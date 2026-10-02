/**
 * The **Mix Helper**: which of the Track browser's tracks would mix well
 * into what is playing on the Decks, by tempo and by key round the Camelot
 * wheel. The ranking is the app's own, pure and instant; where the musician
 * has set them up, the Assistant's Provider and the Decision Engine (Jev)
 * can be asked to pick from it too, and they only ever pick tracks it sent
 * them. Nothing here changes a Deck: loading a pick is the DJ's to do.
 */
import type { StartExchange } from "../assistant/assistant";
import type { Decide } from "../assistant/jev";
import type { ToolDefinition } from "../assistant/tools";
import type { DjAnalysis } from "../audio/audio-output";
import { camelot, camelotName, compatible, formatBpm, keyName, keySyncShift, type MusicalKey, shiftKey } from "./dj-logic";
import type { DeckReport } from "./dj-report";
import { type DeckState, type LibraryTrack, titleOf } from "./dj-state";

const mod = (value: number, by: number) => ((value % by) + by) % by;

/** One Deck as the Mix Helper reads it: what is on it and how it sounds now. */
export interface DeckNow {
  deck: number;
  trackId: string | null;
  title: string | null;
  playing: boolean;
  /** Its tempo as it plays now, after the tempo fader or Sync; 0 with no Beat Grid. */
  bpm: number;
  /** Its key as it sounds now: after Key Shift, and after the tempo fader where Master Tempo is off. */
  key: MusicalKey | null;
}

/**
 * The semitones a Deck's tempo fader moves its pitch by, with Master Tempo
 * off: a record played 6% fast is about a semitone sharp. Rounded, as a key
 * is only ever heard as one of the twelve.
 */
export function pitchOfRate(rate: number): number {
  return rate > 0 ? Math.round(12 * Math.log2(rate)) : 0;
}

/** Each Deck up to `layout`, as the Mix Helper reads it from the session. */
export function decksNow(
  layout: number,
  decks: readonly DeckState[],
  reports: readonly DeckReport[],
  library: readonly LibraryTrack[],
): DeckNow[] {
  return Array.from({ length: layout }, (_, deck) => {
    const report = reports[deck];
    const track = report?.loaded ? library.find((t) => t.id === decks[deck]?.trackId) : undefined;
    const base = track?.analysis?.key ?? null;
    const shift = (report?.keyShift ?? 0) + (report && !report.masterTempo ? pitchOfRate(report.rate) : 0);
    return {
      deck,
      trackId: track?.id ?? null,
      title: track ? titleOf(track.name) : null,
      playing: track !== undefined && (report?.playing ?? false),
      bpm: track ? (report?.effectiveBpm ?? 0) : 0,
      key: base ? shiftKey(base, shift) : null,
    };
  });
}

/**
 * The Deck the Mix Helper matches against unless the DJ picks another: the
 * Sync Master while it plays, or else the first Deck playing, or else the
 * Sync Master or the first Deck with a track on it; null with none loaded.
 */
export function defaultTarget(decks: readonly DeckNow[], syncMaster: number | null): number | null {
  const master = syncMaster !== null ? decks[syncMaster] : undefined;
  if (master?.playing) return master.deck;
  const playing = decks.find((d) => d.playing);
  if (playing) return playing.deck;
  if (master?.trackId) return master.deck;
  return decks.find((d) => d.trackId)?.deck ?? null;
}

/**
 * How a track's key sits against the Deck's on the Camelot wheel, as DJs
 * mix harmonically: the same key; a step round the wheel (a fifth up or
 * down); the relative major or minor; a diagonal step (8A to 9B or 7B);
 * an energy boost (two steps up, a whole tone, or seven, a semitone); or a
 * clash.
 */
export type KeyRelation = "same" | "fifthUp" | "fifthDown" | "relative" | "diagonal" | "boost" | "clash";

export function keyRelation(track: MusicalKey, deck: MusicalKey): KeyRelation {
  const x = camelot(track);
  const y = camelot(deck);
  const steps = mod(x.number - y.number, 12);
  if (x.letter === y.letter) {
    if (steps === 0) return "same";
    if (steps === 1) return "fifthUp";
    if (steps === 11) return "fifthDown";
    if (steps === 2 || steps === 7) return "boost";
    return "clash";
  }
  if (steps === 0) return "relative";
  // A step round and across: one note apart, as a fifth is, but a change of mood too.
  if (steps === 1 || steps === 11) return "diagonal";
  return "clash";
}

/** How well each relation mixes, 0 to 1. */
const KEY_SCORE: Record<KeyRelation, number> = {
  same: 1,
  fifthUp: 0.9,
  fifthDown: 0.9,
  relative: 0.85,
  diagonal: 0.65,
  boost: 0.6,
  clash: 0,
};

/** What each relation does to the mix, in a DJ's words. */
export const KEY_WORDS: Record<KeyRelation, string> = {
  same: "the same key: a seamless blend",
  fifthUp: "a step up the Camelot wheel (a fifth up): lifts the energy",
  fifthDown: "a step down the Camelot wheel (a fifth down): settles the energy",
  relative: "its relative major or minor: the same notes, a change of mood",
  diagonal: "a diagonal step on the Camelot wheel: a fresh colour that still works",
  boost: "an energy boost (up a tone or a semitone): best as a quick cut",
  clash: "a key clash: the keys fight in a long blend",
};

/** A Key Shift beyond this many semitones is heard as one, so the Mix Helper offers none further. */
export const MAX_HELPER_SHIFT = 2;
/** Beyond this tempo change, in percent, a track is too far off to beat-match. */
export const MAX_TEMPO_CHANGE = 10;

/** How a track's tempo meets the Deck's: at its own tempo, or at half or double it. */
export interface TempoMatch {
  /** The track's BPM as it would be mixed: its own, halved or doubled. */
  bpm: number;
  /** 1, or 2 or 0.5 for double or half time. */
  factor: number;
  /** The tempo change, in percent, that brings it to the Deck's: +2.4 is 2.4% faster. */
  change: number;
}

export function tempoMatch(trackBpm: number, deckBpm: number): TempoMatch | null {
  if (trackBpm <= 0 || deckBpm <= 0) return null;
  const [best] = [1, 2, 0.5]
    .map((factor) => ({ factor, bpm: trackBpm * factor }))
    .toSorted((a, b) => Math.abs(a.bpm - deckBpm) - Math.abs(b.bpm - deckBpm));
  return { ...best!, change: (deckBpm / best!.bpm - 1) * 100 };
}

/** How easy a tempo change is to make, 0 to 1: within 1% is nothing, 10% and over is too far. */
function tempoScore(match: TempoMatch): number {
  const off = Math.abs(match.change);
  const score = off <= 1 ? 1 : Math.max(0, 1 - (off - 1) / (MAX_TEMPO_CHANGE - 1));
  return match.factor === 1 ? score : score * 0.85;
}

/** A track's tempo change, in a DJ's words. */
export function tempoWords(match: TempoMatch | null): string {
  if (!match) return "tempo unknown";
  const off = Math.abs(match.change);
  const time = match.factor === 2 ? "in double time, " : match.factor === 0.5 ? "in half time, " : "";
  if (off <= 1) return `${time}the same tempo: beat-matches as it is`;
  if (off <= 3) return `${time}a small tempo change (${signed(match.change)}): easy to beat-match`;
  if (off <= 6) return `${time}a tempo change of ${signed(match.change)}: needs the tempo fader`;
  if (off < MAX_TEMPO_CHANGE) return `${time}a big tempo change (${signed(match.change)}): heard as faster or slower`;
  return `${time}too far off in tempo (${signed(match.change)})`;
}

function signed(percent: number): string {
  return `${percent >= 0 ? "+" : "−"}${Math.abs(percent).toFixed(1)}%`;
}

/** One track of the Track browser, as the Mix Helper ranks it against a Deck. */
export interface Match {
  trackId: string;
  title: string;
  /** Its own BPM, as analysed; 0 with no steady beat. */
  bpm: number;
  key: MusicalKey | null;
  /** How its key sits against the Deck's, or null where either key is unknown. */
  relation: KeyRelation | null;
  /** A Key Shift, in semitones, that turns a clash into a key that mixes, where a small one does; else 0. */
  keyShift: number;
  tempo: TempoMatch | null;
  /** The other Decks playing whose keys it would clash with, by number from 0. */
  clashesWith: number[];
  /** 0 to 1: how well it would mix in, all told. */
  score: number;
}

/**
 * The Track browser's analysed tracks, best first, for mixing into Deck
 * `target`: its key weighs most, then its tempo, and a track whose key
 * clashes with another Deck that is playing sinks a little. The tracks on
 * a Deck already, and those not yet analysed, are left out.
 */
export function rankMatches(target: DeckNow, decks: readonly DeckNow[], tracks: readonly LibraryTrack[]): Match[] {
  const onDecks = new Set(decks.map((d) => d.trackId).filter((id) => id !== null));
  const others = decks.filter((d) => d.deck !== target.deck && d.playing && d.key);
  return tracks
    .filter((track) => track.analysis && !onDecks.has(track.id))
    .map((track) => matchOf(track, track.analysis!, target, others))
    .toSorted((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function matchOf(track: LibraryTrack, analysis: DjAnalysis, target: DeckNow, others: readonly DeckNow[]): Match {
  const key = analysis.key;
  let relation: KeyRelation | null = null;
  let keyShift = 0;
  let keyScore = 0.3;
  if (key && target.key) {
    relation = keyRelation(key, target.key);
    keyScore = KEY_SCORE[relation];
    if (relation === "clash") {
      const shift = keySyncShift(key, target.key);
      if (shift !== 0 && Math.abs(shift) <= MAX_HELPER_SHIFT) {
        keyShift = shift;
        keyScore = 0.5;
      }
    }
  }
  const tempo = tempoMatch(analysis.bpm, target.bpm);
  const heard = key ? shiftKey(key, keyShift) : null;
  const clashesWith = heard ? others.filter((d) => !compatible(heard, d.key!)).map((d) => d.deck) : [];
  const score = (0.6 * keyScore + 0.4 * (tempo ? tempoScore(tempo) : 0.3)) * 0.85 ** clashesWith.length;
  return { trackId: track.id, title: titleOf(track.name), bpm: analysis.bpm, key, relation, keyShift, tempo, clashesWith, score };
}

/** "Am · 8A", or "key unknown". */
export function keyLabel(key: MusicalKey | null): string {
  return key ? `${keyName(key)} · ${camelotName(key)}` : "key unknown";
}

/** Why a match mixes in, or doesn't, in a few words. */
export function matchWords(m: Match): string {
  const key =
    m.relation === null
      ? "key unknown"
      : m.keyShift !== 0
        ? `a key clash, fixed by a Key Shift of ${m.keyShift > 0 ? "+" : ""}${m.keyShift}`
        : KEY_WORDS[m.relation];
  const clash = m.clashesWith.length > 0 ? `; clashes with ${m.clashesWith.map((d) => `Deck ${d + 1}`).join(" and ")}` : "";
  return `${key}; ${tempoWords(m.tempo)}${clash}`;
}

/** A Deck in words, for Jev's state and the Assistant's message. */
export function deckWords(d: DeckNow): string {
  if (!d.trackId) return `Deck ${d.deck + 1}: empty`;
  const bpm = d.bpm > 0 ? `${formatBpm(d.bpm)} BPM` : "no steady beat";
  return `Deck ${d.deck + 1}: ${d.title}, ${d.playing ? "playing" : "paused"}, ${bpm}, ${keyLabel(d.key)}`;
}

/** What the Assistant or Jev picked: each pick a track of the Track browser, with why or how sure. */
export interface HelperPicks {
  by: "assistant" | "jev";
  picks: { trackId: string; why: string; probability?: number }[];
  /** A word on the whole set, from the Assistant. */
  note?: string;
}

/** At most this many of the ranking go to Jev as options, to keep its state short (Jev does best on a short state). */
export const JEV_SHORTLIST = 24;
/** At most this many of the ranking go to the Assistant. */
export const ASSISTANT_SHORTLIST = 60;
/** The picks shown from either. */
export const MAX_PICKS = 5;

/** An option's name for Jev: its place in the ranking and title, unique and short. */
function optionName(m: Match, index: number): string {
  return `${index + 1}. ${m.title.slice(0, 60)}`;
}

/** The state and question Jev is asked: one Choice between the ranking's best. */
export function jevQuestion(target: DeckNow, decks: readonly DeckNow[], matches: readonly Match[]) {
  const shortlist = matches.slice(0, JEV_SHORTLIST);
  const state = {
    mixing_into: deckWords(target),
    other_decks: decks.filter((d) => d.deck !== target.deck && d.trackId).map(deckWords),
  };
  const options = Object.fromEntries(shortlist.map((m, index) => [optionName(m, index), `${keyLabel(m.key)}: ${matchWords(m)}`]));
  return {
    shortlist,
    state,
    questions: {
      next: {
        kind: "choice" as const,
        instructions:
          "Which track should the DJ mix in next, over `mixing_into`, so the blend sounds harmonious? Prefer keys that mix on the Camelot wheel (the same key, a step either way, or the relative major or minor) and tempos close enough to beat-match, and keys that also suit the `other_decks` that are playing.",
        options,
      },
    },
  };
}

/** Asks Jev, through `decide`, for the ranking's best to mix into `target`, each with its probability. */
export async function askJev(decide: Decide, target: DeckNow, decks: readonly DeckNow[], matches: readonly Match[]): Promise<HelperPicks> {
  const { shortlist, state, questions } = jevQuestion(target, decks, matches);
  if (shortlist.length === 0) throw new Error("There are no analysed tracks to choose from.");
  const { answers } = await decide(state, questions);
  const answer = answers.next;
  if (answer?.kind !== "choice") throw new Error("Jev didn't pick a track.");
  const picks = shortlist
    .map((m, index) => ({ m, probability: answer.probabilities[optionName(m, index)] ?? 0 }))
    .toSorted((a, b) => b.probability - a.probability)
    .slice(0, MAX_PICKS)
    .filter((p, index) => index === 0 || p.probability > 0)
    .map(({ m, probability }) => ({ trackId: m.trackId, why: matchWords(m), probability }));
  return { by: "jev", picks };
}

/** The Mix Helper's one tool: the Assistant answers by calling it, once. */
export const SUGGEST_TRACKS: ToolDefinition = {
  name: "suggest_tracks",
  description: `Give the DJ up to ${MAX_PICKS} tracks to mix in next, best first, each by its trackId from the list you were sent, with why it mixes in, in a few words as a DJ would say it.`,
  input_schema: {
    type: "object",
    properties: {
      picks: {
        type: "array",
        maxItems: MAX_PICKS,
        items: {
          type: "object",
          properties: {
            trackId: { type: "string", description: "A trackId from the tracks you were sent." },
            why: { type: "string", description: "Why it mixes in, in one short sentence: its key and tempo against the Deck's." },
          },
          required: ["trackId", "why"],
          additionalProperties: false,
        },
      },
      note: { type: "string", description: "Optionally, one short sentence of advice on the transition." },
    },
    required: ["picks"],
    additionalProperties: false,
  },
};

export const MIX_HELPER_SYSTEM = [
  "You are the Mix Helper on the Mixer page of Soundcheck, a DAW with a DJ mixer of up to four Decks. You help a DJ mix harmonically: you choose which of their tracks to mix in next.",
  "You are sent the Deck being mixed into, the other Decks and what is on them, and the tracks in the DJ's Track browser that aren't on a Deck, each with its BPM, its key in Camelot notation, how its key sits against the Deck's on the Camelot wheel and the tempo change that would beat-match it, as the app worked them out. They are sent best first by the app's own ranking, which you may disagree with.",
  "Harmonic mixing: the same key mixes seamlessly; a step either way round the Camelot wheel (8A to 7A or 9A) or the relative major or minor (8A to 8B) mixes well; a diagonal step (8A to 9B or 7B) or an energy boost (two steps up, or seven) works for a lift or a quick cut; anything else clashes in a long blend, unless a small Key Shift fixes it. Tempos within about 3% beat-match easily, up to about 6% with the tempo fader; half or double time can work too. A track should also suit the other Decks that are playing.",
  `Call suggest_tracks once, with up to ${MAX_PICKS} tracks best first, by their trackIds exactly as sent. Don't write anything else, and never name a track you weren't sent.`,
].join("\n");

/** The Assistant's message: the Decks and the ranking, as data. */
export function assistantMessage(target: DeckNow, decks: readonly DeckNow[], matches: readonly Match[], unanalysed: number): string {
  const tracks = matches.slice(0, ASSISTANT_SHORTLIST).map((m) => ({
    trackId: m.trackId,
    title: m.title,
    bpm: m.bpm > 0 ? Number(formatBpm(m.bpm)) : null,
    key: m.key ? keyName(m.key) : null,
    camelot: m.key ? camelotName(m.key) : null,
    against: matchWords(m),
  }));
  return [
    `Mixing into ${deckWords(target)}.`,
    `The other Decks: ${
      decks
        .filter((d) => d.deck !== target.deck)
        .map(deckWords)
        .join("; ") || "none"
    }.`,
    ...(unanalysed > 0 ? [`${unanalysed} more tracks in the Track browser aren't analysed yet, so they aren't listed.`] : []),
    "The tracks, best first by the app's ranking:",
    JSON.stringify(tracks),
  ].join("\n");
}

/**
 * Asks the musician's Provider, through `exchange`, for its picks: one
 * turn, answered by one call of `suggest_tracks`. A trackId it wasn't sent
 * is dropped; with none left, it failed.
 */
export async function askAssistant(
  exchange: StartExchange,
  target: DeckNow,
  decks: readonly DeckNow[],
  matches: readonly Match[],
  unanalysed: number,
): Promise<HelperPicks> {
  if (matches.length === 0) throw new Error("There are no analysed tracks to choose from.");
  const sent = new Set(matches.slice(0, ASSISTANT_SHORTLIST).map((m) => m.trackId));
  const reply = await exchange(MIX_HELPER_SYSTEM, assistantMessage(target, decks, matches, unanalysed)).next([], 1, [SUGGEST_TRACKS]);
  const call = reply.toolCalls.find((c) => c.name === SUGGEST_TRACKS.name);
  const input = (call?.input ?? {}) as { picks?: unknown; note?: unknown };
  const picks = (Array.isArray(input.picks) ? input.picks : [])
    .filter((p): p is { trackId: string; why?: unknown } => typeof p === "object" && p !== null && sent.has((p as { trackId?: string }).trackId ?? ""))
    .filter((p, index, all) => all.findIndex((q) => q.trackId === p.trackId) === index)
    .slice(0, MAX_PICKS)
    .map((p) => ({ trackId: p.trackId, why: typeof p.why === "string" ? p.why : "" }));
  if (picks.length === 0) {
    throw new Error(reply.text.trim() ? `The Assistant didn't pick a track: ${reply.text.trim()}` : "The Assistant didn't pick a track.");
  }
  return { by: "assistant", picks, ...(typeof input.note === "string" && input.note.trim() && { note: input.note.trim() }) };
}
