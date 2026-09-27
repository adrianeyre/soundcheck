/**
 * Where a **Stem Separation**'s result goes in the Project: four new Audio
 * Tracks directly under the source Clip's Track, `<Clip name> – Vocals`,
 * `– Drums`, `– Bass` and `– Other`, each holding one **Stem** as an Audio
 * Clip at the source Clip's position and length, with the source Clip
 * removed, so the song sounds roughly as it did. Import as Stems… puts a
 * whole file's Stems on four such Tracks at the end of the Track list, at the
 * playhead. The commands are one undo step however they are executed: by the
 * Clip's context menu, the Assistant's tool, or Import as Stems….
 *
 * The Stems' audio is the Project's, like any imported file: it is added to
 * the loaded audio under a path in `audio/`, and saved there.
 */
import { clipFileName } from "../export/mix-exporter";
import { copyPathFor } from "../storage/project-folder";
import type { Command } from "../project/commands";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import { type AudioClip, type AudioTrack, createAudioTrack, newId, type Project } from "../project/model";
import type { Stem, StemName } from "./stem-separator";

/** The Tracks' order under the source Track, top to bottom. */
export const STEM_TRACK_ORDER: readonly StemName[] = ["vocals", "drums", "bass", "other"];

/** What each Stem's Track and file are called after its Clip. */
export const STEM_LABELS: Record<StemName, string> = { vocals: "Vocals", drums: "Drums", bass: "Bass", other: "Other" };

/** What the step is called in Undo's label. */
export const SEPARATE_LABEL = "Separate into Stems";


export type StemPlacement =
  | {
      ok: true;
      /** One undo step: the kept Stems' Tracks with their Clips, then the source Clip's removal. */
      commands: Command[];
      /** The Stems' audio, by the path each Stem Clip names, to add to the loaded audio. */
      samples: Map<string, LoadedSample>;
      /** The new Tracks' ids, top to bottom. */
      trackIds: string[];
    }
  | { ok: false; error: string };

/**
 * The commands putting `stems`, separated from `separated` (the Clip as it
 * was when its audio was taken), into `project` in place of that Clip: a
 * Track for each Stem in `keep`, the rest discarded. A
 * Clip since deleted or trimmed gets an error saying so and no commands: its
 * Stems are of audio it no longer plays. One since moved is followed.
 */
export function placeStems(
  project: Project,
  samples: LoadedSamples,
  separated: AudioClip,
  stems: readonly Stem[],
  id: () => string = newId,
  keep: readonly StemName[] = STEM_TRACK_ORDER,
): StemPlacement {
  const index = project.tracks.findIndex(
    (track) => track.kind === "audio" && track.clips.some((clip) => clip.id === separated.id),
  );
  const track = project.tracks[index] as AudioTrack | undefined;
  const clip = track?.clips.find((candidate) => candidate.id === separated.id);
  const name = clipFileName(separated);
  if (!track || !clip) {
    return { ok: false, error: `${name} was deleted while it was being separated, so its Stems were discarded.` };
  }
  if (clip.file !== separated.file || clip.fileOffset !== separated.fileOffset || clip.duration !== separated.duration) {
    return {
      ok: false,
      error: `${name} was trimmed while it was being separated, so its Stems no longer match it and were discarded.`,
    };
  }

  const placed = stemTracks(project, samples, name, stems, { index: index + 1, start: clip.start, duration: clip.duration }, id, keep);
  placed.commands.push({ type: "deleteClip", clipId: clip.id });
  return placed;
}

/** What Import as Stems… calls its undo step. */
export const IMPORT_LABEL = "Import as Stems";

/** A file being imported as Stems: what it is called, and how long it lasts. */
export interface ImportedFile {
  /** Its file name, extension and all. */
  name: string;
  /** In seconds. */
  duration: number;
}

/** The name an imported file's Stems are called after: its file name without the extension, as a Clip's. */
export function importedFileName(file: ImportedFile): string {
  return file.name.replace(/\.[^.]+$/, "") || file.name;
}

/**
 * The commands for Import as Stems…: `stems`, separated from the whole of
 * `file`, on four new Audio Tracks at the end of the Track list, each Stem
 * an Audio Clip from tick `start` (the playhead) for as long as the file.
 * Only the Stems' audio joins the Project, not the file's.
 */
export function placeImportedStems(
  project: Project,
  samples: LoadedSamples,
  file: ImportedFile,
  stems: readonly Stem[],
  start: number,
  id: () => string = newId,
): StemPlacement {
  return stemTracks(
    project,
    samples,
    importedFileName(file),
    stems,
    { index: project.tracks.length, start, duration: file.duration },
    id,
    STEM_TRACK_ORDER,
  );
}

/**
 * A new Audio Track for each Stem in `keep`, `<name> – Vocals` and so on,
 * inserted from `index` down, each holding its Stem as an Audio Clip from
 * tick `start` for `duration` seconds.
 */
function stemTracks(
  project: Project,
  samples: LoadedSamples,
  name: string,
  stems: readonly Stem[],
  { index, start, duration }: { index: number; start: number; duration: number },
  id: () => string,
  keep: readonly StemName[],
): StemPlacement & { ok: true } {
  const added = new Map<string, LoadedSample>();
  const trackIds: string[] = [];
  const kept = STEM_TRACK_ORDER.filter((stemName) => keep.includes(stemName));
  const commands: Command[] = kept.map((stemName, at): Command => {
    const stem = stems.find((candidate) => candidate.name === stemName);
    if (!stem) throw new Error(`The Stem Separation gave no ${STEM_LABELS[stemName]} Stem.`);
    const trackName = `${name} – ${STEM_LABELS[stemName]}`;
    const sample: LoadedSample = { name: `${trackName}.wav`, bytes: [...stem.wav] };
    const path = copyPathFor(sample, new Map([...samples, ...added]), project);
    added.set(path, sample);
    const stemTrack = createAudioTrack(trackName, id());
    trackIds.push(stemTrack.id);
    stemTrack.clips.push({ id: id(), kind: "audio", start, duration, file: path, fileOffset: 0 });
    return { type: "addTrack", track: stemTrack, index: index + at };
  });
  return { ok: true, commands, samples: added, trackIds };
}
