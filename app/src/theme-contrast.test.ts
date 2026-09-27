import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

/** The colour tokens each theme's block in `styles.css` declares. */
function tokens(selector: string): Record<string, string> {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in styles.css`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map(([, name, hex]) => [name!, hex!]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.2's contrast ratio between two colours. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

const SURFACES = ["bg", "surface", "surface-2", "surface-3"];

/** [foreground, background, minimum]: 4.5 for text (1.4.3), 3 for controls, icons and focus (1.4.11). */
const PAIRS: [string, string, number][] = [
  ...SURFACES.map((surface): [string, string, number] => ["text", surface, 4.5]),
  ...SURFACES.map((surface): [string, string, number] => ["text-muted", surface, 4.5]),
  ...["bg", "surface", "surface-2"].map((surface): [string, string, number] => ["primary", surface, 4.5]),
  ...SURFACES.map((surface): [string, string, number] => ["control-border", surface, 3]),
  ...SURFACES.map((surface): [string, string, number] => ["focus", surface, 3]),
  ["text", "primary-soft", 4.5],
  // The icon of the Settings section being read, in its nav.
  ["primary", "primary-soft", 3],
  ["on-primary", "primary", 4.5],
  ["on-play", "play", 4.5],
  ["on-record", "record", 4.5],
  ["on-warning", "warning", 4.5],
  ["record", "surface-2", 3],
  // Yes and no in the Assistant's settings are text in these colours.
  ["play", "surface", 4.5],
  ["record", "surface", 4.5],
  ["play", "surface", 3],
  ["primary", "surface-2", 3],
  ["clip-ink", "clip-pattern", 4.5],
  ["clip-ink", "clip-audio", 4.5],
  ["meter-low", "bg", 3],
  ["meter-clip", "bg", 3],
  ["playhead", "lane", 3],
  // The stripe down the left edge of each kind of Track, wherever it is shown.
  ...["kind-instrument", "kind-drum", "kind-audio"].flatMap((kind) =>
    SURFACES.map((surface): [string, string, number] => [kind, surface, 3]),
  ),
  // The Timeline's bar lines are left out on purpose: they are a faint guide, and the ruler numbers the bars.
];

const THEMES: [string, string][] = [
  ["dark", ':root,\n:root[data-theme="dark"]'],
  ["light", ':root[data-theme="light"]'],
];

/** Every palette over every theme: the palette's accent tokens in place of the theme's. */
const PALETTED: [string, string, string | null][] = ["violet", "ocean", "aqua", "rose", "tangerine", "slate"].flatMap(
  (palette) =>
    THEMES.map(([theme, selector]): [string, string, string | null] => [
      `${theme} ${palette}`,
      selector,
      palette === "violet"
        ? null
        : theme === "dark"
          ? `:root[data-palette="${palette}"]`
          : `:root[data-theme="light"][data-palette="${palette}"]`,
    ]),
);

describe.each(PALETTED)("the %s theme", (_, selector, palette) => {
  const theme = { ...tokens(selector), ...(palette ? tokens(palette) : {}) };

  test.each(PAIRS)("--%s on --%s meets %s:1", (foreground, background, minimum) => {
    expect(theme[foreground], `--${foreground}`).toBeDefined();
    expect(theme[background], `--${background}`).toBeDefined();
    expect(contrast(theme[foreground]!, theme[background]!)).toBeGreaterThanOrEqual(minimum);
  });
});
