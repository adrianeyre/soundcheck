// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { STARTER_KIT } from "../project/model";
import { DrumKit, kitPieces } from "./DrumKit";

afterEach(cleanup);

test("each Pad of the Starter Kit sits on its drum, and the rest get a pad of their own", () => {
  const pieces = kitPieces(STARTER_KIT);
  const on = (id: string) => pieces.find((piece) => piece.id === id)!.pads.map((pad) => pad.name);
  expect(on("kick")).toEqual(["Kick"]);
  expect(on("snare")).toEqual(["Snare"]);
  expect(on("hat")).toEqual(["Closed Hat", "Open Hat"]);
  expect(on("highTom")).toEqual(["High Tom"]);
  expect(on("midTom")).toEqual(["Low Tom"]);
  expect(on("crash")).toEqual([]);
  // The clap and cowbell aren't drums of the kit.
  expect(pieces.filter((piece) => piece.id.startsWith("extra:")).map((piece) => piece.pads[0]!.name)).toEqual(["Clap", "Cowbell"]);
  // Every Pad is somewhere.
  expect(pieces.flatMap((piece) => piece.pads)).toHaveLength(STARTER_KIT.length);
});

test("what is hit lights up and is named", () => {
  const { container } = render(<DrumKit trackName="Drums" pads={STARTER_KIT} hitting={new Set([36, 42])} />);
  expect(screen.getByRole("group", { name: "Drums drum kit: hitting Kick, Closed Hat" })).toBeInTheDocument();
  expect(container.querySelectorAll('[data-hit="true"]')).toHaveLength(2);
});

test("clicking or pressing Enter on a drum hits its Pad", () => {
  const onHit = vi.fn<(note: number, on: boolean) => void>();
  render(<DrumKit trackName="Drums" pads={STARTER_KIT} hitting={new Set()} onHit={onHit} />);
  const snare = screen.getByRole("button", { name: "Hit Snare" });
  fireEvent.pointerDown(snare);
  fireEvent.pointerUp(snare);
  expect(onHit.mock.calls).toEqual([
    [38, true],
    [38, false],
  ]);
  fireEvent.keyDown(screen.getByRole("button", { name: "Hit Kick" }), { key: "Enter" });
  expect(onHit).toHaveBeenLastCalledWith(36, true);
});
