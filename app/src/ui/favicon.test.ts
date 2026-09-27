// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, expect, test } from "vitest";

import { faviconSvg, showPaletteFavicon } from "./favicon";

afterEach(() => {
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("style");
});

const squash = (svg: string) => svg.replace(/\s+/g, "");

test("in Violet's colours the tab icon is the one the app ships", () => {
  const shipped = readFileSync(resolve(import.meta.dirname, "../../public/favicon.svg"), "utf8");
  expect(squash(faviconSvg("#8b7cff", "#3ddc97"))).toBe(squash(shipped));
});

test("the tab icon takes the palette's logo colours", () => {
  document.head.innerHTML = '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />';
  document.documentElement.style.setProperty("--logo-from", "#ff8fb8");
  document.documentElement.style.setProperty("--logo-to", "#9d8fff");
  showPaletteFavicon();
  const href = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.getAttribute("href")!;
  expect(decodeURIComponent(href.replace("data:image/svg+xml,", ""))).toBe(faviconSvg("#ff8fb8", "#9d8fff"));
});

test("without the stylesheet's colours the tab icon is left alone", () => {
  document.head.innerHTML = '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />';
  showPaletteFavicon();
  expect(document.querySelector('link[rel="icon"]')).toHaveProperty("href", "http://localhost:3000/favicon.svg");
});
