import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

import type { AudioOutput } from "../audio/audio-output";
import { readLocal, writeLocal } from "../settings/local-settings";
import { type HeadphoneDevice, type HeadphoneOutput, type HeadphoneState, OFF } from "./headphone-output";

/** Where the headphone device chosen last is remembered, in local storage. */
export const HEADPHONES_KEY = "soundcheck.dj.headphones";

export interface HeadphonePickerProps {
  headphones: HeadphoneOutput;
  /** The running audio output, whose cue it plays; null while audio is off. */
  output: AudioOutput | null;
}

const STATUS: Record<HeadphoneState["status"], string> = {
  off: "Cue out of outputs 3 and 4 only, where the interface has them.",
  waiting: "Chosen: the cue plays there once audio starts.",
  playing: "The cue is playing there.",
  failed: "",
};

/**
 * The mixer's headphone device: which output the cue plays out of while
 * the Master goes to the main one. The choice is remembered on this
 * machine, and chosen again whenever audio starts.
 */
export function HeadphonePicker({ headphones, output }: HeadphonePickerProps) {
  const [devices, setDevices] = useState<HeadphoneDevice[]>([]);
  const [state, setState] = useState<HeadphoneState>(OFF);
  const [chosen, setChosen] = useState<string | null>(() => readLocal(HEADPHONES_KEY) || null);

  const refresh = () =>
    void headphones
      .listDevices()
      .then(setDevices)
      .catch(() => setDevices([]));

  // Each new output: connect to it, list its devices, and choose the remembered one again.
  useEffect(() => {
    headphones.attach(output);
    let live = true;
    headphones
      .listDevices()
      .then((found) => live && setDevices(found))
      .catch(() => live && setDevices([]));
    const remembered = readLocal(HEADPHONES_KEY) || null;
    void headphones.choose(remembered).then((next) => live && setState(next));
    return () => {
      live = false;
    };
  }, [headphones, output]);

  // An unplugged device is noticed on the next look.
  useEffect(() => {
    if (!output || !chosen) return;
    const timer = setInterval(() => void headphones.state().then(setState), 2_000);
    return () => clearInterval(timer);
  }, [headphones, output, chosen]);

  const choose = (device: string | null) => {
    setChosen(device);
    writeLocal(HEADPHONES_KEY, device ?? "");
    void headphones.choose(device).then(setState);
  };

  const listed = chosen && !devices.some((d) => d.id === chosen) ? [...devices, { id: chosen, label: `${chosen} (not found)` }] : devices;

  return (
    <div className="dj-phones-device">
      <label className="dj-phones-label">
        <span className="dj-hw-caption">DEVICE</span>
        <select aria-label="Headphone output device" value={chosen ?? ""} onChange={(event) => choose(event.target.value || null)}>
          <option value="">None</option>
          {listed.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="dj-hw-button" aria-label="List the output devices again" onClick={refresh}>
        <RotateCw size={12} aria-hidden />
      </button>
      <p className="dj-hw-note" role="status" data-status={state.status}>
        {state.status === "failed" ? state.message : STATUS[state.status]}
      </p>
    </div>
  );
}
