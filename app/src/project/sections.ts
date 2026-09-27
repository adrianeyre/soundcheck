/**
 * Sections: the named bar ranges of a song. They never overlap, which the
 * commands, the Assistant's tools and opening a saved Project all check
 * with `overlappingSection`.
 */
import type { Section } from "./model";
import { barStart, type TempoMap } from "./time";

/** Where a Section is, whether or not it is in the Project yet. */
export type SectionRange = Pick<Section, "startBar" | "bars">;

/** The bar after a Section's last: where the next one may start. */
export function sectionEndBar({ startBar, bars }: SectionRange): number {
  return startBar + bars;
}

/** Its bars as the musician reads them: "bar 5" or "bars 5–12". */
export function sectionBarsText(range: SectionRange): string {
  const last = sectionEndBar(range) - 1;
  return last === range.startBar ? `bar ${range.startBar}` : `bars ${range.startBar}–${last}`;
}

/** Where a Section starts and ends in ticks, on the song's tempo map. */
export function sectionTicks(range: SectionRange, map: TempoMap): { start: number; end: number } {
  return { start: barStart(map, range.startBar), end: barStart(map, sectionEndBar(range)) };
}

/**
 * The first of `sections` that `range` would overlap, or none. The Section
 * with `ignoreId` doesn't count, so one can be resized over its own bars.
 */
export function overlappingSection(
  sections: readonly Section[],
  range: SectionRange,
  ignoreId?: string,
): Section | undefined {
  return sections.find(
    (other) =>
      other.id !== ignoreId && other.startBar < sectionEndBar(range) && range.startBar < sectionEndBar(other),
  );
}
