import { showPaletteFavicon } from "../ui/favicon";
import { readLocal, writeLocal } from "./local-settings";

export type ThemePreference = "system" | "dark" | "light";
export type Theme = "dark" | "light";

/** Where the chosen colour theme is kept; `index.html` reads it before first paint. */
export const THEME_KEY = "soundcheck.theme";

export const THEME_PREFERENCES: readonly { id: ThemePreference; label: string }[] = [
  { id: "system", label: "Match my system" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

export function readThemePreference(): ThemePreference {
  const saved = readLocal(THEME_KEY);
  return saved === "dark" || saved === "light" ? saved : "system";
}

function systemTheme(): Theme {
  if (typeof matchMedia === "undefined") return "dark";
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(preference: ThemePreference): Theme {
  return preference === "system" ? systemTheme() : preference;
}

let stopFollowing = () => {};

/**
 * Show `preference` now; "system" follows the OS as it changes, until
 * another preference is applied.
 */
export function applyTheme(preference: ThemePreference): void {
  stopFollowing();
  stopFollowing = () => {};
  const show = () => document.documentElement.setAttribute("data-theme", resolveTheme(preference));
  show();
  if (preference !== "system" || typeof matchMedia === "undefined") return;
  const query = matchMedia("(prefers-color-scheme: light)");
  query.addEventListener("change", show);
  stopFollowing = () => query.removeEventListener("change", show);
}

/** Show `preference` and remember it for next time. */
export function chooseTheme(preference: ThemePreference): void {
  writeLocal(THEME_KEY, preference);
  applyTheme(preference);
}

export type Palette = "violet" | "ocean" | "aqua" | "rose" | "tangerine" | "slate";

/** Where the chosen colour palette is kept; `index.html` reads it before first paint. */
export const PALETTE_KEY = "soundcheck.palette";

/**
 * Each tints the backgrounds and recolours the accent, the logo and the
 * backdrop's motif, in both themes; `styles.css` has their colours.
 */
export const PALETTES: readonly { id: Palette; label: string }[] = [
  { id: "violet", label: "Violet" },
  { id: "ocean", label: "Ocean" },
  { id: "aqua", label: "Aqua" },
  { id: "rose", label: "Rose" },
  { id: "tangerine", label: "Tangerine" },
  { id: "slate", label: "Slate" },
];

export function readPalette(): Palette {
  const saved = readLocal(PALETTE_KEY);
  return PALETTES.find(({ id }) => id === saved)?.id ?? "violet";
}

/** Show `palette`, the tab's icon too; violet is the stylesheet's own, so it needs no attribute. */
export function applyPalette(palette: Palette): void {
  if (palette === "violet") document.documentElement.removeAttribute("data-palette");
  else document.documentElement.setAttribute("data-palette", palette);
  showPaletteFavicon();
}

/** Show `palette` and remember it for next time. */
export function choosePalette(palette: Palette): void {
  writeLocal(PALETTE_KEY, palette);
  applyPalette(palette);
}
