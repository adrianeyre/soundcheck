import { expect, test } from "vitest";

import { arrange, type ArrangementEdit, arrangementProblem } from "./arrangement";
import { applyCommand } from "./commands";
import { deepFreeze } from "./fixtures";
import { type AudioClip, createAudioTrack, createBus, createInstrumentTrack, createProject, type PatternClip, type Project } from "./model";
import { secondsAt, tempoMapOf, TICKS_PER_BEAT } from "./time";

const BAR = TICKS_PER_BEAT * 4;

/**
 * Twelve bars at 120 in 4/4: Verse (bars 1–4), Bridge (5–8, at 90 BPM) and
 * Chorus (9–12). The Keys have a Clip in each, one of which crosses from the
 * verse into the bridge; their volume fades up over the verse and the
 * bridge, and the Master's volume is automated only in the verse.
 */
function song(): Project {
  const project = createProject("Song");
  const keys = createInstrumentTrack("Keys", "keys");
  keys.clips.push(
    { id: "verse", kind: "pattern", start: 0, length: 2 * BAR, notes: [{ pitch: 60, start: 0, length: 480, velocity: 1 }] },
    {
      id: "across",
      kind: "pattern",
      start: 3 * BAR,
      length: 2 * BAR,
      notes: [
        { pitch: 62, start: 0, length: 2 * BAR, velocity: 1 },
        { pitch: 64, start: BAR + 480, length: 480, velocity: 0.5 },
      ],
    },
    { id: "chorus", kind: "pattern", start: 8 * BAR, length: BAR, notes: [{ pitch: 67, start: 0, length: 480, velocity: 1 }] },
  );
  keys.automation.push({
    setting: "volume",
    breakpoints: [
      { tick: 0, value: 0, hold: false },
      { tick: 8 * BAR, value: 1, hold: false },
    ],
  });
  project.tracks.push(keys);
  project.buses.push(createBus("Verb", "verb"));
  project.master.automation.push({
    setting: "volume",
    breakpoints: [
      { tick: 0, value: 0.5, hold: false },
      { tick: 2 * BAR, value: 1, hold: false },
    ],
  });
  project.tempoChanges.push(
    { id: "slow", tick: 4 * BAR, tempo: 90, timeSignature: null },
    { id: "back", tick: 8 * BAR, tempo: 120, timeSignature: null },
  );
  project.sections.push(
    { id: "verse-s", name: "Verse", startBar: 1, bars: 4 },
    { id: "bridge-s", name: "Bridge", startBar: 5, bars: 4 },
    { id: "chorus-s", name: "Chorus", startBar: 9, bars: 4 },
  );
  return deepFreeze(project);
}

function ids(): () => string {
  let next = 0;
  return () => `new-${++next}`;
}

function applied(project: Project, edit: ArrangementEdit): Project {
  const { arrangement } = arrange(project, edit, ids());
  const result = applyCommand(project, { type: "rearrange", arrangement });
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

function clips(project: Project, trackIndex = 0) {
  return project.tracks[trackIndex]!.clips.map(({ id, start, ...rest }) => ({
    id,
    start: start / BAR,
    ...("length" in rest ? { length: rest.length / BAR, notes: rest.notes } : {}),
  }));
}

function sections(project: Project) {
  return project.sections.map(({ name, startBar, bars }) => `${name} ${startBar}+${bars}`);
}

function tempoMap(project: Project) {
  return project.tempoChanges.map(({ tick, tempo, timeSignature }) => ({ bar: tick / BAR + 1, tempo, timeSignature }));
}

test("inserting bars moves everything from that bar on, splits the Clip across it, and holds the Automation's value through the new bars", () => {
  const before = song();
  const after = applied(before, { kind: "insertBars", at: 5, count: 2 });

  expect(clips(after)).toEqual([
    { id: "verse", start: 0, length: 2, notes: (before.tracks[0]!.clips[0] as PatternClip).notes },
    // The note sounding across bar 5 is cut there; the one after goes with the later part.
    { id: "across", start: 3, length: 1, notes: [{ pitch: 62, start: 0, length: BAR, velocity: 1 }] },
    { id: "new-1", start: 6, length: 1, notes: [{ pitch: 64, start: 480, length: 480, velocity: 0.5 }] },
    { id: "chorus", start: 10, length: 1, notes: [{ pitch: 67, start: 0, length: 480, velocity: 1 }] },
  ]);
  // The empty bars are at the verse's 120 BPM; the bridge's change moves with it.
  expect(tempoMap(after)).toEqual([
    { bar: 7, tempo: 90, timeSignature: null },
    { bar: 11, tempo: 120, timeSignature: null },
  ]);
  expect(after.tempoChanges.map((change) => change.id)).toEqual(["slow", "back"]);
  // The verse ends where the bars went in, so it doesn't grow; the rest move.
  expect(sections(after)).toEqual(["Verse 1+4", "Bridge 7+4", "Chorus 11+4"]);
  // The fade reaches half way at bar 5, stays there through the new bars, then carries on.
  expect(after.tracks[0]!.automation[0]!.breakpoints).toEqual([
    { tick: 0, value: 0, hold: false },
    { tick: 4 * BAR, value: 0.5, hold: false },
    { tick: 6 * BAR, value: 0.5, hold: false },
    { tick: 10 * BAR, value: 1, hold: false },
  ]);
  // A lane that ends before the new bars is left exactly as it was.
  expect(after.master.automation).toEqual(before.master.automation);
});

test("bars inserted inside a Section make it longer", () => {
  const after = applied(song(), { kind: "insertBars", at: 3, count: 1 });
  expect(sections(after)).toEqual(["Verse 1+5", "Bridge 6+4", "Chorus 10+4"]);
});

test("deleting bars takes what is in them, splits what crosses their edges and moves the rest up", () => {
  const before = song();
  // Bars 3 and 4, the end of the verse.
  const after = applied(before, { kind: "deleteBars", startBar: 3, bars: 2 });
  expect(clips(after)).toEqual([
    { id: "verse", start: 0, length: 2, notes: (before.tracks[0]!.clips[0] as PatternClip).notes },
    // Its bar 4 was deleted, with the note starting there; its bar 5 now starts at bar 3.
    { id: "new-1", start: 2, length: 1, notes: [{ pitch: 64, start: 480, length: 480, velocity: 0.5 }] },
    { id: "chorus", start: 6, length: 1, notes: [{ pitch: 67, start: 0, length: 480, velocity: 1 }] },
  ]);
  expect(sections(after)).toEqual(["Verse 1+2", "Bridge 3+4", "Chorus 7+4"]);
  expect(tempoMap(after)).toEqual([
    { bar: 3, tempo: 90, timeSignature: null },
    { bar: 7, tempo: 120, timeSignature: null },
  ]);
  expect(after.tempoChanges.map((change) => change.id)).toEqual(["slow", "back"]);
  // The fade steps from where it was at bar 3 to where it was at bar 5.
  const fade = after.tracks[0]!.automation[0]!.breakpoints;
  expect(fade.map(({ tick, hold }) => ({ tick, hold }))).toEqual([
    { tick: 0, hold: false },
    { tick: 2 * BAR - 1, hold: true },
    { tick: 2 * BAR, hold: false },
    { tick: 6 * BAR, hold: false },
  ]);
  expect(fade.map((point) => point.value)).toEqual([0, (2 * BAR - 1) / (8 * BAR), 0.5, 1]);
});

test("a Section deleted whole goes, and so does every Clip only in it", () => {
  const after = applied(song(), { kind: "deleteBars", startBar: 9, bars: 4 });
  expect(sections(after)).toEqual(["Verse 1+4", "Bridge 5+4"]);
  expect(after.tracks[0]!.clips.map((clip) => clip.id)).toEqual(["verse", "across"]);
  // What comes after the chorus is still at the 120 it went back to.
  expect(tempoMap(after)).toEqual([
    { bar: 5, tempo: 90, timeSignature: null },
    { bar: 9, tempo: 120, timeSignature: null },
  ]);
});

test("duplicating a Section copies its Clips, Automation and Tempo Changes into new bars after it", () => {
  const before = song();
  const { arrangement, section } = arrange(before, { kind: "duplicateSection", sectionId: "bridge-s", at: 9 }, ids());
  const result = applyCommand(before, { type: "rearrange", arrangement });
  if (!result.ok) throw new Error(result.error);
  const after = result.project;

  expect(section).toEqual({ id: "new-3", name: "Bridge", startBar: 9, bars: 4 });
  expect(sections(after)).toEqual(["Verse 1+4", "Bridge 5+4", "Bridge 9+4", "Chorus 13+4"]);
  // Only the bar of the Clip across the verse's end that is in the bridge is copied.
  expect(clips(after).map(({ id, start }) => `${id}@${start}`)).toEqual(["verse@0", "across@3", "new-1@8", "chorus@12"]);
  expect(clips(after)[2]!.notes).toEqual([{ pitch: 64, start: 480, length: 480, velocity: 0.5 }]);
  // The copy starts at 90 BPM like the original; the chorus still comes back to 120.
  expect(tempoMap(after)).toEqual([
    { bar: 5, tempo: 90, timeSignature: null },
    { bar: 13, tempo: 120, timeSignature: null },
  ]);
  // The fade over the bridge plays again over the copy: it steps back down
  // to the bridge's start, a tick before the copy.
  const fade = after.tracks[0]!.automation[0]!.breakpoints;
  expect(fade.map(({ tick, hold }) => ({ tick, hold }))).toEqual([
    { tick: 0, hold: false },
    { tick: 8 * BAR - 1, hold: true },
    { tick: 8 * BAR, hold: false },
    { tick: 12 * BAR, hold: false },
  ]);
  expect(fade.map((point) => point.value)).toEqual([0, (8 * BAR - 1) / (8 * BAR), 0.5, 1]);
  // The copy lasts as long as the original.
  const map = tempoMapOf(after);
  expect(secondsAt(map, 12 * BAR) - secondsAt(map, 8 * BAR)).toBeCloseTo(secondsAt(map, 8 * BAR) - secondsAt(map, 4 * BAR), 9);
});

test("duplicating the first Section to the start of the song copies it before itself", () => {
  const after = applied(song(), { kind: "duplicateSection", sectionId: "verse-s", at: 1 });
  expect(sections(after)).toEqual(["Verse 1+4", "Verse 5+4", "Bridge 9+4", "Chorus 13+4"]);
  // The copy has new ids; the original keeps its own.
  expect(after.tracks[0]!.clips.map((clip) => `${clip.id}@${clip.start / BAR}`)).toEqual([
    "new-1@0",
    "new-2@3",
    "verse@4",
    "across@7",
    "chorus@12",
  ]);
  expect(after.sections[1]!.id).toBe("verse-s");
});

test("moving a Section earlier swaps it with the one before, taking its tempo with it", () => {
  const before = song();
  const after = applied(before, { kind: "moveSection", sectionId: "bridge-s", to: 1 });
  expect(sections(after)).toEqual(["Bridge 1+4", "Verse 5+4", "Chorus 9+4"]);
  // The song now starts at the bridge's 90, and the verse gets its 120 back.
  expect(after.tempo).toBe(90);
  expect(tempoMap(after)).toEqual([{ bar: 5, tempo: 120, timeSignature: null }]);
  expect(after.tracks[0]!.clips.map((clip) => `${clip.id}@${clip.start / BAR}`)).toEqual([
    "new-1@0",
    "verse@4",
    "across@7",
    "chorus@8",
  ]);
  expect(after.sections.find((section) => section.name === "Bridge")!.id).toBe("bridge-s");
});

test("moving a Section later puts it before the bar it is moved to, as the song is now", () => {
  const after = applied(song(), { kind: "moveSection", sectionId: "verse-s", to: 9 });
  expect(sections(after)).toEqual(["Bridge 1+4", "Verse 5+4", "Chorus 9+4"]);
  expect(after.tempo).toBe(90);
  expect(tempoMap(after)).toEqual([{ bar: 5, tempo: 120, timeSignature: null }]);
});

test("a time signature in a moved Section goes with it, and the bars after it get theirs back", () => {
  const project = structuredClone(song()) as Project;
  project.tempoChanges = [{ id: "waltz", tick: 4 * BAR, tempo: null, timeSignature: { beatsPerBar: 3, beatUnit: 4 } }];
  // The bridge's four bars of 3/4 end at 4 bars of 4/4 and 4 of 3/4.
  const waltz = (BAR * 3) / 4;
  project.tempoChanges.push({ id: "four", tick: 4 * BAR + 4 * waltz, tempo: null, timeSignature: { beatsPerBar: 4, beatUnit: 4 } });
  project.tracks[0]!.clips = [];
  const after = applied(project, { kind: "moveSection", sectionId: "bridge-s", to: 1 });
  expect(after.timeSignature).toEqual({ beatsPerBar: 3, beatUnit: 4 });
  expect(after.tempoChanges.map(({ tick, timeSignature }) => ({ tick, timeSignature }))).toEqual([
    { tick: 4 * waltz, timeSignature: { beatsPerBar: 4, beatUnit: 4 } },
  ]);
});

test("an Audio Clip split at an edit's edge plays on in its file from where the earlier part stopped", () => {
  const project = structuredClone(song()) as Project;
  project.tempoChanges = [];
  const vocal = createAudioTrack("Vocal", "vocal");
  // Four seconds from bar 4: two bars at 120.
  vocal.clips.push({ id: "take", kind: "audio", start: 3 * BAR, duration: 4, file: "audio/take.wav", fileOffset: 1 });
  project.tracks.push(vocal);
  const after = applied(project, { kind: "insertBars", at: 5, count: 1 });
  expect(after.tracks[1]!.clips as AudioClip[]).toEqual([
    { id: "take", kind: "audio", start: 3 * BAR, duration: 2, file: "audio/take.wav", fileOffset: 1 },
    // (new-1 is the Keys' Clip across bar 5.)
    { id: "new-2", kind: "audio", start: 5 * BAR, duration: 2, file: "audio/take.wav", fileOffset: 3 },
  ]);
});

test("an edit that can't be made says why", () => {
  const project = song();
  expect(arrangementProblem(project, { kind: "insertBars", at: 0, count: 1 })).toBe("at must be a whole bar number, 1 or more, not 0");
  expect(arrangementProblem(project, { kind: "deleteBars", startBar: 2, bars: 1.5 })).toBe("bars must be a whole number of bars, 1 or more, not 1.5");
  expect(arrangementProblem(project, { kind: "duplicateSection", sectionId: "nope", at: 1 })).toBe("There is no Section nope");
  expect(arrangementProblem(project, { kind: "duplicateSection", sectionId: "verse-s", at: 7 })).toBe(
    "Bar 7 is inside the Section “Bridge” (bars 5–8): put it before bar 5 or bar 9 instead",
  );
  expect(arrangementProblem(project, { kind: "moveSection", sectionId: "bridge-s", to: 9 })).toBe(
    "The Section “Bridge” is already there: to is where it goes as the song is now, so move it before another Section's startBar or after one ends",
  );
  expect(() => arrange(project, { kind: "moveSection", sectionId: "bridge-s", to: 7 })).toThrow("already there");
});

test("rearrange refuses an arrangement that leaves out a Track", () => {
  const project = song();
  const { arrangement } = arrange(project, { kind: "insertBars", at: 2, count: 1 });
  const result = applyCommand(project, { type: "rearrange", arrangement: { ...arrangement, tracks: [] } });
  expect(result).toEqual({ ok: false, error: "A rearrangement must list every Track once" });
});
