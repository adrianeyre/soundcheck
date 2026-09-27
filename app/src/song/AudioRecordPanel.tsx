import { Circle, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AudioInput, AudioInputs, InputDevice, RecordedTake } from "../audio/audio-input";
import type { AudioOutput } from "../audio/audio-output";
import { CLIP_GAIN, formatDb, levelFraction } from "../mixer/level";
import type { AudioTrack, TrackInput } from "../project/model";
import { readLocal, writeLocal } from "../settings/local-settings";

/** How often the input's meter is read. */
const LEVEL_MS = 50;

/** Where the musician's loopback-measured offset is kept on this machine. */
export const OFFSET_KEY = "soundcheck.recording-offset-ms";

function savedOffset(): number {
  const saved = Number(readLocal(OFFSET_KEY));
  return Number.isFinite(saved) ? saved : 0;
}

export interface AudioRecordPanelProps {
  /** The platform's inputs, or null where it has none. */
  inputs: AudioInputs | null;
  tracks: readonly AudioTrack[];
  /** Where a Track is in the engine: its place among all the Project's Tracks. */
  engineTrack: (track: AudioTrack) => number;
  /** The running audio, which a take is timed against. */
  output: AudioOutput | null;
  /** The Project is someone else's for now (the Assistant's). */
  disabled: boolean;
  /** Takes were recorded onto armed Tracks: put them in the Project, as one undo step. */
  onRecorded: (takes: { track: AudioTrack; take: RecordedTake }[]) => void | Promise<void>;
  /** The musician chose `track`'s Input: an edit to the Project. */
  onInputChange: (track: AudioTrack, input: TrackInput) => void;
  /** The musician turned `track`'s Input Monitoring on or off: an edit to the Project. */
  onMonitoringChange: (track: AudioTrack, monitoring: boolean) => void;
  /**
   * Told when a take starts, and when it has stopped and landed in the
   * Project, so nothing else (a Request) takes the Project in between.
   */
  onRecording?: (recording: boolean) => void;
  onError: (message: string) => void;
}

/**
 * What the input is opened for: one device, and each armed Track's channels
 * on it, and where the Track is in the engine, which hears the tap when the
 * Track monitors it.
 */
interface Opening {
  device: string | null;
  trackIds: string[];
  taps: TrackInput["channels"][];
  engineTracks: number[];
}

/** A channel pick as a `<select>` value: "" for the default, "4" for one, "2,3" for a pair. */
const pickValue = (channels: TrackInput["channels"]) => channels?.join(",") ?? "";

function pickOf(value: string): TrackInput["channels"] {
  if (value === "") return null;
  const channels = value.split(",").map(Number);
  return channels.length === 2 ? [channels[0]!, channels[1]!] : [channels[0]!];
}

/** A channel pick as the interface labels it, from 1. */
function pickLabel(channels: TrackInput["channels"], count: number): string {
  if (channels === null) return count === 1 ? "Mono 1 (default)" : "Stereo 1/2 (default)";
  return channels.length === 1 ? `Mono ${channels[0] + 1}` : `Stereo ${channels[0] + 1}/${channels[1] + 1}`;
}

/** Every channel on its own, then each pair from the first: 1/2, 3/4 and on. */
function picksFor(count: number): TrackInput["channels"][] {
  const picks: TrackInput["channels"][] = [null];
  for (let channel = 0; channel < count; channel++) picks.push([channel]);
  for (let left = 0; left + 1 < count; left += 2) picks.push([left, left + 1]);
  return picks;
}

/** Whether a device with `count` channels has every channel `channels` names. */
const fits = (channels: TrackInput["channels"], count: number) => channels === null || Math.max(...channels) < count;

/**
 * Recording an audio input onto Audio Tracks: each Track's Input picks a
 * device and one of its channels or a stereo pair, and every Track armed
 * on one device records at once, from one stream, while the song plays.
 * Each take lands where it was played, with the driver's latency taken out,
 * and the offset the musician measured with a loopback taken off too.
 * A Track with Input Monitoring on is heard through its Effects while it is
 * armed; the take is still the dry input.
 */
export function AudioRecordPanel({
  inputs,
  tracks,
  engineTrack,
  output,
  disabled,
  onRecorded,
  onInputChange,
  onMonitoringChange,
  onRecording,
  onError,
}: AudioRecordPanelProps) {
  const [devices, setDevices] = useState<InputDevice[] | null>(null);
  const [armed, setArmed] = useState<string[]>([]);
  const [input, setInput] = useState<AudioInput | null>(null);
  /** Each open take's level, in the order of the Tracks it was opened for. */
  const [levels, setLevels] = useState<number[]>([]);
  const [metered, setMetered] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [offsetMs, setOffsetMs] = useState(savedOffset);
  const inputRef = useRef<AudioInput | null>(null);
  /** What `inputRef` was opened for, whose takes come back in its order. */
  const openedRef = useRef<Opening | null>(null);
  /** Opening and closing one after another, never two at once. */
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const report = useCallback(
    (reason: unknown) => onError(String(reason instanceof Error ? reason.message : reason)),
    [onError],
  );

  // Listed on the running output's host once audio starts, so they are
  // listed again whenever a device list is opened.
  const listDevices = useCallback(() => {
    inputs
      ?.devices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [inputs]);
  useEffect(listDevices, [listDevices]);

  /** The device a Track's Input names, as listed; the default is listed first. */
  const deviceOf = (trackInput: TrackInput) =>
    trackInput.device === null ? devices?.[0] : devices?.find((device) => device.name === trackInput.device);

  // The armed Tracks, in the Project's order, and what to open for them.
  // The Project can change under an armed Track (an undo), so the input
  // follows it: a changed Input reopens it, a deleted Track drops out.
  const armedTracks = tracks.filter((track) => armed.includes(track.id));
  const wanted: Opening | null =
    armedTracks.length === 0
      ? null
      : {
          device: armedTracks[0]!.input.device,
          trackIds: armedTracks.map((track) => track.id),
          taps: armedTracks.map((track) => track.input.channels),
          engineTracks: armedTracks.map(engineTrack),
        };
  const wantedKey = JSON.stringify(wanted);

  useEffect(() => {
    // A take in progress keeps its stream; the input catches up afterwards.
    if (!inputs || recording || JSON.stringify(openedRef.current) === wantedKey) return;
    const opening: Opening | null = JSON.parse(wantedKey);
    let current = true;
    queueRef.current = queueRef.current.then(async () => {
      const previous = inputRef.current;
      inputRef.current = null;
      openedRef.current = null;
      setInput(null);
      setLevels([]);
      setMetered([]);
      await previous?.close().catch(() => {});
      if (!opening || !current) return;
      try {
        const opened = await inputs.open(opening.device, opening.taps, opening.engineTracks);
        if (!current) {
          await opened.close().catch(() => {});
          return;
        }
        inputRef.current = opened;
        openedRef.current = opening;
        setInput(opened);
        setMetered(opening.trackIds);
      } catch (reason) {
        if (!current) return;
        report(reason);
        setArmed([]);
      }
    });
    return () => {
      current = false;
    };
  }, [inputs, recording, wantedKey, report]);

  // The meters run from arming to disarming, recording or not.
  useEffect(() => {
    if (!input) return;
    const timer = setInterval(() => {
      input
        .levels()
        .then(setLevels)
        .catch(() => {});
    }, LEVEL_MS);
    return () => clearInterval(timer);
  }, [input]);

  // The input closes with the page.
  useEffect(
    () => () => {
      queueRef.current = queueRef.current.then(() => inputRef.current?.close().catch(() => {}));
    },
    [],
  );

  const toggleArm = (track: AudioTrack) => {
    if (armed.includes(track.id)) {
      setArmed(armed.filter((id) => id !== track.id));
      return;
    }
    const other = armedTracks.find((candidate) => candidate.input.device !== track.input.device);
    if (other) {
      onError(
        `Tracks armed together record from one input device: ${other.name} is on ${other.input.device ?? "the default input"}, ${track.name} on ${track.input.device ?? "the default input"}`,
      );
      return;
    }
    const device = deviceOf(track.input);
    if (device && !fits(track.input.channels, device.channels)) {
      onError(`${device.name} has no ${pickLabel(track.input.channels, device.channels)} for ${track.name} to record from`);
      return;
    }
    setArmed([...armed, track.id]);
  };

  const changeInput = (track: AudioTrack, change: Partial<TrackInput>) => {
    const next = { ...track.input, ...change };
    // A new device keeps the channels only where it has them.
    if ("device" in change && !("channels" in change)) {
      const device = deviceOf(next);
      if (!device || !fits(next.channels, device.channels)) next.channels = null;
    }
    onInputChange(track, next);
  };

  const startRecording = async () => {
    if (!input || !output) return;
    try {
      await input.startRecording();
      output.send({ type: "play" });
      setRecording(true);
      onRecording?.(true);
    } catch (reason) {
      report(reason);
    }
  };

  const stopRecording = async () => {
    setRecording(false);
    const opened = openedRef.current;
    try {
      const takes = await input!.stopRecording(offsetMs);
      output?.send({ type: "stop" });
      const landed = takes.flatMap((take, index) => {
        const track = tracks.find((candidate) => candidate.id === opened?.trackIds[index]);
        return track ? [{ track, take }] : [];
      });
      if (landed.length > 0) await onRecorded(landed);
    } catch (reason) {
      output?.send({ type: "stop" });
      report(reason);
    } finally {
      onRecording?.(false);
    }
  };

  const changeOffset = (value: number) => {
    setOffsetMs(value);
    writeLocal(OFFSET_KEY, String(value));
  };

  if (!inputs) {
    return (
      <section aria-label="Record audio" className="panel">
        <p className="hint">
          <Mic size={14} aria-hidden /> Recording audio needs the Desktop App.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="record-audio-heading" className="panel">
      <div className="panel-head">
        <h2 id="record-audio-heading" className="kind-stripe" data-track-kind="audio">
          <Mic size={18} aria-hidden />
          Record audio
        </h2>
      </div>
      {tracks.length === 0 && <p className="hint">Add an Audio Track to record onto it.</p>}
      {tracks.map((track) => {
        const isArmed = armed.includes(track.id);
        const locked = disabled || recording || isArmed;
        const device = deviceOf(track.input);
        const count = device?.channels ?? 0;
        const picks = picksFor(count);
        const saved = track.input.channels;
        const level = levels[metered.indexOf(track.id)] ?? 0;
        const clipping = level >= CLIP_GAIN;
        return (
          <div key={track.id} className="row row-end" role="group" aria-label={`${track.name} input`}>
            <label className="field">
              {track.name} input device
              <select
                value={track.input.device ?? ""}
                disabled={locked}
                onFocus={listDevices}
                onChange={(event) => changeInput(track, { device: event.target.value || null })}
              >
                <option value="">Default input</option>
                {devices?.map(({ name }) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {track.input.device !== null && devices !== null && !device && (
                  <option value={track.input.device}>{track.input.device} (not connected)</option>
                )}
              </select>
            </label>
            <label className="field">
              {track.name} input channels
              <select
                value={pickValue(saved)}
                disabled={locked}
                onChange={(event) => changeInput(track, { channels: pickOf(event.target.value) })}
              >
                {picks.map((pick) => (
                  <option key={pickValue(pick)} value={pickValue(pick)}>
                    {pickLabel(pick, count)}
                  </option>
                ))}
                {!fits(saved, count) && (
                  <option value={pickValue(saved)}>{`${pickLabel(saved, count)} (not on this device)`}</option>
                )}
              </select>
            </label>
            <button
              type="button"
              aria-pressed={isArmed}
              disabled={recording || (!isArmed && disabled)}
              onClick={() => toggleArm(track)}
            >
              {isArmed ? `Disarm ${track.name}` : `Arm ${track.name}`}
            </button>
            <label className="field-inline" title="Hear the input through the Track's Effects while it is armed">
              <input
                type="checkbox"
                checked={track.monitoring}
                disabled={disabled}
                aria-describedby="monitor-help"
                onChange={(event) => onMonitoringChange(track, event.target.checked)}
              />
              Monitor {track.name}
            </label>
            <div
              role="meter"
              aria-label={`${track.name} input level`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={Number(levelFraction(level).toFixed(3))}
              aria-valuetext={clipping ? `${formatDb(level)}, clipping` : formatDb(level)}
              className="meter"
              data-clipping={clipping}
              style={{ width: 120, height: 12, alignSelf: "center" }}
            >
              <div aria-hidden className="meter-fill" style={{ left: 0, top: 0, width: `${levelFraction(level) * 100}%`, height: "100%" }} />
            </div>
          </div>
        );
      })}
      <div className="row row-end mt-3">
        <button
          type="button"
          className="btn-record"
          aria-pressed={recording}
          disabled={!recording && (!input || !output || disabled)}
          onClick={() => void (recording ? stopRecording() : startRecording())}
        >
          {recording ? <Square size={14} aria-hidden /> : <Circle size={14} fill="currentColor" aria-hidden />}
          {recording ? "Stop recording audio" : "Record audio"}
        </button>
        <label className="field">
          Offset (ms)
          <input
            type="number"
            step={0.1}
            value={offsetMs}
            disabled={recording}
            style={{ width: "6em" }}
            aria-describedby="offset-help"
            onChange={(event) => changeOffset(Number(event.target.value) || 0)}
          />
        </label>
      </div>
      <p id="monitor-help" className="hint mt-3">
        Monitoring plays an armed Track&apos;s input through its Effects. Use headphones: through speakers it can feed
        back.
      </p>
      <p id="offset-help" className="hint mt-3">
        Offset is the latency the audio driver doesn&apos;t report, measured with a loopback cable (see the README).
      </p>
    </section>
  );
}
