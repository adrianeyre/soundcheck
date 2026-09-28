import { FilePlus2, ListMusic } from "lucide-react";
import { useRef, useState } from "react";

import { camelotName, formatBpm, formatTime, keyName } from "./dj-logic";
import { type LibraryTrack, titleOf } from "./dj-state";

type Column = "title" | "bpm" | "key" | "length";

const COLUMNS: { id: Column; label: string }[] = [
  { id: "title", label: "Title" },
  { id: "bpm", label: "BPM" },
  { id: "key", label: "Key" },
  { id: "length", label: "Length" },
];

/** How `track` sorts by `column`: a file not yet analysed sorts last. */
function sortValue(track: LibraryTrack, column: Column): string | number {
  const analysis = track.analysis;
  switch (column) {
    case "title":
      return titleOf(track.name).toLowerCase();
    case "bpm":
      return analysis?.bpm || Number.POSITIVE_INFINITY;
    case "key":
      return analysis?.key ? camelotName(analysis.key).padStart(3, "0") : "zzz";
    case "length":
      return analysis?.seconds ?? Number.POSITIVE_INFINITY;
  }
}

export function sortTracks(tracks: readonly LibraryTrack[], column: Column, ascending: boolean): LibraryTrack[] {
  return tracks.toSorted((a, b) => {
    const [x, y] = [sortValue(a, column), sortValue(b, column)];
    const order = x < y ? -1 : x > y ? 1 : 0;
    return ascending ? order : -order;
  });
}

export interface TrackBrowserProps {
  tracks: readonly LibraryTrack[];
  decks: number;
  canLoad: boolean;
  onAdd: (files: File[]) => void;
  onLoad: (trackId: string, deck: number) => void;
}

/**
 * The Track browser: every file the DJ has added, with its BPM, key (in
 * Camelot notation too) and length once a Deck has analysed it, sortable by
 * any column. A row loads onto a Deck by its buttons, or is dragged onto one.
 */
export function TrackBrowser({ tracks, decks, canLoad, onAdd, onLoad }: TrackBrowserProps) {
  const [sort, setSort] = useState<{ column: Column; ascending: boolean }>({ column: "title", ascending: true });
  const input = useRef<HTMLInputElement>(null);
  const sorted = sortTracks(tracks, sort.column, sort.ascending);

  return (
    <section
      className="dj-browser panel"
      aria-labelledby="dj-browser-heading"
      onDragOver={(event) => event.dataTransfer.types.includes("Files") && event.preventDefault()}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        onAdd([...event.dataTransfer.files]);
      }}
    >
      <div className="panel-head">
        <h2 id="dj-browser-heading">
          <ListMusic size={18} aria-hidden />
          Track browser
        </h2>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept="audio/mpeg,audio/wav,audio/x-wav,audio/flac,.mp3,.wav,.flac"
          aria-label="Add files to the Track browser"
          onChange={(event) => {
            onAdd([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <button type="button" className="btn-sm" onClick={() => input.current?.click()}>
          <FilePlus2 size={14} aria-hidden />
          Add files
        </button>
      </div>
      {tracks.length === 0 ? (
        <p className="hint">Add MP3, WAV or FLAC files, or drop them here. A file&apos;s BPM and key show once it is on a Deck.</p>
      ) : (
        <div className="dj-browser-scroll">
          <table className="dj-browser-table">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={sort.column === column.id ? (sort.ascending ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="dj-sort"
                      onClick={() =>
                        setSort({ column: column.id, ascending: sort.column === column.id ? !sort.ascending : true })
                      }
                    >
                      {column.label}
                      <span aria-hidden>{sort.column === column.id ? (sort.ascending ? " ▲" : " ▼") : ""}</span>
                    </button>
                  </th>
                ))}
                <th scope="col">Load</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((track) => (
                <tr
                  key={track.id}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData("application/x-soundcheck-dj-track", track.id)}
                >
                  <th scope="row">{titleOf(track.name)}</th>
                  <td className="num">{track.analysis ? formatBpm(track.analysis.bpm) : "—"}</td>
                  <td className="num">
                    {track.analysis?.key ? `${keyName(track.analysis.key)} · ${camelotName(track.analysis.key)}` : "—"}
                  </td>
                  <td className="num">{track.analysis ? formatTime(track.analysis.seconds) : "—"}</td>
                  <td>
                    <div className="row">
                      {Array.from({ length: decks }, (_, deck) => (
                        <button
                          key={deck}
                          type="button"
                          className="btn-sm"
                          aria-label={`Load ${titleOf(track.name)} onto Deck ${deck + 1}`}
                          disabled={!canLoad}
                          onClick={() => onLoad(track.id, deck)}
                        >
                          {deck + 1}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
