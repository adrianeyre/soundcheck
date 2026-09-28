import { readdirSync, readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { assistantFamilies, capabilitiesOf, defaultModel, PROVIDERS } from "./catalogue";
import { addTextOnlyModel, TEXT_ONLY_MODEL } from "./test-catalogue";

const DIRECTORY = new URL("./", import.meta.url);

/** The Assistant's own code, tests left out, line by line with where each is. */
function sourceLines(): { where: string; line: string }[] {
  return readdirSync(DIRECTORY)
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.startsWith("test-"))
    .flatMap((file) =>
      readFileSync(new URL(file, DIRECTORY), "utf8")
        .split("\n")
        .map((line, index) => ({ where: `${file}:${index + 1}`, line })),
    );
}

const quoted = (words: string[]) => words.map((word) => `"${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).join("|");

test("no code decides what a model can do by which provider it is", () => {
  const names = quoted(PROVIDERS.map((each) => each.name));
  const ids = quoted(PROVIDERS.map((each) => each.id));
  const byName = new RegExp(`(===|!==)\\s*(${names})|(${names})\\s*(===|!==)|\\bwho\\s*(===|!==)`);
  const byId = new RegExp(`(===|!==)\\s*(${ids})|(${ids})\\s*(===|!==)|case (${ids}):`);
  const lines = sourceLines();

  expect(lines.filter(({ line }) => byName.test(line)).map(({ where }) => where)).toEqual([]);
  // A provider's id is compared only where it picks the provider's client,
  // and in the saved format, where Claude's settings alone save as they did
  // before there were other providers.
  const allowed = /^(providers\.ts|connection\.ts):/;
  expect(lines.filter(({ where, line }) => byId.test(line) && !allowed.test(where)).map(({ where }) => where)).toEqual([]);
  expect(lines.filter(({ where, line }) => byId.test(line) && where.startsWith("connection.ts")).map(({ line }) => line.trim())).toEqual([
    'if (settings.provider === "claude" && saved.every(([id]) => id === "claude") && !settings.jev) {',
  ]);
});

test("every provider's default can use tools, and so can every model the catalogue offers", () => {
  for (const { id, families } of PROVIDERS) {
    expect(capabilitiesOf(id, defaultModel(id)).toolUse).toBe(true);
    expect(assistantFamilies(id)).toEqual(families);
  }
});

test("a model that can't use tools isn't offered", () => {
  addTextOnlyModel();
  const qwen = assistantFamilies("local").find((family) => family.name === "Qwen")!;
  expect(qwen.versions.map((version) => version.id)).not.toContain(TEXT_ONLY_MODEL.id);
  expect(capabilitiesOf("local", TEXT_ONLY_MODEL.id).toolUse).toBe(false);
});

test("a model the catalogue doesn't list is taken to do what its provider's default does", () => {
  for (const { id } of PROVIDERS) expect(capabilitiesOf(id, "not-listed")).toEqual(capabilitiesOf(id, defaultModel(id)));
});
