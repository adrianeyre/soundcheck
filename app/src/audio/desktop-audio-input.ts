/**
 * Audio inputs on the desktop: a cpal input stream beside the output, in
 * the Tauri process (`desktop/src/audio_input.rs`). A take's WAV file comes
 * back as raw bytes rather than JSON.
 */
import type { AudioInputs, InputDevice, RecordedTake } from "./audio-input";
import type { Invoke } from "./desktop-audio-output";

/** `InputInfo` in `desktop/src/audio_input.rs`. */
interface InputInfo {
  device: string;
  sampleRate: number;
  channels: number;
}

/** `RecordedTake` in `desktop/src/lib.rs`. */
interface PlacedTake {
  startTick: number;
  seconds: number;
}

export function desktopAudioInputs(invoke: Invoke): AudioInputs {
  return {
    devices: () => invoke<InputDevice[]>("audio_input_devices"),
    open: async (device, taps, tracks) => {
      const info = await invoke<InputInfo>("audio_input_open", { device, taps, tracks });
      return {
        device: info.device,
        levels: () => invoke<number[]>("audio_input_levels"),
        startRecording: () => invoke<void>("audio_record_start"),
        stopRecording: async (offsetMs): Promise<RecordedTake[]> => {
          const placed = await invoke<PlacedTake[]>("audio_record_stop", { offsetMs });
          const takes: RecordedTake[] = [];
          for (const [index, take] of placed.entries()) {
            const wav = new Uint8Array(await invoke<ArrayBuffer>("audio_record_take", { index }));
            takes.push({ ...take, wav });
          }
          return takes;
        },
        close: () => invoke<void>("audio_input_close"),
      };
    },
  };
}
