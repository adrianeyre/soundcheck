/**
 * What the Mixing page keeps of the DJ's session: the files loaded, each
 * Deck's cues and display settings, and the mixer's knobs as last set. None
 * of it is the Project's (ADR 0013); it lasts as long as the page is open.
 * The engine is told every knob as it moves, and all of them again when a
 * new audio output starts, so the two never disagree.
 */
import type { DjAnalysis, DjControlKind } from "../audio/audio-output";
import { DECKS } from "./dj-report";
import type { HotCue, TempoRangeId } from "./dj-logic";

/** The drag type a file from the Track browser's loaded list travels under. */
export const DJ_TRACK_DRAG_TYPE = "application/x-soundcheck-dj-track";

/** A file in the Track browser. */
export interface LibraryTrack {
  id: string;
  name: string;
  bytes: Uint8Array;
  /** Known once it has been loaded onto a Deck. */
  analysis: DjAnalysis | null;
  /** Where in the sample folders it came from, so choosing it again finds this one. */
  from?: string;
}

export interface DeckState {
  trackId: string | null;
  loading: boolean;
  error: string | null;
  hotCues: (HotCue | null)[];
  /** Memory cues, in seconds, in order. */
  memoryCues: number[];
  /** Vinyl mode: the jog scratches; otherwise it bends. */
  vinyl: boolean;
  range: TempoRangeId;
  /** Seconds a vinyl brake or spin-back takes. */
  brakeSeconds: number;
  /** Seconds either side of the playhead the close-up waveform shows. */
  zoom: number;
  loopBeats: number;
  jumpBeats: number;
}

export interface ChannelState {
  trimDb: number;
  /** Low, low-mid, high-mid and high, in dB (-26 to +6). */
  eq: [number, number, number, number];
  compression: number;
  colour: number;
  fader: number;
  curve: number;
  /** 0 A, 1 THRU, 2 B. */
  assign: number;
  cue: boolean;
}

export interface MixerState {
  crossfader: number;
  crossfaderCurve: number;
  crossfaderReverse: boolean;
  master: number;
  booth: number;
  headphoneMix: number;
  headphoneLevel: number;
  isolator: boolean;
  colourType: number;
  colourParameter: number;
  beatFxType: number;
  beatFxDivision: number;
  beatFxTarget: number;
  beatFxLevel: number;
  beatFxOn: boolean;
  /** A tapped BPM for the Beat FX, or 0 to follow the Sync Master. */
  bpm: number;
}

export const EQ_BANDS = [
  { name: "eqHigh", index: 3, caption: "HI", label: "high" },
  { name: "eqHighMid", index: 2, caption: "HI MID", label: "high-mid" },
  { name: "eqLowMid", index: 1, caption: "LO MID", label: "low-mid" },
  { name: "eqLow", index: 0, caption: "LOW", label: "low" },
] as const;

export const EQ_MIN_DB = -26;
export const EQ_MAX_DB = 6;

export function newDeck(): DeckState {
  return {
    trackId: null,
    loading: false,
    error: null,
    hotCues: Array.from({ length: 8 }, () => null),
    memoryCues: [],
    vinyl: true,
    range: "10",
    brakeSeconds: 1,
    zoom: 4,
    loopBeats: 4,
    jumpBeats: 4,
  };
}

export function newChannel(deck: number): ChannelState {
  // Decks 1 and 3 on side A of the crossfader, 2 and 4 on side B.
  return { trimDb: 0, eq: [0, 0, 0, 0], compression: 0, colour: 0, fader: 1, curve: 0, assign: deck % 2 === 0 ? 0 : 2, cue: false };
}

export const NEW_MIXER: MixerState = {
  crossfader: 0,
  crossfaderCurve: 0,
  crossfaderReverse: false,
  master: 1,
  booth: 1,
  headphoneMix: 0.5,
  headphoneLevel: 0.8,
  isolator: false,
  colourType: 5,
  colourParameter: 0.3,
  beatFxType: 0,
  beatFxDivision: 1,
  beatFxTarget: 6,
  beatFxLevel: 0.5,
  beatFxOn: false,
  bpm: 0,
};

/** One control the engine is told: as `EngineCommand`'s `djSet`. */
export interface DjSetting {
  kind: DjControlKind;
  index: number;
  name: string;
  value: number;
}

const on = (value: boolean) => (value ? 1 : 0);

/** Every mixer knob and switch as the engine should have them. */
export function mixerSettings(channels: readonly ChannelState[], mixer: MixerState): DjSetting[] {
  const settings: DjSetting[] = [];
  channels.slice(0, DECKS).forEach((channel, index) => {
    const set = (name: string, value: number) => settings.push({ kind: "channel", index, name, value });
    set("trim", channel.trimDb);
    for (const band of EQ_BANDS) set(band.name, channel.eq[band.index]);
    set("compression", channel.compression);
    set("colour", channel.colour);
    set("fader", channel.fader);
    set("curve", channel.curve);
    set("assign", channel.assign);
    set("cue", on(channel.cue));
  });
  const set = (name: string, value: number) => settings.push({ kind: "mixer", index: 0, name, value });
  set("crossfader", mixer.crossfader);
  set("crossfaderCurve", mixer.crossfaderCurve);
  set("crossfaderReverse", on(mixer.crossfaderReverse));
  set("master", mixer.master);
  set("booth", mixer.booth);
  set("headphoneMix", mixer.headphoneMix);
  set("headphoneLevel", mixer.headphoneLevel);
  set("isolator", on(mixer.isolator));
  set("colourType", mixer.colourType);
  set("colourParameter", mixer.colourParameter);
  set("beatFxType", mixer.beatFxType);
  set("beatFxDivision", mixer.beatFxDivision);
  set("beatFxTarget", mixer.beatFxTarget);
  set("beatFxLevel", mixer.beatFxLevel);
  set("beatFxOn", on(mixer.beatFxOn));
  set("bpm", mixer.bpm);
  return settings;
}

/** "track.mp3" without its extension. */
export function titleOf(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
