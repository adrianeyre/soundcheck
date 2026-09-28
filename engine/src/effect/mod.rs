//! Effects: built-in processors that change audio passing through them, and
//! the Insert Chain that runs them in order.

mod bitcrusher;
mod chain;
mod chorus;
mod compressor;
mod delay;
mod eq;
mod filter;
mod gate;
mod limiter;
mod params;
mod phaser;
mod reverb;
mod saturator;
mod utility;

pub use bitcrusher::{BITCRUSHER_PARAMS, Bitcrusher, BitcrusherSettings};
pub use chain::{Effect, EffectKind, InsertChain, MAX_EFFECTS, effect_parameters_json};
pub use chorus::{CHORUS_PARAMS, Chorus, ChorusSettings};
pub use compressor::{COMPRESSOR_PARAMS, Compressor, CompressorSettings};
pub use delay::{DELAY_PARAMS, Delay, DelaySettings};
pub use eq::{EQ_PARAMS, Eq, EqSettings, eq_response_db};
pub use filter::{FILTER_PARAMS, Filter, FilterSettings};
pub use gate::{GATE_PARAMS, Gate, GateSettings};
pub use limiter::{LIMITER_PARAMS, Limiter, LimiterSettings};
pub use params::Settings;
pub use phaser::{PHASER_PARAMS, Phaser, PhaserSettings};
pub use reverb::{REVERB_PARAMS, Reverb, ReverbSettings};
pub use saturator::{SATURATOR_PARAMS, Saturator, SaturatorSettings};
pub use utility::{UTILITY_PARAMS, Utility, UtilitySettings};
