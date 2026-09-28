// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, expect, test } from "vitest";

import { keysPresetCommand } from "../preset/preset-library";
import { ProjectHistory } from "../project/history";
import { createKeysTrack, createProject, type InstrumentTrack, type KeysInstrument } from "../project/model";
import { KeysPanel } from "./KeysPanel";
import { KEYS_PRESETS } from "./keys-presets";

afterEach(cleanup);

function keysOf(history: ProjectHistory): KeysInstrument {
  return (history.project.tracks[0] as InstrumentTrack).instrument as KeysInstrument;
}

/** The panel over one Keys Track, wired to a history as the Editor wires it; files loaded are kept. */
function show() {
  const track = createKeysTrack("Piano", "t1", KEYS_PRESETS[0]!);
  const history = new ProjectHistory({ ...createProject("Demo"), tracks: [track] });
  const loaded: File[] = [];
  function Harness() {
    useSyncExternalStore((listener) => history.subscribe(listener), () => history.project);
    const keys = keysOf(history);
    return (
      <KeysPanel
        trackName="Piano"
        preset={keys.preset}
        settings={keys.settings}
        sampleName={keys.sample}
        onChange={(settings) => history.execute({ type: "setKeysSettings", trackId: "t1", settings })}
        onPreset={(preset) => history.execute(keysPresetCommand("t1", preset))}
        onLoadSample={(file) => {
          loaded.push(file);
          history.execute({ type: "setKeysSample", trackId: "t1", sample: `audio/${file.name}` });
        }}
        onClearSample={() => history.execute({ type: "setKeysSample", trackId: "t1", sample: null })}
      />
    );
  }
  render(<Harness />);
  return { history, loaded };
}

test("the sound browser lists every piano sound, the loaded one pressed, and picking one loads it", () => {
  const { history } = show();
  const sounds = within(screen.getByRole("list", { name: "Piano sounds" })).getAllByRole("button");
  expect(sounds).toHaveLength(KEYS_PRESETS.length);
  expect(sounds.length).toBeGreaterThanOrEqual(30);
  expect(screen.getByRole("button", { name: /^Concert Grand/ })).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(screen.getByRole("button", { name: /^Suitcase EP/ }));
  expect(keysOf(history).preset).toBe("Suitcase EP");
  expect(keysOf(history).settings.tremoloStereo).toBe(1);
  expect(screen.getByRole("button", { name: /^Suitcase EP/ })).toHaveAttribute("aria-pressed", "true");
  // One undo step takes the sound back.
  history.undo();
  expect(keysOf(history).preset).toBe("Concert Grand");
});

test("the browser narrows by category and by what is typed, and says when nothing matches", () => {
  show();
  fireEvent.click(screen.getByRole("radio", { name: "Electric pianos" }));
  const electric = within(screen.getByRole("list", { name: "Piano sounds" })).getAllByRole("button");
  expect(electric.length).toBe(KEYS_PRESETS.filter((each) => each.category === "electric").length);
  fireEvent.change(screen.getByLabelText("Find a piano sound"), { target: { value: "tremolo" } });
  expect(within(screen.getByRole("list", { name: "Piano sounds" })).getAllByRole("button").map((each) => each.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining("Suitcase EP")]),
  );
  fireEvent.change(screen.getByLabelText("Find a piano sound"), { target: { value: "theremin" } });
  expect(screen.getByText(/No sound matches/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show them all" }));
  expect(within(screen.getByRole("list", { name: "Piano sounds" })).getAllByRole("button")).toHaveLength(KEYS_PRESETS.length);
});

test("a sample is loaded to play across the keyboard from its root note, and taken off again", () => {
  const { history, loaded } = show();
  fireEvent.click(screen.getByLabelText(/Your sample/));
  expect(keysOf(history).settings.source).toBe("sample");
  expect(screen.getByText("No sample yet")).toBeInTheDocument();
  // The piano's own controls go; the sound browser with them.
  expect(screen.queryByRole("list", { name: "Piano sounds" })).not.toBeInTheDocument();
  expect(screen.queryByText("Hammer and strings")).not.toBeInTheDocument();

  const file = new File([new Uint8Array([82, 73, 70, 70])], "choir.wav", { type: "audio/wav" });
  fireEvent.change(screen.getByLabelText("Piano Keys sample"), { target: { files: [file] } });
  expect(loaded).toEqual([file]);
  expect(keysOf(history).sample).toBe("audio/choir.wav");

  fireEvent.change(screen.getByLabelText("Root note"), { target: { value: "57" } });
  expect(keysOf(history).settings.rootNote).toBe(57);
  expect(screen.getByLabelText("Root note")).toHaveDisplayValue("A3");

  fireEvent.click(screen.getByRole("button", { name: "Remove sample" }));
  expect(keysOf(history).sample).toBeNull();
  expect(keysOf(history).settings.source).toBe("piano");
});

test("a control changes its setting, as one undo step", () => {
  const { history } = show();
  fireEvent.change(screen.getByLabelText(/^Brightness/), { target: { value: "0.2" } });
  expect(keysOf(history).settings.brightness).toBe(0.2);
  history.undo();
  expect(keysOf(history).settings.brightness).toBe(KEYS_PRESETS[0]!.settings.brightness);
});
