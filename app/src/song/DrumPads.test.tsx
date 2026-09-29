// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { type DrumPad, nextDrumPad, STARTER_KIT } from "../project/model";
import { LIMITS } from "../project/validate";
import { DrumPads } from "./DrumPads";

afterEach(cleanup);

/** `count` Pads, as adding them one at a time from none gives. */
function padsOf(count: number): DrumPad[] {
  const pads: DrumPad[] = [];
  while (pads.length < count) pads.push(nextDrumPad(pads));
  return pads;
}

function renderPads(pads: readonly DrumPad[], handlers: { onAddPad?: () => void; onRemovePad?: () => void }) {
  render(<DrumPads trackName="Drums" pads={pads} sampleNames={[]} onPad={vi.fn<(pad: number, settings: Partial<DrumPad>) => void>()} onLoad={vi.fn<(pad: number, file: File) => void>()} {...handlers} />);
}

const add = () => screen.getByRole("button", { name: "Add Pad" });
const remove = () => screen.getByRole("button", { name: "Remove last Pad" });

test("a Pad is added after the last and the last one taken off, with a row for each", () => {
  const onAddPad = vi.fn<() => void>();
  const onRemovePad = vi.fn<() => void>();
  renderPads(STARTER_KIT.slice(0, 8), { onAddPad, onRemovePad });
  expect(screen.getAllByRole("row")).toHaveLength(9);
  expect(screen.getByText("8 of 32 Pads")).toBeInTheDocument();
  fireEvent.click(add());
  expect(onAddPad).toHaveBeenCalledOnce();
  fireEvent.click(remove());
  expect(onRemovePad).toHaveBeenCalledOnce();
});

test("Add is off at the most Pads a Drum Sampler holds, and Remove at the fewest", () => {
  renderPads(padsOf(LIMITS.drumPads[1]), { onAddPad: vi.fn<() => void>(), onRemovePad: vi.fn<() => void>() });
  expect(add()).toBeDisabled();
  expect(remove()).toBeEnabled();
  expect(screen.getByRole("rowheader", { name: "Pad 32" })).toBeInTheDocument();
  cleanup();

  renderPads(padsOf(LIMITS.drumPads[0]), { onAddPad: vi.fn<() => void>(), onRemovePad: vi.fn<() => void>() });
  expect(add()).toBeEnabled();
  expect(remove()).toBeDisabled();
});

test("without the handlers there are no buttons", () => {
  renderPads(STARTER_KIT, {});
  expect(screen.queryByRole("button", { name: "Add Pad" })).not.toBeInTheDocument();
});
