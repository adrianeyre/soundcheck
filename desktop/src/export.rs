//! Exporting the mix, or one Audio Clip's own audio, as a WAV or MP3 file,
//! rendered offline in this process.
//!
//! The UI sends the commands that build its Project into a fresh Engine,
//! the range to render and the file's format. The render runs on its own
//! Engine on a worker thread, never the audio thread, so playback carries
//! on; the UI polls `ExportJob::progress` over IPC and can cancel. For one
//! Audio Clip it sends the Clip's audio file and the stretch the Clip plays,
//! which is written as it is, with nothing of the mix.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use serde::Deserialize;
use soundcheck_engine::{ClipRender, SampleFormat, mp3_bytes, wav_bytes};

use crate::command::EngineCommand;
use crate::host::{Renderer, offline};

/// How long reverb and release tails may run past the range's end. The
/// render stops sooner, once the sound has died away.
pub const TAIL_SECONDS: f32 = 10.0;

/// The sample rates a mix exports at.
const SAMPLE_RATES: [u32; 2] = [44_100, 48_000];

/// Frames rendered between progress reports and checks for cancelling: a
/// tenth of a second of audio, which renders in a few milliseconds.
const STEP: usize = 4_800;

/// What to export: mirrors `ExportRequest` in `app/src/export/mix-exporter.ts`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    /// Builds the Project into a fresh Engine.
    pub commands: Vec<EngineCommand>,
    /// The range, in ticks: the whole song or the loop region.
    pub start_tick: f64,
    pub end_tick: f64,
    pub sample_rate: u32,
    /// What kind of file, and its format.
    pub encoding: Encoding,
}

/// The kind of file the save dialog asks for.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ExportKind {
    Wav,
    Mp3,
}

/// The file's kind: mirrors `Encoding` in `app/src/export/mix-exporter.ts`.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Encoding {
    /// 16 or 24 for integer PCM, 32 for float.
    Wav { bits: u32 },
    /// Constant bitrate, in kbps.
    Mp3 { kbps: u32 },
}

/// One export under way, shared between the thread rendering it and the
/// IPC commands that watch and cancel it.
#[derive(Debug, Default)]
pub struct ExportJob {
    /// 0 to 1, as an `f32`'s bits.
    progress: AtomicU32,
    cancelled: AtomicBool,
}

impl ExportJob {
    pub fn progress(&self) -> f32 {
        f32::from_bits(self.progress.load(Ordering::Relaxed))
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    /// Render `request` as a file's bytes, or None if cancelled first.
    pub fn render(&self, request: &ExportRequest) -> Result<Option<Vec<u8>>, String> {
        render_mix(request, |progress| self.carry_on(progress))
    }

    /// Render one Audio Clip's own audio, from its file's bytes `audio`, as
    /// a file's bytes, or None if cancelled first.
    pub fn render_clip(
        &self,
        audio: &[u8],
        request: &ClipExportRequest,
    ) -> Result<Option<Vec<u8>>, String> {
        render_clip(audio, request, |progress| self.carry_on(progress))
    }

    /// Note how far the render has got, and answer whether to carry on.
    fn carry_on(&self, progress: f32) -> bool {
        self.progress.store(progress.to_bits(), Ordering::Relaxed);
        !self.cancelled.load(Ordering::Relaxed)
    }
}

/// A file's format, checked against those offered.
enum Format {
    Wav(SampleFormat),
    Mp3 { kbps: u32 },
}

impl Format {
    /// Checked before rendering, so a format that isn't offered fails at once.
    fn checked(encoding: Encoding, sample_rate: u32) -> Result<Self, String> {
        if !SAMPLE_RATES.contains(&sample_rate) {
            return Err(format!("{sample_rate} Hz isn't offered"));
        }
        match encoding {
            Encoding::Wav { bits } => SampleFormat::from_bits(bits)
                .map(Self::Wav)
                .ok_or_else(|| format!("{bits}-bit WAV isn't offered")),
            Encoding::Mp3 { kbps } if soundcheck_engine::MP3_BITRATES.contains(&kbps) => {
                Ok(Self::Mp3 { kbps })
            }
            Encoding::Mp3 { kbps } => Err(format!("{kbps} kbps MP3 isn't offered")),
        }
    }

    /// `audio`, interleaved stereo at `sample_rate`, as a file's bytes.
    fn encode(&self, audio: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
        match *self {
            Self::Wav(format) => Ok(wav_bytes(audio, sample_rate, format)),
            Self::Mp3 { kbps } => mp3_bytes(audio, sample_rate, kbps),
        }
    }
}

/// Render `request` as a WAV or MP3 file's bytes. `progress` hears how far
/// the range has got, 0 to 1, and answers whether to carry on; None if it
/// didn't.
pub fn render_mix(
    request: &ExportRequest,
    mut progress: impl FnMut(f32) -> bool,
) -> Result<Option<Vec<u8>>, String> {
    let format = Format::checked(request.encoding, request.sample_rate)?;
    let mut renderer = offline_renderer(request.sample_rate, &request.commands);
    let engine = renderer.engine_mut();
    let range = engine.start_render(request.start_tick, request.end_tick, TAIL_SECONDS);
    let mut audio = Vec::with_capacity(range * 2);
    loop {
        // The tail's length isn't known until it ends, so it counts as done.
        let done = (audio.len() / 2) as f32 / range.max(1) as f32;
        if !progress(done.min(1.0)) {
            return Ok(None);
        }
        let step = engine.render_next(STEP);
        if step.is_empty() {
            break;
        }
        audio.extend(step);
    }
    let file = format.encode(&audio, request.sample_rate)?;
    progress(1.0);
    Ok(Some(file))
}

/// One Audio Clip's own audio to export: mirrors `ClipExportRequest` in
/// `app/src/export/mix-exporter.ts`. The file's bytes come beside it.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipExportRequest {
    /// Seconds into the file where the Clip starts playing.
    pub file_offset: f64,
    /// Seconds of the file the Clip plays.
    pub duration: f64,
    pub sample_rate: u32,
    pub encoding: Encoding,
}

/// Where to write a Clip's export, and what to render: the JSON that
/// `export_clip`'s raw body starts with.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ClipExport {
    pub path: String,
    pub request: ClipExportRequest,
}

/// `export_clip`'s body: the byte length of its JSON as four little-endian
/// bytes, the JSON (a `ClipExport`), then the audio file's bytes. One raw
/// body carries a song-length file without a JSON list of numbers, and a
/// path headers might not carry intact.
pub fn read_clip_body(body: &[u8]) -> Result<(ClipExport, &[u8]), String> {
    let malformed = || "The Clip to export arrived malformed.".to_string();
    let (length, rest) = body.split_first_chunk::<4>().ok_or_else(malformed)?;
    let length = u32::from_le_bytes(*length) as usize;
    if rest.len() < length {
        return Err(malformed());
    }
    let (json, audio) = rest.split_at(length);
    let export = serde_json::from_slice(json).map_err(|_| malformed())?;
    Ok((export, audio))
}

/// Render the stretch of the audio file `audio` an Audio Clip plays, raw,
/// past the mixer, as a WAV or MP3 file's bytes. `progress` is as
/// `render_mix` has it.
pub fn render_clip(
    audio: &[u8],
    request: &ClipExportRequest,
    mut progress: impl FnMut(f32) -> bool,
) -> Result<Option<Vec<u8>>, String> {
    let format = Format::checked(request.encoding, request.sample_rate)?;
    if !progress(0.0) {
        return Ok(None);
    }
    let mut clip = ClipRender::decode(
        audio,
        request.file_offset,
        request.duration,
        request.sample_rate,
    )?;
    let frames = clip.frames();
    let mut out = Vec::with_capacity(frames * 2);
    loop {
        if !progress((out.len() / 2) as f32 / frames.max(1) as f32) {
            return Ok(None);
        }
        let step = clip.render_next(STEP);
        if step.is_empty() {
            break;
        }
        out.extend(step);
    }
    let file = format.encode(&out, request.sample_rate)?;
    progress(1.0);
    Ok(Some(file))
}

/// An Engine that isn't playing live, brought to what `commands` say about
/// the Project through the live host's own handling, so the file is what
/// plays. Commands for the keyboard, recording and the transport mean
/// nothing to an offline render and are left out.
pub fn offline_renderer(sample_rate: u32, commands: &[EngineCommand]) -> Renderer {
    let about_the_project = commands.iter().filter(|command| {
        !matches!(
            command,
            EngineCommand::NoteOn { .. }
                | EngineCommand::NoteOff { .. }
                | EngineCommand::SetPatternPlaying { .. }
                | EngineCommand::SetLatencyTest { .. }
                | EngineCommand::SetLiveTrack { .. }
                | EngineCommand::SetRecording { .. }
                | EngineCommand::Play
                | EngineCommand::Stop
                | EngineCommand::Seek { .. }
                | EngineCommand::SetLoop { .. }
                | EngineCommand::SetPlayRange { .. }
                | EngineCommand::SetMetronome { .. }
                // The DJ Mixer is never in an export of the song (ADR 0013).
                | EngineCommand::DjSet { .. }
        )
    });
    offline(sample_rate as f32, about_the_project.cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEAT: f64 = soundcheck_engine::TICKS_PER_BEAT as f64;

    /// A Synth and a Drum Sampler playing a bar, as the UI sends it.
    fn request(bits: u32, sample_rate: u32) -> ExportRequest {
        let commands = serde_json::from_str(
            r#"[
                {"type":"setTempo","bpm":120},
                {"type":"setTimeSignature","beatsPerBar":4,"beatUnit":4},
                {"type":"setTrackCount","count":2},
                {"type":"setTrackNotes","track":0,"notes":[0,960,60,1,960,960,64,0.8]},
                {"type":"setTrackInstrument","track":1,"instrument":"drumSampler","pads":8},
                {"type":"setTrackNotes","track":1,"notes":[0,120,36,1,960,120,38,1]},
                {"type":"setTrackMixer","track":1,"volume":0.8,"pan":-0.3,"mute":false,"solo":false},
                {"type":"setMasterVolume","volume":0.9}
            ]"#,
        )
        .unwrap();
        ExportRequest {
            commands,
            start_tick: 0.0,
            end_tick: 4.0 * BEAT,
            sample_rate,
            encoding: Encoding::Wav { bits },
        }
    }

    /// The Engine the request describes, rendered offline to `end` ticks.
    fn offline_render(request: &ExportRequest, end: f64) -> Vec<f32> {
        offline_renderer(request.sample_rate, &request.commands)
            .engine_mut()
            .render_range(request.start_tick, end)
    }

    /// A WAV's data chunk, and its sample rate.
    fn data_of(wav: &[u8]) -> (&[u8], u32) {
        let rate = u32::from_le_bytes(wav[24..28].try_into().unwrap());
        let at = wav.windows(4).position(|id| id == b"data").unwrap();
        (&wav[at + 8..], rate)
    }

    #[test]
    fn the_file_is_the_offline_render_sample_for_sample() {
        let request = request(32, 48_000);
        let wav = render_mix(&request, |_| true).unwrap().unwrap();
        let (data, rate) = data_of(&wav);
        assert_eq!(rate, 48_000);
        let exported: Vec<f32> = data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect();

        // The bar, then its tail: a longer render of the same song.
        let range = 4 * 24_000 * 2;
        assert!(exported.len() > range, "the tail is in the file");
        assert!(exported.len() <= range + (TAIL_SECONDS * 48_000.0) as usize * 2);
        let render = offline_render(&request, 40.0 * BEAT);
        assert_eq!(exported[..], render[..exported.len()]);
    }

    /// A 32-bit float WAV's samples, interleaved.
    fn samples_of(wav: &[u8]) -> Vec<f32> {
        let (data, _) = data_of(wav);
        data.as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect()
    }

    fn peak(samples: &[f32]) -> f32 {
        samples
            .iter()
            .fold(0.0, |max, sample| max.max(sample.abs()))
    }

    #[test]
    fn the_file_plays_audio_clips_through_the_insert_chains() {
        const TONE: &[u8] = include_bytes!("../../engine/tests/fixtures/tone.wav");
        // The quarter-second tone from beat 2 of an Audio Track, as the UI
        // sends it, then with `effects` added.
        let export = |effects: &[EngineCommand]| {
            let mut commands = vec![
                EngineCommand::SetTempo { bpm: 120.0 },
                EngineCommand::SetTrackCount { count: 1 },
                EngineCommand::SetTrackAudio {
                    track: 0,
                    audio: true,
                },
                EngineCommand::LoadAudioFile {
                    file: 1,
                    bytes: TONE.to_vec(),
                },
                EngineCommand::SetTrackAudioClips {
                    track: 0,
                    clips: vec![BEAT, BEAT, 1.0, 0.0],
                },
            ];
            commands.extend_from_slice(effects);
            let request = ExportRequest {
                commands,
                start_tick: 0.0,
                end_tick: 4.0 * BEAT,
                sample_rate: 48_000,
                encoding: Encoding::Wav { bits: 32 },
            };
            samples_of(&render_mix(&request, |_| true).unwrap().unwrap())
        };
        // An EQ whose low shelf takes 18 dB off everything.
        let eq = |chain| {
            [
                EngineCommand::InsertEffect {
                    chain,
                    index: 0,
                    effect: "eq".to_string(),
                },
                EngineCommand::SetEffectSettings {
                    chain,
                    index: 0,
                    settings: vec![0.0, 30.0, 20_000.0, -18.0],
                },
            ]
        };

        // At 120 BPM a beat is 24,000 frames: silence until the Clip starts.
        let dry = export(&[]);
        assert_eq!(peak(&dry[..2 * 24_000]), 0.0);
        assert!(peak(&dry[2 * 24_000..2 * 48_000]) > 0.1);

        assert!(peak(&export(&eq(0))) < peak(&dry) / 4.0, "the Track's EQ");
        assert!(peak(&export(&eq(-1))) < peak(&dry) / 4.0, "the Master's EQ");
        let mut bypassed = eq(-1).to_vec();
        bypassed.push(EngineCommand::SetEffectBypassed {
            chain: -1,
            index: 0,
            bypassed: true,
        });
        assert_eq!(export(&bypassed), dry);
    }

    /// A quarter-second tone recorded at 44.1 kHz while beat 2 played, placed
    /// and saved as a 24-bit WAV exactly as `audio_record_stop` saves a take.
    fn recorded_take() -> (u64, Vec<u8>) {
        use soundcheck_engine::{PlaybackAnchor, SampleFormat, place_recording, wav_bytes};
        let rate = 44_100;
        let samples: Vec<f32> = (0..rate / 4)
            .flat_map(|i| {
                let value = 0.5 * (std::f32::consts::TAU * 440.0 * i as f32 / rate as f32).sin();
                [value, value]
            })
            .collect();
        // The transport was at the top of the song ten seconds in, moving at
        // 120 BPM, and the take's first frame came in half a second later.
        let anchor = PlaybackAnchor {
            seconds: 10.0,
            tick: 0.0,
            ticks_per_second: 2.0 * BEAT,
        };
        let placed = place_recording(&samples, rate, 10.5, anchor, 0.0).unwrap();
        let wav = wav_bytes(&placed.samples, rate, SampleFormat::Int24);
        (placed.start_tick, wav)
    }

    #[test]
    fn the_file_plays_a_recorded_take_through_its_effects() {
        let (start_tick, take) = recorded_take();
        assert_eq!(start_tick as f64, BEAT);
        let export = |effects: &[EngineCommand]| {
            let mut commands = vec![
                EngineCommand::SetTempo { bpm: 120.0 },
                EngineCommand::SetTrackCount { count: 1 },
                EngineCommand::SetTrackAudio {
                    track: 0,
                    audio: true,
                },
                EngineCommand::LoadAudioFile {
                    file: 1,
                    bytes: take.clone(),
                },
                EngineCommand::SetTrackAudioClips {
                    track: 0,
                    clips: vec![start_tick as f64, 0.25, 1.0, 0.0],
                },
            ];
            commands.extend_from_slice(effects);
            let request = ExportRequest {
                commands,
                start_tick: 0.0,
                end_tick: 4.0 * BEAT,
                sample_rate: 48_000,
                encoding: Encoding::Wav { bits: 32 },
            };
            samples_of(&render_mix(&request, |_| true).unwrap().unwrap())
        };
        let effect = |chain, name: &str, settings: Vec<f32>| {
            [
                EngineCommand::InsertEffect {
                    chain,
                    index: 0,
                    effect: name.to_string(),
                },
                EngineCommand::SetEffectSettings {
                    chain,
                    index: 0,
                    settings,
                },
            ]
        };
        // Threshold, ratio, attack, release, makeup, knee: 20:1 from -40 dB.
        let compressor =
            |chain| effect(chain, "compressor", vec![-40.0, 20.0, 0.1, 50.0, 0.0, 0.0]);
        // Size, decay, damping, pre-delay, width, mix.
        let reverb = |chain, mix| effect(chain, "reverb", vec![0.5, 2.0, 0.5, 0.0, 1.0, mix]);
        // Sync, note, time, feedback, high cut, ping-pong, mix: only the
        // repeats, one a quarter note on.
        let delay = |chain| {
            effect(
                chain,
                "delay",
                vec![1.0, 7.0, 250.0, 0.0, 20_000.0, 0.0, 1.0],
            )
        };
        // Beats 3 and 4, after the take has ended.
        let after = |samples: &[f32]| peak(&samples[2 * 48_000..2 * 96_000]);

        // At 120 BPM a beat is 24,000 frames: the take plays in beat 2 only.
        let dry = export(&[]);
        assert_eq!(peak(&dry[..2 * 24_000]), 0.0);
        assert!(peak(&dry[2 * 24_000..2 * 48_000]) > 0.1);
        assert_eq!(after(&dry), 0.0);

        for chain in [0, -1] {
            let squashed = export(&compressor(chain));
            assert!(
                peak(&squashed) < peak(&dry) / 4.0,
                "the Compressor on {chain}"
            );
            let wet = export(&reverb(chain, 1.0));
            assert!(after(&wet) > 1e-3, "the Reverb's tail on {chain}");
            assert_eq!(
                export(&reverb(chain, 0.0)),
                dry,
                "a Reverb with no mix on {chain}"
            );
            // The take, a beat later: beat 3 is beat 2 again.
            let echoed = export(&delay(chain));
            assert_eq!(peak(&echoed[..2 * 48_000]), 0.0, "the Delay on {chain}");
            assert!(
                (peak(&echoed[2 * 48_000..2 * 72_000]) - peak(&dry)).abs() < 0.05,
                "the Delay's repeat on {chain}"
            );
        }
    }

    #[test]
    fn a_tempo_change_is_in_the_file_as_it_plays() {
        // The bar at 120, then a synced Delay on the Master and a note on
        // every beat of a bar of 3/4 at 60, as the UI sends a Tempo Change.
        let mut request = request(32, 48_000);
        request.commands.extend(
            serde_json::from_str::<Vec<EngineCommand>>(
                r#"[
                    {"type":"setTempoChanges","changes":[3840,60,3,4]},
                    {"type":"setTrackNotes","track":0,"notes":[0,960,60,1,3840,240,60,1,4800,240,64,1,5760,240,67,1]},
                    {"type":"insertEffect","chain":-1,"index":0,"effect":"delay"},
                    {"type":"setEffectSettings","chain":-1,"index":0,"settings":[1,7,250,0.3,8000,0,0.5]}
                ]"#,
            )
            .unwrap(),
        );
        request.end_tick = 4.0 * BEAT + 3.0 * BEAT;
        let exported = samples_of(&render_mix(&request, |_| true).unwrap().unwrap());

        // 2 s at 120, then 3 s at 60.
        let range = (2 + 3) * 48_000;
        let mut renderer = offline_renderer(48_000, &request.commands);
        let engine = renderer.engine_mut();
        engine.play();
        let mut played = Vec::new();
        while played.len() < range * 2 {
            engine.render(256);
            for (l, r) in engine.left()[..256].iter().zip(&engine.right()[..256]) {
                played.extend([*l, *r]);
            }
        }
        played.truncate(range * 2);
        assert!(exported.len() > range * 2, "the tail is in the file");
        assert!(played == exported[..range * 2], "the file is what plays");
        assert!(peak(&played[4 * 48_000 * 2..]) > 0.05, "bar 2 is heard");
    }

    #[test]
    fn automation_is_in_the_file_as_it_plays() {
        // Track 0 fades out over the first two beats and the Master holds at
        // half, then steps to silence at beat 3, as the UI sends Automation.
        let mut request = request(32, 48_000);
        request.commands.extend(
            serde_json::from_str::<Vec<EngineCommand>>(
                r#"[
                    {"type":"setAutomation","target":0,"setting":"volume","points":[0,1,0,1920,0,0]},
                    {"type":"setAutomation","target":1,"setting":"pan","points":[0,-1,0,3840,1,0]},
                    {"type":"setAutomation","target":-1,"setting":"volume","points":[0,0.5,1,2880,0,0]}
                ]"#,
            )
            .unwrap(),
        );
        let exported = samples_of(&render_mix(&request, |_| true).unwrap().unwrap());

        let range = 2 * 48_000;
        let mut renderer = offline_renderer(48_000, &request.commands);
        let engine = renderer.engine_mut();
        engine.play();
        let mut played = Vec::new();
        while played.len() < range * 2 {
            engine.render(300);
            for (l, r) in engine.left()[..300].iter().zip(&engine.right()[..300]) {
                played.extend([*l, *r]);
            }
        }
        played.truncate(range * 2);
        let first = played.iter().zip(&exported).position(|(a, b)| a != b);
        assert_eq!(first, None, "{:?}", first.map(|i| (played[i], exported[i])));
        assert!(peak(&played[..72_000 * 2]) > 0.01, "heard before beat 3");
        assert_eq!(peak(&exported[72_000 * 2..]), 0.0, "silent from beat 3");
    }

    #[test]
    fn sends_are_in_the_file_as_they_play() {
        // Both Tracks send to one Reverb, and the Synth's fader fades under
        // Automation, so its Send fades with it.
        let mut request = request(32, 48_000);
        let dry = samples_of(&render_mix(&request, |_| true).unwrap().unwrap());
        request.commands.extend(
            serde_json::from_str::<Vec<EngineCommand>>(
                r#"[
                    {"type":"setBusCount","count":1},
                    {"type":"insertEffect","chain":-2,"index":0,"effect":"reverb"},
                    {"type":"setSends","channel":0,"sends":[0,0.8]},
                    {"type":"setSends","channel":1,"sends":[0,0.4]},
                    {"type":"setAutomation","target":0,"setting":"volume","points":[0,1,0,1920,0,0]}
                ]"#,
            )
            .unwrap(),
        );
        let exported = samples_of(&render_mix(&request, |_| true).unwrap().unwrap());

        let range = 2 * 48_000;
        let mut renderer = offline_renderer(48_000, &request.commands);
        let engine = renderer.engine_mut();
        engine.play();
        let mut played = Vec::new();
        while played.len() < range * 2 {
            engine.render(300);
            for (l, r) in engine.left()[..300].iter().zip(&engine.right()[..300]) {
                played.extend([*l, *r]);
            }
        }
        played.truncate(range * 2);
        let first = played.iter().zip(&exported).position(|(a, b)| a != b);
        assert_eq!(first, None, "{:?}", first.map(|i| (played[i], exported[i])));
        assert!(
            exported[..range * 2] != dry[..range * 2],
            "the Reverb is heard"
        );
    }

    #[test]
    fn live_commands_leave_the_file_alone() {
        let quiet = request(32, 48_000);
        let mut live = quiet.clone();
        live.commands.extend([
            EngineCommand::NoteOn {
                note: 72,
                velocity: 1.0,
            },
            EngineCommand::Seek { tick: 2.0 * BEAT },
            EngineCommand::SetMetronome { on: true },
        ]);
        assert_eq!(render_mix(&live, |_| true), render_mix(&quiet, |_| true));
    }

    #[test]
    fn integer_files_are_the_render_rounded_to_the_nearest_step() {
        let request = request(16, 44_100);
        let wav = render_mix(&request, |_| true).unwrap().unwrap();
        let (data, rate) = data_of(&wav);
        assert_eq!(rate, 44_100);
        let render = offline_render(&request, 40.0 * BEAT);
        let samples = data.as_chunks::<2>().0;
        assert!(samples.len() > 4 * 22_050 * 2 && samples.len() < render.len());
        for (bytes, sample) in samples.iter().zip(&render) {
            let value = i16::from_le_bytes(*bytes);
            let expected = (sample * 32_768.0).round().clamp(-32_768.0, 32_767.0) as i16;
            assert_eq!(value, expected);
        }
    }

    #[test]
    fn progress_rises_to_one() {
        let mut reports = Vec::new();
        render_mix(&request(24, 48_000), |progress| {
            reports.push(progress);
            true
        })
        .unwrap();
        assert_eq!(reports.first(), Some(&0.0));
        assert_eq!(reports.last(), Some(&1.0));
        assert!(reports.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn cancelling_stops_the_render() {
        let job = ExportJob::default();
        job.cancel();
        assert_eq!(job.render(&request(16, 48_000)), Ok(None));
    }

    #[test]
    fn a_job_reports_how_far_it_has_got() {
        let job = ExportJob::default();
        assert!(job.render(&request(16, 48_000)).unwrap().is_some());
        assert_eq!(job.progress(), 1.0);
    }

    #[test]
    fn only_the_offered_formats_export() {
        assert!(render_mix(&request(8, 48_000), |_| true).is_err());
        assert!(render_mix(&request(16, 22_050), |_| true).is_err());
        let mp3 = ExportRequest {
            encoding: Encoding::Mp3 { kbps: 96 },
            ..request(16, 48_000)
        };
        assert!(render_mix(&mp3, |_| true).is_err());
    }

    #[test]
    fn an_mp3_is_the_offline_render_encoded() {
        let request = ExportRequest {
            encoding: Encoding::Mp3 { kbps: 192 },
            ..request(16, 48_000)
        };
        let mp3 = render_mix(&request, |_| true).unwrap().unwrap();
        let wav = samples_of(
            &render_mix(
                &ExportRequest {
                    encoding: Encoding::Wav { bits: 32 },
                    ..request
                },
                |_| true,
            )
            .unwrap()
            .unwrap(),
        );
        // Its length, then its loudest sample.
        let summary = soundcheck_engine::audio_file_summary(&mp3, 1).unwrap();
        let seconds = wav.len() as f32 / 2.0 / 48_000.0;
        // The encoder pads to whole frames and adds its own delay.
        assert!(
            (seconds..seconds + 0.1).contains(&summary[0]),
            "{} s",
            summary[0]
        );
        assert!(
            (summary[1] - peak(&wav)).abs() < 0.1 * peak(&wav),
            "{} against {}",
            summary[1],
            peak(&wav)
        );
    }

    #[test]
    fn the_request_reads_the_json_the_ui_sends() {
        let request: ExportRequest = serde_json::from_str(
            r#"{"commands":[{"type":"setTempo","bpm":90}],"startTick":0,"endTick":1920,"sampleRate":44100,"encoding":{"kind":"wav","bits":24}}"#,
        )
        .unwrap();
        assert_eq!(request.commands, [EngineCommand::SetTempo { bpm: 90.0 }]);
        assert_eq!(
            (request.end_tick, request.sample_rate, request.encoding),
            (1_920.0, 44_100, Encoding::Wav { bits: 24 })
        );
        let mp3: ExportRequest = serde_json::from_str(
            r#"{"commands":[],"startTick":0,"endTick":1920,"sampleRate":48000,"encoding":{"kind":"mp3","kbps":320}}"#,
        )
        .unwrap();
        assert_eq!(mp3.encoding, Encoding::Mp3 { kbps: 320 });
    }

    const TONE: &[u8] = include_bytes!("../../engine/tests/fixtures/tone.wav");

    /// The tone's Clip trimmed to 0.1 s from 0.05 s in.
    fn clip_request(sample_rate: u32, encoding: Encoding) -> ClipExportRequest {
        ClipExportRequest {
            file_offset: 0.05,
            duration: 0.1,
            sample_rate,
            encoding,
        }
    }

    #[test]
    fn a_trimmed_clip_at_its_files_rate_is_its_stretch_sample_for_sample() {
        let request = clip_request(44_100, Encoding::Wav { bits: 32 });
        let wav = render_clip(TONE, &request, |_| true).unwrap().unwrap();
        assert_eq!(data_of(&wav).1, 44_100);
        let file = soundcheck_engine::PreparedAudioFile::decode(TONE, 44_100.0).unwrap();
        let stretch: Vec<f32> = (2_205..6_615)
            .flat_map(|frame| [file.left()[frame], file.right()[frame]])
            .collect();
        assert_eq!(samples_of(&wav), stretch);
    }

    #[test]
    fn a_clip_exports_at_each_bit_depth_and_rate() {
        for sample_rate in SAMPLE_RATES {
            for bits in [16, 24, 32] {
                let request = clip_request(sample_rate, Encoding::Wav { bits });
                let wav = render_clip(TONE, &request, |_| true).unwrap().unwrap();
                let (data, rate) = data_of(&wav);
                assert_eq!(rate, sample_rate);
                let frames = sample_rate as usize / 10;
                assert_eq!(data.len(), frames * 2 * bits as usize / 8, "{bits}-bit");
            }
        }
    }

    #[test]
    fn a_clip_exports_as_mp3_at_each_bitrate() {
        for kbps in soundcheck_engine::MP3_BITRATES {
            let request = clip_request(48_000, Encoding::Mp3 { kbps });
            let mp3 = render_clip(TONE, &request, |_| true).unwrap().unwrap();
            let summary = soundcheck_engine::audio_file_summary(&mp3, 1).unwrap();
            // The encoder pads to whole frames and adds its own delay.
            assert!(
                (0.1..0.2).contains(&summary[0]),
                "{kbps} kbps: {} s",
                summary[0]
            );
            // The tone's left side peaks at half scale.
            assert!(
                (summary[1] - 0.5).abs() < 0.05,
                "{kbps} kbps: {}",
                summary[1]
            );
        }
    }

    #[test]
    fn cancelling_a_clip_export_gives_no_file() {
        let request = clip_request(48_000, Encoding::Wav { bits: 24 });
        let job = ExportJob::default();
        job.cancel();
        assert_eq!(job.render_clip(TONE, &request), Ok(None));
        // Cancelled part way.
        let mut reports = 0;
        let cancelled = render_clip(TONE, &request, |_| {
            reports += 1;
            reports < 2
        });
        assert_eq!(cancelled, Ok(None));
    }

    #[test]
    fn a_clip_job_reports_how_far_it_has_got() {
        let job = ExportJob::default();
        let request = clip_request(48_000, Encoding::Wav { bits: 16 });
        assert!(job.render_clip(TONE, &request).unwrap().is_some());
        assert_eq!(job.progress(), 1.0);
    }

    #[test]
    fn a_clip_exports_only_in_the_offered_formats_and_from_audio() {
        let bad = [
            clip_request(22_050, Encoding::Wav { bits: 16 }),
            clip_request(48_000, Encoding::Wav { bits: 8 }),
            clip_request(48_000, Encoding::Mp3 { kbps: 96 }),
        ];
        for request in bad {
            assert!(
                render_clip(TONE, &request, |_| true).is_err(),
                "{request:?}"
            );
        }
        let request = clip_request(48_000, Encoding::Wav { bits: 16 });
        assert_eq!(
            render_clip(b"not audio", &request, |_| true),
            Err("This isn't a WAV, FLAC or MP3 file".into())
        );
    }

    #[test]
    fn the_clip_request_reads_the_json_the_ui_sends() {
        let request: ClipExportRequest = serde_json::from_str(
            r#"{"fileOffset":1.5,"duration":2,"sampleRate":44100,"encoding":{"kind":"mp3","kbps":256}}"#,
        )
        .unwrap();
        assert_eq!(
            request,
            ClipExportRequest {
                file_offset: 1.5,
                duration: 2.0,
                sample_rate: 44_100,
                encoding: Encoding::Mp3 { kbps: 256 },
            }
        );
    }

    #[test]
    fn a_clip_body_is_its_json_then_the_audio() {
        let json = br#"{"path":"C:\\M\u00fasica\\vocals.wav","request":{"fileOffset":0,"duration":1,"sampleRate":48000,"encoding":{"kind":"wav","bits":24}}}"#;
        let mut body = (json.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(json);
        body.extend_from_slice(b"RIFF");
        let (export, audio) = read_clip_body(&body).unwrap();
        assert_eq!(export.path, "C:\\Música\\vocals.wav");
        assert_eq!(export.request.encoding, Encoding::Wav { bits: 24 });
        assert_eq!(audio, b"RIFF");
        assert!(read_clip_body(&body[..10]).is_err());
        assert!(read_clip_body(&[1, 0]).is_err());
    }
}
