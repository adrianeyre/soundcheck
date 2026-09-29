import { Power } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AudioOutput } from "../audio/audio-output";
import { defaultLayout, type WidgetId, type WidgetLayout } from "../grid/layout";
import { WidgetGrid, type WidgetGridProps } from "../grid/WidgetGrid";
import type { LibraryStorage } from "../preset/library-storage";
import type { SampleTarget } from "../samples/SampleBrowser";
import type { SampleRef, SampleSource } from "../samples/sample-source";
import { AddToSong } from "./AddToSong";
import { DjBrowser } from "./DjBrowser";
import type { HeadphoneOutput } from "./headphone-output";
import { DeckPanel } from "./DeckPanel";
import { type DjSession, type DjSessionProps, useDjSession } from "./dj-session";
import { titleOf } from "./dj-state";
import { MixerPanel } from "./MixerPanel";
import { PadController } from "./PadController";
import type { DjRecordingSaver } from "./recording-saver";
import type { TimecodeControls } from "./timecode-input";
import { WaveformStack } from "./WaveformStack";

/**
 * A Deck's BROWSE button: the Track browser on its side of the mixer brought into view and focused, Decks 1
 * and 3 the first, 2 and 4 the second; or the other, if that one is hidden.
 */
export function browse(deck: number) {
  const [near, far] = deck % 2 === 0 ? [1, 2] : [2, 1];
  const browser = document.getElementById(`dj-browser-${near}`) ?? document.getElementById(`dj-browser-${far}`);
  browser?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  browser?.focus({ preventScroll: true });
}

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

/** A page's Grid (ADR 0004): its layout, kept by the app, where its pinned Widgets go, and a way to say which are empty. */
export interface PageGrid {
  layout: WidgetLayout;
  onLayout: (layout: WidgetLayout) => void;
  pinned?: WidgetGridProps["pinned"];
  onEmpty?: (empty: readonly WidgetId[]) => void;
}

export interface DjPageProps {
  output: AudioOutput | null;
  /** Start the audio output, as the Editor's Start audio does. */
  onStart?: () => void;
  starting?: boolean;
  /** Whether the page is the one showing, so its keyboard shortcuts apply. */
  active: boolean;
  saver: DjRecordingSaver;
  /** Where the headphone cue plays: a second output device, null where none can be chosen, absent for no picker. */
  headphones?: HeadphoneOutput | null;
  /** The sample folders the Editor's Samples Widget reads, for the Track browser's tree; null where there are none. */
  samples?: SampleSource | null;
  /** The app-level library, where those folders are remembered and the Sampler's slots kept. */
  library?: LibraryStorage | null;
  /** Put a recording into the Editor's song (`DjSessionProps.onAddToSong`). */
  onAddToSong?: DjSessionProps["onAddToSong"];
  /**
   * The page's Grid (ADR 0004): its layout, kept by the app, where its pinned Widgets go, and a way
   * to say which Widgets have nothing to show. Without one the page keeps a layout of its own.
   */
  grid?: PageGrid;
}

/**
 * The Mixer page on a session of its own, for a host (or a test) that has
 * only this page. The app shares one session between the Mixer page and the
 * Pads page (`MixerPage`, `PadsPage`).
 */
export function DjPage(props: DjPageProps) {
  const session = useDjSession(props);
  return <MixerPage {...props} session={session} />;
}

/** The parts of a page drawn over the shared session. */
export interface SessionPageProps {
  session: DjSession;
  onStart?: () => void;
  starting?: boolean;
  active: boolean;
  headphones?: HeadphoneOutput | null;
  samples?: SampleSource | null;
  library?: LibraryStorage | null;
  grid?: PageGrid;
  /** The Decks' timecode vinyl (`useTimecode`), or absent for none. */
  timecode?: TimecodeControls | null;
}

/**
 * The Track browser, over the session's loaded tracks: `number` 1 and 2 on
 * the Mixer page, and the Pads page's own.
 */
export function SessionBrowser({
  session,
  number,
  samples,
  library,
  sampleTargets = true,
  title,
}: {
  session: DjSession;
  number: 1 | 2 | 3;
  samples: SampleSource | null;
  library: LibraryStorage | null;
  /** Whether a folder's file can be put straight onto a Deck. */
  sampleTargets?: boolean;
  /** Its heading, if not "Track browser" and its number. */
  title?: string;
}) {
  const { dj, layout, output } = session;
  const targets = useMemo<SampleTarget[]>(
    () => (dj && sampleTargets ? Array.from({ length: layout }, (_, deck) => ({ id: `deck:${deck}`, label: `Deck ${deck + 1}` })) : []),
    [dj, layout, sampleTargets],
  );
  const putSample = session.putSample;
  const onUse = useCallback((sample: SampleRef, target: string) => void putSample(sample, Number(target.split(":")[1])), [putSample]);
  const setMessage = session.setMessage;
  const onBrowseError = useCallback((error: string) => setMessage(error), [setMessage]);
  // A browser with a folder tree is one the browse knob can drive.
  const registerTree = session.registerTree;
  const hasTree = samples !== null && library !== null;
  useEffect(() => (hasTree ? registerTree(number) : undefined), [hasTree, registerTree, number]);
  return (
    <DjBrowser
      number={number}
      title={title}
      source={samples}
      library={library}
      canAudition={output !== null}
      targets={targets}
      onUse={onUse}
      onError={onBrowseError}
      tracks={session.library}
      decks={layout}
      canLoad={dj !== null}
      onAdd={(files) => void session.addFiles(files)}
      onLoad={(trackId, deck) => {
        const track = session.library.find((t) => t.id === trackId);
        if (track) void session.loadTrack(track, deck);
      }}
      cursor={session.cursor}
      onCursor={session.setCursor}
      onOrder={session.setOrder}
      show={number === 3 || number === 1 ? session.browserShow : null}
      treeCursor={session.treeCursor?.key ?? null}
      treeCommand={session.treeCommand?.browser === number ? session.treeCommand : null}
      onTreeCursor={session.onTreeCursor}
    />
  );
}

/** Start audio, as the page's toolbar offers it. */
export function StartAudio({ session, onStart, starting }: Pick<SessionPageProps, "session" | "onStart" | "starting">) {
  if (session.output || !onStart) return null;
  return (
    <button type="button" className="btn-primary" disabled={starting} aria-busy={starting} onClick={onStart}>
      <Power size={16} aria-hidden />
      {starting ? "Starting…" : "Start audio for mixing"}
    </button>
  );
}

/**
 * The Mixer page (ADR 0013): two or four CDJ-style **Decks** around a
 * DJM-style mixer, and the **Track browser**. It only tells the engine what
 * the DJ does and draws what the engine reports; nothing here is the
 * Project's, and none of it is undone.
 */
export function MixerPage(props: SessionPageProps) {
  const { session, onStart, starting = false, active, samples = null, library: folderLibrary = null, grid, headphones } = props;
  const [ownLayout, setOwnLayout] = useState(() => defaultLayout("mixing"));
  const { output, dj, layout, setLayout, library, decks, channels, mixer, report, send, format, saving, message } = session;
  const [span, setSpan] = useState(4);

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
        masterKey={report.syncMaster !== deck ? session.masterKey : null}
        canPlay={dj !== null}
        set={(name, value) => send("deck", deck, name, value)}
        onState={(change) => session.changeDeck(deck, change)}
        onLoadFile={(file) => void session.addFiles([file]).then(([added]) => added && session.loadTrack(added, deck))}
        onDropTrack={(trackId) => {
          const dropped = library.find((t) => t.id === trackId);
          if (dropped) void session.loadTrack(dropped, deck);
        }}
        onDropSample={(sample) => void session.putSample(sample, deck)}
        onBrowse={() => browse(deck)}
        onEject={() => session.eject(deck)}
        timecode={props.timecode}
      />
    );
  };

  // With two Decks, the third and fourth have nothing to show, so they are off the Grid (ADR 0004).
  const empty: WidgetId[] = layout === 4 ? [] : ["deck3", "deck4"];
  const emptyKey = empty.join(" ");
  const onEmpty = grid?.onEmpty;
  useEffect(() => {
    onEmpty?.(emptyKey ? (emptyKey.split(" ") as WidgetId[]) : []);
  }, [emptyKey, onEmpty]);

  return (
    <div className="dj-page">
      <div className="dj-toolbar row">
        <StartAudio session={session} onStart={onStart} starting={starting} />
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
      <WidgetGrid
        layout={grid?.layout ?? ownLayout}
        onLayout={grid?.onLayout ?? setOwnLayout}
        pinned={grid?.pinned}
        empty={empty}
        widgets={{
          djWaveforms: (
            <WaveformStack
              span={span}
              onSpan={setSpan}
              onDeck={(deck, name, value) => send("deck", deck, name, value)}
              lanes={Array.from({ length: layout }, (_, deck) => {
                const track = library.find((t) => t.id === decks[deck]?.trackId) ?? null;
                return {
                  deck,
                  report: report.decks[deck]!,
                  analysis: track?.analysis ?? null,
                  hotCues: decks[deck]!.hotCues,
                  title: track ? titleOf(track.name) : null,
                  syncMaster: report.syncMaster === deck,
                  vinyl: decks[deck]!.vinyl,
                };
              })}
            />
          ),
          deck1: deckPanel(0),
          deck2: deckPanel(1),
          // The third and fourth Decks are on the page only with four Decks; until then they step aside.
          deck3: layout === 4 ? deckPanel(2) : null,
          deck4: layout === 4 ? deckPanel(3) : null,
          djMixer: (
            <MixerPanel
              channels={channels}
              mixer={mixer}
              report={report}
              // All four channels, even with two Decks: the mixer reads as the four-channel hardware it models.
              count={4}
              headphones={dj?.headphones ?? false}
              canPlay={dj !== null}
              onChannel={session.changeChannel}
              onMixer={session.changeMixer}
              recording={{ on: report.recording, seconds: report.recordingSeconds, format, saving }}
              onRecordFormat={session.setFormat}
              onRecord={(on) => void session.record(on, { source: "master" })}
              addToSong={
                session.canAddToSong ? (
                  <AddToSong
                    place={session.songPlace}
                    onPlace={session.setSongPlace}
                    onAdd={() => void session.addTakeToSong()}
                    disabled={session.take === null || report.recording || saving}
                    tempoOffer={session.tempoOffer ?? null}
                    onSetTempo={session.setSongTempo}
                  />
                ) : undefined
              }
              headphoneOutput={headphones}
              output={output}
            />
          ),
          djBrowser: <SessionBrowser session={session} number={1} samples={samples} library={folderLibrary} />,
          djBrowser2: <SessionBrowser session={session} number={2} samples={samples} library={folderLibrary} />,
          djPadController: <PadController session={session} id="mixing" timecode={props.timecode} />,
        }}
      />
    </div>
  );
}
