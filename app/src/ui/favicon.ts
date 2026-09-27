/**
 * The tab's icon in the colour palette's colours: `public/favicon.svg`, with
 * the palette's logo gradient in place of Violet's.
 */
export function faviconSvg(from: string, to: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M26 44V20l20-5v24" fill="none" stroke="#0b0d17" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="21" cy="44" r="6" fill="#0b0d17"/><circle cx="41" cy="39" r="6" fill="#0b0d17"/><path d="M50 10l1.6 3.4L55 15l-3.4 1.6L50 20l-1.6-3.4L45 15l3.4-1.6z" fill="#ffffff"/></svg>`;
}

/**
 * Point the SVG tab icon at the palette's colours, read from the stylesheet
 * (`--logo-from`, `--logo-to`) so they are defined in one place.
 */
export function showPaletteFavicon(): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (!link) return;
  const style = getComputedStyle(document.documentElement);
  const from = style.getPropertyValue("--logo-from").trim();
  const to = style.getPropertyValue("--logo-to").trim();
  // No stylesheet to read (a test): the icon stays as it is.
  if (!from || !to) return;
  link.href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(from, to))}`;
}
