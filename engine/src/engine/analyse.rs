//! Audio Analysis of the Engine's own sound: render a range offline, the
//! whole mix or one Track on its own, and measure it, and draw it if asked.

use wasm_bindgen::prelude::*;

use super::Engine;
use crate::analysis::{self, Analysis, Source, Timeline};
use crate::dsp::resample;
use crate::wav_writer::{SampleFormat, mono_wav_bytes};

/// How far before the range the render starts, so what rings into it is
/// heard as it would be playing through: a Reverb's tail (its longest decay),
/// a Delay's repeats, a Compressor already clamping down, a Synth's release.
const PRE_ROLL_SECONDS: f64 = 10.0;

/// The measurements of one render, and what else `analyse_audio` asked for
/// of the same render: a picture of it, the audio itself, or both.
/// Only its strings are cloned out to JavaScript; the number is copied.
#[wasm_bindgen]
pub struct AnalysisWithAttachments {
    /// Compact JSON, as `Engine::analyse` writes it.
    #[wasm_bindgen(getter_with_clone)]
    pub measurements: String,
    /// The spectrogram as a base64 PNG, as Claude's image input takes it.
    #[wasm_bindgen(getter_with_clone)]
    pub spectrogram: Option<String>,
    /// The render as a base64 mono WAV file (see `Listening`).
    #[wasm_bindgen(getter_with_clone)]
    pub audio: Option<String>,
    /// How long `audio` is, in seconds; 0 without it.
    pub audio_seconds: f64,
}

/// How the Assistant hears a render as audio: mono, the two channels
/// averaged, at `sample_rate`, as 16-bit PCM, and at most `max_seconds`
/// of it, from the start of the range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Listening {
    pub sample_rate: u32,
    pub max_seconds: f64,
}

/// What an analysis draws or encodes as well as measuring.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Attachments {
    pub spectrogram: bool,
    pub audio: Option<Listening>,
}

/// One analysis and its attachments, for native callers.
#[derive(Debug, PartialEq)]
pub struct Attached {
    pub analysis: Analysis,
    /// A PNG file.
    pub spectrogram: Option<Vec<u8>>,
    /// A mono WAV file.
    pub audio: Option<Vec<u8>>,
    /// How long `audio` is, in seconds; 0 without it.
    pub audio_seconds: f64,
}

#[wasm_bindgen]
impl Engine {
    /// Render from `start` to `end` ticks offline and analyse it, as compact
    /// JSON (see `Analysis::to_json`). `track` below 0 is the whole mix;
    /// otherwise that Track alone, after its Insert Chain.
    pub fn analyse(&mut self, start: f64, end: f64, track: i32) -> String {
        let source = usize::try_from(track).map_or(Source::Mix, Source::Track);
        self.analysis(start, end, source).to_json()
    }

    /// `analyse`, plus a spectrogram of the same render if `spectrogram`, and
    /// the render itself as audio at `audio_rate` Hz, at most
    /// `audio_max_seconds` of it, unless `audio_rate` is 0.
    pub fn analyse_with(
        &mut self,
        start: f64,
        end: f64,
        track: i32,
        spectrogram: bool,
        audio_rate: u32,
        audio_max_seconds: f64,
    ) -> AnalysisWithAttachments {
        let source = usize::try_from(track).map_or(Source::Mix, Source::Track);
        let audio = (audio_rate > 0).then_some(Listening {
            sample_rate: audio_rate,
            max_seconds: audio_max_seconds,
        });
        let attached = self.analysis_with(start, end, source, Attachments { spectrogram, audio });
        AnalysisWithAttachments {
            measurements: attached.analysis.to_json(),
            spectrogram: attached.spectrogram.as_deref().map(analysis::base64),
            audio: attached.audio.as_deref().map(analysis::base64),
            audio_seconds: attached.audio_seconds,
        }
    }
}

impl Engine {
    /// `analyse` for native callers (tests, a future desktop host), returning
    /// the measurements themselves. The metronome is left out of the render.
    /// One Track is rendered through its own mixer channel and the Master,
    /// but whatever mute and solo say: you asked for that Track.
    pub fn analysis(&mut self, start: f64, end: f64, source: Source) -> Analysis {
        let (left, right, timeline) = self.render_for_analysis(start, end, source);
        analysis::analyse(&left, &right, self.sample_rate, &timeline, source)
    }

    /// `analysis`, plus a spectrogram of the same render as a PNG file.
    pub fn analysis_with_spectrogram(
        &mut self,
        start: f64,
        end: f64,
        source: Source,
    ) -> (Analysis, Vec<u8>) {
        let attachments = Attachments {
            spectrogram: true,
            audio: None,
        };
        let attached = self.analysis_with(start, end, source, attachments);
        (attached.analysis, attached.spectrogram.unwrap_or_default())
    }

    /// `analysis`, plus whatever `attachments` asks for, all of one render.
    pub fn analysis_with(
        &mut self,
        start: f64,
        end: f64,
        source: Source,
        attachments: Attachments,
    ) -> Attached {
        let (left, right, timeline) = self.render_for_analysis(start, end, source);
        let analysis = analysis::analyse(&left, &right, self.sample_rate, &timeline, source);
        let spectrogram = attachments
            .spectrogram
            .then(|| analysis::spectrogram_png(&left, &right, self.sample_rate, &timeline));
        let audio = attachments
            .audio
            .map(|listening| listening_wav(&left, &right, self.sample_rate, listening));
        Attached {
            analysis,
            spectrogram,
            audio_seconds: audio.as_ref().map_or(0.0, |(_, seconds)| *seconds),
            audio: audio.map(|(wav, _)| wav),
        }
    }

    /// The left and right channels of the range, and where they are in the
    /// song.
    fn render_for_analysis(
        &mut self,
        start: f64,
        end: f64,
        source: Source,
    ) -> (Vec<f32>, Vec<f32>, Timeline) {
        let saved = (self.isolate, self.metronome_on);
        self.isolate = match source {
            // An Engine's render is never a file: asked for one, it is the mix.
            Source::Mix | Source::File => None,
            Source::Track(index) => Some(index),
        };
        self.metronome_on = false;
        let from = start.max(0.0).floor();
        let map = self.transport.tempo_map().clone();
        let pre_roll = map
            .tick_at(map.seconds_at(from) - PRE_ROLL_SECONDS)
            .max(0.0)
            .floor();
        // Where `from` falls once the render starts at `pre_roll`, as
        // `Transport::frame_of` puts it.
        let skip = ((map.seconds_at(from) - map.seconds_at(pre_roll)) * f64::from(self.sample_rate)
            - 1e-6)
            .ceil()
            .max(0.0) as usize;
        let mut interleaved = self.render_range(pre_roll, end);
        interleaved.drain(..(skip * 2).min(interleaved.len()));
        (self.isolate, self.metronome_on) = saved;

        let (left, right): (Vec<f32>, Vec<f32>) = interleaved
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&[l, r]| (l, r))
            .unzip();
        let timeline = Timeline {
            start_tick: start.max(0.0).floor(),
            tempo_map: map,
        };
        (left, right, timeline)
    }
}

/// The first `max_seconds` of a render as `listening` has it, and how many
/// seconds that is.
fn listening_wav(left: &[f32], right: &[f32], rate: f32, listening: Listening) -> (Vec<u8>, f64) {
    let frames = left
        .len()
        .min((listening.max_seconds.max(0.0) * f64::from(rate)).floor() as usize);
    let mono: Vec<f32> = left[..frames]
        .iter()
        .zip(right)
        .map(|(l, r)| (l + r) * 0.5)
        .collect();
    let to = f64::from(listening.sample_rate.max(1));
    let samples = resample(&mono, f64::from(rate), to);
    let seconds = samples.len() as f64 / to;
    (
        mono_wav_bytes(&samples, listening.sample_rate.max(1), SampleFormat::Int16),
        seconds,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::BANDS;
    use crate::transport::TICKS_PER_BEAT;

    const RATE: f32 = 48_000.0;
    const BEAT: f64 = TICKS_PER_BEAT as f64;
    const BAR: f64 = BEAT * 4.0;

    /// Flat notes for `set_track_notes`: every pitch of `chord` from `start`
    /// ticks for `length` ticks.
    fn chord(start: f64, length: f64, chord: &[u8], velocity: f64) -> Vec<f64> {
        chord
            .iter()
            .flat_map(|&pitch| [start, length, f64::from(pitch), velocity])
            .collect()
    }

    /// I–IV–V–I in C, one chord a beat with a bass note, for `bars` bars.
    fn c_major_loop(bars: usize) -> Vec<f64> {
        let progression: [&[u8]; 4] = [
            &[36, 60, 64, 67],
            &[41, 60, 65, 69],
            &[43, 59, 62, 67],
            &[36, 60, 64, 67],
        ];
        (0..bars * 4)
            .flat_map(|beat| chord(beat as f64 * BEAT, BEAT * 0.75, progression[beat % 4], 0.8))
            .collect()
    }

    fn band(analysis: &Analysis, name: &str) -> f32 {
        analysis.bands_db[BANDS.iter().position(|b| b.name == name).unwrap()]
    }

    #[test]
    fn a_c_major_chord_loop_at_120_bpm_is_in_c_major_at_120_bpm() {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(1);
        engine.set_track_notes(0, &c_major_loop(4));
        let analysis = engine.analysis(0.0, 4.0 * BAR, Source::Mix);

        let key = analysis.key.unwrap();
        assert_eq!(key.name(), "C major");
        assert!(key.confidence > 0.5, "{key:?}");
        let tempo = analysis.tempo.unwrap();
        assert!((tempo.bpm - 120.0).abs() < 1.0, "{tempo:?}");
        assert!(tempo.confidence > 0.5, "{tempo:?}");
    }

    #[test]
    fn tempo_follows_the_transport_not_a_preference_for_120() {
        let mut engine = Engine::new(RATE);
        engine.set_tempo(95.0);
        engine.set_track_count(1);
        engine.set_track_notes(0, &c_major_loop(4));
        let tempo = engine.analysis(0.0, 4.0 * BAR, Source::Mix).tempo.unwrap();
        assert!((tempo.bpm - 95.0).abs() < 1.0, "{tempo:?}");
    }

    #[test]
    fn every_chord_is_an_onset_on_its_beat() {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(1);
        engine.set_track_notes(0, &c_major_loop(2));
        let analysis = engine.analysis(0.0, 2.0 * BAR, Source::Mix);

        assert_eq!(analysis.onset_count, 8, "{:?}", analysis.onsets);
        for (beat, onset) in analysis.onsets.iter().enumerate() {
            let expected = beat as f64 * 0.5;
            assert!((onset.seconds - expected).abs() < 0.02, "{onset:?}");
            assert_eq!(onset.label(), format!("{}.{}", beat / 4 + 1, beat % 4 + 1));
        }
    }

    #[test]
    fn a_deliberately_clipped_render_says_where_it_clips() {
        // The same full chord on every Track adds up far past full scale,
        // from bar 2 until the chord fades out.
        let mut engine = Engine::new(RATE);
        engine.set_track_count(4);
        let loud = chord(BAR, BAR, &[48, 52, 55, 60, 64, 67, 72, 76], 1.0);
        for track in 0..4 {
            engine.set_track_notes(track, &loud);
        }
        let analysis = engine.analysis(0.0, 3.0 * BAR, Source::Mix);

        assert!(analysis.clipped_frames > 0);
        assert!(
            analysis.sample_peak_db.abs() < 1e-3,
            "{}",
            analysis.sample_peak_db
        );
        let first = analysis.clipping[0];
        assert_eq!(first.start.label(), "2.1");
        assert!((first.start.seconds - 2.0).abs() < 0.05, "{first:?}");
        let last = analysis.clipping.last().unwrap();
        assert!(last.end.seconds <= 4.5, "{last:?}");
    }

    #[test]
    fn a_quiet_render_does_not_clip() {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(1);
        engine.set_track_notes(0, &chord(0.0, BAR, &[60], 0.5));
        let analysis = engine.analysis(0.0, BAR, Source::Mix);
        assert_eq!(analysis.clipped_frames, 0);
        assert!(analysis.clipping.is_empty());
    }

    #[test]
    fn one_track_is_analysed_on_its_own() {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(2);
        engine.set_track_notes(0, &chord(0.0, BAR, &[36], 1.0));
        engine.set_track_notes(1, &chord(0.0, BAR, &[84], 1.0));

        let low = engine.analysis(0.0, BAR, Source::Track(0));
        let high = engine.analysis(0.0, BAR, Source::Track(1));
        let mix = engine.analysis(0.0, BAR, Source::Mix);
        // A C2 lives in the bass, a C6 in the mids; the mix has both.
        assert!(band(&low, "bass") > band(&high, "bass") + 40.0);
        assert!(band(&high, "mid") > band(&low, "mid") + 10.0);
        assert!((band(&mix, "bass") - band(&low, "bass")).abs() < 1.0);
        assert!((band(&mix, "mid") - band(&high, "mid")).abs() < 1.0);
        assert!(mix.integrated_lufs > low.integrated_lufs);
    }

    #[test]
    fn analysis_leaves_the_engine_as_it_was() {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(2);
        engine.set_metronome(true);
        engine.set_track_notes(0, &chord(0.0, BAR, &[60], 1.0));
        engine.analysis(0.0, BAR, Source::Track(1));
        assert_eq!(engine.isolate, None);
        assert!(engine.metronome_on);
    }

    #[test]
    fn a_missing_track_analyses_as_silence() {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(1);
        engine.set_track_notes(0, &chord(0.0, BAR, &[60], 1.0));
        let analysis = engine.analysis(0.0, BAR, Source::Track(5));
        assert_eq!(analysis.integrated_lufs, f64::NEG_INFINITY);
    }

    #[test]
    fn the_json_names_every_measurement_and_places_it_in_bars_and_beats() {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(1);
        engine.set_track_notes(0, &c_major_loop(2));
        let json = engine.analyse(BAR, 2.0 * BAR, -1);

        assert!(
            json.starts_with(
                r#"{"source":"mix","start":{"s":2,"at":"2.1"},"end":{"s":4,"at":"3.1"}"#
            ),
            "{json}"
        );
        for field in [
            "\"integrated_lufs\":",
            "\"max_short_term_lufs\":",
            "\"short_term\":",
            "\"rms_db\":",
            "\"true_peak_dbtp\":",
            "\"clipping\":{\"clipped_samples\":0,\"region_count\":0,\"regions\":[]}",
            "\"bands_db\":{\"sub\":",
            "\"key\":{\"name\":\"C major\"",
            "\"tempo\":{\"bpm\":",
            "\"onsets\":{\"count\":4,",
        ] {
            assert!(json.contains(field), "{field} missing from {json}");
        }
        assert!(!json.contains("inf") && !json.contains("NaN"), "{json}");
        assert!(json.ends_with("}}"));
        assert_eq!(json.matches('{').count(), json.matches('}').count());

        let track = engine.analyse(0.0, BAR, 0);
        assert!(track.starts_with(r#"{"source":"track 0""#), "{track}");
    }

    #[test]
    fn the_spectrogram_is_drawn_from_the_same_render_as_the_measurements() {
        // A fresh engine each time: a render leaves the Synth's state behind.
        let engine = || {
            let mut engine = Engine::new(RATE);
            engine.set_track_count(1);
            engine.set_track_notes(0, &c_major_loop(2));
            engine
        };
        let measured = engine().analysis(0.0, 2.0 * BAR, Source::Mix);
        let (seen, png) = engine().analysis_with_spectrogram(0.0, 2.0 * BAR, Source::Mix);
        assert_eq!(seen, measured);
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));

        let both = engine().analyse_with(0.0, 2.0 * BAR, -1, true, 0, 0.0);
        assert_eq!(both.measurements, measured.to_json());
        let spectrogram = both.spectrogram.unwrap();
        assert!(
            spectrogram.starts_with("iVBORw0KGgo"),
            "{}",
            &spectrogram[..16]
        );
        assert_eq!((both.audio, both.audio_seconds), (None, 0.0));
    }

    const LISTENING: Listening = Listening {
        sample_rate: 16_000,
        max_seconds: 3.0,
    };

    #[test]
    fn the_audio_is_the_same_render_in_mono_at_the_rate_asked_for() {
        let engine = || {
            let mut engine = Engine::new(RATE);
            engine.set_track_count(1);
            engine.set_track_notes(0, &c_major_loop(1));
            engine
        };
        let measured = engine().analysis(0.0, BAR, Source::Mix);
        let attachments = Attachments {
            spectrogram: false,
            audio: Some(LISTENING),
        };
        let heard = engine().analysis_with(0.0, BAR, Source::Mix, attachments);
        assert_eq!(heard.analysis, measured);
        assert_eq!(heard.spectrogram, None);
        // A bar at 120 BPM is 2 seconds: under the cap, so all of it.
        assert!(
            (heard.audio_seconds - 2.0).abs() < 1e-3,
            "{}",
            heard.audio_seconds
        );
        let wav = heard.audio.unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        let read = crate::instrument::decode(&wav).unwrap();
        assert_eq!((read.rate(), read.frames()), (16_000.0, 32_000));
        // The chords are in it: as loud as the render, give or take the
        // averaging of two identical channels, which changes nothing.
        let peak = (0..read.frames())
            .map(|frame| read.at(frame, 0).abs())
            .fold(0.0, f32::max);
        let render_peak = 10f32.powf(measured.sample_peak_db / 20.0);
        assert!(
            (peak - render_peak).abs() < 0.1 * render_peak,
            "{peak} vs {render_peak}"
        );
    }

    #[test]
    fn audio_longer_than_the_cap_is_cut_to_it_from_the_start_of_the_range() {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(1);
        engine.set_track_notes(0, &c_major_loop(4));
        let attachments = Attachments {
            spectrogram: false,
            audio: Some(LISTENING),
        };
        // From bar 2 for three bars: 6 seconds, measured in full.
        let heard = engine.analysis_with(BAR, 4.0 * BAR, Source::Mix, attachments);
        assert_eq!(
            (heard.analysis.start.seconds, heard.analysis.end.seconds),
            (2.0, 8.0)
        );
        assert!(
            (heard.audio_seconds - 3.0).abs() < 1e-3,
            "{}",
            heard.audio_seconds
        );
        let read = crate::instrument::decode(&heard.audio.unwrap()).unwrap();
        assert_eq!(read.frames(), 48_000);

        let wasm = engine.analyse_with(BAR, 4.0 * BAR, -1, false, 16_000, 3.0);
        assert!(wasm.audio.unwrap().starts_with("UklGR"));
        assert!((wasm.audio_seconds - 3.0).abs() < 1e-3);
        assert_eq!(wasm.spectrogram, None);
    }

    #[test]
    fn a_range_hears_the_reverb_ringing_into_it_from_before() {
        // A chord for the first beat, then a bar of silence to analyse.
        let engine = |mix: f32| {
            let mut engine = Engine::new(RATE);
            engine.set_track_count(1);
            engine.set_track_notes(0, &chord(0.0, BEAT, &[48, 60, 64, 67], 0.8));
            engine.insert_effect(-1, 0, "reverb");
            // Size, decay, damping, pre-delay, width, mix.
            engine.set_effect_settings(-1, 0, &[0.5, 4.0, 0.5, 0.0, 1.0, mix]);
            engine
        };
        let dry = engine(0.0).analysis(2.0 * BEAT, 2.0 * BEAT + BAR, Source::Mix);
        assert!(!dry.sample_peak_db.is_finite(), "{dry:?}");
        let wet = engine(1.0).analysis(2.0 * BEAT, 2.0 * BEAT + BAR, Source::Mix);
        assert!(wet.sample_peak_db > -60.0, "{wet:?}");
        // Only the range is measured: from beat 3, a second in, for a bar.
        assert_eq!((wet.start.seconds, wet.end.seconds), (1.0, 3.0));
    }
}
