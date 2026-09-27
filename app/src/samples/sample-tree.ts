/**
 * A sample folder's files arranged as the folders they sit in, for the
 * sample browser's tree: folders first, then files, each in the order a
 * musician expects ("kick 2" before "kick 10"), and searched by every word.
 */

/** A folder in a sample folder, or the sample folder itself (path ""). */
export interface SampleTreeFolder {
  /** Its own name; "" for the sample folder itself. */
  readonly name: string;
  /** Relative to the sample folder, separated by "/"; "" for the sample folder itself. */
  readonly path: string;
  readonly folders: readonly SampleTreeFolder[];
  /** The files directly in it, as sample-folder-relative paths. */
  readonly files: readonly string[];
  /** Every file in it and the folders inside it. */
  readonly count: number;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The name at the end of a "/"-separated path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The folder part of a "/"-separated path: "" for a file at the top. */
export function folderPart(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

interface Building {
  name: string;
  path: string;
  folders: Map<string, Building>;
  files: string[];
}

export function sampleTree(paths: readonly string[]): SampleTreeFolder {
  const root: Building = { name: "", path: "", folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/").filter((part) => part.length > 0);
    if (parts.length === 0) continue;
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.get(part);
      if (!next) {
        next = { name: part, path: at.path ? `${at.path}/${part}` : part, folders: new Map(), files: [] };
        at.folders.set(part, next);
      }
      at = next;
    }
    at.files.push(parts.join("/"));
  }
  return finish(root);
}

function finish(building: Building): SampleTreeFolder {
  const folders = [...building.folders.values()].map(finish).toSorted((a, b) => byName.compare(a.name, b.name));
  const files = building.files.toSorted((a, b) => byName.compare(baseName(a), baseName(b)));
  return {
    name: building.name,
    path: building.path,
    folders,
    files,
    count: files.length + folders.reduce((sum, folder) => sum + folder.count, 0),
  };
}

/** The words of a search, lower-cased; none for a blank one. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
}

/** Whether a path has every word of the search in it, anywhere. */
export function matchesSearch(path: string, words: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return words.every((word) => lower.includes(word));
}

/** The tree with only the files that match every word, and the folders that hold them; null where none match. */
export function filterSampleTree(tree: SampleTreeFolder, words: readonly string[]): SampleTreeFolder | null {
  if (words.length === 0) return tree;
  const folders = tree.folders.flatMap((folder) => filterSampleTree(folder, words) ?? []);
  const files = tree.files.filter((path) => matchesSearch(path, words));
  if (folders.length === 0 && files.length === 0) return null;
  return { ...tree, folders, files, count: files.length + folders.reduce((sum, folder) => sum + folder.count, 0) };
}

/** Where in `text` the search's words are, as [start, end) ranges in order, merged where they touch. */
export function matchRanges(text: string, words: readonly string[]): [number, number][] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const word of words) {
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) {
      ranges.push([at, at + word.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** The file's format, from its extension, as the musician is shown it. */
export function formatOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toUpperCase();
}
