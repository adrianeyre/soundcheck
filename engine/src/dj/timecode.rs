//! Timecode vinyl, for a **DVS**: a control record whose groove carries a
//! stereo pilot tone in quadrature, left and right a quarter of a cycle
//! apart, so which way the pair turns says which way the record turns and
//! how fast it turns says how fast. Each cycle of the tone is also loud or
//! quiet, one bit of a long pseudo-random sequence, so a window of the last
//! bits read says where on the record the needle is.
//!
//! `TimecodeDecoder` reads a Deck's stereo input one sample at a time and
//! gives, for each, a `VinylFrame`: whether there is a signal at all (a
//! lifted needle, or a stopped platter, gives none), the record's speed
//! (1.0 is its nominal 33⅓ rpm, negative is backwards) and, once enough bits
//! have agreed, its position. It works sample by sample, so it gives the
//! same frames whatever blocks the host renders in, and it allocates
//! nothing: the table that turns a window of bits into a position is built
//! off the audio thread (`PositionTable::build`) and moved in whole.
//!
//! **The speed** comes from the pair's phase. Each sample the angle of
//! (primary, secondary) is taken, unwrapped into a running count of cycles,
//! and its advance averaged over `SPEED_SECONDS` (a few milliseconds, so a
//! scratch is followed) is the tone's frequency; over the carrier's, the
//! speed. **The signal** is there while the input is loud enough and its
//! phase advances steadily: noise, whose phase jumps at random, has none.
//!
//! **The position** is read once per cycle, as the phase passes the point
//! where the primary channel peaks: a peak louder than the running average
//! of peaks is a 1. The bits are kept in a register of the sequence's
//! length in the order they lie on the record, whichever way it turns, and
//! each new one is checked against the next (or, backwards, the previous)
//! step of the sequence's linear feedback shift register. After
//! `VALID_BITS` agree in a row, the register is looked up, and from then on
//! the position is the count of cycles since, which the phase gives to a
//! fraction of a cycle; between readings, and through a scratch that
//! reverses too often to read, it carries on from the phase alone.
//!
//! The formats' facts (carrier, register length, seed, taps, length, which
//! channel leads and which peak carries the bits) are as the open-source
//! xwax project documents them (<https://github.com/xwax/xwax>,
//! `timecoder.c`, © Mark Hills, GPL-2.0). This is an independent
//! implementation of the formats from those facts, not a copy of its code.

use std::f64::consts::TAU;
use std::sync::Arc;

/// How long the speed is averaged over: short enough that a scratch feels
/// direct, long enough to smooth a worn groove's wobble.
const SPEED_SECONDS: f64 = 0.002;
/// How long the phase's steadiness is averaged over, for whether there is
/// a signal.
const PRESENCE_SECONDS: f64 = 0.01;
/// How long the level is averaged over. The pair's level is steady through
/// each cycle, so this can be short, and a lifted needle is heard at once.
const LEVEL_SECONDS: f64 = 0.001;
/// The time constant of the filter that takes out a DC offset or rumble.
const DC_SECONDS: f64 = 0.02;
/// Levels, as a peak of the pair, above which a signal is heard, and below
/// which it is lost again: about -48 dBFS and -54 dBFS, below a line-level
/// record's lead-in but well above an idle input's noise.
const LEVEL_ON: f64 = 0.004;
const LEVEL_OFF: f64 = 0.002;
/// How steadily the phase must advance: 1 is a pure tone, 0 noise.
const COHERENCE_ON: f64 = 0.7;
const COHERENCE_OFF: f64 = 0.5;
/// Bits that must agree with the sequence in a row before a position is
/// trusted. Fewer, and a scratch can land the Deck somewhere wrong.
pub const VALID_BITS: u32 = 24;
/// Cycles the bit threshold averages its peaks over.
const REFERENCE_CYCLES: f64 = 32.0;
/// How long a carrier must hold steady before Auto settles on it, and how
/// long the signal must be gone before Auto listens again.
const AUTO_LOCK_SECONDS: f64 = 0.3;
const AUTO_RELEASE_SECONDS: f64 = 2.0;
/// The carriers Auto chooses between, and how far off one a tone may be.
const AUTO_CARRIERS: [f64; 3] = [1_000.0, 1_300.0, 2_000.0];
const AUTO_RANGE: f64 = 0.12;

/// One kind of timecode record. Carriers are in Hz at 33⅓ rpm; positions
/// are counted in cycles of the carrier from the start of the sequence.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimecodeFormat {
    /// How the host names it.
    pub id: &'static str,
    pub label: &'static str,
    pub carrier: f64,
    /// The shift register's length, in bits.
    pub bits: u32,
    /// The register at the start of the sequence.
    pub seed: u32,
    /// The register's feedback taps.
    pub taps: u32,
    /// Cycles in the sequence, and the last one it is safe to trust (the
    /// rest is the run-out).
    pub length: u32,
    pub safe: u32,
    /// The bits are read on the left channel, not the right.
    pub primary_left: bool,
    /// The secondary lags the primary by three quarters of a cycle, not one.
    pub reversed_phase: bool,
    /// The bits are read at the primary's negative peak, not its positive.
    pub read_negative: bool,
}

const fn format(
    id: &'static str,
    label: &'static str,
    carrier: f64,
    (bits, seed, taps): (u32, u32, u32),
    (length, safe): (u32, u32),
    (primary_left, reversed_phase, read_negative): (bool, bool, bool),
) -> TimecodeFormat {
    TimecodeFormat {
        id,
        label,
        carrier,
        bits,
        seed,
        taps,
        length,
        safe,
        primary_left,
        reversed_phase,
        read_negative,
    }
}

/// The records a Deck can read, by choice: 0 is Auto (the carrier found by
/// listening, for REL only), then these from 1.
pub const TIMECODE_FORMATS: [TimecodeFormat; 9] = [
    format(
        "serato2a",
        "Serato CV02, side A",
        1_000.0,
        (20, 0x59017, 0x361e4),
        (712_000, 707_000),
        (false, false, false),
    ),
    format(
        "serato2b",
        "Serato CV02, side B",
        1_000.0,
        (20, 0x8f3c6, 0x4f0d8),
        (922_000, 917_000),
        (false, false, false),
    ),
    format(
        "seratoCd",
        "Serato control CD",
        1_000.0,
        (20, 0xd8b40, 0x34d54),
        (950_000, 940_000),
        (false, false, false),
    ),
    format(
        "traktorA",
        "Traktor Scratch, side A",
        2_000.0,
        (23, 0x134503, 0x041040),
        (1_500_000, 1_480_000),
        (true, true, true),
    ),
    format(
        "traktorB",
        "Traktor Scratch, side B",
        2_000.0,
        (23, 0x32066c, 0x041040),
        (2_110_000, 2_090_000),
        (true, true, true),
    ),
    format(
        "mixvibesV2",
        "MixVibes V2",
        1_300.0,
        (20, 0x22c90, 0x00008),
        (950_000, 923_000),
        (false, true, false),
    ),
    format(
        "mixvibes7",
        "MixVibes 7\"",
        1_300.0,
        (20, 0x22c90, 0x00008),
        (312_000, 310_000),
        (false, true, false),
    ),
    format(
        "rekordboxA",
        "rekordbox Control Vinyl, side A",
        1_000.0,
        (20, 0x78370, 0x7933a),
        (635_000, 614_000),
        (false, false, true),
    ),
    format(
        "rekordboxB",
        "rekordbox Control Vinyl, side B",
        1_000.0,
        (20, 0xf7012, 0x2ef1c),
        (918_500, 913_000),
        (false, false, true),
    ),
];

/// The format a choice names: None for Auto (0) or one there isn't.
pub fn timecode_format(choice: usize) -> Option<&'static TimecodeFormat> {
    choice.checked_sub(1).and_then(|i| TIMECODE_FORMATS.get(i))
}

fn parity(x: u32) -> u32 {
    x.count_ones() & 1
}

/// The register one cycle further on: the oldest bit (the lowest) drops
/// out and the next, the parity of the tapped bits and the oldest, comes
/// in at the top.
pub fn step_forward(state: u32, format: &TimecodeFormat) -> u32 {
    let next = parity(state & (format.taps | 1));
    (state >> 1) | (next << (format.bits - 1))
}

/// The register one cycle back: the newest bit drops out of the top and the
/// one before the oldest comes back in at the bottom. Since the newest bit
/// was the parity of the taps and the oldest, the oldest is the parity of
/// the newest and the taps, each a place lower now.
pub fn step_back(state: u32, format: &TimecodeFormat) -> u32 {
    let mask = (1u32 << format.bits) - 1;
    let old = parity(state & ((format.taps >> 1) | (1 << (format.bits - 1))));
    ((state << 1) & mask) | old
}

/// Every register a format's sequence passes through, and where: built off
/// the audio thread when a format is chosen, then only looked up.
#[derive(Debug)]
pub struct PositionTable {
    choice: usize,
    /// The register in the high 32 bits and its cycle in the low, sorted.
    entries: Box<[u64]>,
}

impl PositionTable {
    /// The table for a format by its choice; None for Auto. Allocates
    /// eight bytes a cycle (17 MB for the longest) and sorts them.
    pub fn build(choice: usize) -> Option<Self> {
        let format = timecode_format(choice)?;
        let mut entries = Vec::with_capacity(format.length as usize);
        let mut state = format.seed;
        for cycle in 0..format.length {
            entries.push((u64::from(state) << 32) | u64::from(cycle));
            state = step_forward(state, format);
        }
        entries.sort_unstable();
        Some(Self {
            choice,
            entries: entries.into_boxed_slice(),
        })
    }

    pub fn choice(&self) -> usize {
        self.choice
    }

    /// The cycle whose register, from it on, is `state`.
    pub fn lookup(&self, state: u32) -> Option<u32> {
        self.entries
            .binary_search_by(|entry| ((entry >> 32) as u32).cmp(&state))
            .ok()
            .map(|index| self.entries[index] as u32)
    }

    /// Whether no register comes up twice, so every lookup is one place.
    pub fn is_unique(&self) -> bool {
        self.entries
            .windows(2)
            .all(|w| (w[0] >> 32) != (w[1] >> 32))
    }
}

/// What the record is doing at one sample.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VinylFrame {
    /// There is a timecode signal: a needle on a turning record.
    pub present: bool,
    /// 1.0 is the record's nominal speed; negative is backwards.
    pub speed: f64,
    /// Seconds into the record at its nominal speed, NaN until known.
    pub position: f64,
    /// Past the part of the record whose position can be trusted.
    pub off_range: bool,
}

impl Default for VinylFrame {
    fn default() -> Self {
        Self {
            present: false,
            speed: 0.0,
            position: f64::NAN,
            off_range: false,
        }
    }
}

/// The record's channel layout, as a format has it or Auto guesses it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Layout {
    primary_left: bool,
    reversed_phase: bool,
    read_negative: bool,
}

/// Reads a timecode record's speed and position from a stereo input.
#[derive(Debug)]
pub struct TimecodeDecoder {
    rate: f64,
    /// 0 Auto, or one of `TIMECODE_FORMATS` from 1.
    choice: usize,
    /// The input's left and right are the other way round.
    pub swap: bool,
    /// The input's right channel is upside down.
    pub invert: bool,
    table: Option<Arc<PositionTable>>,
    dc: [f64; 2],
    dc_alpha: f64,
    speed_alpha: f64,
    presence_alpha: f64,
    level_alpha: f64,
    /// The pair's angle last sample, in cycles, and its unwrapped count.
    angle: f64,
    phase: f64,
    started: bool,
    /// The last sample's pair, for the phase's steadiness.
    previous: (f64, f64),
    /// Cycles the phase advances a sample, averaged.
    advance: f64,
    /// The average of each sample's advance as a unit phasor: its length is
    /// how steady the phase is.
    coherence: (f64, f64),
    level: f64,
    present: bool,
    /// The carrier the speed is measured against, in Hz.
    carrier: f64,
    /// Auto: whether it has settled on a carrier, how long the tone has
    /// held steady, how long the signal has been gone, and the tone's
    /// slow average.
    locked: bool,
    steady: f64,
    absent: f64,
    slow: f64,
    /// The cycle the phase was in last sample, for when it passes the
    /// point where a bit is read.
    cycle: i64,
    forwards: bool,
    /// The bits last read, oldest on the record lowest.
    register: u32,
    /// Bits in a row that agreed with the sequence.
    valid: u32,
    /// The running average of peaks, which a 1 is louder than.
    reference: f64,
    /// Cycles of the record at phase 0, once a position has been read.
    offset: Option<f64>,
    off_range: bool,
}

impl TimecodeDecoder {
    pub fn new(sample_rate: f32) -> Self {
        let rate = f64::from(sample_rate);
        let alpha = |seconds: f64| 1.0 - (-1.0 / (seconds * rate)).exp();
        Self {
            rate,
            choice: 0,
            swap: false,
            invert: false,
            table: None,
            dc: [0.0; 2],
            dc_alpha: alpha(DC_SECONDS),
            speed_alpha: alpha(SPEED_SECONDS),
            presence_alpha: alpha(PRESENCE_SECONDS),
            level_alpha: alpha(LEVEL_SECONDS),
            angle: 0.0,
            phase: 0.0,
            started: false,
            previous: (0.0, 0.0),
            advance: 0.0,
            coherence: (0.0, 0.0),
            level: 0.0,
            present: false,
            carrier: AUTO_CARRIERS[0],
            locked: false,
            steady: 0.0,
            absent: 0.0,
            slow: 0.0,
            cycle: 0,
            forwards: true,
            register: 0,
            valid: 0,
            reference: 0.0,
            offset: None,
            off_range: false,
        }
    }

    /// Read `choice`: 0 Auto, or one of `TIMECODE_FORMATS` from 1. A choice
    /// there isn't is Auto.
    pub fn set_format(&mut self, choice: usize) {
        let choice = if timecode_format(choice).is_some() {
            choice
        } else {
            0
        };
        if choice != self.choice {
            self.choice = choice;
            self.locked = false;
            self.carrier = timecode_format(choice).map_or(AUTO_CARRIERS[0], |f| f.carrier);
            self.started = false;
            self.lose_position();
        }
    }

    pub fn format(&self) -> usize {
        self.choice
    }

    /// Give it the position table for its format, handing back the one it
    /// had to be dropped off the audio thread.
    pub fn set_table(&mut self, table: Option<Arc<PositionTable>>) -> Option<Arc<PositionTable>> {
        self.lose_position();
        std::mem::replace(&mut self.table, table)
    }

    /// Whether it can read positions: a format is chosen and its table is in.
    pub fn reads_position(&self) -> bool {
        self.choice != 0 && self.table.as_ref().is_some_and(|t| t.choice == self.choice)
    }

    /// The carrier it measures speed against, in Hz: its format's, or the
    /// one Auto found.
    pub fn carrier(&self) -> f64 {
        self.carrier
    }

    pub fn is_present(&self) -> bool {
        self.present
    }

    /// Forget where the record is, and start the bits again.
    fn lose_position(&mut self) {
        self.valid = 0;
        self.offset = None;
        self.off_range = false;
        self.reference = 0.0;
    }

    fn layout(&self) -> Layout {
        match timecode_format(self.choice) {
            Some(f) => Layout {
                primary_left: f.primary_left,
                reversed_phase: f.reversed_phase,
                read_negative: f.read_negative,
            },
            // Auto measures every record as Serato's is laid out; Traktor's
            // turns the same way, and MixVibes' the other (see `speed`).
            None => Layout {
                primary_left: false,
                reversed_phase: false,
                read_negative: false,
            },
        }
    }

    /// Read the next sample of the input. Allocates nothing.
    pub fn process(&mut self, left: f32, right: f32) -> VinylFrame {
        let (left, right) = if self.swap {
            (right, left)
        } else {
            (left, right)
        };
        let right = if self.invert { -right } else { right };
        let (left, right) = (f64::from(left), f64::from(right));
        self.dc[0] += (left - self.dc[0]) * self.dc_alpha;
        self.dc[1] += (right - self.dc[1]) * self.dc_alpha;
        let (left, right) = (left - self.dc[0], right - self.dc[1]);

        let layout = self.layout();
        let (primary, secondary) = if layout.primary_left {
            (left, right)
        } else {
            (right, left)
        };
        let secondary = if layout.reversed_phase {
            -secondary
        } else {
            secondary
        };

        let magnitude = primary.hypot(secondary);
        self.level += (magnitude - self.level) * self.level_alpha;
        let delta = if magnitude > 1e-9 {
            let angle = secondary.atan2(primary) / TAU;
            let delta = if self.started {
                (angle - self.angle + 0.5).rem_euclid(1.0) - 0.5
            } else {
                self.phase = angle;
                self.started = true;
                0.0
            };
            self.angle = angle;
            delta
        } else {
            0.0
        };
        self.phase += delta;
        self.advance += (delta - self.advance) * self.speed_alpha;

        // How steady the phase is: the average of each advance as a unit
        // phasor, taken from this pair and the last without a trig call.
        let (pp, ps) = self.previous;
        let (re, im) = (primary * pp + secondary * ps, secondary * pp - primary * ps);
        let length = re.hypot(im);
        let (ur, ui) = if length > 1e-12 {
            (re / length, im / length)
        } else {
            (0.0, 0.0)
        };
        self.previous = (primary, secondary);
        self.coherence.0 += (ur - self.coherence.0) * self.presence_alpha;
        self.coherence.1 += (ui - self.coherence.1) * self.presence_alpha;
        let coherence = self.coherence.0.hypot(self.coherence.1);

        if self.present {
            if self.level < LEVEL_OFF || coherence < COHERENCE_OFF {
                self.present = false;
                self.lose_position();
            }
        } else if self.level > LEVEL_ON && coherence > COHERENCE_ON {
            self.present = true;
        }

        let frequency = self.advance * self.rate;
        self.follow_carrier(frequency);

        let read_at = if layout.read_negative { 0.5 } else { 0.0 };
        let point = self.phase - read_at;
        let cycle = point.floor() as i64;
        if self.present && self.reads_position() && (cycle - self.cycle).abs() == 1 {
            // The phase moves less than half a cycle a sample, so it has
            // passed exactly one reading point: the higher of the two.
            let forwards = cycle > self.cycle;
            self.read_bit(primary.abs(), forwards, cycle.max(self.cycle));
        }
        self.cycle = cycle;

        if !self.present {
            return VinylFrame::default();
        }
        let sign = if self.choice == 0 && self.carrier == AUTO_CARRIERS[1] {
            -1.0
        } else {
            1.0
        };
        let position = match (self.offset, timecode_format(self.choice)) {
            (Some(offset), Some(format)) if !self.off_range => (point + offset) / format.carrier,
            _ => f64::NAN,
        };
        VinylFrame {
            present: true,
            speed: sign * frequency / self.carrier,
            position,
            off_range: self.off_range,
        }
    }

    /// Auto: find the carrier from the tone, and hold it once it is steady.
    fn follow_carrier(&mut self, frequency: f64) {
        if self.choice != 0 {
            return;
        }
        let dt = 1.0 / self.rate;
        if !self.present {
            self.absent += dt;
            self.steady = 0.0;
            if self.absent > AUTO_RELEASE_SECONDS {
                self.locked = false;
            }
            return;
        }
        self.absent = 0.0;
        if self.locked {
            return;
        }
        let tone = frequency.abs();
        self.slow += (tone - self.slow) * self.presence_alpha;
        let nearest = AUTO_CARRIERS
            .into_iter()
            .find(|&carrier| (tone / carrier).ln().abs() < AUTO_RANGE);
        if let Some(carrier) = nearest {
            self.carrier = carrier;
            if (tone / self.slow - 1.0).abs() < 0.03 {
                self.steady += dt;
                self.locked = self.steady > AUTO_LOCK_SECONDS;
                return;
            }
        }
        self.steady = 0.0;
    }

    /// One cycle's bit, read as the phase passed its reading point
    /// `crossing` going `forwards` (or back), from the primary's peak `peak`.
    fn read_bit(&mut self, peak: f64, forwards: bool, crossing: i64) {
        let Some(format) = timecode_format(self.choice) else {
            return;
        };
        if forwards != self.forwards {
            // Turning the other way, the register fills from its other end:
            // start counting again.
            self.forwards = forwards;
            self.valid = 0;
        }
        if self.reference <= 0.0 {
            self.reference = peak * 0.9;
        }
        let bit = u32::from(peak > self.reference);
        self.reference += (peak - self.reference) / REFERENCE_CYCLES;

        let expected;
        if forwards {
            expected = step_forward(self.register, format);
            self.register = (self.register >> 1) | (bit << (format.bits - 1));
        } else {
            expected = step_back(self.register, format);
            let mask = (1u32 << format.bits) - 1;
            self.register = ((self.register << 1) & mask) | bit;
        }
        if self.register == expected {
            self.valid = self.valid.saturating_add(1);
        } else {
            self.valid = 0;
        }
        if self.valid < VALID_BITS {
            return;
        }
        let Some(first) = self.table.as_ref().and_then(|t| t.lookup(self.register)) else {
            return;
        };
        // The register holds the bits from `first` on; the needle is at its
        // newest end going forwards, its oldest going back.
        let needle = if forwards {
            first + format.bits - 1
        } else {
            first
        };
        if needle > format.safe {
            self.off_range = true;
            self.offset = None;
        } else {
            self.off_range = false;
            self.offset = Some(f64::from(needle) - crossing as f64);
        }
    }
}

/// A timecode record played at any speed from any place, for tests and for
/// checking an input by ear: the tone, its quadrature and its bits, laid
/// out as `format` has them.
#[derive(Debug)]
pub struct TimecodeGenerator {
    format: TimecodeFormat,
    rate: f64,
    /// Where the needle is, in cycles: a whole number is a reading point.
    cycles: f64,
    /// The cycle whose bit is sounding, and the register from it on.
    bit_cycle: i64,
    state: u32,
    /// The level of a 1, and of a 0 as a share of it.
    pub level: f32,
    pub zero_level: f32,
}

impl TimecodeGenerator {
    /// A record of `format` with the needle `seconds` into it.
    pub fn new(format: TimecodeFormat, sample_rate: f32, seconds: f64) -> Self {
        let mut generator = Self {
            format,
            rate: f64::from(sample_rate),
            cycles: 0.0,
            bit_cycle: 0,
            state: format.seed,
            level: 0.5,
            zero_level: 0.7,
        };
        generator.drop_needle(seconds);
        generator
    }

    /// Put the needle `seconds` into the record. Steps the register there,
    /// so a long way in takes a moment.
    pub fn drop_needle(&mut self, seconds: f64) {
        self.cycles = (seconds * self.format.carrier).max(0.0);
        self.bit_cycle = 0;
        self.state = self.format.seed;
        self.follow_bit();
    }

    /// Where the needle is, in seconds at the record's nominal speed.
    pub fn seconds(&self) -> f64 {
        self.cycles / self.format.carrier
    }

    fn follow_bit(&mut self) {
        // A cycle's bit sounds from a quarter of a cycle before its reading
        // point, where the primary crosses zero, to three quarters after.
        let target = (self.cycles + 0.25).floor() as i64;
        while self.bit_cycle < target {
            self.state = step_forward(self.state, &self.format);
            self.bit_cycle += 1;
        }
        while self.bit_cycle > target && self.bit_cycle > 0 {
            self.state = step_back(self.state, &self.format);
            self.bit_cycle -= 1;
        }
    }

    /// The next sample, left and right, with the record at `speed`.
    pub fn next(&mut self, speed: f64) -> (f32, f32) {
        self.cycles = (self.cycles + speed * self.format.carrier / self.rate).max(0.0);
        self.follow_bit();
        let one = self.state & 1 == 1;
        let level = f64::from(self.level * if one { 1.0 } else { self.zero_level });
        let read_at = if self.format.read_negative { 0.5 } else { 0.0 };
        let angle = TAU * (self.cycles + read_at);
        let primary = level * angle.cos();
        let secondary = level * angle.sin();
        let secondary = if self.format.reversed_phase {
            -secondary
        } else {
            secondary
        };
        let (left, right) = if self.format.primary_left {
            (primary, secondary)
        } else {
            (secondary, primary)
        };
        (left as f32, right as f32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;
    const SERATO_A: usize = 1;
    const TRAKTOR_A: usize = 4;
    const MIXVIBES: usize = 6;

    fn fmt(choice: usize) -> TimecodeFormat {
        *timecode_format(choice).unwrap()
    }

    /// Decode `seconds` of `generator` at `speed(t)`, handing each frame
    /// and the true speed to `each`.
    fn run(
        decoder: &mut TimecodeDecoder,
        generator: &mut TimecodeGenerator,
        seconds: f64,
        speed: impl Fn(f64) -> f64,
        mut each: impl FnMut(f64, VinylFrame, f64),
    ) -> VinylFrame {
        let frames = (seconds * f64::from(RATE)) as usize;
        let mut last = VinylFrame::default();
        for i in 0..frames {
            let t = i as f64 / f64::from(RATE);
            let (l, r) = generator.next(speed(t));
            last = decoder.process(l, r);
            each(t, last, speed(t));
        }
        last
    }

    fn steady(choice: usize, speed: f64) -> VinylFrame {
        let mut decoder = TimecodeDecoder::new(RATE);
        decoder.set_format(choice);
        let mut generator = TimecodeGenerator::new(fmt(choice.max(1)), RATE, 10.0);
        run(&mut decoder, &mut generator, 0.2, |_| speed, |_, _, _| {})
    }

    #[test]
    fn the_registers_step_back_to_where_they_came_from() {
        for format in &TIMECODE_FORMATS {
            let mut state = format.seed;
            for _ in 0..10_000 {
                let next = step_forward(state, format);
                assert_eq!(step_back(next, format), state, "{}", format.id);
                state = next;
            }
        }
    }

    #[test]
    fn every_formats_sequence_is_one_place_per_register() {
        for choice in 1..=TIMECODE_FORMATS.len() {
            let table = PositionTable::build(choice).unwrap();
            assert!(table.is_unique(), "{}", fmt(choice).id);
            let format = fmt(choice);
            let mut state = format.seed;
            for _ in 0..12_345 {
                state = step_forward(state, &format);
            }
            assert_eq!(table.lookup(state), Some(12_345));
        }
        assert!(PositionTable::build(0).is_none(), "Auto has no table");
    }

    #[test]
    fn steady_speeds_forwards_and_backwards() {
        for speed in [1.0, 0.5, -1.0, 1.08] {
            let frame = steady(SERATO_A, speed);
            assert!(frame.present);
            assert!(
                (frame.speed - speed).abs() < 0.005,
                "{speed}: {}",
                frame.speed
            );
        }
        let frame = steady(TRAKTOR_A, 1.0);
        assert!((frame.speed - 1.0).abs() < 0.005, "traktor {}", frame.speed);
    }

    #[test]
    fn a_scratch_is_followed_within_a_few_milliseconds() {
        let mut decoder = TimecodeDecoder::new(RATE);
        decoder.set_format(SERATO_A);
        let mut generator = TimecodeGenerator::new(fmt(SERATO_A), RATE, 30.0);
        // Swinging between 2 forwards and 2 back, four times a second.
        let swing = |t: f64| 2.0 * (TAU * 4.0 * t).sin();
        let mut worst: f64 = 0.0;
        let mut backwards = false;
        run(&mut decoder, &mut generator, 1.0, swing, |t, frame, _| {
            if t > 0.05 && swing(t).abs() > 0.5 {
                // Against the true speed a few milliseconds ago.
                worst = worst.max((frame.speed - swing(t - 0.002)).abs());
                backwards |= frame.speed < -1.5;
            }
        });
        assert!(worst < 0.2, "{worst}");
        assert!(backwards);
    }

    #[test]
    fn silence_and_noise_are_no_signal() {
        let mut decoder = TimecodeDecoder::new(RATE);
        for _ in 0..4_800 {
            let frame = decoder.process(0.0, 0.0);
            assert!(!frame.present && frame.speed == 0.0);
        }
        let mut seed = 12_345u32;
        let mut noise = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        };
        let mut heard = 0;
        for _ in 0..48_000 {
            let frame = decoder.process(noise() * 0.6, noise() * 0.6);
            heard += usize::from(frame.present);
            assert_eq!(frame.speed, 0.0);
        }
        assert_eq!(heard, 0, "noise is never a signal");
    }

    #[test]
    fn a_lifted_needle_stops_and_a_dropped_one_starts_again() {
        let mut decoder = TimecodeDecoder::new(RATE);
        decoder.set_format(SERATO_A);
        let mut generator = TimecodeGenerator::new(fmt(SERATO_A), RATE, 5.0);
        run(&mut decoder, &mut generator, 0.1, |_| 1.0, |_, _, _| {});
        let mut gone_after = None;
        for i in 0..4_800 {
            if !decoder.process(0.0, 0.0).present && gone_after.is_none() {
                gone_after = Some(i);
            }
        }
        let gone_after = gone_after.expect("lifted, the signal goes");
        assert!(gone_after < 480, "within 10 ms: {gone_after}");
        let frame = run(&mut decoder, &mut generator, 0.05, |_| 1.0, |_, _, _| {});
        assert!(frame.present && (frame.speed - 1.0).abs() < 0.01);
    }

    #[test]
    fn a_dc_offset_is_taken_out() {
        let mut decoder = TimecodeDecoder::new(RATE);
        decoder.set_format(SERATO_A);
        let mut generator = TimecodeGenerator::new(fmt(SERATO_A), RATE, 5.0);
        let mut frame = VinylFrame::default();
        for _ in 0..24_000 {
            let (l, r) = generator.next(1.0);
            frame = decoder.process(l + 0.3, r - 0.2);
        }
        assert!(
            frame.present && (frame.speed - 1.0).abs() < 0.01,
            "{frame:?}"
        );
    }

    /// Decode a Serato record whose channels reach the input as `wire`
    /// makes them, with the decoder's own settings.
    fn wired(wire: impl Fn(f32, f32) -> (f32, f32), swap: bool, invert: bool) -> f64 {
        let mut decoder = TimecodeDecoder::new(RATE);
        decoder.set_format(SERATO_A);
        decoder.swap = swap;
        decoder.invert = invert;
        let mut generator = TimecodeGenerator::new(fmt(SERATO_A), RATE, 5.0);
        let mut frame = VinylFrame::default();
        for _ in 0..9_600 {
            let (l, r) = generator.next(1.0);
            let (l, r) = wire(l, r);
            frame = decoder.process(l, r);
        }
        frame.speed
    }

    #[test]
    fn swapped_or_inverted_channels_read_backwards_unless_the_setting_says() {
        let near = |a: f64, b: f64| (a - b).abs() < 0.01;
        assert!(near(wired(|l, r| (l, r), false, false), 1.0));
        assert!(near(wired(|l, r| (r, l), false, false), -1.0), "swapped");
        assert!(near(wired(|l, r| (r, l), true, false), 1.0), "set to swap");
        assert!(near(wired(|l, r| (l, -r), false, false), -1.0), "inverted");
        assert!(
            near(wired(|l, r| (l, -r), false, true), 1.0),
            "set to invert"
        );
        assert!(
            near(wired(|l, r| (-l, -r), false, false), 1.0),
            "both: no matter"
        );
    }

    #[test]
    fn auto_finds_the_carrier_and_holds_it() {
        for (choice, carrier) in [
            (SERATO_A, 1_000.0),
            (TRAKTOR_A, 2_000.0),
            (MIXVIBES, 1_300.0),
        ] {
            let mut decoder = TimecodeDecoder::new(RATE);
            let mut generator = TimecodeGenerator::new(fmt(choice), RATE, 5.0);
            let frame = run(&mut decoder, &mut generator, 0.5, |_| 1.02, |_, _, _| {});
            assert_eq!(decoder.carrier(), carrier, "{}", fmt(choice).id);
            assert!(
                (frame.speed - 1.02).abs() < 0.01,
                "{}: {}",
                fmt(choice).id,
                frame.speed
            );
            assert!(frame.position.is_nan(), "Auto reads no position");
        }
    }

    fn with_table(choice: usize) -> TimecodeDecoder {
        let mut decoder = TimecodeDecoder::new(RATE);
        decoder.set_format(choice);
        decoder.set_table(PositionTable::build(choice).map(Arc::new));
        decoder
    }

    #[test]
    fn a_needle_drop_is_read_as_its_position() {
        for choice in [SERATO_A, TRAKTOR_A, 8] {
            let mut decoder = with_table(choice);
            let mut generator = TimecodeGenerator::new(fmt(choice), RATE, 123.4);
            let mut known_after = None;
            let frame = run(
                &mut decoder,
                &mut generator,
                0.2,
                |_| 1.0,
                |t, frame, _| {
                    if !frame.position.is_nan() && known_after.is_none() {
                        known_after = Some(t);
                    }
                },
            );
            let id = fmt(choice).id;
            let known_after = known_after.unwrap_or_else(|| panic!("{id}: no position"));
            assert!(known_after < 0.1, "{id}: {known_after}");
            assert!(
                (frame.position - generator.seconds()).abs() < 0.001,
                "{id}: {} against {}",
                frame.position,
                generator.seconds()
            );
        }
    }

    #[test]
    fn the_position_follows_forwards_and_backwards_and_a_scratch() {
        let mut decoder = with_table(SERATO_A);
        let mut generator = TimecodeGenerator::new(fmt(SERATO_A), RATE, 60.0);
        run(&mut decoder, &mut generator, 0.2, |_| 1.0, |_, _, _| {});
        let frame = run(&mut decoder, &mut generator, 0.3, |_| -0.8, |_, _, _| {});
        assert!((frame.position - generator.seconds()).abs() < 0.001, "back");
        let mut worst: f64 = 0.0;
        let mut unknown = 0;
        let swing = |t: f64| 3.0 * (TAU * 5.0 * t).sin();
        let frames = (0.5 * f64::from(RATE)) as usize;
        for i in 0..frames {
            let t = i as f64 / f64::from(RATE);
            let (l, r) = generator.next(swing(t));
            let frame = decoder.process(l, r);
            if frame.position.is_nan() {
                unknown += 1;
            } else {
                worst = worst.max((frame.position - generator.seconds()).abs());
            }
        }
        assert_eq!(unknown, 0, "the position is kept through the scratch");
        assert!(worst < 0.001, "through the scratch: {worst}");
        // A needle dropped elsewhere, after a lift, is read there.
        for _ in 0..2_400 {
            decoder.process(0.0, 0.0);
        }
        generator.drop_needle(300.0);
        let frame = run(&mut decoder, &mut generator, 0.2, |_| 1.0, |_, _, _| {});
        assert!((frame.position - generator.seconds()).abs() < 0.001);
    }

    #[test]
    fn past_the_safe_part_of_the_record_it_is_off_range() {
        let mut decoder = with_table(SERATO_A);
        let format = fmt(SERATO_A);
        let end = f64::from(format.safe) / format.carrier + 1.0;
        let mut generator = TimecodeGenerator::new(format, RATE, end);
        let frame = run(&mut decoder, &mut generator, 0.2, |_| 1.0, |_, _, _| {});
        assert!(frame.present && frame.off_range && frame.position.is_nan());
    }
}
