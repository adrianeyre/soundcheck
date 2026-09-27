/**
 * What Ctrl+C on the Timeline copies and where Ctrl+V puts it: a Clip, or a
 * Section with everything in its bars. Pure, so the rules are tested without
 * a browser; `Timeline` turns what they give into commands.
 *
 * A paste goes straight after the one selected, as Ctrl+D and Duplicate
 * do, and the copy is selected, so pasting again lays the next after it.
 */
import type { ArrangementEdit } from "../project/arrangement";
import { type Clip, clipEnd, type Project, type Track } from "../project/model";
import { sectionEndBar } from "../project/sections";
import type { TempoMap } from "../project/time";
import { accepts } from "./timeline-view";

/** What the Timeline has copied. */
export type TimelineClipboard =
  /** The Clip as it was copied, so it pastes even once the original is changed or gone. */
  | { kind: "clip"; clip: Clip; trackId: string }
  /** The Section by id: its bars are copied as they are when it is pasted, as Duplicate copies them. */
  | { kind: "section"; sectionId: string; name: string };

/**
 * Where a copied Clip goes: on the selected Clip's Track, straight after it,
 * where that Track takes its kind; otherwise straight after where it was
 * copied from, on its own Track. Its own Track gone, the first that takes
 * it, at the same place. Null where no Track takes it.
 */
export function clipPasteTarget(
  project: Project,
  map: TempoMap,
  copied: Extract<TimelineClipboard, { kind: "clip" }>,
  selected: { clip: Clip; track: Track } | null,
): { trackId: string; start: number } | null {
  if (selected && accepts(selected.track, copied.clip)) {
    return { trackId: selected.track.id, start: Math.ceil(clipEnd(selected.clip, map)) };
  }
  const start = Math.ceil(clipEnd(copied.clip, map));
  const own = project.tracks.find((track) => track.id === copied.trackId);
  const track = own ?? project.tracks.find((candidate) => accepts(candidate, copied.clip));
  return track ? { trackId: track.id, start } : null;
}

/**
 * The arrangement edit that pastes a copied Section: its bars, with
 * everything in them, put in straight after the selected Section, or after
 * itself with none selected. Null once the Section is gone.
 */
export function sectionPaste(
  project: Project,
  copied: Extract<TimelineClipboard, { kind: "section" }>,
  selectedId: string | null,
): Extract<ArrangementEdit, { kind: "duplicateSection" }> | null {
  const section = project.sections.find((candidate) => candidate.id === copied.sectionId);
  if (!section) return null;
  const after = project.sections.find((candidate) => candidate.id === selectedId) ?? section;
  return { kind: "duplicateSection", sectionId: section.id, at: sectionEndBar(after) };
}

/** Whether a key press went to something that edits text, where Ctrl+C and Ctrl+V are the text's own. */
export function editsText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select") !== null;
}
