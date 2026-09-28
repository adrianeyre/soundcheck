//! The Keys: an Instrument that plays pitched sounds across the keyboard.
//!
//! Its sound comes from one of two sources. The modelled piano strikes one to
//! three slightly detuned strings per note, each a set of decaying partials
//! stretched as a real string's are, with a burst of hammer noise, and an
//! inharmonic "bell" partial for tines, reeds and toys; its factory Presets
//! (`presets.rs`) make grands, uprights, electric pianos and more of it. Or
//! it plays a sample the musician loads, at each key's pitch from its root
//! note, as a classic sampler does.
//!
//! Every partial is a damped rotating phasor, so a note costs a few
//! multiplies per partial per frame, and nothing here allocates once built:
//! a sample arrives already decoded, and the one it replaces is handed back
//! to drop off the audio thread.

mod params;
mod presets;

use std::f32::consts::{PI, TAU};
use std::sync::Arc;

pub use params::{
    KEYS_PARAM_COUNT, KEYS_PARAMS, KeysSettings, MAX_KEYS_VOICES, keys_parameters_json,
};
pub use presets::{KeysPreset, keys_factory_presets, keys_presets_json};

use self::params::{MAX_PARTIALS, MAX_STRINGS, at};
use super::wav::Sample;

/// A level below which a voice is silent, and ends.
const SILENT: f32 = 1e-4;
/// How long the hammer's noise takes to die away, in seconds.
const NOISE_DECAY: f32 = 0.02;
/// How quickly a stolen voice fades, in seconds, so stealing never clicks.
const STEAL_FADE: f32 = 0.005;

/// One partial: a phasor that turns and shrinks a little every frame.
#[derive(Clone, Copy, Debug, Default)]
struct Partial {
    re: f32,
    im: f32,
    cos: f32,
    sin: f32,
    damp: f32,
}

impl Partial {
    fn new(amplitude: f32, hz: f32, t60: f32, sample_rate: f32) -> Self {
        let turn = TAU * hz / sample_rate;
        Self {
            re: amplitude,
            im: 0.0,
            cos: turn.cos(),
            sin: turn.sin(),
            damp: decay_per_frame(t60, sample_rate),
        }
    }

    #[inline]
    fn next(&mut self) -> f32 {
        let re = (self.re * self.cos - self.im * self.sin) * self.damp;
        let im = (self.re * self.sin + self.im * self.cos) * self.damp;
        self.re = re;
        self.im = im;
        im
    }
}

/// What a level is multiplied by each frame to fall 60 dB in `t60` seconds.
fn decay_per_frame(t60: f32, sample_rate: f32) -> f32 {
    (-6.907_755 / (t60.max(0.001) * sample_rate)).exp()
}

#[derive(Clone, Debug)]
struct Voice {
    active: bool,
    note: u8,
    /// The key is still down, so the dampers are off it.
    held: bool,
    /// When it started, to steal the oldest.
    started: u64,
    partials: [Partial; MAX_PARTIALS * MAX_STRINGS],
    count: usize,
    bell: Partial,
    has_bell: bool,
    /// How loud the fundamental has fallen to, to end a note once it is silent.
    remaining: f32,
    remaining_damp: f32,
    noise: f32,
    noise_damp: f32,
    noise_lp: f32,
    noise_coeff: f32,
    rng: u32,
    /// The attack's ramp, 0 to 1, and how far it climbs a frame.
    rise: f32,
    rise_step: f32,
    /// 1 while held; falls by `fall` every frame once let go.
    gain: f32,
    fall: f32,
    drive: f32,
    left: f32,
    right: f32,
    /// A sample voice: where it is in the sample, and how far it moves a frame.
    sampled: bool,
    position: f64,
    step: f64,
    loudness: f32,
}

impl Default for Voice {
    fn default() -> Self {
        Self {
            active: false,
            note: 0,
            held: false,
            started: 0,
            partials: [Partial::default(); MAX_PARTIALS * MAX_STRINGS],
            count: 0,
            bell: Partial::default(),
            has_bell: false,
            remaining: 0.0,
            remaining_damp: 1.0,
            noise: 0.0,
            noise_damp: 1.0,
            noise_lp: 0.0,
            noise_coeff: 0.0,
            rng: 0x9E37_79B9,
            rise: 1.0,
            rise_step: 1.0,
            gain: 1.0,
            fall: 1.0,
            drive: 0.0,
            left: 0.0,
            right: 0.0,
            sampled: false,
            position: 0.0,
            step: 1.0,
            loudness: 1.0,
        }
    }
}

impl Voice {
    #[inline]
    fn white(&mut self) -> f32 {
        // xorshift32: noise without allocation or a shared generator.
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    /// The next frame, left and right, or `None` once it has ended.
    #[inline]
    fn next(&mut self, sample: Option<&Sample>) -> Option<(f32, f32)> {
        let (mut left, mut right) = if self.sampled {
            let sample = sample?;
            if self.position >= sample.frames() as f64 {
                return None;
            }
            let frame = (
                sample.between(self.position, 0),
                sample.between(self.position, 1),
            );
            self.position += self.step;
            (frame.0 * self.loudness, frame.1 * self.loudness)
        } else {
            let mut out = 0.0;
            for partial in &mut self.partials[..self.count] {
                out += partial.next();
            }
            if self.has_bell {
                out += self.bell.next();
            }
            if self.noise > SILENT {
                let white = self.white();
                self.noise_lp += self.noise_coeff * (white - self.noise_lp);
                out += self.noise_lp * self.noise;
                self.noise *= self.noise_damp;
            }
            self.remaining *= self.remaining_damp;
            if self.remaining < SILENT && self.noise <= SILENT {
                return None;
            }
            if self.drive > 0.0 {
                let push = 1.0 + self.drive * 5.0;
                out = (out * push).tanh() / push.sqrt();
            }
            (out, out)
        };
        if self.rise < 1.0 {
            self.rise = (self.rise + self.rise_step).min(1.0);
        }
        if !self.held {
            self.gain *= self.fall;
            if self.gain < SILENT {
                return None;
            }
        }
        let level = self.rise * self.gain;
        left *= level * self.left;
        right *= level * self.right;
        Some((left, right))
    }
}

/// The Keys Instrument.
#[derive(Debug)]
pub struct Keys {
    sample_rate: f32,
    settings: KeysSettings,
    sample: Option<Arc<Sample>>,
    voices: Vec<Voice>,
    clock: u64,
    tremolo_phase: f32,
    tone_left: f32,
    tone_right: f32,
}

impl Keys {
    pub fn new(sample_rate: f32, settings: KeysSettings) -> Self {
        Self {
            sample_rate,
            settings,
            sample: None,
            voices: vec![Voice::default(); MAX_KEYS_VOICES],
            clock: 0,
            tremolo_phase: 0.0,
            tone_left: 0.0,
            tone_right: 0.0,
        }
    }

    pub fn settings(&self) -> KeysSettings {
        self.settings
    }

    /// New settings: what sounds carries on as it was struck, and the next note takes them.
    pub fn set_settings(&mut self, settings: KeysSettings) {
        self.settings = settings;
    }

    /// Change one setting, as Automation does, clamped.
    pub fn set_setting(&mut self, index: usize, value: f32) {
        self.settings.set_index(index, value);
    }

    /// The sample the `sample` source plays, handing back the one it replaces to drop elsewhere.
    pub fn set_sample(&mut self, sample: Option<Arc<Sample>>) -> Option<Arc<Sample>> {
        // A voice still reading the old sample would read the new one from where it was: it stops.
        for voice in self.voices.iter_mut().filter(|voice| voice.sampled) {
            voice.active = false;
        }
        std::mem::replace(&mut self.sample, sample)
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|voice| voice.active).count()
    }

    pub fn note_on(&mut self, note: u8, velocity: f32) {
        let settings = self.settings;
        let sampled = settings.at(at::SOURCE) >= 0.5;
        if sampled && self.sample.is_none() {
            return;
        }
        self.clock += 1;
        let limit = (settings.at(at::VOICES) as usize).clamp(1, MAX_KEYS_VOICES);
        let slot = self.free_voice(limit);
        let voice = &mut self.voices[slot];
        let rate = self.sample_rate;
        let velocity = velocity.clamp(0.0, 1.0);
        let sense = settings.at(at::VELOCITY_SENSE);
        let loudness = (1.0 - sense) + sense * velocity.powf(1.5);

        *voice = Voice {
            rng: voice.rng ^ (u32::from(note) << 16) ^ (self.clock as u32),
            ..Voice::default()
        };
        voice.active = true;
        voice.held = true;
        voice.note = note;
        voice.started = self.clock;
        let attack = settings.at(at::ATTACK);
        voice.rise = 0.0;
        voice.rise_step = 1.0 / (attack * rate).max(1.0);
        voice.fall = 1.0;
        let pan = ((f32::from(note) - 60.0) / 48.0).clamp(-1.0, 1.0) * settings.at(at::WIDTH);
        let angle = (pan + 1.0) * 0.25 * PI;
        voice.left = angle.cos() * std::f32::consts::SQRT_2;
        voice.right = angle.sin() * std::f32::consts::SQRT_2;

        if sampled {
            let sample = self.sample.as_ref().expect("checked above");
            let root = settings.at(at::ROOT_NOTE);
            voice.sampled = true;
            voice.step =
                f64::from(2f32.powf((f32::from(note) - root) / 12.0) * sample.rate() / rate);
            voice.loudness = loudness;
            return;
        }

        let fundamental = 440.0 * 2f32.powf((f32::from(note) - 69.0) / 12.0);
        let nyquist = rate * 0.45;
        let brightness = settings.at(at::BRIGHTNESS) * (1.0 - sense * 0.5 + sense * 0.5 * velocity);
        let slope = 2.8 - 2.3 * brightness;
        let position = settings.at(at::HAMMER_POSITION);
        let stretch =
            settings.at(at::INHARMONICITY) * 0.0008 * 2f32.powf((f32::from(note) - 60.0) / 18.0);
        let strings = (settings.at(at::STRINGS) as usize).clamp(1, MAX_STRINGS);
        let detune = settings.at(at::DETUNE);
        // Lower notes ring longer, as a longer, heavier string does.
        let t60 = (settings.at(at::DECAY) * 2f32.powf(-(f32::from(note) - 60.0) / 30.0)).max(0.05);
        let damping = settings.at(at::HIGH_DAMPING);
        let wanted = settings.at(at::PARTIALS) as usize;

        let mut amplitudes = [0.0f32; MAX_PARTIALS];
        let mut power = 0.0;
        for (index, amplitude) in amplitudes
            .iter_mut()
            .enumerate()
            .take(wanted.min(MAX_PARTIALS))
        {
            let n = (index + 1) as f32;
            let comb = (PI * n * position).sin().abs().max(0.05);
            *amplitude = n.powf(-slope) * comb;
            power += *amplitude * *amplitude;
        }
        let normal = 0.16 * loudness / (power.sqrt().max(1e-6) * (strings as f32).sqrt());
        let mut count = 0;
        for string in 0..strings {
            let cents = if strings == 1 {
                0.0
            } else {
                detune * (string as f32 / (strings - 1) as f32 - 0.5)
            };
            let tuning = 2f32.powf(cents / 1200.0);
            for (index, amplitude) in amplitudes.iter().enumerate().take(wanted.min(MAX_PARTIALS)) {
                let n = (index + 1) as f32;
                let hz = n * fundamental * (1.0 + stretch * n * n).sqrt() * tuning;
                if hz >= nyquist {
                    break;
                }
                let partial_t60 = t60 / (1.0 + damping * (n - 1.0) * 0.6);
                voice.partials[count] = Partial::new(amplitude * normal, hz, partial_t60, rate);
                count += 1;
            }
        }
        voice.count = count;
        voice.remaining = 1.0;
        voice.remaining_damp = decay_per_frame(t60, rate);

        let bell = settings.at(at::BELL);
        let bell_hz = fundamental * settings.at(at::BELL_RATIO);
        if bell > 0.0 && bell_hz < nyquist {
            voice.has_bell = true;
            voice.bell = Partial::new(
                bell * 0.25 * (0.4 + 0.6 * velocity) * loudness,
                bell_hz,
                settings.at(at::BELL_DECAY),
                rate,
            );
        }

        voice.noise = settings.at(at::HAMMER_NOISE) * 0.12 * loudness * (0.3 + 0.7 * velocity);
        voice.noise_damp = decay_per_frame(NOISE_DECAY, rate);
        voice.noise_coeff = one_pole((fundamental * 8.0).min(9_000.0), rate);
        voice.drive = settings.at(at::DRIVE);
    }

    pub fn note_off(&mut self, note: u8) {
        let fall = decay_per_frame(self.settings.at(at::RELEASE), self.sample_rate);
        for voice in self
            .voices
            .iter_mut()
            .filter(|voice| voice.active && voice.held && voice.note == note)
        {
            voice.held = false;
            voice.fall = fall;
        }
    }

    /// Let every voice go, as the transport stopping does.
    pub fn release_all(&mut self) {
        let fall = decay_per_frame(self.settings.at(at::RELEASE), self.sample_rate);
        for voice in self.voices.iter_mut().filter(|voice| voice.active) {
            voice.held = false;
            voice.fall = fall;
        }
    }

    /// A voice to play the next note on: a free one, or, at `limit` sounding, the oldest.
    fn free_voice(&mut self, limit: usize) -> usize {
        let sounding = self.active_voices();
        if sounding < limit
            && let Some(free) = self.voices.iter().position(|voice| !voice.active)
        {
            return free;
        }
        // The oldest let-go voice first, then the oldest of all; it fades fast rather than clicking.
        let oldest = self
            .voices
            .iter()
            .enumerate()
            .filter(|(_, voice)| voice.active)
            .min_by_key(|(_, voice)| (voice.held, voice.started))
            .map_or(0, |(index, _)| index);
        let free = self.voices.iter().position(|voice| !voice.active);
        let steal = decay_per_frame(STEAL_FADE, self.sample_rate);
        let stolen = &mut self.voices[oldest];
        stolen.held = false;
        stolen.fall = steal;
        free.unwrap_or(oldest)
    }

    /// Render the next `left.len()` frames, replacing what is there.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        let sample = self.sample.clone();
        for voice in self.voices.iter_mut().filter(|voice| voice.active) {
            for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                match voice.next(sample.as_deref()) {
                    Some((a, b)) => {
                        *l += a;
                        *r += b;
                    }
                    None => {
                        voice.active = false;
                        break;
                    }
                }
            }
        }

        let settings = self.settings;
        let tone = one_pole(settings.at(at::TONE_HZ), self.sample_rate);
        let depth = settings.at(at::TREMOLO_DEPTH);
        let stereo = settings.at(at::TREMOLO_STEREO);
        let turn = TAU * settings.at(at::TREMOLO_RATE_HZ) / self.sample_rate;
        // The level, tone and tremolo are the whole Instrument's, so Automation moves them as it plays.
        let level = settings.at(at::LEVEL);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            *l *= level;
            *r *= level;
            if tone < 1.0 {
                self.tone_left += tone * (*l - self.tone_left);
                self.tone_right += tone * (*r - self.tone_right);
                *l = self.tone_left;
                *r = self.tone_right;
            }
            if depth > 0.0 {
                let lfo = self.tremolo_phase.sin();
                let both = 1.0 - depth * (1.0 - stereo) * (0.5 - 0.5 * lfo);
                *l *= both * (1.0 - depth * stereo * (0.5 + 0.5 * lfo));
                *r *= both * (1.0 - depth * stereo * (0.5 - 0.5 * lfo));
                self.tremolo_phase += turn;
                if self.tremolo_phase > TAU {
                    self.tremolo_phase -= TAU;
                }
            }
        }
        // The sample's handle went back to where it came from; the clone costs a count, never an allocation.
        drop(sample);
    }
}

/// A one-pole low-pass's coefficient for `hz`: 1 passes everything.
fn one_pole(hz: f32, sample_rate: f32) -> f32 {
    if hz >= sample_rate * 0.45 {
        return 1.0;
    }
    1.0 - (-TAU * hz / sample_rate).exp()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::peak;

    const RATE: f32 = 48_000.0;

    fn render(keys: &mut Keys, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut left = vec![0.0; frames];
        let mut right = vec![0.0; frames];
        keys.render(&mut left, &mut right);
        (left, right)
    }

    /// The strongest frequency in `signal`, by counting rising zero crossings.
    fn pitch(signal: &[f32]) -> f32 {
        let crossings = signal
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count();
        crossings as f32 * RATE / signal.len() as f32
    }

    #[test]
    fn every_preset_sounds_without_clipping_and_dies_away_after_its_release() {
        for preset in keys_factory_presets() {
            let mut keys = Keys::new(RATE, preset.settings);
            for note in [36, 60, 84] {
                keys.note_on(note, 1.0);
            }
            let (left, right) = render(&mut keys, 9_600);
            let loudest = peak(&left).max(peak(&right));
            assert!(loudest > 0.02, "{} is silent: {loudest}", preset.name);
            assert!(loudest < 1.0, "{} clips: {loudest}", preset.name);
            keys.release_all();
            render(&mut keys, (RATE * 12.0) as usize);
            assert_eq!(keys.active_voices(), 0, "{} rings on", preset.name);
        }
    }

    #[test]
    fn a_note_sounds_at_its_pitch_and_a_harder_one_is_louder() {
        let pure = KeysSettings::with(&[
            ("partials", 1.0),
            ("strings", 1.0),
            ("hammerNoise", 0.0),
            ("width", 0.0),
            ("inharmonicity", 0.0),
        ]);
        let mut keys = Keys::new(RATE, pure);
        keys.note_on(69, 1.0);
        let (loud, _) = render(&mut keys, 48_000);
        assert!((pitch(&loud) - 440.0).abs() < 3.0, "{}", pitch(&loud));

        let mut soft = Keys::new(RATE, pure);
        soft.note_on(69, 0.2);
        assert!(peak(&render(&mut soft, 4_800).0) < peak(&loud[..4_800]) * 0.6);
    }

    #[test]
    fn letting_a_key_go_damps_it_and_holding_it_lets_it_ring() {
        let mut held = Keys::new(RATE, KeysSettings::default());
        held.note_on(60, 0.8);
        let mut released = Keys::new(RATE, KeysSettings::default());
        released.note_on(60, 0.8);
        render(&mut held, 4_800);
        render(&mut released, 4_800);
        released.note_off(60);
        let later_held = render(&mut held, 24_000).0;
        let later_released = render(&mut released, 24_000).0;
        assert!(peak(&later_held[19_200..]) > 0.01);
        assert!(peak(&later_released[19_200..]) < peak(&later_held[19_200..]) * 0.05);
    }

    #[test]
    fn low_notes_lean_left_and_high_right_by_the_width() {
        let mut keys = Keys::new(RATE, KeysSettings::with(&[("width", 1.0)]));
        keys.note_on(30, 1.0);
        let (left, right) = render(&mut keys, 4_800);
        assert!(peak(&left) > peak(&right) * 2.0);
    }

    #[test]
    fn a_sample_plays_at_each_keys_pitch_from_its_root_note() {
        // A 100 Hz sine, a second long, rooted at the G below middle C.
        let data: Vec<f32> = (0..48_000)
            .map(|frame| (TAU * 100.0 * frame as f32 / RATE).sin() * 0.5)
            .collect();
        let mut keys = Keys::new(
            RATE,
            KeysSettings::with(&[("source", 1.0), ("rootNote", 55.0), ("width", 0.0)]),
        );
        // Without a sample the sample source is silent.
        keys.note_on(55, 1.0);
        assert_eq!(keys.active_voices(), 0);
        assert!(
            keys.set_sample(Some(Arc::new(Sample::new(data, 1, RATE))))
                .is_none()
        );
        keys.note_on(67, 1.0);
        let (left, _) = render(&mut keys, 12_000);
        assert!(
            (pitch(&left) - 200.0).abs() < 3.0,
            "an octave up plays twice as fast: {}",
            pitch(&left)
        );
        // An octave up, it runs out in half the time.
        render(&mut keys, 14_000);
        assert_eq!(keys.active_voices(), 0);
    }

    #[test]
    fn past_its_voices_the_oldest_is_stolen() {
        let mut keys = Keys::new(
            RATE,
            KeysSettings::with(&[("voices", 2.0), ("decay", 30.0)]),
        );
        for note in [60, 62, 64] {
            keys.note_on(note, 1.0);
        }
        render(&mut keys, 2_400);
        assert_eq!(keys.active_voices(), 2);
    }
}
