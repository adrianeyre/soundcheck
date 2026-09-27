import { readdirSync } from "node:fs";

import { expect, test } from "vitest";

import { parseSkill, SKILL_CATEGORIES, SKILLS, skillCommand, skillRequest, skillsByCategory, skillsFrom, skillSuggestions, type Skill } from "./skills";

const SKILL_MD = `---
name: fix-clipping
title: Fix clipping
category: Mixing
description: Bring the true peak under the ceiling.
argument-hint: "[a Track]"
---

Analyse the mix first.
`;

test("every folder of the repo's skills folder is a Skill, named as its folder", () => {
  const folders = readdirSync(new URL("../../../skills", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  expect(folders.length).toBeGreaterThan(0);
  expect(SKILLS.map((skill) => skill.name)).toEqual(folders);
  expect(SKILLS.filter((skill) => !skill.title || !skill.description || !skill.instructions)).toEqual([]);
});

test("a SKILL.md's front matter names it, and its body is its instructions", () => {
  expect(parseSkill("fix-clipping", SKILL_MD)).toEqual({
    name: "fix-clipping",
    title: "Fix clipping",
    category: "Mixing",
    description: "Bring the true peak under the ceiling.",
    argumentHint: "[a Track]",
    instructions: "Analyse the mix first.",
  });
});

test("a SKILL.md missing a field, or named otherwise than its folder, is refused by its folder", () => {
  expect(() => parseSkill("x", "Just instructions.")).toThrow("skills/x/SKILL.md has no front matter.");
  expect(() => parseSkill("fix-clipping", SKILL_MD.replace("title: Fix clipping\n", ""))).toThrow("has no title");
  expect(() => parseSkill("clipping", SKILL_MD)).toThrow('skills/clipping/SKILL.md is named "fix-clipping"');
  expect(() => parseSkill("fix-clipping", SKILL_MD.replace("Analyse the mix first.", ""))).toThrow("has no instructions");
  expect(() => parseSkill("fix-clipping", SKILL_MD.replace("category: Mixing\n", ""))).toThrow("has no category");
  expect(() => parseSkill("fix-clipping", SKILL_MD.replace("Mixing", "Polka"))).toThrow('has the category "Polka": it must be one of');
});

test("Skills group by category, in the categories' order, leaving out a category with none", () => {
  const genre: Skill = { ...parseSkill("fix-clipping", SKILL_MD), name: "trance", category: "Genres" };
  const mix: Skill = parseSkill("fix-clipping", SKILL_MD);
  expect(skillsByCategory([genre, mix])).toEqual([
    { category: "Mixing", skills: [mix] },
    { category: "Genres", skills: [genre] },
  ]);
  // Every category the repo's Skills use is one of them, and the genres are there.
  expect(skillsByCategory(SKILLS).map((group) => group.category)).toEqual([...SKILL_CATEGORIES]);
  expect(SKILLS.filter((skill) => skill.category === "Genres").map((skill) => skill.name)).toEqual(
    expect.arrayContaining(["dance", "electro", "gabber", "hardcore-techno", "trance"]),
  );
});

test("Skills are listed by name, whatever order their files come in", () => {
  const other = SKILL_MD.replaceAll("fix-clipping", "build-up");
  const skills = skillsFrom({ "../skills/fix-clipping/SKILL.md": SKILL_MD, "../skills/build-up/SKILL.md": other });
  expect(skills.map((skill) => skill.name)).toEqual(["build-up", "fix-clipping"]);
});

const fix: Skill = parseSkill("fix-clipping", SKILL_MD);
const build: Skill = { ...fix, name: "build-up", title: "Build-up" };
const skills = [build, fix];

test("a Request that starts with a Skill's command names it, and what follows is the rest", () => {
  expect(skillCommand("/fix-clipping on the drums", skills)).toEqual({ skill: fix, rest: "on the drums" });
  expect(skillCommand("  /FIX-CLIPPING  ", skills)).toEqual({ skill: fix, rest: "" });
  expect(skillCommand("/fix-clipping\nand the bass", skills)).toEqual({ skill: fix, rest: "and the bass" });
  expect(skillCommand("/nope please", skills)).toEqual({ unknown: "nope" });
  expect(skillCommand("fix the clipping", skills)).toBeNull();
  expect(skillCommand("/", skills)).toBeNull();
});

test("a slash suggests the Skills whose command starts as typed, until a space follows it", () => {
  expect(skillSuggestions("/", skills)).toEqual([build, fix]);
  expect(skillSuggestions("/F", skills)).toEqual([fix]);
  expect(skillSuggestions("/fix-clipping ", skills)).toEqual([]);
  expect(skillSuggestions("/zzz", skills)).toEqual([]);
  expect(skillSuggestions("fix", skills)).toEqual([]);
});

test("a Skill's Request is its instructions, then what the musician added", () => {
  const sent = skillRequest(fix, "on the drums");
  expect(sent).toContain("Skill /fix-clipping (Fix clipping)");
  expect(sent).toContain("Analyse the mix first.");
  expect(sent.endsWith("What the musician added: on the drums")).toBe(true);
  expect(skillRequest(fix, "")).toContain("added nothing after the command");
});
