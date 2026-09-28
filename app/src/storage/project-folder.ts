/**
 * Saving and opening a Project folder, on top of any `FileStorage`.
 *
 * The folder is the Project: `project.json` plus the audio it names. Saving
 * somewhere new copies that audio across, so the new folder is complete on
 * its own and moving or sharing it keeps the song intact. A WAV the musician
 * has loaded onto a Drum Sampler pad is only in memory until then, so saving
 * writes it into `audio/` and opening reads it back onto its pad. Nothing
 * else is written — in particular the Claude API key lives in the machine's
 * credential store, never in a Project.
 */
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import type { Project } from "../project/model";
import { parseProject, serialiseProject } from "../project/serialise";
import type { FileStorage, ProjectFolder } from "./file-storage";

/** The Project's data, in the root of its folder. */
export const DATA_FILE = "project.json";

/** Where a Project's copies of the audio it uses belong. */
export const AUDIO_FOLDER = "audio";

/**
 * Audio the Project names, as paths relative to its folder, without repeats:
 * the Reference Track's file too, which is saved and opened with the rest
 * though it is never in the mix.
 */
export function audioFiles(project: Project): string[] {
  const files = new Set<string>(padSamples(project));
  for (const track of project.tracks) {
    if (track.kind === "audio") for (const clip of track.clips) files.add(clip.file);
    if (track.kind === "instrument" && track.instrument.type === "keys" && track.instrument.sample) files.add(track.instrument.sample);
  }
  if (project.referenceTrack) files.add(project.referenceTrack.file);
  return [...files].toSorted();
}

/**
 * The samples loaded onto Drum Sampler pads, as paths relative to the folder,
 * without repeats.
 */
export function padSamples(project: Project): string[] {
  const files = new Set<string>();
  for (const track of project.tracks) {
    if (track.kind === "instrument" && track.instrument.type === "drumSampler") {
      for (const pad of track.instrument.pads) if (pad.sample) files.add(pad.sample);
    }
  }
  return [...files].toSorted();
}

/** The name at the end of a folder-relative path. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Whether new audio is named after what it holds as well as what it is
 * called. On while a Shared Project is open (ADR 0007): two Collaborators
 * who each add a different `kick.wav` while apart can't see each other's
 * name as taken, so each gets a name of its own from its bytes instead. One
 * Project is open at a time, so this is the app's to set, not a Project's.
 */
let namedByContent = false;

export function nameAudioByContent(on: boolean): void {
  namedByContent = on;
}

/**
 * Where a WAV loaded onto a pad will live in the Project folder: `audio/`
 * and the file's own name. A name already taken — two pads given different
 * files called `kick.wav` — gets a number, so neither pad overwrites the
 * other's sample. In a Shared Project, `bytes` add a hash of what the file
 * holds to its name.
 */
export function audioPathFor(name: string, taken: Iterable<string>, bytes?: readonly number[]): string {
  // Only the file's own name, and only characters every platform takes: the
  // ones Windows refuses cover the others too.
  const given = fileName(name).split("\\").pop() ?? "";
  const safe = given.replace(/[:*?"<>|]/g, " ").trim() || "sample.wav";
  const dot = safe.lastIndexOf(".");
  const named = dot > 0 ? safe.slice(0, dot) : safe;
  const stem = namedByContent && bytes ? `${named}-${contentHash(bytes)}` : named;
  const extension = dot > 0 ? safe.slice(dot) : "";
  const used = new Set(taken);
  let path = `${AUDIO_FOLDER}/${stem}${extension}`;
  for (let number = 2; used.has(path); number++) {
    path = `${AUDIO_FOLDER}/${stem}-${number}${extension}`;
  }
  return path;
}

/**
 * Twelve hex digits from a file's bytes: two 32-bit FNV-1a hashes, seeded
 * apart. Not for security, only so two different files never share a name.
 */
function contentHash(bytes: readonly number[]): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ bytes.length;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x5bd1e995);
  }
  return `${hex(a)}${hex(b)}`.slice(0, 12);
}

const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");

/** The path a sample is already loaded under, where it is the same file. */
export function pathOf(samples: LoadedSamples, sample: LoadedSample): string | null {
  for (const [path, loaded] of samples) {
    if (loaded.name === sample.name && sameBytes(loaded.bytes, sample.bytes)) return path;
  }
  return null;
}

/**
 * Where `sample` goes in the Project when it is copied in: the path it is
 * already loaded under if the same file is there, or a path of its own in
 * `audio/`, even where it is called what another file is.
 */
export function copyPathFor(sample: LoadedSample, samples: LoadedSamples, project: Project): string {
  return pathOf(samples, sample) ?? audioPathFor(sample.name, [...audioFiles(project), ...samples.keys()], sample.bytes);
}

function sameBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}

/** Audio the Project names that the folder hasn't got. Saving still happens. */
export type SaveResult = { ok: true; missingAudio: string[] } | { ok: false; error: string };

export type OpenResult =
  | { ok: true; project: Project; missingAudio: string[]; samples: LoadedSamples }
  | { ok: false; error: string };

/**
 * Save `project` into `to`, bringing the audio it uses with it from `from`,
 * the folder it was opened from or last saved to, and writing out `samples`,
 * the WAVs loaded onto pads and the files imported onto Audio Tracks that
 * the folder hasn't got a copy of yet.
 */
export async function saveProject(
  storage: FileStorage,
  project: Project,
  to: ProjectFolder,
  from: ProjectFolder | null = null,
  samples: LoadedSamples = new Map(),
): Promise<SaveResult> {
  const missingAudio: string[] = [];
  const wanted = audioFiles(project);
  if (wanted.length > 0) {
    const here = new Set(await storage.listFiles(to, ""));
    const source = from && from.id !== to.id ? from : null;
    const there = source ? new Set(await storage.listFiles(source, "")) : new Set<string>();
    for (const file of wanted) {
      if (here.has(file)) continue;
      const loaded = samples.get(file);
      if (loaded) await storage.writeBytes(to, file, Uint8Array.from(loaded.bytes));
      else if (source && there.has(file)) await storage.copyFile(source, file, to, file);
      else missingAudio.push(file);
    }
  }
  await storage.writeText(to, DATA_FILE, serialiseProject(project));
  return { ok: true, missingAudio };
}

/** Open the Project in `folder`, migrating it forward if it is an older one. */
export async function openProject(storage: FileStorage, folder: ProjectFolder): Promise<OpenResult> {
  let text: string;
  try {
    text = await storage.readText(folder, DATA_FILE);
  } catch {
    return { ok: false, error: `This folder isn't a Project: it has no ${DATA_FILE}` };
  }

  const parsed = parseProject(text);
  if (!parsed.ok) return parsed;

  return { ok: true, project: parsed.project, ...(await readAudio(storage, folder, audioFiles(parsed.project))) };
}

/**
 * Read `files` from `folder` into memory, and say which it hasn't got. The
 * engine takes bytes, not paths (ADR 0001), so every pad's sample and every
 * Audio Clip's file is read back as loading or importing it left it.
 */
export async function readAudio(
  storage: FileStorage,
  folder: ProjectFolder,
  files: readonly string[],
): Promise<{ samples: LoadedSamples; missingAudio: string[] }> {
  if (files.length === 0) return { samples: new Map(), missingAudio: [] };
  const here = new Set(await storage.listFiles(folder, ""));
  const samples = new Map<string, LoadedSample>();
  for (const file of files) {
    if (!here.has(file)) continue;
    const bytes = await storage.readBytes(folder, file);
    samples.set(file, { name: fileName(file), bytes: [...bytes] });
  }
  return { samples, missingAudio: files.filter((file) => !here.has(file)) };
}
