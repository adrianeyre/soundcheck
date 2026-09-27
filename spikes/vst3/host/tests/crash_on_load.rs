//! A Plugin that crashes as its library loads, as copy protection can, costs a
//! scan only the helper it was loaded in. Its own test binary, because it sets
//! an environment variable every helper started from here inherits.

mod common;

use std::time::Duration;

use spike_vst3_host::scan::{self, Source};

#[test]
fn a_plugin_that_crashes_as_it_loads_costs_only_its_scan() {
    let old = common::faulty_without_moduleinfo("crash-on-load");

    // SAFETY: the only test in this binary, so no other thread reads the
    // environment.
    unsafe { std::env::set_var("SPIKE_FAULTY_CRASH_ON_LOAD", "1") };
    let bundles = [
        old.clone(),
        common::bundle("adelay"),
        common::bundle("spike-faulty"),
    ];
    let found = scan::scan(&bundles, &common::helper(), Duration::from_secs(10));

    assert_eq!(found[0].source, Source::Helper);
    let why = found[0].classes.as_ref().unwrap_err();
    assert_eq!(why, "it crashed while it was being scanned");
    // The scan carried on, and a bundle with a moduleinfo is never loaded, so
    // even the same Plugin scans with one.
    assert_eq!(found[1].classes.as_ref().unwrap()[0].name, "ADelay");
    assert_eq!(found[2].source, Source::ModuleInfo);
    assert_eq!(found[2].classes.as_ref().unwrap()[0].name, "Spike Faulty");
    std::fs::remove_dir_all(old.parent().unwrap()).unwrap();
}
