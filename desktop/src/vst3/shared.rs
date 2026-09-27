//! The block of shared memory audio goes through: `vst3-host/src/shared.h`,
//! in Rust. The app creates it and starts the helper with its name.
//!
//! On Linux it is POSIX shared memory with process-shared semaphores inside
//! it, and its name is unlinked once the helper has it mapped, so nothing is
//! left behind if either side dies. On Windows it is a named file mapping and
//! two named auto-reset events, `<name>-go` and `<name>-done`, which go when
//! the last handle to them closes. Their names are random, rather than
//! handles the helper inherits: Rust can't limit which handles a child
//! inherits, and every Plugin's helper would get every other's (ADR 0008).
//!
//! macOS has neither: its unnamed POSIX semaphores can't be shared between
//! processes and have no timed wait (ADR 0008's slice 6). Until that is
//! built, making a block there fails with [`UNSUPPORTED`], so a VST3 Plugin
//! is refused rather than the build failing.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

pub const MAGIC: u32 = 0x3354_5356;
pub const VERSION: u32 = 2;
pub const MAX_FRAMES: usize = 1024;
pub const MAX_PARAM_CHANGES: usize = 64;
pub const MAX_EVENTS: usize = 128;

pub const EVENT_NOTE_ON: u32 = 1;
pub const EVENT_NOTE_OFF: u32 = 2;

pub const STATUS_OK: u32 = 0;
/// Set by the helper's crash handler as the helper dies.
pub const STATUS_CRASHED: u32 = 2;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ParamChange {
    /// The Plugin's ParamID.
    pub id: u32,
    /// The frame in the block where it changes.
    pub offset: u32,
    /// Normalised, 0 to 1.
    pub value: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Event {
    pub kind: u32,
    pub offset: u32,
    pub pitch: i32,
    pub velocity: f32,
}

#[repr(C)]
pub struct Layout {
    pub magic: u32,
    pub version: u32,
    /// A `sem_t` on Linux; unused on Windows.
    pub go: [u8; 64],
    pub done: [u8; 64],
    pub seq: u32,
    pub quit: u32,
    pub done_seq: u32,
    pub status: u32,
    pub frames: u32,
    pub param_change_count: u32,
    pub event_count: u32,
    pub reserved: u32,
    pub param_changes: [ParamChange; MAX_PARAM_CHANGES],
    pub events: [Event; MAX_EVENTS],
    pub input: [[f32; MAX_FRAMES]; 2],
    pub output: [[f32; MAX_FRAMES]; 2],
}

/// What the helper says its layout's size is, and so this one's must be.
pub const SIZE: usize = std::mem::size_of::<Layout>();

/// Why a block can't be made where shared memory for VST3 isn't built.
pub const UNSUPPORTED: &str = "VST3 Plugins aren't supported on macOS yet";

#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
static NEXT: AtomicU32 = AtomicU32::new(0);

/// A name no other block on the machine has: this process's, a count, and
/// something random so it can't be guessed ahead of time.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
fn fresh_name(prefix: &str) -> String {
    use std::hash::{BuildHasher, RandomState};
    let random = RandomState::new().hash_one(NEXT.load(Ordering::Relaxed));
    format!(
        "{prefix}soundcheck-vst3-{}-{}-{random:016x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(target_os = "linux")]
mod os {
    use std::ffi::CString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use super::{Layout, MAGIC, SIZE, VERSION};

    const _: () = assert!(std::mem::size_of::<libc::sem_t>() <= 64);

    /// One mapped block, owned by the app.
    pub struct Shared {
        name: CString,
        ptr: *mut Layout,
        unlinked: AtomicBool,
    }

    impl Shared {
        pub fn create() -> std::io::Result<Self> {
            let name = CString::new(super::fresh_name("/")).expect("no NUL in the name");
            // SAFETY: plain libc calls on a name we made; every result is
            // checked.
            unsafe {
                let fd = libc::shm_open(
                    name.as_ptr(),
                    libc::O_CREAT | libc::O_EXCL | libc::O_RDWR,
                    0o600,
                );
                if fd < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ftruncate(fd, SIZE as libc::off_t) != 0 {
                    let error = std::io::Error::last_os_error();
                    libc::close(fd);
                    libc::shm_unlink(name.as_ptr());
                    return Err(error);
                }
                let memory = libc::mmap(
                    std::ptr::null_mut(),
                    SIZE,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_SHARED,
                    fd,
                    0,
                );
                libc::close(fd);
                if memory == libc::MAP_FAILED {
                    let error = std::io::Error::last_os_error();
                    libc::shm_unlink(name.as_ptr());
                    return Err(error);
                }
                // ftruncate zeroed it; only the header and semaphores need
                // setting.
                let ptr = memory.cast::<Layout>();
                (*ptr).magic = MAGIC;
                (*ptr).version = VERSION;
                libc::sem_init(go(ptr), 1, 0);
                libc::sem_init(done(ptr), 1, 0);
                Ok(Self {
                    name,
                    ptr,
                    unlinked: AtomicBool::new(false),
                })
            }
        }

        pub fn name(&self) -> &str {
            self.name.to_str().expect("the name is ASCII")
        }

        pub fn unlink(&self) {
            if !self.unlinked.swap(true, Ordering::AcqRel) {
                // SAFETY: our own name.
                unsafe { libc::shm_unlink(self.name.as_ptr()) };
            }
        }

        pub fn ptr(&self) -> *mut Layout {
            self.ptr
        }

        pub fn post_go(&self) {
            // SAFETY: initialised in `create`.
            unsafe { libc::sem_post(go(self.ptr)) };
        }

        pub fn post_done(&self) {
            // SAFETY: initialised in `create`.
            unsafe { libc::sem_post(done(self.ptr)) };
        }

        pub fn wait_done(&self, timeout: Duration) -> bool {
            // SAFETY: initialised in `create`; `deadline` is a valid timespec.
            unsafe {
                let mut deadline = std::mem::zeroed::<libc::timespec>();
                libc::clock_gettime(libc::CLOCK_REALTIME, &mut deadline);
                let nanos = deadline.tv_nsec as u64 + u64::from(timeout.subsec_nanos());
                deadline.tv_sec +=
                    timeout.as_secs() as libc::time_t + (nanos / 1_000_000_000) as libc::time_t;
                deadline.tv_nsec = (nanos % 1_000_000_000) as libc::c_long;
                loop {
                    if libc::sem_timedwait(done(self.ptr), &deadline) == 0 {
                        return true;
                    }
                    if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                        return false;
                    }
                }
            }
        }

        pub fn try_done(&self) -> bool {
            // SAFETY: initialised in `create`.
            unsafe { libc::sem_trywait(done(self.ptr)) == 0 }
        }
    }

    /// The semaphores, in their slots in the layout.
    fn go(ptr: *mut Layout) -> *mut libc::sem_t {
        // SAFETY: in bounds of the mapping; the slot is 8-aligned and big
        // enough, as the assertion above checks.
        unsafe { (&raw mut (*ptr).go).cast() }
    }

    fn done(ptr: *mut Layout) -> *mut libc::sem_t {
        // SAFETY: as `go`.
        unsafe { (&raw mut (*ptr).done).cast() }
    }

    impl Drop for Shared {
        fn drop(&mut self) {
            self.unlink();
            // SAFETY: mapped in `create` with this size, and unmapped only
            // here.
            unsafe {
                libc::sem_destroy(go(self.ptr));
                libc::sem_destroy(done(self.ptr));
                libc::munmap(self.ptr.cast(), SIZE);
            }
        }
    }
}

#[cfg(windows)]
mod os {
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{
        CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Memory::{
        CreateFileMappingW, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
        PAGE_READWRITE, UnmapViewOfFile,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, CreateEventW, CreateWaitableTimerExW, SetEvent,
        SetWaitableTimer, TIMER_ALL_ACCESS, WaitForMultipleObjects, WaitForSingleObject,
    };

    use super::{Layout, MAGIC, SIZE, VERSION};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// One mapped block, owned by the app.
    pub struct Shared {
        name: String,
        mapping: HANDLE,
        ptr: *mut Layout,
        go: HANDLE,
        done: HANDLE,
        /// Wakes a wait for `done` at its deadline to well under a
        /// millisecond, which a plain timed wait can't; null on a Windows
        /// too old to have one, which waits in whole milliseconds instead.
        timer: HANDLE,
    }

    impl Shared {
        pub fn create() -> std::io::Result<Self> {
            let name = super::fresh_name("Local\\");
            // SAFETY: plain Win32 calls on names we made; every result is
            // checked, and whatever was made is closed by `drop`.
            unsafe {
                let mut shared = Self {
                    mapping: CreateFileMappingW(
                        INVALID_HANDLE_VALUE,
                        std::ptr::null(),
                        PAGE_READWRITE,
                        0,
                        SIZE as u32,
                        wide(&name).as_ptr(),
                    ),
                    name,
                    ptr: std::ptr::null_mut(),
                    go: std::ptr::null_mut(),
                    done: std::ptr::null_mut(),
                    timer: std::ptr::null_mut(),
                };
                if shared.mapping.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                shared.ptr = MapViewOfFile(shared.mapping, FILE_MAP_ALL_ACCESS, 0, 0, SIZE)
                    .Value
                    .cast();
                if shared.ptr.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let event = |suffix: &str| {
                    CreateEventW(
                        std::ptr::null(),
                        0,
                        0,
                        wide(&format!("{}-{suffix}", shared.name)).as_ptr(),
                    )
                };
                shared.go = event("go");
                shared.done = event("done");
                if shared.go.is_null() || shared.done.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                shared.timer = CreateWaitableTimerExW(
                    std::ptr::null(),
                    std::ptr::null(),
                    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                    TIMER_ALL_ACCESS,
                );
                // A new mapping of the paging file is zeroed.
                (*shared.ptr).magic = MAGIC;
                (*shared.ptr).version = VERSION;
                Ok(shared)
            }
        }

        pub fn name(&self) -> &str {
            &self.name
        }

        /// Nothing to do: the names go with the last handle.
        pub fn unlink(&self) {}

        pub fn ptr(&self) -> *mut Layout {
            self.ptr
        }

        pub fn post_go(&self) {
            // SAFETY: made in `create`.
            unsafe { SetEvent(self.go) };
        }

        pub fn post_done(&self) {
            // SAFETY: made in `create`.
            unsafe { SetEvent(self.done) };
        }

        pub fn wait_done(&self, timeout: Duration) -> bool {
            if self.timer.is_null() {
                let millis = timeout
                    .as_nanos()
                    .div_ceil(1_000_000)
                    .min(u128::from(u32::MAX - 1));
                // SAFETY: made in `create`.
                return unsafe { WaitForSingleObject(self.done, millis as u32) } == WAIT_OBJECT_0;
            }
            let started = Instant::now();
            // Relative, in units of 100 ns.
            let due = -((timeout.as_nanos() / 100).min(i64::MAX as u128) as i64).max(1);
            // SAFETY: made in `create`; the handles live as long as `self`.
            unsafe {
                if SetWaitableTimer(self.timer, &due, 0, None, std::ptr::null(), 0) == 0 {
                    return WaitForSingleObject(self.done, timeout.as_millis() as u32)
                        == WAIT_OBJECT_0;
                }
                let handles = [self.done, self.timer];
                // The timer ends the wait; the extra second is only in case
                // it never fires.
                let guard = (timeout + Duration::from_secs(1)).as_millis() as u32;
                let woken = WaitForMultipleObjects(2, handles.as_ptr(), 0, guard);
                woken == WAIT_OBJECT_0
                    || (woken != WAIT_OBJECT_0 + 1
                        && started.elapsed() < timeout
                        && self.try_done())
            }
        }

        pub fn try_done(&self) -> bool {
            // SAFETY: made in `create`.
            unsafe { WaitForSingleObject(self.done, 0) == WAIT_OBJECT_0 }
        }
    }

    impl Drop for Shared {
        fn drop(&mut self) {
            // SAFETY: each was made in `create` and is closed only here.
            unsafe {
                if !self.ptr.is_null() {
                    UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                        Value: self.ptr.cast(),
                    });
                }
                for handle in [self.mapping, self.go, self.done, self.timer] {
                    if !handle.is_null() {
                        CloseHandle(handle);
                    }
                }
            }
        }
    }
}

/// Where the shared memory isn't built yet: macOS, and any other Unix.
#[cfg(not(any(target_os = "linux", windows)))]
mod os {
    use std::time::Duration;

    use super::Layout;

    pub struct Shared {
        _never: std::convert::Infallible,
    }

    impl Shared {
        pub fn create() -> std::io::Result<Self> {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                super::UNSUPPORTED,
            ))
        }

        pub fn name(&self) -> &str {
            match self._never {}
        }

        pub fn unlink(&self) {
            match self._never {}
        }

        pub fn ptr(&self) -> *mut Layout {
            match self._never {}
        }

        pub fn post_go(&self) {
            match self._never {}
        }

        pub fn post_done(&self) {
            match self._never {}
        }

        pub fn wait_done(&self, _timeout: Duration) -> bool {
            match self._never {}
        }

        pub fn try_done(&self) -> bool {
            match self._never {}
        }
    }
}

/// One mapped block, owned by the app.
pub struct Shared(os::Shared);

// The helper is the only other party, and *go* and *done* order every access
// to the layout. The app's side is used by the thread that runs blocks,
// apart from `post_done`, which the pipe thread calls when the helper dies.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

impl Shared {
    pub fn create() -> std::io::Result<Self> {
        os::Shared::create().map(Self)
    }

    /// The name the helper opens it by.
    pub fn name(&self) -> &str {
        self.0.name()
    }

    /// Removes the name once the helper has it mapped, on Linux; the memory
    /// lives on until both have unmapped it.
    pub fn unlink(&self) {
        self.0.unlink();
    }

    /// The layout, to write a block into or read one out of.
    ///
    /// # Safety
    ///
    /// Only between blocks (no *go* outstanding, or its *done* taken), and
    /// only from the one thread that runs blocks.
    #[allow(clippy::mut_from_ref)]
    pub unsafe fn layout(&self) -> &mut Layout {
        // SAFETY: mapped for as long as `self` lives; the caller keeps to
        // the rules above.
        unsafe { &mut *self.0.ptr() }
    }

    /// What the helper has written to `done_seq`, read afresh each time.
    pub fn done_seq(&self) -> u32 {
        // SAFETY: an aligned u32 in the mapping, written by the other process.
        unsafe { std::ptr::read_volatile(&raw const (*self.0.ptr()).done_seq) }
    }

    /// Wakes the helper for the block now written.
    pub fn post_go(&self) {
        self.0.post_go();
    }

    /// Wakes whoever is waiting for *done*: the thread running blocks, told
    /// this way that the helper has died rather than left to wait out its
    /// deadline.
    pub fn post_done(&self) {
        self.0.post_done();
    }

    /// Waits for *done* for at most `timeout`. True if it came.
    pub fn wait_done(&self, timeout: Duration) -> bool {
        self.0.wait_done(timeout)
    }

    /// Takes a *done* that has already been posted, without waiting.
    pub fn try_done(&self) -> bool {
        self.0.try_done()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn its_layout_is_the_helpers() {
        // What `vst3-host/src/shared.h` makes it on 64-bit Linux and Windows,
        // and what the helper's greeting says.
        assert_eq!(SIZE, 19_624);
        assert_eq!(std::mem::offset_of!(Layout, seq), 136);
        assert_eq!(std::mem::offset_of!(Layout, param_changes), 168);
        assert_eq!(std::mem::offset_of!(Layout, input), 3_240);
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn a_new_block_is_zeroed_with_its_header_set() {
        let shared = Shared::create().unwrap();
        // SAFETY: no helper, so no block is outstanding.
        let layout = unsafe { shared.layout() };
        assert_eq!(layout.magic, MAGIC);
        assert_eq!(layout.version, VERSION);
        assert_eq!(layout.seq, 0);
        assert_eq!(layout.output[1][MAX_FRAMES - 1], 0.0);
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn done_waits_until_posted_or_the_timeout() {
        let shared = Shared::create().unwrap();
        assert!(!shared.wait_done(Duration::from_millis(5)));
        assert!(!shared.try_done());
        shared.post_done();
        assert!(shared.try_done());
        shared.post_done();
        assert!(shared.wait_done(Duration::from_millis(5)));
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn no_two_blocks_share_a_name() {
        let a = Shared::create().unwrap();
        let b = Shared::create().unwrap();
        assert_ne!(a.name(), b.name());
        assert!(a.name().contains("soundcheck-vst3-"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn its_name_is_gone_once_unlinked() {
        let shared = Shared::create().unwrap();
        let path = format!("/dev/shm{}", shared.name());
        assert!(std::path::Path::new(&path).exists());
        shared.unlink();
        assert!(!std::path::Path::new(&path).exists());
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    #[test]
    fn a_block_is_refused_where_it_isnt_built() {
        let error = Shared::create().err().expect("no shared memory here yet");
        assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
        assert_eq!(error.to_string(), UNSUPPORTED);
    }
}
