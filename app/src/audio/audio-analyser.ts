/**
 * Audio Analysis: render part of the Project offline, on an engine of its
 * own, and measure it (#24's measurements). This is how the Assistant
 * listens, since Claude's API takes no audio; a model that takes audio can
 * hear the render too, encoded as `LISTENING` says.
 *
 * The Project arrives as the `EngineCommand`s that bring a fresh engine to
 * it, the same ones `EngineSync` sends the engine that plays, so what is
 * analysed is exactly what the musician hears. The playing engine is left
 * alone: nothing it is doing stops or changes.
 */
import init, { Engine } from "@engine";

import { WasmPluginHost } from "../plugin/wasm-plugin-runtime";
import { applyEngineCommand } from "./apply-engine-command";
import type { EngineCommand } from "./audio-output";
import { forShell, type Invoke } from "./desktop-audio-output";
import { LISTENING } from "./listening";

/** What to analyse. Positions are in ticks from the start of the song. */
export interface AnalysisRange {
  start: number;
  end: number;
  /** One engine Track on its own, by index, or null for the whole mix. */
  track: number | null;
  /** Also draw a spectrogram of the same render. Left out, no picture. */
  spectrogram?: boolean;
  /** Also encode the same render as audio, as `LISTENING` says. Left out, no audio. */
  audio?: boolean;
}

/** A render as the model hears it. */
export interface HeardAudio {
  /** The WAV file, base64-encoded. */
  data: string;
  /** How long it is: the range, or `LISTENING.maxSeconds` if that is shorter. */
  seconds: number;
}

/** What an analysis resolves to. */
export interface Analysed {
  /** The measurements, as the engine's compact JSON. */
  measurements: string;
  /**
   * When asked for, a spectrogram of the same render, with the waveform
   * above it, labelled in bars and hertz: a base64 PNG, as Claude's image
   * input takes it.
   */
  spectrogram?: string;
  /** When asked for, the same render as audio. */
  audio?: HeardAudio;
}

export type AnalyseAudio = (commands: readonly EngineCommand[], range: AnalysisRange) => Promise<Analysed>;

/** The rate the analysis renders at. The measurements don't depend on it. */
const SAMPLE_RATE = 48_000;

/** On the desktop, in the Rust process, off both the audio and UI threads. */
export function desktopAudioAnalyser(invoke: Invoke): AnalyseAudio {
  return async (commands, { start, end, track, spectrogram = false, audio = false }) => {
    const analysed = await invoke<{ measurements: string; spectrogram: string | null; audio: string | null; audioSeconds: number }>(
      "audio_analyse",
      {
        commands: commands.map(forShell),
        start,
        end,
        track,
        spectrogram,
        audio: audio ? { sampleRate: LISTENING.sampleRate, maxSeconds: LISTENING.maxSeconds } : null,
      },
    );
    return attached(analysed.measurements, analysed.spectrogram, analysed.audio, analysed.audioSeconds);
  };
}

/**
 * In the browser, on the main thread: the page stops responding until the
 * render is done, which the dev host can live with. `load` makes sure the
 * WASM build is ready; tests that have loaded it already pass a no-op.
 */
export function wasmAudioAnalyser(load: () => Promise<unknown> = init): AnalyseAudio {
  return async (commands, { start, end, track, spectrogram = false, audio = false }) => {
    await load();
    const engine = new Engine(SAMPLE_RATE);
    try {
      const plugins = new WasmPluginHost(SAMPLE_RATE);
      for (const command of commands) applyEngineCommand(engine, command, plugins);
      if (!spectrogram && !audio) return { measurements: engine.analyse(start, end, track ?? -1) };
      // A rate of 0 asks for no audio.
      const rate = audio ? LISTENING.sampleRate : 0;
      const analysed = engine.analyse_with(start, end, track ?? -1, spectrogram, rate, LISTENING.maxSeconds);
      try {
        return attached(analysed.measurements, analysed.spectrogram, analysed.audio, analysed.audio_seconds);
      } finally {
        analysed.free();
      }
    } finally {
      engine.free();
    }
  };
}

/** An analysis with only what came with it: none is left out, not null. */
function attached(measurements: string, spectrogram: string | null | undefined, audio: string | null | undefined, seconds: number): Analysed {
  return {
    measurements,
    ...(spectrogram != null && { spectrogram }),
    ...(audio != null && { audio: { data: audio, seconds } }),
  };
}
