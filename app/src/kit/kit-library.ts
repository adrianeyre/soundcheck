/**
 * Saved Kits (#51): a Drum Sampler's Pads, kept in the app-level library
 * outside any Project so a Kit saved in one Project loads into every other.
 *
 * A Kit is its own folder in the library, `kits/<id>/`: `kit.json` holds its
 * name and Pads, and `audio/` a copy of every sample the Pads play. Saving
 * copies the samples in, so the Kit doesn't depend on the Project it came
 * from; loading copies them into the Project, which then owns them as it
 * owns a WAV loaded onto a pad, and saving the Project writes them into its
 * folder. Neither ever names the other, so moving either changes nothing.
 *
 * A pad with no sample plays the bundled sound, which ships with the app,
 * so it is kept as it is. Names are unique among Kits, case-insensitively,
 * and the bundled Starter Kit's can't be taken, so a picker can name a Kit
 * without ambiguity.
 */
import type { Command } from "../project/commands";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import { type DrumPad, newId, STARTER_KIT, STARTER_KIT_PRESET } from "../project/model";
import { LIMITS, validateInstrument } from "../project/validate";
import type { LibraryStorage } from "../preset/library-storage";
import { AUDIO_FOLDER, audioPathFor, fileName, pathOf } from "../storage/project-folder";

export interface SavedKit {
  /** Names its folder in the library; never shown. */
  id: string;
  name: string;
  /** Each pad's sample is a path in the Kit's folder, such as `audio/kick.wav`, or null for the bundled sound. */
  pads: DrumPad[];
}

/** The folder of the library the Kits are kept in. */
const FOLDER = "kits";
const KIT_FILE = "kit.json";
/** The file format's version, so a later app can read an older library. */
const FILE_VERSION = 1;

/** A Kit can't be saved, loaded or deleted: the reason is the message. */
export class KitRefused extends Error {}

/**
 * The library's saved Kits, and the ways to change them. Reads once with
 * `load`, then keeps its list in step with every change it writes.
 */
export class KitLibrary {
  private kits: SavedKit[] = [];

  constructor(private readonly storage: LibraryStorage) {}

  /** Every saved Kit, by name, as last loaded or changed. */
  get savedKits(): readonly SavedKit[] {
    return this.kits;
  }

  /**
   * Read every saved Kit in the library. One that can't be read, or isn't a
   * Kit this app can load, is left out rather than stopping the rest.
   */
  async load(): Promise<readonly SavedKit[]> {
    const files = await this.storage.listFiles(FOLDER);
    const read = await Promise.all(
      files
        .filter((file) => /^kits\/[^/]+\/kit\.json$/.test(file))
        .map(async (file) => {
          try {
            return parseKit(file.split("/")[1]!, await this.storage.readText(file), new Set(files));
          } catch {
            return null;
          }
        }),
    );
    this.kits = [];
    for (const kit of read) {
      // A name used twice (a folder copied in by hand) keeps the first.
      if (kit && !this.kits.some((other) => sameName(other.name, kit.name))) this.kits.push(kit);
    }
    this.kits.sort((a, b) => a.name.localeCompare(b.name));
    return this.kits;
  }

  /**
   * Save `pads` as a new Kit called `name`, copying in the sample of every
   * pad that has one from `samples`, the Project's loaded audio by path.
   */
  async save(name: string, pads: readonly DrumPad[], samples: LoadedSamples): Promise<SavedKit> {
    const trimmed = this.checkName(name);
    const id = newId();
    // Each Project sample once, however many pads play it, under its own name.
    const copied = new Map<string, string>();
    const kitPads = pads.map((pad): DrumPad => {
      if (!pad.sample) return { ...pad };
      if (!samples.has(pad.sample)) {
        throw new KitRefused(`${pad.name}'s sample, ${fileName(pad.sample)}, is missing, so the Kit can't be saved`);
      }
      let file = copied.get(pad.sample);
      if (!file) {
        file = audioPathFor(fileName(pad.sample), copied.values());
        copied.set(pad.sample, file);
      }
      return { ...pad, sample: file };
    });
    const problem = validateInstrument({ type: "drumSampler", preset: trimmed, pads: kitPads });
    if (problem) throw new KitRefused(problem);

    for (const [from, file] of copied) {
      await this.storage.writeBytes(`${folderOf(id)}/${file}`, Uint8Array.from(samples.get(from)!.bytes));
    }
    // The Kit's file last, so a Kit is only listed once its samples are in.
    const kit: SavedKit = { id, name: trimmed, pads: kitPads };
    const text = JSON.stringify({ version: FILE_VERSION, name: kit.name, pads: kit.pads }, null, 2);
    await this.storage.writeText(`${folderOf(id)}/${KIT_FILE}`, text);
    this.kits = [...this.kits, kit].toSorted((a, b) => a.name.localeCompare(b.name));
    return kit;
  }

  /** Delete the saved Kit called `name`, its samples with it. */
  async delete(name: string): Promise<void> {
    const kit = this.savedKit(name);
    const files = await this.storage.listFiles(folderOf(kit.id));
    // The Kit's file first, so a Kit half deleted is no longer listed.
    const kitFile = `${folderOf(kit.id)}/${KIT_FILE}`;
    await this.storage.deleteFile(kitFile);
    for (const file of files) if (file !== kitFile) await this.storage.deleteFile(file);
    this.kits = this.kits.filter((other) => other !== kit);
  }

  /** The samples of the saved Kit `kit`, by their paths in its folder. */
  async samples(kit: SavedKit): Promise<Map<string, LoadedSample>> {
    const read = new Map<string, LoadedSample>();
    for (const pad of kit.pads) {
      if (!pad.sample || read.has(pad.sample)) continue;
      try {
        const bytes = await this.storage.readBytes(`${folderOf(kit.id)}/${pad.sample}`);
        read.set(pad.sample, { name: fileName(pad.sample), bytes: [...bytes] });
      } catch {
        throw new KitRefused(`${kit.name}'s sample ${fileName(pad.sample)} is missing from the library`);
      }
    }
    return read;
  }

  private savedKit(name: string): SavedKit {
    const kit = this.kits.find((other) => other.name === name);
    if (kit) return kit;
    if (sameName(name, STARTER_KIT_PRESET)) throw new KitRefused(`The ${STARTER_KIT_PRESET} comes with the app, and can't be changed`);
    throw new KitRefused(`There is no saved Kit called “${name}”`);
  }

  /** The name, trimmed, if a new Kit can be called it. */
  private checkName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > LIMITS.nameLength) {
      throw new KitRefused(`A Kit's name must be 1 to ${LIMITS.nameLength} characters`);
    }
    if (sameName(trimmed, STARTER_KIT_PRESET)) {
      throw new KitRefused(`“${trimmed}” is the bundled Kit's name, which can't be taken`);
    }
    if (this.kits.some((other) => sameName(other.name, trimmed))) {
      throw new KitRefused(`There is already a Kit called “${trimmed}”`);
    }
    return trimmed;
  }
}

/** What loading a Kit onto a Track does to the Project. */
export interface LoadedKit {
  /** Replaces the Track's Drum Sampler with the Kit's Pads, as one undo step. */
  command: Command;
  /** The Kit's samples, copied into the Project under their new paths, to add to its loaded audio. */
  samples: Map<string, LoadedSample>;
}

/**
 * Load `kit`, whose samples are `kitSamples`, onto the Drum Sampler Track
 * `trackId`. Each sample gets a path of its own in the Project's `audio/`,
 * away from every path in `taken` (the audio the Project names) and in
 * `samples` (the audio it has loaded), unless the Project already has the
 * same file in `samples`, which is then shared rather than copied twice.
 */
export function loadKitCommand(
  trackId: string,
  kit: SavedKit,
  kitSamples: ReadonlyMap<string, LoadedSample>,
  samples: LoadedSamples,
  taken: Iterable<string>,
): LoadedKit {
  const used = new Set([...taken, ...samples.keys()]);
  const added = new Map<string, LoadedSample>();
  const paths = new Map<string, string>();
  for (const [file, sample] of kitSamples) {
    let path = pathOf(samples, sample) ?? pathOf(added, sample);
    if (!path) {
      path = audioPathFor(sample.name, used, sample.bytes);
      used.add(path);
      added.set(path, sample);
    }
    paths.set(file, path);
  }
  const pads = kit.pads.map((pad) => {
    if (!pad.sample) return { ...pad };
    const path = paths.get(pad.sample);
    if (!path) throw new KitRefused(`${kit.name}'s sample ${fileName(pad.sample)} is missing from the library`);
    return { ...pad, sample: path };
  });
  return {
    command: { type: "setInstrument", trackId, instrument: { type: "drumSampler", preset: kit.name, pads } },
    samples: added,
  };
}

/** The bundled Starter Kit as a Kit to load, which has no samples of its own. */
export const BUNDLED_KIT: SavedKit = {
  id: "starter",
  name: STARTER_KIT_PRESET,
  pads: STARTER_KIT.map((pad) => ({ ...pad })),
};

function folderOf(id: string): string {
  return `${FOLDER}/${id}`;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A saved Kit from its file, or null if it isn't one: its Pads must pass the
 * Project's own checks, and every sample they name must be in its folder,
 * `files` being every file under the library's Kits.
 */
function parseKit(id: string, text: string, files: ReadonlySet<string>): SavedKit | null {
  const file: unknown = JSON.parse(text);
  if (typeof file !== "object" || file === null) return null;
  const { name, pads } = file as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (validateInstrument({ type: "drumSampler", preset: name, pads })) return null;
  const kitPads = pads as DrumPad[];
  const inFolder = (sample: string) =>
    sample.startsWith(`${AUDIO_FOLDER}/`) && !sample.split("/").includes("..") && files.has(`${folderOf(id)}/${sample}`);
  if (kitPads.some((pad) => pad.sample !== null && !inFolder(pad.sample))) return null;
  return { id, name: name.trim(), pads: kitPads.map((pad) => ({ ...pad })) };
}
