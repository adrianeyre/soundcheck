import { readFileSync } from "node:fs";

import { dj_effects, initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import {
  BEAT_FX,
  barBeat,
  beatsLabel,
  beatsUntil,
  camelotName,
  COLOUR_FX,
  compatible,
  endWarning,
  formatTempo,
  formatTime,
  keyName,
  keySyncShift,
  LOOP_BEATS,
  meterFraction,
  quantize,
  TapTempo,
} from "./dj-logic";
import { DJ_REPORT_LEN, EMPTY_REPORT, GLOBAL_FIELDS, DECK_FIELDS, readDjReport } from "./dj-report";
import { mixerSettings, NEW_MIXER, newChannel } from "./dj-state";
import { sortTracks } from "./TrackBrowser";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

test("the page's lists and report are the engine's", () => {
  const engine = JSON.parse(dj_effects()) as { beatFx: string[]; colourFx: string[]; reportLength: number };
  expect(BEAT_FX.map((fx) => fx.id)).toEqual(engine.beatFx);
  expect(COLOUR_FX.map((fx) => fx.id)).toEqual(engine.colourFx);
  expect(DJ_REPORT_LEN).toBe(engine.reportLength);
});

test("keys are named and placed on the Camelot wheel", () => {
  expect(camelotName({ tonic: 0, minor: false })).toBe("8B");
  expect(camelotName({ tonic: 9, minor: true })).toBe("8A");
  expect(camelotName({ tonic: 7, minor: false })).toBe("9B");
  expect(camelotName({ tonic: 5, minor: false })).toBe("7B");
  expect(camelotName({ tonic: 4, minor: true })).toBe("9A");
  expect(camelotName({ tonic: 11, minor: false })).toBe("1B");
  expect(keyName({ tonic: 6, minor: true })).toBe("F♯m");
});

test("keys a step round the wheel, or relative, mix", () => {
  const c = { tonic: 0, minor: false };
  expect(compatible(c, { tonic: 7, minor: false })).toBe(true);
  expect(compatible(c, { tonic: 5, minor: false })).toBe(true);
  expect(compatible(c, { tonic: 9, minor: true })).toBe(true);
  expect(compatible(c, { tonic: 2, minor: false })).toBe(false);
  expect(compatible(c, { tonic: 1, minor: false })).toBe(false);
});

test("Key Sync shifts as little as it takes", () => {
  const master = { tonic: 0, minor: false };
  expect(keySyncShift({ tonic: 7, minor: false }, master)).toBe(0);
  expect(keySyncShift({ tonic: 1, minor: false }, master)).toBe(-1);
  expect(keySyncShift({ tonic: 2, minor: false }, master)).toBe(-2);
});

test("the Beat Grid's arithmetic", () => {
  expect(quantize(1.1, 120, 0)).toBe(1);
  expect(quantize(1.2, 120, 0.05)).toBeCloseTo(1.05, 9);
  expect(beatsUntil(0, 2, 120)).toBe(4);
  expect(beatsUntil(3, 2, 120)).toBeNull();
  expect(barBeat(0, 120, 0)).toBe("1.1");
  expect(barBeat(2.6, 120, 0)).toBe("2.2");
  expect(barBeat(1, 0, 0)).toBe("—");
});

test("readouts", () => {
  expect(formatTime(187.44)).toBe("3:07.4");
  expect(formatTempo(0.0235)).toBe("+2.35%");
  expect(formatTempo(-0.1)).toBe("−10.00%");
  expect(beatsLabel(1 / 32)).toBe("1/32");
  expect(beatsLabel(3 / 4)).toBe("3/4");
  expect(beatsLabel(16)).toBe("4 bars");
  expect(beatsLabel(2)).toBe("2");
  expect(LOOP_BEATS[0]).toBe(1 / 32);
  expect(LOOP_BEATS.at(-1)).toBe(512);
  expect(endWarning(200, 220)).toBe(true);
  expect(endWarning(100, 220)).toBe(false);
  expect(meterFraction(1)).toBe(1);
  expect(meterFraction(0)).toBe(0);
});

test("tap tempo averages the taps and starts again after a pause", () => {
  const tap = new TapTempo();
  expect(tap.tap(0)).toBeNull();
  expect(tap.tap(500)).toBe(120);
  expect(tap.tap(1_000)).toBe(120);
  expect(tap.tap(5_000)).toBeNull();
  expect(tap.tap(5_400)).toBe(150);
});

test("the report reads the engine's layout", () => {
  expect(readDjReport(null)).toBe(EMPTY_REPORT);
  const flat: number[] = Array.from({ length: DJ_REPORT_LEN }, () => 0);
  flat[2] = 1;
  flat[3] = 126;
  const deck = (index: number, field: number, value: number) => (flat[GLOBAL_FIELDS + index * DECK_FIELDS + field] = value);
  deck(1, 0, 1);
  deck(1, 1, 1);
  deck(1, 2, 12.5);
  deck(1, 7, 1);
  deck(1, 8, 10);
  deck(1, 9, 12);
  deck(1, 11, -1);
  const report = readDjReport(flat);
  expect(report.syncMaster).toBe(1);
  expect(report.masterBpm).toBe(126);
  expect(report.decks[1]).toMatchObject({ loaded: true, playing: true, position: 12.5, loop: { start: 10, end: 12 }, slipPosition: null });
  expect(report.decks[0]!.loaded).toBe(false);
});

test("every knob is sent under the engine's names", () => {
  const settings = mixerSettings([newChannel(0), newChannel(1)], NEW_MIXER);
  expect(settings.filter((s) => s.kind === "channel")).toHaveLength(2 * 11);
  expect(settings).toContainEqual({ kind: "channel", index: 1, name: "assign", value: 2 });
  expect(settings).toContainEqual({ kind: "mixer", index: 0, name: "colourType", value: 5 });
});

const track = (name: string, bpm: number | null) => ({
  id: name,
  name,
  bytes: new Uint8Array(),
  analysis: bpm === null ? null : { seconds: 60, bpm, firstBeat: 0, key: null, waveformRate: 100, waveform: [] },
});

test("the Track browser sorts by any column, unanalysed files last", () => {
  const tracks = [track("b.mp3", 128), track("a.mp3", null), track("c.wav", 120)];
  expect(sortTracks(tracks, "title", true).map((t) => t.id)).toEqual(["a.mp3", "b.mp3", "c.wav"]);
  expect(sortTracks(tracks, "bpm", true).map((t) => t.id)).toEqual(["c.wav", "b.mp3", "a.mp3"]);
  expect(sortTracks(tracks, "bpm", false).map((t) => t.id)).toEqual(["a.mp3", "b.mp3", "c.wav"]);
});
