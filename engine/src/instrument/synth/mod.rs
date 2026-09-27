//! The Synth: a polyphonic subtractive Instrument.
//!
//! Each voice is two oscillators, detuned against each other, through a
//! resonant filter with its own envelope, shaped by an amplitude envelope.
//! One LFO per voice can be routed to pitch, the filter or the amplitude.
//! Notes glide from the last pitch the voice played, and when every voice is
//! busy the oldest is taken.
//!
//! `params.rs` declares every setting once — name, range and default — so
//! the UI can draw a control for each and the **Assistant** can set them by
//! name. `presets.rs` holds the factory presets.
//!
//! **No clicks.** A step in the output is a click, so: no envelope stage may
//! take zero time (`MIN_STAGE`), a voice's oscillators and filter are only
//! reset when the voice is silent, re-triggering carries on from the level
//! the envelope has reached, and modulation that multiplies the output (the
//! LFO on the amplitude) is ramped across each control block rather than
//! stepped at its edge.

mod params;
mod presets;

pub use params::{MAX_VOICES, PARAMS, Param, SynthSettings, parameters_json};
pub use presets::{Preset, factory_presets, presets_json};

use params::{LfoTarget, MIN_STAGE};

use crate::dsp::{Biquad, Envelope, Lfo, Oscillator, note_to_frequency};

/// Keeps a full chord of voices from clipping. A preset's `level` sits on
/// top of it, so the presets can be balanced against each other.
const VOICE_GAIN: f32 = 0.25;

/// How often modulation is recalculated, in samples: about 1.5 kHz at 48 kHz,
/// far above any LFO or envelope, and cheap enough for every voice to have
/// its own filter coefficients.
const CONTROL_FRAMES: usize = 32;

/// How far the cutoff has to move before the filter is redesigned, as a
/// fraction. Below this the change is inaudible and the work is wasted.
const CUTOFF_TOLERANCE: f32 = 0.001;

/// An LFO at full depth on pitch bends this far either way.
const LFO_PITCH_SEMITONES: f32 = 2.0;
/// An LFO at full depth on the filter sweeps this far either way.
const LFO_FILTER_OCTAVES: f32 = 4.0;

#[derive(Clone, Copy, Debug)]
struct Voice {
    note: u8,
    velocity: f32,
    /// When the note started, so the oldest can be taken.
    started: u64,
    osc1: Oscillator,
    osc2: Oscillator,
    filter: Biquad,
    /// The cutoff the filter was last designed for.
    filter_hz: f32,
    amp: Envelope,
    filter_env: Envelope,
    lfo: Lfo,
    /// The pitch being played, in (fractional) MIDI notes: it glides towards
    /// `target_note`.
    note_now: f32,
    target_note: f32,
    /// Semitones per sample while gliding, or 0 once it has arrived.
    glide_step: f32,
    /// Set once the voice has played, so glide knows where to come from.
    played: bool,
}

impl Voice {
    fn new(sample_rate: f32, settings: &SynthSettings) -> Self {
        Self {
            note: 0,
            velocity: 0.0,
            started: 0,
            osc1: Oscillator::new(settings.osc1_wave),
            osc2: Oscillator::new(settings.osc2_wave),
            filter: Biquad::of_kind(
                settings.filter_kind,
                sample_rate,
                settings.cutoff_hz,
                settings.resonance,
            ),
            filter_hz: settings.cutoff_hz,
            amp: Envelope::new(
                sample_rate,
                settings.attack,
                settings.decay,
                settings.sustain,
                settings.release,
            ),
            filter_env: Envelope::new(
                sample_rate,
                settings.filter_attack,
                settings.filter_decay,
                settings.filter_sustain,
                settings.filter_release,
            ),
            lfo: Lfo::default(),
            note_now: 0.0,
            target_note: 0.0,
            glide_step: 0.0,
            played: false,
        }
    }
}

/// A polyphonic subtractive Synth.
#[derive(Clone, Debug)]
pub struct Synth {
    sample_rate: f32,
    settings: SynthSettings,
    /// Always `MAX_VOICES` of them; `settings.voices` says how many play, so
    /// changing the polyphony never allocates.
    voices: Vec<Voice>,
    notes_started: u64,
}

impl Synth {
    pub fn new(sample_rate: f32, settings: SynthSettings) -> Self {
        let mut synth = Self {
            sample_rate,
            settings,
            voices: vec![Voice::new(sample_rate, &settings); MAX_VOICES],
            notes_started: 0,
        };
        synth.apply_settings();
        synth
    }

    /// The sound this Synth is making, as the settings that describe it.
    pub fn settings(&self) -> SynthSettings {
        self.settings
    }

    /// Change the sound. Notes already sounding keep their level and carry
    /// on with the new settings, so a knob can be turned while playing.
    pub fn set_settings(&mut self, settings: SynthSettings) {
        self.settings = settings;
        self.apply_settings();
    }

    /// Start a note. `velocity` is 0..=1. Retriggers the note if it is
    /// already sounding, otherwise takes a free voice or steals one.
    pub fn note_on(&mut self, note: u8, velocity: f32) {
        let index = self.voice_for(note);
        self.notes_started += 1;
        let started = self.notes_started;
        let glide = self.settings.glide;
        let rate = self.sample_rate;

        let voice = &mut self.voices[index];
        if !voice.amp.is_active() {
            // Silent, so nothing can jump: start the waveforms together.
            voice.osc1.reset();
            voice.osc2.reset();
            voice.filter.reset();
            voice.lfo.reset();
        }
        voice.note = note;
        voice.velocity = velocity.clamp(0.0, 1.0);
        voice.started = started;
        voice.target_note = f32::from(note);
        if glide > 0.0 && voice.played {
            let distance = voice.target_note - voice.note_now;
            voice.glide_step = distance / (glide * rate);
        } else {
            voice.note_now = voice.target_note;
            voice.glide_step = 0.0;
        }
        voice.played = true;
        voice.amp.trigger();
        voice.filter_env.trigger();
    }

    /// Release a note; it fades out over the release time.
    pub fn note_off(&mut self, note: u8) {
        for voice in &mut self.voices {
            if voice.note == note && !voice.amp.is_released() {
                voice.amp.release();
                voice.filter_env.release();
            }
        }
    }

    /// How many voices are sounding, including ones fading out.
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.amp.is_active()).count()
    }

    /// Render the next `output.len()` samples, replacing what is there.
    pub fn render(&mut self, output: &mut [f32]) {
        output.fill(0.0);
        let count = self.settings.voices.clamp(1, MAX_VOICES);
        for index in 0..count {
            if self.voices[index].amp.is_active() {
                self.render_voice(index, output);
            }
        }
    }

    /// Which voice plays `note`: the one already playing it, else a silent
    /// one, else the one that has been released longest, else the oldest.
    fn voice_for(&self, note: u8) -> usize {
        let count = self.settings.voices.clamp(1, MAX_VOICES);
        let voices = &self.voices[..count];
        let oldest = |pick: &dyn Fn(&Voice) -> bool| {
            voices
                .iter()
                .enumerate()
                .filter(|(_, v)| pick(v))
                .min_by_key(|(_, v)| v.started)
                .map(|(index, _)| index)
        };
        voices
            .iter()
            .position(|v| v.amp.is_active() && v.note == note)
            .or_else(|| voices.iter().position(|v| !v.amp.is_active()))
            .or_else(|| oldest(&|v| v.amp.is_released()))
            .or_else(|| oldest(&|_| true))
            .unwrap_or(0)
    }

    /// Push the settings into every voice, keeping where each has got to.
    fn apply_settings(&mut self) {
        let s = self.settings;
        let rate = self.sample_rate;
        for voice in &mut self.voices {
            voice.osc1.set_waveform(s.osc1_wave);
            voice.osc2.set_waveform(s.osc2_wave);
            voice
                .amp
                .set_shape(s.attack.max(MIN_STAGE), s.decay, s.sustain, s.release);
            voice.filter_env.set_shape(
                s.filter_attack.max(MIN_STAGE),
                s.filter_decay,
                s.filter_sustain,
                s.filter_release,
            );
            voice.lfo.set_rate(s.lfo_rate_hz, rate);
        }
    }

    fn render_voice(&mut self, index: usize, output: &mut [f32]) {
        let settings = self.settings;
        let rate = self.sample_rate;
        let voice = &mut self.voices[index];
        let level = voice.velocity * settings.level * VOICE_GAIN;
        let mut written = 0;

        while written < output.len() && voice.amp.is_active() {
            let frames = CONTROL_FRAMES.min(output.len() - written);

            // Pitch: glide, then the LFO's bend.
            if voice.glide_step != 0.0 {
                let remaining = voice.target_note - voice.note_now;
                let moved = voice.glide_step * frames as f32;
                if moved.abs() >= remaining.abs() {
                    voice.note_now = voice.target_note;
                    voice.glide_step = 0.0;
                } else {
                    voice.note_now += moved;
                }
            }
            let lfo = voice.lfo.value();
            let bend = match settings.lfo_target {
                LfoTarget::Pitch => lfo * settings.lfo_depth * LFO_PITCH_SEMITONES,
                _ => 0.0,
            };
            let frequency = note_to_frequency(voice.note_now + bend);
            voice.osc1.set_frequency(frequency, rate);
            voice
                .osc2
                .set_frequency(frequency * cents(settings.osc2_detune), rate);

            // The filter: its envelope, and the LFO's sweep.
            let sweep = match settings.lfo_target {
                LfoTarget::Filter => lfo * settings.lfo_depth * LFO_FILTER_OCTAVES,
                _ => 0.0,
            };
            let octaves = settings.filter_env_amount * voice.filter_env.level() + sweep;
            let cutoff = (settings.cutoff_hz * 2.0_f32.powf(octaves)).clamp(20.0, 20_000.0);
            if (cutoff - voice.filter_hz).abs() > voice.filter_hz * CUTOFF_TOLERANCE {
                let state = voice.filter;
                voice.filter =
                    Biquad::of_kind(settings.filter_kind, rate, cutoff, settings.resonance);
                voice.filter.restore_state(&state);
                voice.filter_hz = cutoff;
            }

            // The LFO on the amplitude, ramped across the block: a step in a
            // gain is a step in the output, and that is a click.
            let tremolo = |value: f32| match settings.lfo_target {
                LfoTarget::Amp => 1.0 - settings.lfo_depth * (0.5 + 0.5 * value),
                _ => 1.0,
            };
            voice.lfo.advance(frames);
            let from = level * tremolo(lfo);
            let to = level * tremolo(voice.lfo.value());
            let slope = (to - from) / frames as f32;

            let mix = settings.osc_mix;
            for (offset, sample) in output[written..written + frames].iter_mut().enumerate() {
                let raw = voice.osc1.next_sample() * (1.0 - mix) + voice.osc2.next_sample() * mix;
                let gain = from + slope * offset as f32;
                voice.filter_env.next_level();
                *sample += voice.filter.process(raw) * voice.amp.next_level() * gain;
            }
            written += frames;
        }
    }
}

/// The frequency ratio of `cents` cents.
fn cents(cents: f32) -> f32 {
    2.0_f32.powf(cents / 1_200.0)
}

#[cfg(test)]
mod tests;
