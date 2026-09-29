//! The DJ Mixer's **Sampler**: four banks of sixteen **Sampler Slots**, each
//! holding a sample that one press of a pad plays into the mix, as DJ
//! software's sampler does. It is shared by every Deck: it has its own
//! channel into the Master, with a gain of its own (the Sampler Gain), a cue
//! button for the headphones and a meter.
//!
//! A slot plays its sample once through (one-shot), only while its pad is
//! held (gate), or round and round until it is stopped (loop). A sample is
//! decoded at the engine's rate off the audio thread and moved in whole, so
//! playing one only moves a read position: nothing here allocates once
//! `prepare` has sized the buffers.

use crate::engine::PreparedAudioFile;

/// Slots in one bank: one per pad.
pub const SAMPLER_BANK_SLOTS: usize = 16;
/// Banks, shared by every Deck.
pub const SAMPLER_BANKS: usize = 4;
pub const SAMPLER_SLOTS: usize = SAMPLER_BANK_SLOTS * SAMPLER_BANKS;
/// How many frames a slot fades over when it is stopped, paused or cut off
/// by being played again, so it doesn't click.
const FADE_FRAMES: u32 = 96;

/// How a slot plays.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SlotMode {
    /// Once through from the start, on each press.
    #[default]
    OneShot,
    /// From the start while the pad is held; let go, it stops.
    Gate,
    /// From the start, round and round until stopped or paused.
    Loop,
}

impl SlotMode {
    pub fn from_value(value: f64) -> Self {
        match value.round() as i64 {
            1 => Self::Gate,
            2 => Self::Loop,
            _ => Self::OneShot,
        }
    }
}

/// Where a slot is, as the report gives it: `SlotState as u8`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SlotState {
    #[default]
    Empty = 0,
    /// Loaded and still.
    Stopped = 1,
    Playing = 2,
    Paused = 3,
}

#[derive(Debug, Default)]
struct Slot {
    file: Option<PreparedAudioFile>,
    /// Where it reads, in frames of its sample.
    position: usize,
    playing: bool,
    paused: bool,
    mode: SlotMode,
    /// The slot's own level, on top of the Sampler Gain.
    gain: f32,
    /// Frames left of a fade out, and whether it then pauses (else stops).
    fade: Option<(u32, bool)>,
    /// Frames into a fade in, after a start.
    fade_in: u32,
}

impl Slot {
    fn stop(&mut self, pause: bool) {
        if self.playing && self.fade.is_none() {
            self.fade = Some((FADE_FRAMES, pause));
        }
    }
}

#[derive(Debug)]
pub struct Sampler {
    slots: [Slot; SAMPLER_SLOTS],
    /// The Sampler Gain: 1 is unity, up to 2.
    pub gain: f32,
    /// Whether the Sampler is in the headphone cue.
    pub cue: bool,
    /// The loudest sample of the last block, after the gain.
    pub peak: f32,
    out: [Vec<f32>; 2],
}

impl Sampler {
    pub fn new() -> Self {
        Self {
            slots: std::array::from_fn(|_| Slot {
                gain: 1.0,
                ..Slot::default()
            }),
            gain: 1.0,
            cue: false,
            peak: 0.0,
            out: [Vec::new(), Vec::new()],
        }
    }

    /// Size the buffers for blocks of up to `frames`. Allocates.
    pub fn prepare(&mut self, frames: usize) {
        for buffer in &mut self.out {
            if buffer.len() < frames {
                buffer.resize(frames, 0.0);
            }
        }
    }

    /// Put a sample in slot `slot`, or empty it with None, handing back the
    /// one it replaces to be dropped off the audio thread.
    pub fn load(
        &mut self,
        slot: usize,
        file: Option<PreparedAudioFile>,
    ) -> Option<PreparedAudioFile> {
        let slot = self.slots.get_mut(slot)?;
        slot.playing = false;
        slot.paused = false;
        slot.position = 0;
        slot.fade = None;
        std::mem::replace(&mut slot.file, file)
    }

    /// A pad pressed: the slot plays from its start (a paused one too).
    pub fn play(&mut self, slot: usize) {
        let Some(slot) = self.slots.get_mut(slot) else {
            return;
        };
        if slot.file.is_none() {
            return;
        }
        slot.position = 0;
        slot.playing = true;
        slot.paused = false;
        slot.fade = None;
        slot.fade_in = 0;
    }

    /// A pad let go: a gated slot stops.
    pub fn release(&mut self, slot: usize) {
        if let Some(slot) = self.slots.get_mut(slot)
            && slot.mode == SlotMode::Gate
        {
            slot.stop(false);
        }
    }

    pub fn stop(&mut self, slot: usize) {
        if let Some(slot) = self.slots.get_mut(slot) {
            slot.paused = false;
            slot.stop(false);
        }
    }

    /// Pause a playing slot where it is, or carry on with a paused one.
    pub fn pause(&mut self, slot: usize) {
        let Some(slot) = self.slots.get_mut(slot) else {
            return;
        };
        if slot.playing {
            slot.stop(true);
        } else if slot.paused && slot.file.is_some() {
            slot.paused = false;
            slot.playing = true;
            slot.fade_in = 0;
        }
    }

    /// Stop every slot.
    pub fn stop_all(&mut self) {
        for slot in &mut self.slots {
            slot.paused = false;
            slot.stop(false);
        }
    }

    pub fn set_mode(&mut self, slot: usize, mode: SlotMode) {
        if let Some(slot) = self.slots.get_mut(slot) {
            slot.mode = mode;
        }
    }

    pub fn set_slot_gain(&mut self, slot: usize, gain: f32) {
        if let Some(slot) = self.slots.get_mut(slot) {
            slot.gain = gain.clamp(0.0, 2.0);
        }
    }

    pub fn state(&self, slot: usize) -> SlotState {
        match self.slots.get(slot) {
            Some(s) if s.file.is_none() => SlotState::Empty,
            Some(s) if s.playing => SlotState::Playing,
            Some(s) if s.paused => SlotState::Paused,
            Some(_) => SlotState::Stopped,
            None => SlotState::Empty,
        }
    }

    pub fn is_active(&self) -> bool {
        self.slots.iter().any(|s| s.playing) || self.peak > 1e-4
    }

    /// Render the next `frames` of every playing slot, summed, after the
    /// Sampler Gain. Allocates nothing once `prepare` has sized it.
    pub fn render(&mut self, frames: usize) {
        self.prepare(frames);
        let [out_l, out_r] = &mut self.out;
        out_l[..frames].fill(0.0);
        out_r[..frames].fill(0.0);
        let mut peak = 0.0f32;
        for slot in &mut self.slots {
            if !slot.playing {
                continue;
            }
            let Some(file) = slot.file.as_ref() else {
                slot.playing = false;
                continue;
            };
            let (left, right) = (file.left(), file.right());
            let length = left.len().min(right.len());
            if length == 0 {
                slot.playing = false;
                continue;
            }
            let gain = slot.gain * self.gain;
            for i in 0..frames {
                if slot.position >= length {
                    if slot.mode == SlotMode::Loop {
                        slot.position = 0;
                    } else {
                        slot.playing = false;
                        slot.position = 0;
                        break;
                    }
                }
                let mut level = gain;
                if slot.fade_in < FADE_FRAMES {
                    level *= slot.fade_in as f32 / FADE_FRAMES as f32;
                    slot.fade_in += 1;
                }
                if let Some((left_frames, pause)) = slot.fade {
                    if left_frames == 0 {
                        slot.fade = None;
                        slot.playing = false;
                        slot.paused = pause;
                        if !pause {
                            slot.position = 0;
                        }
                        break;
                    }
                    level *= left_frames as f32 / FADE_FRAMES as f32;
                    slot.fade = Some((left_frames - 1, pause));
                }
                out_l[i] += left[slot.position] * level;
                out_r[i] += right[slot.position] * level;
                slot.position += 1;
            }
        }
        for s in out_l[..frames].iter().chain(out_r[..frames].iter()) {
            peak = peak.max(s.abs());
        }
        self.peak = peak;
    }

    /// The last block, left and right.
    pub fn output(&self) -> (&[f32], &[f32]) {
        (&self.out[0], &self.out[1])
    }
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_file::AudioFile;
    use crate::dsp::measure::peak;

    fn constant(value: f32, frames: usize) -> PreparedAudioFile {
        PreparedAudioFile::from_file(AudioFile::from_samples(
            vec![value; frames],
            vec![value; frames],
        ))
    }

    fn render(sampler: &mut Sampler, frames: usize) -> Vec<f32> {
        sampler.render(frames);
        sampler.output().0[..frames].to_vec()
    }

    #[test]
    fn an_empty_or_still_sampler_is_silent() {
        let mut sampler = Sampler::new();
        assert!(render(&mut sampler, 256).iter().all(|&s| s == 0.0));
        sampler.load(3, Some(constant(0.5, 1_000)));
        assert_eq!(sampler.state(3), SlotState::Stopped);
        assert!(render(&mut sampler, 256).iter().all(|&s| s == 0.0));
        sampler.play(4);
        assert_eq!(sampler.state(4), SlotState::Empty, "nothing to play");
    }

    #[test]
    fn a_one_shot_plays_once_through_at_its_gain() {
        let mut sampler = Sampler::new();
        sampler.load(0, Some(constant(0.5, 1_000)));
        sampler.gain = 0.5;
        sampler.play(0);
        let played = render(&mut sampler, 2_000);
        assert!((played[500] - 0.25).abs() < 1e-6, "{}", played[500]);
        assert!(
            played[..FADE_FRAMES as usize]
                .windows(2)
                .all(|w| w[1] >= w[0]),
            "fades in"
        );
        assert!(
            played[1_000..].iter().all(|&s| s == 0.0),
            "and stops at its end"
        );
        assert_eq!(sampler.state(0), SlotState::Stopped);
    }

    #[test]
    fn slots_play_together_and_add_up() {
        let mut sampler = Sampler::new();
        sampler.load(0, Some(constant(0.25, 4_000)));
        sampler.load(17, Some(constant(0.25, 4_000)));
        sampler.play(0);
        sampler.play(17);
        let played = render(&mut sampler, 1_000);
        assert!((played[500] - 0.5).abs() < 1e-6);
        assert!((sampler.peak - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_gated_slot_stops_when_let_go_and_a_one_shot_doesnt() {
        let mut sampler = Sampler::new();
        sampler.load(0, Some(constant(0.5, 48_000)));
        sampler.load(1, Some(constant(0.5, 48_000)));
        sampler.set_mode(0, SlotMode::Gate);
        sampler.play(0);
        sampler.play(1);
        render(&mut sampler, 480);
        sampler.release(0);
        sampler.release(1);
        render(&mut sampler, 480);
        assert_eq!(sampler.state(0), SlotState::Stopped);
        assert_eq!(sampler.state(1), SlotState::Playing);
    }

    #[test]
    fn a_looped_slot_goes_round_until_stopped() {
        let mut sampler = Sampler::new();
        sampler.load(2, Some(constant(0.5, 300)));
        sampler.set_mode(2, SlotMode::Loop);
        sampler.play(2);
        let played = render(&mut sampler, 3_000);
        assert!(peak(&played[2_500..]) > 0.49, "still going");
        sampler.stop(2);
        let played = render(&mut sampler, 3_000);
        assert!(played[FADE_FRAMES as usize + 1..].iter().all(|&s| s == 0.0));
        assert_eq!(sampler.state(2), SlotState::Stopped);
    }

    #[test]
    fn pausing_holds_the_place_and_carries_on_from_it() {
        let ramp: Vec<f32> = (0..48_000).map(|i| i as f32 / 48_000.0).collect();
        let file = PreparedAudioFile::from_file(AudioFile::from_samples(ramp.clone(), ramp));
        let mut sampler = Sampler::new();
        sampler.load(5, Some(file));
        sampler.play(5);
        render(&mut sampler, 4_800);
        sampler.pause(5);
        render(&mut sampler, 480);
        assert_eq!(sampler.state(5), SlotState::Paused);
        assert!(render(&mut sampler, 480).iter().all(|&s| s == 0.0));
        sampler.pause(5);
        let played = render(&mut sampler, 480);
        let at = played[FADE_FRAMES as usize + 10];
        assert!(
            at > 0.1,
            "carries on past where it was paused, not from the start: {at}"
        );
    }

    #[test]
    fn loading_over_a_slot_hands_back_the_old_sample_and_stops_it() {
        let mut sampler = Sampler::new();
        assert!(sampler.load(0, Some(constant(0.5, 100))).is_none());
        sampler.play(0);
        assert!(sampler.load(0, Some(constant(0.5, 100))).is_some());
        assert_eq!(sampler.state(0), SlotState::Stopped);
        assert!(sampler.load(0, None).is_some());
        assert_eq!(sampler.state(0), SlotState::Empty);
        assert!(
            sampler
                .load(SAMPLER_SLOTS, Some(constant(0.5, 100)))
                .is_none()
        );
    }
}
