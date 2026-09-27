//! Nothing outlives a Plugin: not its process, nor its shared memory, however
//! it ended. Its own test binary, so no other test's Plugins are in /dev/shm.

mod common;

use spike_vst3_host::process::Block;
use spike_vst3_host::shared::ParamChange;

fn ours() -> Vec<String> {
    let prefix = format!("soundcheck-vst3-{}-", std::process::id());
    std::fs::read_dir("/dev/shm")
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(&prefix))
        .collect()
}

#[test]
fn nothing_is_left_behind() {
    let quitting = common::load("spike-faulty", "Spike Faulty");
    let dropped = common::load("adelay", "ADelay");
    let mut crashing = common::load("spike-faulty", "Spike Faulty");
    // Each name goes as soon as its helper has the memory mapped.
    assert_eq!(ours(), Vec::<String>::new());

    let pids = [quitting.pid(), dropped.pid(), crashing.pid()];
    let (mut left, mut right) = common::signal(0);
    let crash = [ParamChange {
        id: 1,
        offset: 0,
        value: 1.0,
    }];
    let block = crashing.process(&mut left, &mut right, &crash, &[]);
    assert_eq!(block, Block::Crashed);
    quitting.quit();
    drop(dropped);
    drop(crashing);
    for pid in pids {
        assert!(common::is_gone(pid), "{pid} is still there");
    }
}
