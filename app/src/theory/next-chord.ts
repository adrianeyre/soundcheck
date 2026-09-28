/**
 * The next chord of a progression, as the Decision Engine picks it: one
 * Choice between the chords the Chords Widget offers, the Song Key's own
 * and those borrowed from its parallel key, given the key and the chords so
 * far. Jev only picks; the pick is one of the pads, so it plays and is
 * written as any other.
 */
import type { Decide } from "../assistant/jev";
import { type Chord, chordName, keyName, type MusicalKey } from "./theory";

/** A chord Jev may pick, and whether it is borrowed from `borrowedFrom`. */
export interface Candidate {
  chord: Chord;
  borrowed: boolean;
}

/** What Jev picked, and how sure it was, 0 to 1. */
export interface PickedChord {
  chord: Chord;
  confidence: number;
}

/** Asks for the next chord; supplied only where Jev is set up. */
export type NextChord = (key: MusicalKey, progression: readonly Chord[], candidates: readonly Candidate[]) => Promise<PickedChord>;

const WHAT_IT_DOES: Record<Chord["function"], string> = {
  tonic: "home: restful and resolved",
  subdominant: "away from home: moving, opening up",
  dominant: "tension: wants to resolve home",
};

/** The option a candidate is offered as: its name and numeral, which tell the pads apart. */
export function optionName({ chord, borrowed }: Candidate): string {
  return `${chordName(chord)} (${chord.numeral}${borrowed ? ", borrowed" : ""})`;
}

/** The state and question for the next chord, as Jev is asked it. */
export function nextChordQuestion(key: MusicalKey, borrowedFrom: MusicalKey, progression: readonly Chord[], candidates: readonly Candidate[]) {
  const state = {
    song_key: keyName(key),
    progression_so_far: progression.length === 0 ? "none yet: this is the first chord" : progression.map((chord) => `${chordName(chord)} (${chord.numeral})`),
  };
  const options = Object.fromEntries(
    candidates.map((candidate) => [
      optionName(candidate),
      candidate.borrowed ? `borrowed from ${keyName(borrowedFrom)}: a darker or brighter colour outside the key` : WHAT_IT_DOES[candidate.chord.function],
    ]),
  );
  return {
    state,
    questions: {
      next: {
        kind: "choice" as const,
        instructions:
          progression.length === 0
            ? "Which chord should the progression in `song_key` start on, so it sounds natural and musical?"
            : "Which chord should come next after `progression_so_far`, in `song_key`, so the progression sounds natural and musical and keeps moving?",
        options,
      },
    },
  };
}

/** Asking Jev through `decide`, which the platform's fetch and the musician's key make. */
export function jevNextChord(decide: Decide, borrowedKey: (key: MusicalKey) => MusicalKey): NextChord {
  return async (key, progression, candidates) => {
    const { state, questions } = nextChordQuestion(key, borrowedKey(key), progression, candidates);
    const { answers } = await decide(state, questions);
    const answer = answers.next;
    const picked = answer?.kind === "choice" ? candidates.find((candidate) => optionName(candidate) === answer.choice) : undefined;
    if (!picked || answer?.kind !== "choice") throw new Error("Jev didn't pick a chord.");
    return { chord: picked.chord, confidence: answer.confidence };
  };
}
