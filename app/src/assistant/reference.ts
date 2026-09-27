/**
 * The mix against the Reference Track (#106), for `compare_to_reference`:
 * an analysis of the mix and one of the whole reference, set side by side,
 * so the Assistant hears how the musician's mix differs from a finished
 * song they want it to sound like.
 *
 * The reference is measured once, whole, and never rendered: it isn't in
 * the mix. Louder or quieter says nothing on its own about the balance, so
 * the band differences are also given with the loudness difference taken
 * out, as if the two were played at the same loudness.
 */
import type { LoadedSamples } from "../project/engine-sync";
import { measureReference } from "../reference/reference-player";
import { fileName } from "../storage/project-folder";
import { type KeptAnalysis, NOTICEABLE_DB } from "./compare";

/**
 * Measure the Reference Track, whose file is `file` in the Project: the
 * engine's compact Audio Analysis JSON of all of it. Throws with what is
 * wrong when it can't be.
 */
export type HearReference = (file: string) => Promise<string>;

/** The Reference Track measured from the audio in memory, where the Project's files are. */
export function hearReferenceIn(samples: LoadedSamples): HearReference {
  return (file) => {
    const sample = samples.get(file);
    if (!sample) throw new Error(`${fileName(file)} isn't in the Project folder: add the Reference Track again.`);
    return measureReference(sample);
  };
}

/** What of the engine's measurements are set side by side. */
interface Measured {
  end: { s: number };
  loudness: { integrated_lufs: number | null; max_short_term_lufs: number | null };
  rms_db: number | null;
  true_peak_dbtp: number | null;
  bands_db: Record<string, number | null>;
}

interface Against {
  mix: number | null;
  reference: number | null;
  /** The mix less the reference, or null when either is silence. */
  difference: number | null;
}

/** To 0.1, as the engine rounds its levels; and never "-0". */
function round(value: number): number {
  return Math.round(value * 10) / 10 || 0;
}

function against(mix: number | null, reference: number | null): Against {
  return { mix, reference, difference: mix === null || reference === null ? null : round(mix - reference) };
}

/**
 * What `compare_to_reference` tells the model: which of the mix was heard
 * against the reference, each measurement of both and the difference, and
 * a last line on the differences big enough to hear.
 */
export function compareToReference(mix: KeptAnalysis, referenceName: string, referenceMeasurements: string): string {
  const ours = JSON.parse(mix.measurements) as Measured;
  const theirs = JSON.parse(referenceMeasurements) as Measured;
  const loudness = against(ours.loudness.integrated_lufs, theirs.loudness.integrated_lufs);
  const bands = Object.fromEntries(
    Object.keys(ours.bands_db).map((band) => {
      const side = against(ours.bands_db[band]!, theirs.bands_db[band] ?? null);
      const matched = side.difference === null || loudness.difference === null ? null : round(side.difference - loudness.difference);
      return [band, { ...side, matched }];
    }),
  );
  const compared = {
    integrated_lufs: loudness,
    max_short_term_lufs: against(ours.loudness.max_short_term_lufs, theirs.loudness.max_short_term_lufs),
    rms_db: against(ours.rms_db, theirs.rms_db),
    true_peak_dbtp: against(ours.true_peak_dbtp, theirs.true_peak_dbtp),
    bands_db: bands,
  };
  return [
    `${mix.what[0]!.toUpperCase()}${mix.what.slice(1)}, ${mix.span} (analysisId ${mix.id}, which compare_audio takes), against the Reference Track “${referenceName}”, all ${round(theirs.end.s)} s of it. Each difference is the mix less the reference; a band's matched difference is its difference with the loudness difference taken out, as if both played at the same loudness:`,
    JSON.stringify(compared),
    verdict(loudness.difference, bands),
  ].join("\n");
}

/** How much louder or quieter the mix is, and which bands differ enough to hear with the loudness matched. */
function verdict(loudness: number | null, bands: Record<string, Against & { matched: number | null }>): string {
  if (loudness === null) return "One of them is silent, so they can't be compared.";
  const level =
    Math.abs(loudness) < NOTICEABLE_DB
      ? `The mix is within ${NOTICEABLE_DB} LU of the reference's loudness`
      : `The mix is ${Math.abs(loudness)} LU ${loudness > 0 ? "louder" : "quieter"} than the reference overall`;
  const apart = Object.entries(bands)
    .filter(([, { matched }]) => matched !== null && Math.abs(matched) >= NOTICEABLE_DB)
    .map(([band, { matched }]) => `the ${band.replace("_", "-")} band ${Math.abs(matched!)} dB ${matched! > 0 ? "more" : "less"} than the reference's`);
  const balance = apart.length > 0 ? apart.join("; ") : `every band within ${NOTICEABLE_DB} dB of the reference's`;
  return `${level}. With the loudness matched: ${balance}.`;
}
