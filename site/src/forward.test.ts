import { expect, test } from "vitest";

import { appAddressFor } from "./forward";

test("the app's pages, at the old address, go to the Browser Version", () => {
  for (const page of ["#editor", "#mixing", "#pads", "#settings"]) expect(appAddressFor(page)).toBe(`app/${page}`);
});

test("an invite link keeps its whole session", () => {
  expect(appAddressFor("#live=abc.def-123")).toBe("app/#live=abc.def-123");
});

test("the website's own anchors and an empty hash stay on the website", () => {
  for (const hash of ["", "#", "#features", "#download", "#editorial", "#live"]) expect(appAddressFor(hash)).toBeNull();
});
