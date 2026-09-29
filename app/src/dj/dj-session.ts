/**
 * The DJ's session, shared by the Mixer page and the Pads page: the files
 * in the Track browser, what is on each Deck, the mixer's knobs, the
 * Sampler's slots, the engine's report and the recording. Both pages drive
 * the same Decks and the same Sampler through it, as a pad controller and a
 * set of players drive one piece of DJ software.
 *
 * None of it is the Project's (ADR 0013), except where the DJ asks for it
 * to be: "Add to song" puts a recording into the Editor's Project, through
 * the Editor. The Sampler's slots are kept in the app's library
 * (`sampler-library.ts`); everything else lasts as long as the app is open.
 */
import { encode_mp3, encode_wav, starter_kit_wav } from "@engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AudioOutput } from "../audio/audio-output";
import { loadEngine } from "../engine";
import type { LibraryStorage } from "../preset/library-storage";
import { STARTER_KIT } from "../project/model";
import type { TreeCommand, TreeCursor } from "../samples/SampleBrowser";
import { lastName, type SampleRef, type SampleSource } from "../samples/sample-source";
import type { TakePlace, TakeTrack } from "../song/take-placement";
import { keySyncShift, type MusicalKey, shiftKey } from "./dj-logic";
import { EMPTY_REPORT, readDjReport, SAMPLER_SLOTS } from "./dj-report";
import {
  type ChannelState,
  type DeckState,
  type LibraryTrack,
  mixerSettings,
  type MixerState,
  newChannel,
  newDeck,
  NEW_MIXER,
  titleOf,
} from "./dj-state";
import type { DjRecordingSaver, RecordingKind } from "./recording-saver";
import {
  type BundledSound,
  defaultSampler,
  readSampler,
  type SamplerSetup,
  type SamplerSlot,
  type SlotMode,
  writeSampler,
} from "./sampler-library";

/** How often the page reads the engine's report: often enough for a smooth platter. */
const REPORT_MS = 40;
/** How often a recording is taken from the engine while it runs. */
const RECORDING_MS = 500;

/** A recording held since it stopped, to save or put in the song. */
export interface Take {
  /** Interleaved stereo at `sampleRate`. */
  interleaved: Float32Array;
  sampleRate: number;
  seconds: number;
  /** What it took: the whole mix, or the Sampler alone. */
  source: "master" | "sampler";
  /** When it stopped, for its name. */
  stamp: string;
  /** The Master's tempo while it was recorded, with a Deck playing (or a BPM tapped); null if there was none. */
  bpm: number | null;
}

/** A take for the Editor to put into its song, and where. */
export interface AddTakeRequest {
  wav: Uint8Array;
  name: string;
  seconds: number;
  /** The mix's tempo as it was recorded (`Take.bpm`). */
  bpm: number | null;
  place: TakePlace;
  track: TakeTrack;
}

/** What the Editor did with a take: what to say, and, where the mix's tempo wasn't the song's, a way to make it so. */
export interface AddedTake {
  message: string;
  setTempo?: { bpm: number; apply: () => string };
}

/** Which of a Track browser's lists the browse knob's cursor is in. */
export type BrowseList = "loaded" | "tree";

/** The Beat FX as a Pad FX or SLIDE FX wants it, while it has the unit. */
export interface BeatFxOverride {
  type: number;
  division: number;
  /** 0 to 3 a channel, as the mixer numbers its Beat FX targets. */
  target: number;
  level: number;
}

export interface DjSessionProps {
  output: AudioOutput | null;
  saver: DjRecordingSaver;
  /** The sample folders, for the Track browser's tree; null where there are none. */
  samples?: SampleSource | null;
  /** The app-level library: where the folders are remembered, and the Sampler's slots kept. */
  library?: LibraryStorage | null;
  /**
   * Put a recording into the Editor's Project as an Audio Clip, where the
   * request says, as one undo step. Answers what happened, for the page to say.
   */
  onAddToSong?: (request: AddTakeRequest) => Promise<AddedTake>;
  /** The Starter Kit's sounds for the Sampler's first bank; the engine's own by default. */
  bundled?: BundledSound;
}

/** The engine's bundled Starter Kit sound at `index`, with its name. */
export const engineBundled: BundledSound = (index) => {
  const pad = STARTER_KIT[index];
  if (!pad) return null;
  try {
    const bytes = starter_kit_wav(index);
    return bytes ? { name: pad.name, bytes } : null;
  } catch {
    // The engine isn't loaded (a test without it): the Sampler starts empty.
    return null;
  }
};

const on = (value: boolean) => (value ? 1 : 0);

/** What LOAD says where the browse knob, in the folder tree, isn't on a file. */
const noFolderFile = (at: TreeCursor | null) =>
  at
    ? `The browse knob is on ${at.name} in the folders: turn it to a file, or press it to go to the loaded tracks.`
    : "The Track browser's folders have nothing to choose: add a folder under Folders, or press the browse knob to go to the loaded tracks.";
/** A Sampler Slot, with the BPM found for its sample when it had none of its own. */
const withBpm = (held: SamplerSlot | null, bpm: number | undefined): SamplerSlot | null =>
  held && held.bpm === undefined && bpm !== undefined ? { ...held, bpm } : held;

export function useDjSession(props: DjSessionProps) {
  const { output, saver, samples = null, library: storage = null, onAddToSong, bundled = engineBundled } = props;
  const dj = output?.dj ?? null;
  const [layout, setLayout] = useState<2 | 4>(2);
  const [library, setLibrary] = useState<LibraryTrack[]>([]);
  const [decks, setDecks] = useState<DeckState[]>(() => Array.from({ length: 4 }, newDeck));
  const [channels, setChannels] = useState<ChannelState[]>(() => Array.from({ length: 4 }, (_, deck) => newChannel(deck)));
  const [mixer, setMixer] = useState<MixerState>(NEW_MIXER);
  const [report, setReport] = useState(EMPTY_REPORT);
  const [format, setFormat] = useState<RecordingKind>("wav");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [take, setTake] = useState<Take | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [browserShow, setBrowserShow] = useState<{ tab: "folders" | "loaded"; nonce: number } | null>(null);
  const [browseList, setBrowseList] = useState<BrowseList>("loaded");
  const [treeCursor, setTreeCursor] = useState<TreeCursor | null>(null);
  const [treeCommand, setTreeCommand] = useState<(TreeCommand & { browser: number }) | null>(null);
  const [songPlace, setSongPlace] = useState<{ place: TakePlace; track: TakeTrack }>({ place: "playhead", track: "new" });
  const [tempoOffer, setTempoOffer] = useState<AddedTake["setTempo"] | null>(null);
  const mixBpm = useRef<number | null>(null);
  const order = useRef<string[]>([]);
  const recorded = useRef<Float32Array[]>([]);
  const nextId = useRef(0);

  const send = useCallback(
    (kind: "deck" | "channel" | "mixer" | "sampler", index: number, name: string, value: number) =>
      output?.send({ type: "djSet", kind, index, name, value }),
    [output],
  );

  // A new output is a fresh engine: tell it every knob as the session has it.
  // Each change after that is sent as it is made.
  const knobs = useRef(mixerSettings(channels, mixer));
  useEffect(() => {
    knobs.current = mixerSettings(channels, mixer);
  }, [channels, mixer]);
  useEffect(() => {
    if (!output) return;
    for (const setting of knobs.current) output.send({ type: "djSet", ...setting });
  }, [output]);

  useEffect(() => {
    if (!output) return;
    const timer = setInterval(() => setReport(readDjReport(output.stats().dj)), REPORT_MS);
    return () => clearInterval(timer);
  }, [output]);

  useEffect(() => {
    if (!dj || !report.recording) return;
    const timer = setInterval(() => {
      void dj.takeRecording().then((chunk) => chunk.length > 0 && recorded.current.push(chunk));
    }, RECORDING_MS);
    return () => clearInterval(timer);
  }, [dj, report.recording]);

  // The mix's tempo while it records, for "Add to song" to hold up against the song's: the Master's BPM
  // while a Deck plays, or a BPM tapped in. The Master's 120 with nothing playing isn't a tempo.
  const tapped = mixer.bpm > 0;
  useEffect(() => {
    if (report.recording && (tapped || report.decks.some((deck) => deck.playing))) mixBpm.current = report.masterBpm;
  }, [report, tapped]);

  const changeDeck = useCallback(
    (deck: number, change: Partial<DeckState>) =>
      setDecks((all) => all.map((state, index) => (index === deck ? { ...state, ...change } : state))),
    [],
  );
  /** Tell the engine the settings that differ between `before` and `after`. */
  const sendChanges = (before: ReturnType<typeof mixerSettings>, after: ReturnType<typeof mixerSettings>) => {
    after.forEach((setting, at) => {
      if (before[at]?.value !== setting.value) send(setting.kind, setting.index, setting.name, setting.value);
    });
  };
  const changeChannel = (index: number, change: Partial<ChannelState>) => {
    const next = channels.map((state, at) => (at === index ? { ...state, ...change } : state));
    setChannels(next);
    sendChanges(mixerSettings(channels, mixer), mixerSettings(next, mixer));
  };
  const changeMixer = (change: Partial<MixerState>) => {
    const next = { ...mixer, ...change };
    setMixer(next);
    sendChanges(mixerSettings(channels, mixer), mixerSettings(channels, next));
  };

  const addFiles = async (files: File[]): Promise<LibraryTrack[]> => {
    const added = await Promise.all(
      files.map(async (file) => ({
        id: `track-${nextId.current++}`,
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        analysis: null,
      })),
    );
    setLibrary((all) => [...all, ...added]);
    return added;
  };

  const loadTrack = async (track: LibraryTrack, deck: number): Promise<boolean> => {
    if (!dj) return false;
    if (report.decks[deck]?.playing) {
      setMessage(`Pause Deck ${deck + 1} to load another track onto it.`);
      return false;
    }
    setMessage(null);
    changeDeck(deck, { loading: true, error: null });
    try {
      const analysis = await dj.load(deck, track.bytes);
      setLibrary((all) => all.map((t) => (t.id === track.id ? { ...t, analysis } : t)));
      changeDeck(deck, { ...newDeck(), vinyl: decks[deck]!.vinyl, range: decks[deck]!.range, trackId: track.id });
      return true;
    } catch (reason) {
      changeDeck(deck, { loading: false, error: `${titleOf(track.name)} couldn't be loaded: ${String(reason)}` });
      return false;
    }
  };

  /** A file from the folder tree, read once and kept in the loaded list. */
  const latest = useRef({ library, loadTrack });
  useEffect(() => {
    latest.current = { library, loadTrack };
  });
  const readSample = useCallback(
    async (sample: SampleRef): Promise<LibraryTrack | null> => {
      if (!samples) return null;
      const from = `${sample.folder.id}\u0000${sample.path}`;
      const known = latest.current.library.find((t) => t.from === from);
      if (known) return known;
      try {
        const bytes = await samples.readBytes(sample);
        const track: LibraryTrack = { id: `track-${nextId.current++}`, name: lastName(sample.path), bytes, analysis: null, from };
        setLibrary((all) => [...all, track]);
        return track;
      } catch (reason) {
        setMessage(`${sample.path} couldn't be read: ${String(reason instanceof Error ? reason.message : reason)}`);
        return null;
      }
    },
    [samples],
  );
  const putSample = useCallback(
    async (sample: SampleRef, deck: number) => {
      const track = await readSample(sample);
      if (track) await latest.current.loadTrack(track, deck);
    },
    [readSample],
  );

  const eject = (deck: number) => {
    dj?.unload(deck);
    const state = decks[deck]!;
    changeDeck(deck, { ...newDeck(), vinyl: state.vinyl, range: state.range });
  };

  // ---- The Track browser's cursor, which the Pad Controller's browse knob moves and LOAD loads.

  /** The loaded tracks in the order a Track browser last showed them. */
  const setOrder = useCallback((ids: readonly string[]) => {
    order.current = [...ids];
  }, []);
  const ordered = (): LibraryTrack[] => {
    const byId = new Map(library.map((t) => [t.id, t]));
    const shown = order.current.map((id) => byId.get(id)).filter((t): t is LibraryTrack => t !== undefined);
    return [...shown, ...library.filter((t) => !order.current.includes(t.id))];
  };
  /** Move the cursor `by` rows through the loaded tracks, answering the track it lands on. */
  const moveCursor = (by: number): LibraryTrack | null => {
    const tracks = ordered();
    if (tracks.length === 0) return null;
    const at = tracks.findIndex((t) => t.id === cursor);
    const next = at < 0 ? (by > 0 ? 0 : tracks.length - 1) : Math.max(0, Math.min(tracks.length - 1, at + by));
    setCursor(tracks[next]!.id);
    return tracks[next]!;
  };
  const cursorTrack = library.find((t) => t.id === cursor) ?? null;
  /** Bring a Track browser's tab into view: the rotary selector's press. */
  const showBrowser = (tab: "folders" | "loaded") => setBrowserShow((was) => ({ tab, nonce: (was?.nonce ?? 0) + 1 }));
  /** A loaded track chosen in a Track browser: the cursor goes to it, in the loaded list. */
  const chooseTrack = useCallback((trackId: string) => {
    setCursor(trackId);
    setBrowseList("loaded");
  }, []);

  // ---- The cursor in the folder tree, which the browse knob drives through one Track browser's tree and
  // the others follow. Where the platform has no folders there is no tree, and the knob stays on the loaded list.

  const hasTree = samples !== null && storage !== null;
  const treeCursorNow = useRef<TreeCursor | null>(null);
  const treeNonce = useRef(0);
  const treeBrowsers = useRef(new Set<number>());
  const treeAfter = useRef<{ nonce: number; after: (cursor: TreeCursor | null) => void } | null>(null);
  /** A Track browser with a folder tree, there to be driven; answers how to take it away. */
  const registerTree = useCallback((browser: number) => {
    treeBrowsers.current.add(browser);
    return () => void treeBrowsers.current.delete(browser);
  }, []);
  /** Told by a tree where its cursor is now: moved by the knob (with its command's `nonce`), or by the musician. */
  const onTreeCursor = useCallback((next: TreeCursor | null, nonce: number | null) => {
    treeCursorNow.current = next;
    setTreeCursor(next);
    if (nonce === null) {
      if (next) setBrowseList("tree");
      return;
    }
    const waiting = treeAfter.current;
    if (waiting?.nonce === nonce) {
      treeAfter.current = null;
      waiting.after(next);
    }
  }, []);
  /**
   * Ask the tree of Track browser `browser` (or, where it isn't on a page, any
   * other) to move its cursor, and then do `after` where it lands.
   */
  const driveTree = (action: TreeCommand["action"], browser: number, by = 0, after?: (cursor: TreeCursor | null) => void) => {
    const browsers = treeBrowsers.current;
    const target = browsers.has(browser) ? browser : [...browsers][0];
    if (target === undefined) {
      after?.(null);
      return;
    }
    const nonce = ++treeNonce.current;
    treeAfter.current = after ? { nonce, after } : null;
    setTreeCommand({ nonce, action, by, from: treeCursorNow.current?.key ?? null, browser: target });
  };

  /**
   * The browse knob turned `by` rows, in the list its cursor is in, for the
   * Pad Controller beside Track browser `browser`. Answers what to say, if anything.
   */
  const turnKnob = (by: number, browser: number): string | null => {
    if (browseList === "tree" && hasTree) {
      driveTree("move", browser, by, (at) => {
        if (!at) setMessage(noFolderFile(null));
      });
      return null;
    }
    return moveCursor(by) ? null : "The Track browser has no loaded tracks yet: add files to it, or drop them on a Deck.";
  };
  /**
   * The browse knob pressed: on a closed folder it opens it (SHIFT: in an
   * open one, or on a file in one, it closes it); otherwise the cursor moves
   * between the loaded list and the folder tree.
   */
  const pressKnob = (withShift: boolean, browser: number) => {
    if (!hasTree) {
      setBrowseList("loaded");
      showBrowser("loaded");
      return;
    }
    if (browseList === "loaded") {
      setBrowseList("tree");
      showBrowser("folders");
      return;
    }
    const at = treeCursorNow.current;
    const branch = at !== null && (at.kind === "root" || at.kind === "folder");
    if (!withShift && branch && at.expanded === false) driveTree("open", browser);
    else if (withShift && at !== null && ((branch && at.expanded === true) || at.level > 1)) driveTree("close", browser);
    else {
      setBrowseList("loaded");
      showBrowser("loaded");
    }
  };
  /**
   * LOAD: what the browse knob is on onto Deck `deck`, a loaded track or a
   * file in the folder tree; with `next`, the one below it. Answers what to
   * say, if anything.
   */
  const loadChosen = (deck: number, next: boolean, browser: number): string | null => {
    if (browseList === "tree" && hasTree) {
      const load = (at: TreeCursor | null) => {
        if (at?.sample) void putSample(at.sample, deck);
        else setMessage(noFolderFile(at));
      };
      if (next) driveTree("move", browser, 1, load);
      else load(treeCursorNow.current);
      return null;
    }
    const track = next ? moveCursor(1) : cursorTrack;
    if (!track) return "Choose a track first: turn the browse knob, or click one under Loaded tracks in the Track browser.";
    void loadTrack(track, deck);
    return null;
  };
  /** What the browse knob is on, as its display says it. */
  const knobOn =
    browseList === "tree" && hasTree
      ? treeCursor
        ? `Folders: ${treeCursor.name}`
        : "Folders: nothing chosen"
      : cursorTrack
        ? titleOf(cursorTrack.name)
        : "No track chosen";

  /**
   * Instant doubles: the track on Deck `from` loaded onto Deck `to` too, at
   * the same place, playing if it was.
   */
  const instantDouble = async (from: number, to: number) => {
    const source = library.find((t) => t.id === decks[from]?.trackId);
    const was = report.decks[from];
    if (!source || !was?.loaded) {
      setMessage(`Deck ${from + 1} has nothing to double.`);
      return;
    }
    const started = performance.now();
    if (!(await loadTrack(source, to))) return;
    const late = was.playing ? ((performance.now() - started) / 1000) * was.rate : 0;
    send("deck", to, "seek", was.position + late);
    send("deck", to, "tempo", was.tempo);
    if (was.playing) send("deck", to, "play", 1);
    changeDeck(to, { hotCues: decks[from]!.hotCues, memoryCues: decks[from]!.memoryCues });
  };

  // ---- Key Sync kept on: each Deck with it follows the Sync Master's key.

  const keyOf = (deck: number): MusicalKey | null => {
    const analysis = library.find((t) => t.id === decks[deck]?.trackId)?.analysis;
    return analysis?.key ? shiftKey(analysis.key, report.decks[deck]?.keyShift ?? 0) : null;
  };
  const baseKeyOf = (deck: number): MusicalKey | null => library.find((t) => t.id === decks[deck]?.trackId)?.analysis?.key ?? null;
  const masterKey = report.syncMaster !== null ? keyOf(report.syncMaster) : null;
  const keySyncSent = useRef<(number | null)[]>([null, null, null, null]);
  const syncs = decks
    .map((state, deck) => {
      const base = baseKeyOf(deck);
      if (!state.keySync || !base || !masterKey || report.syncMaster === deck || !report.decks[deck]?.loaded) return null;
      return keySyncShift(base, masterKey);
    })
    .join(",");
  useEffect(() => {
    syncs.split(",").forEach((shift, deck) => {
      if (shift === "") {
        keySyncSent.current[deck] = null;
        return;
      }
      const value = Number(shift);
      if (keySyncSent.current[deck] === value) return;
      keySyncSent.current[deck] = value;
      send("deck", deck, "keyShift", value);
    });
  }, [syncs, send]);

  // ---- The one Beat FX unit, lent to a Pad FX or SLIDE FX while it is held.

  const overrides = useRef(new Map<string, BeatFxOverride>());
  const mixerRef = useRef(mixer);
  useEffect(() => {
    mixerRef.current = mixer;
  }, [mixer]);
  /**
   * `owner` takes the Beat FX with `fx`, or gives it back with null. The
   * last one to take it has it; when none has it, it is as the mixer set it.
   */
  const lendBeatFx = useCallback(
    (owner: string, fx: BeatFxOverride | null) => {
      overrides.current.delete(owner);
      if (fx) overrides.current.set(owner, fx);
      const holder = [...overrides.current.values()].at(-1);
      if (holder) {
        send("mixer", 0, "beatFxType", holder.type);
        send("mixer", 0, "beatFxDivision", holder.division);
        send("mixer", 0, "beatFxTarget", holder.target);
        send("mixer", 0, "beatFxLevel", holder.level);
        send("mixer", 0, "beatFxOn", 1);
        return;
      }
      const own = mixerRef.current;
      send("mixer", 0, "beatFxType", own.beatFxType);
      send("mixer", 0, "beatFxDivision", own.beatFxDivision);
      send("mixer", 0, "beatFxTarget", own.beatFxTarget);
      send("mixer", 0, "beatFxLevel", own.beatFxLevel);
      send("mixer", 0, "beatFxOn", on(own.beatFxOn));
    },
    [send],
  );

  // ---- The Sampler: 64 slots, kept in the library.

  const [sampler, setSampler] = useState<SamplerSetup>(() => ({
    slots: Array.from({ length: SAMPLER_SLOTS }, () => null),
    gain: 1,
  }));
  const [samplerReady, setSamplerReady] = useState(false);
  const samplerRef = useRef(sampler);
  useEffect(() => {
    samplerRef.current = sampler;
  }, [sampler]);
  // The library is read once, as the session opens.
  const opening = useRef({ storage, bundled });
  useEffect(() => {
    let live = true;
    const { storage: from, bundled: sounds } = opening.current;
    void (async () => {
      // The Starter Kit's sounds are the engine's: it may still be loading, as the app starts on this page.
      if (sounds === engineBundled) await loadEngine().catch(() => {});
      const saved = from ? await readSampler(from, sounds).catch(() => null) : null;
      if (!live) return;
      setSampler(saved ?? defaultSampler(sounds));
      setSamplerReady(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  /**
   * Tell the engine one slot's sample and how it plays: mode, level, pitch,
   * sync and BPM. Answers the slot's BPM: its own, or else the one the engine
   * found for the sample (0 for none).
   */
  const sendSlot = useCallback(
    async (slot: number, held: SamplerSlot | null): Promise<number | undefined> => {
      if (!dj) return undefined;
      if (!held) {
        dj.unloadSample(slot);
        return undefined;
      }
      const found = await dj.loadSample(slot, held.bytes);
      const bpm = held.bpm ?? found.bpm;
      send("sampler", slot, "mode", held.mode);
      send("sampler", slot, "gain", held.gain);
      send("sampler", slot, "pitch", held.pitch);
      send("sampler", slot, "sync", on(held.sync));
      send("sampler", slot, "bpm", bpm);
      return bpm;
    },
    [dj, send],
  );
  // A new output, or the Sampler read from the library: the engine is given every slot.
  useEffect(() => {
    if (!dj || !samplerReady) return;
    const { slots, gain } = samplerRef.current;
    send("mixer", 0, "samplerGain", gain);
    for (const [slot, held] of slots.entries()) {
      if (!held) continue;
      void sendSlot(slot, held)
        .then((bpm) => {
          // A slot saved before slots had a BPM (or a Starter Kit sound) shows the one found.
          const now = samplerRef.current;
          if (now.slots[slot] !== held || held.bpm !== undefined || bpm === undefined) return;
          const next = { ...now, slots: now.slots.map((s, at) => (at === slot ? withBpm(s, bpm) : s)) };
          samplerRef.current = next;
          setSampler(next);
        })
        .catch(() => {});
    }
  }, [dj, samplerReady, send, sendSlot]);

  const persist = (next: SamplerSetup, changed: number[]) => {
    if (storage) {
      void writeSampler(storage, next, changed).catch((reason: unknown) =>
        setMessage(`The Sampler couldn't be saved: ${String(reason instanceof Error ? reason.message : reason)}`),
      );
    }
  };
  /** Put `held` in `slot` (or empty it), in the engine and the library. */
  const setSlot = async (slot: number, loaded: SamplerSlot | null): Promise<boolean> => {
    let held = loaded;
    try {
      held = withBpm(loaded, await sendSlot(slot, loaded));
    } catch (reason) {
      setMessage(`${held?.name ?? "The sample"} couldn't be loaded into slot ${slot + 1}: ${String(reason instanceof Error ? reason.message : reason)}`);
      return false;
    }
    const next = { ...samplerRef.current, slots: samplerRef.current.slots.map((s, at) => (at === slot ? held : s)) };
    samplerRef.current = next;
    setSampler(next);
    persist(next, [slot]);
    return true;
  };
  const loadSlotBytes = (slot: number, name: string, bytes: Uint8Array) => {
    const was = samplerRef.current.slots[slot];
    // How the slot plays stays; the new sample's BPM is found as it loads.
    return setSlot(slot, {
      name: titleOf(name),
      bytes,
      mode: was?.mode ?? 0,
      gain: was?.gain ?? 1,
      pitch: was?.pitch ?? 0,
      sync: was?.sync ?? false,
    });
  };
  const loadSlotFile = async (slot: number, file: File) => loadSlotBytes(slot, file.name, new Uint8Array(await file.arrayBuffer()));
  const loadSlotTrack = (slot: number, trackId: string) => {
    const track = library.find((t) => t.id === trackId);
    return track ? loadSlotBytes(slot, track.name, track.bytes) : Promise.resolve(false);
  };
  const loadSlotSample = async (slot: number, sample: SampleRef) => {
    const track = await readSample(sample);
    return track ? loadSlotBytes(slot, track.name, track.bytes) : false;
  };
  /** SHIFT and a Sampler pad, or the slot's own button: the track (or folder file) under the Track browser's cursor goes in. */
  const loadSlotFromCursor = (slot: number) => {
    if (browseList === "tree" && hasTree) {
      const at = treeCursorNow.current;
      if (at?.sample) return loadSlotSample(slot, at.sample);
      setMessage(noFolderFile(at));
      return Promise.resolve(false);
    }
    if (!cursorTrack) {
      setMessage("Choose a track in the Track browser first (turn the browse knob, or click one under Loaded tracks).");
      return Promise.resolve(false);
    }
    return loadSlotBytes(slot, cursorTrack.name, cursorTrack.bytes);
  };
  const clearSlot = (slot: number) => setSlot(slot, null);
  /** Change a slot's name, mode, level, pitch, sync or BPM: its sample stays. */
  const changeSlot = (slot: number, change: Partial<Pick<SamplerSlot, "name" | "mode" | "gain" | "pitch" | "sync" | "bpm">>) => {
    const held = samplerRef.current.slots[slot];
    if (!held) return;
    const next = { ...held, ...change };
    if (change.mode !== undefined) send("sampler", slot, "mode", change.mode);
    if (change.gain !== undefined) send("sampler", slot, "gain", change.gain);
    if (change.pitch !== undefined) send("sampler", slot, "pitch", change.pitch);
    if (change.sync !== undefined) send("sampler", slot, "sync", on(change.sync));
    if (change.bpm !== undefined) send("sampler", slot, "bpm", change.bpm);
    const setup = { ...samplerRef.current, slots: samplerRef.current.slots.map((s, at) => (at === slot ? next : s)) };
    samplerRef.current = setup;
    setSampler(setup);
    persist(setup, []);
  };
  const setSamplerGain = (gain: number) => {
    send("mixer", 0, "samplerGain", gain);
    const setup = { ...samplerRef.current, gain };
    samplerRef.current = setup;
    setSampler(setup);
    persist(setup, []);
  };
  const setSlotMode = (slot: number, mode: SlotMode) => changeSlot(slot, { mode });

  // ---- Recording, and the take it leaves.

  /**
   * Start or stop recording. Stopped with `save`, the take is encoded and
   * saved where the DJ chooses, as the mixer's REC does; either way it is
   * kept, to save or add to the song.
   */
  const record = async (start: boolean, { save = true, source }: { save?: boolean; source?: "master" | "sampler" } = {}) => {
    if (start) {
      recorded.current = [];
      mixBpm.current = null;
      if (source) send("mixer", 0, "recordSource", source === "sampler" ? 1 : 0);
      send("mixer", 0, "record", 1);
      return;
    }
    send("mixer", 0, "record", 0);
    if (!dj || !output) return;
    const last = await dj.takeRecording();
    const chunks = [...recorded.current, last];
    recorded.current = [];
    const interleaved = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      interleaved.set(chunk, at);
      at += chunk.length;
    }
    if (interleaved.length === 0) {
      setMessage("Nothing was recorded.");
      return;
    }
    const sampleRate = output.stats().sampleRate;
    const kept: Take = {
      interleaved,
      sampleRate,
      seconds: interleaved.length / 2 / sampleRate,
      source: report.sampler.recordSource,
      stamp: new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"),
      bpm: mixBpm.current,
    };
    setTake(kept);
    setTempoOffer(null);
    if (save) await saveTake(kept);
    else setMessage(`Recorded ${kept.seconds.toFixed(1)} seconds. Add it to the song, or save it as a file.`);
  };
  const takeName = (kept: Take) => `${kept.source === "sampler" ? "Sampler" : "Mix"} ${kept.stamp}`;
  const saveTake = async (kept: Take | null = take) => {
    if (!kept) return;
    setSaving(true);
    try {
      const bytes =
        format === "wav" ? encode_wav(kept.interleaved, kept.sampleRate, 24) : encode_mp3(kept.interleaved, kept.sampleRate, 320);
      if (!bytes) throw new Error("the recording couldn't be encoded");
      const where = await saver.save(takeName(kept), format, bytes);
      setMessage(where ? `Recording saved: ${where}` : "The recording wasn't saved.");
    } catch (reason) {
      setMessage(`The recording couldn't be saved: ${String(reason)}`);
    } finally {
      setSaving(false);
    }
  };
  /** Put the last take into the Editor's song, where `songPlace` says. */
  const addTakeToSong = async () => {
    if (!take || !onAddToSong) return;
    setSaving(true);
    setTempoOffer(null);
    try {
      const wav = encode_wav(take.interleaved, take.sampleRate, 24);
      if (!wav) throw new Error("the recording couldn't be encoded");
      const added = await onAddToSong({
        wav,
        name: take.source === "sampler" ? "Sampler take" : "Mix take",
        seconds: take.seconds,
        bpm: take.bpm,
        ...songPlace,
      });
      setMessage(added.message);
      setTempoOffer(added.setTempo ?? null);
    } catch (reason) {
      setMessage(`The recording couldn't be added to the song: ${String(reason instanceof Error ? reason.message : reason)}`);
    } finally {
      setSaving(false);
    }
  };

  /** The offer made as the take went in: the song's tempo set to the mix's, as a change of its own. */
  const setSongTempo = () => {
    if (!tempoOffer) return;
    setTempoOffer(null);
    try {
      setMessage(tempoOffer.apply());
    } catch (reason) {
      setMessage(`The song's tempo couldn't be set: ${String(reason instanceof Error ? reason.message : reason)}`);
    }
  };

  const titleOfDeck = (deck: number) => {
    const track = library.find((t) => t.id === decks[deck]?.trackId);
    return track ? titleOf(track.name) : null;
  };

  const targets = useMemo(() => Array.from({ length: layout }, (_, deck) => deck), [layout]);

  return {
    output,
    dj,
    layout,
    setLayout,
    library,
    decks,
    channels,
    mixer,
    report,
    send,
    changeDeck,
    changeChannel,
    changeMixer,
    addFiles,
    loadTrack,
    putSample,
    readSample,
    eject,
    message,
    setMessage,
    format,
    setFormat,
    saving,
    record,
    take,
    saveTake,
    addTakeToSong,
    canAddToSong: onAddToSong !== undefined,
    keyOf,
    baseKeyOf,
    masterKey,
    titleOfDeck,
    cursor,
    setCursor: chooseTrack,
    cursorTrack,
    browseList,
    hasTree,
    treeCursor,
    treeCommand,
    onTreeCursor,
    registerTree,
    turnKnob,
    pressKnob,
    loadChosen,
    knobOn,
    songPlace,
    setSongPlace,
    tempoOffer,
    setSongTempo,
    moveCursor,
    setOrder,
    browserShow,
    showBrowser,
    instantDouble,
    lendBeatFx,
    sampler,
    loadSlotFile,
    loadSlotTrack,
    loadSlotSample,
    loadSlotFromCursor,
    clearSlot,
    changeSlot,
    setSlotMode,
    setSamplerGain,
    targets,
    samples,
    storage,
  };
}

export type DjSession = ReturnType<typeof useDjSession>;
