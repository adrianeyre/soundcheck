//! The block of shared memory audio goes through: `helper/shared.h`, in Rust.
//! The app creates it, starts the helper with its name, and unlinks the name
//! once the helper has mapped it, so nothing is left behind if either dies.
//!
//! Linux only, like the spike: POSIX shared memory and process-shared POSIX
//! semaphores. Windows would use a named file mapping and two named events.

use std::ffi::CString;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

pub const MAGIC: u32 = 0x3354_5356;
pub const VERSION: u32 = 1;
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
    pub id: u32,
    pub offset: u32,
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
    pub go: libc::sem_t,
    pub done: libc::sem_t,
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

/// One mapped block, owned by the app.
pub struct Shared {
    name: CString,
    ptr: *mut Layout,
    unlinked: AtomicBool,
}

// The helper is the only other party, and the semaphores order every access
// to the layout. The app's side is used by its audio thread, apart from
// `post_done`, which the pipe thread calls when the helper dies.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

static NEXT: AtomicU32 = AtomicU32::new(0);

impl Shared {
    pub fn create() -> std::io::Result<Self> {
        let name = format!(
            "/soundcheck-vst3-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let name = CString::new(name).expect("no NUL in the name");
        let size = std::mem::size_of::<Layout>();
        // SAFETY: plain libc calls on a name we made; every result is checked.
        unsafe {
            let fd = libc::shm_open(
                name.as_ptr(),
                libc::O_CREAT | libc::O_EXCL | libc::O_RDWR,
                0o600,
            );
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ftruncate(fd, size as libc::off_t) != 0 {
                let error = std::io::Error::last_os_error();
                libc::close(fd);
                libc::shm_unlink(name.as_ptr());
                return Err(error);
            }
            let memory = libc::mmap(
                std::ptr::null_mut(),
                size,
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
            // ftruncate zeroed it; only the header and semaphores need setting.
            let ptr = memory.cast::<Layout>();
            (*ptr).magic = MAGIC;
            (*ptr).version = VERSION;
            libc::sem_init(&raw mut (*ptr).go, 1, 0);
            libc::sem_init(&raw mut (*ptr).done, 1, 0);
            Ok(Self {
                name,
                ptr,
                unlinked: AtomicBool::new(false),
            })
        }
    }

    /// The name the helper opens it by.
    pub fn name(&self) -> &str {
        self.name.to_str().expect("the name is ASCII")
    }

    /// Removes the name once the helper has it mapped; the memory lives on
    /// until both have unmapped it.
    pub fn unlink(&self) {
        if !self.unlinked.swap(true, Ordering::AcqRel) {
            // SAFETY: our own name.
            unsafe { libc::shm_unlink(self.name.as_ptr()) };
        }
    }

    /// The layout, to write a block into or read one out of.
    ///
    /// # Safety
    ///
    /// Only between blocks (no `go` outstanding, or its `done` taken), and
    /// only from the one thread that runs blocks.
    #[allow(clippy::mut_from_ref)]
    pub unsafe fn layout(&self) -> &mut Layout {
        // SAFETY: mapped for as long as `self` lives; the caller keeps to
        // the rules above.
        unsafe { &mut *self.ptr }
    }

    /// What the helper has written to `done_seq`, read afresh each time.
    pub fn done_seq(&self) -> u32 {
        // SAFETY: an aligned u32 in the mapping, written by the other process.
        unsafe { std::ptr::read_volatile(&raw const (*self.ptr).done_seq) }
    }

    /// Wakes the helper for the block now written.
    pub fn post_go(&self) {
        // SAFETY: initialised in `create`.
        unsafe { libc::sem_post(&raw mut (*self.ptr).go) };
    }

    /// Wakes whoever is waiting for `done`: the app's audio thread, told this
    /// way that the helper has died rather than left to wait out its deadline.
    pub fn post_done(&self) {
        // SAFETY: initialised in `create`.
        unsafe { libc::sem_post(&raw mut (*self.ptr).done) };
    }

    /// Waits for `done` for at most `timeout`. True if it came.
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
                if libc::sem_timedwait(&raw mut (*self.ptr).done, &deadline) == 0 {
                    return true;
                }
                if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                    return false;
                }
            }
        }
    }

    /// Takes a `done` that has already been posted, without waiting.
    pub fn try_done(&self) -> bool {
        // SAFETY: initialised in `create`.
        unsafe { libc::sem_trywait(&raw mut (*self.ptr).done) == 0 }
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        self.unlink();
        // SAFETY: mapped in `create` with this size, and unmapped only here.
        unsafe {
            libc::sem_destroy(&raw mut (*self.ptr).go);
            libc::sem_destroy(&raw mut (*self.ptr).done);
            libc::munmap(self.ptr.cast(), std::mem::size_of::<Layout>());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn its_name_is_gone_once_unlinked() {
        let shared = Shared::create().unwrap();
        let path = format!("/dev/shm{}", shared.name());
        assert!(std::path::Path::new(&path).exists());
        shared.unlink();
        assert!(!std::path::Path::new(&path).exists());
    }
}
