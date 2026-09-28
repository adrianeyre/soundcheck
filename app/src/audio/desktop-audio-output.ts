/**
 * The desktop host: the Audio Engine runs natively in the Tauri process, on
 * the audio device through cpal (`desktop/src/audio.rs`). Commands go over
 * Tauri IPC; the figures come back the same way, a few times a second.
 */
import type {
  AudioOutput,
  AudioOutputStats,
  DjAnalysis,
  EngineCommand,
  EngineReport,
  Meters,
  OpenAudioOutput,
  RecordedNoteEvent,
} from "./audio-output";

/**
 * Tauri's `invoke`, or a stand-in for tests. Bytes on their own are sent as
 * the request's raw body rather than as JSON, for a command that reads it so.
 */
export type Invoke = <T>(command: string, args?: Record<string, unknown> | Uint8Array) => Promise<T>;

/** `OpenInfo` in `desktop/src/audio.rs`. */
interface OpenInfo {
  host: string;
  device: string;
  sampleRate: number;
  channels: number;
  requestedBufferFrames: number | null;
  grantedBufferFrames: number | null;
}

/** `Measured` in `desktop/src/stats.rs`. */
export interface Measured {
  callbacks: number;
  lateCallbacks: number;
  maxRenderSeconds: number;
  callbackFrames: number;
  framesPlayed: number;
  outputLatency: number | null;
  engine: EngineReport;
  meters: Meters;
  /** The DJ Mixer's report, or null before the Mixer page is used. */
  dj?: number[] | null;
}

const STATS_MS = 50;

export function desktopAudioOutput(invoke: Invoke): OpenAudioOutput {
  return async (options) => {
    const info = await invoke<OpenInfo>("audio_open", {
      options: {
        bufferFrames: options.bufferFrames ?? null,
        host: options.host ?? null,
        trackCount: options.trackCount,
      },
    });

    let measured = await invoke<Measured | null>("audio_stats");
    let measuredAt = performance.now();
    let recorded: RecordedNoteEvent[] = [];
    const poll = () =>
      Promise.all([
        invoke<Measured | null>("audio_stats").then((latest) => {
          measured = latest;
          measuredAt = performance.now();
        }),
        // Drained on the same beat as the figures, so nothing sits in the
        // engine's fixed-size log for long.
        invoke<RecordedNoteEvent[]>("audio_recorded_notes").then((notes) => {
          if (notes.length > 0) recorded = recorded.concat(notes);
        }),
      ])
        .then(() => {})
        .catch(() => {});
    const timer = setInterval(() => void poll(), STATS_MS);

    return {
      send(command: EngineCommand) {
        void invoke("audio_send", { command: forShell(command) }).catch(() => {});
      },

      stats(): AudioOutputStats {
        // Before the first callback, what the host says it granted.
        const blockFrames = measured?.callbackFrames || info.grantedBufferFrames || 0;
        return {
          host: `${info.host}: ${info.device}`,
          sampleRate: info.sampleRate,
          blockFrames,
          requestedBufferFrames: info.requestedBufferFrames,
          baseLatency: blockFrames / info.sampleRate,
          outputLatency: measured?.outputLatency ?? null,
          underruns: null,
          callbacks: measured
            ? {
                callbacks: measured.callbacks,
                late: measured.lateCallbacks,
                slowestRender: measured.maxRenderSeconds,
              }
            : null,
          engine: measured?.engine ?? null,
          meters: measured?.meters ?? null,
          dj: measured?.dj ?? null,
        };
      },

      currentTime() {
        if (!measured) return 0;
        return measured.framesPlayed / info.sampleRate + (performance.now() - measuredAt) / 1000;
      },

      takeRecordedNotes(): RecordedNoteEvent[] {
        const notes = recorded;
        recorded = [];
        return notes;
      },

      resetCounters() {
        void invoke("audio_reset_counters").then(poll);
      },

      async close() {
        clearInterval(timer);
        await invoke("audio_close");
      },

      dj: {
        async load(deck: number, bytes: Uint8Array): Promise<DjAnalysis> {
          return JSON.parse(await invoke<string>("dj_load", { deck, bytes: [...bytes] })) as DjAnalysis;
        },
        unload(deck: number) {
          void invoke("dj_unload", { deck }).catch(() => {});
        },
        async takeRecording(): Promise<Float32Array> {
          const bytes = await invoke<ArrayBuffer>("dj_recording_take");
          return new Float32Array(bytes);
        },
        // The cue goes out of outputs 3 and 4, which only a DJ interface has.
        headphones: info.channels >= 4,
      },
    } satisfies AudioOutput;
  };
}

/** The audio hosts the desktop can play through, e.g. WASAPI and ASIO. */
export function desktopAudioHosts(invoke: Invoke): () => Promise<string[]> {
  return () => invoke<string[]>("audio_hosts");
}

/**
 * A command as the Tauri shell reads it: a Plugin's bytes go as the list of
 * numbers it expects, not as the object JSON makes of a typed array.
 */
export function forShell(command: EngineCommand): unknown {
  return command.type === "loadPlugin" ? { ...command, wasm: [...command.wasm] } : command;
}
