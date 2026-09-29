//! The DJ Mixer's **Sampler**: four banks of sixteen **Sampler Slots**, each
//! holding a sample that one press of a pad plays into the mix, as DJ
//! software's sampler does. It is shared by every Deck: it has its own
//! channel into the Master, with a gain of its own (the Sampler Gain), a cue
//! button for the headphones and a meter.
//!
//! A slot plays its sample once through (one-shot), only while its pad is
//! held (gate), or round and round until it is stopped (loop). Its **pitch**
//! (up to an octave either way, to the cent) is played by reading the sample
//! faster or slower, so it changes the speed too, as a sampler's pitch does.
//! With **sync** on, a slot with a BPM plays at the **Sync Master**'s tempo
//! instead and keeps its pitch, by the Decks' own time-stretch (`Stretcher`),
//! as a DJ sampler's BEAT SYNC does; a synced loop goes round in whole beats
//! and starts each time round on the Master's beat. Without a Sync Master it
//! plays at its own tempo.
//!
//! A sample is decoded at the engine's rate off the audio thread and moved in
//! whole, so playing one only moves a read position: nothing here allocates
//! once `new` and `prepare` have sized it.

use super::deck::read;
use super::stretch::Stretcher;
use crate::engine::PreparedAudioFile;

/// Slots in one bank: one per pad.
pub const SAMPLER_BANK_SLOTS: usize = 16;
/// Banks, shared by every Deck.
pub const SAMPLER_BANKS: usize = 4;
pub const SAMPLER_SLOTS: usize = SAMPLER_BANK_SLOTS * SAMPLER_BANKS;
/// How far a slot's pitch goes either way, in semitones.
pub const SLOT_PITCH_RANGE: f64 = 12.0;
/// How many frames a slot fades over when it is stopped, paused or cut off
/// by being played again, so it doesn't click.
const FADE_FRAMES: u32 = 96;
/// How near the Master's beat a synced loop coming round has to be, as a
/// fraction of a beat, to be put on it. Further off, the DJ started it off
/// the beat on purpose, and it stays there.
const BEAT_SNAP: f64 = 0.25;

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

/// The tempo synced slots follow: the Sync Master's BPM as it plays now,
/// and where it is in its beats while it plays (2.25 is a quarter past its
/// third beat).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MasterTempo {
    pub bpm: f64,
    pub beat: Option<f64>,
}

#[derive(Debug)]
struct Slot {
    file: Option<PreparedAudioFile>,
    /// Where it reads, in frames of its sample.
    position: f64,
    playing: bool,
    paused: bool,
    mode: SlotMode,
    /// The slot's own level, on top of the Sampler Gain.
    gain: f32,
    /// In semitones, -12 to 12.
    pitch: f64,
    /// Whether it follows the Master's tempo.
    sync: bool,
    /// Its sample's tempo; 0 when it has none.
    bpm: f64,
    /// Frames left of a fade out, and whether it then pauses (else stops).
    fade: Option<(u32, bool)>,
    /// Frames into a fade in, after a start.
    fade_in: u32,
    stretcher: Stretcher,
}

impl Slot {
    fn new(sample_rate: f32) -> Self {
        Self {
            file: None,
            position: 0.0,
            playing: false,
            paused: false,
            mode: SlotMode::OneShot,
            gain: 1.0,
            pitch: 0.0,
            sync: false,
            bpm: 0.0,
            fade: None,
            fade_in: 0,
            stretcher: Stretcher::new(sample_rate),
        }
    }

    fn stop(&mut self, pause: bool) {
        if self.playing && self.fade.is_none() {
            self.fade = Some((FADE_FRAMES, pause));
        }
    }
}

#[derive(Debug)]
pub struct Sampler {
    sample_rate: f32,
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
    /// Allocates: each slot has its own time-stretch.
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            slots: std::array::from_fn(|_| Slot::new(sample_rate)),
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
    /// one it replaces to be dropped off the audio thread. How the slot
    /// plays (its mode, level, pitch, sync and BPM) stays as it was set.
    pub fn load(
        &mut self,
        slot: usize,
        file: Option<PreparedAudioFile>,
    ) -> Option<PreparedAudioFile> {
        let slot = self.slots.get_mut(slot)?;
        slot.playing = false;
        slot.paused = false;
        slot.position = 0.0;
        slot.fade = None;
        slot.stretcher.reset();
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
        slot.position = 0.0;
        slot.playing = true;
        slot.paused = false;
        slot.fade = None;
        slot.fade_in = 0;
        slot.stretcher.reset();
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
            slot.stretcher.reset();
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

    /// The slot's pitch in semitones (a fraction is cents), up to an
    /// octave either way.
    pub fn set_pitch(&mut self, slot: usize, semitones: f64) {
        if let Some(slot) = self.slots.get_mut(slot)
            && semitones.is_finite()
        {
            slot.pitch = semitones.clamp(-SLOT_PITCH_RANGE, SLOT_PITCH_RANGE);
        }
    }

    /// Whether the slot follows the Master's tempo.
    pub fn set_sync(&mut self, slot: usize, on: bool) {
        if let Some(slot) = self.slots.get_mut(slot)
            && slot.sync != on
        {
            slot.sync = on;
            slot.stretcher.reset();
        }
    }

    /// The slot's sample's tempo; 0 (or anything not above it) for none, so
    /// it doesn't sync.
    pub fn set_bpm(&mut self, slot: usize, bpm: f64) {
        if let Some(slot) = self.slots.get_mut(slot) {
            slot.bpm = if bpm.is_finite() && bpm > 0.0 {
                bpm
            } else {
                0.0
            };
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
    /// Sampler Gain, with synced slots following `master` (at the start of
    /// the block). Allocates nothing once `prepare` has sized it.
    pub fn render(&mut self, frames: usize, master: Option<MasterTempo>) {
        self.prepare(frames);
        let rate = f64::from(self.sample_rate);
        let [out_l, out_r] = &mut self.out;
        out_l[..frames].fill(0.0);
        out_r[..frames].fill(0.0);
        let master = master.filter(|m| m.bpm.is_finite() && m.bpm > 0.0);
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
            let pitch = 2f64.powf(slot.pitch / 12.0);
            let synced = master.filter(|_| slot.sync && slot.bpm > 0.0);
            // Synced, it moves at the Master's tempo and is heard at its
            // pitch; else it is read faster or slower, and the pitch follows.
            let speed = synced.map_or(pitch, |m| m.bpm / slot.bpm);
            let stretched = synced.is_some() && (speed - pitch).abs() > 1e-9;
            let beat_frames = if slot.bpm > 0.0 {
                60.0 / slot.bpm * rate
            } else {
                0.0
            };
            // A synced loop goes round in whole beats.
            let end = match synced {
                Some(_) if slot.mode == SlotMode::Loop => {
                    let beats = (length as f64 / beat_frames).round();
                    if beats >= 1.0 {
                        beats * beat_frames
                    } else {
                        length as f64
                    }
                }
                _ => length as f64,
            };
            let mut master_beat = synced.and_then(|m| m.beat);
            let master_step = synced.map_or(0.0, |m| m.bpm / 60.0 / rate);
            for i in 0..frames {
                if slot.position >= end {
                    if slot.mode == SlotMode::Loop {
                        slot.position -= end;
                        // Round again on the Master's beat, when it is near it.
                        if let Some(beat) = master_beat {
                            let phase = beat.rem_euclid(1.0);
                            if phase < BEAT_SNAP {
                                slot.position = phase * beat_frames;
                            } else if phase > 1.0 - BEAT_SNAP {
                                slot.position = (phase - 1.0) * beat_frames;
                            }
                        }
                    } else {
                        slot.playing = false;
                        slot.position = 0.0;
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
                            slot.position = 0.0;
                        }
                        break;
                    }
                    level *= left_frames as f32 / FADE_FRAMES as f32;
                    slot.fade = Some((left_frames - 1, pause));
                }
                let (l, r) = if stretched {
                    slot.stretcher.next(left, right, slot.position, 1.0, pitch)
                } else {
                    (read(left, slot.position), read(right, slot.position))
                };
                out_l[i] += l * level;
                out_r[i] += r * level;
                slot.position += speed;
                if let Some(beat) = master_beat.as_mut() {
                    *beat += master_step;
                }
            }
        }
        let peak = out_l[..frames]
            .iter()
            .chain(out_r[..frames].iter())
            .fold(0.0f32, |m, s| m.max(s.abs()));
        self.peak = peak;
    }

    /// The last block, left and right.
    pub fn output(&self) -> (&[f32], &[f32]) {
        (&self.out[0], &self.out[1])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_file::AudioFile;
    use crate::dsp::measure::{peak, rising_zero_crossings, sine};
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    const RATE: f32 = 48_000.0;

    // Counts this thread's allocations, so a test can show that playing
    // allocates nothing.
    struct Counting;
    thread_local! {
        static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    }
    // SAFETY: every call is passed straight on to the system allocator.
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
            // SAFETY: the caller's contract is the system allocator's.
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            // SAFETY: the caller's contract is the system allocator's.
            unsafe { System.dealloc(ptr, layout) }
        }
    }
    #[global_allocator]
    static GLOBAL: Counting = Counting;
    fn allocations() -> usize {
        ALLOCATIONS.with(Cell::get)
    }

    fn constant(value: f32, frames: usize) -> PreparedAudioFile {
        PreparedAudioFile::from_file(AudioFile::from_samples(
            vec![value; frames],
            vec![value; frames],
        ))
    }

    fn render(sampler: &mut Sampler, frames: usize) -> Vec<f32> {
        sampler.render(frames, None);
        sampler.output().0[..frames].to_vec()
    }

    #[test]
    fn an_empty_or_still_sampler_is_silent() {
        let mut sampler = Sampler::new(RATE);
        assert!(render(&mut sampler, 256).iter().all(|&s| s == 0.0));
        sampler.load(3, Some(constant(0.5, 1_000)));
        assert_eq!(sampler.state(3), SlotState::Stopped);
        assert!(render(&mut sampler, 256).iter().all(|&s| s == 0.0));
        sampler.play(4);
        assert_eq!(sampler.state(4), SlotState::Empty, "nothing to play");
    }

    #[test]
    fn a_one_shot_plays_once_through_at_its_gain() {
        let mut sampler = Sampler::new(RATE);
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
        let mut sampler = Sampler::new(RATE);
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
        let mut sampler = Sampler::new(RATE);
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
        let mut sampler = Sampler::new(RATE);
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
        let mut sampler = Sampler::new(RATE);
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
        let mut sampler = Sampler::new(RATE);
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

    fn tone(frequency: f32, seconds: f32) -> PreparedAudioFile {
        let tone = sine(frequency, 0.5, RATE, (seconds * RATE) as usize);
        PreparedAudioFile::from_file(AudioFile::from_samples(tone.clone(), tone))
    }

    fn master(bpm: f64) -> Option<MasterTempo> {
        Some(MasterTempo { bpm, beat: None })
    }

    /// Play slot 0 until it stops, following `master`: what it played.
    fn play_through(sampler: &mut Sampler, master: Option<MasterTempo>) -> Vec<f32> {
        sampler.play(0);
        let mut out = Vec::new();
        while sampler.state(0) == SlotState::Playing && out.len() < 10 * RATE as usize {
            sampler.render(480, master);
            out.extend_from_slice(&sampler.output().0[..480]);
        }
        let end = out.iter().rposition(|&s| s != 0.0).map_or(0, |at| at + 1);
        out.truncate(end);
        out
    }

    #[test]
    fn a_slot_pitched_up_an_octave_plays_an_octave_up_and_twice_as_fast() {
        let mut sampler = Sampler::new(RATE);
        sampler.load(0, Some(tone(500.0, 2.0)));
        sampler.set_pitch(0, 12.0);
        let played = play_through(&mut sampler, None);
        let seconds = played.len() as f32 / RATE;
        assert!((seconds - 1.0).abs() < 0.01, "lasts {seconds} s");
        let hertz = rising_zero_crossings(&played[4_800..4_800 + 24_000]) * 2;
        assert!((hertz as f32 - 1_000.0).abs() <= 4.0, "{hertz} Hz");

        sampler.set_pitch(0, -12.0);
        let played = play_through(&mut sampler, None);
        assert!((played.len() as f32 / RATE - 4.0).abs() < 0.01);
        let hertz = rising_zero_crossings(&played[4_800..4_800 + 48_000]);
        assert!((hertz as f32 - 250.0).abs() <= 2.0, "{hertz} Hz");

        sampler.set_pitch(0, 40.0);
        let played = play_through(&mut sampler, None);
        assert!(
            (played.len() as f32 / RATE - 1.0).abs() < 0.01,
            "an octave at most"
        );
    }

    #[test]
    fn a_synced_slot_plays_at_the_masters_tempo_and_keeps_its_pitch() {
        let mut sampler = Sampler::new(RATE);
        sampler.load(0, Some(tone(1_000.0, 2.0)));
        sampler.set_bpm(0, 120.0);
        sampler.set_sync(0, true);
        let played = play_through(&mut sampler, master(128.0));
        let seconds = played.len() as f64 / f64::from(RATE);
        let expected = 2.0 * 120.0 / 128.0;
        assert!(
            (seconds - expected).abs() < 0.02,
            "{seconds} s, not {expected}"
        );
        let hertz = rising_zero_crossings(&played[4_800..4_800 + 48_000]);
        assert!((hertz as f32 - 1_000.0).abs() <= 5.0, "{hertz} Hz");

        // With a pitch of its own too: at the tempo, a fifth up.
        sampler.set_pitch(0, 7.0);
        let played = play_through(&mut sampler, master(128.0));
        let seconds = played.len() as f64 / f64::from(RATE);
        assert!((seconds - expected).abs() < 0.02, "{seconds} s");
        let fifth = 1_000.0 * 2f32.powf(7.0 / 12.0);
        let hertz = rising_zero_crossings(&played[4_800..4_800 + 48_000]) as f32;
        assert!((hertz - fifth).abs() <= 30.0, "{hertz} Hz, not {fifth}");
    }

    #[test]
    fn without_sync_or_a_master_or_a_bpm_a_slot_plays_at_its_own_tempo() {
        let mut sampler = Sampler::new(RATE);
        sampler.load(0, Some(tone(1_000.0, 1.0)));
        sampler.set_bpm(0, 120.0);
        let own = |sampler: &mut Sampler, master| play_through(sampler, master).len();
        assert_eq!(own(&mut sampler, master(128.0)), RATE as usize, "sync off");
        sampler.set_sync(0, true);
        assert_eq!(own(&mut sampler, None), RATE as usize, "no Master");
        sampler.set_bpm(0, 0.0);
        assert_eq!(own(&mut sampler, master(128.0)), RATE as usize, "no BPM");
    }

    #[test]
    fn a_synced_loop_goes_round_in_whole_beats_on_the_masters_beat() {
        let mut sampler = Sampler::new(RATE);
        // A little over a beat at 120: it goes round after exactly one.
        let beat = RATE as usize / 2;
        sampler.load(0, Some(constant(0.5, beat + 2_000)));
        sampler.set_bpm(0, 120.0);
        sampler.set_sync(0, true);
        sampler.set_mode(0, SlotMode::Loop);
        sampler.play(0);
        // The Master is a tenth of a beat past its beat as the loop comes round.
        let tempo = MasterTempo {
            bpm: 120.0,
            beat: Some(0.1),
        };
        sampler.render(beat, Some(tempo));
        assert_eq!(sampler.slots[0].position, beat as f64);
        sampler.render(1, Some(tempo));
        let expected = 0.1 * beat as f64 + 1.0;
        assert!(
            (sampler.slots[0].position - expected).abs() < 1e-6,
            "round again a tenth of a beat in, with the Master: {}",
            sampler.slots[0].position
        );
    }

    #[test]
    fn playing_pitched_and_synced_slots_allocates_nothing() {
        let mut sampler = Sampler::new(RATE);
        sampler.load(0, Some(tone(440.0, 1.0)));
        sampler.load(1, Some(tone(440.0, 1.0)));
        sampler.set_pitch(1, -3.5);
        sampler.set_bpm(1, 120.0);
        sampler.set_sync(1, true);
        sampler.set_mode(1, SlotMode::Loop);
        sampler.set_pitch(0, 5.0);
        sampler.prepare(512);
        let tempo = Some(MasterTempo {
            bpm: 126.0,
            beat: Some(3.9),
        });
        let before = allocations();
        sampler.play(0);
        sampler.play(1);
        for _ in 0..200 {
            sampler.render(512, tempo);
        }
        sampler.pause(1);
        sampler.stop_all();
        sampler.render(512, tempo);
        assert_eq!(allocations(), before);
    }
}
