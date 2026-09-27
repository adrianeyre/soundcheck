import { expect, test } from "vitest";

import { createAudioTrack, createInstrumentTrack, createProject, type PatternClip } from "../project/model";
import { barTicks, tempoMapOf } from "../project/time";
import { copyTarget } from "./SectionLane";
import { clipPasteTarget, sectionPaste } from "./timeline-clipboard";

const BAR = barTicks({ beatsPerBar: 4, beatUnit: 4 });
const copied: PatternClip = { id: "keys-1", kind: "pattern", start: BAR, length: BAR * 2, notes: [] };

test("a Clip whose Track has gone pastes on the first Track that takes it, after where it was", () => {
  const project = createProject("Demo");
  project.tracks.push(createAudioTrack("Vocals", "vocals"), createInstrumentTrack("Pads", "pads"));
  const map = tempoMapOf(project);
  expect(clipPasteTarget(project, map, { kind: "clip", clip: copied, trackId: "keys" }, null)).toEqual({ trackId: "pads", start: BAR * 3 });
  // With no Track to take it, there is nowhere to paste.
  project.tracks.pop();
  expect(clipPasteTarget(project, map, { kind: "clip", clip: copied, trackId: "keys" }, null)).toBeNull();
});

test("a Section pastes after the one selected, or after itself, and not at all once it has gone", () => {
  const project = createProject("Demo");
  project.sections.push({ id: "verse", name: "Verse", startBar: 1, bars: 4 }, { id: "chorus", name: "Chorus", startBar: 5, bars: 2 });
  const verse = { kind: "section", sectionId: "verse", name: "Verse" } as const;
  expect(sectionPaste(project, verse, null)).toEqual({ kind: "duplicateSection", sectionId: "verse", at: 5 });
  expect(sectionPaste(project, verse, "chorus")).toEqual({ kind: "duplicateSection", sectionId: "verse", at: 7 });
  // A selection that has gone is no selection.
  expect(sectionPaste(project, verse, "bridge")?.at).toBe(5);
  project.sections.shift();
  expect(sectionPaste(project, verse, "chorus")).toBeNull();
});

test("a Section copied by dragging goes before the bar it was dropped on, or the nearer edge of a Section there", () => {
  const sections = [
    { id: "verse", name: "Verse", startBar: 1, bars: 4 },
    { id: "chorus", name: "Chorus", startBar: 5, bars: 4 },
  ];
  const [verse] = sections;
  expect(copyTarget(sections, verse!, 1)).toBeNull();
  expect(copyTarget(sections, verse!, 9)).toBe(9);
  expect(copyTarget(sections, verse!, 12)).toBe(12);
  // Inside the chorus, bars 5–8: the nearer of its edges.
  expect(copyTarget(sections, verse!, 6)).toBe(5);
  expect(copyTarget(sections, verse!, 8)).toBe(9);
  // Inside itself, the same: straight after itself, or before it.
  expect(copyTarget(sections, verse!, 4)).toBe(5);
  expect(copyTarget(sections, verse!, 2)).toBe(1);
});
