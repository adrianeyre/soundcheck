import { expect, test } from "vitest";

import {
  barLines,
  barStart,
  barTicks,
  beatLines,
  beatTicks,
  constantTempoMap,
  formatPosition,
  isBarLine,
  secondsAt,
  tempoAt,
  tempoMapOf,
  tickAfter,
  tickAt,
} from "./time";

const fourFour = { beatsPerBar: 4, beatUnit: 4 };
const sixEight = { beatsPerBar: 6, beatUnit: 8 };

test("beats follow the time signature's note value", () => {
  expect(beatTicks(fourFour)).toBe(960);
  expect(barTicks(fourFour)).toBe(3840);
  expect(beatTicks(sixEight)).toBe(480);
  expect(barTicks(sixEight)).toBe(2880);
});

test("positions read as bar.beat.tick from 1.1.000", () => {
  const map = constantTempoMap(120, fourFour);
  expect(formatPosition(0, map)).toBe("1.1.000");
  expect(formatPosition(960 + 12.7, map)).toBe("1.2.012");
  expect(formatPosition(2880 * 2 + 3 * 480, constantTempoMap(120, sixEight))).toBe("3.4.000");
  expect(formatPosition(-5, map)).toBe("1.1.000");
});

// Two bars of 4/4 at 120, then 60 from beat 3 of bar 2, then 6/8 from bar 3.
const song = tempoMapOf({
  tempo: 120,
  timeSignature: fourFour,
  tempoChanges: [
    { tick: 3840 + 1920, tempo: 60, timeSignature: null },
    { tick: 7680, tempo: null, timeSignature: sixEight },
  ],
});

test("ticks become seconds through each Tempo Change in turn", () => {
  expect(secondsAt(song, 3840)).toBe(2);
  expect(secondsAt(song, 3840 + 1920)).toBe(3);
  expect(secondsAt(song, 7680)).toBe(5);
  expect(secondsAt(song, 7680 + 480)).toBe(5.5);
  expect(tickAt(song, 5.5)).toBe(7680 + 480);
  expect(tickAt(song, 1)).toBe(1920);
  expect(tempoAt(song, 7680)).toBe(60);
  // Audio starting on beat 2 for two seconds runs on at the slower tempo.
  expect(tickAfter(song, 3840 + 960, 2)).toBe(3840 + 1920 + 1440);
});

test("a time signature change starts a new bar grid; a tempo alone doesn't", () => {
  expect(formatPosition(3840 + 1920 + 960, song)).toBe("2.4.000");
  expect(formatPosition(7680, song)).toBe("3.1.000");
  expect(formatPosition(7680 + 2880 + 480, song)).toBe("4.2.000");
  expect(barStart(song, 4)).toBe(7680 + 2880);
  expect(barStart(song, 2)).toBe(3840);
  expect(isBarLine(song, 7680 + 2880)).toBe(true);
  expect(isBarLine(song, 7680 + 3840)).toBe(false);
  expect(barLines(song, 1, 7680 + 2880)).toEqual([
    { tick: 3840, bar: 2 },
    { tick: 7680, bar: 3 },
    { tick: 10560, bar: 4 },
  ]);
  expect(beatLines(song, 6720, 7680 + 960)).toEqual([6720, 7680, 8160, 8640]);
});
