// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { AddTrack } from "./TrackList";

afterEach(cleanup);

test("the empty place at the end of the Tracks offers each kind of Track, with its stripe, and adds the one chosen", () => {
  const add = { instrument: vi.fn<() => void>(), drum: vi.fn<() => void>(), audio: vi.fn<() => void>() };
  render(
    <AddTrack
      choices={[
        { id: "instrument", kind: "instrument", label: "Instrument", onAdd: add.instrument },
        { id: "drum", kind: "drum", label: "Drum", onAdd: add.drum },
        { id: "audio", kind: "audio", label: "Audio", onAdd: add.audio },
      ]}
    />,
  );
  const place = screen.getByRole("group", { name: "Add a Track" });
  expect(within(place).getAllByRole("button").map((choice) => [choice.getAttribute("aria-label"), choice.dataset.trackKind])).toEqual([
    ["Add Instrument Track", "instrument"],
    ["Add Drum Track", "drum"],
    ["Add Audio Track", "audio"],
  ]);
  fireEvent.click(within(place).getByRole("button", { name: "Add Drum Track" }));
  expect(add.drum).toHaveBeenCalledOnce();
  expect(add.instrument).not.toHaveBeenCalled();
});
