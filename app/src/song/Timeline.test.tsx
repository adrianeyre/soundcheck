// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { Command } from "../project/commands";
import { ProjectHistory } from "../project/history";
import { type AudioTrack, createAudioTrack, createBus, createDrumTrack, createEffect, createInstrumentTrack, createProject, type InstrumentTrack, type Project, trackKind } from "../project/model";
import { barTicks } from "../project/time";
import type { Waveform } from "./import-audio";
import { type AbsentAudio, LABEL_WIDTH, Timeline } from "./Timeline";
import { DEFAULT_ZOOM } from "./timeline-view";

afterEach(cleanup);

const SIGNATURE = { beatsPerBar: 4, beatUnit: 4 };
const BAR = barTicks(SIGNATURE);
/** One bar is this many pixels at the default zoom, so a bar is a bar's drag. */
const BAR_PX = DEFAULT_ZOOM;

function project(): Project {
  const base = createProject("Demo");
  const keys = createInstrumentTrack("Keys", "keys");
  keys.clips.push({
    id: "keys-1",
    kind: "pattern",
    start: 0,
    length: BAR * 2,
    notes: [{ pitch: 60, start: 0, length: 240, velocity: 0.8 }],
  });
  const bass = createInstrumentTrack("Bass", "bass");
  const vocals = createAudioTrack("Vocals", "vocals");
  base.tracks.push(keys, bass, vocals);
  return base;
}

/**
 * The Timeline over a real history, so every test can check that what it did
 * reached the Project and can be undone.
 */
function setUp(start: Project = project(), waveforms?: ReadonlyMap<string, Waveform>, absentAudio?: ReadonlyMap<string, AbsentAudio>) {
  const history = new ProjectHistory(start);
  const onLoopRegion = vi.fn<(start: number, end: number) => void>();
  const onSelectSection = vi.fn<(sectionId: string | null) => void>();
  const errors: string[] = [];
  let selected: string | null = null;

  const view = render(<Timeline {...timelineProps()} />);
  function timelineProps() {
    return {
      project: history.project,
      selectedClipId: selected,
      position: null,
      loop: { start: 0, end: BAR, enabled: false },
      clipBars: 4,
      onSelectClip: (id: string | null) => {
        selected = id;
        view.rerender(<Timeline {...timelineProps()} />);
      },
      onCommands: (commands: Command[], label: string) => {
        const result = history.execute(commands, label);
        if (!result.ok) errors.push(result.error);
        view.rerender(<Timeline {...timelineProps()} />);
      },
      onLoopRegion,
      onSelectSection,
      waveforms,
      absentAudio,
    };
  }

  const clips = (trackId: string) => history.project.tracks.find((t) => t.id === trackId)!.clips;
  /** Undoes as the app does, drawing the Project it goes back to. */
  const undo = () => {
    history.undo();
    view.rerender(<Timeline {...timelineProps()} />);
  };
  return { history, clips, errors, onLoopRegion, onSelectSection, selectedId: () => selected, undo };
}

const clip = (name: string) => screen.queryByLabelText(name) ?? screen.getByTitle(name);
/** The strokes an Audio Clip's waveform is drawn with. */
const drawn = () => screen.getByLabelText("Waveform").querySelector("path")!.getAttribute("d")!;
const lane = (name: string) => screen.getByLabelText(`${name} lane`);
const tempoChange = () => screen.getByRole("button", { name: /^Tempo Change at/ });

/** A drag of `bars` bars on `element`, starting at `fromBar` bars across. */
function dragBy(element: Element, bars: number, options: MouseEventInit = {}, over = element) {
  fireEvent.mouseDown(element, { clientX: 0, ...options });
  fireEvent.mouseMove(over, { clientX: bars * BAR_PX, ...options });
  fireEvent.mouseUp(over, { clientX: bars * BAR_PX, ...options });
}

test("dragging a Clip moves it to an exact grid position", () => {
  const { clips, history } = setUp();
  // Two and a bit bars to the right: the Clip lands on bar 3, not on the
  // pixel the mouse let go at.
  dragBy(clip("Keys Clip 1"), 2.3);
  expect(clips("keys")[0]).toMatchObject({ id: "keys-1", start: BAR * 2 });

  expect(history.undo()).toBe(true);
  expect(clips("keys")[0]).toMatchObject({ start: 0 });
  history.redo();
  expect(clips("keys")[0]).toMatchObject({ start: BAR * 2 });
});

test("a finer grid snaps to beats, and Alt ignores the grid altogether", () => {
  const { clips } = setUp();
  fireEvent.change(screen.getByLabelText("Snap"), { target: { value: "beat" } });
  dragBy(clip("Keys Clip 1"), 0.3);
  // 0.3 of a bar is 1.2 beats, which snaps to one beat.
  expect(clips("keys")[0]!.start).toBe(960);

  fireEvent.change(screen.getByLabelText("Snap"), { target: { value: "bar" } });
  dragBy(clip("Keys Clip 1"), 1, { altKey: true });
  // Held free of the grid, it goes exactly where it was dropped.
  expect(clips("keys")[0]!.start).toBe(960 + BAR);
});

test("dragging a Clip's edges trims it, and its notes stay where they sounded", () => {
  const { clips, history } = setUp();
  dragBy(clip("Trim the start of Keys Clip 1"), 0.6);
  // The Clip now starts at bar 2 and still ends where it did; the note that
  // was at its old start is outside it now, so it is gone.
  expect(clips("keys")[0]).toMatchObject({ start: BAR, length: BAR });
  expect(clips("keys")[0]).toHaveProperty("notes", []);

  dragBy(clip("Trim the end of Keys Clip 1"), 1.2);
  expect(clips("keys")[0]).toMatchObject({ start: BAR, length: BAR * 2 });
  // A Clip can't be trimmed away to nothing: one grid step is the shortest.
  dragBy(clip("Trim the end of Keys Clip 1"), -9);
  expect(clips("keys")[0]).toMatchObject({ start: BAR, length: BAR });

  history.undo();
  history.undo();
  history.undo();
  expect(clips("keys")[0]).toMatchObject({ start: 0, length: BAR * 2 });
});

test("Ctrl-dragging copies a Clip instead of moving it, and the copy is selected", () => {
  const { clips, selectedId } = setUp();
  dragBy(clip("Keys Clip 1"), 2, { ctrlKey: true });
  expect(clips("keys").map((c) => c.start)).toEqual([0, BAR * 2]);
  expect(clips("keys")[1]).toHaveProperty("notes", [{ pitch: 60, start: 0, length: 240, velocity: 0.8 }]);
  expect(clips("keys")[1]!.id).not.toBe("keys-1");
  expect(selectedId()).toBe(clips("keys")[1]!.id);
});

test("a Clip is dragged onto another Instrument Track, but never onto an Audio Track", () => {
  const { clips, errors } = setUp();
  // The pointer moves over the Bass lane, so that is where it is dropped.
  dragBy(clip("Keys Clip 1"), 1, {}, lane("Bass"));
  expect(clips("keys")).toEqual([]);
  expect(clips("bass")[0]).toMatchObject({ id: "keys-1", start: BAR });

  dragBy(clip("Bass Clip 1"), 0, {}, lane("Vocals"));
  // Refused, with the reason, and the Clip stays put.
  expect(errors).toEqual(["A Clip can only move to another Instrument Track"]);
  expect(clips("bass")).toHaveLength(1);
  expect(clips("vocals")).toEqual([]);
});

test("the keyboard moves, trims, copies and deletes the selected Clip", () => {
  const { clips, errors, history, selectedId } = setUp();
  const keys = () => clip("Keys Clip 1");
  fireEvent.click(keys());
  expect(keys()).toHaveAttribute("aria-pressed", "true");

  fireEvent.keyDown(keys(), { key: "ArrowRight" });
  expect(clips("keys")[0]!.start).toBe(BAR);
  fireEvent.keyDown(keys(), { key: "ArrowLeft" });
  expect(clips("keys")[0]!.start).toBe(0);

  fireEvent.keyDown(keys(), { key: "ArrowRight", shiftKey: true });
  expect(clips("keys")[0]).toMatchObject({ length: BAR * 3 });
  fireEvent.keyDown(keys(), { key: "ArrowRight", altKey: true });
  expect(clips("keys")[0]).toMatchObject({ start: BAR, length: BAR * 2 });

  // Down a Track, then refused when the next Track down is an Audio Track.
  fireEvent.keyDown(keys(), { key: "ArrowDown" });
  expect(clips("bass")).toHaveLength(1);
  fireEvent.keyDown(clip("Bass Clip 1"), { key: "ArrowDown" });
  expect(errors).toEqual(["A Clip can only move to another Instrument Track"]);

  fireEvent.keyDown(clip("Bass Clip 1"), { key: "d", ctrlKey: true });
  expect(clips("bass").map((c) => c.start)).toEqual([BAR, BAR * 3]);
  expect(selectedId()).toBe(clips("bass")[1]!.id);

  fireEvent.keyDown(clip("Bass Clip 2"), { key: "Delete" });
  expect(clips("bass")).toHaveLength(1);
  expect(selectedId()).toBe(null);

  // Deleting and copying undo like everything else.
  expect(history.undoLabel).toBe("Delete Clip");
  history.undo();
  expect(clips("bass")).toHaveLength(2);
  history.undo();
  expect(clips("bass")).toHaveLength(1);
});

test("double-clicking an empty lane places a Clip on the grid", () => {
  const { clips, selectedId } = setUp();
  fireEvent.doubleClick(lane("Bass"), { clientX: BAR_PX * 1.7 });
  expect(clips("bass")[0]).toMatchObject({ kind: "pattern", start: BAR * 2, length: BAR * 4, notes: [] });
  expect(selectedId()).toBe(clips("bass")[0]!.id);

  // An Audio Track takes no Pattern Clip: an Audio Clip needs a file (#17).
  fireEvent.doubleClick(lane("Vocals"), { clientX: BAR_PX });
  expect(clips("vocals")).toEqual([]);
});

test("dragging on the ruler sets the loop region, snapped", () => {
  const { onLoopRegion } = setUp();
  dragBy(screen.getByLabelText("Ruler"), 3.4);
  expect(onLoopRegion).toHaveBeenLastCalledWith(0, BAR * 3);

  fireEvent.mouseDown(screen.getByLabelText("Ruler"), { clientX: BAR_PX * 4 });
  fireEvent.mouseUp(window, { clientX: BAR_PX * 2 });
  // Dragged right to left, it still reads low to high.
  expect(onLoopRegion).toHaveBeenLastCalledWith(BAR * 2, BAR * 4);
});

test("zooming changes how wide a bar is drawn, and so what a drag means", () => {
  const { clips } = setUp();
  fireEvent.click(screen.getByLabelText("Zoom out"));
  expect(screen.getByLabelText("Zoom")).toHaveTextContent(`${DEFAULT_ZOOM / 2} px/bar`);
  // Zoomed out, the same pixels are twice as much music.
  dragBy(clip("Keys Clip 1"), 1);
  expect(clips("keys")[0]!.start).toBe(BAR * 2);

  fireEvent.click(screen.getByLabelText("Zoom in"));
  fireEvent.click(screen.getByLabelText("Zoom in"));
  expect(screen.getByLabelText("Zoom")).toHaveTextContent(`${DEFAULT_ZOOM * 2} px/bar`);
});

test("an Audio Clip shows its waveform, and trimming its start moves where in the file it plays from", () => {
  const start = project();
  const vocals = start.tracks.find((t) => t.id === "vocals")!;
  if (vocals.kind !== "audio") throw new Error("not an Audio Track");
  // Two bars is four seconds at 120 bpm.
  vocals.clips.push({ id: "take", kind: "audio", start: 0, duration: 4, file: "audio/take.wav", fileOffset: 0 });
  const waveform = { seconds: 4, peaks: [0.1, 0.9, 0.5, 0.2] };
  const { clips, history } = setUp(start, new Map([["audio/take.wav", waveform]]));

  // All four seconds of the file, a stroke each.
  expect(drawn().match(/M/g)).toHaveLength(4);

  dragBy(clip("Trim the start of Vocals Clip 1"), 1);
  expect(clips("vocals")[0]).toMatchObject({ start: BAR, duration: 2, fileOffset: 2 });
  // Only the file's second half is left to draw.
  expect(drawn().match(/M/g)).toHaveLength(2);

  dragBy(clip("Vocals Clip 1"), 1);
  expect(clips("vocals")[0]).toMatchObject({ start: BAR * 2, duration: 2, fileOffset: 2 });
  history.undo();
  history.undo();
  expect(clips("vocals")[0]).toMatchObject({ start: 0, duration: 4, fileOffset: 0 });
});

test("an Audio Clip whose audio hasn't arrived says it is waiting, and one whose audio is missing says so", () => {
  const start = project();
  const vocals = start.tracks[2] as AudioTrack;
  vocals.clips.push(
    { id: "take", kind: "audio", start: 0, duration: 4, file: "audio/take.wav", fileOffset: 0 },
    { id: "lost", kind: "audio", start: BAR * 2, duration: 4, file: "audio/lost.wav", fileOffset: 0 },
    { id: "here", kind: "audio", start: BAR * 4, duration: 4, file: "audio/here.wav", fileOffset: 0 },
  );
  setUp(
    start,
    new Map([["audio/here.wav", { seconds: 4, peaks: [0.5] }]]),
    new Map<string, AbsentAudio>([
      ["audio/take.wav", "arriving"],
      ["audio/lost.wav", "missing"],
    ]),
  );
  const waiting = screen.getByRole("button", { name: "Vocals Clip 1" });
  expect(waiting).toHaveTextContent("Waiting for its audio: silent until it arrives");
  expect(waiting).toHaveAccessibleDescription("Waiting for its audio: silent until it arrives");
  expect(within(waiting).queryByLabelText("Waveform")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Vocals Clip 2" })).toHaveAccessibleDescription("Its audio is missing, so it is silent");
  // One whose audio is here draws it, and says nothing more.
  const here = screen.getByRole("button", { name: "Vocals Clip 3" });
  expect(within(here).getByLabelText("Waveform")).toBeInTheDocument();
  expect(here).not.toHaveAccessibleDescription();
  expect(here).not.toHaveTextContent(/silent/);
});

test("the selected Clip's start, length and Track can be typed, without dragging", () => {
  const { history, clips } = setUp();
  fireEvent.click(screen.getByRole("button", { name: "Keys Clip 1" }));
  const fields = screen.getByRole("group", { name: "Selected Clip: Keys Clip 1" });

  fireEvent.change(within(fields).getByLabelText("Clip start (bar)"), { target: { value: "3" } });
  expect(clips("keys")[0]).toMatchObject({ start: BAR * 2, length: BAR * 2 });
  fireEvent.change(within(fields).getByLabelText("Clip length (bars)"), { target: { value: "1" } });
  expect(clips("keys")[0]).toMatchObject({ start: BAR * 2, length: BAR });

  // Only the Tracks that can hold a Pattern Clip are offered.
  const track = within(fields).getByLabelText("Clip Track") as HTMLSelectElement;
  expect([...track.options].map((option) => option.text)).toEqual(["Keys", "Bass"]);
  fireEvent.change(track, { target: { value: "bass" } });
  expect(clips("bass")).toHaveLength(1);
  expect(history.undoLabel).toBe("Move Clip");
});

test("the selected Clip can be duplicated and deleted with buttons", () => {
  const { clips, selectedId } = setUp();
  fireEvent.click(screen.getByRole("button", { name: "Keys Clip 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
  expect(clips("keys").map((c) => c.start)).toEqual([0, BAR * 2]);
  expect(selectedId()).toBe(clips("keys")[1]!.id);

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(clips("keys")).toHaveLength(1);
  expect(selectedId()).toBeNull();
});

test("Tempo Changes are added, edited, moved and deleted on the Tempo lane, and each undoes", () => {
  const { history } = setUp();
  const changes = () => history.project.tempoChanges;

  // With no playhead, a change goes at the second bar, keeping the tempo there.
  fireEvent.click(screen.getByLabelText("Add Tempo Change at the playhead"));
  expect(changes()).toMatchObject([{ tick: BAR, tempo: 120, timeSignature: null }]);
  expect(tempoChange()).toHaveAccessibleName("Tempo Change at 2.1.000: 120 BPM");

  fireEvent.change(screen.getByLabelText("Tempo (BPM)"), { target: { value: "90" } });
  fireEvent.click(screen.getByLabelText("New time signature"));
  fireEvent.change(screen.getByLabelText("Beats per bar"), { target: { value: "3" } });
  expect(changes()).toMatchObject([{ tick: BAR, tempo: 90, timeSignature: { beatsPerBar: 3, beatUnit: 4 } }]);
  // Bar 3 now starts three beats after bar 2.
  expect(within(screen.getByLabelText("Ruler")).getByText("3")).toHaveStyle({ left: `${BAR_PX * 1.75 + 4}px` });

  // A change of time signature moves a bar at a time.
  fireEvent.keyDown(tempoChange(), { key: "ArrowRight" });
  expect(changes()[0]!.tick).toBe(BAR * 2);
  fireEvent.keyDown(tempoChange(), { key: "Delete" });
  expect(changes()).toEqual([]);

  // The beats per bar, then the time signature itself.
  for (const label of ["Delete Tempo Change", "Move Tempo Change", "Edit Tempo Change", "Edit Tempo Change"]) {
    expect(history.undoLabel).toBe(label);
    history.undo();
  }
  expect(changes()).toMatchObject([{ tick: BAR, tempo: 90, timeSignature: null }]);
  history.undo();
  expect(changes()).toMatchObject([{ tick: BAR, tempo: 120 }]);
  expect(history.undoLabel).toBe("Add Tempo Change");
  history.undo();
  expect(changes()).toEqual([]);
});

test("double-clicking the Tempo lane adds a Tempo Change on the grid", () => {
  const { history } = setUp();
  fireEvent.doubleClick(screen.getByLabelText("Tempo lane"), { clientX: BAR_PX * 3 + 5 });
  expect(history.project.tempoChanges).toMatchObject([{ tick: BAR * 3, tempo: 120 }]);
});

const section = (name: string) => screen.getByRole("button", { name: new RegExp(`^Section ${name},`) });
const edge = (name: string, which: "start" | "end") => section(name).querySelectorAll(".section-handle")[which === "start" ? 0 : 1]!;

test("Sections are added, renamed, resized and deleted above the ruler, and each undoes", () => {
  const { history, errors } = setUp();
  const sections = () => history.project.sections;

  // Double-clicking bar 3 starts an eight-bar Section there.
  fireEvent.doubleClick(screen.getByLabelText("Section lane"), { clientX: BAR_PX * 2.5 });
  expect(sections()).toMatchObject([{ name: "Section 1", startBar: 3, bars: 8 }]);
  expect(section("Section 1")).toHaveAccessibleName("Section Section 1, bars 3–10");
  expect(section("Section 1")).toHaveStyle({ left: `${BAR_PX * 2}px`, width: `${BAR_PX * 8}px` });

  const name = screen.getByLabelText("Name");
  fireEvent.change(name, { target: { value: "Intro" } });
  fireEvent.keyDown(name, { key: "Enter" });
  expect(sections()[0]!.name).toBe("Intro");

  // Its end dragged back four and a bit bars lands on the bar line.
  dragBy(edge("Intro", "end"), -4.3);
  expect(sections()[0]).toMatchObject({ startBar: 3, bars: 4 });
  fireEvent.keyDown(section("Intro"), { key: "ArrowRight", shiftKey: true });
  expect(sections()[0]).toMatchObject({ startBar: 3, bars: 5 });

  // A Section before it gets only the bars there are room for.
  fireEvent.doubleClick(screen.getByLabelText("Section lane"), { clientX: 5 });
  expect(sections()).toMatchObject([{ name: "Section 2", startBar: 1, bars: 2 }, { name: "Intro" }]);

  // Neither a drag nor the keyboard can pull Intro over it...
  dragBy(edge("Intro", "start"), -2);
  fireEvent.keyDown(section("Intro"), { key: "ArrowLeft", altKey: true });
  expect(sections()[1]).toMatchObject({ startBar: 3, bars: 5 });
  // ...and typing it there is refused.
  fireEvent.mouseDown(section("Intro"));
  fireEvent.change(screen.getByLabelText("Start (bar)"), { target: { value: "2" } });
  expect(errors.at(-1)).toMatch(/would overlap the Section “Section 2” \(bars 1–2\)/);
  fireEvent.change(screen.getByLabelText("Bars"), { target: { value: "12" } });
  expect(sections()[1]).toMatchObject({ startBar: 3, bars: 12 });

  fireEvent.keyDown(section("Intro"), { key: "Delete" });
  expect(sections().map((s) => s.name)).toEqual(["Section 2"]);

  for (const label of ["Delete Section", "Resize Section", "Add Section", "Resize Section", "Resize Section", "Rename Section"]) {
    expect(history.undoLabel).toBe(label);
    history.undo();
  }
  expect(sections()).toMatchObject([{ name: "Section 1", startBar: 3, bars: 8 }]);
  expect(history.undoLabel).toBe("Add Section");
  history.undo();
  expect(sections()).toEqual([]);
});

test("a Section is deleted with its button, and one past the last Clip lengthens the timeline", () => {
  const start = project();
  start.sections.push({ id: "outro", name: "Outro", startBar: 20, bars: 4 });
  const { history } = setUp(start);
  expect(screen.getByLabelText("Ruler")).toHaveStyle({ width: `${BAR_PX * 24}px` });

  fireEvent.mouseDown(section("Outro"));
  fireEvent.click(screen.getByRole("button", { name: "Delete Section" }));
  expect(history.project.sections).toEqual([]);
  expect(history.undoLabel).toBe("Delete Section");
});

/** The demo song named Verse (bars 1–2, the Keys Clip's), Chorus (bars 3–4) and Outro (bars 5–6), with a Clip in the chorus. */
function arranged(): Project {
  const start = project();
  (start.tracks[1] as InstrumentTrack).clips.push({ id: "bass-1", kind: "pattern", start: BAR * 2, length: BAR * 2, notes: [{ pitch: 36, start: 0, length: 240, velocity: 1 }] });
  start.tempoChanges.push({ id: "fast", tick: BAR * 2, tempo: 140, timeSignature: null }, { id: "back", tick: BAR * 4, tempo: 120, timeSignature: null });
  start.sections.push(
    { id: "verse", name: "Verse", startBar: 1, bars: 2 },
    { id: "chorus", name: "Chorus", startBar: 3, bars: 2 },
    { id: "outro", name: "Outro", startBar: 5, bars: 2 },
  );
  return start;
}

const order = (history: ProjectHistory) => history.project.sections.map((s) => `${s.name} ${s.startBar}`);
const starts = (history: ProjectHistory) => history.project.tracks.map((t) => t.clips.map((c) => c.start / BAR));

test("a Section is duplicated, moved and its bars deleted on the ruler, taking its Clips and Tempo Changes, and each undoes", () => {
  const { history, undo } = setUp(arranged());
  const before = history.project;

  fireEvent.mouseDown(section("Chorus"));
  fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
  expect(order(history)).toEqual(["Verse 1", "Chorus 3", "Chorus 5", "Outro 7"]);
  expect(starts(history)).toEqual([[0], [2, 4], []]);
  // The copy follows the chorus at 140, so needs no Tempo Change of its own.
  expect(history.project.tempoChanges.map((c) => [c.tick / BAR, c.tempo])).toEqual([
    [2, 140],
    [6, 120],
  ]);
  expect(history.undoLabel).toBe("Duplicate Section");
  undo();
  expect(history.project).toEqual(before);

  // Swapped with the verse before it, by its button and by the keyboard back again.
  fireEvent.click(screen.getByRole("button", { name: "Move Section earlier" }));
  expect(order(history)).toEqual(["Chorus 1", "Verse 3", "Outro 5"]);
  expect(starts(history)).toEqual([[2], [0], []]);
  expect(screen.getByRole("button", { name: "Move Section earlier" })).toBeDisabled();
  expect(history.project.tempo).toBe(140);
  fireEvent.keyDown(section("Chorus"), { key: "ArrowRight", ctrlKey: true });
  expect(order(history)).toEqual(["Verse 1", "Chorus 3", "Outro 5"]);
  expect(starts(history)).toEqual([[0], [2], []]);
  expect(history.project.tempo).toBe(120);
  expect(history.project.tempoChanges.map((c) => [c.tick / BAR, c.tempo])).toEqual([
    [2, 140],
    [4, 120],
  ]);
  expect(history.undoLabel).toBe("Move Section");
  undo();
  undo();
  expect(history.project).toEqual(before);

  fireEvent.click(screen.getByRole("button", { name: "Delete bars" }));
  expect(order(history)).toEqual(["Verse 1", "Outro 3"]);
  expect(starts(history)).toEqual([[0], [], []]);
  expect(history.project.tempoChanges).toEqual([]);
  expect(history.undoLabel).toBe("Delete bars");
  undo();
  expect(history.project).toEqual(before);
});

test("a Section dragged by its body moves between the others with everything in its bars", () => {
  const { history, undo } = setUp(arranged());
  const before = history.project;

  // Dragged two bars right, the chorus goes after the outro.
  dragBy(section("Chorus"), 2.2);
  expect(order(history)).toEqual(["Verse 1", "Outro 3", "Chorus 5"]);
  expect(starts(history)).toEqual([[0], [4], []]);
  undo();
  expect(history.project).toEqual(before);

  // Dropped part way into the verse, it goes before it, the nearer edge.
  dragBy(section("Chorus"), -1.6);
  expect(order(history)).toEqual(["Chorus 1", "Verse 3", "Outro 5"]);
  undo();

  // Let go inside its own bars, or at the start of them, it stays.
  dragBy(section("Chorus"), 0.3);
  dragBy(section("Chorus"), -0.4);
  expect(history.project).toEqual(before);
  expect(history.canUndo).toBe(false);
});

/** A breakpoint's height on its lane for `value` of 0 to 2: the lane is 56 px, with 6 px above and below the line. */
const volumeY = (value: number) => 6 + (1 - value / 2) * 44;
const breakpoints = (history: ProjectHistory, trackId = "keys") =>
  history.project.tracks.find((t) => t.id === trackId)!.automation.find((a) => a.setting === "volume")?.breakpoints;

const point = (at: string) => screen.getByRole("button", { name: new RegExp(`^Volume breakpoint at ${at}`) });

test("breakpoints are drawn, moved and deleted on a Track's Automation Lane, and each undoes", () => {
  const { history, errors } = setUp();
  const toggle = screen.getByLabelText("Keys Automation");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  const automationLane = screen.getByLabelText("Keys volume Automation Lane");

  // Double-clicking draws a breakpoint on the grid, at the height clicked.
  fireEvent.doubleClick(automationLane, { clientX: BAR_PX + 5, clientY: volumeY(1) });
  fireEvent.doubleClick(automationLane, { clientX: BAR_PX * 3 - 4, clientY: volumeY(0.5) });
  expect(breakpoints(history)).toEqual([
    { tick: BAR, value: 1, hold: false },
    { tick: BAR * 3, value: 0.5, hold: false },
  ]);
  expect(screen.getByLabelText("Keys Automation (volume automated)")).toBeInTheDocument();
  expect(point("4.1.000")).toHaveAccessibleName("Volume breakpoint at 4.1.000: 0.5 (-6.0 dB)");

  // Dragged a bar left and down, it lands on the grid, below where it was.
  const second = point("4.1.000");
  fireEvent.mouseDown(second, { clientX: 0, clientY: 0 });
  fireEvent.mouseMove(second, { clientX: -BAR_PX, clientY: 11 });
  fireEvent.mouseUp(second, { clientX: -BAR_PX, clientY: 11 });
  expect(breakpoints(history)![1]).toEqual({ tick: BAR * 2, value: 0, hold: false });
  // Never past its neighbour.
  fireEvent.keyDown(point("3.1.000"), { key: "ArrowLeft" });
  fireEvent.keyDown(point("2.1.001"), { key: "ArrowLeft" });
  expect(breakpoints(history)![1]!.tick).toBe(BAR + 1);

  // The keyboard lifts a value a twentieth of its range, and H holds it.
  fireEvent.keyDown(point("2.1.000"), { key: "ArrowUp" });
  fireEvent.keyDown(point("2.1.000"), { key: "H" });
  expect(breakpoints(history)![0]).toEqual({ tick: BAR, value: 1.1, hold: true });
  expect(point("2.1.000")).toHaveAccessibleName("Volume breakpoint at 2.1.000: 1.1 (+0.8 dB), holds");

  fireEvent.keyDown(point("2.1.000"), { key: "Delete" });
  expect(breakpoints(history)).toHaveLength(1);
  expect(errors).toEqual([]);

  // The second ArrowLeft, against its neighbour, changed nothing to undo.
  for (const label of ["Delete breakpoint", "Edit breakpoint", "Move breakpoint", "Move breakpoint", "Move breakpoint"]) {
    expect(history.undoLabel).toBe(label);
    history.undo();
  }
  expect(breakpoints(history)![1]).toEqual({ tick: BAR * 3, value: 0.5, hold: false });
  expect(history.undoLabel).toBe("Add breakpoint");
  history.undo();
  history.undo();
  expect(breakpoints(history)).toBeUndefined();
});

test("a breakpoint is added at the playhead from the lane's label, on the line where it already is", () => {
  const { history } = setUp();
  fireEvent.click(screen.getByLabelText("Keys Automation"));

  // With no playhead, at the start, at the fixed volume.
  fireEvent.click(screen.getByLabelText("Add volume breakpoint at the playhead"));
  expect(breakpoints(history)).toEqual([{ tick: 0, value: 1, hold: false }]);
  expect(history.undoLabel).toBe("Add breakpoint");
});

test("a breakpoint is edited and deleted in its fields, without dragging, and a Track's pan has a lane too", () => {
  const { history } = setUp();
  fireEvent.click(screen.getByLabelText("Keys Automation"));
  fireEvent.doubleClick(screen.getByLabelText("Keys volume Automation Lane"), { clientX: 5, clientY: volumeY(1) });
  const fields = screen.getByRole("group", { name: "Selected breakpoint of Keys volume" });
  fireEvent.change(within(fields).getByLabelText("At (bar)"), { target: { value: "2.5" } });
  fireEvent.change(within(fields).getByLabelText("Volume (gain)"), { target: { value: "0.25" } });
  fireEvent.click(within(fields).getByLabelText("Hold until the next"));
  expect(breakpoints(history)).toEqual([{ tick: BAR * 1.5, value: 0.25, hold: true }]);
  // What was typed stays as typed.
  expect(within(fields).getByLabelText("At (bar)")).toHaveValue(2.5);
  fireEvent.click(within(fields).getByText("Delete breakpoint"));
  expect(breakpoints(history)).toBeUndefined();

  fireEvent.change(screen.getByLabelText("Keys automated setting"), { target: { value: "pan" } });
  fireEvent.doubleClick(screen.getByLabelText("Keys pan Automation Lane"), { clientX: 5, clientY: 6 });
  expect(history.project.tracks[0]!.automation).toEqual([{ setting: "pan", breakpoints: [{ tick: 0, value: 1, hold: false }] }]);
});

test("the Master's volume has an Automation Lane, and of the Master's own settings only its EQ is automated besides", () => {
  const { history } = setUp();
  fireEvent.click(screen.getByLabelText("Master Automation"));
  const picker = screen.getByLabelText("Master automated setting");
  expect([...picker.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
    "Volume",
    "Channel EQ: Low",
    "Channel EQ: Low mid",
    "Channel EQ: High mid",
    "Channel EQ: High",
  ]);
  fireEvent.doubleClick(screen.getByLabelText("Master volume Automation Lane"), { clientX: BAR_PX + 5, clientY: volumeY(0) });
  expect(history.project.master.automation).toEqual([{ setting: "volume", breakpoints: [{ tick: BAR, value: 0, hold: false }] }]);
  history.undo();
  expect(history.project.master.automation).toEqual([]);
});

test("a Bus has an Automation Lane, and any channel automates its Sends' levels, its Effects' and its Synth's numbers", () => {
  const start = project();
  start.buses.push(createBus("Verb", "verb"));
  start.tracks[0]!.sends.push({ busId: "verb", level: 1 });
  start.tracks[0]!.insertChain.push(createEffect("eq", "keys-eq"));
  start.buses[0]!.insertChain.push(createEffect("reverb", "verb-reverb"));
  const { history } = setUp(start);

  fireEvent.click(screen.getByLabelText("Keys Automation"));
  const picker = screen.getByLabelText("Keys automated setting");
  const options = within(picker).getAllByRole("option").map((option) => option.textContent);
  expect(options).toEqual(expect.arrayContaining(["Volume", "Pan", "Send to Verb", "EQ: Low shelf gain", "Synth: Cutoff"]));
  // Switches and choices stay where they are set.
  expect(options).not.toContain("Synth: Oscillator 1 wave");
  expect(options).not.toContain("EQ: Low cut");

  fireEvent.change(picker, { target: { value: "effect:keys-eq:lowShelfGainDb" } });
  // The top of the lane is the EQ's +24 dB.
  fireEvent.doubleClick(screen.getByLabelText("Keys EQ: Low shelf gain Automation Lane"), { clientX: 5, clientY: 6 });
  expect(history.project.tracks[0]!.automation).toEqual([
    { setting: "effect:keys-eq:lowShelfGainDb", breakpoints: [{ tick: 0, value: 24, hold: false }] },
  ]);
  expect(screen.getByRole("button", { name: /^EQ: Low shelf gain breakpoint at .*: 24 dB$/ })).toBeInTheDocument();
  expect(screen.getByLabelText("Keys Automation (EQ: Low shelf gain automated)")).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Verb Automation"));
  fireEvent.change(screen.getByLabelText("Verb automated setting"), { target: { value: "pan" } });
  fireEvent.doubleClick(screen.getByLabelText("Verb pan Automation Lane"), { clientX: 5, clientY: 6 });
  expect(history.project.buses[0]!.automation).toEqual([{ setting: "pan", breakpoints: [{ tick: 0, value: 1, hold: false }] }]);
  history.undo();
  expect(history.project.buses[0]!.automation).toEqual([]);
});

test("a Drum Track's Automation Lane offers each Pad's volume, pan and pitch, and not its note or choke group", () => {
  const start = project();
  start.tracks.push(createDrumTrack("Drums", "drums"));
  const { history } = setUp(start);

  fireEvent.click(screen.getByLabelText("Drums Automation"));
  const picker = screen.getByLabelText("Drums automated setting");
  const options = within(picker).getAllByRole("option").map((option) => option.textContent);
  expect(options).toEqual(expect.arrayContaining(["Kick: Volume", "Kick: Pan", "Kick: Pitch", "Closed Hat: Pitch", "Cowbell: Volume"]));
  expect(options.filter((option) => option?.startsWith("Kick"))).toEqual(["Kick: Volume", "Kick: Pan", "Kick: Pitch"]);

  fireEvent.change(picker, { target: { value: "instrument:pad42.pitch" } });
  // The top of the lane is the Pad's +24 semitones.
  fireEvent.doubleClick(screen.getByLabelText("Drums Closed Hat: Pitch Automation Lane"), { clientX: 5, clientY: 6 });
  expect(history.project.tracks[3]!.automation).toEqual([{ setting: "instrument:pad42.pitch", breakpoints: [{ tick: 0, value: 24, hold: false }] }]);
  expect(screen.getByRole("button", { name: /^Closed Hat: Pitch breakpoint at .*: 24 st$/ })).toBeInTheDocument();
  expect(screen.getByLabelText("Drums Automation (Closed Hat: Pitch automated)")).toBeInTheDocument();
  history.undo();
  expect(history.project.tracks[3]!.automation).toEqual([]);
  history.redo();
  expect(history.project.tracks[3]!.automation).toHaveLength(1);
});

test("right-clicking a Clip opens its menu, where it offers one, and choosing an item closes it", () => {
  const start = project();
  const vocals = start.tracks[2]!;
  if (vocals.kind !== "audio") throw new Error("not an Audio Track");
  vocals.clips.push({ id: "take", kind: "audio", start: 0, duration: 4, file: "audio/take.wav", fileOffset: 0 });
  const onExport = vi.fn<(clipId: string) => void>();
  const onSelectClip = vi.fn<(clipId: string | null) => void>();
  render(
    <Timeline
      project={start}
      selectedClipId={null}
      position={null}
      loop={{ start: 0, end: BAR, enabled: false }}
      clipBars={4}
      onSelectClip={onSelectClip}
      onCommands={() => {}}
      onLoopRegion={() => {}}
      clipMenuItems={(offered) =>
        offered.kind === "audio"
          ? [{ kind: "action", id: "export", label: "Export Clip…", onSelect: () => onExport(offered.id) }]
          : []
      }
    />,
  );

  // A Pattern Clip offers nothing here, so the platform's own menu is left alone.
  const keys = screen.getByRole("button", { name: "Keys Clip 1" });
  expect(fireEvent.contextMenu(keys, { clientX: 40, clientY: 20 })).toBe(true);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();

  const take = screen.getByRole("button", { name: "Vocals Clip 1" });
  expect(fireEvent.contextMenu(take, { clientX: 40, clientY: 90 })).toBe(false);
  const menu = screen.getByRole("menu", { name: "Vocals Clip 1" });
  expect(onSelectClip).toHaveBeenLastCalledWith("take");
  const item = within(menu).getByRole("menuitem", { name: "Export Clip…" });
  expect(item).toHaveFocus();
  fireEvent.click(item);
  expect(onExport).toHaveBeenCalledWith("take");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(take).toHaveFocus();

  // Escape closes it too, and a click outside.
  fireEvent.contextMenu(take);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Export Clip…" }), { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.contextMenu(take);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("dragging a Clip with the right button drops a copy where it lands, and a right-click without a drag opens its menu", () => {
  const start = project();
  (start.tracks[2] as AudioTrack).clips.push({ id: "take", kind: "audio", start: 0, duration: 4, file: "audio/take.wav", fileOffset: 0 });
  const history = new ProjectHistory(start);
  const selected: (string | null)[] = [];
  const view = render(<Timeline {...props()} />);
  function props() {
    return {
      project: history.project,
      selectedClipId: selected.at(-1) ?? null,
      position: null,
      loop: { start: 0, end: BAR, enabled: false },
      clipBars: 4,
      onSelectClip: (id: string | null) => {
        selected.push(id);
        view.rerender(<Timeline {...props()} />);
      },
      onCommands: (commands: Command[], label: string) => {
        history.execute(commands, label);
        view.rerender(<Timeline {...props()} />);
      },
      onLoopRegion: () => {},
      clipMenuItems: () => [{ kind: "action" as const, id: "export", label: "Export Clip…", onSelect: () => {} }],
    };
  }
  const keys = () => history.project.tracks[0]!.clips;

  dragBy(clip("Keys Clip 1"), 3, { button: 2 });
  // The browser's own menu event, which Windows sends after the release, opens nothing over the copy.
  expect(fireEvent.contextMenu(clip("Keys Clip 1"))).toBe(false);
  expect(keys().map((c) => c.start / BAR)).toEqual([0, 3]);
  expect(history.undoLabel).toBe("Copy Clip");
  expect(selected.at(-1)).toBe(keys()[1]!.id);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();

  // Pressed and let go where it was, it is a right-click: the menu opens, and nothing is copied.
  const take = clip("Vocals Clip 1");
  fireEvent.mouseDown(take, { button: 2, clientX: 10, clientY: 10 });
  expect(fireEvent.contextMenu(take)).toBe(false);
  fireEvent.mouseUp(take, { button: 2, clientX: 11, clientY: 10 });
  expect(screen.getByRole("menu", { name: "Vocals Clip 1" })).toBeInTheDocument();
  expect(history.project.tracks[2]!.clips).toHaveLength(1);
});

test("dragging a Section with the right button copies it, with everything in its bars, where it is dropped", () => {
  const { history, undo } = setUp(arranged());
  const before = history.project;
  // The verse, bars 1–2, dropped after the outro.
  const verse = section("Verse");
  expect(fireEvent.contextMenu(verse)).toBe(false);
  dragBy(verse, 6, { button: 2 });
  expect(order(history)).toEqual(["Verse 1", "Chorus 3", "Outro 5", "Verse 7"]);
  expect(starts(history)).toEqual([[0, 6], [2], []]);
  expect(history.undoLabel).toBe("Copy Section");
  undo();
  expect(history.project).toEqual(before);
  // Dropped on itself, nothing is copied.
  dragBy(section("Verse"), 0.2, { button: 2 });
  expect(history.project).toEqual(before);
});

test("each Track and Bus is muted and soloed from its header, and the Master has neither", () => {
  const start = project();
  start.buses.push(createBus("Band", "band"));
  const { history, undo } = setUp(start);
  fireEvent.click(screen.getByRole("button", { name: "Mute Keys" }));
  fireEvent.click(screen.getByRole("button", { name: "Solo Band" }));
  expect(history.project.tracks[0]!.mixer.mute).toBe(true);
  expect(history.project.buses[0]!.mixer.solo).toBe(true);
  expect(screen.getByRole("button", { name: "Mute Keys" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Solo Band" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "Mute Master" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Move Master" })).not.toBeInTheDocument();
  undo();
  expect(history.project.buses[0]!.mixer.solo).toBe(false);
});

const laneNames = () => [...document.querySelectorAll(".lane-head .lane-name")].map((name) => name.textContent);
const laneLabels = () => [...document.querySelectorAll(".lane-label")].map((label) => label.textContent?.trim());

test("a header's grip moves its Track among the Tracks, and its Bus among the Buses, by the arrows or a drag", () => {
  const start = project();
  start.buses.push(createBus("Band", "band"), createBus("Verb", "verb"));
  const { history } = setUp(start);

  fireEvent.keyDown(screen.getByRole("button", { name: "Move Keys" }), { key: "ArrowDown" });
  expect(history.project.tracks.map((track) => track.id)).toEqual(["bass", "keys", "vocals"]);
  // The last Track can't go on down among the Buses, nor the first up.
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Vocals" }), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Bass" }), { key: "ArrowUp" });
  expect(history.project.tracks.map((track) => track.id)).toEqual(["bass", "keys", "vocals"]);

  // Dragged onto another Bus's header, a Bus takes its place.
  fireEvent.dragStart(screen.getByRole("button", { name: "Move Verb" }));
  const band = screen.getByRole("button", { name: "Move Band" }).closest(".lane-head")!;
  fireEvent.dragOver(band);
  expect(band).toHaveAttribute("data-drop", "before");
  fireEvent.drop(band);
  expect(history.project.buses.map((bus) => bus.id)).toEqual(["verb", "band"]);
  // A Bus dropped on a Track's header stays where it is.
  fireEvent.dragStart(screen.getByRole("button", { name: "Move Band" }));
  fireEvent.drop(screen.getByRole("button", { name: "Move Keys" }).closest(".lane-head")!);
  expect(history.project.buses.map((bus) => bus.id)).toEqual(["verb", "band"]);

  expect(laneNames()).toEqual(["Bass", "Keys", "Vocals", "Verb", "Band"]);
  // The Master is always the last row.
  expect(laneLabels().at(-1)).toBe("Master");
});

const headOf = (name: string) => screen.getByRole("button", { name: `Move ${name}` }).closest(".lane-head")!;

test("each Track's header has its kind's stripe, a Drum Track's its own; a Bus's has none", () => {
  const start = project();
  start.tracks.push(createDrumTrack("Beat", "beat"));
  start.buses.push(createBus("Band", "band"));
  setUp(start);
  expect(headOf("Keys")).toHaveAttribute("data-track-kind", "instrument");
  expect(headOf("Vocals")).toHaveAttribute("data-track-kind", "audio");
  expect(headOf("Beat")).toHaveAttribute("data-track-kind", "drum");
  expect(headOf("Band")).not.toHaveAttribute("data-track-kind");
  expect(headOf("Keys")).toHaveClass("kind-stripe");
  expect(trackKind(start.tracks[3]!)).toBe("drum");
});

test("the column of names is widened by the arrows on its edge, within its limits, and kept for next time", () => {
  localStorage.clear();
  setUp();
  const names = screen.getByRole("separator", { name: "Width of the names" });
  expect(names).toHaveAttribute("aria-valuenow", String(LABEL_WIDTH.initial));
  fireEvent.keyDown(names, { key: "ArrowRight" });
  fireEvent.keyDown(names, { key: "ArrowRight" });
  expect(names).toHaveAttribute("aria-valuenow", String(LABEL_WIDTH.initial + 40));
  expect(screen.getByRole("button", { name: "Move Keys" }).closest(".lane-head")).toHaveStyle({ width: `${LABEL_WIDTH.initial + 40}px` });
  for (let press = 0; press < 40; press++) fireEvent.keyDown(names, { key: "ArrowLeft" });
  expect(names).toHaveAttribute("aria-valuenow", String(LABEL_WIDTH.min));
  cleanup();
  setUp();
  expect(screen.getByRole("separator", { name: "Width of the names" })).toHaveAttribute("aria-valuenow", String(LABEL_WIDTH.min));
  localStorage.clear();
});

test("Ctrl+C copies the selected Clip and Ctrl+V pastes it straight after, again and again, and each undoes", () => {
  const { history, clips, selectedId, undo } = setUp();
  fireEvent.click(clip("Keys Clip 1"));
  fireEvent.keyDown(clip("Keys Clip 1"), { key: "c", ctrlKey: true });
  // Nothing changes until it is pasted.
  expect(history.undoLabel).toBeNull();

  fireEvent.keyDown(clip("Keys Clip 1"), { key: "v", ctrlKey: true });
  expect(clips("keys").map((c) => c.start / BAR)).toEqual([0, 2]);
  expect(selectedId()).toBe(clips("keys")[1]!.id);
  expect(history.undoLabel).toBe("Paste Clip");
  // The copy is selected, so the next goes after it; ⌘ works as Ctrl does.
  fireEvent.keyDown(clip("Keys Clip 2"), { key: "v", metaKey: true });
  expect(clips("keys").map((c) => c.start / BAR)).toEqual([0, 2, 4]);
  expect(clips("keys")[2]).toMatchObject({ kind: "pattern", length: BAR * 2, notes: [{ pitch: 60 }] });

  undo();
  undo();
  expect(clips("keys").map((c) => c.start / BAR)).toEqual([0]);
});

test("a copied Clip pastes after the Clip selected on another Track, where that Track takes its kind", () => {
  const start = project();
  (start.tracks[1] as InstrumentTrack).clips.push({ id: "bass-1", kind: "pattern", start: BAR * 4, length: BAR, notes: [] });
  (start.tracks[2] as AudioTrack).clips.push({ id: "take", kind: "audio", start: 0, duration: 4, file: "audio/take.wav", fileOffset: 0 });
  const { clips, errors } = setUp(start);
  fireEvent.click(clip("Keys Clip 1"));
  fireEvent.keyDown(clip("Keys Clip 1"), { key: "c", ctrlKey: true });

  fireEvent.click(clip("Bass Clip 1"));
  fireEvent.keyDown(clip("Bass Clip 1"), { key: "v", ctrlKey: true });
  expect(errors).toEqual([]);
  expect(clips("bass").map((c) => c.start / BAR)).toEqual([4, 5]);

  // An Audio Track can't take a Pattern Clip, so it goes after where it was copied from, on its own Track.
  fireEvent.click(clip("Vocals Clip 1"));
  fireEvent.keyDown(clip("Vocals Clip 1"), { key: "v", ctrlKey: true });
  expect(errors).toEqual([]);
  expect(clips("vocals")).toHaveLength(1);
  expect(clips("keys").map((c) => c.start / BAR)).toEqual([0, 2]);
});

test("clicking a Section plays it, and clicking it again unselects it so the whole song plays", () => {
  const { onSelectSection } = setUp(arranged());
  const click = (name: string) => {
    fireEvent.mouseDown(section(name), { clientX: 10 });
    fireEvent.mouseUp(window, { clientX: 10 });
  };
  click("Chorus");
  expect(section("Chorus")).toHaveAttribute("aria-pressed", "true");
  const chorusId = onSelectSection.mock.calls.at(-1)![0];
  expect(chorusId).toEqual(expect.any(String));
  click("Chorus");
  expect(section("Chorus")).toHaveAttribute("aria-pressed", "false");
  expect(onSelectSection).toHaveBeenLastCalledWith(null);
  // The keyboard does the same with Enter.
  fireEvent.keyDown(section("Chorus"), { key: "Enter" });
  expect(onSelectSection).toHaveBeenLastCalledWith(chorusId);
  fireEvent.keyDown(section("Chorus"), { key: "Enter" });
  expect(onSelectSection).toHaveBeenLastCalledWith(null);
  // Escape unselects it too, and so does a click on one of its edges.
  click("Chorus");
  fireEvent.keyDown(section("Chorus"), { key: "Escape" });
  expect(onSelectSection).toHaveBeenLastCalledWith(null);
  click("Chorus");
  const handle = section("Chorus").querySelector(".section-handle")!;
  fireEvent.mouseDown(handle, { clientX: 10 });
  fireEvent.mouseUp(window, { clientX: 12 });
  expect(section("Chorus")).toHaveAttribute("aria-pressed", "false");
  // A drag is a move, not a click, and leaves it selected.
  click("Chorus");
  fireEvent.mouseDown(section("Chorus"), { clientX: 10 });
  fireEvent.mouseUp(window, { clientX: 10 + 20 });
  expect(section("Chorus")).toHaveAttribute("aria-pressed", "true");
});

test("Ctrl+C copies the selected Section and Ctrl+V pastes it, with everything in its bars, after the one selected", () => {
  const { history, undo } = setUp(arranged());
  const before = history.project;
  fireEvent.mouseDown(section("Chorus"));
  fireEvent.keyDown(section("Chorus"), { key: "c", ctrlKey: true });
  fireEvent.keyDown(section("Chorus"), { key: "v", ctrlKey: true });
  // As Duplicate does: the chorus and its Clips, straight after it.
  expect(order(history)).toEqual(["Verse 1", "Chorus 3", "Chorus 5", "Outro 7"]);
  expect(starts(history)).toEqual([[0], [2, 4], []]);
  expect(history.undoLabel).toBe("Paste Section");

  // The copy is selected, so pasting again puts the next after it, whichever Chorus has focus.
  const [chorus] = screen.getAllByRole("button", { name: /^Section Chorus,/ });
  fireEvent.keyDown(chorus!, { key: "v", ctrlKey: true });
  expect(order(history)).toEqual(["Verse 1", "Chorus 3", "Chorus 5", "Chorus 7", "Outro 9"]);

  // With the Outro selected, it goes after the Outro.
  fireEvent.mouseDown(section("Outro"));
  fireEvent.keyDown(section("Outro"), { key: "v", ctrlKey: true });
  expect(order(history).at(-1)).toBe("Chorus 11");

  undo();
  undo();
  undo();
  expect(history.project).toEqual(before);
});

test("in the Timeline's text fields, Ctrl+C and Ctrl+V are the text's own", () => {
  const { history } = setUp();
  fireEvent.click(clip("Keys Clip 1"));
  fireEvent.keyDown(clip("Keys Clip 1"), { key: "c", ctrlKey: true });
  const field = within(screen.getByRole("group", { name: /^Selected Clip/ })).getAllByRole("spinbutton")[0]!;
  const pasted = fireEvent.keyDown(field, { key: "v", ctrlKey: true });
  // Not handled, so the browser pastes the text as it always does.
  expect(pasted).toBe(true);
  expect(history.undoLabel).toBeNull();
});

test("double-clicking an Audio Track's lane asks for a file, to go where it was clicked", () => {
  const onImportAudio = vi.fn<(trackId: string, file: File, at: number) => void>();
  const start = project();
  render(
    <Timeline
      project={start}
      selectedClipId={null}
      position={null}
      loop={{ start: 0, end: BAR, enabled: false }}
      clipBars={4}
      onSelectClip={() => {}}
      onCommands={() => {}}
      onLoopRegion={() => {}}
      onImportAudio={onImportAudio}
    />,
  );
  const picker = screen.getByLabelText<HTMLInputElement>("Audio file to place on the Timeline");
  const opened = vi.spyOn(picker, "click").mockImplementation(() => {});
  fireEvent.doubleClick(screen.getByLabelText("Vocals lane"), { clientX: BAR_PX * 2 + 5 });
  expect(opened).toHaveBeenCalledOnce();

  const file = new File(["RIFF"], "take.wav", { type: "audio/wav" });
  fireEvent.change(picker, { target: { files: [file] } });
  expect(onImportAudio).toHaveBeenCalledWith(start.tracks[2]!.id, file, BAR * 2);
});
