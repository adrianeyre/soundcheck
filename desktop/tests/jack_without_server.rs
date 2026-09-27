//! Choosing JACK where no JACK server is running: the sandbox and CI have
//! none, and a musician may pick JACK before starting one. Opening it must
//! say so, not panic. The server is named one nobody runs, so this holds on
//! a machine with JACK running too. Its own test binary, since it sets the
//! environment libjack reads.

#![cfg(target_os = "linux")]

use soundcheck_desktop::recorder::Tap;
use soundcheck_desktop::{audio, audio_input};

#[test]
fn opening_jack_without_a_server_is_a_clear_error() {
    // SAFETY: the only test in this binary, so nothing else reads the
    // environment while it is set.
    unsafe { std::env::set_var("JACK_DEFAULT_SERVER", "soundcheck-test-no-such-server") };

    let options = audio::OpenOptions {
        buffer_frames: Some(256),
        host: Some("JACK".into()),
        track_count: 0,
    };
    let error = audio::open(&options)
        .err()
        .expect("JACK opened without a server");
    assert!(error.contains("no JACK server is running"), "{error}");

    let error = audio_input::open(Some("JACK"), None, &[Tap::FirstTwo], None)
        .err()
        .expect("a JACK input opened without a server");
    assert!(error.contains("no JACK server is running"), "{error}");
}
