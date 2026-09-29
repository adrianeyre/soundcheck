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
  expect(on("kick")).toEqual(["Kick", "Hard Kick"]);
  expect(on("snare")).toEqual(["Snare", "Rimshot", "Electric Snare"]);
  expect(on("hat")).toEqual(["Closed Hat", "Open Hat"]);
  expect(on("hatPedal")).toEqual(["Pedal Hat"]);
  expect(on("highTom")).toEqual(["High Tom"]);
  expect(on("midTom")).toEqual(["Mid Tom"]);
  expect(on("lowTom")).toEqual(["Low Tom"]);
  expect(on("floorTom")).toEqual(["Low Floor Tom"]);
  expect(on("crash")).toEqual(["Crash"]);
  expect(on("splash")).toEqual(["Splash"]);
  expect(on("ride")).toEqual(["Ride"]);
  // The hand percussion isn't drums of the kit.
  const extras = pieces.filter((piece) => piece.id.startsWith("extra:"));
  expect(extras.map((piece) => piece.pads[0]!.name)).toEqual(["Clap", "Cowbell", "Tambourine", "Hi Conga", "Low Conga", "Maracas", "Claves"]);
  // They fit in the picture, clear of each other.
  for (const piece of extras) expect(piece.x + piece.r).toBeLessThanOrEqual(420);
  expect(new Set(extras.map((piece) => `${piece.x},${piece.y}`)).size).toBe(extras.length);
  // Every Pad is somewhere.
  expect(pieces.flatMap((piece) => piece.pads)).toHaveLength(STARTER_KIT.length);
});

test("what is hit lights up and is named", () => {
  const { container } = render(<DrumKit trackName="Drums" pads={STARTER_KIT} hitting={new Set([36, 42])} />);
  expect(screen.getByRole("group", { name: "Drums drum kit: hitting Kick, Closed Hat" })).toBeInTheDocument();
  expect(container.querySelectorAll('[data-hit="true"]')).toHaveLength(2);
});

test("every Pad of the Starter Kit can be hit on its own, and the buttons fit in the picture", () => {
  const onHit = vi.fn<(note: number, on: boolean) => void>();
  render(<DrumKit trackName="Drums" pads={STARTER_KIT} hitting={new Set()} onHit={onHit} />);
  for (const pad of STARTER_KIT) {
    fireEvent.pointerDown(screen.getByRole("button", { name: `Hit ${pad.name}` }));
    expect(onHit).toHaveBeenLastCalledWith(pad.note, true);
  }
  for (const piece of kitPieces(STARTER_KIT)) {
    for (const chip of piece.chips) {
      expect(chip.x - 10).toBeGreaterThanOrEqual(0);
      expect(chip.x + 10).toBeLessThanOrEqual(420);
      expect(chip.y - 10).toBeGreaterThanOrEqual(0);
      expect(chip.y + 10).toBeLessThanOrEqual(224);
    }
  }
});

test("a piece's other Pads, past what the kit draws, still get a button each", () => {
  const pads = [36, 35, 40, 37, 38].map((note, index) => ({ ...STARTER_KIT[0]!, name: `Pad ${index + 1}`, note }));
  const pieces = kitPieces(pads);
  expect(pieces.find((piece) => piece.id === "kick")!.chips).toHaveLength(1);
  expect(pieces.find((piece) => piece.id === "snare")!.chips).toHaveLength(2);
});

test("clicking or pressing Enter on a drum hits its Pad", () => {
  const onHit = vi.fn<(note: number, on: boolean) => void>();
  render(<DrumKit trackName="Drums" pads={STARTER_KIT} hitting={new Set()} onHit={onHit} />);
  // The snare holds three Pads: the drum hits the first, and each of the others has a button.
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
