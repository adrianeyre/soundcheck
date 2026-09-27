/**
 * The app's library as the Assistant uses it: the musician's User Presets
 * (#50) and saved Kits (#51), which live outside any Project so every
 * Project can load them.
 *
 * A Request is told what is in it, loads from it, and saves into it. Saving
 * is not a change to the Project, so it is not part of the Request's undo
 * step: undoing the Request leaves the Preset or Kit in the library, as
 * undoing in the UI leaves one the musician saved by hand. Loading a Kit is
 * a change to the Project, and undoes.
 *
 * It also holds the sample browser's folders (#52), which the Assistant
 * lists and places samples from, and the lengths of the Project's own audio
 * files. Placing a sample copies it into the Project's loaded audio as a
 * drop does, so the Project never names the sample folder. The browser dev
 * host has no sample browser, so there only the Project's files are offered.
 */
import { type KitLibrary, loadKitCommand, type SavedKit } from "../kit/kit-library";
import type { PresetSettings, PresetTarget, UserPreset } from "../preset/preset-library";
import type { Command } from "../project/commands";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import type { DrumPad, Project } from "../project/model";
import type { SampleFolder, SampleRef, SampleSource } from "../samples/sample-source";
import { readAudioFile, summariseAudio } from "../song/import-audio";
import { audioFiles, copyPathFor, fileName } from "../storage/project-folder";

/** An audio file in the Project, by its folder-relative path, and how many seconds it lasts. */
export interface AudioFileLength {
  file: string;
  seconds: number;
}

/** What the library holds, as the model is told it and the tools look in it. */
export interface LibraryContents {
  userPresets: readonly UserPreset[];
  savedKits: readonly SavedKit[];
  /** The sample browser's folders, or null where there is no sample browser, as on the browser dev host. */
  sampleFolders: readonly SampleFolder[] | null;
  /** The Project's audio files that are loaded and can be read, in path order. */
  audioFiles: readonly AudioFileLength[];
}

export const EMPTY_LIBRARY: LibraryContents = { userPresets: [], savedKits: [], sampleFolders: null, audioFiles: [] };

/** The library, and the ways a Request changes it or loads from it. Each rejects with the reason when it can't. */
export interface AssistantLibrary {
  /** What is in it as a Request starts, with `project`'s audio files. */
  contents: (project: Project) => Promise<LibraryContents>;
  /** Save a new User Preset. A name already taken is refused, never saved over. */
  savePreset: (target: PresetTarget, name: string, settings: PresetSettings) => Promise<UserPreset>;
  /** Save a Drum Sampler's Pads as a new Kit, with a copy of every sample they play. A name already taken is refused. */
  saveKit: (name: string, pads: readonly DrumPad[]) => Promise<SavedKit>;
  /**
   * Copy a saved Kit's samples into the Project's loaded audio and give the
   * command that puts its Pads on the Track, for the Request to execute.
   */
  loadKit: (trackId: string, kit: SavedKit, project: Project) => Promise<Command>;
  /** Every audio file in a sample folder, as the sample browser lists them. */
  listSamples: (folder: SampleFolder) => Promise<string[]>;
  /**
   * Copy a sample from the sample browser into the Project's loaded audio,
   * as a drop does, and give the path it has there and its length.
   */
  copySample: (sample: SampleRef, project: Project) => Promise<AudioFileLength>;
}

/**
 * The Project's loaded audio: the samples its Pads and Audio Clips play, by
 * path, which isn't in the Project itself. Saving a Kit reads it, and
 * loading one adds to it.
 */
export interface ProjectAudio {
  samples: () => LoadedSamples;
  add: (samples: ReadonlyMap<string, LoadedSample>) => void;
}

/** The sample browser, where there is one: its folders, as the musician added them, and where they are read. */
export interface SampleLibrary {
  folders: () => Promise<SampleFolder[]>;
  source: SampleSource;
}

/**
 * The library the Assistant uses, over the Preset library, the Kit library,
 * the Project's loaded audio and the sample browser, if there is one.
 */
export function assistantLibrary(
  presets: Pick<LibraryContents, "userPresets"> & {
    save: (target: PresetTarget, name: string, settings: PresetSettings) => Promise<UserPreset>;
  },
  kits: KitLibrary,
  audio: ProjectAudio,
  samples: SampleLibrary | null = null,
): AssistantLibrary {
  // Each file is measured once, however many Requests are told its length.
  const lengths = new WeakMap<LoadedSample, number>();
  const lengthOf = async (sample: LoadedSample) => {
    const known = lengths.get(sample);
    if (known !== undefined) return known;
    const { seconds } = await summariseAudio(sample.bytes);
    lengths.set(sample, seconds);
    return seconds;
  };
  return {
    async contents(project) {
      const loaded = audio.samples();
      const files = await Promise.all(
        audioFiles(project).map(async (file): Promise<AudioFileLength | null> => {
          const sample = loaded.get(file);
          // A file the Project names but hasn't got, or can't read, can't be placed.
          if (!sample) return null;
          return lengthOf(sample).then(
            (seconds) => ({ file, seconds }),
            () => null,
          );
        }),
      );
      return {
        userPresets: [...presets.userPresets],
        savedKits: [...kits.savedKits],
        sampleFolders: samples ? await samples.folders() : null,
        audioFiles: files.filter((file) => file !== null),
      };
    },
    savePreset: (target, name, settings) => presets.save(target, name, settings),
    saveKit: (name, pads) => kits.save(name, pads, audio.samples()),
    async loadKit(trackId, kit, project) {
      const loaded = loadKitCommand(trackId, kit, await kits.samples(kit), audio.samples(), audioFiles(project));
      audio.add(loaded.samples);
      return loaded.command;
    },
    listSamples(folder) {
      if (!samples) return Promise.reject(new Error("The sample browser isn't available here"));
      return samples.source.listAudio(folder);
    },
    async copySample(sample, project) {
      if (!samples) throw new Error("The sample browser isn't available here");
      let bytes;
      try {
        bytes = await samples.source.readBytes(sample);
      } catch (reason) {
        throw new Error(`${sample.path} couldn't be read: ${reason instanceof Error ? reason.message : String(reason)}`, {
          cause: reason,
        });
      }
      // Read as a drop reads it, so a file a drop refuses is refused here too.
      const { sample: read, waveform } = await readAudioFile(new File([bytes], fileName(sample.path)));
      const known = audio.samples();
      const file = copyPathFor(read, known, project);
      const copy = known.get(file) ?? read;
      audio.add(new Map([[file, copy]]));
      lengths.set(copy, waveform.seconds);
      return { file, seconds: waveform.seconds };
    },
  };
}
