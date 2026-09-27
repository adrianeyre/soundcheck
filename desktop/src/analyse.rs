//! Audio Analysis for the Assistant, off the audio thread.
//!
//! The UI sends the Project as the `EngineCommand`s that would bring a fresh
//! engine to it, the same ones the playing engine was sent, so what is
//! analysed is exactly what plays. They go through a `Controller` and a
//! `Renderer` of their own, which no device plays, and the engine renders
//! the range offline.

use serde::Serialize;
use soundcheck_engine::{Attachments, Source, base64};

use crate::command::EngineCommand;
use crate::host::offline;

/// The rate the analysis renders at, whatever the device runs at: the
/// measurements don't depend on it.
pub const SAMPLE_RATE: f32 = 48_000.0;

/// Bring a fresh engine to `commands`, then render from `start` to `end`
/// ticks and measure it: the whole mix, or with `track` that engine Track
/// alone. Compact JSON, as the engine writes it.
pub fn analyse(commands: Vec<EngineCommand>, start: f64, end: f64, track: Option<usize>) -> String {
    let mut renderer = offline(SAMPLE_RATE, commands);
    let source = track.map_or(Source::Mix, Source::Track);
    renderer.engine_mut().analysis(start, end, source).to_json()
}

/// What `audio_analyse` resolves to: the measurements, a spectrogram of the
/// same render when one was asked for, and the render itself as audio when
/// that was.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysed {
    pub measurements: String,
    /// A PNG, base64-encoded as Claude's image input takes it.
    pub spectrogram: Option<String>,
    /// A mono WAV file, base64-encoded, as `Listening` has it.
    pub audio: Option<String>,
    /// How long `audio` is, in seconds; 0 without it.
    pub audio_seconds: f64,
}

/// `analyse`, plus whatever `attachments` asks for, of the same render.
pub fn analyse_with(
    commands: Vec<EngineCommand>,
    start: f64,
    end: f64,
    track: Option<usize>,
    attachments: Attachments,
) -> Analysed {
    let mut renderer = offline(SAMPLE_RATE, commands);
    let source = track.map_or(Source::Mix, Source::Track);
    let attached = renderer
        .engine_mut()
        .analysis_with(start, end, source, attachments);
    Analysed {
        measurements: attached.analysis.to_json(),
        spectrogram: attached.spectrogram.as_deref().map(base64),
        audio: attached.audio.as_deref().map(base64),
        audio_seconds: attached.audio_seconds,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soundcheck_engine::{Listening, TICKS_PER_BEAT};

    const BAR: f64 = TICKS_PER_BEAT as f64 * 4.0;

    /// One Synth Track holding a loud chord for a bar, at `volume`.
    fn loud_chord(volume: f32) -> Vec<EngineCommand> {
        let notes = [36.0, 43.0, 48.0, 52.0, 55.0, 60.0, 64.0, 67.0, 72.0, 76.0]
            .iter()
            .flat_map(|&pitch| [0.0, BAR, pitch, 1.0])
            .collect();
        vec![
            EngineCommand::SetTempo { bpm: 120.0 },
            EngineCommand::SetTrackCount { count: 1 },
            EngineCommand::SetTrackNotes { track: 0, notes },
            EngineCommand::SetTrackMixer {
                track: 0,
                volume,
                pan: 0.0,
                mute: false,
                solo: false,
            },
        ]
    }

    fn clipped_samples(json: &str) -> usize {
        let at = json
            .find(r#""clipped_samples":"#)
            .expect("a clipping count")
            + 18;
        json[at..]
            .split(|c: char| !c.is_ascii_digit())
            .next()
            .and_then(|digits| digits.parse().ok())
            .expect("a number")
    }

    #[test]
    fn a_track_too_loud_clips_and_turned_down_does_not() {
        let loud = analyse(loud_chord(2.0), 0.0, BAR, None);
        assert!(loud.starts_with(r#"{"source":"mix""#), "{loud}");
        assert!(clipped_samples(&loud) > 0, "{loud}");

        let quiet = analyse(loud_chord(0.1), 0.0, BAR, None);
        assert_eq!(clipped_samples(&quiet), 0, "{quiet}");
    }

    #[test]
    fn one_track_is_heard_on_its_own() {
        let json = analyse(loud_chord(0.5), 0.0, BAR, Some(0));
        assert!(json.starts_with(r#"{"source":"track 0""#), "{json}");
        assert!(!json.contains(r#""sample_peak_db":null"#), "{json}");
    }

    #[test]
    fn a_project_with_nothing_in_it_is_silence() {
        let json = analyse(Vec::new(), 0.0, BAR, None);
        assert!(json.contains(r#""sample_peak_db":null"#), "{json}");
    }

    fn attachments(spectrogram: bool, audio: Option<Listening>) -> Attachments {
        Attachments { spectrogram, audio }
    }

    #[test]
    fn a_spectrogram_and_audio_come_only_when_asked_for() {
        let plain = analyse_with(loud_chord(0.5), 0.0, BAR, None, attachments(false, None));
        assert_eq!((plain.spectrogram, plain.audio), (None, None));
        assert_eq!(plain.measurements, analyse(loud_chord(0.5), 0.0, BAR, None));

        let seen = analyse_with(loud_chord(0.5), 0.0, BAR, None, attachments(true, None));
        assert_eq!(seen.measurements, plain.measurements);
        let png = seen.spectrogram.expect("a spectrogram");
        assert!(png.starts_with("iVBORw0KGgo"), "{}", &png[..16]);
        assert_eq!(seen.audio, None);

        let listening = Listening {
            sample_rate: 16_000,
            max_seconds: 1.0,
        };
        let heard = analyse_with(
            loud_chord(0.5),
            0.0,
            BAR,
            None,
            attachments(false, Some(listening)),
        );
        assert_eq!(heard.measurements, plain.measurements);
        assert_eq!(heard.spectrogram, None);
        // "RIFF", base64-encoded; a bar is 2 seconds, cut to the one asked for.
        assert!(heard.audio.expect("audio").starts_with("UklGR"));
        assert!(
            (heard.audio_seconds - 1.0).abs() < 1e-3,
            "{}",
            heard.audio_seconds
        );
    }

    /// The peak the analysis measured, in dB, or None for silence.
    fn sample_peak_db(json: &str) -> Option<f64> {
        let at = json.find(r#""sample_peak_db":"#).expect("a sample peak") + 17;
        json[at..]
            .split([',', '}'])
            .next()
            .and_then(|value| value.parse().ok())
    }

    /// Two beats of the chord on its own, then `effect` on `chain` with `settings`.
    fn chord_through(chain: i32, effect: &str, settings: Vec<f32>) -> Vec<EngineCommand> {
        let mut commands = loud_chord(0.5);
        let EngineCommand::SetTrackNotes { notes, .. } = &mut commands[2] else {
            unreachable!()
        };
        for length in notes.iter_mut().skip(1).step_by(4) {
            *length = BAR / 2.0;
        }
        commands.extend([
            EngineCommand::InsertEffect {
                chain,
                index: 0,
                effect: effect.to_string(),
            },
            EngineCommand::SetEffectSettings {
                chain,
                index: 0,
                settings,
            },
        ]);
        commands
    }

    #[test]
    fn the_analysis_hears_the_compressor_and_the_reverb_on_any_chain() {
        // Threshold, ratio, attack, release, makeup, knee; and size, decay,
        // damping, pre-delay, width, mix.
        let compressor = vec![-40.0, 20.0, 0.1, 50.0, 0.0, 0.0];
        let reverb = |mix| vec![0.5, 2.0, 0.5, 0.0, 1.0, mix];
        // The chord stops at half a bar, and its release is short: the last
        // quarter of the bar is silent without a Reverb.
        let tail = |commands| analyse(commands, BAR * 0.75, BAR, None);
        let plain = chord_through(0, "reverb", reverb(0.0));
        let loud = sample_peak_db(&analyse(plain.clone(), 0.0, BAR, None)).unwrap();
        assert_eq!(sample_peak_db(&tail(plain)), None);

        for chain in [0, -1] {
            let squashed = analyse(
                chord_through(chain, "compressor", compressor.clone()),
                0.0,
                BAR,
                None,
            );
            assert!(
                sample_peak_db(&squashed).unwrap() < loud - 12.0,
                "{chain}: {squashed}"
            );
            let wet = tail(chord_through(chain, "reverb", reverb(1.0)));
            assert!(sample_peak_db(&wet).is_some(), "{chain}: {wet}");
        }
    }
}
