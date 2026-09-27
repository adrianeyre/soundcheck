//! The Desktop App's side of hosting VST3 Plugins in a separate process: a
//! throwaway spike for #69 (ADR 0008). `helper/` is the other side.

pub mod moduleinfo;
pub mod process;
pub mod protocol;
pub mod saved;
pub mod scan;
pub mod shared;
