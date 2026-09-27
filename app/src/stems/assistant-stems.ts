/**
 * **Stem Separation** as a Request uses it, for the Assistant's
 * `separate_stems` (#118): the platform's `StemSeparator`, fed the stretch
 * of its file an Audio Clip plays (`clipAudio`), and the Project's loaded
 * audio, which the Stems' audio joins.
 *
 * A Suggestion's Stems join the loaded audio while it is worked out, so the
 * rest of the Request can hear them, and leave it again if it is discarded:
 * `remove` is how.
 */
import type { ProjectAudio } from "../assistant/library";
import type { LoadedSamples } from "../project/engine-sync";
import type { AudioClip } from "../project/model";
import { clipAudio } from "./clip-audio";
import type { SeparationOptions, SeparatorStatus, Stem, StemSeparator } from "./stem-separator";

export interface AssistantStems extends ProjectAudio {
  /** Whether separation can run here, and if its model is installed. */
  status(): Promise<SeparatorStatus>;
  /** Separate the stretch `clip` plays into its four Stems, or null if cancelled. */
  separate(clip: AudioClip, options: SeparationOptions): Promise<Stem[] | null>;
  /** Take files out of the loaded audio: a discarded Suggestion's Stems. */
  remove(paths: readonly string[]): void;
}

/** The loaded audio, as `assistantStems` reads, adds to and takes from it. */
export interface RemovableAudio extends ProjectAudio {
  remove(paths: readonly string[]): void;
}

/**
 * The Assistant's Stem Separation over `separator` and the loaded audio.
 * `cut` takes the Clip's audio out of its file; the engine's, unless a test
 * says otherwise.
 */
export function assistantStems(
  separator: StemSeparator,
  audio: RemovableAudio,
  cut: (clip: AudioClip, samples: LoadedSamples) => Promise<Uint8Array> = clipAudio,
): AssistantStems {
  return {
    status: () => separator.status(),
    async separate(clip, options) {
      return separator.separate(await cut(clip, audio.samples()), options);
    },
    samples: () => audio.samples(),
    add: (samples) => audio.add(samples),
    remove: (paths) => audio.remove(paths),
  };
}
