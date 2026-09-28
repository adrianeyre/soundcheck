import { Disc3, Eject, FolderOpen, Pause, Play, Repeat, Rewind, SkipBack, SkipForward, ZoomIn, ZoomOut } from "lucide-react";
import { useRef, useState } from "react";

import type { DjAnalysis } from "../audio/audio-output";
import {
  BEAT_JUMPS,
  beatsLabel,
  beatsUntil,
  barBeat,
  camelotName,
  compatible,
  endWarning,
  formatBpm,
  formatTempo,
  formatTime,
  HOT_CUE_COLOURS,
  HOT_CUE_NAMES,
  keyName,
  keySyncShift,
  LOOP_BEATS,
  type MusicalKey,
  quantize,
  shiftKey,
  TapTempo,
  TEMPO_RANGES,
  type TempoRangeId,
  tempoRange,
} from "./dj-logic";
import type { DeckReport } from "./dj-report";
import type { DeckState } from "./dj-state";
import { JogWheel } from "./JogWheel";
import { Overview, Zoom } from "./Waveform";

export interface DeckPanelProps {
  deck: number;
  state: DeckState;
  report: DeckReport;
  title: string | null;
  analysis: DjAnalysis | null;
  /** Whether this Deck is the one the others Sync to. */
  syncMaster: boolean;
  /** The Sync Master's key as it plays, when another Deck leads. */
  masterKey: MusicalKey | null;
  canPlay: boolean;
  /** Tell the engine: this Deck's control `name` is now `value`. */
  set: (name: string, value: number) => void;
  onState: (change: Partial<DeckState>) => void;
  onLoadFile: (file: File) => void;
  /** A file from the Track browser, dropped on the Deck. */
  onDropTrack: (trackId: string) => void;
  onEject: () => void;
}

const ZOOMS = [1, 2, 4, 8, 16, 32];
const BEND = 0.04;

/**
 * One CDJ-3000: the track's display (time, BPM, key and tempo, the whole
 * waveform and a close-up with its Beat Grid), the jog wheel, Play and Cue,
 * eight Hot Cues, memory cues, loops, Beat Jump, the tempo fader with its
 * ranges, Master Tempo, Key Shift and Key Sync, Sync, Slip, Reverse, the
 * vinyl brake and spin-back, and tap tempo and grid nudges to fix the Beat
 * Grid. Every button says what it does, and every drag has keys too.
 */
export function DeckPanel(props: DeckPanelProps) {
  const { deck, state, report, title, analysis, syncMaster, masterKey, canPlay, set, onState } = props;
  const file = useRef<HTMLInputElement>(null);
  const tap = useRef(new TapTempo());
  const [deleting, setDeleting] = useState(false);
  const [editingCues, setEditingCues] = useState(false);
  const name = `Deck ${deck + 1}`;
  const loaded = report.loaded && analysis !== null;
  const disabled = !canPlay || !loaded;
  const range = tempoRange(state.range);
  const baseKey = analysis?.key ?? null;
  const playingKey = baseKey && shiftKey(baseKey, report.keyShift);
  const mixes = playingKey && masterKey ? compatible(playingKey, masterKey) : null;
  const beatsTo = (() => {
    const targets = [report.cue, ...state.hotCues.filter((c) => c !== null).map((c) => c.seconds), report.duration]
      .filter((seconds) => seconds > report.position + 0.01)
      .toSorted((a, b) => a - b);
    return targets.length ? beatsUntil(report.position, targets[0]!, report.bpm) : null;
  })();
  const snap = (seconds: number) => (report.quantize ? quantize(seconds, report.bpm, report.firstBeat) : seconds);
  const loopBeats = report.loop && report.bpm > 0 ? ((report.loop.end - report.loop.start) * report.bpm) / 60 : null;
  const toggle = (label: string, pressed: boolean, control: string, extra?: string) => (
    <button type="button" className="dj-toggle" aria-pressed={pressed} disabled={disabled} onClick={() => set(control, pressed ? 0 : 1)}>
      {label}
      {extra && <span className="visually-hidden"> {extra}</span>}
    </button>
  );

  return (
    <section
      className="dj-deck"
      aria-label={name}
      data-playing={report.playing}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/x-soundcheck-dj-track") || event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const trackId = event.dataTransfer.getData("application/x-soundcheck-dj-track");
        if (trackId) props.onDropTrack(trackId);
        else if (event.dataTransfer.files[0]) props.onLoadFile(event.dataTransfer.files[0]);
      }}
    >
      <header className="dj-deck-head">
        <h2>
          <Disc3 size={18} aria-hidden />
          <span className="dj-deck-number">{deck + 1}</span>
          <span className="dj-deck-title">{state.loading ? "Loading…" : (title ?? "No track")}</span>
        </h2>
        <div className="row">
          {syncMaster && <span className="dj-badge" data-kind="master">MASTER</span>}
          {report.sync && <span className="dj-badge" data-kind="sync">SYNC</span>}
          <input
            ref={file}
            type="file"
            hidden
            accept="audio/mpeg,audio/wav,audio/x-wav,audio/flac,.mp3,.wav,.flac"
            aria-label={`Load a file onto ${name}`}
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) props.onLoadFile(chosen);
              event.target.value = "";
            }}
          />
          <button type="button" className="btn-sm" disabled={!canPlay || state.loading} onClick={() => file.current?.click()}>
            <FolderOpen size={14} aria-hidden />
            Load
          </button>
          <button
            type="button"
            className="btn-sm"
            aria-label={`Eject ${name}`}
            disabled={!loaded || report.playing}
            title={report.playing ? "Pause the Deck to eject it" : undefined}
            onClick={props.onEject}
          >
            <Eject size={14} aria-hidden />
          </button>
        </div>
      </header>
      {state.error && (
        <p className="hint" role="alert">
          {state.error}
        </p>
      )}

      <div className="dj-screen" aria-live="off">
        <div className="dj-readouts">
          <div className="dj-readout">
            <span className="dj-readout-label">ELAPSED</span>
            <span className="num dj-time">{formatTime(report.position)}</span>
          </div>
          <div className="dj-readout" data-warn={report.playing && endWarning(report.position, report.duration)}>
            <span className="dj-readout-label">REMAIN</span>
            <span className="num dj-time">−{formatTime(report.duration - report.position)}</span>
          </div>
          <div className="dj-readout">
            <span className="dj-readout-label">BPM</span>
            <span className="num dj-bpm">{formatBpm(report.effectiveBpm)}</span>
            <span className="num hint">{formatBpm(report.bpm)}</span>
          </div>
          <div className="dj-readout">
            <span className="dj-readout-label">TEMPO</span>
            <span className="num">{formatTempo(report.rate - 1)}</span>
            <span className="hint">{report.masterTempo ? "MT" : ""}</span>
          </div>
          <div className="dj-readout" data-compatible={mixes === null ? undefined : mixes}>
            <span className="dj-readout-label">KEY</span>
            <span className="num">{playingKey ? `${keyName(playingKey)} · ${camelotName(playingKey)}` : "—"}</span>
            <span className="hint">
              {report.keyShift !== 0 && `${report.keyShift > 0 ? "+" : ""}${report.keyShift} st`}
              {mixes !== null && (mixes ? " mixes with Master" : " clashes with Master")}
            </span>
          </div>
          <div className="dj-readout">
            <span className="dj-readout-label">BEAT</span>
            <span className="num">{barBeat(report.position, report.bpm, report.firstBeat)}</span>
            <span className="hint num">{beatsTo !== null ? `${beatsTo} to cue` : ""}</span>
          </div>
        </div>
        {analysis ? (
          <>
            <Overview
              deck={deck}
              analysis={analysis}
              position={report.position}
              cue={report.cue}
              hotCues={state.hotCues}
              loop={report.loop}
              onSeek={(seconds) => set("seek", seconds)}
            />
            <div className="dj-zoom-row">
              <Zoom
                deck={deck}
                analysis={analysis}
                position={report.position}
                span={state.zoom}
                bpm={report.bpm}
                firstBeat={report.firstBeat}
                cue={report.cue}
                hotCues={state.hotCues}
                loop={report.loop}
              />
              <div className="dj-zoom-buttons">
                <button
                  type="button"
                  className="btn-sm btn-icon"
                  aria-label={`Zoom ${name}'s waveform in`}
                  disabled={state.zoom === ZOOMS[0]}
                  onClick={() => onState({ zoom: ZOOMS[Math.max(0, ZOOMS.indexOf(state.zoom) - 1)]! })}
                >
                  <ZoomIn size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  className="btn-sm btn-icon"
                  aria-label={`Zoom ${name}'s waveform out`}
                  disabled={state.zoom === ZOOMS.at(-1)}
                  onClick={() => onState({ zoom: ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(state.zoom) + 1)]! })}
                >
                  <ZoomOut size={14} aria-hidden />
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="dj-empty hint">
            {canPlay ? "Load a file, or drop one here or from the Track browser." : "Start audio to load a Deck."}
          </p>
        )}
      </div>

      <div className="dj-deck-body">
        <div className="dj-left">
          <JogWheel
            deck={deck}
            position={report.position}
            cue={report.cue}
            hotCues={state.hotCues}
            vinyl={state.vinyl}
            playing={report.playing}
            onTouch={(touching) => set("touch", touching ? 1 : 0)}
            onScratch={(speed) => set("scratch", speed)}
            onBend={(bend) => set("bend", bend)}
          />
          <div className="row dj-jog-modes">
            <button type="button" className="dj-toggle" aria-pressed={state.vinyl} onClick={() => onState({ vinyl: !state.vinyl })}>
              VINYL
            </button>
            {toggle("REV", report.reverse, "reverse", "Reverse")}
            {toggle("SLIP", report.slip, "slip", "Slip")}
          </div>
          <div className="row">
            <button type="button" className="btn-sm" disabled={disabled || !report.playing} onClick={() => set("brake", state.brakeSeconds)}>
              Brake
            </button>
            <button type="button" className="btn-sm" disabled={disabled || !report.playing} onClick={() => set("spinback", state.brakeSeconds)}>
              <Rewind size={14} aria-hidden />
              Spin back
            </button>
            <label className="field-inline hint">
              <span className="visually-hidden">{name} brake and spin-back time</span>
              <input
                type="range"
                min={0.1}
                max={4}
                step={0.1}
                value={state.brakeSeconds}
                aria-valuetext={`${state.brakeSeconds.toFixed(1)} seconds`}
                onChange={(event) => onState({ brakeSeconds: Number(event.target.value) })}
              />
              <span className="num">{state.brakeSeconds.toFixed(1)} s</span>
            </label>
          </div>
          <div className="row dj-transport">
            <button
              type="button"
              className="dj-cue"
              aria-label={`${name} cue`}
              aria-keyshortcuts={["Q", "I", "A", "J"][deck]}
              data-lit={report.previewing || (!report.playing && Math.abs(report.position - report.cue) < 0.02)}
              disabled={disabled}
              onPointerDown={() => set("cueDown", 1)}
              onPointerUp={() => set("cueUp", 1)}
              onPointerLeave={(event) => {
                if (event.buttons & 1) set("cueUp", 1);
              }}
              onKeyDown={(event) => {
                if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                  event.preventDefault();
                  set("cueDown", 1);
                }
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") set("cueUp", 1);
              }}
            >
              CUE
            </button>
            <button
              type="button"
              className="dj-play"
              aria-label={report.playing ? `Pause ${name}` : `Play ${name}`}
              aria-keyshortcuts={["W", "O", "S", "K"][deck]}
              aria-pressed={report.playing}
              disabled={disabled}
              onClick={() => set("play", report.playing ? 0 : 1)}
            >
              {report.playing ? <Pause size={22} aria-hidden /> : <Play size={22} aria-hidden />}
            </button>
          </div>
        </div>

        <div className="dj-centre">
          <div className="dj-hot-cues" role="group" aria-label={`${name} Hot Cues`}>
            {state.hotCues.map((hot, index) => {
              const letter = HOT_CUE_NAMES[index]!;
              return (
                <button
                  key={letter}
                  type="button"
                  className="dj-hot-cue"
                  style={hot ? { borderColor: hot.colour, color: hot.colour } : undefined}
                  data-set={hot !== null}
                  aria-label={
                    hot
                      ? `${deleting ? "Delete" : "Jump to"} Hot Cue ${letter}, ${hot.label}, at ${formatTime(hot.seconds)}`
                      : `Set Hot Cue ${letter}`
                  }
                  disabled={disabled}
                  onPointerDown={() => {
                    if (!hot || deleting) return;
                    set("jumpHold", hot.seconds);
                  }}
                  onPointerUp={() => {
                    if (hot && !deleting) set("jumpRelease", 1);
                  }}
                  onClick={(event) => {
                    if (hot && deleting) {
                      onState({ hotCues: state.hotCues.map((c, at) => (at === index ? null : c)) });
                    } else if (!hot) {
                      const seconds = snap(report.position);
                      onState({
                        hotCues: state.hotCues.map((c, at) =>
                          at === index ? { seconds, label: letter, colour: HOT_CUE_COLOURS[index]! } : c,
                        ),
                      });
                    } else if (event.detail === 0) {
                      // The keyboard: Enter jumps and returns at once.
                      set("jumpHold", hot.seconds);
                      set("jumpRelease", 1);
                    }
                  }}
                >
                  <span className="dj-hot-cue-letter">{letter}</span>
                  <span className="dj-hot-cue-label">{hot ? hot.label : ""}</span>
                </button>
              );
            })}
          </div>
          <div className="row">
            <button type="button" className="dj-toggle" aria-pressed={deleting} onClick={() => setDeleting(!deleting)}>
              {deleting ? "Deleting: pick a Hot Cue" : "Delete Hot Cue"}
            </button>
            <button type="button" className="btn-sm" aria-expanded={editingCues} onClick={() => setEditingCues(!editingCues)}>
              Name Hot Cues
            </button>
            <button
              type="button"
              className="btn-sm"
              disabled={disabled}
              onClick={() => onState({ memoryCues: [...new Set([...state.memoryCues, report.cue])].toSorted((a, b) => a - b) })}
            >
              Memory
            </button>
            <button
              type="button"
              className="btn-sm btn-icon"
              aria-label={`${name} previous memory cue`}
              disabled={disabled || !state.memoryCues.some((c) => c < report.cue - 0.01)}
              onClick={() => {
                const previous = state.memoryCues.filter((c) => c < report.cue - 0.01).at(-1);
                if (previous !== undefined) {
                  set("seek", previous);
                  set("setCue", previous);
                }
              }}
            >
              <SkipBack size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="btn-sm btn-icon"
              aria-label={`${name} next memory cue`}
              disabled={disabled || !state.memoryCues.some((c) => c > report.cue + 0.01)}
              onClick={() => {
                const next = state.memoryCues.find((c) => c > report.cue + 0.01);
                if (next !== undefined) {
                  set("seek", next);
                  set("setCue", next);
                }
              }}
            >
              <SkipForward size={14} aria-hidden />
            </button>
            <span className="hint num">{state.memoryCues.length} memory</span>
          </div>
          {editingCues && (
            <div className="dj-cue-names">
              {state.hotCues.map(
                (hot, index) =>
                  hot && (
                    <label key={index} className="field-inline">
                      {HOT_CUE_NAMES[index]}
                      <input
                        type="text"
                        value={hot.label}
                        maxLength={24}
                        onChange={(event) =>
                          onState({
                            hotCues: state.hotCues.map((c, at) => (at === index && c ? { ...c, label: event.target.value } : c)),
                          })
                        }
                      />
                    </label>
                  ),
              )}
            </div>
          )}

          <fieldset className="dj-group">
            <legend>Loop {loopBeats !== null && <span className="num">· {beatsLabel(Math.round(loopBeats * 32) / 32)} beats</span>}</legend>
            <div className="row">
              <select
                aria-label={`${name} loop size`}
                value={state.loopBeats}
                onChange={(event) => onState({ loopBeats: Number(event.target.value) })}
              >
                {LOOP_BEATS.map((beats) => (
                  <option key={beats} value={beats}>
                    {beatsLabel(beats)}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-sm" disabled={disabled || report.bpm <= 0} onClick={() => set("autoLoop", state.loopBeats)}>
                <Repeat size={14} aria-hidden />
                Loop
              </button>
              <button type="button" className="btn-sm" disabled={disabled} onClick={() => set("loopIn", report.position)}>
                In
              </button>
              <button type="button" className="btn-sm" disabled={disabled} onClick={() => set("loopOut", report.position)}>
                Out
              </button>
              <button type="button" className="btn-sm" aria-label={`Halve ${name}'s loop`} disabled={!report.loop} onClick={() => set("resizeLoop", 0.5)}>
                ½
              </button>
              <button type="button" className="btn-sm" aria-label={`Double ${name}'s loop`} disabled={!report.loop} onClick={() => set("resizeLoop", 2)}>
                ×2
              </button>
              <button
                type="button"
                className="btn-sm"
                disabled={disabled}
                onClick={() => set(report.loop ? "exitLoop" : "reloop", 1)}
              >
                {report.loop ? "Exit" : "Reloop"}
              </button>
            </div>
          </fieldset>

          <fieldset className="dj-group">
            <legend>Beat Jump</legend>
            <div className="row">
              <button type="button" className="btn-sm" aria-label={`${name} jump back ${state.jumpBeats} beats`} disabled={disabled || report.bpm <= 0} onClick={() => set("beatJump", -state.jumpBeats)}>
                ◀
              </button>
              <select aria-label={`${name} Beat Jump size`} value={state.jumpBeats} onChange={(event) => onState({ jumpBeats: Number(event.target.value) })}>
                {BEAT_JUMPS.map((beats) => (
                  <option key={beats} value={beats}>
                    {beats} {beats === 1 ? "beat" : "beats"}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-sm" aria-label={`${name} jump forward ${state.jumpBeats} beats`} disabled={disabled || report.bpm <= 0} onClick={() => set("beatJump", state.jumpBeats)}>
                ▶
              </button>
              {toggle("Q", report.quantize, "quantize", "Quantize")}
            </div>
          </fieldset>

          <fieldset className="dj-group">
            <legend>Beat Grid</legend>
            <div className="row">
              <button
                type="button"
                className="btn-sm"
                disabled={disabled}
                onClick={() => {
                  const bpm = tap.current.tap(performance.now());
                  if (bpm) set("gridBpm", bpm);
                }}
              >
                Tap
              </button>
              <button type="button" className="btn-sm" disabled={disabled || report.bpm <= 0} onClick={() => set("gridBpm", report.bpm / 2)}>
                ÷2
              </button>
              <button type="button" className="btn-sm" disabled={disabled || report.bpm <= 0} onClick={() => set("gridBpm", report.bpm * 2)}>
                ×2
              </button>
              <button type="button" className="btn-sm" aria-label={`Move ${name}'s grid earlier`} disabled={disabled} onClick={() => set("gridOffset", report.firstBeat - 0.01)}>
                ◀ Grid
              </button>
              <button type="button" className="btn-sm" aria-label={`Move ${name}'s grid later`} disabled={disabled} onClick={() => set("gridOffset", report.firstBeat + 0.01)}>
                Grid ▶
              </button>
              <button type="button" className="btn-sm" disabled={disabled} onClick={() => set("gridOffset", report.position)}>
                Beat 1 here
              </button>
            </div>
          </fieldset>
        </div>

        <div className="dj-right">
          <div className="row">
            <button
              type="button"
              className="dj-toggle dj-sync"
              aria-pressed={report.sync}
              aria-keyshortcuts={["E", "P", "D", "L"][deck]}
              disabled={disabled || report.bpm <= 0}
              onClick={() => set("sync", report.sync ? 0 : 1)}
            >
              BEAT SYNC
            </button>
            <button
              type="button"
              className="dj-toggle"
              aria-pressed={syncMaster}
              disabled={disabled || report.bpm <= 0}
              onClick={() => set("syncMaster", 1)}
            >
              MASTER
            </button>
          </div>
          <div className="row">
            {toggle("MASTER TEMPO", report.masterTempo, "masterTempo", "(key lock)")}
          </div>
          <div className="row dj-key">
            <button type="button" className="btn-sm" aria-label={`${name} key down a semitone`} disabled={disabled} onClick={() => set("keyShift", report.keyShift - 1)}>
              ♭
            </button>
            <span className="num">KEY {report.keyShift > 0 ? "+" : ""}{report.keyShift}</span>
            <button type="button" className="btn-sm" aria-label={`${name} key up a semitone`} disabled={disabled} onClick={() => set("keyShift", report.keyShift + 1)}>
              ♯
            </button>
            <button
              type="button"
              className="btn-sm"
              disabled={disabled || !baseKey || !masterKey}
              onClick={() => baseKey && masterKey && set("keyShift", keySyncShift(baseKey, masterKey))}
            >
              KEY SYNC
            </button>
          </div>
          <div className="dj-tempo">
            <input
              type="range"
              className="dj-tempo-fader"
              aria-label={`${name} tempo`}
              aria-valuetext={formatTempo(report.tempo)}
              min={-range}
              max={range}
              step={range / 1000}
              value={Math.max(-range, Math.min(range, report.tempo))}
              disabled={disabled || report.sync}
              onChange={(event) => set("tempo", Number(event.target.value))}
            />
            <div className="dj-tempo-side">
              <select aria-label={`${name} tempo range`} value={state.range} onChange={(event) => onState({ range: event.target.value as TempoRangeId })}>
                {TEMPO_RANGES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <span className="num">{formatTempo(report.tempo)}</span>
              <button type="button" className="btn-sm" disabled={disabled || report.sync} onClick={() => set("tempo", 0)}>
                Reset
              </button>
              <button
                type="button"
                className="btn-sm"
                aria-label={`${name} bend slower`}
                disabled={disabled}
                onPointerDown={() => set("bend", -BEND)}
                onPointerUp={() => set("bend", 0)}
                onPointerLeave={() => set("bend", 0)}
                onKeyDown={(event) => (event.key === " " || event.key === "Enter") && !event.repeat && set("bend", -BEND)}
                onKeyUp={() => set("bend", 0)}
              >
                −
              </button>
              <button
                type="button"
                className="btn-sm"
                aria-label={`${name} bend faster`}
                disabled={disabled}
                onPointerDown={() => set("bend", BEND)}
                onPointerUp={() => set("bend", 0)}
                onPointerLeave={() => set("bend", 0)}
                onKeyDown={(event) => (event.key === " " || event.key === "Enter") && !event.repeat && set("bend", BEND)}
                onKeyUp={() => set("bend", 0)}
              >
                +
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
