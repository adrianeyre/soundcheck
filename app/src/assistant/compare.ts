/**
 * Before and after: two `analyse_audio` results of one Request, compared,
 * so the Assistant can check that a fix did what it was meant to.
 *
 * Each analysis a Request makes is kept for the rest of it with an id
 * (`a1`, `a2`, …), and `compare_audio` takes two of them. Only two of the
 * same thing (the whole mix, or the same Track on its own) over the same
 * ticks compare: then every difference is the Request's change, not a
 * difference in what was heard.
 *
 * The engine's measurements are numbers already; this only takes one set
 * from the other, so it needs no engine.
 */
import { InvalidToolCall, TRUE_PEAK_CEILING_DBTP, type Heard } from "./tools";

/** An `analyse_audio` result, kept for the rest of its Request. */
export interface KeptAnalysis extends Heard {
  /** What `compare_audio` names it by. */
  id: string;
  /** The ticks heard, from the top of the song. */
  start: number;
  end: number;
  /** The engine's JSON, as the model read it. */
  measurements: string;
}

/** The id the `n`th analysis of a Request is kept by, counting from 1. */
export function analysisId(n: number): string {
  return `a${n}`;
}

/** The smallest change of level, in dB or LU, the last line mentions: about the least most people hear. */
export const NOTICEABLE_DB = 1;

const CEILING = `the ceiling of ${TRUE_PEAK_CEILING_DBTP} dBTP`;

function reject(message: string): never {
  throw new InvalidToolCall(message);
}

function sameTarget(a: KeptAnalysis, b: KeptAnalysis): boolean {
  return a.trackId === b.trackId;
}

function sameRange(a: KeptAnalysis, b: KeptAnalysis): boolean {
  return a.start === b.start && a.end === b.end;
}

function comparable(a: KeptAnalysis, b: KeptAnalysis): boolean {
  return sameTarget(a, b) && sameRange(a, b);
}

/**
 * The two analyses `compare_audio` compares: `before` and `after` by id,
 * or, left out, the first and the latest of the same target and range as
 * the other. With neither, `after` is the latest analysis of all. Throws
 * `InvalidToolCall`, saying why, when there aren't two that compare.
 */
export function chooseAnalyses(kept: readonly KeptAnalysis[], beforeId?: string, afterId?: string): [KeptAnalysis, KeptAnalysis] {
  if (kept.length === 0) {
    reject("There are no analyses to compare yet: call analyse_audio before the change and again after it, then compare_audio.");
  }
  const find = (id: string) =>
    kept.find((analysis) => analysis.id === id) ??
    reject(`There is no analysis ${JSON.stringify(id)} in this Request. The analyses so far are: ${kept.map(listed).join(", ")}.`);

  const given = beforeId === undefined ? null : find(beforeId);
  const after = afterId !== undefined ? find(afterId) : given ? kept.findLast((analysis) => comparable(analysis, given))! : kept.at(-1)!;
  const before = given ?? kept.find((analysis) => comparable(analysis, after))!;

  if (before === after) {
    if (beforeId !== undefined && afterId !== undefined) reject("before and after must be two different analyses.");
    reject(
      `${after.id} is the only analysis of ${after.what} ${after.span} so far: analyse the same again after the change, then compare the two.`,
    );
  }
  const why = "only two analyses of the same thing over the same range compare, so that every difference is the change you made.";
  if (!sameTarget(before, after)) {
    reject(`${before.id} heard ${before.what} and ${after.id} heard ${after.what}: ${why} Analyse ${before.what} again, then compare.`);
  }
  if (!sameRange(before, after)) {
    reject(`${before.id} heard ${before.span} and ${after.id} ${after.span}: ${why} Analyse the same range again, then compare.`);
  }
  return [before, after];
}

function listed(analysis: KeptAnalysis): string {
  return `${analysis.id} (${analysis.what} ${analysis.span})`;
}

/** What of the engine's measurements are compared. */
interface Measured {
  loudness: { integrated_lufs: number | null; max_short_term_lufs: number | null };
  rms_db: number | null;
  sample_peak_db: number | null;
  true_peak_dbtp: number | null;
  clipping: { clipped_samples: number; region_count: number };
  bands_db: Record<string, number | null>;
  onsets: { count: number };
}

interface Change {
  before: number | null;
  after: number | null;
  /** After less before, or null when either is silence. */
  change: number | null;
}

function change(before: number | null, after: number | null): Change {
  // To 0.1, as the engine rounds its levels; and never "-0".
  const difference = before === null || after === null ? null : Math.round((after - before) * 10) / 10 || 0;
  return { before, after, change: difference };
}

/**
 * What `compare_audio` tells the model: which analyses, each measurement
 * before and after and the change, and a last line on what got better or
 * worse.
 */
export function compareAnalyses(before: KeptAnalysis, after: KeptAnalysis): string {
  const was = JSON.parse(before.measurements) as Measured;
  const is = JSON.parse(after.measurements) as Measured;
  const compared = {
    integrated_lufs: change(was.loudness.integrated_lufs, is.loudness.integrated_lufs),
    max_short_term_lufs: change(was.loudness.max_short_term_lufs, is.loudness.max_short_term_lufs),
    rms_db: change(was.rms_db, is.rms_db),
    sample_peak_db: change(was.sample_peak_db, is.sample_peak_db),
    true_peak_dbtp: change(was.true_peak_dbtp, is.true_peak_dbtp),
    clipped_samples: change(was.clipping.clipped_samples, is.clipping.clipped_samples),
    clip_regions: change(was.clipping.region_count, is.clipping.region_count),
    bands_db: Object.fromEntries(Object.keys(was.bands_db).map((band) => [band, change(was.bands_db[band]!, is.bands_db[band] ?? null)])),
    onsets: change(was.onsets.count, is.onsets.count),
  };
  return [
    `${before.id} and ${after.id} compared, ${after.what} ${after.span}, before and after:`,
    JSON.stringify(compared),
    verdict(was, is),
  ].join("\n");
}

/** A number as the model reads it elsewhere: to 0.1, without trailing zeros. */
function number(value: number): string {
  return String(Math.round(value * 10) / 10 || 0);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function listOf(items: readonly string[]): string {
  return items.length > 0 ? items.join("; ") : "nothing";
}

/** What got better, what got worse, and what else changed enough to hear. */
function verdict(was: Measured, is: Measured): string {
  const better: string[] = [];
  const worse: string[] = [];
  const also: string[] = [];

  const clippedBefore = was.clipping.clipped_samples;
  const clippedAfter = is.clipping.clipped_samples;
  if (clippedBefore > 0 && clippedAfter === 0) better.push(`clipping is gone (${plural(clippedBefore, "sample", "samples")} clipped before, none after)`);
  else if (clippedBefore === 0 && clippedAfter > 0) worse.push(`${plural(clippedAfter, "sample clips", "samples clip")} now, where none did`);
  else if (clippedAfter < clippedBefore) better.push(`fewer samples clip (${clippedBefore} before, ${clippedAfter} after)`);
  else if (clippedAfter > clippedBefore) worse.push(`more samples clip (${clippedBefore} before, ${clippedAfter} after)`);

  const peakBefore = was.true_peak_dbtp;
  const peakAfter = is.true_peak_dbtp;
  if (peakBefore !== null && peakAfter === null) worse.push("it is silent now");
  else if (peakBefore === null && peakAfter !== null) also.push("it was silent and isn't now");
  else if (peakBefore !== null && peakAfter !== null) {
    const overBefore = peakBefore > TRUE_PEAK_CEILING_DBTP;
    const overAfter = peakAfter > TRUE_PEAK_CEILING_DBTP;
    const peaks = `(${number(peakBefore)} dBTP before, ${number(peakAfter)} dBTP after)`;
    if (overBefore && !overAfter) better.push(`the true peak is within ${CEILING} now ${peaks}`);
    else if (!overBefore && overAfter) worse.push(`the true peak is above ${CEILING} now ${peaks}`);
    else if (overAfter && peakAfter < peakBefore) {
      better.push(`the true peak is lower, ${number(peakAfter)} dBTP from ${number(peakBefore)} dBTP, but still above ${CEILING}`);
    } else if (overAfter && peakAfter > peakBefore) {
      worse.push(`the true peak is higher, ${number(peakAfter)} dBTP from ${number(peakBefore)} dBTP, and above ${CEILING}`);
    }
  }

  // Louder or quieter is neither better nor worse: that depends on the Request.
  const level = (before: number | null, after: number | null, say: (by: string, way: string) => string) => {
    if (before === null || after === null || Math.abs(after - before) < NOTICEABLE_DB) return;
    also.push(say(number(Math.abs(after - before)), after > before ? "louder" : "quieter"));
  };
  level(was.loudness.integrated_lufs, is.loudness.integrated_lufs, (by, way) => `${by} LU ${way} overall`);
  level(was.loudness.max_short_term_lufs, is.loudness.max_short_term_lufs, (by, way) => `${by} LU ${way} at its loudest`);
  for (const band of Object.keys(was.bands_db)) {
    level(was.bands_db[band]!, is.bands_db[band] ?? null, (by, way) => `the ${band.replace("_", "-")} band ${by} dB ${way}`);
  }
  const onsets = is.onsets.count - was.onsets.count;
  if (onsets !== 0) also.push(`${Math.abs(onsets)} ${onsets > 0 ? "more" : "fewer"} ${Math.abs(onsets) === 1 ? "onset" : "onsets"}`);

  const noticed = also.length > 0 ? listOf(also) : `no change of ${NOTICEABLE_DB} dB or more`;
  return `Better: ${listOf(better)}. Worse: ${listOf(worse)}. Also: ${noticed}.`;
}
