/**
 * The Browser Version was at the site's root until the website took it
 * (ADR 0017). Its pages are `#` routes, so a bookmark, or an invite link
 * someone sent before the move, or one an older Desktop App makes, reaches
 * the website with the app's hash. This says where that hash now lives.
 */
const APP_PAGES = new Set(["#editor", "#mixing", "#pads", "#settings"]);

/** The Browser Version's address for a hash the website was opened with, relative to the website; null if the hash is the website's own. */
export function appAddressFor(hash: string): string | null {
  if (APP_PAGES.has(hash) || hash.startsWith("#live=")) return `app/${hash}`;
  return null;
}
