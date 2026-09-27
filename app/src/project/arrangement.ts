/**
 * Arrangement edits: inserting and deleting bars, and duplicating and
 * moving a Section. The Section Lane and the Assistant's arrangement tools
 * both make them here, and both apply the result as one `rearrange`
 * command, so each is one undo step.
 *
 * Every edit lays the song out again as pieces of the song as it is, in
 * order: a copy of a bar range, or empty bars. A piece takes everything in
 * its bars with it, on every Track, Bus and the Master: the Clips, the
 * Automation and the Tempo Changes, and the tempo and time signature it
 * started with. So a piece sounds where it lands as it did where it was.
 *
 * A Clip across a piece's edge is split there, not dropped: each part keeps
 * the stretch of the Clip in its own piece. A Pattern Clip's notes go with
 * the part they start in, and one still sounding at the edge is cut there,
 * as a note past its Clip's end always is. An Audio Clip's later part plays
 * on in its file from where the earlier part stopped. The part that starts
 * where the Clip started keeps its id; the others, and every copy, get new
 * ids. Automation is cut at a piece's edge in the same way: each piece keeps
 * its values, with a breakpoint added at the edge where the value changes.
 *
 * Sections are whole bars, so they are worked out in bars: a Section in the
 * bars an edit makes room in grows, one in bars it deletes shrinks or goes,
 * and the rest move with their bars.
 */
import {
  type Automation,
  type Breakpoint,
  type Clip,
  clipEnd,
  newId,
  type Project,
  type Section,
  type TempoChange,
} from "./model";
import { sectionBarsText, sectionEndBar } from "./sections";
import { barStart, barTicks, sameSignature, secondsBetween, segmentAt, type TempoMap, tempoMapOf, type TimeSignature } from "./time";

/** One arrangement edit, in bars counting from 1, as the musician counts them. */
export type ArrangementEdit =
  /** `count` empty bars before bar `at`: everything from bar `at` on moves later. */
  | { kind: "insertBars"; at: number; count: number }
  /** `bars` bars from `startBar` go, with everything in them, and what came after moves up. */
  | { kind: "deleteBars"; startBar: number; bars: number }
  /** A copy of the Section and everything in its bars, before bar `at`, which makes room for it. */
  | { kind: "duplicateSection"; sectionId: string; at: number }
  /**
   * The Section and everything in its bars, taken out and put back before
   * bar `to` as the song is now: another Section's startBar, or the bar after
   * one ends.
   */
  | { kind: "moveSection"; sectionId: string; to: number };

/**
 * Everything in the Project that is laid out in time, as `rearrange` sets
 * it: the tempo map, the Sections, and every Track's Clips and every
 * channel's Automation.
 */
export interface Arrangement {
  tempo: number;
  timeSignature: TimeSignature;
  tempoChanges: TempoChange[];
  sections: Section[];
  tracks: { trackId: string; clips: Clip[]; automation: Automation[] }[];
  buses: { busId: string; automation: Automation[] }[];
  masterAutomation: Automation[];
}

/** An edit worked out: the song it makes, and what it did, for the musician and the model. */
export interface Arranged {
  arrangement: Arrangement;
  /** How many Clips were split at an edit's edge, or had a part copied. */
  split: number;
  /** How many Clips went with the bars they were in. */
  removed: number;
  /** The Section a duplicate made, or the one moved. */
  section?: Section;
}

/** A stretch of the song as it is, in bars, or `gap` empty bars. */
type Piece = { from: number; to: number; copy?: boolean } | { gap: number };

/** Why `edit` can't be made on `project`, in words the musician and the model both read, or null. */
export function arrangementProblem(project: Project, edit: ArrangementEdit): string | null {
  switch (edit.kind) {
    case "insertBars":
      return bar(edit.at, "at") ?? count(edit.count, "count");
    case "deleteBars":
      return bar(edit.startBar, "startBar") ?? count(edit.bars, "bars");
    case "duplicateSection":
    case "moveSection": {
      const section = project.sections.find((candidate) => candidate.id === edit.sectionId);
      if (!section) return `There is no Section ${edit.sectionId}`;
      const at = edit.kind === "duplicateSection" ? edit.at : edit.to;
      const what = edit.kind === "duplicateSection" ? "at" : "to";
      const wrong = bar(at, what);
      if (wrong) return wrong;
      if (edit.kind === "moveSection" && at >= section.startBar && at <= sectionEndBar(section)) {
        return `The Section “${section.name}” is already there: to is where it goes as the song is now, so move it before another Section's startBar or after one ends`;
      }
      const inside = project.sections.find((other) => other.startBar < at && at < sectionEndBar(other));
      if (inside) {
        return `Bar ${at} is inside the Section “${inside.name}” (${sectionBarsText(inside)}): put it before bar ${inside.startBar} or bar ${sectionEndBar(inside)} instead`;
      }
      return null;
    }
  }
}

function bar(value: number, what: string): string | null {
  return Number.isInteger(value) && value >= 1 ? null : `${what} must be a whole bar number, 1 or more, not ${value}`;
}

function count(value: number, what: string): string | null {
  return Number.isInteger(value) && value >= 1 ? null : `${what} must be a whole number of bars, 1 or more, not ${value}`;
}

/**
 * Work out `edit` on `project`: the song it makes, to set with `rearrange`.
 * Throws if `arrangementProblem` has a problem with it. New ids come from
 * `makeId`.
 */
export function arrange(project: Project, edit: ArrangementEdit, makeId: () => string = newId): Arranged {
  const problem = arrangementProblem(project, edit);
  if (problem) throw new Error(problem);
  const map = tempoMapOf(project);
  const pieces = piecesOf(project, edit);
  const layout = laidOut(pieces, map);

  let split = 0;
  let removed = 0;
  const tracks = project.tracks.map((track) => {
    const clips: Clip[] = [];
    for (const clip of track.clips as Clip[]) {
      const parts = clipParts(clip, layout, map, makeId);
      if (parts.some((part) => !part.whole)) split++;
      if (parts.every((part) => part.copied)) removed++;
      clips.push(...parts.map((part) => part.clip));
    }
    clips.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    return { trackId: track.id, clips, automation: rearrangedAutomation(track.automation, layout) };
  });
  const { tempo, timeSignature, tempoChanges } = rearrangedTempo(project, layout, map, makeId);
  const { sections, section } = rearrangedSections(project.sections, edit, makeId);
  return {
    arrangement: {
      tempo,
      timeSignature,
      tempoChanges,
      sections,
      tracks,
      buses: project.buses.map((bus) => ({ busId: bus.id, automation: rearrangedAutomation(bus.automation, layout) })),
      masterAutomation: rearrangedAutomation(project.master.automation, layout),
    },
    split,
    removed,
    ...(section ? { section } : {}),
  };
}

/** The pieces `edit` lays the song out in. The last runs to the end of the song. */
function piecesOf(project: Project, edit: ArrangementEdit): Piece[] {
  const end = Infinity;
  const pieces: Piece[] = (() => {
    switch (edit.kind) {
      case "insertBars":
        return [{ from: 1, to: edit.at }, { gap: edit.count }, { from: edit.at, to: end }];
      case "deleteBars":
        return [
          { from: 1, to: edit.startBar },
          { from: edit.startBar + edit.bars, to: end },
        ];
      case "duplicateSection": {
        const section = project.sections.find((candidate) => candidate.id === edit.sectionId)!;
        return [
          { from: 1, to: edit.at },
          { from: section.startBar, to: sectionEndBar(section), copy: true },
          { from: edit.at, to: end },
        ];
      }
      case "moveSection": {
        const section = project.sections.find((candidate) => candidate.id === edit.sectionId)!;
        const [a, b, x] = [section.startBar, sectionEndBar(section), edit.to];
        return x < a
          ? [
              { from: 1, to: x },
              { from: a, to: b },
              { from: x, to: a },
              { from: b, to: end },
            ]
          : [
              { from: 1, to: a },
              { from: b, to: x },
              { from: a, to: b },
              { from: x, to: end },
            ];
      }
    }
  })();
  return pieces.filter((piece) => "gap" in piece || piece.from < piece.to);
}

/**
 * A piece in ticks: `start` to `end` of the song as it is (`end` Infinity
 * for the last), landing at `at`. Empty bars have no `start`: they hold what
 * came before them, `value` of it for Automation.
 */
interface Placed {
  start: number;
  end: number;
  at: number;
  copy: boolean;
  gap: boolean;
}

function laidOut(pieces: readonly Piece[], map: TempoMap): Placed[] {
  const placed: Placed[] = [];
  let at = 0;
  for (const piece of pieces) {
    if ("gap" in piece) {
      // Empty bars in the time signature of the bar before them: where they
      // start is where the song as it is carries on after them.
      const next = pieces[pieces.indexOf(piece) + 1];
      const resume = next && !("gap" in next) ? barStart(map, next.from) : 0;
      const length = piece.gap * barTicks(segmentAt(map, Math.max(0, resume - 1)).timeSignature);
      placed.push({ start: resume, end: resume, at, copy: false, gap: true });
      at += length;
      continue;
    }
    const start = barStart(map, piece.from);
    const end = piece.to === Infinity ? Infinity : barStart(map, piece.to);
    placed.push({ start, end, at, copy: piece.copy ?? false, gap: false });
    at += end - start;
  }
  return placed;
}

/** A Clip's parts in each piece it has a stretch in: `copied` where the piece is a copy, `whole` if it is all of the Clip. */
function clipParts(clip: Clip, layout: readonly Placed[], map: TempoMap, makeId: () => string): ClipPart[] {
  const start = clip.start;
  const end = clipEnd(clip, map);
  const parts: ClipPart[] = [];
  for (const piece of layout) {
    if (piece.gap) continue;
    const from = Math.max(start, piece.start);
    const to = Math.min(end, piece.end);
    // An Audio Clip's end is fractional: a sliver under a tick is nothing heard.
    if (to - from < 1) continue;
    const id = !piece.copy && from === start ? clip.id : makeId();
    const moved = from - piece.start + piece.at;
    const part = { copied: piece.copy, whole: from === start && to === end };
    if (clip.kind === "pattern") {
      const cut = to < end;
      const notes = clip.notes
        .filter((note) => start + note.start >= from && start + note.start < to)
        .map((note) => {
          const noteStart = start + note.start - from;
          return { ...note, start: noteStart, length: cut ? Math.min(note.length, to - from - noteStart) : note.length };
        });
      parts.push({ ...part, clip: { ...clip, id, start: moved, length: to - from, notes } });
    } else {
      const skipped = from > start ? secondsBetween(map, start, from) : 0;
      const duration = to === end ? clip.duration - skipped : secondsBetween(map, from, to);
      parts.push({ ...part, clip: { ...clip, id, start: moved, fileOffset: clip.fileOffset + skipped, duration } });
    }
  }
  return parts;
}

interface ClipPart {
  clip: Clip;
  copied: boolean;
  whole: boolean;
}

/** A breakpoint, and whether it was added at a piece's edge (and may go again if it changes nothing). */
type Point = Breakpoint & { added: boolean };

function rearrangedAutomation(automation: readonly Automation[], layout: readonly Placed[]): Automation[] {
  return automation.map((lane) => ({ setting: lane.setting, breakpoints: rearrangedLane(lane.breakpoints, layout) }));
}

function rearrangedLane(breakpoints: readonly Breakpoint[], layout: readonly Placed[]): Breakpoint[] {
  const points: Point[] = [];
  /** The value the last piece was heading for at its end, and the tick before it, where it can step from. */
  let left: { value: number; before: number; at: number } | null = null;
  for (const piece of layout) {
    // Empty bars hold the value the song as it is carries on with after them.
    const value = valueAt(breakpoints, piece.start);
    if (left && !near(left.value, value)) {
      const last = points.at(-1);
      if (last && last.tick === left.at - 1) last.hold = true;
      else points.push({ tick: left.at - 1, value: left.before, hold: true, added: true });
    }
    const own = !piece.gap ? breakpoints.find((point) => point.tick === piece.start) : undefined;
    points.push(
      own
        ? { ...own, tick: piece.at, added: false }
        : { tick: piece.at, value, hold: piece.gap ? false : holdsAt(breakpoints, piece.start), added: true },
    );
    if (piece.gap) {
      const next = layout[layout.indexOf(piece) + 1];
      const end = next ? next.at : piece.at;
      left = { value, before: value, at: end };
      continue;
    }
    for (const point of breakpoints) {
      if (point.tick > piece.start && point.tick < piece.end) points.push({ ...point, tick: point.tick - piece.start + piece.at, added: false });
    }
    left =
      piece.end === Infinity
        ? null
        : { value: valueBefore(breakpoints, piece.end), before: valueAt(breakpoints, piece.end - 1), at: piece.end - piece.start + piece.at };
  }
  return withoutRedundant(points).map(({ tick, value, hold }) => ({ tick, value, hold }));
}

/** A lane's value at `tick`: a breakpoint there gives its own. */
export function valueAt(points: readonly Breakpoint[], tick: number): number {
  const index = points.findLastIndex((point) => point.tick <= tick);
  if (index < 0) return points[0]!.value;
  const point = points[index]!;
  const next = points[index + 1];
  if (!next || point.hold) return point.value;
  return point.value + ((next.value - point.value) * (tick - point.tick)) / (next.tick - point.tick);
}

/** The value a lane is heading for as it reaches `tick`, before a breakpoint there steps it. */
function valueBefore(points: readonly Breakpoint[], tick: number): number {
  const index = points.findLastIndex((point) => point.tick < tick);
  if (index < 0) return points[0]!.value;
  const point = points[index]!;
  const next = points[index + 1];
  if (!next || point.hold) return point.value;
  return point.value + ((next.value - point.value) * (tick - point.tick)) / (next.tick - point.tick);
}

/** Whether the lane holds, rather than ramps, from `tick` to its next breakpoint. */
function holdsAt(points: readonly Breakpoint[], tick: number): boolean {
  return points.findLast((point) => point.tick <= tick)?.hold ?? false;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Take away the breakpoints added at the edges that change nothing heard,
 * so a lane the edit didn't change comes out exactly as it went in. The
 * musician's own breakpoints always stay.
 */
function withoutRedundant(input: Point[]): Point[] {
  const points = [...input];
  for (let changed = true; changed && points.length > 1; ) {
    changed = false;
    for (let index = 0; index < points.length && points.length > 1; index++) {
      const point = points[index]!;
      if (!point.added) continue;
      const previous = points[index - 1];
      const next = points[index + 1];
      let redundant: boolean;
      if (!previous) redundant = near(point.value, next!.value);
      else if (!next) redundant = near(previous.value, point.value);
      else if (previous.hold) redundant = near(point.value, previous.value) && (point.hold || near(point.value, next.value));
      else {
        const onLine = previous.value + ((next.value - previous.value) * (point.tick - previous.tick)) / (next.tick - previous.tick);
        redundant = near(onLine, point.value) && (!point.hold || near(point.value, next.value));
      }
      if (redundant) {
        points.splice(index, 1);
        changed = true;
        index--;
      }
    }
  }
  return points;
}

/**
 * The tempo map laid out again. Each piece starts with the tempo and time
 * signature it had, with a Tempo Change where that isn't what the song is
 * at by then, and brings its own Tempo Changes; empty bars carry on with
 * what came before them.
 */
function rearrangedTempo(
  project: Project,
  layout: readonly Placed[],
  map: TempoMap,
  makeId: () => string,
): Pick<Arrangement, "tempo" | "timeSignature" | "tempoChanges"> {
  const first = segmentAt(map, layout[0]?.start ?? 0);
  const start = { tempo: first.tempo, timeSignature: structuredClone(first.timeSignature) };
  let { tempo, timeSignature } = start;
  const changes: TempoChange[] = [];
  const add = (change: TempoChange) => {
    tempo = change.tempo ?? tempo;
    timeSignature = change.timeSignature ?? timeSignature;
    if (change.tempo !== null || change.timeSignature !== null) changes.push(change);
  };
  for (const piece of layout) {
    if (piece.gap) continue;
    // The song starts with the first piece's tempo and time signature.
    if (piece.at > 0) {
      const segment = segmentAt(map, piece.start);
      const own = project.tempoChanges.find((change) => change.tick === piece.start);
      add({
        id: own && !piece.copy ? own.id : makeId(),
        tick: piece.at,
        // Only what the song isn't at by then: a change back to a tempo it already has is gone.
        tempo: segment.tempo !== tempo ? segment.tempo : null,
        timeSignature: !sameSignature(segment.timeSignature, timeSignature) ? structuredClone(segment.timeSignature) : null,
      });
    }
    for (const change of project.tempoChanges) {
      if (change.tick > piece.start && change.tick < piece.end) {
        add({ ...structuredClone(change), id: piece.copy ? makeId() : change.id, tick: change.tick - piece.start + piece.at });
      }
    }
  }
  return { ...start, tempoChanges: changes };
}

/** `sections` with `bars` bars inserted before bar `at`: one they go inside grows. */
function insertedSections(sections: readonly Section[], at: number, bars: number): Section[] {
  return sections.map((section) =>
    section.startBar >= at
      ? { ...section, startBar: section.startBar + bars }
      : at < sectionEndBar(section)
        ? { ...section, bars: section.bars + bars }
        : { ...section },
  );
}

function byBar(sections: Section[]): Section[] {
  return sections.toSorted((a, b) => a.startBar - b.startBar);
}

function rearrangedSections(
  sections: readonly Section[],
  edit: ArrangementEdit,
  makeId: () => string,
): { sections: Section[]; section?: Section } {
  switch (edit.kind) {
    case "insertBars":
      return { sections: insertedSections(sections, edit.at, edit.count) };
    case "deleteBars": {
      const { startBar, bars } = edit;
      const end = startBar + bars;
      const kept: Section[] = [];
      for (const section of sections) {
        const sectionEnd = sectionEndBar(section);
        const before = Math.max(0, Math.min(sectionEnd, startBar) - section.startBar);
        const after = Math.max(0, sectionEnd - Math.max(section.startBar, end));
        if (before + after === 0) continue;
        const from = section.startBar < startBar ? section.startBar : section.startBar >= end ? section.startBar - bars : startBar;
        kept.push({ ...section, startBar: from, bars: before + after });
      }
      return { sections: kept };
    }
    case "duplicateSection": {
      const source = sections.find((candidate) => candidate.id === edit.sectionId)!;
      const copy: Section = { id: makeId(), name: source.name, startBar: edit.at, bars: source.bars };
      return { sections: byBar([...insertedSections(sections, edit.at, source.bars), copy]), section: copy };
    }
    case "moveSection": {
      const moving = sections.find((candidate) => candidate.id === edit.sectionId)!;
      const { bars } = moving;
      const [a, b, x] = [moving.startBar, sectionEndBar(moving), edit.to];
      const moved: Section = { ...moving, startBar: x < a ? x : x - bars };
      const others = sections
        .filter((section) => section !== moving)
        .map((section) => {
          if (x < a && section.startBar >= x && section.startBar < a) return { ...section, startBar: section.startBar + bars };
          if (x > a && section.startBar >= b && section.startBar < x) return { ...section, startBar: section.startBar - bars };
          return { ...section };
        });
      return { sections: byBar([...others, moved]), section: moved };
    }
  }
}
