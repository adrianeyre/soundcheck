import { FolderTree, ListMusic } from "lucide-react";
import { memo, useEffect, useId, useState } from "react";

import type { LibraryStorage } from "../preset/library-storage";
import { SampleBrowser, type SampleTarget } from "../samples/SampleBrowser";
import type { SampleRef, SampleSource } from "../samples/sample-source";
import type { LibraryTrack } from "./dj-state";
import { TrackBrowser } from "./TrackBrowser";

/** The folder tree only changes with its own props, never with the page's reports. */
const Folders = memo(SampleBrowser);

export interface DjBrowserProps {
  /**
   * Which it is: the Mixer page's two, 1 and 2, or the Pads page's, 3. In its heading, and its id, which a
   * Deck's BROWSE button looks it up by.
   */
  number: 1 | 2 | 3;
  /** Its heading, if not "Track browser" and its number. */
  title?: string;
  /** The sample folders on this machine, or null where the platform has none. */
  source: SampleSource | null;
  library: LibraryStorage | null;
  canAudition: boolean;
  /** One target per Deck on the page: `deck:0`… */
  targets: readonly SampleTarget[];
  onUse: (sample: SampleRef, target: string) => void;
  onError: (message: string) => void;
  tracks: readonly LibraryTrack[];
  decks: number;
  canLoad: boolean;
  onAdd: (files: File[]) => void;
  onLoad: (trackId: string, deck: number) => void;
  /** The loaded track the Pad Controller's browse knob is on, and a way to put it on another. */
  cursor?: string | null;
  onCursor?: (trackId: string) => void;
  /** Told the loaded tracks' order as this browser sorts them, for the knob to move through. */
  onOrder?: (ids: readonly string[]) => void;
  /** A tab to bring into view, each time `nonce` changes: the browse knob's press. */
  show?: { tab: Tab; nonce: number } | null;
}

export type Tab = "folders" | "loaded";

/**
 * The Track browser, as DJ software's: the Editor's folder tree of the
 * sample folders (search, audition, and "Use on" a Deck, or drag a file onto
 * one), and beside it the files already loaded this session with their BPM
 * and key. Where the platform can't list folders, only the loaded list, with
 * its file picker, is offered.
 */
export function DjBrowser(props: DjBrowserProps) {
  const { source, library } = props;
  const hasFolders = source !== null && library !== null;
  const [tab, setTab] = useState<Tab>(hasFolders ? "folders" : "loaded");
  const id = useId();
  // The browse knob's press: its tab brought up, and the browser focused.
  const shown = props.show;
  const [seen, setSeen] = useState(shown?.nonce ?? 0);
  if (shown && shown.nonce !== seen) {
    setSeen(shown.nonce);
    setTab(shown.tab);
  }
  useEffect(() => {
    if (shown) document.getElementById(`dj-browser-${props.number}`)?.focus({ preventScroll: true });
  }, [shown, props.number]);
  const title = props.title ?? `Track browser ${props.number}`;
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "folders", label: "Folders", icon: <FolderTree size={14} aria-hidden /> },
    { id: "loaded", label: `Loaded tracks (${props.tracks.length})`, icon: <ListMusic size={14} aria-hidden /> },
  ];
  return (
    <section id={`dj-browser-${props.number}`} className="dj-browser panel" aria-labelledby={`${id}-heading`} tabIndex={-1}>
      <div className="panel-head">
        <h2 id={`${id}-heading`}>
          <ListMusic size={18} aria-hidden />
          {title}
        </h2>
        <div className="dj-tabs" role="tablist" aria-label={`${title} views`}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${id}-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${id}-${t.id}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              className="dj-tab"
              onClick={() => setTab(t.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                const next = tabs[(tabs.findIndex((x) => x.id === tab) + 1) % tabs.length]!.id;
                setTab(next);
                document.getElementById(`${id}-${next}`)?.focus();
              }}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`${id}-folders-panel`} aria-labelledby={`${id}-folders`} hidden={tab !== "folders"}>
        {hasFolders ? (
          <Folders
            source={source}
            library={library}
            canAudition={props.canAudition}
            targets={props.targets}
            onUse={props.onUse}
            onError={props.onError}
            title="Folders"
            noTargets="Start audio to load a Deck"
          />
        ) : (
          <p className="hint">
            This platform can&apos;t list folders of files. Add files under Loaded tracks, or drop them onto a Deck.
          </p>
        )}
      </div>
      <div role="tabpanel" id={`${id}-loaded-panel`} aria-labelledby={`${id}-loaded`} hidden={tab !== "loaded"}>
        <TrackBrowser
          tracks={props.tracks}
          decks={props.decks}
          canLoad={props.canLoad}
          onAdd={props.onAdd}
          onLoad={props.onLoad}
          cursor={props.cursor ?? null}
          onCursor={props.onCursor}
          onOrder={props.onOrder}
        />
      </div>
    </section>
  );
}
