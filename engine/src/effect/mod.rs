//! Effects: built-in processors that change audio passing through them, and
//! the Insert Chain that runs them in order.

mod chain;
mod compressor;
mod delay;
mod eq;
mod params;
mod reverb;

pub use chain::{Effect, EffectKind, InsertChain, MAX_EFFECTS, effect_parameters_json};
pub use compressor::{COMPRESSOR_PARAMS, Compressor, CompressorSettings};
pub use delay::{DELAY_PARAMS, Delay, DelaySettings};
pub use eq::{EQ_PARAMS, Eq, EqSettings, eq_response_db};
pub use params::Settings;
pub use reverb::{REVERB_PARAMS, Reverb, ReverbSettings};
