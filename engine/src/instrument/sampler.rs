//! The Drum Sampler: pads that each play one WAV sample.
//!
//! A note triggers the pad that answers to it; the sample then plays to its
//! end, since a drum has no note off. Each pad has its own volume, pan, pitch
//! and choke group, and pads sharing a choke group cut each other off — which
//! is how a closed hi-hat silences an open one.
//!
//! Samples are held behind an `Arc`, so a host can decode one off the audio
//! thread, swap it in, and drop the old one somewhere it is safe to free.

use std::sync::Arc;

use crate::instrument::wav::Sample;

/// The most pads a kit can have. The bundled Starter Kit has 22, and room
/// is left over for a musician's own.
pub const MAX_PADS: usize = 32;

/// How many pads can sound at once before the oldest is cut.
const VOICES: usize = 16;

/// Seconds a choked or stolen voice takes to fade, so it never clicks.
const FADE_SECONDS: f32 = 0.005;

/// Pitch in semitones, either way.
const MAX_SEMITONES: f32 = 24.0;

/// What a pad does with its sample. Plain numbers: setting these on the
/// audio thread allocates nothing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PadSettings {
    /// The note that triggers this pad.
    pub note: u8,
    /// Linear gain, 0 to 2.
    pub volume: f32,
    /// -1 (left) to 1 (right). Equal power: a centred pad plays at -3 dB
    /// on each side, so moving it across doesn't change how loud it is.
    pub pan: f32,
    /// Semitones, -24 to 24: how far the sample is transposed.
    pub pitch: f32,
    /// Pads sharing a group above 0 cut each other off; 0 is no choking.
    pub choke_group: u8,
}

impl Default for PadSettings {
    fn default() -> Self {
        Self {
            note: 0,
            volume: 1.0,
            pan: 0.0,
            pitch: 0.0,
            choke_group: 0,
        }
    }
}

/// A pad's settings Automation can move: its numbers, but not the note
/// that triggers it or its choke group, which pick rather than measure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PadParam {
    Volume,
    Pan,
    Pitch,
}

impl PadParam {
    /// Every one, in the order a pad's Automation keeps them.
    pub const ALL: [Self; 3] = [Self::Volume, Self::Pan, Self::Pitch];

    /// The setting the host names: "volume", "pan" or "pitch", as the
    /// Project calls a pad's.
    pub fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|param| param.name() == name)
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Volume => "volume",
            Self::Pan => "pan",
            Self::Pitch => "pitch",
        }
    }

    /// Where it is in `ALL`.
    pub fn index(self) -> usize {
        self as usize
    }

    /// `value`, within the range a pad takes it in.
    fn clamp(self, value: f32) -> f32 {
        match self {
            Self::Volume => value.clamp(0.0, 2.0),
            Self::Pan => value.clamp(-1.0, 1.0),
            Self::Pitch => value.clamp(-MAX_SEMITONES, MAX_SEMITONES),
        }
    }

    fn set(self, settings: &mut PadSettings, value: f32) {
        match self {
            Self::Volume => settings.volume = value,
            Self::Pan => settings.pan = value,
            Self::Pitch => settings.pitch = value,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Pad {
    /// As the host set them: what an automated setting goes back to when its
    /// Automation is taken away.
    settings: PadSettings,
    /// The value Automation holds each of `PadParam::ALL` at, over the one
    /// the host set, or none where it isn't automated.
    automated: [Option<f32>; 3],
    sample: Option<Arc<Sample>>,
}

impl Pad {
    /// What the pad plays with: its settings, with Automation's values over
    /// the ones it moves.
    fn played(&self) -> PadSettings {
        let mut settings = self.settings;
        for param in PadParam::ALL {
            if let Some(value) = self.automated[param.index()] {
                param.set(&mut settings, value);
            }
        }
        settings
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Voice {
    pad: usize,
    /// Where in the sample this voice is, in frames.
    position: f64,
    /// Frames of the sample per frame of output at the sample's own pitch:
    /// its rate against the output's.
    rate: f64,
    /// Frames of the sample per frame of output: rate and pitch together.
    step: f64,
    velocity: f32,
    left_gain: f32,
    right_gain: f32,
    /// 1 while the voice plays out; falls to 0 when it is choked or stolen.
    fade: f32,
    fade_step: f32,
    playing: bool,
    started: u64,
}

impl Voice {
    /// Set its speed and each side's gain from its pad's settings.
    fn tune(&mut self, settings: PadSettings) {
        self.step = self.rate * f64::from(2.0_f32.powf(settings.pitch / 12.0));
        // Equal power, so panning doesn't change how loud a pad is.
        let angle = (settings.pan + 1.0) * std::f32::consts::FRAC_PI_4;
        let gain = settings.volume * self.velocity;
        self.left_gain = gain * angle.cos();
        self.right_gain = gain * angle.sin();
    }
}

/// An Instrument whose pads each play a sample.
#[derive(Clone, Debug)]
pub struct DrumSampler {
    sample_rate: f32,
    pads: Vec<Pad>,
    voices: Vec<Voice>,
    triggered: u64,
}

impl DrumSampler {
    /// An empty kit of `pads` silent pads, answering to no notes yet.
    pub fn new(sample_rate: f32, pads: usize) -> Self {
        Self {
            sample_rate,
            pads: vec![Pad::default(); pads.clamp(1, MAX_PADS)],
            voices: vec![Voice::default(); VOICES],
            triggered: 0,
        }
    }

    /// The bundled starter kit on a sampler of `pads` pads, decoded and
    /// ready to play: the kit fills as many pads as it reaches, and any pad
    /// past it starts empty, for the host to set and load itself. `pads` is
    /// clamped to 1..=`MAX_PADS`.
    pub fn starter_kit(sample_rate: f32, pads: usize) -> Self {
        let mut sampler = Self::new(sample_rate, pads);
        for (index, kit_pad) in super::kit::STARTER_KIT.iter().enumerate() {
            if index >= sampler.pad_count() {
                break;
            }
            sampler.set_pad(
                index,
                PadSettings {
                    note: kit_pad.note,
                    choke_group: kit_pad.choke_group,
                    ..PadSettings::default()
                },
            );
            if let Some(sample) = super::kit_sample(index) {
                sampler.set_sample(index, Some(Arc::new(sample)));
            }
        }
        sampler
    }

    pub fn pad_count(&self) -> usize {
        self.pads.len()
    }

    /// Change what a pad does. Allocates nothing, so it is safe on the audio
    /// thread; a pad that doesn't exist is ignored.
    /// A hit already sounding carries on with the new volume, pan and pitch,
    /// unless Automation holds them.
    pub fn set_pad(&mut self, pad: usize, settings: PadSettings) {
        if let Some(target) = self.pads.get_mut(pad) {
            target.settings = PadSettings {
                volume: settings.volume.clamp(0.0, 2.0),
                pan: settings.pan.clamp(-1.0, 1.0),
                pitch: settings.pitch.clamp(-MAX_SEMITONES, MAX_SEMITONES),
                ..settings
            };
            self.retune(pad);
        }
    }

    /// Hold one of a pad's numbers at `value`, as its Automation says, over
    /// what the host set; `None` gives it back the host's. Hits sounding
    /// follow it, so a volume ramp fades a cymbal that is ringing. Only a
    /// change is applied, and nothing allocates.
    pub fn automate(&mut self, pad: usize, param: PadParam, value: Option<f32>) {
        let Some(target) = self.pads.get_mut(pad) else {
            return;
        };
        let value = value.map(|value| param.clamp(value));
        let slot = &mut target.automated[param.index()];
        if *slot != value {
            *slot = value;
            self.retune(pad);
        }
    }

    /// Bring the hits sounding on `pad` into line with what it plays with now.
    fn retune(&mut self, pad: usize) {
        let settings = self.pads[pad].played();
        for voice in self.voices.iter_mut().filter(|v| v.playing && v.pad == pad) {
            voice.tune(settings);
        }
    }

    /// What a pad is set to. A host keeps its own copy of the settings it
    /// sent, so only the tests read them back.
    #[cfg(test)]
    pub fn pad_settings(&self, pad: usize) -> Option<PadSettings> {
        self.pads.get(pad).map(|pad| pad.settings)
    }

    /// Put a sample on a pad, handing back the one it replaces so a host can
    /// drop it off the audio thread. Voices playing the old sample are faded
    /// out rather than left reading it.
    pub fn set_sample(&mut self, pad: usize, sample: Option<Arc<Sample>>) -> Option<Arc<Sample>> {
        if pad >= self.pads.len() {
            return sample;
        }
        self.fade_out(|voice| voice.pad == pad);
        std::mem::replace(&mut self.pads[pad].sample, sample)
    }

    /// The pad a note triggers, if any.
    pub fn pad_for_note(&self, note: u8) -> Option<usize> {
        self.pads.iter().position(|pad| pad.settings.note == note)
    }

    /// Play the pad this note triggers. `velocity` is 0..=1.
    pub fn note_on(&mut self, note: u8, velocity: f32) {
        let Some(index) = self.pad_for_note(note) else {
            return;
        };
        let pad = &self.pads[index];
        let Some(rate) = pad.sample.as_ref().map(|sample| sample.rate()) else {
            return;
        };
        let settings = pad.played();

        // A pad in a choke group cuts off everything in that group, itself
        // included: one hi-hat at a time.
        if settings.choke_group > 0 {
            let group = settings.choke_group;
            let groups: [u8; MAX_PADS] = std::array::from_fn(|pad| {
                self.pads.get(pad).map_or(0, |pad| pad.settings.choke_group)
            });
            self.fade_out(|voice| groups[voice.pad] == group);
        }

        let slot = self.free_voice();

        self.triggered += 1;
        let mut voice = Voice {
            pad: index,
            position: 0.0,
            rate: f64::from(rate / self.sample_rate),
            velocity: velocity.clamp(0.0, 1.0),
            fade: 1.0,
            playing: true,
            started: self.triggered,
            ..Voice::default()
        };
        voice.tune(settings);
        self.voices[slot] = voice;
    }

    /// Drums are one-shots: a note off leaves them to play out.
    pub fn note_off(&mut self, _note: u8) {}

    /// Stop everything, as the transport does on stop or a loop wrap. The
    /// fade keeps it from clicking.
    pub fn release_all(&mut self) {
        self.fade_out(|_| true);
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|voice| voice.playing).count()
    }

    /// Render the next `left.len()` frames, replacing what is there.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        for voice in self.voices.iter_mut().filter(|voice| voice.playing) {
            let Some(sample) = self.pads[voice.pad].sample.as_ref() else {
                voice.playing = false;
                continue;
            };
            let frames = sample.frames() as f64;
            for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                if voice.position >= frames || voice.fade <= 0.0 {
                    voice.playing = false;
                    break;
                }
                let level = voice.fade;
                *l += sample.between(voice.position, 0) * voice.left_gain * level;
                *r += sample.between(voice.position, 1) * voice.right_gain * level;
                voice.position += voice.step;
                voice.fade = (voice.fade - voice.fade_step).max(0.0);
            }
        }
    }

    /// Start fading out every voice `choose` picks, which is what choking,
    /// stopping and voice stealing all do.
    fn fade_out(&mut self, choose: impl Fn(&Voice) -> bool) {
        let step = 1.0 / (FADE_SECONDS * self.sample_rate).max(1.0);
        for voice in self.voices.iter_mut().filter(|v| v.playing) {
            if choose(voice) {
                voice.fade_step = voice.fade_step.max(step);
            }
        }
    }

    /// A voice to play the next hit on: a silent one, or the oldest.
    fn free_voice(&mut self) -> usize {
        self.voices
            .iter()
            .position(|voice| !voice.playing)
            .unwrap_or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, voice)| voice.started)
                    .map_or(0, |(index, _)| index)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rms};
    use crate::instrument::wav;

    const RATE: f32 = 48_000.0;
    const KICK: usize = 0;
    const OPEN_HAT: usize = 4;

    fn kit() -> DrumSampler {
        DrumSampler::starter_kit(RATE, super::super::STARTER_KIT_PADS)
    }

    /// Render `frames` frames, returning left and right.
    fn render(sampler: &mut DrumSampler, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut left = vec![0.0; frames];
        let mut right = vec![0.0; frames];
        sampler.render(&mut left, &mut right);
        (left, right)
    }

    #[test]
    fn the_starter_kit_has_a_sample_on_every_pad() {
        let pads = kit().pad_count();
        assert_eq!(pads, 22);
        assert_eq!(kit().pad_settings(KICK).unwrap().note, 36);
        for pad in 0..pads {
            let mut sampler = kit();
            let note = sampler.pad_settings(pad).unwrap().note;
            sampler.note_on(note, 1.0);
            let level = peak(&render(&mut sampler, 24_000).0);
            assert!(level > 0.1, "pad {pad} sounds: {level}");
        }
    }

    #[test]
    fn a_note_plays_its_pad_and_a_note_with_no_pad_is_silent() {
        let mut sampler = kit();
        sampler.note_on(36, 1.0);
        let (left, right) = render(&mut sampler, 4_800);
        assert!(peak(&left) > 0.3, "the kick sounds");
        assert_eq!(left, right, "a mono sample plays down the middle");

        let mut quiet = kit();
        quiet.note_on(100, 1.0);
        assert_eq!(peak(&render(&mut quiet, 4_800).0), 0.0);
        assert_eq!(quiet.active_voices(), 0);
    }

    #[test]
    fn a_one_shot_plays_on_past_its_note_off_and_then_stops() {
        let mut sampler = kit();
        sampler.note_on(36, 1.0);
        sampler.note_off(36);
        assert!(peak(&render(&mut sampler, 2_400).0) > 0.3, "still playing");
        assert_eq!(sampler.active_voices(), 1);
        // The kick is under half a second long.
        render(&mut sampler, 48_000);
        assert_eq!(sampler.active_voices(), 0);
        assert_eq!(peak(&render(&mut sampler, 1_024).0), 0.0);
    }

    #[test]
    fn several_pads_play_at_once() {
        let mut sampler = kit();
        for note in [36, 38, 42] {
            sampler.note_on(note, 0.9);
        }
        assert_eq!(sampler.active_voices(), 3);
        assert!(peak(&render(&mut sampler, 2_400).0) > 0.3);
    }

    #[test]
    fn volume_pan_and_velocity_set_each_side_s_level() {
        let mut sampler = kit();
        let settings = sampler.pad_settings(KICK).unwrap();
        sampler.set_pad(
            KICK,
            PadSettings {
                pan: 1.0,
                ..settings
            },
        );
        sampler.note_on(36, 1.0);
        let (left, right) = render(&mut sampler, 4_800);
        assert!(peak(&left) < 1e-6, "hard right leaves nothing on the left");
        assert!(peak(&right) > 0.3);

        let mut quieter = kit();
        quieter.set_pad(
            KICK,
            PadSettings {
                volume: 0.5,
                ..settings
            },
        );
        quieter.note_on(36, 1.0);
        let mut loud = kit();
        loud.note_on(36, 1.0);
        let full = peak(&render(&mut loud, 4_800).0);
        let ratio = peak(&render(&mut quieter, 4_800).0) / full;
        assert!((ratio - 0.5).abs() < 0.01, "ratio {ratio}");

        let mut soft = kit();
        soft.note_on(36, 0.25);
        let ratio = peak(&render(&mut soft, 4_800).0) / full;
        assert!((ratio - 0.25).abs() < 0.01, "velocity ratio {ratio}");
    }

    #[test]
    fn automation_holds_a_pads_number_over_its_own_and_a_ringing_hit_follows() {
        let mut sampler = kit();
        sampler.note_on(36, 1.0);
        let before = peak(&render(&mut sampler, 480).0);
        sampler.automate(KICK, PadParam::Volume, Some(0.0));
        assert_eq!(
            peak(&render(&mut sampler, 480).0),
            0.0,
            "the ringing kick follows"
        );
        // Out of range is held at the end of the range; the fixed value stays.
        sampler.automate(KICK, PadParam::Pitch, Some(99.0));
        assert_eq!(sampler.pads[KICK].played().pitch, MAX_SEMITONES);
        assert_eq!(sampler.pad_settings(KICK).unwrap().volume, 1.0);
        // Taken away, the hit is back at the pad's own volume.
        sampler.automate(KICK, PadParam::Volume, None);
        assert!(peak(&render(&mut sampler, 480).0) > 0.1 * before);
        assert_eq!(PadParam::named("pan"), Some(PadParam::Pan));
        assert_eq!(PadParam::named("note"), None);
    }

    #[test]
    fn pitch_transposes_the_sample_and_makes_it_shorter() {
        let length = |semitones: f32| {
            let mut sampler = kit();
            let settings = sampler.pad_settings(KICK).unwrap();
            sampler.set_pad(
                KICK,
                PadSettings {
                    pitch: semitones,
                    ..settings
                },
            );
            sampler.note_on(36, 1.0);
            let (left, _) = render(&mut sampler, 96_000);
            left.iter().rposition(|s| s.abs() > 1e-4).unwrap_or(0)
        };
        let plain = length(0.0);
        // An octave up plays twice as fast, so it lasts half as long.
        let octave_up = length(12.0);
        let ratio = octave_up as f32 / plain as f32;
        assert!((ratio - 0.5).abs() < 0.02, "ratio {ratio}");
        assert!(length(-12.0) > plain);
    }

    #[test]
    fn the_closed_hat_chokes_the_open_one() {
        // The open hat rings for about half a second on its own.
        let mut ringing = kit();
        ringing.note_on(46, 1.0);
        let (alone, _) = render(&mut ringing, 24_000);
        let ringing_tail = rms(&alone[9_600..]);
        assert!(ringing_tail > 1e-3, "the open hat rings: {ringing_tail}");

        // Closing the hat a tenth of a second in cuts that tail off.
        let mut choked = kit();
        choked.note_on(46, 1.0);
        render(&mut choked, 4_800);
        choked.note_on(42, 1.0);
        let (after, _) = render(&mut choked, 19_200);
        // Past the closed hat's own short sound, only the choked tail is left.
        let choked_tail = rms(&after[4_800..]);
        assert!(
            choked_tail < ringing_tail / 20.0,
            "choked: {choked_tail} vs {ringing_tail}"
        );
        assert_eq!(choked.active_voices(), 0);
    }

    #[test]
    fn pads_outside_a_choke_group_ring_on() {
        let mut sampler = kit();
        sampler.note_on(46, 1.0); // Open hat: choke group 1.
        sampler.note_on(36, 1.0); // Kick: no group.
        render(&mut sampler, 4_800);
        sampler.note_on(42, 1.0); // Closed hat chokes the open one only.
        render(&mut sampler, 2_400);
        assert!(sampler.active_voices() >= 2, "the kick plays on");
    }

    #[test]
    fn choking_fades_rather_than_cutting_so_it_doesnt_click() {
        // Two pads in one group, the second silent, so what is left to hear
        // is the first one fading: a steady sample shows that plainly.
        let mut sampler = DrumSampler::new(RATE, 2);
        for (pad, note) in [(0, 60), (1, 61)] {
            sampler.set_pad(
                pad,
                PadSettings {
                    note,
                    choke_group: 1,
                    ..PadSettings::default()
                },
            );
        }
        sampler.set_sample(0, Some(Arc::new(Sample::new(vec![1.0; 48_000], 1, RATE))));
        sampler.set_sample(1, Some(Arc::new(Sample::new(vec![0.0; 48_000], 1, RATE))));
        sampler.note_on(60, 1.0);
        render(&mut sampler, 480);

        sampler.note_on(61, 1.0);
        let (left, _) = render(&mut sampler, 2_400);
        let biggest_jump = left
            .windows(2)
            .fold(0.0_f32, |max, pair| max.max((pair[1] - pair[0]).abs()));
        assert!(biggest_jump < 0.05, "step of {biggest_jump} in the fade");
        // The fade is over within 10 ms, and silent after it.
        assert_eq!(peak(&left[480..]), 0.0);
    }

    #[test]
    fn stealing_the_oldest_voice_keeps_the_newest_hits() {
        let mut sampler = kit();
        for _ in 0..VOICES + 4 {
            sampler.note_on(36, 1.0);
            render(&mut sampler, 64);
        }
        assert!(sampler.active_voices() <= VOICES);
        assert!(peak(&render(&mut sampler, 2_400).0) > 0.3);
    }

    #[test]
    fn a_loaded_sample_replaces_the_pad_s_own_and_the_old_one_comes_back() {
        let mut sampler = kit();
        let square = Sample::new(vec![0.6; 48_000], 1, RATE);
        let old = sampler.set_sample(OPEN_HAT, Some(Arc::new(square)));
        assert!(old.is_some(), "the kit's sample comes back to be dropped");
        sampler.note_on(46, 1.0);
        let (left, _) = render(&mut sampler, 4_800);
        let centred = 0.6 * std::f32::consts::FRAC_1_SQRT_2;
        assert!((peak(&left) - centred).abs() < 1e-3, "the new sample plays");
    }

    #[test]
    fn a_pad_with_no_sample_is_silent() {
        let mut sampler = DrumSampler::new(RATE, 4);
        sampler.set_pad(
            0,
            PadSettings {
                note: 36,
                ..PadSettings::default()
            },
        );
        sampler.note_on(36, 1.0);
        assert_eq!(sampler.active_voices(), 0);
        assert_eq!(peak(&render(&mut sampler, 1_024).0), 0.0);
    }

    #[test]
    fn a_pad_past_the_kit_s_end_is_silent_rather_than_playing_another_pad_s_sound() {
        let kit_pads = super::super::STARTER_KIT_PADS;
        let mut sampler = DrumSampler::starter_kit(RATE, MAX_PADS);
        assert_eq!(sampler.pad_count(), MAX_PADS);
        // Putting the kit's own sample back, as taking the musician's off
        // does, finds none past the kit: the index doesn't wrap around.
        assert!(super::super::kit_sample(kit_pads).is_none());
        assert!(super::super::kit_sample(MAX_PADS - 1).is_none());
        for pad in kit_pads..MAX_PADS {
            let note = 76 + (pad - kit_pads) as u8;
            sampler.set_pad(
                pad,
                PadSettings {
                    note,
                    ..PadSettings::default()
                },
            );
            sampler.set_sample(pad, super::super::kit_sample(pad).map(Arc::new));
            sampler.note_on(note, 1.0);
            assert_eq!(sampler.active_voices(), 0, "pad {pad} plays nothing");
            assert_eq!(peak(&render(&mut sampler, 1_024).0), 0.0);
        }
        // The last of the kit's own still sounds beside them.
        let last = sampler.pad_settings(kit_pads - 1).unwrap().note;
        sampler.note_on(last, 1.0);
        assert!(peak(&render(&mut sampler, 24_000).0) > 0.1);
    }

    #[test]
    fn a_sample_recorded_at_another_rate_plays_at_its_own_speed() {
        let mut sampler = DrumSampler::new(RATE, 1);
        sampler.set_pad(
            0,
            PadSettings {
                note: 36,
                ..PadSettings::default()
            },
        );
        // Half a second at 24 kHz plays for half a second at 48 kHz.
        sampler.set_sample(
            0,
            Some(Arc::new(Sample::new(vec![0.5; 12_000], 1, 24_000.0))),
        );
        sampler.note_on(36, 1.0);
        let (left, _) = render(&mut sampler, 48_000);
        let last = left.iter().rposition(|s| s.abs() > 1e-4).unwrap_or(0);
        assert!((23_000..=24_100).contains(&last), "ends at {last}");
    }

    #[test]
    fn stopping_silences_every_pad() {
        let mut sampler = kit();
        sampler.note_on(36, 1.0);
        sampler.note_on(46, 1.0);
        sampler.release_all();
        render(&mut sampler, 1_024);
        assert_eq!(sampler.active_voices(), 0);
    }

    #[test]
    fn a_wav_the_host_hands_over_can_be_played_from_its_bytes() {
        // Bytes as a host would hand them over, rather than a decoded kit.
        let bytes = include_bytes!("../../assets/kits/starter/snare.wav");
        let sample = wav::decode(bytes).unwrap();
        let mut sampler = DrumSampler::new(RATE, 1);
        sampler.set_pad(
            0,
            PadSettings {
                note: 60,
                ..PadSettings::default()
            },
        );
        sampler.set_sample(0, Some(Arc::new(sample)));
        sampler.note_on(60, 1.0);
        assert!(peak(&render(&mut sampler, 4_800).0) > 0.3);
    }
}
