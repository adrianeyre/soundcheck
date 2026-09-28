/**
 * Tap tempo: the tempo a musician taps, from the times of their taps. A gap
 * of more than two seconds starts again, and only the last eight taps count,
 * so a change of mind is heard quickly.
 */

const RESTART_MS = 2000;
const TAPS = 8;

/** The taps kept after one at `now`, in milliseconds. */
export function addTap(taps: readonly number[], now: number): number[] {
  const last = taps.at(-1);
  if (last === undefined || now - last > RESTART_MS || now <= last) return [now];
  return [...taps, now].slice(-TAPS);
}

/** The tempo, in beats per minute to one decimal place, or null before two taps. */
export function tappedTempo(taps: readonly number[]): number | null {
  if (taps.length < 2) return null;
  const average = (taps.at(-1)! - taps[0]!) / (taps.length - 1);
  return Math.round((60_000 / average) * 10) / 10;
}
