/**
 * The browser dev host: the Audio Engine's WASM build in an AudioWorklet,
 * playing to the browser's audio output.
 */
// The raw module: compiled here and handed to the worklet, which can't fetch.
import wasmUrl from "../../../engine/pkg/soundcheck_engine_bg.wasm?url";

import init, { dj_prepare } from "@engine";

import type {
  AudioOutput,
  AudioOutputOptions,
  AudioOutputStats,
  DjAnalysis,
  EngineCommand,
  EngineReport,
  Meters,
  RecordedNoteEvent,
  UnderrunStats,
} from "./audio-output";
import type { DjLoadMessage, ProcessorMessage, ProcessorOptions } from "./engine-processor";
// Vite bundles the processor and gives back its URL; oxlint can't see that.
// oxlint-disable-next-line import/default
import processorUrl from "./engine-processor.ts?worker&url";

/**
 * `AudioContext.playbackStats`, newer than TypeScript's DOM library. Chrome
 * also has it under its old name, `playoutStats`.
 */
interface PlaybackStats {
  underrunEvents: number;
  underrunDuration: number;
  averageLatency: number;
  minimumLatency: number;
  maximumLatency: number;
}
type ContextWithStats = AudioContext & {
  playbackStats?: PlaybackStats;
  playoutStats?: PlaybackStats;
  renderQuantumSize?: number;
};

const READY_TIMEOUT_MS = 10_000;

/** Flat tick, pitch, velocity and note-on flag, as the engine logs them. */
function recordedNotes(flat: Float64Array): RecordedNoteEvent[] {
  const notes: RecordedNoteEvent[] = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    notes.push({
      tick: flat[i]!,
      pitch: flat[i + 1]!,
      velocity: flat[i + 2]!,
      on: flat[i + 3] !== 0,
    });
  }
  return notes;
}

export async function openWorkletAudioOutput(options: AudioOutputOptions): Promise<AudioOutput> {
  const context: ContextWithStats = new AudioContext({ latencyHint: options.latencyHint ?? "interactive" });
  try {
    const [module] = await Promise.all([
      fetch(wasmUrl)
        .then((response) => response.arrayBuffer())
        .then((bytes) => WebAssembly.compile(bytes)),
      context.audioWorklet.addModule(processorUrl),
    ]);

    const processorOptions: ProcessorOptions = { module, trackCount: options.trackCount };
    // Four channels where the device has them, so the DJ Mixer's headphone
    // cue can go out of outputs 3 and 4 (ADR 0013); two otherwise.
    const channels = context.destination.maxChannelCount >= 4 ? 4 : 2;
    if (channels === 4) {
      context.destination.channelCount = 4;
      context.destination.channelCountMode = "explicit";
      context.destination.channelInterpretation = "discrete";
    }
    const node = new AudioWorkletNode(context, "engine", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      // Always four: the cue is on the third and fourth, for outputs 3 and 4
      // or for a second device (`headphone-output.ts`).
      outputChannelCount: [4],
      channelInterpretation: "discrete",
      processorOptions,
    });

    let engine: EngineReport | null = null;
    let meters: Meters | null = null;
    let recorded: RecordedNoteEvent[] = [];
    let dj: number[] | null = null;
    let djRecording: Float32Array[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("The Audio Engine didn't start in the AudioWorklet")),
        READY_TIMEOUT_MS,
      );
      node.addEventListener("processorerror", () => {
        clearTimeout(timeout);
        reject(new Error("The Audio Engine failed in the AudioWorklet"));
      });
      node.port.addEventListener("message", (event: MessageEvent<ProcessorMessage>) => {
        const message = event.data;
        if (message.type === "ready") {
          clearTimeout(timeout);
          resolve();
        } else {
          const { type: _, meters: latest, recorded: played, dj: mixer, djRecording: mix, ...report } = message;
          engine = report;
          meters = latest;
          if (mixer) dj = Array.from(mixer);
          if (mix && mix.length > 0) djRecording.push(mix);
          if (played.length > 0) recorded = recorded.concat(recordedNotes(played));
        }
      });
      node.port.start();
    });

    // The Master (and, on a four-channel device, the cue) to the output; the
    // cue alone to a stream a second device can play.
    const split = context.createChannelSplitter(4);
    const main = context.createChannelMerger(channels);
    const cue = context.createChannelMerger(2);
    const cueStream = context.createMediaStreamDestination();
    node.connect(split);
    for (let channel = 0; channel < channels; channel++) split.connect(main, channel, channel);
    split.connect(cue, 2, 0);
    split.connect(cue, 3, 1);
    main.connect(context.destination);
    cue.connect(cueStream);
    await context.resume();

    const platformStats = () => context.playbackStats ?? context.playoutStats;
    let underrunsAtReset = { events: 0, duration: 0 };

    return {
      send(command: EngineCommand) {
        // A MessagePort, not a window: there is no target origin to give.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        node.port.postMessage(command);
      },

      stats(): AudioOutputStats {
        const platform = platformStats();
        const underruns: UnderrunStats | null = platform
          ? {
              events: platform.underrunEvents - underrunsAtReset.events,
              duration: platform.underrunDuration - underrunsAtReset.duration,
              averageLatency: platform.averageLatency,
              minimumLatency: platform.minimumLatency,
              maximumLatency: platform.maximumLatency,
            }
          : null;
        return {
          host: "Browser AudioWorklet",
          sampleRate: context.sampleRate,
          blockFrames: context.renderQuantumSize ?? 128,
          requestedBufferFrames: null,
          baseLatency: context.baseLatency,
          outputLatency: context.outputLatency,
          underruns,
          callbacks: null,
          engine,
          meters,
          dj,
        };
      },

      currentTime: () => context.currentTime,

      takeRecordedNotes(): RecordedNoteEvent[] {
        const notes = recorded;
        recorded = [];
        return notes;
      },

      resetCounters() {
        const platform = platformStats();
        underrunsAtReset = platform
          ? { events: platform.underrunEvents, duration: platform.underrunDuration }
          : underrunsAtReset;
      },

      async close() {
        node.disconnect();
        split.disconnect();
        main.disconnect();
        cue.disconnect();
        await context.close();
      },

      dj: {
        async load(deck: number, bytes: Uint8Array): Promise<DjAnalysis> {
          // Decoding and analysing a whole track would stall the audio
          // thread, so the page's own copy of the engine does it (ADR 0013).
          await init({ module_or_path: module });
          const prepared = dj_prepare(bytes, context.sampleRate);
          try {
            const message: DjLoadMessage = {
              type: "djLoad",
              deck,
              left: prepared.left(),
              right: prepared.right(),
              bpm: prepared.bpm(),
              firstBeat: prepared.first_beat(),
            };
            const analysis = JSON.parse(prepared.analysis()) as DjAnalysis;
            // A MessagePort, not a window: there is no target origin to give.
            // oxlint-disable-next-line unicorn/require-post-message-target-origin
            node.port.postMessage(message, [message.left!.buffer, message.right!.buffer]);
            return analysis;
          } finally {
            prepared.free();
          }
        },
        unload(deck: number) {
          const message: DjLoadMessage = { type: "djLoad", deck, left: null, right: null, bpm: 0, firstBeat: 0 };
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          node.port.postMessage(message);
        },
        async takeRecording(): Promise<Float32Array> {
          const chunks = djRecording;
          djRecording = [];
          const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
          let at = 0;
          for (const chunk of chunks) {
            out.set(chunk, at);
            at += chunk.length;
          }
          return out;
        },
        headphones: channels >= 4,
        headphoneStream: () => cueStream.stream,
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
