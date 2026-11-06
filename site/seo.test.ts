import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { robotsTxt, siteAddress, sitemapXml, withPrerendered } from "./seo.ts";

const SITE = "https://soundcheck.adrianeyre.co.uk";

test("the site's address is put on HTTPS, without a trailing slash", () => {
  expect(siteAddress("http://soundcheck.adrianeyre.co.uk/")).toBe(SITE);
  expect(siteAddress("https://adrianeyre.github.io/soundcheck")).toBe("https://adrianeyre.github.io/soundcheck");
  expect(siteAddress("http://localhost:5146/")).toBe("http://localhost:5146");
});

test("robots.txt lets every crawler in and names the sitemap", () => {
  expect(robotsTxt(SITE)).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
});

test("the sitemap lists the website and the Browser Version, with when they last changed", () => {
  const xml = sitemapXml(SITE, new Date("2026-11-06T10:00:00Z"));
  expect(xml).toContain(`<loc>${SITE}/</loc>`);
  expect(xml).toContain(`<loc>${SITE}/app/</loc>`);
  expect(xml.match(/<lastmod>2026-11-06<\/lastmod>/g)).toHaveLength(2);
});

test("the page is drawn into the root, and a missing root is an error", () => {
  expect(withPrerendered('<body><div id="root"></div></body>', "<h1>Hi</h1>")).toBe('<body><div id="root"><h1>Hi</h1></div></body>');
  expect(() => withPrerendered("<body></body>", "x")).toThrow(/no empty/);
});

const head = readFileSync(new URL("index.html", import.meta.url), "utf8");
const meta = (attr: "name" | "property", key: string) =>
  new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]+)"`).exec(head)?.[1];

test("a shared link gets a title, a description and a 1200×630 image, all absolute", () => {
  const og = ["og:title", "og:description", "og:url", "og:image", "og:image:alt", "og:site_name"];
  expect(og.filter((key) => !meta("property", key))).toEqual([]);
  const twitter = ["twitter:card", "twitter:title", "twitter:description", "twitter:image", "twitter:image:alt"];
  expect(twitter.filter((key) => !meta("name", key))).toEqual([]);
  expect(meta("property", "og:image")).toMatch(/^%VITE_SITE_URL%\//);
  expect(meta("property", "og:image:width")).toBe("1200");
  expect(meta("property", "og:image:height")).toBe("630");
});

test("the title and description fit what a search result shows", () => {
  const title = /<title>([^<]+)<\/title>/.exec(head)?.[1] ?? "";
  expect(title.length).toBeGreaterThan(20);
  expect(title.length).toBeLessThanOrEqual(60);
  const description = /<meta\s+name="description"\s+content="([^"]+)"/.exec(head)?.[1] ?? "";
  expect(description.length).toBeGreaterThanOrEqual(120);
  expect(description.length).toBeLessThanOrEqual(160);
});

test("the structured data is valid JSON", () => {
  const json = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/.exec(head)?.[1];
  expect(json).toBeTruthy();
  const data = JSON.parse(json!.replaceAll("%VITE_SITE_URL%", SITE).replaceAll("%VITE_APP_VERSION%", "1.0.0"));
  expect(data["@graph"].map((node: { "@type": string }) => node["@type"])).toEqual(
    expect.arrayContaining(["WebSite", "SoftwareApplication"]),
  );
});
