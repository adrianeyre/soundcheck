//! The spike Effect behind a WIT interface instead of the C-style ABI.

use std::cell::RefCell;

wit_bindgen::generate!({ world: "plugin", path: "wit" });

use exports::soundcheck::spike::effect::{Guest, GuestTone};

struct Component;

struct Tone(RefCell<spike_plugin::Tone>);

impl Guest for Component {
    type Tone = Tone;
}

impl GuestTone for Tone {
    fn new(sample_rate: f32) -> Self {
        Self(RefCell::new(spike_plugin::Tone::new(sample_rate)))
    }

    fn set_param(&self, index: u32, value: f32) {
        self.0.borrow_mut().set_param(index, value);
    }

    fn process(&self, mut left: Vec<f32>, mut right: Vec<f32>) -> (Vec<f32>, Vec<f32>) {
        self.0.borrow_mut().process(&mut left, &mut right);
        (left, right)
    }
}

export!(Component);
