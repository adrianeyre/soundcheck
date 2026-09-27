// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { ProjectHistory } from "../project/history";
import { createInstrumentTrack, createProject, type Project } from "../project/model";
import { FakeFileStorage, fakeFolder } from "./fake-file-storage";
import { changesFile, openFolder, parseChanges } from "../collab/shared-folder";
import { DATA_FILE, openProject, saveProject } from "./project-folder";
import { ProjectFileAlerts, ProjectTitle } from "./ProjectFile";
import { folderNameFor, NO_STORAGE, type ProjectFileOptions, useProjectFile } from "./useProjectFile";

afterEach(cleanup);

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const saveState = () => document.querySelector<HTMLElement>(".save-state")!;

/** The File menu's commands as plain buttons, with the title and alerts the app shows. */
function Harness(options: ProjectFileOptions & { adopting?: ProjectHistory }) {
  const file = useProjectFile(options);
  return (
    <>
      <ProjectTitle file={file} history={options.history} />
      <ProjectFileAlerts file={file} />
      <button type="button" disabled={file.replaceBlocked} onClick={file.newProject}>
        New
      </button>
      <button type="button" disabled={file.replaceBlocked} onClick={file.open}>
        Open…
      </button>
      <button type="button" disabled={file.busy} onClick={file.save}>
        Save
      </button>
      <button type="button" disabled={file.busy} onClick={file.saveAs}>
        Save As…
      </button>
      <button type="button" disabled={file.replaceBlocked || file.shared} onClick={file.share}>
        Share this Project…
      </button>
      {options.adopting && (
        <button type="button" onClick={() => file.adopt(options.adopting!)}>
          Take the Live Session's Project
        </button>
      )}
    </>
  );
}

function setUp(storage: FakeFileStorage | null, project: Project = createProject("Demo"), adopting?: ProjectHistory) {
  let history = new ProjectHistory(project);
  const discard = vi.fn<(message: string) => boolean>(() => true);
  const harness = () => (
    <Harness storage={storage} history={history} onProject={swap} confirmDiscard={discard} adopting={adopting} />
  );
  const view = render(harness());
  function swap(next: ProjectHistory) {
    history = next;
    view.rerender(harness());
  }
  // An edit, as the Step Sequencer or the Assistant would make.
  const edit = (name = "Synth 1") => {
    history.execute({ type: "addTrack", track: createInstrumentTrack(name) });
    swap(history);
  };
  return { discard, edit, current: () => history };
}

test("a new Project is saved into the folder the musician picks, named after it", async () => {
  const storage = new FakeFileStorage();
  storage.saveChoice = fakeFolder("/songs/Demo");
  const { edit } = setUp(storage);
  edit();

  expect(saveState()).toHaveTextContent("Not saved yet");
  click("Save");
  await waitFor(() => expect(saveState()).toHaveTextContent("Saved (/songs/Demo)"));
  expect(storage.suggested).toEqual(["Demo"]);
  expect(storage.files("/songs/Demo")).toEqual([DATA_FILE]);

  const opened = await openProject(storage, storage.saveChoice);
  expect(opened.ok && opened.project.tracks.map((track) => track.name)).toEqual(["Synth 1"]);
});

test("what is saved can hold more than the history does, and the history's own Project counts as saved", async () => {
  const storage = new FakeFileStorage();
  storage.saveChoice = fakeFolder("/songs/Demo");
  const history = new ProjectHistory(createProject("Demo"));
  const beforeSave = vi.fn<(project: Project) => Promise<Project>>((project) => Promise.resolve({ ...project, name: "Demo, with its Plugins' states" }));
  render(<Harness storage={storage} history={history} onProject={() => {}} beforeSave={beforeSave} />);

  click("Save");
  await waitFor(() => expect(saveState()).toHaveTextContent("Saved (/songs/Demo)"));
  expect(beforeSave).toHaveBeenCalledWith(history.project);
  const opened = await openProject(storage, storage.saveChoice);
  expect(opened.ok && opened.project.name).toBe("Demo, with its Plugins' states");
});

test("unsaved changes show, and are gone again once saved", async () => {
  const storage = new FakeFileStorage();
  storage.saveChoice = fakeFolder("/songs/Demo");
  const { edit } = setUp(storage);
  click("Save");
  await waitFor(() => expect(saveState()).toHaveTextContent("Saved (/songs/Demo)"));

  edit();
  expect(saveState()).toHaveTextContent("Unsaved changes (/songs/Demo)");
  click("Save");
  // Saving again goes to the same folder, without asking.
  await waitFor(() => expect(saveState()).toHaveTextContent("Saved (/songs/Demo)"));
  expect(storage.suggested).toEqual(["Demo"]);
});

test("New and Open warn before losing unsaved changes", async () => {
  const storage = new FakeFileStorage();
  const saved = createProject("Saved song");
  await saveProject(storage, saved, fakeFolder("/songs/saved"));
  storage.openChoice = fakeFolder("/songs/saved");
  const { discard, edit, current } = setUp(storage);
  edit();

  discard.mockReturnValueOnce(false);
  click("New");
  expect(discard).toHaveBeenCalled();
  expect(current().project.tracks).toHaveLength(1);

  click("New");
  expect(current().project.tracks).toEqual([]);
  expect(current().canUndo).toBe(false);
  expect(saveState()).toHaveTextContent("Not saved yet");

  edit("Synth 2");
  discard.mockReturnValueOnce(false);
  click("Open…");
  await waitFor(() => expect(discard).toHaveBeenCalledTimes(3));
  expect(current().project.name).toBe("Untitled");

  click("Open…");
  await waitFor(() => expect(current().project.name).toBe("Saved song"));
  expect(saveState()).toHaveTextContent("Saved (/songs/saved)");
});

test("Save As writes a second folder and keeps saving there", async () => {
  const storage = new FakeFileStorage();
  storage.saveChoice = fakeFolder("/songs/Demo");
  const { edit } = setUp(storage);
  click("Save");
  await waitFor(() => expect(saveState()).toHaveTextContent("Saved (/songs/Demo)"));

  storage.saveChoice = fakeFolder("/songs/Demo copy");
  click("Save As…");
  await waitFor(() => expect(saveState()).toHaveTextContent("Saved (/songs/Demo copy)"));

  edit();
  click("Save");
  await waitFor(() => expect(saveState()).toHaveTextContent("Saved (/songs/Demo copy)"));
  expect(storage.suggested).toEqual(["Demo", "Demo"]);
  const inFirst = await openProject(storage, fakeFolder("/songs/Demo"));
  expect(inFirst.ok && inFirst.project.tracks).toEqual([]);
});

test("a shared Project writes every edit to its folder as it is made, with nothing left unsaved", async () => {
  const storage = new FakeFileStorage();
  storage.saveChoice = fakeFolder("/shared/Demo");
  const { edit, current } = setUp(storage);
  edit();

  click("Share this Project…");
  await waitFor(() => expect(saveState()).toHaveTextContent("Shared (/shared/Demo)"));
  expect(screen.getByRole("button", { name: "Share this Project…" })).toBeDisabled();
  const own = changesFile(current().copy);
  expect(storage.files("/shared/Demo")).toEqual([own, DATA_FILE]);

  edit("Synth 2");
  expect(saveState()).toHaveTextContent("Shared");
  await waitFor(async () => expect(parseChanges(await storage.readText(fakeFolder("/shared/Demo"), own))).toHaveLength(1));
  // What a Collaborator opens there: the base and the edit since.
  const opened = await openFolder(storage, fakeFolder("/shared/Demo"), { copy: "bob" });
  expect(opened.ok && opened.history.project.tracks.map((track) => track.name)).toEqual(["Synth 1", "Synth 2"]);
});

test("a Collaborator's Changes in the shared folder show up without anyone opening it again", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/shared/Demo");
  await saveProject(storage, createProject("Demo"), folder);
  storage.add(folder.id, changesFile("bob"), "");
  storage.openChoice = folder;
  const { current } = setUp(storage);
  click("Open…");
  await waitFor(() => expect(saveState()).toHaveTextContent("Shared (/shared/Demo)"));

  const bob = new ProjectHistory(current().project, { copy: "bob", by: "Bob" });
  bob.onChange((change) => void storage.appendText(folder, changesFile("bob"), `${JSON.stringify(change)}\n`));
  bob.execute({ type: "setTempo", tempo: 90 });
  await waitFor(() => expect(current().project.tempo).toBe(90), { timeout: 5000 });
});

test("a Live Session's Project, taken on joining it, is saved nowhere yet, and its folder is no longer followed", async () => {
  const storage = new FakeFileStorage();
  storage.saveChoice = fakeFolder("/shared/Demo");
  const session = new ProjectHistory(createProject("Their song"));
  const { current, discard } = setUp(storage, createProject("Demo"), session);
  click("Share this Project…");
  await waitFor(() => expect(saveState()).toHaveTextContent("Shared (/shared/Demo)"));

  const before = storage.files("/shared/Demo");
  click("Take the Live Session's Project");
  expect(current()).toBe(session);
  expect(saveState()).toHaveTextContent("Not saved yet");
  expect(screen.getByRole("button", { name: "Share this Project…" })).toBeEnabled();
  session.execute({ type: "setTempo", tempo: 90 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The session's edits don't go into the folder it replaced.
  expect(storage.files("/shared/Demo")).toEqual(before);
  expect(before).not.toContain(changesFile(session.copy));
  // It is the musician's to save, so New asks first.
  click("New");
  expect(discard).toHaveBeenCalled();
});

test("a folder that isn't a Project is reported, and the Project in hand is kept", async () => {
  const storage = new FakeFileStorage();
  storage.openChoice = storage.add("/photos", "holiday.jpg", "not a Project");
  const { current } = setUp(storage, createProject("Mine"));

  click("Open…");
  expect(await screen.findByRole("alert")).toHaveTextContent(`it has no ${DATA_FILE}`);
  expect(current().project.name).toBe("Mine");
});

test("missing audio is reported when a Project folder opens without it", async () => {
  const storage = new FakeFileStorage();
  const project = createProject("Gappy");
  project.tracks.push({
    id: "a",
    kind: "audio",
    name: "Vocals",
    input: { device: null, channels: null },
    monitoring: false,
    mixer: { volume: 1, pan: 0, mute: false, solo: false },
    insertChain: [],
    output: null,
    sends: [],
    automation: [],
    clips: [{ id: "c", kind: "audio", start: 0, duration: 0.5, file: "audio/gone.wav", fileOffset: 0 }],
  });
  storage.openChoice = storage.add("/songs/gappy", DATA_FILE, JSON.stringify(project));
  setUp(storage);

  click("Open…");
  expect(await screen.findByRole("alert")).toHaveTextContent("audio/gone.wav");
});

test("the Project's name is part of the Project, and undoes like any other change", () => {
  const { current } = setUp(new FakeFileStorage());
  const name = screen.getByLabelText("Project name");
  fireEvent.change(name, { target: { value: "  Night drive  " } });
  fireEvent.blur(name);
  expect(current().project.name).toBe("Night drive");
  current().undo();
  expect(current().project.name).toBe("Demo");
});

test("without a file storage the Project can only be worked on, and Open and Save say why", () => {
  const { current } = setUp(null);
  click("Save");
  expect(screen.getByRole("alert")).toHaveTextContent(NO_STORAGE);
  click("Dismiss");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  click("Open…");
  expect(screen.getByRole("alert")).toHaveTextContent(NO_STORAGE);
  click("New");
  expect(current().project.name).toBe("Untitled");
});

test("Escape puts the name back as it was", () => {
  const { current } = setUp(new FakeFileStorage());
  const name = screen.getByLabelText("Project name");
  fireEvent.change(name, { target: { value: "Oops" } });
  fireEvent.keyDown(name, { key: "Escape" });
  expect(current().project.name).toBe("Demo");
  expect(name).toHaveValue("Demo");
});

test("a Project name becomes a folder name the filesystem will take", () => {
  expect(folderNameFor("Night drive")).toBe("Night drive");
  expect(folderNameFor("AC/DC: 4pm?")).toBe("AC DC  4pm");
  expect(folderNameFor("///")).toBe("Untitled");
});

