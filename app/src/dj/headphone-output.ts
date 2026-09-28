/**
 * The Mixing page's headphone cue on a second output device (ADR 0013):
 * the channels with CUE on, blended with the Master by the headphone
 * MIXING knob at the headphone LEVEL, out of the device the DJ picks, while
 * the Master goes to the main output. `platform.ts` picks the platform's.
 *
 * - Desktop: the shell opens a second cpal stream on the device, fed from
 *   the engine through a lock-free ring (`desktop/src/headphones.rs`).
 * - Browser: the worklet's cue channels go to a MediaStream, played by an
 *   audio element sent to the device with `setSinkId`. Where a browser has
 *   no `setSinkId` (Firefox, Safari), there is none.
 */
import type { AudioOutput } from "../audio/audio-output";
import type { Invoke } from "../audio/desktop-audio-output";

export interface HeadphoneDevice {
  /** How it is chosen again: a desktop device's name, or a browser's device id. */
  id: string;
  label: string;
}

export interface HeadphoneState {
  /** The device chosen, or null for none. */
  device: string | null;
  /**
   * `off`: none chosen. `waiting`: chosen, and waiting for audio to start.
   * `playing`: the cue is going out of it. `failed`: it couldn't be opened,
   * or it stopped (unplugged), as `message` says.
   */
  status: "off" | "waiting" | "playing" | "failed";
  message: string | null;
}

export interface HeadphoneOutput {
  listDevices(): Promise<HeadphoneDevice[]>;
  /** Play the cue out of `device`, or out of no second device with null. */
  choose(device: string | null): Promise<HeadphoneState>;
  state(): Promise<HeadphoneState>;
  /**
   * The audio output whose cue it plays, or null when audio stops. The
   * browser connects to each new output's graph; the desktop's shell
   * follows the output itself.
   */
  attach(output: AudioOutput | null): void;
}

export const OFF: HeadphoneState = { device: null, status: "off", message: null };

/** `HeadphoneStatus` in `desktop/src/headphones.rs`. */
interface DesktopStatus {
  device: string | null;
  sampleRate: number | null;
  failed: string | null;
}

export function desktopStateOf(status: DesktopStatus): HeadphoneState {
  if (!status.device) return OFF;
  if (status.failed) return { device: status.device, status: "failed", message: status.failed };
  if (status.sampleRate === null) return { device: status.device, status: "waiting", message: null };
  return { device: status.device, status: "playing", message: `${status.sampleRate} Hz` };
}

export function desktopHeadphoneOutput(invoke: Invoke): HeadphoneOutput {
  return {
    listDevices: () => invoke<HeadphoneDevice[]>("headphones_devices"),
    choose: async (device) => desktopStateOf(await invoke<DesktopStatus>("headphones_choose", { device })),
    state: async () => desktopStateOf(await invoke<DesktopStatus>("headphones_status")),
    // The shell opens the chosen device again whenever audio starts.
    attach: () => {},
  };
}

/** An audio element as far as playing a stream to a chosen device goes. */
export interface SinkElement {
  srcObject: MediaProvider | null;
  setSinkId(id: string): Promise<void>;
  play(): Promise<void>;
  pause(): void;
}

/** Whether this browser can send an audio element to a chosen device. */
export function canChooseSink(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

export interface BrowserHeadphoneDeps {
  devices: () => Promise<MediaDeviceInfo[]>;
  element: () => SinkElement;
}

/** The browser's, or null where it can't choose an output device. */
export function browserHeadphoneOutput(
  deps: BrowserHeadphoneDeps | null = canChooseSink()
    ? {
        devices: () => navigator.mediaDevices.enumerateDevices(),
        element: () => new Audio() as unknown as SinkElement,
      }
    : null,
): HeadphoneOutput | null {
  if (!deps) return null;
  let element: SinkElement | null = null;
  let stream: MediaStream | null = null;
  let current: HeadphoneState = OFF;

  const apply = async (): Promise<HeadphoneState> => {
    if (!current.device) {
      element?.pause();
      return (current = OFF);
    }
    if (!stream) return (current = { device: current.device, status: "waiting", message: null });
    element ??= deps.element();
    try {
      element.srcObject = stream;
      await element.setSinkId(current.device);
      await element.play();
      return (current = { device: current.device, status: "playing", message: null });
    } catch (reason) {
      return (current = {
        device: current.device,
        status: "failed",
        message: `The headphone device couldn't be used: ${reason instanceof Error ? reason.message : String(reason)}`,
      });
    }
  };

  return {
    async listDevices() {
      const outputs = (await deps.devices()).filter((d) => d.kind === "audiooutput" && d.deviceId !== "default");
      // Without permission to use a device the browser hides its name.
      return outputs.map((d, index) => ({ id: d.deviceId, label: d.label || `Audio output ${index + 1}` }));
    },
    async choose(device) {
      current = { device, status: device ? "waiting" : "off", message: null };
      return apply();
    },
    state: async () => current,
    attach(output) {
      stream = output?.dj?.headphoneStream?.() ?? null;
      if (!stream) element?.pause();
      void apply();
    },
  };
}
