import { expect, test, vi } from "vitest";

import type { ModelReply, StartExchange } from "../assistant/assistant";
import type { Decide } from "../assistant/jev";
import type { DjAnalysis } from "../audio/audio-output";
import type { MusicalKey } from "./dj-logic";
import type { DeckReport } from "./dj-report";
import { type LibraryTrack, newDeck } from "./dj-state";
import {
  askAssistant,
  askJev,
  type DeckNow,
  decksNow,
  defaultTarget,
  jevQuestion,
  keyRelation,
  MIX_HELPER_SYSTEM,
  pitchOfRate,
  rankMatches,
  SUGGEST_TRACKS,
  tempoMatch,
} from "./mix-helper";

const minor = (tonic: number): MusicalKey => ({ tonic, minor: true });
const major = (tonic: number): MusicalKey => ({ tonic, minor: false });
// A minor is 8A, E minor 9A, D minor 7A, C major 8B, G major 9B, F major 7B, B minor 10A, F♯ minor 11A.
const A_MINOR = minor(9);

function analysis(bpm: number, key: MusicalKey | null): DjAnalysis {
  return { seconds: 200, bpm, firstBeat: 0, key, waveformRate: 100, waveform: [] };
}

function track(id: string, bpm: number, key: MusicalKey | null): LibraryTrack {
  return { id, name: `${id}.mp3`, bytes: new Uint8Array(), analysis: analysis(bpm, key) };
}

function deck(at: number, change: Partial<DeckNow> = {}): DeckNow {
  return { deck: at, trackId: null, title: null, playing: false, bpm: 0, key: null, ...change };
}

const playing = deck(0, { trackId: "on", title: "On", playing: true, bpm: 124, key: A_MINOR });

test("keys sit against a Deck's round the Camelot wheel", () => {
  expect(keyRelation(A_MINOR, A_MINOR)).toBe("same");
  expect(keyRelation(minor(4), A_MINOR)).toBe("fifthUp");
  expect(keyRelation(minor(2), A_MINOR)).toBe("fifthDown");
  expect(keyRelation(major(0), A_MINOR)).toBe("relative");
  expect(keyRelation(major(7), A_MINOR)).toBe("diagonal");
  expect(keyRelation(minor(2), major(0))).toBe("diagonal");
  expect(keyRelation(major(5), A_MINOR)).toBe("diagonal");
  expect(keyRelation(major(9), A_MINOR)).toBe("clash");
  expect(keyRelation(minor(11), A_MINOR)).toBe("boost");
  expect(keyRelation(minor(10), A_MINOR)).toBe("boost");
  expect(keyRelation(minor(6), A_MINOR)).toBe("clash");
  expect(keyRelation(major(2), A_MINOR)).toBe("clash");
});

test("a tempo is met at its own, half or double time, with the change that beat-matches it", () => {
  expect(tempoMatch(126, 124)).toEqual({ bpm: 126, factor: 1, change: expect.closeTo(-1.587, 2) });
  expect(tempoMatch(62, 124)?.factor).toBe(2);
  expect(tempoMatch(250, 124)?.factor).toBe(0.5);
  expect(tempoMatch(0, 124)).toBeNull();
  expect(tempoMatch(124, 0)).toBeNull();
});

const report = (change: Partial<DeckReport>) =>
  ({ loaded: true, playing: true, effectiveBpm: 124, rate: 1, keyShift: 0, masterTempo: true, ...change }) as DeckReport;

test("a Deck's key is heard after its Key Shift, and after its tempo fader with Master Tempo off", () => {
  expect(pitchOfRate(1.06)).toBe(1);
  expect(pitchOfRate(1.02)).toBe(0);
  const decks = [{ ...newDeck(), trackId: "a" }, { ...newDeck(), trackId: "a" }, newDeck()];
  const library = [track("a", 124, A_MINOR)];
  const now = decksNow(3, decks, [report({ keyShift: 2 }), report({ masterTempo: false, rate: 1.06 }), report({ loaded: false })], library);
  expect(now[0]).toMatchObject({ title: "a", playing: true, bpm: 124, key: minor(11) });
  expect(now[1]!.key).toEqual(minor(10));
  expect(now[2]).toMatchObject({ trackId: null, playing: false, key: null });
});

test("the Deck matched against is the playing Sync Master, else one playing, else one loaded", () => {
  const loaded = deck(1, { trackId: "b" });
  expect(defaultTarget([deck(0), loaded, deck(2, { trackId: "c", playing: true })], 1)).toBe(2);
  expect(defaultTarget([deck(0, { trackId: "a", playing: true }), deck(1, { trackId: "b", playing: true })], 1)).toBe(1);
  expect(defaultTarget([deck(0), loaded], null)).toBe(1);
  expect(defaultTarget([deck(0), deck(1)], null)).toBeNull();
});

test("tracks rank by key first, then tempo, leaving out those on a Deck and those not yet analysed", () => {
  const library = [
    track("on", 124, A_MINOR),
    track("clash", 124, minor(6)),
    track("same-key-far-tempo", 133, A_MINOR),
    track("same", 124.5, A_MINOR),
    track("fifth", 125, minor(4)),
    track("relative", 123, major(0)),
    { ...track("unread", 124, A_MINOR), analysis: null },
  ];
  const ranked = rankMatches(playing, [playing], library).map((m) => m.trackId);
  expect(ranked).toEqual(["same", "fifth", "relative", "same-key-far-tempo", "clash"]);
});

test("a clash a small Key Shift fixes says so, and a key that fights another playing Deck sinks", () => {
  // B♭ minor (3A) is a clash with A minor; down a semitone it is A minor itself.
  const [shifted] = rankMatches(playing, [playing], [track("near", 124, minor(10))]);
  expect(shifted).toMatchObject({ relation: "boost" });
  const [fixed] = rankMatches(playing, [playing], [track("fixable", 124, minor(8))]);
  expect(fixed).toMatchObject({ relation: "clash", keyShift: 1 });
  const other = deck(1, { trackId: "x", playing: true, bpm: 124, key: minor(3) });
  const [fights] = rankMatches(playing, [playing, other], [track("same", 124, A_MINOR)]);
  expect(fights!.clashesWith).toEqual([1]);
  const [alone] = rankMatches(playing, [playing], [track("same", 124, A_MINOR)]);
  expect(fights!.score).toBeLessThan(alone!.score);
});

test("Jev is asked one Choice between the ranking's best, and its picks come back by probability", async () => {
  const matches = rankMatches(playing, [playing], [track("same", 124, A_MINOR), track("fifth", 125, minor(4)), track("clash", 124, minor(6))]);
  const { questions, state } = jevQuestion(playing, [playing], matches);
  expect(state.mixing_into).toBe("Deck 1: On, playing, 124.00 BPM, Am · 8A");
  expect(Object.keys(questions.next.options)).toEqual(["1. same", "2. fifth", "3. clash"]);
  expect(questions.next.options["2. fifth"]).toContain("a fifth up");
  const decide = vi.fn<Decide>(async () => ({
    model: "jev-1.13.0",
    usage: { input: 10, output: 0 },
    answers: { next: { kind: "choice", choice: "2. fifth", confidence: 0.8, probabilities: { "1. same": 0.3, "2. fifth": 0.7, "3. clash": 0 } } },
  }));
  const picks = await askJev(decide, playing, [playing], matches);
  expect(picks.by).toBe("jev");
  expect(picks.picks.map((p) => [p.trackId, p.probability])).toEqual([
    ["fifth", 0.7],
    ["same", 0.3],
  ]);
});

test("the Assistant answers by calling suggest_tracks, and a track it wasn't sent is dropped", async () => {
  const matches = rankMatches(playing, [playing], [track("same", 124, A_MINOR), track("fifth", 125, minor(4))]);
  const next = vi.fn<(...args: unknown[]) => Promise<ModelReply>>(async () => ({
    text: "",
    toolCalls: [
      {
        id: "1",
        name: "suggest_tracks",
        input: {
          picks: [
            { trackId: "made-up", why: "?" },
            { trackId: "fifth", why: "Up a fifth for a lift." },
            { trackId: "fifth", why: "again" },
          ],
          note: "Bring it in on the breakdown.",
        },
      },
    ],
  }));
  const exchange = vi.fn<StartExchange>(() => ({ next }));
  const picks = await askAssistant(exchange, playing, [playing], matches, 2);
  expect(picks).toEqual({ by: "assistant", picks: [{ trackId: "fifth", why: "Up a fifth for a lift." }], note: "Bring it in on the breakdown." });
  const [system, message] = exchange.mock.calls[0]!;
  expect(system).toBe(MIX_HELPER_SYSTEM);
  expect(message).toContain("Mixing into Deck 1: On, playing");
  expect(message).toContain("2 more tracks in the Track browser aren't analysed yet");
  expect(message).toContain('"trackId":"same"');
  expect(next).toHaveBeenCalledWith([], 1, [SUGGEST_TRACKS]);
});

const unsure: StartExchange = () => ({ next: async () => ({ text: "I can't tell.", toolCalls: [] }) });

test("an Assistant that picks nothing says what it said instead", async () => {
  const matches = rankMatches(playing, [playing], [track("same", 124, A_MINOR)]);
  await expect(askAssistant(unsure, playing, [playing], matches, 0)).rejects.toThrow("The Assistant didn't pick a track: I can't tell.");
  await expect(askAssistant(unsure, playing, [playing], [], 0)).rejects.toThrow("no analysed tracks");
});
