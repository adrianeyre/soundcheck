import { expect, test } from "vitest";

import { desktopOnly, type HasPlatformParts } from "./desktop-only";

const DESKTOP: HasPlatformParts = {
  name: "desktop",
  listAudioHosts: () => Promise.resolve(["WASAPI"]),
  audioInputs: { list: () => Promise.resolve([]) } as unknown as HasPlatformParts["audioInputs"],
  samples: {} as HasPlatformParts["samples"],
  storage: {} as HasPlatformParts["storage"],
  vst3: {} as HasPlatformParts["vst3"],
  headphones: {} as HasPlatformParts["headphones"],
  timecode: {} as HasPlatformParts["timecode"],
};

const CHROME: HasPlatformParts = {
  name: "browser",
  listAudioHosts: null,
  audioInputs: null,
  samples: null,
  storage: {} as HasPlatformParts["storage"],
  vst3: null,
  headphones: {} as HasPlatformParts["headphones"],
  timecode: null,
};

test("the Desktop App lacks nothing", () => {
  expect(desktopOnly(DESKTOP)).toEqual([]);
});

test("in Chrome or Edge the Browser Version lacks low latency, recording, the sample browser, VST3 Plugins, timecode vinyl and the credential store", () => {
  expect(desktopOnly(CHROME).map(({ feature }) => feature)).toEqual([
    "Low latency",
    "Recording audio",
    "The sample browser",
    "VST3 Plugins",
    "Timecode vinyl (DVS)",
    "Your system's credential store",
  ]);
});

test("where the browser can't open folders, Project folders are listed too, and Chrome and Edge are named", () => {
  const lacks = desktopOnly({ ...CHROME, storage: null });
  const folders = lacks.find(({ feature }) => feature === "Project folders");
  expect(folders?.detail).toMatch(/Chrome and Edge/);
});

test("low latency says how late the browser was measured, and what the Desktop App lets you choose", () => {
  const [latency] = desktopOnly(CHROME);
  expect(latency?.detail).toMatch(/80 ms/);
  expect(latency?.detail).toMatch(/audio host and buffer size/);
});

/** What Chrome would lack with `parts` of its own. */
const features = (parts: Partial<HasPlatformParts>) => desktopOnly({ ...CHROME, ...parts }).map(({ feature }) => feature);

test("each lacking part is listed on its own, so a browser that gains one stops listing it", () => {
  expect(features({ audioInputs: DESKTOP.audioInputs })).not.toContain("Recording audio");
  expect(features({ samples: DESKTOP.samples })).not.toContain("The sample browser");
  expect(features({ listAudioHosts: DESKTOP.listAudioHosts })).not.toContain("Low latency");
  expect(features({ vst3: DESKTOP.vst3 })).not.toContain("VST3 Plugins");
  expect(features({ headphones: null })).toContain("Headphones on a second audio device");
  expect(features({})).not.toContain("Headphones on a second audio device");
  expect(features({ timecode: DESKTOP.timecode })).not.toContain("Timecode vinyl (DVS)");
});

test("VST3 Plugins says a Project keeps them in the browser, and names the trademark's owner", () => {
  const vst3 = desktopOnly(CHROME).find(({ feature }) => feature === "VST3 Plugins");
  expect(vst3?.detail).toMatch(/keeps each one exactly/);
  expect(vst3?.detail).toMatch(/Steinberg Media Technologies GmbH/);
});
