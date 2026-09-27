/**
 * Levels as the mixer shows them. The Project stores linear gain, because
 * that is what the engine multiplies by; faders and meters are read in
 * decibels, because that is what ears hear.
 */

/** The quietest level a meter or a fader readout shows. */
export const FLOOR_DB = -60;

/** A sample at or above this is at full scale, and the meter says so. */
export const CLIP_GAIN = 1;

export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;
}

/** A level as it is written on a fader or a meter: "-6.0 dB", or "-∞". */
export function formatDb(gain: number): string {
  const db = gainToDb(gain);
  if (db <= FLOOR_DB) return "-∞ dB";
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

/**
 * How full a meter or fader reads, 0 to 1, on a decibel scale from
 * `FLOOR_DB` to 0 dB. Anything above full scale reads full.
 */
export function levelFraction(gain: number): number {
  const db = gainToDb(gain);
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}
