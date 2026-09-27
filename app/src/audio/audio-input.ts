/**
 * An audio input to record from onto an Audio Track: the platform's side of
 * recording. The Audio Engine places each take on the timeline, compensated
 * for the latency the driver reports; `offsetMs` takes off what it doesn't
 * (measured once with a loopback, see the README). `platform.ts` picks the
 * implementation: the desktop app's cpal input (`desktop-audio-input.ts`).
 * One input device is open at a time, and every Track armed on it records
 * from the same stream, each from its own Input's channels.
 */
import type { TrackInput } from "../project/model";

/** A finished take, placed on the timeline. */
export interface RecordedTake {
  /** Where its Audio Clip starts, in ticks, with the latency taken out. */
  startTick: number;
  /** How long it lasts. */
  seconds: number;
  /** The take as a WAV file, for the Project folder and the engine. */
  wav: Uint8Array;
}

/**
 * An open input, metered from the moment it opens, with one take for each
 * armed Track's channels, in the order it was opened with.
 */
export interface AudioInput {
  /** The device's name. */
  device: string;
  /** Each armed Track's loudest sample since the last call, 0 to 1. */
  levels(): Promise<number[]>;
  /** Start the takes. The transport is started straight after, by the caller. */
  startRecording(): Promise<void>;
  /** Stop the takes and place them, one per armed Track; none when nothing was recorded. */
  stopRecording(offsetMs: number): Promise<RecordedTake[]>;
  close(): Promise<void>;
}

/** An input device, and how many channels a Track's Input can pick from. */
export interface InputDevice {
  name: string;
  channels: number;
}

/** The inputs a platform can record from. */
export interface AudioInputs {
  /** The input devices, the default first. */
  devices(): Promise<InputDevice[]>;
  /**
   * Open `device`, or the default input for null, recording each of `taps`
   * (armed Tracks' Input channels) as a take of its own. `tracks` are the
   * engine Tracks the taps belong to, in the same order, so a Track with
   * Input Monitoring on hears its own tap.
   */
  open(device: string | null, taps: readonly TrackInput["channels"][], tracks: readonly number[]): Promise<AudioInput>;
}
