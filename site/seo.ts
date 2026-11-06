/**
 * What search engines and link previews read, beside `index.html`'s head:
 * `robots.txt`, `sitemap.xml`, and the page's HTML drawn ahead of time.
 */

/** The Pages site's address, absolute, on HTTPS and with no trailing slash. */
export function siteAddress(raw: string): string {
  const site = raw.trim().replace(/\/+$/, "");
  // GitHub reports `http://` for a custom domain whose HTTPS it doesn't
  // enforce itself (Cloudflare does), and a sitemap or share card that
  // names a redirect is one a crawler marks down.
  return /^http:\/\/(?!localhost|127\.0\.0\.1)/.test(site) ? site.replace(/^http:/, "https:") : site;
}

export function robotsTxt(site: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`;
}

/** The website and the Browser Version under it (ADR 0017), each last changed at `lastmod`. */
export function sitemapXml(site: string, lastmod: Date): string {
  const day = lastmod.toISOString().slice(0, 10);
  const url = (loc: string, priority: string) =>
    `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${day}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${url(`${site}/`, "1.0")}${url(`${site}/app/`, "0.8")}</urlset>
`;
}

const ROOT = '<div id="root"></div>';

/** `index.html` with the page's markup already in its root, for a crawler that doesn't run the script. */
export function withPrerendered(indexHtml: string, markup: string): string {
  if (!indexHtml.includes(ROOT)) throw new Error(`index.html has no empty ${ROOT} to draw the page into`);
  return indexHtml.replace(ROOT, `<div id="root">${markup}</div>`);
}
