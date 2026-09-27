import { expect, test } from "vitest";

import { compareAnalyses, chooseAnalyses, type KeptAnalysis } from "./compare";
import { InvalidToolCall } from "./tools";

interface Levels {
  integrated?: number | null;
  shortTerm?: number | null;
  rms?: number | null;
  samplePeak?: number | null;
  truePeak?: number | null;
  clipped?: number;
  regions?: number;
  mid?: number | null;
  onsets?: number;
}

/** Measurements in the engine's JSON shape, with a loud mix's numbers unless given. */
function measurements({
  integrated = -8,
  shortTerm = -7,
  rms = -9,
  samplePeak = 0,
  truePeak = 1.2,
  clipped = 1200,
  regions = 3,
  mid = -12,
  onsets = 4,
}: Levels = {}): string {
  return JSON.stringify({
    source: "mix",
    start: { s: 0, at: "1.1" },
    end: { s: 2, at: "2.1" },
    loudness: { integrated_lufs: integrated, max_short_term_lufs: shortTerm, short_term: [] },
    rms_db: rms,
    sample_peak_db: samplePeak,
    true_peak_dbtp: truePeak,
    clipping: { clipped_samples: clipped, region_count: regions, regions: [] },
    bands_db: { sub: -30, bass: -20, low_mid: -15, mid, high_mid: -18, high: -25 },
    key: null,
    tempo: null,
    onsets: { count: onsets, at: [] },
  });
}

function kept(id: string, levels: Levels = {}, heard: Partial<KeptAnalysis> = {}): KeptAnalysis {
  return {
    id,
    trackId: null,
    what: "the whole mix",
    span: "from 1.1.000 (0 s) to 2.1.000 (2 s)",
    start: 0,
    end: 3840,
    measurements: measurements(levels),
    ...heard,
  };
}

const lead = { trackId: "lead", what: "Track lead (“Lead”) on its own" };
const secondBar = { start: 3840, end: 7680, span: "from 2.1.000 (2 s) to 3.1.000 (4 s)" };

/** Why `run` was refused, as the model is told. */
function refusal(run: () => unknown): string {
  let refused: unknown = null;
  try {
    run();
  } catch (reason) {
    refused = reason;
  }
  expect(refused).toBeInstanceOf(InvalidToolCall);
  return (refused as InvalidToolCall).message;
}

test("by default the first and the latest analysis of what was heard last are compared", () => {
  const analyses = [kept("a1"), kept("a2", {}, lead), kept("a3", {}, lead), kept("a4")];
  expect(chooseAnalyses(analyses).map(({ id }) => id)).toEqual(["a1", "a4"]);
  // The latest was of Lead: the first of Lead is what it is compared with.
  expect(chooseAnalyses(analyses.slice(0, 3)).map(({ id }) => id)).toEqual(["a2", "a3"]);
});

test("with only one of before and after, the other is the first or latest of the same target and range", () => {
  const analyses = [kept("a1"), kept("a2", {}, lead), kept("a3"), kept("a4", {}, lead), kept("a5")];
  expect(chooseAnalyses(analyses, "a2").map(({ id }) => id)).toEqual(["a2", "a4"]);
  expect(chooseAnalyses(analyses, undefined, "a3").map(({ id }) => id)).toEqual(["a1", "a3"]);
  expect(chooseAnalyses(analyses, "a3", "a5").map(({ id }) => id)).toEqual(["a3", "a5"]);
});

test("analyses of different targets are refused, saying why", () => {
  const message = refusal(() => chooseAnalyses([kept("a1"), kept("a2", {}, lead)], "a1", "a2"));
  expect(message).toMatch(/^a1 heard the whole mix and a2 heard Track lead \(“Lead”\) on its own: /);
  expect(message).toMatch(/only two analyses of the same thing over the same range compare/);
});

test("analyses of different ranges are refused, saying why", () => {
  const message = refusal(() => chooseAnalyses([kept("a1"), kept("a2", {}, secondBar)], "a1", "a2"));
  expect(message).toMatch(/^a1 heard from 1\.1\.000 \(0 s\) to 2\.1\.000 \(2 s\) and a2 from 2\.1\.000 \(2 s\) to 3\.1\.000 \(4 s\): /);
  expect(message).toMatch(/only two analyses of the same thing over the same range compare/);
});

test("a comparison needs two analyses of the same thing", () => {
  expect(refusal(() => chooseAnalyses([]))).toMatch(/no analyses to compare yet/);
  expect(refusal(() => chooseAnalyses([kept("a1"), kept("a2", {}, lead)]))).toMatch(
    /^a2 is the only analysis of Track lead \(“Lead”\) on its own from 1\.1\.000 \(0 s\) to 2\.1\.000 \(2 s\)/,
  );
  expect(refusal(() => chooseAnalyses([kept("a1"), kept("a2")], "a2", "a2"))).toMatch(/two different analyses/);
  expect(refusal(() => chooseAnalyses([kept("a1"), kept("a2")], "a1", "a9"))).toMatch(/There is no analysis "a9".*The analyses so far are: a1 \(the whole mix/);
});

test("the comparison gives each measurement before and after, and the change", () => {
  const content = compareAnalyses(kept("a1"), kept("a2", { integrated: -14.1, truePeak: -1.5, clipped: 0, regions: 0, mid: null, onsets: 3 }));
  const [heading, json] = content.split("\n");
  expect(heading).toBe("a1 and a2 compared, the whole mix from 1.1.000 (0 s) to 2.1.000 (2 s), before and after:");
  const compared = JSON.parse(json!) as Record<string, unknown>;
  expect(compared).toMatchObject({
    integrated_lufs: { before: -8, after: -14.1, change: -6.1 },
    max_short_term_lufs: { before: -7, after: -7, change: 0 },
    true_peak_dbtp: { before: 1.2, after: -1.5, change: -2.7 },
    clipped_samples: { before: 1200, after: 0, change: -1200 },
    clip_regions: { before: 3, after: 0, change: -3 },
    onsets: { before: 4, after: 3, change: -1 },
  });
  // Silence has no level, so no change either.
  expect(compared).toHaveProperty("bands_db.mid", { before: -12, after: null, change: null });
  expect(compared).toHaveProperty("bands_db.bass", { before: -20, after: -20, change: 0 });
});

test("the last line says what got better and what got worse", () => {
  const fixed = compareAnalyses(kept("a1"), kept("a2", { integrated: -14, truePeak: -1.5, clipped: 0, regions: 0 }));
  expect(fixed.split("\n").at(-1)).toBe(
    "Better: clipping is gone (1200 samples clipped before, none after); the true peak is within the ceiling of -1 dBTP now (1.2 dBTP before, -1.5 dBTP after). Worse: nothing. Also: 6 LU quieter overall.",
  );

  const broken = compareAnalyses(
    kept("a1", { truePeak: -3, clipped: 0, regions: 0 }),
    kept("a2", { integrated: -6, truePeak: 0.4, clipped: 20, mid: -8, onsets: 6 }),
  );
  expect(broken.split("\n").at(-1)).toBe(
    "Better: nothing. Worse: 20 samples clip now, where none did; the true peak is above the ceiling of -1 dBTP now (-3 dBTP before, 0.4 dBTP after). Also: 2 LU louder overall; the mid band 4 dB louder; 2 more onsets.",
  );

  const unchanged = compareAnalyses(kept("a1", { truePeak: -3, clipped: 0 }), kept("a2", { truePeak: -3, clipped: 0, mid: -12.4 }));
  expect(unchanged.split("\n").at(-1)).toBe("Better: nothing. Worse: nothing. Also: no change of 1 dB or more.");
});

test("fewer or more clipped samples, and a true peak that moves while over the ceiling, are better or worse", () => {
  const less = compareAnalyses(kept("a1"), kept("a2", { clipped: 300, truePeak: 0.3 }));
  expect(less.split("\n").at(-1)).toMatch(
    /^Better: fewer samples clip \(1200 before, 300 after\); the true peak is lower, 0\.3 dBTP from 1\.2 dBTP, but still above the ceiling of -1 dBTP\. Worse: nothing\./,
  );
  const more = compareAnalyses(kept("a1"), kept("a2", { clipped: 1500, truePeak: 2 }));
  expect(more.split("\n").at(-1)).toMatch(
    /^Better: nothing\. Worse: more samples clip \(1200 before, 1500 after\); the true peak is higher, 2 dBTP from 1\.2 dBTP, and above the ceiling of -1 dBTP\./,
  );
});

test("sound that goes silent is worse", () => {
  const silent = { integrated: null, shortTerm: null, rms: null, samplePeak: null, truePeak: null, clipped: 0, regions: 0 };
  const gone = compareAnalyses(kept("a1"), kept("a2", silent));
  expect(gone.split("\n").at(-1)).toMatch(/^Better: clipping is gone \(1200 samples clipped before, none after\)\. Worse: it is silent now\./);
});
