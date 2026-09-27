import type { ClipWaveform } from "@engine";
import { Download, Maximize2, Merge, Play, Scissors, Split, Square, Undo2, WandSparkles, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { encodingOf, ExportFormatFields, KIND_LABELS, useExportFormat } from "../export/ExportFormatFields";
import { ExportButton, ExportMessages, useExportRun } from "../export/ExportRun";
import type { MixExporter } from "../export/mix-exporter";
import type { Command } from "../project/commands";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import type { AudioClip } from "../project/model";
import { formatPosition, type TempoMap, tickAfter } from "../project/time";
import type { ReferencePlayer } from "../reference/reference-player";
import {
  cutAt,
  cutRange,
  equalCuts,
  formatSeconds,
  gridCuts,
  gridLines,
  type GridUnit,
  MIN_SLICE_SECONDS,
  moveCut,
  removeCut,
  rulerStep,
  type Slice,
  sliceAt,
  sliceClip,
  sliceEnd,
  sliceExportRequest,
  sliceNames,
  slicesAt,
  snapTo,
  splitCommands,
  wholeClip,
} from "./audio-editor";
import { clipFileName } from "../export/mix-exporter";
import { clipWaveform, clipWav } from "./slice-audio";

/** Plays a Slice on its own, past the mixer: the platform's Audition. */
export type SliceAuditioner = Pick<ReferencePlayer, "audition" | "stopAudition">;

export interface AudioEditorProps {
  clip: AudioClip;
  trackId: string;
  trackName: string;
  /** The Project's loaded audio, the Clip's file among it once it has arrived. */
  samples: LoadedSamples;
  tempoMap: TempoMap;
  /** Null where this platform can't export. */
  exporter: MixExporter | null;
  /** Null where this platform can't audition. */
  auditioner: SliceAuditioner | null;
  /** Apply the split, as one undo step. */
  onCommands: (commands: Command[], label: string) => void;
  /** While the Assistant has the Project, it can't be split. */
  disabled?: boolean;
}

/** The sample browser's preview level (`AUDITION_GAIN` in `engine/src/audition.rs`), so a Slice sounds as a sample does. */
const AUDITION_GAIN = 0.5;
/** The width drawn at before the view has been measured, as in a test. */
const FALLBACK_WIDTH = 800;
/** The widest the content gets, in pixels, well inside what a browser lays out. */
const MAX_CONTENT_PX = 8_000_000;
/** At the closest zoom, one sample is this many pixels wide. */
const MAX_PX_PER_SAMPLE = 16;
/** Each zoom step doubles or halves. */
const ZOOM_STEP = 2;
/** How far a cut reaches for a zero crossing: a 50 Hz cycle, so there nearly always is one. */
const ZERO_REACH = 0.01;
/** After the grid has placed a cut, a zero crossing only moves it this much, too little to hear off the beat. */
const ZERO_REACH_ON_GRID = 0.002;
/** A sound starting this near the Clip's start or end is the Clip's own edge, not a Slice of its own. */
const TRANSIENT_EDGE = 0.03;
/** An arrow key moves the cursor, or a cut, this many pixels; with Shift, ten times as far. */
const NUDGE_PX = 4;
/** How many cuts are kept to undo. */
const UNDO_DEPTH = 100;

type AutoSlice = "transients" | GridUnit | "equal";

const AUTO_LABELS: Record<AutoSlice, string> = {
  transients: "Transients",
  beat: "Every beat",
  bar: "Every bar",
  equal: "Equal parts",
};

/**
 * One Clip's Slices, with the file offset they were cut at: a Clip trimmed
 * on the Timeline since keeps its cuts where they are in the audio.
 */
interface Cutting {
  fileOffset: number;
  slices: Slice[];
  undo: Slice[][];
}

/** `cutting`'s Slices on `clip` as it is now: those it no longer plays are gone. */
function refit(cutting: Cutting | undefined, clip: AudioClip): Slice[] {
  if (!cutting) return wholeClip();
  const shift = cutting.fileOffset - clip.fileOffset;
  const [first, ...rest] = cutting.slices;
  const moved = rest
    .map((slice) => ({ ...slice, start: slice.start + shift }))
    .filter((slice) => slice.start >= MIN_SLICE_SECONDS && slice.start <= clip.duration - MIN_SLICE_SECONDS);
  return [{ ...first!, start: 0 }, ...moved];
}

interface Playing {
  clipId: string;
  index: number;
  from: number;
  to: number;
  startedAt: number;
}

/**
 * The Audio Editor: an Audio Clip's waveform, to cut into Slices, audition,
 * export as files, or split into Clips of their own. The cuts are the
 * editor's, one set for each Clip, and never the Project's.
 */
export function AudioEditor({ clip, trackId, trackName, samples, tempoMap, exporter, auditioner, onCommands, disabled = false }: AudioEditorProps) {
  const sample = samples.get(clip.file);
  const duration = clip.duration;

  // The waveform, decoded when the Clip's audio or the stretch it plays changes.
  const [decoded, setDecoded] = useState<{
    sample: LoadedSample;
    fileOffset: number;
    duration: number;
    waveform?: ClipWaveform;
    error?: string;
  } | null>(null);
  const { fileOffset } = clip;
  useEffect(() => {
    if (!sample) return;
    let live = true;
    let made: ClipWaveform | null = null;
    const at = { sample, fileOffset, duration };
    clipWaveform(sample, fileOffset, duration).then(
      (waveform) => {
        if (!live) return waveform.free();
        made = waveform;
        setDecoded({ ...at, waveform });
      },
      (reason: unknown) => live && setDecoded({ ...at, error: String(reason) }),
    );
    return () => {
      live = false;
      made?.free();
    };
  }, [sample, fileOffset, duration]);
  const current = decoded && decoded.sample === sample && decoded.fileOffset === clip.fileOffset && decoded.duration === duration;
  const waveform = current ? (decoded.waveform ?? null) : null;
  const decodeError = current ? decoded.error : undefined;
  const rate = waveform?.sample_rate() ?? 48_000;

  // The cuts, kept for each Clip the editor has shown.
  const [cuttings, setCuttings] = useState<ReadonlyMap<string, Cutting>>(new Map());
  const cutting = cuttings.get(clip.id);
  const slices = useMemo(() => refit(cutting, clip), [cutting, clip]);
  const names = sliceNames(clip, slices);
  const setSlices = (next: Slice[], { record = true } = {}) =>
    setCuttings((map) => {
      const before = map.get(clip.id);
      const undo = record ? [...(before?.undo ?? []), slices].slice(-UNDO_DEPTH) : (before?.undo ?? []);
      return new Map(map).set(clip.id, { fileOffset: clip.fileOffset, slices: next, undo });
    });
  const undoSlicing = () =>
    setCuttings((map) => {
      const before = map.get(clip.id);
      const previous = before?.undo.at(-1);
      if (!before || !previous) return map;
      return new Map(map).set(clip.id, { ...before, slices: previous, undo: before.undo.slice(0, -1) });
    });
  const canUndo = (cutting?.undo.length ?? 0) > 0;

  const [selected, setSelected] = useState(0);
  const selectedIndex = Math.min(selected, slices.length - 1);
  const [cursor, setCursor] = useState(0);
  const cursorAt = Math.min(cursor, duration);
  const [announcement, setAnnouncement] = useState("");

  const [grid, setGrid] = useState<GridUnit | "off">("off");
  const [zeroCrossings, setZeroCrossings] = useState(true);
  const [auto, setAuto] = useState<AutoSlice>("transients");
  const [sensitivity, setSensitivity] = useState(0.5);
  const [parts, setParts] = useState(8);
  const lines = useMemo(() => (grid === "off" ? [] : gridLines(clip, tempoMap, grid)), [clip, tempoMap, grid]);

  /** Where a cut or the cursor lands for `at`: on the grid, then at the nearest zero crossing. Alt (`free`) places it exactly. */
  const snap = (at: number, free = false) => {
    let to = Math.min(duration, Math.max(0, at));
    if (free) return to;
    if (lines.length > 0) to = snapTo(to, [...lines, duration]);
    if (zeroCrossings && waveform) to = waveform.zero_crossing(to, lines.length > 0 ? ZERO_REACH_ON_GRID : ZERO_REACH);
    return to;
  };

  // The view: how wide it is, how far it's scrolled and how close it's zoomed.
  const viewRef = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const measure = () => setViewWidth(view.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(view);
    return () => observer.disconnect();
  }, []);
  const width = viewWidth || FALLBACK_WIDTH;
  const fitPps = width / Math.max(duration, 1e-3);
  const maxPps = Math.max(fitPps, Math.min(rate * MAX_PX_PER_SAMPLE, MAX_CONTENT_PX / Math.max(duration, 1e-3)));
  const pps = Math.min(maxPps, Math.max(fitPps, zoom ?? fitPps));
  const contentWidth = Math.max(width, duration * pps);
  const scroll = Math.min(scrollLeft, Math.max(0, contentWidth - width));
  const from = scroll / pps;
  const to = Math.min(duration, (scroll + width) / pps);
  const x = (seconds: number) => seconds * pps;

  // A zoom keeps `anchor` seconds under the same pixel of the view.
  const [pendingScroll, setPendingScroll] = useState<number | null>(null);
  const zoomTo = (next: number | null, anchor = cursorAt) => {
    const nextPps = Math.min(maxPps, Math.max(fitPps, next ?? fitPps));
    const onScreen = anchor >= from && anchor <= to ? x(anchor) - scroll : width / 2;
    setPendingScroll(Math.max(0, anchor * nextPps - onScreen));
    setZoom(next === null || nextPps <= fitPps ? null : nextPps);
  };
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (pendingScroll === null || !view) return;
    view.scrollLeft = pendingScroll;
    setScrollLeft(pendingScroll);
    setPendingScroll(null);
  }, [pendingScroll]);
  // Ctrl (or ⌘) and the wheel zooms about the pointer; the page mustn't zoom instead.
  // Added again each render, so it zooms from where the view is now.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomTo(pps * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), timeAt(event.clientX));
    };
    view.addEventListener("wheel", onWheel, { passive: false });
    return () => view.removeEventListener("wheel", onWheel);
  });
  const onScroll = () => {
    const view = viewRef.current;
    if (view) setScrollLeft(view.scrollLeft);
  };
  /** Scroll so `seconds` is in view. */
  const reveal = (seconds: number) => {
    const view = viewRef.current;
    const at = x(seconds);
    if (!view || (at >= scroll && at <= scroll + width)) return;
    const left = Math.max(0, at - width / 2);
    view.scrollLeft = left;
    setScrollLeft(left);
  };

  function timeAt(clientX: number): number {
    const box = viewRef.current?.getBoundingClientRect();
    return Math.min(duration, Math.max(0, (clientX - (box?.left ?? 0) + scroll) / pps));
  }

  // What is drawn: one column per pixel, or once samples are wider than two pixels, each sample.
  const lanes = waveform?.stereo() ? 2 : 1;
  const drawn = useMemo(() => {
    if (!waveform || to <= from) return null;
    const columns = Math.max(1, Math.round((to - from) * pps));
    const frames = (to - from) * rate;
    if (frames * 2 < columns) {
      const first = Math.floor(from * rate);
      const count = Math.min(waveform.frames() - first, Math.ceil(frames) + 2);
      if (count <= 0) return null;
      // A quarter frame in, so each point lands squarely on its frame.
      const values = waveform.peaks((first + 0.25) / rate, (first + 0.25 + count) / rate, count);
      return { kind: "samples" as const, first, count, values };
    }
    return { kind: "peaks" as const, columns, values: waveform.peaks(from, to, columns) };
  }, [waveform, from, to, pps, rate]);

  const paths = useMemo(() => {
    if (!drawn) return [];
    return Array.from({ length: lanes }, (_lane, lane) => {
      const centre = lane * 2 + 1;
      const y = (value: number) => (centre - value * 0.95).toFixed(4);
      if (drawn.kind === "samples") {
        const points = Array.from({ length: drawn.count }, (_, i) => {
          const px = ((drawn.first + i) / rate) * pps - scroll;
          return `${px.toFixed(2)},${y(drawn.values[i * 4 + lane * 2 + 1]!)}`;
        });
        return { kind: "line" as const, d: `M${points.join("L")}` };
      }
      const upper: string[] = [];
      const lower: string[] = [];
      for (let i = 0; i < drawn.columns; i++) {
        const lo = drawn.values[i * 4 + lane * 2]!;
        const hi = drawn.values[i * 4 + lane * 2 + 1]!;
        // Silence still shows as a hairline.
        const pad = Math.max(0, 0.01 - (hi - lo)) / 2;
        upper.push(`${i + 0.5},${y(hi + pad)}`);
        lower.push(`${i + 0.5},${y(lo - pad)}`);
      }
      return { kind: "fill" as const, d: `M${upper.join("L")}L${lower.toReversed().join("L")}Z` };
    });
  }, [drawn, lanes, rate, scroll, pps]);

  // Auditioning a Slice: its audio rendered and played on its own.
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [playTime, setPlayTime] = useState(0);
  const [auditionError, setAuditionError] = useState<string | null>(null);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const elapsed = (performance.now() - playing.startedAt) / 1000;
      if (elapsed >= playing.to - playing.from) return setPlaying(null);
      setPlayTime(playing.from + elapsed);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const stopAudition = () => {
    setPlaying(null);
    void auditioner?.stopAudition().catch(() => {});
  };
  // Opening another Clip stops what the last one was playing, and so does closing the editor.
  if (playing && playing.clipId !== clip.id) {
    setPlaying(null);
    void auditioner?.stopAudition().catch(() => {});
  }
  const playingRef = useRef(playing);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(
    () => () => {
      if (playingRef.current) void auditioner?.stopAudition().catch(() => {});
    },
    [auditioner],
  );
  const audition = async (index: number) => {
    if (!auditioner || !sample) return;
    if (playing?.index === index) return stopAudition();
    setAuditionError(null);
    try {
      const wav = await clipWav(sliceClip(clip, slices, index), sample);
      await auditioner.audition(wav, AUDITION_GAIN);
      const at = { clipId: clip.id, index, from: slices[index]!.start, to: sliceEnd(slices, index, duration) };
      setPlayTime(at.from);
      setPlaying({ ...at, startedAt: performance.now() });
    } catch (reason) {
      setPlaying(null);
      setAuditionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // Cutting.
  const cutAtCursor = () => {
    const next = cutAt(slices, cursorAt, duration);
    if (!next) {
      setAnnouncement(`No cut at ${formatSeconds(cursorAt)}: a Slice can't be shorter than ${MIN_SLICE_SECONDS * 1000} ms`);
      return;
    }
    setSlices(next);
    setSelected(sliceAt(next, cursorAt));
    setAnnouncement(`Cut at ${formatSeconds(cursorAt)}. ${next.length} Slices`);
  };
  const joinSelected = () => {
    if (selectedIndex < 1) return;
    const next = removeCut(slices, selectedIndex);
    setSlices(next);
    setSelected(selectedIndex - 1);
    setAnnouncement(`Joined. ${next.length} ${next.length === 1 ? "Slice" : "Slices"}`);
  };
  const autoSlice = () => {
    if (auto !== "transients" || waveform) {
      const cuts =
        auto === "transients"
          ? [...waveform!.transients(sensitivity)].filter((at) => at >= TRANSIENT_EDGE && at <= duration - TRANSIENT_EDGE).map((at) => snap(at))
          : auto === "equal"
            ? equalCuts(duration, parts)
            : gridCuts(clip, tempoMap, auto).map((at) => (zeroCrossings && waveform ? waveform.zero_crossing(at, ZERO_REACH_ON_GRID) : at));
      const next = slicesAt(cuts, duration);
      setSlices(next);
      setSelected(0);
      setAnnouncement(`${next.length} ${next.length === 1 ? "Slice" : "Slices"}`);
    }
  };
  const clearCuts = () => {
    setSlices(wholeClip());
    setSelected(0);
    setAnnouncement("Cuts cleared");
  };
  const updateSlice = (index: number, change: Partial<Slice>) =>
    setSlices(
      slices.map((slice, i) => (i === index ? { ...slice, ...change } : slice)),
      { record: change.included !== undefined },
    );

  // The cursor and the Slice it's in.
  const place = (at: number) => {
    setCursor(at);
    setSelected(sliceAt(slices, at));
  };
  const selectSlice = (index: number) => {
    setSelected(index);
    setCursor(slices[index]!.start);
    reveal(slices[index]!.start);
  };

  const nudge = (event: React.KeyboardEvent, start: number, direction: 1 | -1) => {
    if (lines.length > 0 && !event.altKey) {
      const all = [...lines, duration];
      const next = direction > 0 ? all.find((line) => line > start + 1e-9) : all.findLast((line) => line < start - 1e-9);
      return next ?? (direction > 0 ? duration : 0);
    }
    return start + (direction * NUDGE_PX * (event.shiftKey ? 10 : 1)) / pps;
  };

  const onViewKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey) return;
    const handled = () => {
      event.preventDefault();
      // Not a note on the computer keyboard, nor the transport's.
      event.stopPropagation();
    };
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const at = Math.min(duration, Math.max(0, nudge(event, cursorAt, event.key === "ArrowRight" ? 1 : -1)));
        place(at);
        reveal(at);
        return handled();
      }
      case "Home":
        place(0);
        reveal(0);
        return handled();
      case "End":
        place(duration);
        reveal(duration);
        return handled();
      case "s":
      case "S":
        cutAtCursor();
        return handled();
      case " ":
        void audition(selectedIndex);
        return handled();
      case "[":
        selectSlice(Math.max(0, selectedIndex - 1));
        return handled();
      case "]":
        selectSlice(Math.min(slices.length - 1, selectedIndex + 1));
        return handled();
      case "Delete":
      case "Backspace":
        joinSelected();
        return handled();
      case "+":
      case "=":
        zoomTo(pps * ZOOM_STEP);
        return handled();
      case "-":
        zoomTo(pps / ZOOM_STEP);
        return handled();
      case "0":
        zoomTo(null);
        return handled();
    }
  };

  // Pressing the waveform places the cursor, and dragging scrubs it; a double-click cuts there.
  const scrubbing = useRef(false);
  const onViewDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // The scrollbar is the view's own.
    const box = event.currentTarget.getBoundingClientRect();
    if (box.height > 0 && event.clientY > box.top + event.currentTarget.clientHeight) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrubbing.current = true;
    place(snap(timeAt(event.clientX), event.altKey));
  };
  const onViewMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (scrubbing.current) setCursor(snap(timeAt(event.clientX), event.altKey));
  };
  const onViewUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    place(snap(timeAt(event.clientX), event.altKey));
  };
  const onViewDoubleClick = (event: React.MouseEvent) => {
    const at = snap(timeAt(event.clientX), event.altKey);
    const next = cutAt(slices, at, duration);
    if (!next) return;
    setSlices(next);
    setCursor(at);
    setSelected(sliceAt(next, at));
    setAnnouncement(`Cut at ${formatSeconds(at)}. ${next.length} Slices`);
  };

  // Dragging a cut.
  const dragging = useRef<number | null>(null);
  const onCutDown = (event: React.PointerEvent, index: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as HTMLElement).focus();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    dragging.current = index;
    // One undo step for the whole drag.
    setSlices(slices);
    setSelected(index);
  };
  const onCutMove = (event: React.PointerEvent, index: number) => {
    if (dragging.current !== index) return;
    setSlices(moveCut(slices, index, snap(timeAt(event.clientX), event.altKey), duration), { record: false });
  };
  const onCutUp = (event: React.PointerEvent, index: number) => {
    if (dragging.current !== index) return;
    dragging.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    setAnnouncement(`Cut ${index} at ${formatSeconds(slices[index]!.start)}`);
  };
  const onCutKey = (event: React.KeyboardEvent, index: number) => {
    const { min, max } = cutRange(slices, index, duration);
    const at = slices[index]!.start;
    const moveTo = (target: number) => {
      setSlices(moveCut(slices, index, target, duration));
      reveal(Math.min(max, Math.max(min, target)));
    };
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        moveTo(nudge(event, at, -1));
        break;
      case "ArrowRight":
      case "ArrowUp":
        moveTo(nudge(event, at, 1));
        break;
      case "Home":
        moveTo(min);
        break;
      case "End":
        moveTo(max);
        break;
      case "Delete":
      case "Backspace":
        setSlices(removeCut(slices, index));
        setSelected(index - 1);
        setAnnouncement(`Cut removed. ${slices.length - 1} ${slices.length === 2 ? "Slice" : "Slices"}`);
        viewRef.current?.focus();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Exporting and splitting.
  const [format, setFormat] = useExportFormat();
  const run = useExportRun();
  const exporting = run.status.state === "exporting";
  const included = slices.flatMap((slice, index) => (slice.included ? [index] : []));
  const exportFormat = { sampleRate: format.sampleRate, encoding: encodingOf(format) };
  const requestFor = (index: number) => {
    const request = sliceExportRequest(clip, slices, index, samples, exportFormat);
    if (!request) throw new Error(`${clipFileName(clip)}'s audio file isn't loaded`);
    return request;
  };
  const exportSlices = () => {
    if (!exporter) return;
    const chosen = [...included];
    void run.start(
      async () => {
        const folder = await exporter.chooseFolder();
        return folder && { ...folder, label: `${folder.label} (${chosen.length} ${chosen.length === 1 ? "file" : "files"})` };
      },
      async (folder, options) => {
        for (const [done, index] of chosen.entries()) {
          const target = await exporter.fileIn(folder, names[index]!, format.kind);
          const written = await exporter.exportClip(target, requestFor(index), {
            signal: options.signal,
            onProgress: (fraction) => options.onProgress((done + fraction) / chosen.length),
          });
          if (!written) return false;
        }
        return true;
      },
    );
  };
  const exportSlice = (index: number) => {
    if (!exporter) return;
    void run.start(
      () => exporter.chooseFile(names[index]!, format.kind, "clip"),
      (target, options) => exporter.exportClip(target, requestFor(index), options),
    );
  };
  const splitsSomething = slices.length > 1 || !slices[0]!.included;
  const split = () => {
    const { commands, kept } = splitCommands(trackId, clip, slices, tempoMap);
    onCommands(commands, kept.length === 0 ? "Delete Clip" : `Split Clip into ${kept.length}`);
    setAnnouncement(kept.length === 0 ? "Clip deleted" : `Split into ${kept.length} ${kept.length === 1 ? "Clip" : "Clips"}`);
  };

  const status = !sample
    ? "This Clip's audio file isn't loaded yet."
    : decodeError
      ? `The waveform can't be drawn: ${decodeError}`
      : !waveform
        ? "Drawing the waveform…"
        : null;
  const songPosition = formatPosition(tickAfter(tempoMap, clip.start, cursorAt), tempoMap);
  const clipName = clipFileName(clip);
  const rulerEvery = rulerStep(pps);
  const rulerTicks: number[] = [];
  for (let at = Math.floor(from / rulerEvery) * rulerEvery; at <= to + 1e-9; at += rulerEvery) rulerTicks.push(at);
  const visibleLines = lines.filter((line) => line >= from && line <= to);
  const helpId = `audio-editor-help-${clip.id}`;

  return (
    <section aria-label="Audio Editor" className="panel audio-editor">
      <div className="panel-head">
        <h2 className="kind-stripe" data-track-kind="audio">
          <Scissors size={18} aria-hidden />
          Audio Editor: {trackName}
          <span className="hint audio-editor-clip">{clipName}</span>
        </h2>
        <div className="toolbar-group" role="group" aria-label="Zoom">
          <button type="button" className="btn-sm btn-icon" aria-label="Zoom out" title="Zoom out (−)" disabled={pps <= fitPps} onClick={() => zoomTo(pps / ZOOM_STEP)}>
            <ZoomOut size={16} aria-hidden />
          </button>
          <button type="button" className="btn-sm btn-icon" aria-label="Zoom in" title="Zoom in (+)" disabled={pps >= maxPps} onClick={() => zoomTo(pps * ZOOM_STEP)}>
            <ZoomIn size={16} aria-hidden />
          </button>
          <button type="button" className="btn-sm btn-icon" aria-label="Zoom to fit" title="Zoom to fit (0)" disabled={zoom === null} onClick={() => zoomTo(null)}>
            <Maximize2 size={16} aria-hidden />
          </button>
        </div>
        <label className="field-inline">
          Snap
          <select value={grid} onChange={(event) => setGrid(event.target.value as GridUnit | "off")}>
            <option value="off">Off</option>
            <option value="beat">Beats</option>
            <option value="bar">Bars</option>
          </select>
        </label>
        <label className="field-inline" title="Cuts land where the wave crosses zero, so they don't click">
          <input type="checkbox" checked={zeroCrossings} onChange={(event) => setZeroCrossings(event.target.checked)} />
          Zero crossings
        </label>
      </div>

      <div className="toolbar-group audio-editor-tools" role="toolbar" aria-label="Slicing">
        <button type="button" className="btn-sm" aria-keyshortcuts="S" disabled={!sample} onClick={cutAtCursor}>
          <Scissors size={16} aria-hidden />
          Cut at cursor
        </button>
        <button type="button" className="btn-sm" aria-keyshortcuts="Delete" disabled={selectedIndex < 1} onClick={joinSelected}>
          <Merge size={16} aria-hidden />
          Join with previous
        </button>
        <span className="divider" aria-hidden />
        <label className="field-inline">
          Slice at
          <select value={auto} onChange={(event) => setAuto(event.target.value as AutoSlice)}>
            {(Object.keys(AUTO_LABELS) as AutoSlice[]).map((choice) => (
              <option key={choice} value={choice}>
                {AUTO_LABELS[choice]}
              </option>
            ))}
          </select>
        </label>
        {auto === "transients" && (
          <label className="field-inline">
            Sensitivity
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={sensitivity}
              aria-valuetext={`${Math.round(sensitivity * 100)}%`}
              onChange={(event) => setSensitivity(Number(event.target.value))}
            />
            <span className="num">{Math.round(sensitivity * 100)}%</span>
          </label>
        )}
        {auto === "equal" && (
          <label className="field-inline">
            Parts
            <input
              type="number"
              inputMode="numeric"
              min={2}
              max={128}
              value={parts}
              onChange={(event) => setParts(Math.min(128, Math.max(2, Math.round(Number(event.target.value) || 2))))}
            />
          </label>
        )}
        <button type="button" className="btn-sm" disabled={auto === "transients" && !waveform} onClick={autoSlice}>
          <WandSparkles size={16} aria-hidden />
          Auto-slice
        </button>
        <span className="divider" aria-hidden />
        <button type="button" className="btn-sm" disabled={slices.length < 2} onClick={clearCuts}>
          Clear cuts
        </button>
        <button type="button" className="btn-sm btn-icon" aria-label="Undo slicing" title="Undo slicing" disabled={!canUndo} onClick={undoSlicing}>
          <Undo2 size={16} aria-hidden />
        </button>
      </div>

      <p id={helpId} className="visually-hidden">
        Left and Right move the cursor, Shift further; S cuts at the cursor; Space plays the Slice; [ and ] choose the Slice
        before or after; Delete joins the Slice with the one before; plus, minus and 0 zoom. Tab reaches each cut, which the
        arrow keys move and Delete removes. Alt with the mouse ignores the snap.
      </p>
      <div
        ref={viewRef}
        className="audio-editor-view"
        tabIndex={0}
        role="group"
        aria-label={`Waveform of ${clipName}, cursor at ${formatSeconds(cursorAt)}`}
        aria-describedby={helpId}
        aria-keyshortcuts="S Space [ ] Delete + - 0"
        data-lanes={lanes}
        onKeyDown={onViewKey}
        onPointerDown={onViewDown}
        onPointerMove={onViewMove}
        onPointerUp={onViewUp}
        onDoubleClick={onViewDoubleClick}
        onScroll={onScroll}
      >
        <div className="audio-editor-content" style={{ width: contentWidth }}>
          <div className="audio-editor-ruler" aria-hidden>
            {rulerTicks.map((at) => (
              <span key={at.toFixed(6)} className="audio-editor-tick" style={{ left: x(at) }}>
                {formatSeconds(at)}
              </span>
            ))}
          </div>
          {slices.map((slice, index) => {
            const end = sliceEnd(slices, index, duration);
            if (end < from || slice.start > to) return null;
            return (
              <div
                key={index}
                className="audio-editor-slice"
                data-selected={index === selectedIndex || undefined}
                data-excluded={!slice.included || undefined}
                style={{ left: x(slice.start), width: x(end - slice.start) }}
                aria-hidden
              >
                <span className="audio-editor-slice-label">{index + 1}</span>
              </div>
            );
          })}
          {visibleLines.map((line) => (
            <div key={line.toFixed(6)} className="audio-editor-grid-line" style={{ left: x(line) }} aria-hidden />
          ))}
          {paths.length > 0 && (
            <svg
              className="audio-editor-wave"
              style={{ left: scroll, width: Math.max(1, x(to) - scroll) }}
              viewBox={`0 0 ${Math.max(1, x(to) - scroll)} ${lanes * 2}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {Array.from({ length: lanes }, (_, lane) => (
                <line key={lane} className="audio-editor-axis" x1={0} x2={x(to) - scroll} y1={lane * 2 + 1} y2={lane * 2 + 1} vectorEffect="non-scaling-stroke" />
              ))}
              {paths.map((path, lane) =>
                path.kind === "fill" ? <path key={lane} d={path.d} /> : <path key={lane} d={path.d} className="audio-editor-samples" vectorEffect="non-scaling-stroke" />,
              )}
            </svg>
          )}
          {status && <p className="hint audio-editor-status-over">{status}</p>}
          {slices.slice(1).map((slice, i) => {
            const index = i + 1;
            const { min, max } = cutRange(slices, index, duration);
            return (
              <div
                key={index}
                role="slider"
                tabIndex={0}
                className="audio-editor-cut"
                style={{ left: x(slice.start) }}
                aria-label={`Cut ${index}`}
                aria-valuemin={Number(min.toFixed(3))}
                aria-valuemax={Number(max.toFixed(3))}
                aria-valuenow={Number(slice.start.toFixed(3))}
                aria-valuetext={formatSeconds(slice.start)}
                aria-keyshortcuts="Delete"
                onPointerDown={(event) => onCutDown(event, index)}
                onPointerMove={(event) => onCutMove(event, index)}
                onPointerUp={(event) => onCutUp(event, index)}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => onCutKey(event, index)}
                onFocus={() => setSelected(index)}
              />
            );
          })}
          <div className="audio-editor-cursor" style={{ left: x(cursorAt) }} aria-hidden />
          {playing && <div className="audio-editor-playhead" style={{ left: x(playTime) }} aria-hidden />}
        </div>
      </div>

      <p className="audio-editor-readout hint">
        <span>
          Cursor <span className="num">{formatSeconds(cursorAt)}</span> (bar <span className="num">{songPosition}</span>)
        </span>
        <span>
          Slice <span className="num">{selectedIndex + 1}</span> of <span className="num">{slices.length}</span>,{" "}
          <span className="num">{formatSeconds(sliceEnd(slices, selectedIndex, duration) - slices[selectedIndex]!.start)}</span> long
        </span>
        <span>
          <span className="num">{formatSeconds(duration)}</span> in all
        </span>
      </p>
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {auditionError && (
        <p role="alert" className="alert">
          {auditionError}
        </p>
      )}

      <div className="table-scroll audio-editor-slices">
        <table>
          <caption className="visually-hidden">Slices of {clipName}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Audition</span>
              </th>
              <th scope="col">#</th>
              <th scope="col">Name</th>
              <th scope="col">Start</th>
              <th scope="col">Length</th>
              <th scope="col">Include</th>
              <th scope="col">
                <span className="visually-hidden">Export</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {slices.map((slice, index) => {
              const length = sliceEnd(slices, index, duration) - slice.start;
              const isPlaying = playing?.index === index;
              return (
                <tr key={index} aria-selected={index === selectedIndex} data-excluded={!slice.included || undefined} onClick={() => selectSlice(index)}>
                  <td>
                    <button
                      type="button"
                      className="btn-sm btn-icon"
                      aria-label={isPlaying ? `Stop ${names[index]}` : `Play ${names[index]}`}
                      aria-pressed={isPlaying}
                      disabled={!auditioner || !sample}
                      onClick={(event) => {
                        event.stopPropagation();
                        void audition(index);
                      }}
                    >
                      {isPlaying ? <Square size={14} aria-hidden /> : <Play size={14} aria-hidden />}
                    </button>
                  </td>
                  <td className="num">{index + 1}</td>
                  <td>
                    <input
                      aria-label={`Name of Slice ${index + 1}`}
                      // Re-keyed on the name, so undo shows through.
                      key={slice.name}
                      defaultValue={slice.name}
                      placeholder={names[index]}
                      onFocus={() => setSelected(index)}
                      onBlur={(event) => {
                        const name = event.target.value.trim();
                        if (name !== slice.name) updateSlice(index, { name });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </td>
                  <td className="num">{formatSeconds(slice.start)}</td>
                  <td className="num">{formatSeconds(length)}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Include Slice ${index + 1}`}
                      checked={slice.included}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateSlice(index, { included: event.target.checked })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-sm btn-icon"
                      aria-label={`Export ${names[index]}`}
                      title={`Export ${KIND_LABELS[format.kind]}…`}
                      disabled={!exporter || !sample || exporting}
                      onClick={(event) => {
                        event.stopPropagation();
                        exportSlice(index);
                      }}
                    >
                      <Download size={14} aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row row-end">
        {exporter ? (
          <>
            <ExportFormatFields format={format} onChange={setFormat} disabled={exporting} />
            <ExportButton
              run={run}
              label={`Export ${included.length} ${included.length === 1 ? "Slice" : "Slices"}…`}
              onExport={exportSlices}
              emptyHintId={included.length === 0 || !sample ? `audio-editor-empty-${clip.id}` : undefined}
            />
          </>
        ) : (
          <p className="hint">This version of Soundcheck can&apos;t export files.</p>
        )}
        <button
          type="button"
          disabled={disabled || !splitsSomething || exporting}
          title={disabled ? "The Assistant is working on the Project" : "Replace the Clip with its included Slices, each where it plays"}
          onClick={split}
        >
          <Split size={16} aria-hidden />
          {included.length === 0 ? "Delete Clip" : `Split into ${included.length} ${included.length === 1 ? "Clip" : "Clips"}`}
        </button>
      </div>
      {exporter && (included.length === 0 || !sample) && !exporting && (
        <p id={`audio-editor-empty-${clip.id}`} className="hint">
          {sample ? "Tick Include on a Slice to export it." : "This Clip's audio file isn't loaded."}
        </p>
      )}
      <ExportMessages status={run.status} />
    </section>
  );
}
