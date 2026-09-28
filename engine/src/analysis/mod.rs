//! Audio Analysis: the measurements the Assistant listens through.
//!
//! Every measurement takes plain sample buffers, so each is testable without
//! an Engine. `analyse` runs them all over one stretch of stereo audio and
//! places what it finds in the song, in seconds and in bars and beats.
//! `Analysis::to_json` writes the result compactly, for an LLM to read.

mod bands;
pub(crate) mod fft;
mod glyphs;
mod json;
pub(crate) mod key;
mod loudness;
pub(crate) mod onsets;
mod peaks;
mod picture;
pub(crate) mod tempo;

use crate::audio_file::{AudioFile, AudioFileError};
use crate::tempo_map::TempoMap;
use fft::{Spectrogram, frame_size};

pub use bands::{BANDS, Band};
pub use key::Key;
pub use picture::{base64, spectrogram_png};
pub use tempo::Tempo;

/// Frames for onsets and tempo: short, for timing.
const ONSET_FRAME_SECONDS: f32 = 0.02;
const ONSET_FRAMES_PER_SECOND: f32 = 200.0;
/// Frames for bands and key: long, for pitch resolution in the bass.
const SPECTRUM_FRAME_SECONDS: f32 = 0.17;
/// The most onsets listed; the rest are only counted.
pub const MAX_ONSETS: usize = 64;

/// What was analysed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The whole mix, as the Master outputs it.
    Mix,
    /// One Track on its own, after its Insert Chain.
    Track(usize),
    /// A whole audio file, never rendered: the Reference Track (#106).
    File,
}

/// How the analysed audio lines up with the song, to place what is found.
#[derive(Clone, Debug, PartialEq)]
pub struct Timeline {
    /// The tick the audio's first frame is at.
    pub start_tick: f64,
    pub tempo_map: TempoMap,
}

/// A point in the song: seconds from its start, and the bar and beat it
/// falls in, both counting from 1 as the UI shows them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub seconds: f64,
    pub bar: u64,
    pub beat: u64,
}

impl Position {
    /// Bar and beat as "bar.beat", such as "3.2".
    pub fn label(&self) -> String {
        format!("{}.{}", self.bar, self.beat)
    }
}

impl Timeline {
    /// Where the audio's first frame is in the song, in seconds.
    fn start_seconds(&self) -> f64 {
        self.tempo_map.seconds_at(self.start_tick)
    }

    /// The tick `offset` seconds into the analysed audio falls on.
    fn tick_at(&self, offset: f64) -> f64 {
        self.tempo_map.tick_at(self.start_seconds() + offset)
    }

    /// Where `offset` seconds into the analysed audio falls in the song.
    pub fn position(&self, offset: f64) -> Position {
        let seconds = (self.start_seconds() + offset).max(0.0);
        let (bar, beat) = self.tempo_map.bar_and_beat(self.tempo_map.tick_at(seconds));
        Position { seconds, bar, beat }
    }
}

/// A stretch of clipping: its first clipped frame and one past its last.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClipRegion {
    pub start: Position,
    pub end: Position,
}

/// Everything Audio Analysis measures about a stretch of audio. Levels are in
/// dB (LUFS for loudness, dBFS for levels, dBTP for true peak); silence reads
/// `-inf`.
#[derive(Clone, Debug, PartialEq)]
pub struct Analysis {
    pub source: Source,
    pub start: Position,
    pub end: Position,
    pub integrated_lufs: f64,
    pub max_short_term_lufs: f64,
    /// Short-term (3 s) loudness at a few points, each window's start.
    pub short_term_lufs: Vec<(Position, f64)>,
    pub rms_db: f32,
    pub sample_peak_db: f32,
    pub true_peak_db: f32,
    /// Frames where either channel is at or beyond full scale.
    pub clipped_frames: usize,
    /// The first few stretches that clip.
    pub clipping: Vec<ClipRegion>,
    /// How many stretches clip, listed or not.
    pub clip_region_count: usize,
    /// The level in each of `BANDS`, in order.
    pub bands_db: [f32; BANDS.len()],
    pub key: Option<Key>,
    pub tempo: Option<Tempo>,
    /// The first `MAX_ONSETS` places a sound starts.
    pub onsets: Vec<Position>,
    pub onset_count: usize,
}

/// Measure `left` and `right` (the same length) at `sample_rate`.
pub fn analyse(
    left: &[f32],
    right: &[f32],
    sample_rate: f32,
    timeline: &Timeline,
    source: Source,
) -> Analysis {
    let rate = f64::from(sample_rate);
    let at_frame = |frame: usize| timeline.position(frame as f64 / rate);
    let mono: Vec<f32> = left.iter().zip(right).map(|(l, r)| 0.5 * (l + r)).collect();

    let loudness = loudness::measure(left, right, sample_rate);
    let levels = peaks::measure(left, right, sample_rate);

    let long = frame_size(sample_rate, SPECTRUM_FRAME_SECONDS);
    let spectrum = Spectrogram::new(&mono, sample_rate, long, long / 2);
    let hop = (sample_rate / ONSET_FRAMES_PER_SECOND).round().max(1.0) as usize;
    let short = Spectrogram::new(
        &mono,
        sample_rate,
        frame_size(sample_rate, ONSET_FRAME_SECONDS),
        hop,
    );
    let strength = onsets::strength(&short);
    let frames_per_second = rate / hop as f64;
    let onset_frames = onsets::detect(&strength, frames_per_second);

    Analysis {
        source,
        start: at_frame(0),
        end: at_frame(left.len()),
        integrated_lufs: loudness.integrated,
        max_short_term_lufs: loudness.max_short_term,
        short_term_lufs: loudness
            .short_term
            .iter()
            .map(|&(seconds, lufs)| (timeline.position(seconds), lufs))
            .collect(),
        rms_db: levels.rms_db,
        sample_peak_db: levels.sample_peak_db,
        true_peak_db: levels.true_peak_db,
        clipped_frames: levels.clipping.clipped_frames,
        clipping: levels
            .clipping
            .regions
            .iter()
            .map(|r| ClipRegion {
                start: at_frame(r.start),
                end: at_frame(r.end),
            })
            .collect(),
        clip_region_count: levels.clipping.region_count,
        bands_db: bands::measure(&spectrum),
        key: key::detect(&spectrum),
        tempo: tempo::detect(&strength, frames_per_second),
        onsets: onset_frames
            .iter()
            .take(MAX_ONSETS)
            .map(|&frame| timeline.position(short.frame_time(frame)))
            .collect(),
        onset_count: onset_frames.len(),
    }
}

/// Where sounds start in `mono` at `sample_rate`, in seconds from its
/// start, as `analyse` finds its onsets but at a `sensitivity` of its own:
/// 0 finds only the sharpest attacks, 1 nearly every change. For the Audio
/// Editor, which slices a Clip at them.
pub fn transients(mono: &[f32], sample_rate: f32, sensitivity: f64) -> Vec<f64> {
    let hop = (sample_rate / ONSET_FRAMES_PER_SECOND).round().max(1.0) as usize;
    let short = Spectrogram::new(
        mono,
        sample_rate,
        frame_size(sample_rate, ONSET_FRAME_SECONDS),
        hop,
    );
    let strength = onsets::strength(&short);
    let threshold = TRANSIENT_THRESHOLD.0
        + (TRANSIENT_THRESHOLD.1 - TRANSIENT_THRESHOLD.0) * sensitivity.clamp(0.0, 1.0);
    onsets::detect_above(&strength, f64::from(sample_rate) / hop as f64, threshold)
        .into_iter()
        .map(|frame| short.frame_time(frame))
        .collect()
}

/// The onset threshold `transients` uses at sensitivity 0 and at 1: the
/// analysis's own, 0.1, is about a sensitivity of 0.7.
const TRANSIENT_THRESHOLD: (f64, f64) = (0.4, 0.01);

/// The rate `analyse_file` measures a file at, whatever the file's own: the
/// measurements don't depend on it.
pub const FILE_ANALYSIS_RATE: f32 = 48_000.0;

/// Measure the whole of an audio file (WAV, FLAC or MP3) as `analyse`
/// measures a render: the Reference Track (#106), which is never in the mix,
/// so no Engine renders it. A file has no bars of the song, so its positions
/// are placed at 120 BPM in 4/4, from its start: their seconds are what count.
pub fn analyse_file(bytes: &[u8]) -> Result<Analysis, AudioFileError> {
    let file = AudioFile::decode(bytes, FILE_ANALYSIS_RATE)?;
    let timeline = Timeline {
        start_tick: 0.0,
        tempo_map: TempoMap::default(),
    };
    Ok(analyse(
        file.left(),
        file.right(),
        FILE_ANALYSIS_RATE,
        &timeline,
        Source::File,
    ))
}

impl Analysis {
    /// The analysis as compact JSON. Levels are rounded to 0.1 dB, times to
    /// the millisecond; silence's `-inf` is written as `null`.
    pub fn to_json(&self) -> String {
        json::write(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::sine;
    use crate::transport::TimeSignature;

    const RATE: f32 = 48_000.0;

    fn four_four_at_120(start_tick: f64) -> Timeline {
        Timeline {
            start_tick,
            tempo_map: TempoMap::default(),
        }
    }

    #[test]
    fn positions_count_bars_and_beats_from_one() {
        let timeline = four_four_at_120(0.0);
        let start = timeline.position(0.0);
        assert_eq!((start.bar, start.beat, start.label()), (1, 1, "1.1".into()));
        // At 120 BPM a beat is half a second and a 4/4 bar two seconds.
        let later = timeline.position(4.6);
        assert_eq!(later.label(), "3.2");
        assert!((later.seconds - 4.6).abs() < 1e-9);
    }

    #[test]
    fn positions_are_in_the_song_not_the_analysed_range() {
        let bar = TimeSignature::default().bar_ticks() as f64;
        let position = four_four_at_120(bar * 4.0).position(0.5);
        assert_eq!(position.label(), "5.2");
        assert!((position.seconds - 8.5).abs() < 1e-9);
    }

    #[test]
    fn positions_follow_the_tempo_map() {
        let mut tempo_map = TempoMap::default();
        // Bar 2 on is at 60 bpm: a beat a second.
        tempo_map.swap_changes(crate::tempo_map::TempoChanges::from_flat(&[
            3_840.0, 60.0, 4.0, 4.0,
        ]));
        let timeline = Timeline {
            tempo_map,
            ..four_four_at_120(0.0)
        };
        assert_eq!(timeline.position(2.0).label(), "2.1");
        assert_eq!(timeline.position(3.0).label(), "2.2");
        assert_eq!(timeline.position(6.0).label(), "3.1");
    }

    #[test]
    fn positions_follow_the_time_signature() {
        let timeline = Timeline {
            tempo_map: TempoMap::new(
                120.0,
                TimeSignature {
                    beats_per_bar: 6,
                    beat_unit: 8,
                },
            ),
            ..four_four_at_120(0.0)
        };
        // Eighth-note beats are a quarter of a second; six make a bar.
        assert_eq!(timeline.position(1.3).label(), "1.6");
        assert_eq!(timeline.position(1.5).label(), "2.1");
    }

    #[test]
    fn a_tone_is_measured_throughout() {
        let tone = sine(1_000.0, 0.5, RATE, 4 * RATE as usize);
        let analysis = analyse(&tone, &tone, RATE, &four_four_at_120(0.0), Source::Mix);
        assert_eq!(analysis.end.label(), "3.1");
        assert!((analysis.integrated_lufs + 6.02).abs() < 0.1);
        assert!((analysis.sample_peak_db + 6.02).abs() < 0.01);
        assert_eq!(analysis.clipped_frames, 0);
        assert_eq!(analysis.onset_count, 1);
        let loudest = analysis
            .bands_db
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap();
        assert_eq!(BANDS[loudest.0].name, "mid");
    }

    #[test]
    fn a_whole_file_is_measured_as_a_render_is() {
        // A quarter of a second of a 1 kHz tone at half scale, in each format.
        for bytes in [
            crate::audio_file::tests::TONE_WAV,
            crate::audio_file::tests::TONE_FLAC,
        ] {
            let analysis = analyse_file(bytes).unwrap();
            assert_eq!(analysis.source, Source::File);
            assert!(
                (analysis.end.seconds - 0.25).abs() < 1e-3,
                "{:?}",
                analysis.end
            );
            assert!(
                (analysis.sample_peak_db + 6.02).abs() < 0.1,
                "{}",
                analysis.sample_peak_db
            );
            assert!(analysis.to_json().starts_with(r#"{"source":"file","#));
        }
        assert_eq!(analyse_file(b"not audio"), Err(AudioFileError::NotAudio));
    }

    #[test]
    fn silence_measures_as_nothing() {
        let silence = vec![0.0; RATE as usize];
        let analysis = analyse(
            &silence,
            &silence,
            RATE,
            &four_four_at_120(0.0),
            Source::Mix,
        );
        assert_eq!(analysis.integrated_lufs, f64::NEG_INFINITY);
        assert_eq!((analysis.key, analysis.tempo), (None, None));
        assert!(analysis.onsets.is_empty());
    }
}
