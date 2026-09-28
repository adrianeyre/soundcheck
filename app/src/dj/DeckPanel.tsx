import { useRef, useState } from "react";

import type { DjAnalysis } from "../audio/audio-output";
import { droppedSample, isSampleDrag } from "../samples/sample-drag";
import type { SampleRef } from "../samples/sample-source";
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
  tempoRange,
} from "./dj-logic";
import type { DeckReport } from "./dj-report";
import { DJ_TRACK_DRAG_TYPE, type DeckState } from "./dj-state";
import { JogWheel } from "./JogWheel";
import { Overview } from "./Waveform";


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
  /** A file from the Track browser's loaded list, dropped on the Deck. */
  onDropTrack: (trackId: string) => void;
  /** A file from the folder tree, dropped on the Deck. */
  onDropSample?: (sample: SampleRef) => void;
  onEject: () => void;
  /** Take the DJ to the Track browser, as the player's BROWSE button does. */
  onBrowse?: () => void;
}

const BEND = 0.04;

/** Whether a drag carries something a Deck loads: a file from the system, the folder tree or the loaded list. */
function loadable(transfer: DataTransfer): boolean {
  const types = [...transfer.types];
  return types.includes(DJ_TRACK_DRAG_TYPE) || types.includes("Files") || isSampleDrag(transfer);
}

/**
 * A lit hardware button: a small-caps label, and a light that is off, on
 * or blinking. It is a toggle when `pressed` is given.
 */
function HwButton({
  label,
  caption,
  pressed,
  light,
  disabled,
  onClick,
  tone,
  wide = false,
}: {
  /** Its full name, for assistive technology. */
  label: string;
  /** What is printed on it. */
  caption: React.ReactNode;
  pressed?: boolean;
  light?: "on" | "blink";
  disabled?: boolean;
  onClick: () => void;
  tone?: "amber" | "green" | "red" | "blue";
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      className="dj-hw-button"
      aria-label={label}
      aria-pressed={pressed}
      data-light={light ?? (pressed ? "on" : undefined)}
      data-tone={tone}
      data-wide={wide || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {caption}
    </button>
  );
}

/**
 * One Deck drawn as a club player: the source and browse buttons top left
 * of its screen (the track, its time, BPM, key, tempo and overview), the
 * Beat Grid buttons beside it, eight Hot Cue pads under it, Beat Jump and
 * the loops left of the jog wheel with the big CUE and PLAY/PAUSE buttons
 * under them, and the syncs, keys, Master Tempo and the long tempo fader
 * down the right. Every button says what it does, and every drag has keys
 * too.
 */
export function DeckPanel(props: DeckPanelProps) {
  const { deck, state, report, title, analysis, syncMaster, masterKey, canPlay, set, onState } = props;
  const file = useRef<HTMLInputElement>(null);
  const tap = useRef(new TapTempo());
  const [deleting, setDeleting] = useState(false);
  const [editingCues, setEditingCues] = useState(false);
  const [remainFirst, setRemainFirst] = useState(false);
  // How many of the panel's elements a drag of something loadable is over: dragenter and dragleave come for
  // each child, so the highlight goes only when the drag has left them all.
  const [dragDepth, setDragDepth] = useState(0);
  const name = `Deck ${deck + 1}`;
  const loaded = report.loaded && analysis !== null;
  const disabled = !canPlay || !loaded;
  const range = tempoRange(state.range);
  const rangeIndex = TEMPO_RANGES.findIndex((r) => r.id === state.range);
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
  const loopIndex = LOOP_BEATS.indexOf(state.loopBeats);
  const atCue = Math.abs(report.position - report.cue) < 0.02;
  const cueLight = !loaded ? undefined : report.previewing || (!report.playing && atCue) ? "on" : !report.playing ? "blink" : undefined;
  const playLight = !loaded ? undefined : report.playing ? "on" : "blink";
  const warning = report.playing && endWarning(report.position, report.duration);
  const toggle = (caption: string, pressed: boolean, control: string, label: string, tone?: "amber" | "green" | "red" | "blue") => (
    <HwButton label={`${name} ${label}`} caption={caption} pressed={pressed} disabled={disabled} tone={tone} onClick={() => set(control, pressed ? 0 : 1)} />
  );
  const hold = (bend: number) => ({
    onPointerDown: () => set("bend", bend),
    onPointerUp: () => set("bend", 0),
    onPointerLeave: () => set("bend", 0),
    onKeyDown: (event: React.KeyboardEvent) => {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) set("bend", bend);
    },
    onKeyUp: () => set("bend", 0),
  });

  return (
    <section
      className="dj-deck dj-hw"
      aria-label={name}
      data-deck={deck}
      data-playing={report.playing}
      data-drop={dragDepth > 0 || undefined}
      onDragEnter={(event) => {
        if (loadable(event.dataTransfer)) setDragDepth((depth) => depth + 1);
      }}
      onDragLeave={(event) => {
        if (loadable(event.dataTransfer)) setDragDepth((depth) => Math.max(0, depth - 1));
      }}
      onDragOver={(event) => {
        if (loadable(event.dataTransfer)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragDepth(0);
        if (!canPlay) return;
        const trackId = event.dataTransfer.getData(DJ_TRACK_DRAG_TYPE);
        const sample = droppedSample(event.dataTransfer);
        if (trackId) props.onDropTrack(trackId);
        else if (sample) props.onDropSample?.(sample);
        else if (event.dataTransfer.files[0]) props.onLoadFile(event.dataTransfer.files[0]);
      }}
    >
      {dragDepth > 0 && (
        <div className="dj-drop-veil" aria-hidden>
          {canPlay ? `Drop to load onto ${name}` : "Start audio to load a Deck"}
        </div>
      )}
      <div className="dj-deck-top">
        <div className="dj-hw-column dj-deck-source" role="group" aria-label={`${name} source`}>
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
          <HwButton label={`Load a file from disk onto ${name}`} caption="SOURCE" disabled={!canPlay || state.loading} onClick={() => file.current?.click()} />
          <HwButton label={`Browse files for ${name}`} caption="BROWSE" disabled={!props.onBrowse} onClick={() => props.onBrowse?.()} />
          <HwButton
            label={`${name} time mode, ${remainFirst ? "remaining" : "elapsed"}`}
            caption={remainFirst ? "REMAIN" : "ELAPSED"}
            pressed={remainFirst}
            onClick={() => setRemainFirst(!remainFirst)}
          />
          <HwButton
            label={`Eject ${name}`}
            caption="EJECT"
            disabled={!loaded || report.playing}
            onClick={props.onEject}
          />
        </div>

        <div className="dj-screen">
          <div className="dj-screen-head">
            <span className="dj-deck-number">{deck + 1}</span>
            <h2 className="dj-deck-title">{state.loading ? "Loading…" : (title ?? "No track")}</h2>
            {syncMaster && <span className="dj-badge" data-kind="master">MASTER</span>}
            {report.sync && <span className="dj-badge" data-kind="sync">SYNC</span>}
            {report.masterTempo && <span className="dj-badge" data-kind="mt">MT</span>}
          </div>
          {state.error && (
            <p className="dj-screen-error" role="alert">
              {state.error}
            </p>
          )}
          <div className="dj-readouts">
            <div className="dj-readout" data-main={!remainFirst}>
              <span className="dj-readout-label">ELAPSED</span>
              <span className="num dj-time">{formatTime(report.position)}</span>
            </div>
            <div className="dj-readout" data-main={remainFirst} data-warn={warning}>
              <span className="dj-readout-label">REMAIN</span>
              <span className="num dj-time">−{formatTime(report.duration - report.position)}</span>
            </div>
            <div className="dj-readout">
              <span className="dj-readout-label">BPM</span>
              <span className="num dj-bpm">{formatBpm(report.effectiveBpm)}</span>
              <span className="num dj-readout-sub">{formatBpm(report.bpm)}</span>
            </div>
            <div className="dj-readout">
              <span className="dj-readout-label">TEMPO {TEMPO_RANGES[rangeIndex]?.label}</span>
              <span className="num">{formatTempo(report.rate - 1)}</span>
            </div>
            <div className="dj-readout" data-compatible={mixes === null ? undefined : mixes}>
              <span className="dj-readout-label">KEY</span>
              <span className="num">{playingKey ? `${keyName(playingKey)} · ${camelotName(playingKey)}` : "—"}</span>
              <span className="dj-readout-sub">
                {report.keyShift !== 0 && `${report.keyShift > 0 ? "+" : ""}${report.keyShift} st `}
                {mixes !== null && (mixes ? "mixes with Master" : "clashes with Master")}
              </span>
            </div>
            <div className="dj-readout">
              <span className="dj-readout-label">BEAT</span>
              <span className="num">{barBeat(report.position, report.bpm, report.firstBeat)}</span>
              <span className="num dj-readout-sub">{beatsTo !== null ? `${beatsTo} to cue` : ""}</span>
            </div>
          </div>
          {analysis ? (
            <Overview
              deck={deck}
              analysis={analysis}
              position={report.position}
              cue={report.cue}
              hotCues={state.hotCues}
              loop={report.loop}
              onSeek={(seconds) => set("seek", seconds)}
            />
          ) : (
            <p className="dj-empty">
              {canPlay ? "Load a file: BROWSE, SOURCE, or drop one here." : "Start audio to load a Deck."}
            </p>
          )}
        </div>

        <div className="dj-hw-column dj-deck-grid" role="group" aria-label={`${name} Beat Grid`}>
          <span className="dj-hw-caption">GRID</span>
          <HwButton
            label={`${name} tap tempo`}
            caption="TAP"
            disabled={disabled}
            onClick={() => {
              const bpm = tap.current.tap(performance.now());
              if (bpm) set("gridBpm", bpm);
            }}
          />
          <div className="dj-hw-pair">
            <HwButton label={`Halve ${name}'s BPM`} caption="÷2" disabled={disabled || report.bpm <= 0} onClick={() => set("gridBpm", report.bpm / 2)} />
            <HwButton label={`Double ${name}'s BPM`} caption="×2" disabled={disabled || report.bpm <= 0} onClick={() => set("gridBpm", report.bpm * 2)} />
          </div>
          <div className="dj-hw-pair">
            <HwButton label={`Move ${name}'s grid earlier`} caption="◀" disabled={disabled} onClick={() => set("gridOffset", report.firstBeat - 0.01)} />
            <HwButton label={`Move ${name}'s grid later`} caption="▶" disabled={disabled} onClick={() => set("gridOffset", report.firstBeat + 0.01)} />
          </div>
          <HwButton label={`${name}: beat 1 here`} caption="BEAT 1" disabled={disabled} onClick={() => set("gridOffset", report.position)} />
        </div>
      </div>

      <div className="dj-pads-row">
        <div className="dj-hot-cues" role="group" aria-label={`${name} Hot Cues`}>
          {state.hotCues.map((hot, index) => {
            const letter = HOT_CUE_NAMES[index]!;
            return (
              <button
                key={letter}
                type="button"
                className="dj-hot-cue"
                style={hot ? ({ "--pad": hot.colour } as React.CSSProperties) : undefined}
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
                <span className="dj-hot-cue-label">{hot && hot.label !== letter ? hot.label : ""}</span>
              </button>
            );
          })}
        </div>
        <div className="dj-hw-row" role="group" aria-label={`${name} cue memory`}>
          <HwButton
            label={`${name} previous memory cue`}
            caption="◀ CALL"
            disabled={disabled || !state.memoryCues.some((c) => c < report.cue - 0.01)}
            onClick={() => {
              const previous = state.memoryCues.filter((c) => c < report.cue - 0.01).at(-1);
              if (previous !== undefined) {
                set("seek", previous);
                set("setCue", previous);
              }
            }}
          />
          <HwButton
            label={`${name} store the cue as a memory cue, ${state.memoryCues.length} stored`}
            caption={`MEMORY ${state.memoryCues.length || ""}`}
            disabled={disabled}
            onClick={() => onState({ memoryCues: [...new Set([...state.memoryCues, report.cue])].toSorted((a, b) => a - b) })}
          />
          <HwButton
            label={`${name} next memory cue`}
            caption="CALL ▶"
            disabled={disabled || !state.memoryCues.some((c) => c > report.cue + 0.01)}
            onClick={() => {
              const next = state.memoryCues.find((c) => c > report.cue + 0.01);
              if (next !== undefined) {
                set("seek", next);
                set("setCue", next);
              }
            }}
          />
          <HwButton
            label={deleting ? `${name}: pick a Hot Cue to delete` : `${name} delete a Hot Cue`}
            caption="DELETE"
            pressed={deleting}
            tone="red"
            onClick={() => setDeleting(!deleting)}
          />
          <HwButton label={`Name ${name}'s Hot Cues`} caption="NAME" pressed={editingCues} onClick={() => setEditingCues(!editingCues)} />
        </div>
        {editingCues && (
          <div className="dj-cue-names">
            {state.hotCues.every((hot) => hot === null) && <span className="dj-hw-caption">Set a Hot Cue to name it.</span>}
            {state.hotCues.map(
              (hot, index) =>
                hot && (
                  <label key={index} className="dj-cue-name">
                    <span className="dj-hw-caption">{HOT_CUE_NAMES[index]}</span>
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
      </div>

      <div className="dj-deck-body">
        <div className="dj-hw-column dj-deck-left">
          <div className="dj-hw-section" role="group" aria-label={`${name} Beat Jump`}>
            <span className="dj-hw-caption">BEAT JUMP</span>
            <div className="dj-hw-pair">
              <HwButton
                label={`${name} jump back ${state.jumpBeats} beats`}
                caption="◀◀"
                disabled={disabled || report.bpm <= 0}
                onClick={() => set("beatJump", -state.jumpBeats)}
              />
              <HwButton
                label={`${name} jump forward ${state.jumpBeats} beats`}
                caption="▶▶"
                disabled={disabled || report.bpm <= 0}
                onClick={() => set("beatJump", state.jumpBeats)}
              />
            </div>
            <div className="dj-hw-steps" role="radiogroup" aria-label={`${name} Beat Jump size`}>
              {BEAT_JUMPS.map((beats) => (
                <button
                  key={beats}
                  type="button"
                  role="radio"
                  aria-checked={state.jumpBeats === beats}
                  aria-label={`${beats} ${beats === 1 ? "beat" : "beats"}`}
                  className="dj-hw-step"
                  onClick={() => onState({ jumpBeats: beats })}
                >
                  {beats}
                </button>
              ))}
            </div>
          </div>
          <div className="dj-hw-section" role="group" aria-label={`${name} loop`}>
            <span className="dj-hw-caption">
              LOOP {loopBeats !== null && <span className="num dj-loop-size">{beatsLabel(Math.round(loopBeats * 32) / 32)}</span>}
            </span>
            <div className="dj-hw-pair">
              <HwButton label={`${name} loop in`} caption="IN" light={report.loop ? "on" : undefined} tone="amber" disabled={disabled} onClick={() => set("loopIn", report.position)} />
              <HwButton label={`${name} loop out`} caption="OUT" light={report.loop ? "on" : undefined} tone="amber" disabled={disabled} onClick={() => set("loopOut", report.position)} />
            </div>
            <HwButton
              label={report.loop ? `Exit ${name}'s loop` : `Reloop ${name}`}
              caption="RELOOP/EXIT"
              light={report.loop ? "blink" : undefined}
              tone="amber"
              wide
              disabled={disabled}
              onClick={() => set(report.loop ? "exitLoop" : "reloop", 1)}
            />
            <div className="dj-hw-stepper">
              <HwButton
                label={`Shorter ${name} loop size`}
                caption="◀"
                disabled={loopIndex <= 0}
                onClick={() => onState({ loopBeats: LOOP_BEATS[loopIndex - 1]! })}
              />
              <HwButton
                label={`${name} ${beatsLabel(state.loopBeats)} beat loop`}
                caption={<span className="num">{beatsLabel(state.loopBeats)}</span>}
                tone="amber"
                disabled={disabled || report.bpm <= 0}
                onClick={() => set("autoLoop", state.loopBeats)}
              />
              <HwButton
                label={`Longer ${name} loop size`}
                caption="▶"
                disabled={loopIndex >= LOOP_BEATS.length - 1}
                onClick={() => onState({ loopBeats: LOOP_BEATS[loopIndex + 1]! })}
              />
            </div>
            <div className="dj-hw-pair">
              <HwButton label={`Halve ${name}'s loop`} caption="½X" disabled={!report.loop} onClick={() => set("resizeLoop", 0.5)} />
              <HwButton label={`Double ${name}'s loop`} caption="2X" disabled={!report.loop} onClick={() => set("resizeLoop", 2)} />
            </div>
          </div>
          <div className="dj-transport">
            <button
              type="button"
              className="dj-cue"
              aria-label={`${name} cue`}
              aria-keyshortcuts={["Q", "I", "A", "J"][deck]}
              data-light={cueLight}
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
              data-light={playLight}
              disabled={disabled}
              onClick={() => set("play", report.playing ? 0 : 1)}
            >
              <span aria-hidden>▶/❚❚</span>
            </button>
          </div>
        </div>

        <div className="dj-deck-jog">
          <JogWheel
            deck={deck}
            position={report.position}
            remaining={remainFirst}
            duration={report.duration}
            bpm={report.effectiveBpm}
            cue={report.cue}
            hotCues={state.hotCues}
            vinyl={state.vinyl}
            playing={report.playing}
            onTouch={(touching) => set("touch", touching ? 1 : 0)}
            onScratch={(speed) => set("scratch", speed)}
            onBend={(bend) => set("bend", bend)}
          />
          <div className="dj-hw-row dj-jog-modes">
            <HwButton
              label={`${name} jog mode, ${state.vinyl ? "vinyl: the platter scratches" : "CDJ: the platter bends the pitch"}`}
              caption={state.vinyl ? "VINYL" : "CDJ"}
              pressed={state.vinyl}
              onClick={() => onState({ vinyl: !state.vinyl })}
            />
            {toggle("SLIP", report.slip, "slip", "Slip", "amber")}
            {toggle("Q", report.quantize, "quantize", "Quantize", "red")}
            {toggle("REV", report.reverse, "reverse", "Reverse", "red")}
          </div>
          <div className="dj-hw-row dj-brakes">
            <HwButton label={`${name} vinyl brake`} caption="BRAKE" disabled={disabled || !report.playing} onClick={() => set("brake", state.brakeSeconds)} />
            <HwButton label={`${name} spin back`} caption="SPIN BACK" disabled={disabled || !report.playing} onClick={() => set("spinback", state.brakeSeconds)} />
            <label className="dj-brake-time">
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
              <span className="num dj-hw-caption">{state.brakeSeconds.toFixed(1)} S</span>
            </label>
          </div>
        </div>

        <div className="dj-hw-column dj-deck-right">
          <div className="dj-hw-pair">
            <HwButton
              label={`${name} Beat Sync`}
              caption="BEAT SYNC"
              pressed={report.sync}
              tone="blue"
              disabled={disabled || report.bpm <= 0}
              onClick={() => set("sync", report.sync ? 0 : 1)}
            />
            <HwButton
              label={`Make ${name} the Sync Master`}
              caption="MASTER"
              pressed={syncMaster}
              tone="amber"
              disabled={disabled || report.bpm <= 0}
              onClick={() => set("syncMaster", 1)}
            />
          </div>
          <div className="dj-hw-pair">
            <HwButton
              label={`${name} Key Sync`}
              caption="KEY SYNC"
              tone="green"
              disabled={disabled || !baseKey || !masterKey}
              onClick={() => baseKey && masterKey && set("keyShift", keySyncShift(baseKey, masterKey))}
            />
            <HwButton label={`${name} reset the key`} caption="KEY 0" disabled={disabled || report.keyShift === 0} onClick={() => set("keyShift", 0)} />
          </div>
          <div className="dj-hw-stepper" role="group" aria-label={`${name} Key Shift`}>
            <HwButton label={`${name} key down a semitone`} caption="♭" disabled={disabled} onClick={() => set("keyShift", report.keyShift - 1)} />
            <span className="num dj-hw-value" aria-label={`${name} Key Shift`}>
              {report.keyShift > 0 ? "+" : ""}
              {report.keyShift}
            </span>
            <HwButton label={`${name} key up a semitone`} caption="♯" disabled={disabled} onClick={() => set("keyShift", report.keyShift + 1)} />
          </div>
          {toggle("MASTER TEMPO", report.masterTempo, "masterTempo", "Master Tempo (key lock)", "red")}
          <HwButton
            label={`${name} tempo range, ${TEMPO_RANGES[rangeIndex]?.label ?? ""}: press for the next`}
            caption={`TEMPO ${TEMPO_RANGES[rangeIndex]?.label ?? ""}`}
            onClick={() => onState({ range: TEMPO_RANGES[(rangeIndex + 1) % TEMPO_RANGES.length]!.id })}
          />
          <div className="dj-tempo">
            <div className="dj-tempo-scale" aria-hidden>
              <span>−</span>
              <span>0</span>
              <span>+</span>
            </div>
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
          </div>
          <span className="num dj-hw-value">{formatTempo(report.tempo)}</span>
          <HwButton
            label={`${name} tempo reset`}
            caption="TEMPO RESET"
            light={report.tempo === 0 && loaded ? "on" : undefined}
            tone="green"
            disabled={disabled || report.sync}
            onClick={() => set("tempo", 0)}
          />
          <div className="dj-hw-pair">
            <button type="button" className="dj-hw-button" aria-label={`${name} bend slower`} disabled={disabled} {...hold(-BEND)}>
              −
            </button>
            <button type="button" className="dj-hw-button" aria-label={`${name} bend faster`} disabled={disabled} {...hold(BEND)}>
              +
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
