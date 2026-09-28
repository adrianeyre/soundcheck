import { expect, test } from "vitest";

import type { Decide, Question } from "../assistant/jev";
import { parallelKey } from "./ChordPads";
import { jevNextChord, nextChordQuestion, optionName } from "./next-chord";
import { diatonicChords, type MusicalKey } from "./theory";

const C_MAJOR: MusicalKey = { root: 0, scale: "major" };
const CHORDS = diatonicChords(C_MAJOR);
const BORROWED = diatonicChords(parallelKey(C_MAJOR)).filter((chord) => !CHORDS.some((own) => own.root === chord.root && own.quality === chord.quality));
const CANDIDATES = [...CHORDS.map((chord) => ({ chord, borrowed: false })), ...BORROWED.map((chord) => ({ chord, borrowed: true }))];

test("Jev is asked one Choice between every pad, given the key and the chords so far, in words", () => {
  const { state, questions } = nextChordQuestion(C_MAJOR, parallelKey(C_MAJOR), [CHORDS[0]!, CHORDS[5]!], CANDIDATES);
  expect(state).toEqual({ song_key: "C Major", progression_so_far: ["C (I)", "Am (vi)"] });
  const options = Object.keys(questions.next.options);
  expect(options).toHaveLength(CANDIDATES.length);
  expect(options.slice(0, 3)).toEqual(["C (I)", "Dm (ii)", "Em (iii)"]);
  expect(options.some((option) => option.endsWith(", borrowed)"))).toBe(true);
  expect(questions.next.options["G (V)"]).toBe("tension: wants to resolve home");
  expect(nextChordQuestion(C_MAJOR, parallelKey(C_MAJOR), [], CANDIDATES).state.progression_so_far).toMatch(/first chord/);
});

test("Jev's pick comes back as the pad it names, with how sure it was", async () => {
  const asked: Record<string, Question>[] = [];
  const decide: Decide = (_state, questions) => {
    asked.push(questions);
    return Promise.resolve({
      model: "jev-1.13.0",
      answers: { next: { kind: "choice", choice: "F (IV)", probabilities: { "F (IV)": 0.6 }, confidence: 0.55 } },
      usage: { input: 1, output: 1 },
    });
  };
  const picked = await jevNextChord(decide, parallelKey)(C_MAJOR, [CHORDS[0]!], CANDIDATES);
  expect(picked).toEqual({ chord: CHORDS[3], confidence: 0.55 });
  expect(asked).toHaveLength(1);
  expect(optionName(CANDIDATES[3]!)).toBe("F (IV)");
});
