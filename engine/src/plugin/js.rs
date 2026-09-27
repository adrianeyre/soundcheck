//! The browser dev host's side of the Plugin runtime: an instance the
//! worklet made with the host's own `WebAssembly`, reached through the
//! object `app/src/plugin/wasm-plugin-runtime.ts` builds for it.
//!
//! Audio crosses as pointers into the engine's own memory rather than as
//! slices, so a block allocates no JavaScript array: the runtime keeps a view
//! of the engine's memory and copies straight between it and the Plugin's.

use wasm_bindgen::prelude::*;

use super::{PluginFault, PluginInstance};

#[wasm_bindgen]
extern "C" {
    /// A Plugin instance the JavaScript runtime made.
    pub type JsPluginInstance;

    /// Hand the instance the engine's `WebAssembly.Memory`, which the
    /// pointers `process` is given point into.
    #[wasm_bindgen(method, js_name = attachEngineMemory)]
    fn attach_engine_memory(this: &JsPluginInstance, memory: JsValue);

    #[wasm_bindgen(method, js_name = setParam)]
    fn set_param(this: &JsPluginInstance, index: u32, value: f32);

    /// Answers false when the Plugin trapped.
    #[wasm_bindgen(method)]
    fn process(this: &JsPluginInstance, left: u32, right: u32, frames: u32) -> bool;

    #[wasm_bindgen(method)]
    fn reset(this: &JsPluginInstance);

    /// Only an Instrument's. Answers false when the Plugin trapped.
    #[wasm_bindgen(method, js_name = noteOn)]
    fn note_on(this: &JsPluginInstance, note: u32, velocity: f32) -> bool;

    #[wasm_bindgen(method, js_name = noteOff)]
    fn note_off(this: &JsPluginInstance, note: u32) -> bool;
}

pub struct JsPlugin(JsPluginInstance);

impl JsPlugin {
    pub fn new(instance: JsPluginInstance) -> Self {
        instance.attach_engine_memory(wasm_bindgen::memory());
        Self(instance)
    }
}

// The engine's WASM build is single-threaded (no atomics): the instance
// never leaves the worklet's one thread. `Send` is only asked for because
// a native host moves its Engine onto an audio thread.
unsafe impl Send for JsPlugin {}

impl PluginInstance for JsPlugin {
    fn set_param(&mut self, index: usize, value: f32) {
        self.0.set_param(index as u32, value);
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) -> Result<(), PluginFault> {
        let frames = left.len().min(right.len()) as u32;
        let ok = self
            .0
            .process(left.as_mut_ptr() as u32, right.as_mut_ptr() as u32, frames);
        if ok { Ok(()) } else { Err(PluginFault) }
    }

    fn reset(&mut self) {
        self.0.reset();
    }

    fn note_on(&mut self, note: u8, velocity: f32) -> Result<(), PluginFault> {
        if self.0.note_on(note.into(), velocity) {
            Ok(())
        } else {
            Err(PluginFault)
        }
    }

    fn note_off(&mut self, note: u8) -> Result<(), PluginFault> {
        if self.0.note_off(note.into()) {
            Ok(())
        } else {
            Err(PluginFault)
        }
    }
}
