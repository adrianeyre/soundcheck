import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AudioOutput,
  AudioOutputOptions,
  AudioOutputStats,
  EngineCommand,
  LatencyHint,
  OpenAudioOutput,
} from "../audio/audio-output";
import type { OfflineRenderResult, RenderOffline } from "../audio/offline-render";
import { DEFAULT_OCTAVE, listenToComputerKeyboard } from "../keyboard/computer-keyboard";
import type { OpenMidiInput } from "../midi/midi-input";
import { barTicks, constantTempoMap } from "../project/time";
import { TransportBar } from "../transport/TransportBar";
import {
  DEFAULT_TRANSPORT,
  type TransportSettings,
  transportCommands,
} from "../transport/transport-settings";
import { FpsMeter, LONG_FRAME_MS } from "./fps-meter";
import { loadTestChains } from "./load-test-chain";

/**
 * Milestone 0's test page: N Tracks of Synth → EQ → Compressor → Reverb, a
 * live keyboard, and the numbers the latency spike needs.
 */

const DEFAULT_TRACKS = 16;
const TEST_NOTE = 60;
const STATS_MS = 250;
const PLAYHEAD_LOOP_SECONDS = 2;
const OFFLINE_SECONDS = 60;

/** The buffer the desktop asks for first: the MVP's target. */
const DEFAULT_BUFFER_FRAMES = 256;

const LATENCY_HINTS: { label: string; value: LatencyHint }[] = [
  { label: "interactive", value: "interactive" },
  { label: "balanced", value: "balanced" },
  { label: "playback", value: "playback" },
  { label: "5 ms", value: 0.005 },
  { label: "10 ms", value: 0.01 },
  { label: "20 ms", value: 0.02 },
];

interface PageStats {
  fps: number;
  longFrames: number;
  runningSeconds: number;
  output: AudioOutputStats;
}

export interface LoadTestPageProps {
  openOutput: OpenAudioOutput;
  openMidi: OpenMidiInput;
  renderOffline: RenderOffline;
  /**
   * Buffer sizes to choose from, where the platform lets you (the desktop).
   * Without them the page offers the browser's latency hints instead.
   */
  bufferSizes?: readonly number[] | null;
  /** The audio hosts to choose from, e.g. WASAPI and ASIO. */
  listAudioHosts?: (() => Promise<string[]>) | null;
  /** The host and buffer size to start on: the ones chosen in Settings. */
  initialHost?: string | null;
  initialBufferFrames?: number | null;
}

export function LoadTestPage({
  openOutput,
  openMidi,
  renderOffline,
  bufferSizes = null,
  listAudioHosts = null,
  initialHost = null,
  initialBufferFrames = null,
}: LoadTestPageProps) {
  const [hint, setHint] = useState(0);
  const [bufferFrames, setBufferFrames] = useState(() => {
    if (initialBufferFrames !== null && bufferSizes?.includes(initialBufferFrames)) return initialBufferFrames;
    return bufferSizes?.includes(DEFAULT_BUFFER_FRAMES) ? DEFAULT_BUFFER_FRAMES : (bufferSizes?.[0] ?? 0);
  });
  const [hosts, setHosts] = useState<string[]>([]);
  const [host, setHost] = useState<string | null>(initialHost);
  const [trackInput, setTrackInput] = useState(String(DEFAULT_TRACKS));
  const [patternPlaying, setPatternPlaying] = useState(true);
  const [latencyTest, setLatencyTest] = useState(false);
  const [output, setOutput] = useState<AudioOutput | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [midiStatus, setMidiStatus] = useState("Connecting to MIDI…");
  const [octave, setOctave] = useState(DEFAULT_OCTAVE);
  const [stats, setStats] = useState<PageStats | null>(null);
  // The pattern is one bar, so it starts out looping one bar.
  const [transport, setTransport] = useState<TransportSettings>({
    ...DEFAULT_TRANSPORT,
    loop: true,
  });
  const [offline, setOffline] = useState<OfflineRenderResult | "rendering" | null>(null);

  const outputRef = useRef<AudioOutput | null>(null);
  const fpsRef = useRef(new FpsMeter());
  const startedAtRef = useRef(0);
  const playheadRef = useRef<HTMLDivElement>(null);
  // How many of the engine's Tracks have been given the load-test chain.
  const chainedRef = useRef(0);

  const send = (command: EngineCommand) => outputRef.current?.send(command);

  useEffect(() => {
    listAudioHosts?.()
      .then(setHosts)
      .catch(() => setHosts([]));
  }, [listAudioHosts]);

  // MIDI keys go straight to the engine, whenever it is running.
  useEffect(() => {
    const opening = openMidi(
      (event) => outputRef.current?.send(event),
      (names) =>
        setMidiStatus(
          names.length ? `MIDI: ${names.join(", ")}` : "MIDI: no keyboard connected",
        ),
    );
    opening.catch((reason: unknown) => setMidiStatus(`MIDI unavailable: ${String(reason)}`));
    return () => void opening.then((midi) => midi.close()).catch(() => {});
  }, [openMidi]);

  // So does the computer keyboard, for when there is no MIDI keyboard.
  useEffect(
    () => listenToComputerKeyboard(window, (event) => outputRef.current?.send(event), setOctave),
    [],
  );

  // Frame counting and the playhead run every animation frame, outside React.
  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") return;
    let frame = requestAnimationFrame(function tick(timestamp) {
      fpsRef.current.frame(timestamp);
      const current = outputRef.current;
      if (current && playheadRef.current) {
        const position = (current.currentTime() % PLAYHEAD_LOOP_SECONDS) / PLAYHEAD_LOOP_SECONDS;
        playheadRef.current.style.transform = `translateX(${position * 100}%)`;
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // The numbers refresh a few times a second: often enough to read.
  useEffect(() => {
    if (!output) return;
    const refresh = () =>
      setStats({
        fps: fpsRef.current.fps,
        longFrames: fpsRef.current.longFrames,
        runningSeconds: (performance.now() - startedAtRef.current) / 1000,
        output: output.stats(),
      });
    refresh();
    const timer = setInterval(refresh, STATS_MS);
    return () => clearInterval(timer);
  }, [output]);

  // The engine's transport follows the transport bar's settings.
  useEffect(() => {
    if (!output) return;
    for (const command of transportCommands(transport)) output.send(command);
  }, [output, transport]);

  const readReport = useCallback(() => outputRef.current?.stats().engine ?? null, []);

  // Close the output if the page goes away while it is running.
  useEffect(() => () => void outputRef.current?.close(), []);

  const trackCount = () => Math.max(1, Math.round(Number(trackInput)) || DEFAULT_TRACKS);

  // New Tracks start with an empty Insert Chain, so each is given the
  // load-test chain as it appears; Tracks taken away take theirs with them.
  const applyTrackCount = () => {
    const count = trackCount();
    send({ type: "setTrackCount", count });
    if (!outputRef.current) return;
    for (const command of loadTestChains(chainedRef.current, count)) send(command);
    chainedRef.current = count;
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const options: AudioOutputOptions = bufferSizes
        ? { bufferFrames, ...(host ? { host } : {}), trackCount: trackCount() }
        : { latencyHint: LATENCY_HINTS[hint]?.value ?? "interactive", trackCount: trackCount() };
      const opened = await openOutput(options);
      outputRef.current = opened;
      for (const command of transportCommands(transport)) opened.send(command);
      for (const command of loadTestChains(0, trackCount())) opened.send(command);
      chainedRef.current = trackCount();
      opened.send({ type: "setPatternPlaying", playing: patternPlaying });
      opened.send({ type: "setLatencyTest", on: latencyTest });
      resetCounters();
      setOutput(opened);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    const current = outputRef.current;
    outputRef.current = null;
    setOutput(null);
    setStats(null);
    await current?.close();
  };

  const renderOfflineTest = async () => {
    setOffline("rendering");
    // Let "Rendering…" paint before the main thread is busy.
    await new Promise((resolve) => setTimeout(resolve, 50));
    setOffline(
      await renderOffline({
        trackCount: trackCount(),
        tempo: transport.tempo,
        seconds: OFFLINE_SECONDS,
      }),
    );
  };

  const resetCounters = () => {
    outputRef.current?.resetCounters();
    fpsRef.current.reset();
    startedAtRef.current = performance.now();
  };

  return (
    <section aria-label="Latency test">
      <h2>Latency test</h2>

      <fieldset>
        <legend>Audio</legend>
        {bufferSizes ? (
          <>
            {hosts.length > 1 && (
              <label>
                Audio host{" "}
                <select
                  value={host ?? ""}
                  disabled={output !== null}
                  onChange={(event) => setHost(event.target.value || null)}
                >
                  <option value="">default</option>
                  {hosts.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}{" "}
            <label>
              Buffer size{" "}
              <select
                value={bufferFrames}
                disabled={output !== null}
                onChange={(event) => setBufferFrames(Number(event.target.value))}
              >
                {bufferSizes.map((frames) => (
                  <option key={frames} value={frames}>
                    {frames} frames
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label>
            Latency hint{" "}
            <select
              value={hint}
              disabled={output !== null}
              onChange={(event) => setHint(Number(event.target.value))}
            >
              {LATENCY_HINTS.map((option, index) => (
                <option key={option.label} value={index}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}{" "}
        {output ? (
          <button type="button" onClick={() => void stop()}>
            Stop audio
          </button>
        ) : (
          <button type="button" disabled={starting} onClick={() => void start()}>
            {starting ? "Starting…" : "Start audio"}
          </button>
        )}
        {error && <p role="alert">Couldn't start audio: {error}</p>}
      </fieldset>

      <TransportBar
        settings={transport}
        tempoMap={constantTempoMap(transport.tempo, transport.timeSignature)}
        onChange={setTransport}
        send={send}
        readReport={readReport}
      />

      <fieldset>
        <legend>Load</legend>
        <label>
          Tracks{" "}
          <input
            type="number"
            min={1}
            max={512}
            value={trackInput}
            onChange={(event) => setTrackInput(event.target.value)}
          />
        </label>{" "}
        <button type="button" onClick={applyTrackCount}>
          Apply
        </button>{" "}
        <label>
          <input
            type="checkbox"
            checked={patternPlaying}
            onChange={(event) => {
              setPatternPlaying(event.target.checked);
              if (event.target.checked) {
                setTransport({ ...transport, loop: true, loopStart: 0, loopEnd: barTicks(transport.timeSignature) });
              }
              send({ type: "setPatternPlaying", playing: event.target.checked });
            }}
          />{" "}
          Play pattern
        </label>
      </fieldset>

      <fieldset>
        <legend>Offline render</legend>
        <button
          type="button"
          disabled={offline === "rendering"}
          onClick={() => void renderOfflineTest()}
        >
          Render {OFFLINE_SECONDS} s offline
        </button>{" "}
        <span>
          {offline === "rendering"
            ? "Rendering… (the page freezes until it's done)"
            : offline &&
              `${offline.audioSeconds.toFixed(0)} s of audio in ${offline.elapsedSeconds.toFixed(1)} s (${(offline.audioSeconds / offline.elapsedSeconds).toFixed(1)}× real time)`}
        </span>
      </fieldset>

      <fieldset>
        <legend>Live play</legend>
        <p>{midiStatus}</p>
        <p>
          Computer keyboard: A S D F G H J K play C{octave} to C{octave + 1}, W E T Y U the
          sharps; Z / X change octave.
        </p>
        <label>
          <input
            type="checkbox"
            checked={latencyTest}
            onChange={(event) => {
              setLatencyTest(event.target.checked);
              send({ type: "setLatencyTest", on: event.target.checked });
            }}
          />{" "}
          Latency test: a key plays a sharp click instead of the Synth
        </label>{" "}
        <button
          type="button"
          onPointerDown={() => send({ type: "noteOn", note: TEST_NOTE, velocity: 0.8 })}
          onPointerUp={() => send({ type: "noteOff", note: TEST_NOTE })}
          onPointerLeave={() => send({ type: "noteOff", note: TEST_NOTE })}
        >
          Test note
        </button>
      </fieldset>

      <div
        aria-hidden
        style={{ position: "relative", height: 24, margin: "1em 0", background: "#ddd" }}
      >
        <div
          ref={playheadRef}
          style={{ position: "absolute", inset: 0, willChange: "transform" }}
        >
          <div style={{ width: 3, height: "100%", background: "#c00" }} />
        </div>
      </div>

      {stats && (
        <>
          <Stats stats={stats} />
          <button type="button" onClick={resetCounters}>
            Reset counters
          </button>
        </>
      )}
    </section>
  );
}

const ms = (seconds: number) => `${(seconds * 1000).toFixed(1)} ms`;

function Stats({ stats }: { stats: PageStats }) {
  const { output } = stats;
  const minutes = Math.floor(stats.runningSeconds / 60);
  const seconds = Math.floor(stats.runningSeconds % 60)
    .toString()
    .padStart(2, "0");

  const rows: [string, string][] = [
    ["Frame rate", `${stats.fps.toFixed(0)} fps`],
    [`Frames over ${LONG_FRAME_MS} ms`, String(stats.longFrames)],
  ];
  if (output.callbacks) {
    const { late, callbacks, slowestRender } = output.callbacks;
    rows.push([
      "Late callbacks",
      `${late} of ${callbacks} (slowest render ${ms(slowestRender)}, budget ${ms(output.blockFrames / output.sampleRate)})`,
    ]);
  } else {
    rows.push([
      "Underruns",
      output.underruns
        ? `${output.underruns.events} (${ms(output.underruns.duration)} of silence)`
        : "not reported by this browser: use an up-to-date Chrome",
    ]);
  }
  rows.push(
    ["Running for", `${minutes}:${seconds}`],
    ["Audio", output.host],
    ["Sample rate", `${output.sampleRate} Hz`],
  );
  if (output.requestedBufferFrames !== null) {
    rows.push(["Buffer size requested", `${output.requestedBufferFrames} frames`]);
  }
  rows.push(
    [output.requestedBufferFrames !== null ? "Buffer size granted" : "Block size", `${output.blockFrames} frames`],
    [
      "Base latency (buffer)",
      `${ms(output.baseLatency)} (${Math.round(output.baseLatency * output.sampleRate)} frames)`,
    ],
    ["Output latency", output.outputLatency === null ? "not reported" : ms(output.outputLatency)],
  );
  if (output.underruns) {
    const { averageLatency, minimumLatency, maximumLatency } = output.underruns;
    rows.push([
      "Playback latency (avg / min / max)",
      `${ms(averageLatency)} / ${ms(minimumLatency)} / ${ms(maximumLatency)}`,
    ]);
  }
  if (output.engine) {
    rows.push(["Tracks running", String(output.engine.trackCount)]);
    rows.push(["Voices sounding", String(output.engine.activeVoices)]);
  }

  return (
    <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.25em 1em" }}>
      {rows.map(([term, value]) => (
        <div key={term} style={{ display: "contents" }}>
          <dt>{term}</dt>
          <dd style={{ margin: 0 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
