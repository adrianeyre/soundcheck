import { expect, test, vi } from "vitest";

import { deepFreeze, sampleProject } from "./fixtures";
import { type ProjectListener, ProjectHistory } from "./history";
import { createInstrumentTrack } from "./model";

test("a group of commands, like one Request, undoes and redoes as one step", () => {
  const original = deepFreeze(sampleProject());
  const history = new ProjectHistory(original);

  const group = history.beginGroup("Make a bassline");
  group.execute({ type: "setTempo", tempo: 100 });
  group.execute({ type: "addTrack", track: createInstrumentTrack("Bass 2", "bass-2") });
  group.execute({
    type: "addClip",
    trackId: "bass-2",
    clip: { id: "b2", kind: "pattern", start: 0, length: 3840, notes: [{ pitch: 36, start: 0, length: 960, velocity: 1 }] },
  });
  // A rejected command inside the group changes nothing and doesn't end it.
  expect(group.execute({ type: "setTempo", tempo: 5000 }).ok).toBe(false);
  group.end();
  const after = history.project;

  expect(history.undoLabel).toBe("Make a bassline");
  expect(history.undo()).toBe(true);
  expect(history.project).toEqual(original);
  expect(history.canUndo).toBe(false);

  expect(history.redo()).toBe(true);
  expect(history.project).toEqual(after);
});

test("several commands in one call are all-or-nothing", () => {
  const original = deepFreeze(sampleProject());
  const history = new ProjectHistory(original);
  const result = history.execute([
    { type: "setTempo", tempo: 100 },
    { type: "deleteTrack", trackId: "does-not-exist" },
  ]);
  expect(result.ok).toBe(false);
  expect(history.project).toBe(original);

  history.execute([
    { type: "setTempo", tempo: 100 },
    { type: "renameTrack", trackId: "keys", name: "Piano" },
  ]);
  expect(history.undoLabel).toBe("Set tempo and more");
  history.undo();
  expect(history.project).toEqual(original);
});

test("undo past the start and redo past the end do nothing; a new change clears redo", () => {
  const history = new ProjectHistory(sampleProject());
  expect(history.undo()).toBe(false);
  history.execute({ type: "setTempo", tempo: 90 });
  history.execute({ type: "setTempo", tempo: 80 });
  history.undo();
  expect(history.canRedo).toBe(true);
  history.execute({ type: "setTempo", tempo: 70 });
  expect(history.canRedo).toBe(false);
  expect(history.redo()).toBe(false);
  history.undo();
  expect(history.project.tempo).toBe(90);
});

test("while a group is open, editing and undo wait for it, so it stays one step", () => {
  const original = sampleProject();
  const history = new ProjectHistory(original);
  const group = history.beginGroup("Request");
  group.execute({ type: "setTempo", tempo: 90 });

  // The musician's own edit can't join the group's step, or undo split it.
  const refused = history.execute({ type: "renameTrack", trackId: "keys", name: "Piano" });
  expect(refused.ok).toBe(false);
  expect(refused.ok || refused.error).toMatch(/Assistant/);
  expect(history.busy).toBe(true);
  expect(history.canUndo).toBe(false);
  expect(history.undo()).toBe(false);
  expect(history.project.tempo).toBe(90);
  expect(history.project.tracks[0]!.name).toBe("Keys");

  group.end();
  expect(history.busy).toBe(false);
  expect(history.undoLabel).toBe("Request");
  // And the edit the musician makes now is their own step, either side of it.
  expect(history.execute({ type: "renameTrack", trackId: "keys", name: "Piano" }).ok).toBe(true);
  expect(history.undoLabel).toBe("Rename Track");
  history.undo();
  history.undo();
  expect(history.project).toEqual(original);
});

test("an empty group leaves no step", () => {
  const history = new ProjectHistory(sampleProject());
  history.beginGroup("Nothing").end();
  expect(history.canUndo).toBe(false);
});

test("a group knows whether the step it became is undone, as a follow-up Request is told", () => {
  const history = new ProjectHistory(sampleProject());
  const group = history.beginGroup("Request");
  group.execute({ type: "setTempo", tempo: 100 });
  expect(group.undone).toBe(false);
  group.end();
  expect(group.undone).toBe(false);

  history.undo();
  expect(group.undone).toBe(true);
  history.redo();
  expect(group.undone).toBe(false);
  // Undone and then replaced by a change, it can't come back.
  history.undo();
  history.execute({ type: "setTempo", tempo: 90 });
  expect(group.undone).toBe(true);

  // A group that changed nothing has nothing to undo.
  const empty = history.beginGroup("Request");
  empty.end();
  history.undo();
  expect(empty.undone).toBe(false);
});

test("a group that the history has moved on from changes nothing", () => {
  const history = new ProjectHistory(sampleProject());
  const group = history.beginGroup("Request");
  group.end();
  expect(group.open).toBe(false);
  expect(group.execute({ type: "setTempo", tempo: 90 }).ok).toBe(false);
  expect(history.project.tempo).toBe(120);
});

test("listeners hear every change, undo and redo, so the engine can follow", () => {
  const history = new ProjectHistory(sampleProject());
  const listener = vi.fn<ProjectListener>();
  const unsubscribe = history.subscribe(listener);

  history.execute({ type: "setTempo", tempo: 90 });
  history.undo();
  history.redo();
  expect(listener).toHaveBeenCalledTimes(3);
  expect(listener.mock.calls[0]![0].tempo).toBe(90);
  expect(listener.mock.calls[0]![1].tempo).toBe(120);

  unsubscribe();
  history.undo();
  expect(listener).toHaveBeenCalledTimes(3);
});

test("an Audio Track's Input undoes and redoes as its own step, and edits after it leave it alone", () => {
  const history = new ProjectHistory(sampleProject());
  const input = (project: typeof history.project) => project.tracks.find((track) => track.id === "vocals")!;

  history.execute({ type: "setTrackInput", trackId: "vocals", input: { device: "Interface", channels: [4] } });
  expect(history.undoLabel).toBe("Set Track Input");
  history.execute({ type: "setTempo", tempo: 100 });
  history.undo();
  expect(input(history.project)).toMatchObject({ input: { device: "Interface", channels: [4] } });

  history.undo();
  expect(input(history.project)).toMatchObject({ input: { device: null, channels: null } });
  history.redo();
  expect(input(history.project)).toMatchObject({ input: { device: "Interface", channels: [4] } });
});

test("Input Monitoring undoes and redoes as its own step", () => {
  const history = new ProjectHistory(sampleProject());
  const vocals = () => history.project.tracks.find((track) => track.id === "vocals")!;

  history.execute({ type: "setTrackMonitoring", trackId: "vocals", monitoring: true });
  expect(history.undoLabel).toBe("Set Input Monitoring");
  expect(vocals()).toMatchObject({ monitoring: true });
  history.undo();
  expect(vocals()).toMatchObject({ monitoring: false });
  history.redo();
  expect(vocals()).toMatchObject({ monitoring: true });
});
