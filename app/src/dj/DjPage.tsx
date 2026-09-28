import { encode_mp3, encode_wav } from "@engine";
import { Power } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AudioOutput } from "../audio/audio-output";
import type { LibraryStorage } from "../preset/library-storage";
import type { SampleTarget } from "../samples/SampleBrowser";
import { lastName, type SampleRef, type SampleSource } from "../samples/sample-source";
import { DjBrowser } from "./DjBrowser";
import { DeckPanel } from "./DeckPanel";
import { type MusicalKey, shiftKey } from "./dj-logic";
import { EMPTY_REPORT, readDjReport } from "./dj-report";
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
import { MixerPanel } from "./MixerPanel";
import type { DjRecordingSaver, RecordingKind } from "./recording-saver";
import { WaveformStack } from "./WaveformStack";

/** The BROWSE button: the Track browser brought into view and focused. */
function browse() {
  const browser = document.getElementById("dj-browser");
  browser?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  browser?.focus({ preventScroll: true });
}

/** How often the page reads the engine's report: often enough for a smooth platter. */
const REPORT_MS = 40;
/** How often a recording is taken from the engine while it runs. */
const RECORDING_MS = 500;

/** The keys that play, cue and sync each Deck, CDJ-style: cue, play, sync. */
export const DECK_KEYS: readonly { cue: string; play: string; sync: string }[] = [
  { cue: "KeyQ", play: "KeyW", sync: "KeyE" },
  { cue: "KeyI", play: "KeyO", sync: "KeyP" },
  { cue: "KeyA", play: "KeyS", sync: "KeyD" },
  { cue: "KeyJ", play: "KeyK", sync: "KeyL" },
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "range"].includes(target.type);
}

export interface DjPageProps {
  output: AudioOutput | null;
  /** Start the audio output, as the Editor's Start audio does. */
  onStart?: () => void;
  starting?: boolean;
  /** Whether the page is the one showing, so its keyboard shortcuts apply. */
  active: boolean;
  saver: DjRecordingSaver;
  /** The sample folders the Editor's Samples Widget reads, for the Track browser's tree; null where there are none. */
  samples?: SampleSource | null;
  /** The app-level library, where those folders are remembered. */
  library?: LibraryStorage | null;
}

/**
 * The Mixing page (ADR 0013): two or four CDJ-style **Decks** around a
 * DJM-style mixer, and the **Track browser**. It only tells the engine what
 * the DJ does and draws what the engine reports; nothing here is the
 * Project's, and none of it is undone.
 */
export function DjPage({ output, onStart, starting = false, active, saver, samples = null, library: folderLibrary = null }: DjPageProps) {
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
  const [span, setSpan] = useState(4);
  const recorded = useRef<Float32Array[]>([]);
  const nextId = useRef(0);

  const send = useCallback(
    (kind: "deck" | "channel" | "mixer", index: number, name: string, value: number) =>
      output?.send({ type: "djSet", kind, index, name, value }),
    [output],
  );

  // A new output is a fresh engine: tell it every knob as the page has it.
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

  const changeDeck = (deck: number, change: Partial<DeckState>) =>
    setDecks((all) => all.map((state, index) => (index === deck ? { ...state, ...change } : state)));
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

  const loadTrack = async (track: LibraryTrack, deck: number) => {
    if (!dj) return;
    if (report.decks[deck]?.playing) {
      setMessage(`Pause Deck ${deck + 1} to load another track onto it.`);
      return;
    }
    setMessage(null);
    changeDeck(deck, { loading: true, error: null });
    try {
      const analysis = await dj.load(deck, track.bytes);
      setLibrary((all) => all.map((t) => (t.id === track.id ? { ...t, analysis } : t)));
      changeDeck(deck, { ...newDeck(), vinyl: decks[deck]!.vinyl, range: decks[deck]!.range, trackId: track.id });
    } catch (reason) {
      changeDeck(deck, { loading: false, error: `${titleOf(track.name)} couldn't be loaded: ${String(reason)}` });
    }
  };

  // A file from the folder tree: read once, kept in the loaded list, and loaded onto the Deck.
  const latestLoad = useRef({ loadTrack, library });
  useEffect(() => {
    latestLoad.current = { loadTrack, library };
  });
  const useSample = useCallback(
    async (sample: SampleRef, deck: number) => {
      if (!samples) return;
      const from = `${sample.folder.id}\u0000${sample.path}`;
      let track = latestLoad.current.library.find((t) => t.from === from);
      if (!track) {
        try {
          const bytes = await samples.readBytes(sample);
          track = { id: `track-${nextId.current++}`, name: lastName(sample.path), bytes, analysis: null, from };
        } catch (reason) {
          setMessage(`${sample.path} couldn't be read: ${String(reason instanceof Error ? reason.message : reason)}`);
          return;
        }
        const added = track;
        setLibrary((all) => [...all, added]);
      }
      await latestLoad.current.loadTrack(track, deck);
    },
    [samples],
  );
  const deckCount = layout;
  const targets = useMemo<SampleTarget[]>(
    () => (dj ? Array.from({ length: deckCount }, (_, deck) => ({ id: `deck:${deck}`, label: `Deck ${deck + 1}` })) : []),
    [dj, deckCount],
  );
  const onUse = useCallback((sample: SampleRef, target: string) => void useSample(sample, Number(target.split(":")[1])), [useSample]);
  const onBrowseError = useCallback((error: string) => setMessage(error), []);

  const record = async (on: boolean) => {
    if (on) {
      recorded.current = [];
      send("mixer", 0, "record", 1);
      return;
    }
    send("mixer", 0, "record", 0);
    if (!dj || !output) return;
    setSaving(true);
    try {
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
      const rate = output.stats().sampleRate;
      const bytes = format === "wav" ? encode_wav(interleaved, rate, 24) : encode_mp3(interleaved, rate, 320);
      if (!bytes) throw new Error("the recording couldn't be encoded");
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const where = await saver.save(`Mix ${stamp}`, format, bytes);
      setMessage(where ? `Recording saved: ${where}` : "The recording wasn't saved.");
    } catch (reason) {
      setMessage(`The recording couldn't be saved: ${String(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  // The Sync Master's key as it plays, for the other Decks' key displays.
  const keyOf = (deck: number): MusicalKey | null => {
    const analysis = library.find((t) => t.id === decks[deck]?.trackId)?.analysis;
    return analysis?.key ? shiftKey(analysis.key, report.decks[deck]?.keyShift ?? 0) : null;
  };
  const masterKey = report.syncMaster !== null ? keyOf(report.syncMaster) : null;

  // The keyboard plays the Decks while the page shows. It is listened to
  // before anything else, so the Editor's computer keyboard plays no notes
  // under it.
  const latest = useRef({ report, send, canPlay: false });
  useEffect(() => {
    latest.current = { report, send, canPlay: output !== null };
  });
  useEffect(() => {
    if (!active) return;
    const down = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const deck = DECK_KEYS.findIndex((keys) => Object.values(keys).includes(event.code));
      const letters = /^Key[A-Z]$|^Semicolon$/.test(event.code);
      if (letters) event.stopImmediatePropagation();
      if (deck < 0 || event.repeat || !latest.current.canPlay) return;
      const keys = DECK_KEYS[deck]!;
      const state = latest.current.report.decks[deck]!;
      if (!state.loaded) return;
      event.preventDefault();
      if (event.code === keys.cue) latest.current.send("deck", deck, "cueDown", 1);
      if (event.code === keys.play) latest.current.send("deck", deck, "play", state.playing ? 0 : 1);
      if (event.code === keys.sync) latest.current.send("deck", deck, "sync", state.sync ? 0 : 1);
    };
    const up = (event: KeyboardEvent) => {
      if (/^Key[A-Z]$|^Semicolon$/.test(event.code) && !isTyping(event.target)) event.stopImmediatePropagation();
      const deck = DECK_KEYS.findIndex((keys) => keys.cue === event.code);
      if (deck >= 0 && latest.current.canPlay) latest.current.send("deck", deck, "cueUp", 1);
    };
    window.addEventListener("keydown", down, { capture: true });
    window.addEventListener("keyup", up, { capture: true });
    return () => {
      window.removeEventListener("keydown", down, { capture: true });
      window.removeEventListener("keyup", up, { capture: true });
    };
  }, [active]);

  const deckPanel = (deck: number) => {
    const state = decks[deck]!;
    const track = library.find((t) => t.id === state.trackId) ?? null;
    return (
      <DeckPanel
        key={deck}
        deck={deck}
        state={state}
        report={report.decks[deck]!}
        title={track ? titleOf(track.name) : null}
        analysis={report.decks[deck]!.loaded ? (track?.analysis ?? null) : null}
        syncMaster={report.syncMaster === deck}
        masterKey={report.syncMaster !== deck ? masterKey : null}
        canPlay={dj !== null}
        set={(name, value) => send("deck", deck, name, value)}
        onState={(change) => changeDeck(deck, change)}
        onLoadFile={(file) => void addFiles([file]).then(([added]) => added && loadTrack(added, deck))}
        onDropTrack={(trackId) => {
          const dropped = library.find((t) => t.id === trackId);
          if (dropped) void loadTrack(dropped, deck);
        }}
        onDropSample={(sample) => void useSample(sample, deck)}
        onBrowse={browse}
        onEject={() => {
          dj?.unload(deck);
          changeDeck(deck, { ...newDeck(), vinyl: state.vinyl, range: state.range });
        }}
      />
    );
  };

  return (
    <div className="dj-page">
      <div className="dj-toolbar row">
        {!output && onStart && (
          <button type="button" className="btn-primary" disabled={starting} aria-busy={starting} onClick={onStart}>
            <Power size={16} aria-hidden />
            {starting ? "Starting…" : "Start audio for mixing"}
          </button>
        )}
        <div className="dj-layout" role="radiogroup" aria-label="Deck layout">
          {([2, 4] as const).map((count) => (
            <button
              key={count}
              type="button"
              role="radio"
              aria-checked={layout === count}
              className="dj-assign-button"
              onClick={() => setLayout(count)}
            >
              {count} Decks
            </button>
          ))}
        </div>
        <p className="hint">
          Keys: Q W E cue, play and sync Deck 1; I O P Deck 2; A S D Deck 3; J K L Deck 4. The Editor&apos;s song stops while
          this page is open.
        </p>
      </div>
      {message && (
        <p className="hint" role="status">
          {message}
        </p>
      )}
      <WaveformStack
        span={span}
        onSpan={setSpan}
        lanes={Array.from({ length: layout }, (_, deck) => {
          const track = library.find((t) => t.id === decks[deck]?.trackId) ?? null;
          return {
            deck,
            report: report.decks[deck]!,
            analysis: track?.analysis ?? null,
            hotCues: decks[deck]!.hotCues,
            title: track ? titleOf(track.name) : null,
            syncMaster: report.syncMaster === deck,
          };
        })}
      />
      <div className="dj-stage" data-layout={layout}>
        <div className="dj-decks dj-decks-left">
          {deckPanel(0)}
          {layout === 4 && deckPanel(2)}
        </div>
        <MixerPanel
          channels={channels}
          mixer={mixer}
          report={report}
          count={layout}
          headphones={dj?.headphones ?? false}
          canPlay={dj !== null}
          onChannel={changeChannel}
          onMixer={changeMixer}
          recording={{ on: report.recording, seconds: report.recordingSeconds, format, saving }}
          onRecordFormat={setFormat}
          onRecord={(on) => void record(on)}
        />
        <div className="dj-decks dj-decks-right">
          {deckPanel(1)}
          {layout === 4 && deckPanel(3)}
        </div>
      </div>
      <DjBrowser
        source={samples}
        library={folderLibrary}
        canAudition={output !== null}
        targets={targets}
        onUse={onUse}
        onError={onBrowseError}
        tracks={library}
        decks={layout}
        canLoad={dj !== null}
        onAdd={(files) => void addFiles(files)}
        onLoad={(trackId, deck) => {
          const track = library.find((t) => t.id === trackId);
          if (track) void loadTrack(track, deck);
        }}
      />
    </div>
  );
}
