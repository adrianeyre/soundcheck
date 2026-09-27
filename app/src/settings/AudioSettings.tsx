import { useEffect, useId, useState } from "react";

import type { AudioOutput } from "../audio/audio-output";
import type { AudioPreferences } from "./audio-preferences";

/** How often what the running stream got is read again: it settles after its first callbacks. */
const GRANTED_MS = 500;

export interface AudioSettingsProps {
  /** The audio hosts to choose from, e.g. WASAPI and ASIO, or ALSA and JACK. */
  listAudioHosts: () => Promise<string[]>;
  bufferSizes: readonly number[];
  preferences: AudioPreferences;
  /** Saves the choice, and restarts the audio on it if it is running. */
  onChange: (preferences: AudioPreferences) => void;
  /** The song's running audio, to say what it was granted. */
  output: AudioOutput | null;
  /** Why the choice can't change just now (a recording), or null. */
  locked: string | null;
  /** Why the audio last failed to start, e.g. no JACK server; null if it didn't. */
  error: string | null;
}

/**
 * The audio host and buffer size the song plays through, and what the
 * running stream actually got: the host decides, so a request can be
 * rounded, or ignored altogether (JACK runs at its server's size).
 */
export function AudioSettings({ listAudioHosts, bufferSizes, preferences, onChange, output, locked, error }: AudioSettingsProps) {
  const id = useId();
  const [hosts, setHosts] = useState<string[]>([]);
  // What `output` was granted, kept with the output it describes so a closed one's isn't shown.
  const [granted, setGranted] = useState<{ output: AudioOutput; text: string } | null>(null);

  useEffect(() => {
    listAudioHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
  }, [listAudioHosts]);

  useEffect(() => {
    if (!output) return;
    const read = () => {
      const text = describeGranted(output);
      setGranted((shown) => (shown?.output === output && shown.text === text ? shown : { output, text }));
    };
    const first = setTimeout(read, 0);
    const timer = setInterval(read, GRANTED_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [output]);
  const grantedNow = output && granted?.output === output ? granted.text : null;

  // A saved host this build doesn't have (ASIO without the `asio` feature) is still shown, so it isn't lost silently.
  const hostChoices = preferences.host && !hosts.includes(preferences.host) ? [...hosts, preferences.host] : hosts;
  const disabled = locked !== null;

  return (
    <div className="stack">
      <div className="row">
        <label htmlFor={`${id}-host`}>Audio host</label>
        <select
          id={`${id}-host`}
          value={preferences.host ?? ""}
          disabled={disabled}
          onChange={(event) => onChange({ ...preferences, host: event.target.value || null })}
        >
          <option value="">Default{hosts[0] ? ` (${hosts[0]})` : ""}</option>
          {hostChoices.map((name) => (
            <option key={name} value={name}>
              {hosts.includes(name) ? name : `${name} (not in this build)`}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-buffer`}>Buffer size</label>
        <select
          id={`${id}-buffer`}
          value={preferences.bufferFrames ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...preferences, bufferFrames: event.target.value ? Number(event.target.value) : null })
          }
        >
          <option value="">The host&apos;s default</option>
          {bufferSizes.map((frames) => (
            <option key={frames} value={frames}>
              {frames} frames
            </option>
          ))}
        </select>
      </div>
      {preferences.host === "JACK" && (
        <p className="hint">
          JACK plays at its server&apos;s buffer size and sample rate: set them in JACK, or in PipeWire&apos;s quantum.
        </p>
      )}
      {error && !output ? (
        <p role="alert" className="alert">
          Audio didn&apos;t start: {error}
        </p>
      ) : (
        <p className="hint" role="status">
          {locked ?? grantedNow ?? "Audio is off. The choice applies when it starts."}
        </p>
      )}
    </div>
  );
}

/** "Playing through JACK: system at 48000 Hz, 256 frames a buffer (5.3 ms); asked for 128." */
function describeGranted(output: AudioOutput): string {
  const { host, sampleRate, blockFrames, requestedBufferFrames } = output.stats();
  const ms = ((blockFrames / sampleRate) * 1000).toFixed(1);
  const asked =
    requestedBufferFrames !== null && requestedBufferFrames !== blockFrames ? `; asked for ${requestedBufferFrames}` : "";
  return `Playing through ${host} at ${sampleRate} Hz, ${blockFrames} frames a buffer (${ms} ms)${asked}.`;
}
