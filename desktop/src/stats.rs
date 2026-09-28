//! Figures the audio thread publishes for the UI, through atomics: the audio
//! thread writes them without locking, and the control side reads a snapshot
//! whenever the UI asks.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::Relaxed};

use serde::Serialize;
use soundcheck_engine::{DJ_REPORT_LEN, MAX_BUSES, MAX_EFFECTS, MAX_TRACKS};

/// An `f32` in an `AtomicU32`.
#[derive(Default)]
struct AtomicF32(AtomicU32);

impl AtomicF32 {
    fn load(&self) -> f32 {
        f32::from_bits(self.0.load(Relaxed))
    }

    fn store(&self, value: f32) {
        self.0.store(value.to_bits(), Relaxed);
    }
}

/// An `f64` in an `AtomicU64`.
#[derive(Default)]
struct AtomicF64(AtomicU64);

impl AtomicF64 {
    fn new(value: f64) -> Self {
        Self(AtomicU64::new(value.to_bits()))
    }

    fn load(&self) -> f64 {
        f64::from_bits(self.0.load(Relaxed))
    }

    fn store(&self, value: f64) {
        self.0.store(value.to_bits(), Relaxed);
    }
}

/// Written by the audio thread, read by the control side.
pub struct SharedStats {
    callbacks: AtomicU64,
    late_callbacks: AtomicU64,
    max_render_seconds: AtomicF64,
    last_callback_frames: AtomicU32,
    frames_played: AtomicU64,
    /// Seconds from a callback to its audio reaching the device, when the
    /// platform says; NaN until it does.
    output_latency: AtomicF64,
    track_count: AtomicU32,
    active_voices: AtomicU32,
    playing: AtomicBool,
    position: AtomicF64,
    /// One meter per Track, however many Tracks there are, plus the Master's.
    track_peaks: Box<[AtomicF32; MAX_TRACKS]>,
    master_peak: AtomicF32,
    bus_count: AtomicU32,
    /// One meter per Bus, however many there are.
    bus_peaks: Box<[AtomicF32; MAX_BUSES]>,
    /// Every Insert Chain's length, the Tracks' in Track order, then the
    /// Master's, then the Buses', so the gain-reduction meters come back one
    /// per Effect.
    chain_lengths: Box<[AtomicU32]>,
    /// `MAX_EFFECTS` gain-reduction meters per Insert Chain, in the same
    /// order.
    gain_reductions: Box<[AtomicF32]>,
    /// The DJ Mixer's report (`DjMixer::report`), once it is in use.
    dj: Box<[AtomicF64]>,
    dj_in_use: AtomicBool,
}

/// How many Insert Chains' figures are kept: every Track's, the Master's and
/// every Bus's.
const CHAINS: usize = MAX_TRACKS + 1 + MAX_BUSES;

/// Where Insert Chain `chain`'s figures are kept: a Track's index; -1 for the
/// Master, which comes after every Track; -2 - b for Bus b, after the
/// Master. None for a Track or Bus that can't exist.
fn chain_slot(chain: i32) -> Option<usize> {
    match usize::try_from(chain) {
        Ok(track) => (track < MAX_TRACKS).then_some(track),
        Err(_) if chain == -1 => Some(MAX_TRACKS),
        Err(_) => {
            let bus = (-2 - i64::from(chain)) as usize;
            (bus < MAX_BUSES).then_some(MAX_TRACKS + 1 + bus)
        }
    }
}

impl Default for SharedStats {
    fn default() -> Self {
        Self {
            callbacks: AtomicU64::new(0),
            late_callbacks: AtomicU64::new(0),
            max_render_seconds: AtomicF64::new(0.0),
            last_callback_frames: AtomicU32::new(0),
            frames_played: AtomicU64::new(0),
            output_latency: AtomicF64::new(f64::NAN),
            track_count: AtomicU32::new(0),
            active_voices: AtomicU32::new(0),
            playing: AtomicBool::new(false),
            position: AtomicF64::new(0.0),
            track_peaks: Box::new(std::array::from_fn(|_| AtomicF32::default())),
            master_peak: AtomicF32::default(),
            bus_count: AtomicU32::new(0),
            bus_peaks: Box::new(std::array::from_fn(|_| AtomicF32::default())),
            chain_lengths: (0..CHAINS).map(|_| AtomicU32::new(0)).collect(),
            gain_reductions: (0..CHAINS * MAX_EFFECTS)
                .map(|_| AtomicF32::default())
                .collect(),
            dj: (0..DJ_REPORT_LEN).map(|_| AtomicF64::default()).collect(),
            dj_in_use: AtomicBool::new(false),
        }
    }
}

/// The engine's own state, as the audio thread reports it. Nothing here
/// allocates, so it can be built inside the audio callback.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EngineState {
    pub track_count: u32,
    pub active_voices: u32,
    pub playing: bool,
    pub position: f64,
}

/// The engine's own state, as `EngineReport` in `audio-output.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineReport {
    pub track_count: u32,
    pub active_voices: u32,
    pub playing: bool,
    pub position: f64,
}

/// The mixer's meters, as `Meters` in `audio-output.ts`: peak levels the
/// engine measured, one per Track in Track order, the Master's, and one per
/// Bus in Bus order.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meters {
    pub master: f32,
    pub tracks: Vec<f32>,
    pub buses: Vec<f32>,
    pub gain_reduction: GainReductionMeters,
}

/// Every Insert Chain's gain-reduction meters, as `GainReductionMeters` in
/// `audio-output.ts`: one per Effect in chain order, in dB (0 or more), 0
/// for an Effect that doesn't reduce gain.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GainReductionMeters {
    pub master: Vec<f32>,
    pub tracks: Vec<Vec<f32>>,
    pub buses: Vec<Vec<f32>>,
}

/// What the audio thread has measured, as the UI reads it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub callbacks: u64,
    /// Callbacks whose render took longer than the audio they rendered lasts.
    pub late_callbacks: u64,
    pub max_render_seconds: f64,
    /// Frames the last callback asked for: the buffer size actually granted.
    pub callback_frames: u32,
    pub frames_played: u64,
    pub output_latency: Option<f64>,
    pub engine: EngineReport,
    pub meters: Meters,
    /// The DJ Mixer's report, or none before the Mixing page is used.
    pub dj: Option<Vec<f64>>,
}

impl SharedStats {
    /// One callback done: `frames` rendered in `render_seconds`, against a
    /// budget of `budget_seconds`.
    pub fn record_callback(&self, frames: u32, render_seconds: f64, budget_seconds: f64) {
        self.callbacks.fetch_add(1, Relaxed);
        if render_seconds > budget_seconds {
            self.late_callbacks.fetch_add(1, Relaxed);
        }
        if render_seconds > self.max_render_seconds.load() {
            self.max_render_seconds.store(render_seconds);
        }
        self.last_callback_frames.store(frames, Relaxed);
        self.frames_played.fetch_add(u64::from(frames), Relaxed);
    }

    pub fn record_engine(&self, state: EngineState) {
        self.track_count.store(state.track_count, Relaxed);
        self.active_voices.store(state.active_voices, Relaxed);
        self.playing.store(state.playing, Relaxed);
        self.position.store(state.position);
    }

    /// Track `track`'s meter. Tracks past `MAX_TRACKS` don't exist.
    pub fn record_track_peak(&self, track: usize, peak: f32) {
        if let Some(meter) = self.track_peaks.get(track) {
            meter.store(peak);
        }
    }

    /// How many Buses there are, up to `MAX_BUSES`.
    pub fn record_bus_count(&self, count: usize) {
        self.bus_count.store(count.min(MAX_BUSES) as u32, Relaxed);
    }

    /// Bus `bus`'s meter. Buses past `MAX_BUSES` don't exist.
    pub fn record_bus_peak(&self, bus: usize, peak: f32) {
        if let Some(meter) = self.bus_peaks.get(bus) {
            meter.store(peak);
        }
    }

    /// The DJ Mixer's report, `DJ_REPORT_LEN` numbers.
    pub fn record_dj(&self, report: &[f64]) {
        for (slot, &value) in self.dj.iter().zip(report) {
            slot.store(value);
        }
        self.dj_in_use.store(true, Relaxed);
    }

    pub fn record_master_peak(&self, peak: f32) {
        self.master_peak.store(peak);
    }

    /// How many Effects Insert Chain `chain` holds: a Track's index, or
    /// below zero for the Master.
    pub fn record_effect_count(&self, chain: i32, count: usize) {
        if let Some(slot) = chain_slot(chain) {
            self.chain_lengths[slot].store(count.min(MAX_EFFECTS) as u32, Relaxed);
        }
    }

    /// The gain-reduction meter of the Effect at `index` in Insert Chain
    /// `chain`, in dB.
    pub fn record_gain_reduction(&self, chain: i32, index: usize, db: f32) {
        if let Some(slot) = chain_slot(chain).filter(|_| index < MAX_EFFECTS) {
            self.gain_reductions[slot * MAX_EFFECTS + index].store(db);
        }
    }

    /// Insert Chain `chain`'s gain-reduction meters, one per Effect.
    fn gain_reductions(&self, chain: i32) -> Vec<f32> {
        let Some(slot) = chain_slot(chain) else {
            return Vec::new();
        };
        let count = self.chain_lengths[slot].load(Relaxed) as usize;
        self.gain_reductions[slot * MAX_EFFECTS..][..count]
            .iter()
            .map(AtomicF32::load)
            .collect()
    }

    pub fn record_output_latency(&self, seconds: f64) {
        self.output_latency.store(seconds);
    }

    /// Zero the callback counters, e.g. once start-up is over.
    pub fn reset_counters(&self) {
        self.callbacks.store(0, Relaxed);
        self.late_callbacks.store(0, Relaxed);
        self.max_render_seconds.store(0.0);
    }

    pub fn snapshot(&self) -> Measured {
        let latency = self.output_latency.load();
        let track_count = self.track_count.load(Relaxed) as usize;
        let bus_count = self.bus_count.load(Relaxed) as usize;
        Measured {
            callbacks: self.callbacks.load(Relaxed),
            late_callbacks: self.late_callbacks.load(Relaxed),
            max_render_seconds: self.max_render_seconds.load(),
            callback_frames: self.last_callback_frames.load(Relaxed),
            frames_played: self.frames_played.load(Relaxed),
            output_latency: latency.is_finite().then_some(latency),
            dj: self
                .dj_in_use
                .load(Relaxed)
                .then(|| self.dj.iter().map(AtomicF64::load).collect()),
            engine: EngineReport {
                track_count: track_count as u32,
                active_voices: self.active_voices.load(Relaxed),
                playing: self.playing.load(Relaxed),
                position: self.position.load(),
            },
            meters: Meters {
                master: self.master_peak.load(),
                tracks: self.track_peaks[..track_count.min(MAX_TRACKS)]
                    .iter()
                    .map(AtomicF32::load)
                    .collect(),
                buses: self.bus_peaks[..bus_count]
                    .iter()
                    .map(AtomicF32::load)
                    .collect(),
                gain_reduction: GainReductionMeters {
                    master: self.gain_reductions(-1),
                    tracks: (0..track_count.min(MAX_TRACKS) as i32)
                        .map(|track| self.gain_reductions(track))
                        .collect(),
                    buses: (0..bus_count)
                        .map(|bus| self.gain_reductions(soundcheck_engine::bus_chain(bus)))
                        .collect(),
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_render_slower_than_its_buffer_is_a_late_callback() {
        let stats = SharedStats::default();
        stats.record_callback(256, 0.001, 256.0 / 48_000.0);
        stats.record_callback(256, 0.009, 256.0 / 48_000.0);
        let measured = stats.snapshot();
        assert_eq!(measured.callbacks, 2);
        assert_eq!(measured.late_callbacks, 1);
        assert_eq!(measured.max_render_seconds, 0.009);
        assert_eq!(measured.frames_played, 512);
        assert_eq!(measured.output_latency, None);

        stats.reset_counters();
        assert_eq!(stats.snapshot().late_callbacks, 0);
        assert_eq!(stats.snapshot().frames_played, 512, "time keeps counting");
    }

    #[test]
    fn the_meters_reported_are_one_per_track_plus_the_master() {
        let stats = SharedStats::default();
        assert_eq!(stats.snapshot().meters.tracks, Vec::<f32>::new());

        stats.record_engine(EngineState {
            track_count: 3,
            active_voices: 0,
            playing: false,
            position: 0.0,
        });
        stats.record_master_peak(0.75);
        for (track, peak) in [0.1, 0.2, 0.3].into_iter().enumerate() {
            stats.record_track_peak(track, peak);
        }
        // Past the last Track, and past every possible Track.
        stats.record_track_peak(3, 0.9);
        stats.record_track_peak(MAX_TRACKS, 0.9);

        let meters = stats.snapshot().meters;
        assert_eq!(meters.master, 0.75);
        assert_eq!(meters.tracks, vec![0.1, 0.2, 0.3]);
        assert_eq!(meters.buses, Vec::<f32>::new());
        assert_eq!(
            meters.gain_reduction,
            GainReductionMeters {
                master: vec![],
                tracks: vec![vec![]; 3],
                buses: vec![],
            }
        );

        stats.record_bus_count(2);
        stats.record_bus_peak(1, 0.5);
        stats.record_bus_peak(MAX_BUSES, 0.9);
        stats.record_effect_count(soundcheck_engine::bus_chain(1), 1);
        stats.record_gain_reduction(soundcheck_engine::bus_chain(1), 0, 3.0);
        let meters = stats.snapshot().meters;
        assert_eq!(meters.buses, vec![0.0, 0.5]);
        assert_eq!(meters.gain_reduction.buses, vec![vec![], vec![3.0]]);
        assert_eq!(meters.gain_reduction.master, Vec::<f32>::new());
    }

    #[test]
    fn the_gain_reduction_meters_are_one_per_effect_on_every_chain() {
        let stats = SharedStats::default();
        stats.record_engine(EngineState {
            track_count: 2,
            active_voices: 0,
            playing: false,
            position: 0.0,
        });
        stats.record_effect_count(1, 2);
        stats.record_gain_reduction(1, 0, 0.0);
        stats.record_gain_reduction(1, 1, 6.5);
        stats.record_effect_count(-1, 1);
        stats.record_gain_reduction(-1, 0, 3.0);
        // Past the chain's end, past every Effect and past every Track.
        stats.record_gain_reduction(1, 2, 9.0);
        stats.record_gain_reduction(1, MAX_EFFECTS, 9.0);
        stats.record_effect_count(MAX_TRACKS as i32, 1);
        stats.record_gain_reduction(MAX_TRACKS as i32, 0, 9.0);

        let meters = stats.snapshot().meters.gain_reduction;
        assert_eq!(meters.master, vec![3.0]);
        assert_eq!(meters.tracks, vec![vec![], vec![0.0, 6.5]]);
    }
}
