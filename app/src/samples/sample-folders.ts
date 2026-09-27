/**
 * The folders the musician has added to the sample browser, remembered
 * app-wide: one file in the app-level library, outside any Project, so they
 * are there on every launch and in every Project.
 */
import type { LibraryStorage } from "../preset/library-storage";
import type { SampleFolder } from "./sample-source";

/** Where in the library the folders are kept. */
export const SAMPLE_FOLDERS_FILE = "sample-folders.json";

/**
 * The folders saved in `library`. None where nothing has been saved yet;
 * a damaged file, or a damaged entry in it, is skipped rather than refused.
 */
export async function loadSampleFolders(library: LibraryStorage): Promise<SampleFolder[]> {
  let text: string;
  try {
    text = await library.readText(SAMPLE_FOLDERS_FILE);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = (parsed as { folders?: unknown } | null)?.folders;
  if (!Array.isArray(entries)) return [];
  const folders: SampleFolder[] = [];
  for (const entry of entries as unknown[]) {
    const { id, label } = (entry ?? {}) as Partial<Record<keyof SampleFolder, unknown>>;
    if (typeof id === "string" && id !== "" && typeof label === "string") folders.push({ id, label });
  }
  return withoutRepeats(folders);
}

export async function saveSampleFolders(library: LibraryStorage, folders: readonly SampleFolder[]): Promise<void> {
  const saved = folders.map(({ id, label }) => ({ id, label }));
  await library.writeText(SAMPLE_FOLDERS_FILE, `${JSON.stringify({ folders: saved }, null, 2)}\n`);
}

/** `folders` with `folder` at the end, unless it is already there. */
export function addSampleFolder(folders: readonly SampleFolder[], folder: SampleFolder): SampleFolder[] {
  return withoutRepeats([...folders, folder]);
}

export function removeSampleFolder(folders: readonly SampleFolder[], id: string): SampleFolder[] {
  return folders.filter((folder) => folder.id !== id);
}

function withoutRepeats(folders: readonly SampleFolder[]): SampleFolder[] {
  const seen = new Set<string>();
  return folders.filter((folder) => !seen.has(folder.id) && seen.add(folder.id));
}
