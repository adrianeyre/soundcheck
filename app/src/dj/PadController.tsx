import { useEffect, useId, useRef, useState } from "react";

import { droppedSample, isSampleDrag } from "../samples/sample-drag";
import { BEAT_FX, beatsLabel, formatTime, HOT_CUE_COLOURS, quantize } from "./dj-logic";
import type { DjSession } from "./dj-session";
import { SAMPLER_BANK_SLOTS, SAMPLER_BANKS } from "./dj-report";
import { AddToSong } from "./AddToSong";
import { DJ_TRACK_DRAG_TYPE } from "./dj-state";
import {
  DEFAULT_PAGE,
  dim,
  halfDeck,
  HOT_CUE_LETTERS,
  MODE_COLOURS,
  PAD_MODE_BUTTONS,
  PAD_MODE_NAMES,
  padAction,
  type PadAction,
  padCaption,
  type PadMode,
  PADS,
  pagesOf,
  SLIDE_FX_START,
} from "./pad-controller";
import { SLOT_MODES, SLOT_PITCH_RANGE, type SamplerSlot, type SlotMode, slotPitch } from "./sampler-library";
import { MODE_VALUE, type TimecodeControls } from "./timecode-input";

export interface PadControllerProps {
  session: DjSession;
  /** Tells two Pad Controllers (the Mixer page's and the Pads page's) apart in their ids. */
  id: string;
  /** The Decks' timecode vinyl, which INT turns a Deck to (REL) and from; absent for none. */
  timecode?: TimecodeControls | null;
}

/** One half's own state: the pad mode, the page of each mode, which Deck it drives, and its SLIDE FX. */
interface HalfState {
  mode: PadMode;
  pages: Record<PadMode, number>;
  /** Driving Deck 3 (left) or 4 (right) rather than 1 or 2. */
  other: boolean;
  /** The Hot Cue Keyboard mode plays, A to P. */
  keyboardCue: number;
  /** The Beat FX each of FX 1, 2 and 3 applies, and which is enabled. */
  slideFx: [number, number, number];
  slideOn: number | null;
  hold: boolean;
  level: number;
}

const newHalf = (): HalfState => ({
  mode: "hotCue",
  pages: { ...DEFAULT_PAGE },
  other: false,
  keyboardCue: 0,
  slideFx: [...SLIDE_FX_START],
  slideOn: null,
  hold: false,
  level: 0.5,
});

/** How soon a second press of LOAD counts as a double press: instant doubles. */
const DOUBLE_PRESS_MS = 500;

/** Whether a drag carries something a Sampler Slot loads. */
function loadable(transfer: DataTransfer): boolean {
  const types = [...transfer.types];
  return types.includes(DJ_TRACK_DRAG_TYPE) || types.includes("Files") || isSampleDrag(transfer);
}

/**
 * A lit hardware button. `onPress` is a press; `onRelease`, if given, makes
 * it a button that is held (by the pointer, or Space or Enter).
 */
function Key({
  label,
  caption,
  sub,
  pressed,
  light,
  tone,
  disabled,
  onPress,
  onRelease,
  className = "dj-hw-button",
}: {
  label: string;
  caption: React.ReactNode;
  /** What SHIFT makes it, printed under it as on the hardware. */
  sub?: string;
  pressed?: boolean;
  light?: "on" | "blink";
  tone?: "amber" | "green" | "red" | "blue";
  disabled?: boolean;
  onPress: (shifted: boolean) => void;
  onRelease?: () => void;
  className?: string;
}) {
  const held = useRef(false);
  const down = (shifted: boolean) => {
    if (held.current) return;
    held.current = true;
    onPress(shifted);
  };
  const up = () => {
    if (!held.current) return;
    held.current = false;
    onRelease?.();
  };
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-pressed={pressed}
      data-light={light ?? (pressed ? "on" : undefined)}
      data-tone={tone}
      disabled={disabled}
      {...(onRelease
        ? {
            onPointerDown: (event: React.PointerEvent) => down(event.shiftKey),
            onPointerUp: up,
            onPointerLeave: up,
            onKeyDown: (event: React.KeyboardEvent) => {
              if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                event.preventDefault();
                down(event.shiftKey);
              }
            },
            onKeyUp: (event: React.KeyboardEvent) => {
              if (event.key === " " || event.key === "Enter") up();
            },
          }
        : {
            onClick: (event: React.MouseEvent) => {
              onPress(event.shiftKey);
            },
          })}
    >
      <span className="dj-pc-key-caption">{caption}</span>
      {sub && <span className="dj-pc-key-sub">{sub}</span>}
    </button>
  );
}

/**
 * The **Pad Controller**: a two-deck pad controller for DJ software, drawn
 * and working as the hardware does. Each half drives a Deck (the left Deck 1
 * or, with SHIFT and INT, Deck 3; the right Deck 2 or 4) with its SLIDE FX
 * strip at its outer edge, its loop, sync, key and cue buttons, four PAD
 * MODE buttons and sixteen lit pads; between the halves the browse knob and
 * SHIFT. Under them are the Sampler's bank, level and slots, and a recorder
 * whose take goes into the song.
 *
 * It sends the same commands the Decks' own panels send, so it and they
 * drive the same Decks. SHIFT is latched: press it, and the next button
 * (or pad) does its SHIFT function; holding the keyboard's Shift key while
 * pressing works too.
 */
export function PadController({ session, id, timecode = null }: PadControllerProps) {
  const { report, decks, send, sampler } = session;
  const [halves, setHalves] = useState<[HalfState, HalfState]>(() => [newHalf(), newHalf()]);
  const [shift, setShift] = useState(false);
  const [bank, setBank] = useState(0);
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState<"master" | "sampler">("master");
  const [status, setStatus] = useState<string | null>(null);
  const releases = useRef(new Map<string, () => void>());
  const loadPresses = useRef<[number, number]>([0, 0]);
  const touching = useRef<[boolean, boolean]>([false, false]);
  const file = useRef<HTMLInputElement>(null);
  const fileSlot = useRef(0);
  const uid = useId();
  const canPlay = session.dj !== null;
  const recording = report.recording;

  const change = (half: 0 | 1, next: Partial<HalfState>) =>
    setHalves((both) => (half === 0 ? [{ ...both[0], ...next }, both[1]] : [both[0], { ...both[1], ...next }]));

  /** Take SHIFT as pressed for this one press, then let it go. */
  const shifted = (held: boolean) => {
    const on = shift || held;
    if (shift) setShift(false);
    return on;
  };

  // Let go of whatever the pads hold if the controller goes away.
  useEffect(() => {
    const held = releases.current;
    return () => {
      for (const release of held.values()) release();
      held.clear();
    };
  }, []);

  const slotOf = (pad: number) => bank * SAMPLER_BANK_SLOTS + pad;

  // ---- SLIDE FX: the touch strip lends the Beat FX to the half's Deck while it is touched (or held).

  const slideOwner = (half: 0 | 1) => `slide:${id}:${half}`;
  const slide = (half: 0 | 1, state: HalfState, level: number, touched: boolean) => {
    const deck = halfDeck(half, state.other);
    if (state.slideOn === null || (!touched && !state.hold)) {
      session.lendBeatFx(slideOwner(half), null);
      return;
    }
    session.lendBeatFx(slideOwner(half), {
      type: state.slideFx[state.slideOn]!,
      division: session.mixer.beatFxDivision,
      target: deck,
      level,
    });
  };

  // ---- The pads.

  const lightOf = (half: 0 | 1, action: PadAction): { colour: string; light: "off" | "dim" | "on" | "blink" } => {
    const state = halves[half];
    const deck = halfDeck(half, state.other);
    const r = report.decks[deck]!;
    const deckState = decks[deck]!;
    const colour = MODE_COLOURS[state.mode];
    switch (action.kind) {
      case "none":
        return { colour: "#000000", light: "off" };
      case "hotCue": {
        const hot = deckState.hotCues[action.index];
        return hot ? { colour: hot.colour, light: "on" } : { colour: HOT_CUE_COLOURS[action.index]!, light: "off" };
      }
      case "keyboard": {
        const hot = deckState.hotCues[state.keyboardCue];
        const tint = hot?.colour ?? colour;
        return { colour: tint, light: r.keyShift === action.semitones ? "on" : "dim" };
      }
      case "keyShift":
        return { colour, light: r.keyShift === action.semitones ? "on" : "dim" };
      case "keySync":
        return { colour: "#3ddc97", light: deckState.keySync ? "on" : "dim" };
      case "keyReset":
      case "keyStep":
        return { colour: "#eef0f6", light: "dim" };
      case "padFx":
        return { colour, light: "dim" };
      case "beatJump":
        return { colour, light: action.beats < 0 ? "dim" : "on" };
      case "beatLoop": {
        const length = r.loop && r.bpm > 0 ? ((r.loop.end - r.loop.start) * r.bpm) / 60 : null;
        return { colour, light: length !== null && Math.abs(length - action.beats) < 1e-3 ? "blink" : "dim" };
      }
      case "sampler": {
        const slot = report.sampler.slots[slotOf(action.pad)];
        const light = slot === "playing" ? "on" : slot === "paused" ? "blink" : slot === "stopped" ? "dim" : "off";
        return { colour, light };
      }
    }
  };

  /** What pad `pad` of `half` is called, for assistive technology. */
  const padLabel = (half: 0 | 1, action: PadAction): string => {
    const state = halves[half];
    const deck = halfDeck(half, state.other);
    const name = `Deck ${deck + 1}`;
    switch (action.kind) {
      case "none":
        return "No assignment";
      case "hotCue": {
        const hot = decks[deck]!.hotCues[action.index];
        const letter = HOT_CUE_LETTERS[action.index]!;
        return hot ? `${name} Hot Cue ${letter}, ${hot.label}, at ${formatTime(hot.seconds)}` : `${name} set Hot Cue ${letter}`;
      }
      case "keyboard":
        return `${name} play Hot Cue ${HOT_CUE_LETTERS[state.keyboardCue]} at ${padCaption(action)} semitones`;
      case "keyShift":
        return `${name} Key Shift ${padCaption(action)} semitones`;
      case "keySync":
        return `${name} Key Sync ${decks[deck]!.keySync ? "on" : "off"}`;
      case "keyReset":
        return `${name} key reset`;
      case "keyStep":
        return `${name} key ${action.by > 0 ? "up" : "down"} a semitone`;
      case "padFx":
        return `${name} Pad FX ${action.fx.letter}: ${BEAT_FX[action.fx.type]!.label} ${beatsLabel(action.fx.beats)}${action.fx.beats < 8 ? " beat" : ""}, while held`;
      case "beatJump":
        return `${name} Beat Jump ${action.beats < 0 ? "back" : "forward"} ${action.label}`;
      case "beatLoop":
        return `${name} Beat Loop ${action.label}`;
      case "sampler": {
        const slot = slotOf(action.pad);
        const held = sampler.slots[slot];
        return `Sampler Slot ${slot + 1}${held ? `, ${held.name}` : ", empty"}`;
      }
    }
  };

  const press = (half: 0 | 1, pad: number, held: boolean) => {
    const state = halves[half];
    const deck = halfDeck(half, state.other);
    const r = report.decks[deck]!;
    const deckState = decks[deck]!;
    const action = padAction(state.mode, state.pages[state.mode], pad);
    const withShift = shifted(held);
    const key = `${half}:${pad}`;
    const hold = (release: () => void) => releases.current.set(key, release);
    switch (action.kind) {
      case "none":
        return;
      case "hotCue": {
        const hot = deckState.hotCues[action.index];
        if (withShift) {
          if (hot) session.changeDeck(deck, { hotCues: deckState.hotCues.map((c, at) => (at === action.index ? null : c)) });
          return;
        }
        if (!r.loaded) return;
        change(half, { keyboardCue: action.index });
        if (!hot) {
          const seconds = r.quantize ? quantize(r.position, r.bpm, r.firstBeat) : r.position;
          const letter = HOT_CUE_LETTERS[action.index]!;
          session.changeDeck(deck, {
            hotCues: deckState.hotCues.map((c, at) =>
              at === action.index ? { seconds, label: letter, colour: HOT_CUE_COLOURS[action.index]! } : c,
            ),
          });
          return;
        }
        send("deck", deck, "jumpHold", hot.seconds);
        hold(() => send("deck", deck, "jumpRelease", 1));
        return;
      }
      case "keyboard": {
        if (!r.loaded) return;
        const hot = deckState.hotCues[state.keyboardCue] ?? deckState.hotCues.find((c) => c !== null) ?? null;
        send("deck", deck, "keyShift", action.semitones);
        send("deck", deck, "jumpHold", hot?.seconds ?? r.cue);
        hold(() => send("deck", deck, "jumpRelease", 1));
        return;
      }
      case "keyShift":
        if (r.loaded) send("deck", deck, "keyShift", action.semitones);
        return;
      case "keySync":
        session.changeDeck(deck, { keySync: !deckState.keySync });
        return;
      case "keyReset":
        session.changeDeck(deck, { keySync: false });
        send("deck", deck, "keyShift", 0);
        return;
      case "keyStep":
        send("deck", deck, "keyShift", Math.max(-12, Math.min(12, r.keyShift + action.by)));
        return;
      case "padFx": {
        const owner = `pad:${id}:${key}`;
        session.lendBeatFx(owner, { type: action.fx.type, division: action.fx.beats, target: deck, level: action.fx.level });
        hold(() => session.lendBeatFx(owner, null));
        return;
      }
      case "beatJump":
        if (r.loaded) send("deck", deck, "beatJump", action.beats);
        return;
      case "beatLoop": {
        if (!r.loaded) return;
        const length = r.loop && r.bpm > 0 ? ((r.loop.end - r.loop.start) * r.bpm) / 60 : null;
        if (length !== null && Math.abs(length - action.beats) < 1e-3) send("deck", deck, "exitLoop", 1);
        else send("deck", deck, "autoLoop", action.beats);
        return;
      }
      case "sampler": {
        const slot = slotOf(action.pad);
        const now = report.sampler.slots[slot];
        const sample = sampler.slots[slot];
        if (withShift) {
          // SHIFT: pause a sounding slot, or load the chosen track into a still one.
          if (now === "playing" || now === "paused") send("sampler", slot, "pause", 1);
          else void session.loadSlotFromCursor(slot);
          return;
        }
        if (!sample) {
          setEditing(true);
          setStatus(`Sampler Slot ${slot + 1} is empty: load a sample into it below, or press SHIFT and the pad to load the chosen track.`);
          return;
        }
        send("sampler", slot, "play", 1);
        hold(() => send("sampler", slot, "release", 1));
        return;
      }
    }
  };
  const release = (half: 0 | 1, pad: number) => {
    const key = `${half}:${pad}`;
    releases.current.get(key)?.();
    releases.current.delete(key);
  };

  const dropOnPad = (half: 0 | 1, pad: number, event: React.DragEvent) => {
    event.preventDefault();
    if (halves[half].mode !== "sampler" || !canPlay) return;
    const slot = slotOf(pad);
    const trackId = event.dataTransfer.getData(DJ_TRACK_DRAG_TYPE);
    const sample = droppedSample(event.dataTransfer);
    if (trackId) void session.loadSlotTrack(slot, trackId);
    else if (sample) void session.loadSlotSample(slot, sample);
    else if (event.dataTransfer.files[0]) void session.loadSlotFile(slot, event.dataTransfer.files[0]);
  };

  // ---- One half of the panel.

  const renderHalf = (half: 0 | 1) => {
    const state = halves[half];
    const deck = halfDeck(half, state.other);
    const r = report.decks[deck]!;
    const deckName = `Deck ${deck + 1}`;
    const loaded = canPlay && r.loaded;
    const pages = pagesOf(state.mode);
    const page = state.pages[state.mode];
    const side = half === 0 ? "left" : "right";
    const setPage = (by: 1 | -1, withShift: boolean) => {
      if (state.mode === "sampler" || withShift) {
        setBank((b) => (b + by + SAMPLER_BANKS) % SAMPLER_BANKS);
        return;
      }
      if (pages <= 1) return;
      change(half, { pages: { ...state.pages, [state.mode]: (page + by + pages) % pages } });
    };
    const load = (withShift: boolean) => {
      if (!canPlay) return;
      const now = performance.now();
      const last = loadPresses.current[half];
      loadPresses.current[half] = now;
      const otherDeck = halfDeck(half === 0 ? 1 : 0, halves[half === 0 ? 1 : 0].other);
      if (!withShift && now - last < DOUBLE_PRESS_MS) {
        // Pressed twice: instant doubles, the other side's track onto this Deck, where it is.
        loadPresses.current[half] = 0;
        void session.instantDouble(otherDeck, deck);
        return;
      }
      // What the browse knob is on, in the loaded list or the folder tree.
      setStatus(session.loadChosen(deck, withShift, browser));
    };
    const slideFxName = (slot: number) => BEAT_FX[state.slideFx[slot]!]!.label;

    return (
      <div className="dj-pc-half" data-side={side} role="group" aria-label={`${side === "left" ? "Left" : "Right"} half, ${deckName}`}>
        <div className="dj-pc-fx" role="group" aria-label={`SLIDE FX ${half + 1}`}>
          <span className="dj-hw-caption">SLIDE FX {half + 1}</span>
          {[0, 1, 2].map((slot) => (
            <Key
              key={slot}
              label={`FX ${slot + 1}, ${slideFxName(slot)}, on ${deckName}${shift ? ": choose its type" : ""}`}
              caption={`${slot + 1}`}
              sub={slideFxName(slot).toUpperCase()}
              pressed={state.slideOn === slot}
              tone="amber"
              onPress={(held) => {
                if (shifted(held)) {
                  const slideFx = [...state.slideFx] as HalfState["slideFx"];
                  slideFx[slot] = (slideFx[slot]! + 1) % BEAT_FX.length;
                  const next = { ...state, slideFx };
                  change(half, { slideFx });
                  if (next.slideOn === slot && (touching.current[half] || next.hold)) slide(half, next, next.level, touching.current[half]);
                  return;
                }
                // Only one FX a side is enabled at a time.
                const slideOn = state.slideOn === slot ? null : slot;
                const next = { ...state, slideOn };
                change(half, { slideOn });
                slide(half, next, next.level, touching.current[half]);
              }}
            />
          ))}
          <label className="dj-pc-strip">
            <span className="dj-hw-caption">FX LEVEL</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.level}
              aria-label={`SLIDE FX ${half + 1} touch strip: level of ${state.slideOn === null ? "no FX (press 1, 2 or 3)" : slideFxName(state.slideOn)} on ${deckName}`}
              aria-valuetext={`${Math.round(state.level * 100)}%`}
              onPointerDown={() => {
                touching.current[half] = true;
                slide(half, state, state.level, true);
              }}
              onPointerUp={() => {
                touching.current[half] = false;
                slide(half, state, state.level, false);
              }}
              onBlur={() => {
                touching.current[half] = false;
                slide(half, state, state.level, false);
              }}
              onChange={(event) => {
                const level = Number(event.target.value);
                change(half, { level });
                slide(half, { ...state, level }, level, true);
              }}
            />
          </label>
          <Key
            label={`SLIDE FX ${half + 1} hold`}
            caption="HOLD"
            pressed={state.hold}
            tone="red"
            onPress={() => {
              const next = { ...state, hold: !state.hold };
              change(half, { hold: next.hold });
              slide(half, next, next.level, touching.current[half]);
            }}
          />
        </div>

        <div className="dj-pc-main">
          <div className="dj-pc-row">
            <div className="dj-pc-loop" role="group" aria-label={`${deckName} loop`}>
              <span className="dj-hw-caption">LOOP</span>
              <Key
                label={shift ? `${deckName} Active Loop` : r.loop ? `${deckName} exit the loop` : `${deckName} 4 beat loop`}
                caption="4 BEAT LOOP"
                sub="ACTIVE LOOP"
                light={r.loop ? "on" : undefined}
                tone="amber"
                disabled={!loaded}
                onPress={(held) => {
                  if (shifted(held)) send("deck", deck, r.loop ? "exitLoop" : "reloop", 1);
                  else if (r.loop) send("deck", deck, "exitLoop", 1);
                  else send("deck", deck, "autoLoop", 4);
                }}
              />
              <div className="dj-hw-pair">
                <Key
                  label={shift ? `${deckName} loop in` : `Halve ${deckName}'s loop`}
                  caption="1/2X"
                  sub="IN"
                  disabled={!loaded}
                  onPress={(held) => (shifted(held) ? send("deck", deck, "loopIn", r.position) : send("deck", deck, "resizeLoop", 0.5))}
                />
                <Key
                  label={shift ? `${deckName} loop out` : `Double ${deckName}'s loop`}
                  caption="2X"
                  sub="OUT"
                  disabled={!loaded}
                  onPress={(held) => (shifted(held) ? send("deck", deck, "loopOut", r.position) : send("deck", deck, "resizeLoop", 2))}
                />
              </div>
            </div>
            <Key
              label={`${deckName} Quantize`}
              caption="QUANTIZE"
              pressed={r.quantize}
              tone="red"
              disabled={!loaded}
              onPress={() => send("deck", deck, "quantize", r.quantize ? 0 : 1)}
            />
            <div className="dj-pc-load">
              <span className="dj-hw-caption">◀◀ INST. DOUBLES</span>
              <Key
                label={shift ? `Load the next track onto ${deckName}` : `Load the chosen track onto ${deckName}; press twice for instant doubles`}
                caption="LOAD"
                sub="▶▶ NEXT"
                disabled={!canPlay}
                onPress={(held) => load(shifted(held))}
              />
            </div>
          </div>

          <div className="dj-pc-row">
            <div className="dj-pc-parameter" role="group" aria-label={`${deckName} PARAMETER`}>
              <span className="dj-hw-caption">PARAMETER {half + 1}</span>
              <div className="dj-hw-pair">
                <Key
                  label={state.mode === "sampler" || shift ? "Previous Sampler bank" : `${deckName} previous pad page`}
                  caption="◀"
                  sub="BANK"
                  onPress={(held) => setPage(-1, shifted(held))}
                />
                <Key
                  label={state.mode === "sampler" || shift ? "Next Sampler bank" : `${deckName} next pad page`}
                  caption="▶"
                  sub="BANK"
                  onPress={(held) => setPage(1, shifted(held))}
                />
              </div>
            </div>
            <Key
              label={`${deckName} Slip Reverse, while held`}
              caption="⟲ SLIP REV"
              light={r.slipReverse ? "on" : undefined}
              tone="red"
              disabled={!loaded}
              onPress={() => send("deck", deck, "slipReverse", 1)}
              onRelease={() => send("deck", deck, "slipReverse", 0)}
            />
            <Key
              label={`${deckName} Master Tempo`}
              caption="♪ MT"
              pressed={r.masterTempo}
              tone="red"
              disabled={!loaded}
              onPress={() => send("deck", deck, "masterTempo", r.masterTempo ? 0 : 1)}
            />
            <Key
              label={shift ? `Make ${deckName} the Sync Master` : `${deckName} Beat Sync`}
              caption="BEAT SYNC"
              sub="MASTER"
              pressed={r.sync}
              light={report.syncMaster === deck ? "on" : undefined}
              tone="blue"
              disabled={!loaded || r.bpm <= 0}
              onPress={(held) => (shifted(held) ? send("deck", deck, "syncMaster", 1) : send("deck", deck, "sync", r.sync ? 0 : 1))}
            />
          </div>

          <div className="dj-pc-row">
            <Key
              label={`${deckName} Silent Cue`}
              caption="SILENT CUE"
              pressed={r.silent}
              tone="red"
              disabled={!loaded}
              onPress={() => send("deck", deck, "silentCue", r.silent ? 0 : 1)}
            />
            <div className="dj-pc-key" role="group" aria-label={`${deckName} KEY`}>
              <span className="dj-hw-caption">KEY {r.keyShift !== 0 && <span className="num">{r.keyShift > 0 ? `+${r.keyShift}` : r.keyShift}</span>}</span>
              <div className="dj-hw-pair">
                <Key
                  label={shift ? `${deckName} Key Sync ${decks[deck]!.keySync ? "off" : "on"}` : `${deckName} key down a semitone`}
                  caption="−"
                  sub="KEY SYNC"
                  pressed={decks[deck]!.keySync}
                  tone="green"
                  disabled={!loaded}
                  onPress={(held) => {
                    if (shifted(held)) session.changeDeck(deck, { keySync: !decks[deck]!.keySync });
                    else send("deck", deck, "keyShift", Math.max(-12, r.keyShift - 1));
                  }}
                />
                <Key
                  label={shift ? `${deckName} key reset` : `${deckName} key up a semitone`}
                  caption="+"
                  sub="RESET"
                  disabled={!loaded}
                  onPress={(held) => {
                    if (shifted(held)) {
                      session.changeDeck(deck, { keySync: false });
                      send("deck", deck, "keyShift", 0);
                    } else send("deck", deck, "keyShift", Math.min(12, r.keyShift + 1));
                  }}
                />
              </div>
            </div>
            <Key
              label={
                shift
                  ? `Switch the ${side} half to Deck ${halfDeck(half, !state.other) + 1}`
                  : `${deckName} INT, now ${r.mode === "int" ? "INT: it plays the file itself" : `${r.mode.toUpperCase()}: its timecode vinyl moves it`}`
              }
              caption="INT"
              sub={`DECK ${halfDeck(half, !state.other) + 1}`}
              light={r.mode === "int" ? "on" : undefined}
              tone="blue"
              onPress={(held) => {
                if (shifted(held)) {
                  for (const [key, let_go] of releases.current) {
                    if (key.startsWith(`${half}:`)) {
                      let_go();
                      releases.current.delete(key);
                    }
                  }
                  session.lendBeatFx(slideOwner(half), null);
                  change(half, { other: !state.other });
                  setStatus(`The ${side} half drives Deck ${halfDeck(half, !state.other) + 1}.`);
                } else if (r.mode !== "int") {
                  // From REL, or from ABS, back to INT, as the hardware's button does.
                  send("deck", deck, "mode", MODE_VALUE.int);
                  setStatus(`${deckName} plays the file itself (INT).`);
                } else if (!timecode?.available) {
                  setStatus(`REL follows timecode vinyl through an audio input, which needs the Desktop App. ${deckName} stays in INT.`);
                } else {
                  send("deck", deck, "mode", MODE_VALUE.rel);
                  setStatus(
                    timecode.setup[deck]?.device
                      ? `${deckName} is in REL: its timecode vinyl's speed and direction move it.`
                      : `${deckName} is in REL, but has no timecode input yet, so it stays still: choose one under its TIMECODE INPUT on the Mixer page.`,
                  );
                }
              }}
            />
          </div>

          <p className="dj-pc-display" aria-live="polite">
            <span className="dj-deck-number" data-deck={deck}>
              {deck + 1}
            </span>
            <span>{PAD_MODE_NAMES[state.mode]}</span>
            <span className="num">
              {state.mode === "sampler"
                ? `BANK ${bank + 1}`
                : state.mode === "keyboard"
                  ? `CUE ${HOT_CUE_LETTERS[state.keyboardCue]} · PAGE ${page + 1}/${pages}`
                  : pages > 1
                    ? `PAGE ${page + 1}/${pages}`
                    : ""}
            </span>
            <span className="dj-pc-display-title">{session.titleOfDeck(deck) ?? "No track"}</span>
          </p>

          <div className="dj-pc-modes" role="group" aria-label={`${deckName} pad modes`}>
            {PAD_MODE_BUTTONS.map((button, index) => {
              const current = state.mode === button.plain || state.mode === button.shifted;
              return (
                <Key
                  key={button.plain}
                  label={`PAD MODE ${index + 1}: ${PAD_MODE_NAMES[shift ? button.shifted : button.plain]}${current ? `, now ${PAD_MODE_NAMES[state.mode]}` : ""}`}
                  caption={`PAD MODE ${index + 1}`}
                  sub={PAD_MODE_NAMES[button.shifted]}
                  light={current ? (state.mode === button.shifted ? "blink" : "on") : undefined}
                  className="dj-hw-button dj-pc-mode"
                  onPress={(held) => change(half, { mode: shifted(held) ? button.shifted : button.plain })}
                />
              );
            })}
          </div>

          <div className="dj-pc-grid" role="group" aria-label={`${deckName} pads, ${PAD_MODE_NAMES[state.mode]}`}>
            {Array.from({ length: PADS }, (_, pad) => {
              const action = padAction(state.mode, page, pad);
              const { colour, light } = lightOf(half, action);
              const slot = state.mode === "sampler" ? sampler.slots[slotOf(pad)] : null;
              const caption = state.mode === "sampler" ? `${slotOf(pad) + 1}` : padCaption(action);
              const disabled =
                !canPlay ||
                action.kind === "none" ||
                (state.mode !== "sampler" && !action.kind.startsWith("key") && action.kind !== "padFx" && !r.loaded);
              return (
                <button
                  key={pad}
                  type="button"
                  className="dj-pc-pad"
                  aria-label={padLabel(half, action)}
                  data-light={light === "blink" ? "blink" : undefined}
                  data-lit={light}
                  style={{ "--pad": colour, "--pad-dim": dim(colour) } as React.CSSProperties}
                  disabled={disabled}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    press(half, pad, event.shiftKey);
                  }}
                  onPointerUp={() => release(half, pad)}
                  onPointerCancel={() => release(half, pad)}
                  onKeyDown={(event) => {
                    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                      event.preventDefault();
                      press(half, pad, event.shiftKey);
                    }
                  }}
                  onKeyUp={(event) => {
                    if (event.key === " " || event.key === "Enter") release(half, pad);
                  }}
                  onDragOver={(event) => {
                    if (state.mode === "sampler" && loadable(event.dataTransfer)) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                    }
                  }}
                  onDrop={(event) => dropOnPad(half, pad, event)}
                >
                  <span className="dj-pc-pad-caption">{caption}</span>
                  {slot && <span className="dj-pc-pad-name">{slot.name}</span>}
                  {action.kind === "hotCue" && decks[deck]!.hotCues[action.index] && (
                    <span className="dj-pc-pad-name">{decks[deck]!.hotCues[action.index]!.label}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // ---- The centre: the browse knob and SHIFT.

  // The Track browser the knob drives: the one on this controller's page.
  const browser = id === "pads" ? 3 : 1;
  const turn = (by: number) => setStatus(session.turnKnob(by, browser));
  const knobPress = (withShift: boolean) => {
    setStatus(null);
    session.pressKnob(withShift, browser);
  };
  const inTree = session.browseList === "tree" && session.hasTree;

  const bankSlots = Array.from({ length: SAMPLER_BANK_SLOTS }, (_, pad) => slotOf(pad));

  return (
    <section className="dj-pc dj-hw" aria-labelledby={`${uid}-title`}>
      <div className="dj-pc-head">
        <h2 id={`${uid}-title`} className="dj-hw-title">
          Pad Controller
        </h2>
        {(status ?? session.message) && (
          <p className="dj-hw-note" role="status">
            {status ?? session.message}
          </p>
        )}
      </div>

      <div className="dj-pc-body">
        {renderHalf(0)}

        <div className="dj-pc-centre" role="group" aria-label="Browse and SHIFT">
          <span className="dj-hw-caption">BROWSE</span>
          <button
            type="button"
            className="dj-pc-knob"
            aria-label={`Browse knob: turn with the arrow keys or the mouse wheel to move through the ${inTree ? "folders" : "loaded tracks"}; press to ${inTree ? (shift ? "close a folder, or go to the loaded tracks" : "open a folder, or go to the loaded tracks") : session.hasTree ? "go to the folders" : "show the loaded tracks"}. On ${session.knobOn}`}
            onWheel={(event) => turn(event.deltaY > 0 ? 1 : -1)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                event.preventDefault();
                turn(1);
              } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                event.preventDefault();
                turn(-1);
              }
            }}
            onClick={(event) => knobPress(shifted(event.shiftKey))}
          >
            <span className="dj-pc-knob-cap" aria-hidden />
          </button>
          <div className="dj-hw-pair">
            <Key label="Turn the browse knob up" caption="▲" onPress={() => turn(-1)} />
            <Key label="Turn the browse knob down" caption="▼" onPress={() => turn(1)} />
          </div>
          <p className="dj-pc-cursor" aria-live="polite">
            {session.knobOn}
          </p>
          <Key label="SHIFT" caption="SHIFT" pressed={shift} tone="amber" onPress={() => setShift(!shift)} />
        </div>

        {renderHalf(1)}
      </div>

      <div className="dj-pc-sampler" role="group" aria-label="Sampler">
        <span className="dj-hw-caption">SAMPLER</span>
        <div className="dj-layout" role="radiogroup" aria-label="Sampler bank">
          {Array.from({ length: SAMPLER_BANKS }, (_, index) => (
            <button
              key={index}
              type="button"
              role="radio"
              aria-checked={bank === index}
              className="dj-assign-button"
              onClick={() => setBank(index)}
            >
              BANK {index + 1}
            </button>
          ))}
        </div>
        <label className="dj-pc-gain">
          <span className="dj-hw-caption">GAIN</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={sampler.gain}
            aria-label="Sampler Gain"
            aria-valuetext={`${Math.round(sampler.gain * 100)}%`}
            onChange={(event) => session.setSamplerGain(Number(event.target.value))}
          />
        </label>
        <meter className="dj-pc-meter" aria-label="Sampler level" min={0} max={1} value={Math.min(1, report.sampler.level)} />
        <Key label="Sampler in the headphone cue" caption="CUE" pressed={report.sampler.cue} tone="amber" disabled={!canPlay} onPress={() => send("mixer", 0, "samplerCue", report.sampler.cue ? 0 : 1)} />
        <Key label="Stop every Sampler Slot" caption="STOP ALL" disabled={!canPlay} onPress={() => send("mixer", 0, "samplerStopAll", 1)} />
        <Key label="Edit the Sampler Slots" caption="EDIT SLOTS" pressed={editing} onPress={() => setEditing(!editing)} />

        <div className="dj-pc-rec" role="group" aria-label="Recorder">
          <div className="dj-layout" role="radiogroup" aria-label="What to record">
            {(
              [
                ["master", "MIX"],
                ["sampler", "SAMPLER ONLY"],
              ] as const
            ).map(([value, caption]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={source === value}
                aria-label={value === "master" ? "Record the whole mix" : "Record the Sampler alone"}
                className="dj-assign-button"
                disabled={recording}
                onClick={() => setSource(value)}
              >
                {caption}
              </button>
            ))}
          </div>
          <Key
            label={recording ? "Stop recording" : source === "sampler" ? "Record the Sampler" : "Record the mix"}
            caption={recording ? "■ STOP" : "● REC"}
            light={recording ? "blink" : undefined}
            tone="red"
            disabled={!canPlay || session.saving}
            onPress={() => void session.record(!recording, { save: false, source })}
          />
          <span className="num dj-hw-value">{recording ? formatTime(report.recordingSeconds) : session.take ? formatTime(session.take.seconds) : "0:00.0"}</span>
          {session.canAddToSong && (
            <AddToSong
              place={session.songPlace}
              onPlace={session.setSongPlace}
              onAdd={() => void session.addTakeToSong()}
              disabled={!session.take || recording || session.saving}
              tempoOffer={session.tempoOffer ?? null}
              onSetTempo={session.setSongTempo}
            />
          )}
          <Key
            label="Save the recording as a file"
            caption="SAVE…"
            disabled={!session.take || recording || session.saving}
            onPress={() => void session.saveTake()}
          />
        </div>
      </div>

      {editing && (
        <div className="dj-pc-slots" role="group" aria-label={`Bank ${bank + 1} Sampler Slots`}>
          <input
            ref={file}
            type="file"
            hidden
            accept="audio/mpeg,audio/wav,audio/x-wav,audio/flac,.mp3,.wav,.flac"
            aria-label="Load a file into a Sampler Slot"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) void session.loadSlotFile(fileSlot.current, chosen);
              event.target.value = "";
            }}
          />
          <p className="dj-hw-note">
            Load a file, the Track browser&apos;s chosen track, or drop a file or a track on a slot or its pad. Slots are kept for next time.
          </p>
          <ol className="dj-pc-slot-list">
            {bankSlots.map((slot) => {
              const held = sampler.slots[slot];
              const number = slot + 1;
              return (
                <li
                  key={slot}
                  className="dj-pc-slot"
                  data-state={report.sampler.slots[slot]}
                  onDragOver={(event) => {
                    if (loadable(event.dataTransfer)) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const trackId = event.dataTransfer.getData(DJ_TRACK_DRAG_TYPE);
                    const sample = droppedSample(event.dataTransfer);
                    if (trackId) void session.loadSlotTrack(slot, trackId);
                    else if (sample) void session.loadSlotSample(slot, sample);
                    else if (event.dataTransfer.files[0]) void session.loadSlotFile(slot, event.dataTransfer.files[0]);
                  }}
                >
                  <span className="num dj-pc-slot-number">{number}</span>
                  {held ? (
                    <input
                      type="text"
                      value={held.name}
                      maxLength={40}
                      aria-label={`Slot ${number} name`}
                      onChange={(event) => session.changeSlot(slot, { name: event.target.value })}
                    />
                  ) : (
                    <span className="dj-hw-caption">Empty</span>
                  )}
                  {held && (
                    <select
                      aria-label={`Slot ${number} plays`}
                      value={held.mode}
                      onChange={(event) => session.setSlotMode(slot, Number(event.target.value) as SlotMode)}
                    >
                      {SLOT_MODES.map((mode) => (
                        <option key={mode.mode} value={mode.mode} title={mode.label}>
                          {mode.caption}
                        </option>
                      ))}
                    </select>
                  )}
                  {held && (
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.01}
                      value={held.gain}
                      aria-label={`Slot ${number} level`}
                      aria-valuetext={`${Math.round(held.gain * 100)}%`}
                      onChange={(event) => session.changeSlot(slot, { gain: Number(event.target.value) })}
                    />
                  )}
                  {held && <SlotTempo number={number} held={held} onChange={(tempo) => session.changeSlot(slot, tempo)} />}
                  <button
                    type="button"
                    className="btn-sm"
                    aria-label={`Load a file into slot ${number}`}
                    disabled={!canPlay}
                    onClick={() => {
                      fileSlot.current = slot;
                      file.current?.click();
                    }}
                  >
                    File…
                  </button>
                  <button
                    type="button"
                    className="btn-sm"
                    aria-label={`Load the chosen track into slot ${number}`}
                    disabled={!canPlay || !session.cursorTrack}
                    onClick={() => void session.loadSlotFromCursor(slot)}
                  >
                    Chosen track
                  </button>
                  <button
                    type="button"
                    className="btn-sm"
                    aria-label={`Clear slot ${number}`}
                    disabled={!held}
                    onClick={() => void session.clearSlot(slot)}
                  >
                    Clear
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}

/** What a number input holds, or null while it holds none (being typed, say). */
const entered = (value: string) => (value.trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const signed = (value: number) => (value > 0 ? `+${value}` : `${value}`);

/**
 * A Sampler Slot's pitch (semitones, and cents), its sync to the Master's
 * tempo and its BPM, in EDIT SLOTS. The pitch plays the sample faster or
 * slower; synced, the slot plays at the Sync Master's tempo, keeping its
 * pitch, by its BPM (found as it loads, or entered).
 */
function SlotTempo({
  number,
  held,
  onChange,
}: {
  number: number;
  held: SamplerSlot;
  onChange: (change: Partial<Pick<SamplerSlot, "pitch" | "sync" | "bpm">>) => void;
}) {
  const semitones = Math.round(held.pitch);
  const cents = Math.round((held.pitch - semitones) * 100);
  const pitch = (st: number, ct: number) => onChange({ pitch: slotPitch(st + ct / 100) });
  const bpm = held.bpm ?? 0;
  return (
    <>
      <label className="dj-pc-slot-field">
        <span className="dj-hw-caption">PITCH</span>
        <input
          type="number"
          min={-SLOT_PITCH_RANGE}
          max={SLOT_PITCH_RANGE}
          step={1}
          value={semitones}
          aria-label={`Slot ${number} pitch, in semitones`}
          aria-valuetext={`${signed(semitones)} semitones`}
          onChange={(event) => {
            const value = entered(event.target.value);
            if (value !== null) pitch(Math.round(value), cents);
          }}
        />
      </label>
      <label className="dj-pc-slot-field">
        <span className="dj-hw-caption">CENTS</span>
        <input
          type="number"
          min={-50}
          max={50}
          step={1}
          value={cents}
          aria-label={`Slot ${number} fine pitch, in cents`}
          aria-valuetext={`${signed(cents)} cents`}
          onChange={(event) => {
            const value = entered(event.target.value);
            if (value !== null) pitch(semitones, Math.max(-50, Math.min(50, Math.round(value))));
          }}
        />
      </label>
      <button
        type="button"
        className="btn-sm"
        aria-pressed={held.sync}
        aria-label={`Sync slot ${number} to the master tempo`}
        title={bpm > 0 ? "Play at the Sync Master's tempo, keeping the pitch" : "Give the slot a BPM for it to sync by"}
        onClick={() => onChange({ sync: !held.sync })}
      >
        SYNC
      </button>
      <label className="dj-pc-slot-field">
        <span className="dj-hw-caption">BPM</span>
        <input
          type="number"
          min={0}
          max={999}
          step={0.01}
          value={bpm > 0 ? Math.round(bpm * 100) / 100 : ""}
          placeholder="none"
          aria-label={`Slot ${number} BPM`}
          onChange={(event) => {
            const value = entered(event.target.value);
            if (value !== null && value >= 0) onChange({ bpm: value });
          }}
        />
      </label>
    </>
  );
}
