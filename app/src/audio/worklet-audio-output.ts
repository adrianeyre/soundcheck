/**
 * The browser dev host: the Audio Engine's WASM build in an AudioWorklet,
 * playing to the browser's audio output.
 */
// The raw module: compiled here and handed to the worklet, which can't fetch.
import wasmUrl from "../../../engine/pkg/soundcheck_engine_bg.wasm?url";

import type {
  AudioOutput,
  AudioOutputOptions,
  AudioOutputStats,
  EngineCommand,
  EngineReport,
  Meters,
  RecordedNoteEvent,
  UnderrunStats,
} from "./audio-output";
import type { ProcessorMessage, ProcessorOptions } from "./engine-processor";
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
    const node = new AudioWorkletNode(context, "engine", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions,
    });

    let engine: EngineReport | null = null;
    let meters: Meters | null = null;
    let recorded: RecordedNoteEvent[] = [];
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
          const { type: _, meters: latest, recorded: played, ...report } = message;
          engine = report;
          meters = latest;
          if (played.length > 0) recorded = recorded.concat(recordedNotes(played));
        }
      });
      node.port.start();
    });

    node.connect(context.destination);
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
        await context.close();
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
