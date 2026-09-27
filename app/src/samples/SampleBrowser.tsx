import {
  ChevronRight,
  CircleAlert,
  FileAudio,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Headphones,
  LoaderCircle,
  Play,
  RotateCw,
  Square,
  Volume2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { LibraryStorage } from "../preset/library-storage";
import { readLocal, writeLocal } from "../settings/local-settings";
import { startSampleDrag } from "./sample-drag";
import { addSampleFolder, loadSampleFolders, removeSampleFolder, saveSampleFolders } from "./sample-folders";
import type { SampleFolder, SampleRef, SampleSource } from "./sample-source";
import {
  baseName,
  filterSampleTree,
  folderPart,
  formatOf,
  matchRanges,
  sampleTree,
  searchWords,
  type SampleTreeFolder,
} from "./sample-tree";

/** The most entries a folder shows at once; "Show more" and searching reach the rest. */
export const SHOWN_FILES = 200;

/** Where the preview-on-select choice is kept, in local storage. */
export const PREVIEW_KEY = "soundcheck.samples.preview";

/** Somewhere a sample can go without dragging it: an Audio Track or a Pad. */
export interface SampleTarget {
  id: string;
  label: string;
}

export interface SampleBrowserProps {
  /** The platform's sample folders; null where there are none. */
  source: SampleSource | null;
  /** The app-level library, where the added folders are remembered. */
  library: LibraryStorage;
  /** Whether audio is running, which auditioning needs. */
  canAudition: boolean;
  /** Every Audio Track and Pad, for putting a file on one without dragging. */
  targets: readonly SampleTarget[];
  /** Put `sample` on the target with id `target`. */
  onUse: (sample: SampleRef, target: string) => void;
  onError: (message: string) => void;
}

type Listing = { files: string[] } | { error: string };

/** One line of the tree, in the order it is shown. */
type Row = {
  key: string;
  folder: SampleFolder;
  level: number;
  setSize: number;
  posInSet: number;
} & (
  | { kind: "root"; listing: Listing | undefined; count: number | null; expanded: boolean }
  | { kind: "folder"; node: SampleTreeFolder; expanded: boolean }
  | { kind: "file"; path: string }
  | { kind: "more"; parent: string; hidden: number }
  | { kind: "status"; text: string; tone: "loading" | "error" | "empty" }
);

const rootKey = (folder: SampleFolder) => `r\n${folder.id}`;
const folderKey = (folder: SampleFolder, path: string) => `d\n${folder.id}\n${path}`;
const fileKey = (folder: SampleFolder, path: string) => `f\n${folder.id}\n${path}`;

/**
 * Folders of samples on the musician's machine (#52), shown as the folders
 * they are arranged in, as a tree. A file auditions straight to the audio
 * output, past the mixer, and is dragged onto an Audio Track's lane or a
 * Pad, or put on one from the selection's menu, which copies it into the
 * Project. The folders are remembered app-wide, in the library.
 */
export function SampleBrowser(props: SampleBrowserProps) {
  return (
    <section aria-labelledby="samples-heading" className="panel sample-browser">
      <div className="panel-head">
        <h2 id="samples-heading">
          <FolderTree size={18} aria-hidden />
          Samples
        </h2>
      </div>
      {props.source ? (
        <Browser {...props} source={props.source} />
      ) : (
        <p className="hint">The sample browser is unavailable here: it has no way to read folders on your machine.</p>
      )}
    </section>
  );
}

function Browser({ source, library, canAudition, targets, onUse, onError }: SampleBrowserProps & { source: SampleSource }) {
  const id = useId();
  // Null until the library has been read, so nothing added meanwhile is lost.
  const [folders, setFolders] = useState<readonly SampleFolder[] | null>(null);
  const edited = useRef(false);
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(new Map());
  // Folders whose files have been asked for, so each is read once.
  const requested = useRef(new Set<string>());
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const words = useMemo(() => searchWords(deferred), [deferred]);
  const searching = words.length > 0;
  // Folders opened or closed against their default: the added folders start open, those inside them closed.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(new Map());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [auditioned, setPlaying] = useState<string | null>(null);
  // Nothing plays once audio stops.
  const playing = canAudition ? auditioned : null;
  const [preview, setPreview] = useState(() => readLocal(PREVIEW_KEY) === "on");
  const items = useRef(new Map<string, HTMLElement>());
  const focusNext = useRef<string | null>(null);
  const typed = useRef({ text: "", at: 0 });

  useEffect(() => {
    let current = true;
    loadSampleFolders(library).then(
      (loaded) => current && setFolders(loaded),
      () => current && setFolders([]),
    );
    return () => {
      current = false;
    };
  }, [library]);

  const read = useCallback(
    (folder: SampleFolder) => {
      requested.current.add(folder.id);
      source.listAudio(folder).then(
        (files) => setListings((known) => new Map(known).set(folder.id, { files })),
        (reason: unknown) => setListings((known) => new Map(known).set(folder.id, { error: message(reason) })),
      );
    },
    [source],
  );

  // Each folder is read once it is there; adding or removing another leaves it be.
  useEffect(() => {
    for (const folder of folders ?? []) if (!requested.current.has(folder.id)) read(folder);
  }, [folders, read]);

  // What the musician changes is saved, and only that: not what was just read.
  useEffect(() => {
    if (!folders || !edited.current) return;
    saveSampleFolders(library, folders).catch((reason: unknown) =>
      onError(`The sample folders couldn't be saved: ${message(reason)}`),
    );
  }, [folders, library, onError]);

  useEffect(() => source.onAuditionEnd?.(() => setPlaying(null)), [source]);

  const trees = useMemo(() => {
    const built = new Map<string, SampleTreeFolder>();
    for (const [folderId, listing] of listings) if ("files" in listing) built.set(folderId, sampleTree(listing.files));
    return built;
  }, [listings]);

  const rows = useMemo(
    () => treeRows(folders ?? [], listings, trees, words, toggled, limits),
    [folders, listings, trees, words, toggled, limits],
  );

  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.key === activeKey),
  );
  const active = rows[activeIndex];

  useLayoutEffect(() => {
    if (focusNext.current === null) return;
    const element = items.current.get(focusNext.current);
    focusNext.current = null;
    element?.focus();
    element?.scrollIntoView?.({ block: "nearest" });
  });

  const change = (update: (current: readonly SampleFolder[]) => SampleFolder[]) => {
    edited.current = true;
    setFolders((current) => update(current ?? []));
  };

  const addFolder = async () => {
    try {
      const folder = await source.chooseFolder();
      if (!folder) return;
      change((current) => addSampleFolder(current, folder));
      setActiveKey(rootKey(folder));
    } catch (reason) {
      onError(message(reason));
    }
  };

  const removeFolder = (folder: SampleFolder) => {
    change((current) => removeSampleFolder(current, folder.id));
    // Added again later, it is read afresh.
    requested.current.delete(folder.id);
    setListings((known) => {
      const next = new Map(known);
      next.delete(folder.id);
      return next;
    });
    if (playing?.startsWith(`f\n${folder.id}\n`)) void stopAudition();
  };

  // From a click, so a browser that wants permission to read the folder again can ask for it.
  const readAgain = (folder: SampleFolder) => {
    setListings((known) => {
      const next = new Map(known);
      next.delete(folder.id);
      return next;
    });
    read(folder);
  };

  const audition = (sample: SampleRef) => {
    if (!canAudition) return;
    const key = fileKey(sample.folder, sample.path);
    setPlaying(key);
    source.audition(sample).catch((reason: unknown) => {
      setPlaying((now) => (now === key ? null : now));
      onError(message(reason));
    });
  };

  const stopAudition = async () => {
    setPlaying(null);
    await source.stopAudition().catch(() => undefined);
  };

  const toggleAudition = (sample: SampleRef) => {
    if (playing === fileKey(sample.folder, sample.path)) void stopAudition();
    else audition(sample);
  };

  const togglePreview = () => {
    setPreview((on) => {
      writeLocal(PREVIEW_KEY, on ? "off" : "on");
      return !on;
    });
  };

  const toggleOpen = (key: string) =>
    setToggled((known) => {
      const next = new Set(known);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const setOpen = (row: Row, open: boolean) => {
    if ((row.kind === "root" || row.kind === "folder") && row.expanded !== open && !searching) toggleOpen(row.key);
  };

  /** Make `row` the selection, and move focus to it where the keyboard asked. */
  const select = (row: Row, focus: boolean) => {
    setActiveKey(row.key);
    if (focus) focusNext.current = row.key;
    if (preview && row.kind === "file" && row.key !== active?.key) audition({ folder: row.folder, path: row.path });
  };

  const activate = (row: Row) => {
    if (row.kind === "file") toggleAudition({ folder: row.folder, path: row.path });
    else if (row.kind === "root" || row.kind === "folder") setOpen(row, !row.expanded);
    else if (row.kind === "more") showMore(row);
  };

  const showMore = (row: Row & { kind: "more" }) =>
    setLimits((known) => new Map(known).set(row.parent, (known.get(row.parent) ?? SHOWN_FILES) + SHOWN_FILES));

  const go = (index: number) => {
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (row) select(row, true);
  };

  const onTreeKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!active) return;
    const parentIndex = () => {
      for (let at = activeIndex - 1; at >= 0; at--) if (rows[at]!.level < active.level) return at;
      return activeIndex;
    };
    const page = Math.max(1, Math.floor((event.currentTarget.clientHeight || 360) / 36) - 1);
    const open = (active.kind === "root" || active.kind === "folder") && active.expanded;
    const closed = (active.kind === "root" || active.kind === "folder") && !active.expanded;
    switch (event.key) {
      case "ArrowDown":
        go(activeIndex + 1);
        break;
      case "ArrowUp":
        go(activeIndex - 1);
        break;
      case "PageDown":
        go(activeIndex + page);
        break;
      case "PageUp":
        go(activeIndex - page);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      case "ArrowRight":
        if (closed) setOpen(active, true);
        else if (open) go(activeIndex + 1);
        break;
      case "ArrowLeft":
        if (open && !searching) setOpen(active, false);
        else go(parentIndex());
        break;
      case "Enter":
      case " ":
        activate(active);
        break;
      case "Escape":
        if (playing === null) return;
        void stopAudition();
        break;
      default: {
        // Type the start of a name to go to it.
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const now = event.timeStamp;
        typed.current = { text: now - typed.current.at < 700 ? typed.current.text + event.key : event.key, at: now };
        const wanted = typed.current.text.toLowerCase();
        const order = [...rows.slice(activeIndex + (wanted.length === 1 ? 1 : 0)), ...rows.slice(0, activeIndex)];
        const found = order.find((row) => rowName(row).toLowerCase().startsWith(wanted));
        if (found) select(found, true);
        break;
      }
    }
    event.preventDefault();
  };

  if (folders?.length === 0) {
    return (
      <div className="sample-empty">
        <FolderPlus size={28} aria-hidden className="muted" />
        <p>Add a folder of samples to browse its folders, audition files and drop them into the song.</p>
        <button type="button" className="btn-primary" onClick={() => void addFolder()}>
          <FolderPlus size={16} aria-hidden />
          Add folder
        </button>
      </div>
    );
  }

  const total = [...trees.values()].reduce((sum, tree) => sum + tree.count, 0);
  const found = searching
    ? rows.filter((row) => row.kind === "file").length +
      rows.reduce((sum, row) => sum + (row.kind === "more" ? row.hidden : 0), 0)
    : total;
  const selected = active?.kind === "file" ? { folder: active.folder, path: active.path } : null;
  const selectedRoot =
    active && (active.kind === "root" || (active.kind === "status" && active.level === 2))
      ? active.folder
      : null;

  return (
    <div className="sample-browser-body">
      <div className="row sample-toolbar">
        <button type="button" className="btn-sm" disabled={!folders} onClick={() => void addFolder()}>
          <FolderPlus size={14} aria-hidden />
          Add folder
        </button>
        <div className="sample-search">
          <label className="visually-hidden" htmlFor={`${id}-search`}>
            Search samples
          </label>
          <input
            id={`${id}-search`}
            type="search"
            placeholder="Search samples"
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.preventDefault();
                setSearch("");
              } else if (event.key === "ArrowDown" && rows[0]) {
                event.preventDefault();
                select(rows[0], true);
              }
            }}
          />
          {search && (
            <button
              type="button"
              className="btn-sm btn-icon btn-ghost"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => setSearch("")}
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn-sm btn-icon"
          aria-label="Preview on select"
          aria-pressed={preview}
          title={preview ? "Stop playing each file as it is selected" : "Play each file as it is selected"}
          disabled={!canAudition}
          onClick={togglePreview}
        >
          <Headphones size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="btn-sm btn-icon"
          aria-label="Stop audition"
          title="Stop audition (Esc)"
          disabled={!canAudition}
          onClick={() => void stopAudition()}
        >
          <Square size={14} aria-hidden />
        </button>
      </div>

      <p className="hint sample-summary" role="status">
        {searching
          ? found === 0
            ? `No samples match “${search.trim()}”.`
            : `${found} of ${total} ${total === 1 ? "sample" : "samples"} match`
          : !canAudition && total > 0
            ? "Start audio to audition. Drag a file onto an Audio Track or a Pad, or select it and choose where it goes."
            : total > 0
              ? "Drag a file onto an Audio Track or a Pad, or select it and choose where it goes: it is copied into the Project."
              : ""}
      </p>

      {rows.length > 0 && (
        <div
          role="tree"
          aria-label="Sample folders"
          className="sample-tree"
          onKeyDown={onTreeKey}
        >
          {rows.map((row, index) => (
            <TreeRow
              key={row.key}
              row={row}
              words={words}
              active={index === activeIndex}
              playing={row.key === playing}
              canAudition={canAudition}
              ref={(element) => {
                if (element) items.current.set(row.key, element);
                else items.current.delete(row.key);
              }}
              onSelect={() => select(row, false)}
              onActivate={() => activate(row)}
              onAudition={audition}
              onToggleAudition={(sample) => {
                select(row, false);
                toggleAudition(sample);
              }}
              onRemove={removeFolder}
            />
          ))}
        </div>
      )}
      {searching && found === 0 && (
        <button type="button" className="btn-sm sample-clear" onClick={() => setSearch("")}>
          Clear search
        </button>
      )}

      {selected && (
        <div className="sample-details" role="group" aria-label="Selected sample">
          <div className="sample-details-name">
            <strong title={selected.path}>{baseName(selected.path)}</strong>
            <span className="hint">
              {[selected.folder.label, folderPart(selected.path)].filter(Boolean).join(" / ")}
              {formatOf(selected.path) && ` · ${formatOf(selected.path)}`}
            </span>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn-sm"
              disabled={!canAudition}
              title={canAudition ? undefined : "Start audio to audition"}
              onClick={() => toggleAudition(selected)}
            >
              {playing === fileKey(selected.folder, selected.path) ? (
                <>
                  <Square size={14} aria-hidden />
                  Stop
                </>
              ) : (
                <>
                  <Play size={14} aria-hidden />
                  Audition
                </>
              )}
            </button>
            {/* Dragging's single-pointer alternative (WCAG 2.5.7). */}
            <label className="field-inline">
              Put on
              <select
                value=""
                disabled={targets.length === 0}
                onChange={(event) => event.target.value && onUse(selected, event.target.value)}
              >
                <option value="">{targets.length === 0 ? "No Audio Track or Pad" : "Choose…"}</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
      {selectedRoot && (
        <div className="sample-details" role="group" aria-label="Selected folder">
          <div className="sample-details-name">
            <strong title={selectedRoot.id}>{selectedRoot.label}</strong>
            <span className="hint">Its folders and files stay where they are on your machine.</span>
          </div>
          <div className="row">
            {"error" in (listings.get(selectedRoot.id) ?? {}) && (
              <button type="button" className="btn-sm" onClick={() => readAgain(selectedRoot)}>
                <RotateCw size={14} aria-hidden />
                Read {selectedRoot.label} again
              </button>
            )}
            <button
              type="button"
              className="btn-sm"
              aria-label={`Remove ${selectedRoot.label}`}
              title={`Remove ${selectedRoot.label} from the sample browser`}
              onClick={() => removeFolder(selectedRoot)}
            >
              <X size={14} aria-hidden />
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface TreeRowProps {
  row: Row;
  words: readonly string[];
  active: boolean;
  playing: boolean;
  canAudition: boolean;
  ref: (element: HTMLDivElement | null) => void;
  onSelect: () => void;
  onActivate: () => void;
  onAudition: (sample: SampleRef) => void;
  onToggleAudition: (sample: SampleRef) => void;
  onRemove: (folder: SampleFolder) => void;
}

function TreeRow({
  row,
  words,
  active,
  playing,
  canAudition,
  ref,
  onSelect,
  onActivate,
  onAudition,
  onToggleAudition,
  onRemove,
}: TreeRowProps) {
  const branch = row.kind === "root" || row.kind === "folder";
  const expanded = branch ? row.expanded : undefined;
  const name = rowName(row);
  const sample = row.kind === "file" ? { folder: row.folder, path: row.path } : null;
  const count = row.kind === "root" ? row.count : row.kind === "folder" ? row.node.count : null;
  const id = useId();
  const described = [count !== null && `${id}-count`, row.kind === "file" && `${id}-format`].filter(Boolean).join(" ");
  return (
    <div
      ref={ref}
      role="treeitem"
      aria-labelledby={`${id}-name`}
      aria-describedby={described || undefined}
      aria-level={row.level}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={expanded}
      aria-selected={active}
      aria-disabled={row.kind === "status" ? true : undefined}
      tabIndex={active ? 0 : -1}
      className="sample-item"
      data-kind={row.kind}
      data-tone={row.kind === "status" ? row.tone : undefined}
      data-playing={playing || undefined}
      style={{ "--level": row.level - 1 } as CSSProperties}
      title={row.kind === "file" ? `${row.path}: drag onto an Audio Track or a Pad` : row.kind === "root" ? row.folder.id : undefined}
      draggable={sample !== null}
      onDragStart={sample ? (event) => startSampleDrag(event.dataTransfer, sample) : undefined}
      onClick={() => {
        onSelect();
        if (branch || row.kind === "more") onActivate();
      }}
      // Played from the start, even where selecting it already started it.
      onDoubleClick={sample ? () => onAudition(sample) : undefined}
    >
      <span className="sample-item-chevron" aria-hidden>
        {branch && <ChevronRight size={14} />}
      </span>
      <span className="sample-item-icon" aria-hidden>
        {row.kind === "file" ? (
          playing ? (
            <Volume2 size={14} />
          ) : (
            <FileAudio size={14} />
          )
        ) : branch ? (
          expanded ? (
            <FolderOpen size={14} />
          ) : (
            <Folder size={14} />
          )
        ) : row.kind === "status" ? (
          row.tone === "loading" ? (
            <LoaderCircle size={14} className="spin" />
          ) : row.tone === "error" ? (
            <CircleAlert size={14} />
          ) : null
        ) : null}
      </span>
      <span className="sample-item-name" id={`${id}-name`}>
        <Highlighted text={name} words={row.kind === "file" || row.kind === "folder" ? words : []} />
      </span>
      {count !== null && (
        <span className="sample-item-count num" id={`${id}-count`}>
          <span aria-hidden>{count}</span>
          <span className="visually-hidden">{`${count} ${count === 1 ? "sample" : "samples"}`}</span>
        </span>
      )}
      {row.kind === "file" && (
        <span className="sample-item-format" id={`${id}-format`}>
          {formatOf(row.path)}
        </span>
      )}
      {sample && (
        // The pointer's shortcut; the keyboard's is Enter, and the selection's Audition button.
        <span
          className="sample-item-action"
          aria-hidden
          title={!canAudition ? "Start audio to audition" : playing ? "Stop" : `Audition ${name}`}
          data-disabled={!canAudition || undefined}
          onClick={(event) => {
            event.stopPropagation();
            if (canAudition) onToggleAudition(sample);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {playing ? <Square size={12} /> : <Play size={12} />}
        </span>
      )}
      {row.kind === "root" && (
        // The pointer's shortcut; the keyboard's is the selected folder's Remove button.
        <span
          className="sample-item-action"
          aria-hidden
          title={`Remove ${row.folder.label} from the sample browser`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(row.folder);
          }}
        >
          <X size={12} />
        </span>
      )}
    </div>
  );
}

/** The text with the search's words marked. */
function Highlighted({ text, words }: { text: string; words: readonly string[] }) {
  const ranges = matchRanges(text, words);
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function rowName(row: Row): string {
  switch (row.kind) {
    case "root":
      return row.folder.label;
    case "folder":
      return row.node.name;
    case "file":
      return baseName(row.path);
    case "more":
      return `Show ${Math.min(row.hidden, SHOWN_FILES)} more of ${row.hidden}`;
    case "status":
      return row.text;
  }
}

/** The tree's lines, in order: each added folder, and inside the open ones their folders and files. */
export function treeRows(
  folders: readonly SampleFolder[],
  listings: ReadonlyMap<string, Listing>,
  trees: ReadonlyMap<string, SampleTreeFolder>,
  words: readonly string[],
  toggled: ReadonlySet<string>,
  limits: ReadonlyMap<string, number>,
): Row[] {
  const searching = words.length > 0;
  const rows: Row[] = [];
  const roots = folders.flatMap((folder) => {
    const tree = trees.get(folder.id);
    const shown = tree ? filterSampleTree(tree, words) : null;
    // While searching, a folder with nothing matching is left out.
    return searching && !shown ? [] : [{ folder, listing: listings.get(folder.id), tree, shown }];
  });

  const children = (folder: SampleFolder, node: SampleTreeFolder, parent: string, level: number) => {
    const entries = [
      ...node.folders.map((child) => ({ kind: "folder" as const, child })),
      ...node.files.map((path) => ({ kind: "file" as const, path })),
    ];
    const limit = limits.get(parent) ?? SHOWN_FILES;
    const hidden = Math.max(0, entries.length - limit);
    const setSize = Math.min(entries.length, limit) + (hidden > 0 ? 1 : 0);
    entries.slice(0, limit).forEach((entry, index) => {
      const place = { folder, level, setSize, posInSet: index + 1 };
      if (entry.kind === "file") {
        rows.push({ ...place, key: fileKey(folder, entry.path), kind: "file", path: entry.path });
        return;
      }
      const key = folderKey(folder, entry.child.path);
      const expanded = searching || toggled.has(key);
      rows.push({ ...place, key, kind: "folder", node: entry.child, expanded });
      if (expanded) children(folder, entry.child, key, level + 1);
    });
    if (hidden > 0) {
      rows.push({ folder, level, setSize, posInSet: setSize, key: `m\n${parent}`, kind: "more", parent, hidden });
    }
  };

  roots.forEach(({ folder, listing, tree, shown }, index) => {
    const key = rootKey(folder);
    const expanded = searching || !toggled.has(key);
    const place = { folder, level: 1, setSize: roots.length, posInSet: index + 1 };
    rows.push({ ...place, key, kind: "root", listing, count: shown?.count ?? tree?.count ?? null, expanded });
    if (!expanded) return;
    const status = (text: string, tone: "loading" | "error" | "empty") =>
      rows.push({ folder, level: 2, setSize: 1, posInSet: 1, key: `s\n${folder.id}`, kind: "status", text, tone });
    if (!listing) status(`Reading ${folder.label}…`, "loading");
    else if ("error" in listing) {
      status(`${folder.label} couldn't be read: ${listing.error}. Select it to read it again.`, "error");
    }
    else if (shown && shown.count > 0) children(folder, shown, key, 2);
    else status("No audio files.", "empty");
  });
  return rows;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
