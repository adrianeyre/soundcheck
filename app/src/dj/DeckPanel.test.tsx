// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { SampleRef } from "../samples/sample-source";
import { SAMPLE_DRAG_TYPE } from "../samples/sample-drag";
import { DeckPanel } from "./DeckPanel";
import { EMPTY_REPORT } from "./dj-report";
import { DJ_TRACK_DRAG_TYPE, newDeck } from "./dj-state";

afterEach(cleanup);

function deck() {
  const onLoadFile = vi.fn<(file: File) => void>();
  const onDropTrack = vi.fn<(trackId: string) => void>();
  const onDropSample = vi.fn<(sample: SampleRef) => void>();
  render(
    <DeckPanel
      deck={1}
      state={newDeck()}
      report={EMPTY_REPORT.decks[1]!}
      title={null}
      analysis={null}
      syncMaster={false}
      masterKey={null}
      canPlay
      set={() => {}}
      onState={() => {}}
      onLoadFile={onLoadFile}
      onDropTrack={onDropTrack}
      onDropSample={onDropSample}
      onEject={() => {}}
    />,
  );
  return { onLoadFile, onDropTrack, onDropSample, panel: screen.getByRole("region", { name: "Deck 2" }) };
}

const transfer = (types: string[], data: Record<string, string> = {}, files: File[] = []) => ({
  types,
  files,
  dropEffect: "none",
  getData: (type: string) => data[type] ?? "",
});

test("a file from the system dropped anywhere on the Deck loads it, and the Deck lights while it is over it", () => {
  const { onLoadFile, panel } = deck();
  const file = new File([new Uint8Array([1])], "Night Drive.mp3");
  // Onto one of its buttons, not the panel itself.
  const pad = screen.getByRole("button", { name: "Set Hot Cue A" });
  fireEvent.dragEnter(pad, { dataTransfer: transfer(["Files"], {}, [file]) });
  expect(panel).toHaveAttribute("data-drop", "true");
  expect(screen.getByText("Drop to load onto Deck 2")).toBeInTheDocument();
  fireEvent.dragOver(pad, { dataTransfer: transfer(["Files"], {}, [file]) });
  fireEvent.drop(pad, { dataTransfer: transfer(["Files"], {}, [file]) });
  expect(onLoadFile).toHaveBeenCalledWith(file);
  expect(panel).not.toHaveAttribute("data-drop");
});

test("a file from the Folders tree loads it", () => {
  const { onDropSample, panel } = deck();
  const sample = { folder: { id: "music", label: "Music" }, path: "Set/Night Drive.mp3" };
  const data = transfer([SAMPLE_DRAG_TYPE], { [SAMPLE_DRAG_TYPE]: JSON.stringify(sample) });
  fireEvent.dragEnter(panel, { dataTransfer: data });
  fireEvent.drop(screen.getByRole("group", { name: /Deck 2 jog wheel/ }), { dataTransfer: data });
  expect(onDropSample).toHaveBeenCalledWith(sample);
});

test("a row from Loaded tracks loads it", () => {
  const { onDropTrack, panel } = deck();
  fireEvent.drop(panel, { dataTransfer: transfer([DJ_TRACK_DRAG_TYPE], { [DJ_TRACK_DRAG_TYPE]: "track-3" }) });
  expect(onDropTrack).toHaveBeenCalledWith("track-3");
});

test("something else dragged over the Deck isn't taken, and leaving takes the light away", () => {
  const { panel } = deck();
  fireEvent.dragEnter(panel, { dataTransfer: transfer(["text/plain"]) });
  expect(panel).not.toHaveAttribute("data-drop");
  fireEvent.dragEnter(panel, { dataTransfer: transfer(["Files"]) });
  fireEvent.dragEnter(screen.getByRole("button", { name: "Set Hot Cue A" }), { dataTransfer: transfer(["Files"]) });
  fireEvent.dragLeave(panel, { dataTransfer: transfer(["Files"]) });
  expect(panel).toHaveAttribute("data-drop", "true");
  fireEvent.dragLeave(screen.getByRole("button", { name: "Set Hot Cue A" }), { dataTransfer: transfer(["Files"]) });
  expect(panel).not.toHaveAttribute("data-drop");
});
