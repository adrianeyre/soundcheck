import { useRef, useState } from "react";

import type { AudioOutput } from "../audio/audio-output";

import {
  ASSIGNS,
  BEAT_DIVISIONS,
  BEAT_FX,
  BEAT_FX_TARGETS,
  beatsLabel,
  COLOUR_FX,
  formatBpm,
  formatTime,
  meterFraction,
  TapTempo,
} from "./dj-logic";
import type { DjReport } from "./dj-report";
import { type ChannelState, EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB, type MixerState } from "./dj-state";
import type { HeadphoneOutput } from "./headphone-output";
import { HeadphonePicker } from "./HeadphonePicker";
import { Knob } from "./Knob";

const db = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
const percent = (value: number) => `${Math.round(value * 100)}%`;
/** About a second of the page's readings. */
const PEAK_HOLD_READINGS = 25;
const gain = (value: number) => (value <= 0 ? "−∞ dB" : db(20 * Math.log10(value)));

/**
 * A level meter, as a DJM's: segments lit from the bottom, amber near the
 * top and red at full scale, and a peak held for a second at the top of
 * each rise. Only what the engine measured.
 */
export function LevelMeter({ label, level }: { label: string; level: number }) {
  // The peak held, and how many readings ago; kept as each new reading arrives.
  const [held, setHeld] = useState({ level: 0, age: 0, seen: 0 });
  if (level !== held.seen) {
    const keep = level < held.level && held.age < PEAK_HOLD_READINGS;
    setHeld(keep ? { level: held.level, age: held.age + 1, seen: level } : { level, age: 0, seen: level });
  }
  const fraction = meterFraction(level);
  const peak = meterFraction(Math.max(level, held.level));
  const segments = 18;
  const lit = Math.round(fraction * segments);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(fraction.toFixed(3))}
      aria-valuetext={level >= 1 ? "clipping" : gain(level)}
      className="dj-meter"
      data-clipping={level >= 1}
    >
      {Array.from({ length: segments }, (_, index) => (
        <span
          key={index}
          aria-hidden
          className="dj-meter-segment"
          data-lit={index < lit}
          data-peak={index === Math.max(0, Math.round(peak * segments) - 1) && peak > 0}
          data-zone={index >= segments - 2 ? "clip" : index >= segments - 6 ? "hot" : "ok"}
        />
      )).toReversed()}
    </div>
  );
}

export interface MixerPanelProps {
  channels: readonly ChannelState[];
  mixer: MixerState;
  report: DjReport;
  /** How many channels to show, one per Deck: the page shows all four. */
  count: number;
  /** Whether the headphone cue can be heard on this output. */
  headphones: boolean;
  canPlay: boolean;
  onChannel: (index: number, change: Partial<ChannelState>) => void;
  onMixer: (change: Partial<MixerState>) => void;
  recording: { on: boolean; seconds: number; format: "wav" | "mp3"; saving: boolean };
  onRecordFormat: (format: "wav" | "mp3") => void;
  onRecord: (on: boolean) => void;
  /** Put the last recording into the Editor's song; absent where there is no song to put it in. */
  onAddToSong?: () => void;
  /** Whether there is a recording to add. */
  canAddToSong?: boolean;
  /**
   * Plays the cue out of a second output device the DJ picks: absent while
   * the page doesn't offer it, null where the platform can't.
   */
  headphoneOutput?: HeadphoneOutput | null;
  /** The running audio output, which `headphoneOutput` plays the cue of. */
  output?: AudioOutput | null;
}

/** A switch of two or three labelled positions, as a mixer's curve and assign switches. */
function Switch({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="dj-switch" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === index}
          className="dj-switch-position"
          onClick={() => onChange(index)}
          onKeyDown={(event) => {
            const by = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
            if (by === undefined) return;
            event.preventDefault();
            onChange(Math.min(options.length - 1, Math.max(0, value + by)));
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/** The fader curves' names as the switch prints them. */
const CURVE_CAPTIONS = ["SOFT", "LIN", "CUT"] as const;
const XF_CAPTIONS = ["SMOOTH", "POWER", "CUT"] as const;

/**
 * The mixer, drawn as a club's four-channel mixer: for each Deck a channel
 * strip (trim; high, high-mid, low-mid and low EQ, or isolator, each with a
 * kill; the compressor; the Colour FX knob; the lit CUE button; an LED meter
 * beside a long channel fader; the fader-curve switch and the crossfader
 * assign), the Master, booth and headphone knobs and the stereo meter top
 * right, the Colour FX and Beat FX sections with the Beat FX's own display,
 * recording, and the crossfader along the bottom. Knobs turn with the arrow
 * keys, faders are sliders, and switches move with the arrows.
 */
export function MixerPanel(props: MixerPanelProps) {
  const { channels, mixer, report, count, headphones, canPlay, onChannel, onMixer, recording } = props;
  const tap = useRef(new TapTempo());
  const division = BEAT_DIVISIONS.indexOf(mixer.beatFxDivision);
  const fx = BEAT_FX[mixer.beatFxType] ?? BEAT_FX[0];

  return (
    <section className="dj-mixer dj-hw" aria-label="Mixer" style={{ "--channels": count } as React.CSSProperties}>
      <header className="dj-mixer-head">
        <h2 className="dj-hw-title">Mixer</h2>
        <Switch
          label="EQ mode"
          options={["EQ", "ISOLATOR"]}
          value={mixer.isolator ? 1 : 0}
          onChange={(value) => onMixer({ isolator: value === 1 })}
        />
      </header>
      <div className="dj-mixer-body">
        <div className="dj-channels">
          {channels.slice(0, count).map((channel, index) => {
            const deck = report.decks[index]!;
            const name = `Channel ${index + 1}`;
            const set = (change: Partial<ChannelState>) => onChannel(index, change);
            return (
              <fieldset key={index} className="dj-channel" data-deck={index} aria-label={name}>
                <legend className="dj-channel-number">{index + 1}</legend>
                <span className="num dj-channel-bpm" aria-label={`${name} BPM`}>
                  {formatBpm(deck.effectiveBpm)}
                </span>
                <Knob
                  label={`${name} trim`}
                  caption="TRIM"
                  value={channel.trimDb}
                  min={-24}
                  max={12}
                  centre={0}
                  step={0.5}
                  format={db}
                  size={36}
                  onChange={(trimDb) => set({ trimDb })}
                />
                <div className="dj-channel-eq">
                  {EQ_BANDS.map((band) => {
                    const value = channel.eq[band.index];
                    const killed = value <= EQ_MIN_DB;
                    return (
                      <div key={band.name} className="dj-eq">
                        <Knob
                          label={`${name} ${band.label} EQ`}
                          caption={band.caption}
                          value={value}
                          min={EQ_MIN_DB}
                          max={EQ_MAX_DB}
                          centre={0}
                          step={0.5}
                          size={36}
                          format={(v) => (v <= EQ_MIN_DB && mixer.isolator ? "KILL" : db(v))}
                          tone={killed ? "var(--record)" : "var(--dj-knob-arc)"}
                          onChange={(v) => {
                            const eq = [...channel.eq] as ChannelState["eq"];
                            eq[band.index] = v;
                            set({ eq });
                          }}
                        />
                        <button
                          type="button"
                          className="dj-kill"
                          aria-pressed={killed}
                          aria-label={`Kill ${name} ${band.label}`}
                          onClick={() => {
                            const eq = [...channel.eq] as ChannelState["eq"];
                            eq[band.index] = killed ? 0 : EQ_MIN_DB;
                            set({ eq });
                          }}
                        >
                          KILL
                        </button>
                      </div>
                    );
                  })}
                </div>
                <Knob
                  label={`${name} compressor`}
                  caption="COMP"
                  value={channel.compression}
                  min={0}
                  max={1}
                  step={0.05}
                  size={36}
                  format={(v) => (v === 0 ? "OFF" : percent(v))}
                  onChange={(compression) => set({ compression })}
                />
                <span className="num dj-gr" aria-label={`${name} gain reduction`}>
                  {deck.gainReduction > 0.1 ? `GR −${deck.gainReduction.toFixed(1)}` : " "}
                </span>
                <Knob
                  label={`${name} Colour FX, ${COLOUR_FX[mixer.colourType]?.label ?? ""}`}
                  caption="COLOR"
                  value={channel.colour}
                  min={-1}
                  max={1}
                  centre={0}
                  step={0.05}
                  size={40}
                  format={(v) => (Math.abs(v) < 0.02 ? "OFF" : `${v < 0 ? "L" : "R"} ${percent(Math.abs(v))}`)}
                  tone="var(--dj-amber)"
                  onChange={(colour) => set({ colour })}
                />
                <button
                  type="button"
                  className="dj-hw-button dj-cue-button"
                  aria-pressed={channel.cue}
                  data-light={channel.cue ? "on" : undefined}
                  data-tone="amber"
                  aria-label={`Cue ${name} in the headphones`}
                  onClick={() => set({ cue: !channel.cue })}
                >
                  CUE
                </button>
                <div className="dj-fader-row">
                  <LevelMeter label={`${name} level`} level={deck.level} />
                  <div className="dj-fader-slot">
                    <input
                      type="range"
                      className="dj-channel-fader"
                      aria-label={`${name} fader`}
                      aria-valuetext={percent(channel.fader)}
                      min={0}
                      max={1}
                      step={0.01}
                      value={channel.fader}
                      onChange={(event) => set({ fader: Number(event.target.value) })}
                    />
                  </div>
                </div>
                <Switch label={`${name} fader curve`} options={CURVE_CAPTIONS} value={channel.curve} onChange={(curve) => set({ curve })} />
                <Switch label={`${name} crossfader assign`} options={ASSIGNS} value={channel.assign} onChange={(assign) => set({ assign })} />
              </fieldset>
            );
          })}
        </div>

        <div className="dj-mixer-side">
          <div className="dj-hw-section" role="group" aria-label="Master">
            <span className="dj-hw-caption">MASTER</span>
            <div className="dj-master-row">
              <Knob label="DJ master level" caption="MASTER" value={mixer.master} min={0} max={2} centre={1} step={0.02} format={gain} size={40} onChange={(master) => onMixer({ master })} />
              <Knob label="DJ booth level" caption="BOOTH" value={mixer.booth} min={0} max={2} centre={1} step={0.02} format={gain} size={40} onChange={(booth) => onMixer({ booth })} />
              <div className="dj-master-meters">
                <LevelMeter label="DJ master level, left" level={report.master[0]} />
                <LevelMeter label="DJ master level, right" level={report.master[1]} />
                <span className="dj-meter-lr" aria-hidden>
                  <span>L</span>
                  <span>R</span>
                </span>
              </div>
            </div>
          </div>

          <div className="dj-hw-section" role="group" aria-label="Headphones">
            <span className="dj-hw-caption">HEADPHONES</span>
            <div className="dj-master-row">
              <Knob
                label="Headphones cue and master mix"
                caption="MIXING"
                value={mixer.headphoneMix}
                min={0}
                max={1}
                centre={0.5}
                step={0.05}
                size={36}
                format={(v) => `CUE ${percent(1 - v)} · MST ${percent(v)}`}
                onChange={(headphoneMix) => onMixer({ headphoneMix })}
              />
              <Knob label="Headphones level" caption="LEVEL" value={mixer.headphoneLevel} min={0} max={2} centre={0.8} step={0.02} format={gain} size={36} onChange={(headphoneLevel) => onMixer({ headphoneLevel })} />
            </div>
            {props.headphoneOutput && <HeadphonePicker headphones={props.headphoneOutput} output={props.output ?? null} />}
            {props.headphoneOutput === null && (
              <p className="dj-hw-note">
                This browser can&apos;t choose a headphone device: the Desktop App, Chrome and Edge can.
              </p>
            )}
            <p className="dj-hw-note">
              {headphones
                ? "Outputs 3 and 4 play the cue too."
                : props.headphoneOutput
                  ? "Or choose outputs 3 and 4 of an audio interface as the main output."
                  : "The cue needs outputs 3 and 4 of an audio interface, or a second device; this output has two."}
            </p>
          </div>

          <div className="dj-hw-section" role="group" aria-label="Colour FX">
            <span className="dj-hw-caption">COLOR FX</span>
            <div className="dj-fx-buttons" role="radiogroup" aria-label="Colour FX type">
              {COLOUR_FX.map((colour, value) => (
                <button
                  key={colour.id}
                  type="button"
                  role="radio"
                  aria-checked={mixer.colourType === value}
                  aria-label={colour.label}
                  className="dj-hw-button dj-fx-button"
                  data-light={mixer.colourType === value ? "on" : undefined}
                  data-tone="amber"
                  onClick={() => onMixer({ colourType: value })}
                >
                  {colour.label.toUpperCase()}
                </button>
              ))}
            </div>
            <Knob
              label="Colour FX parameter"
              caption="PARAMETER"
              value={mixer.colourParameter}
              min={0}
              max={1}
              step={0.05}
              size={36}
              format={percent}
              onChange={(colourParameter) => onMixer({ colourParameter })}
            />
          </div>

          <div className="dj-hw-section dj-beat-fx" role="group" aria-label="Beat FX">
            <span className="dj-hw-caption">BEAT FX</span>
            <div className="dj-fx-display" role="status" aria-label="Beat FX display">
              <span className="dj-fx-name">{fx.label.toUpperCase()}</span>
              <span className="num dj-fx-division">{beatsLabel(mixer.beatFxDivision)}</span>
              <span className="num dj-fx-bpm">
                {formatBpm(report.masterBpm)} BPM {mixer.bpm > 0 ? "TAP" : "AUTO"}
              </span>
              <span className="dj-fx-target">{BEAT_FX_TARGETS[mixer.beatFxTarget]}</span>
            </div>
            <div className="dj-hw-row">
              <button
                type="button"
                className="dj-hw-button"
                aria-label="Previous Beat FX"
                onClick={() => onMixer({ beatFxType: (mixer.beatFxType + BEAT_FX.length - 1) % BEAT_FX.length })}
              >
                FX ◀
              </button>
              <button
                type="button"
                className="dj-hw-button"
                aria-label={`Next Beat FX, after ${fx.label}`}
                onClick={() => onMixer({ beatFxType: (mixer.beatFxType + 1) % BEAT_FX.length })}
              >
                FX ▶
              </button>
              <button
                type="button"
                className="dj-hw-button"
                aria-label="Shorter Beat FX division"
                disabled={division <= 0}
                onClick={() => onMixer({ beatFxDivision: BEAT_DIVISIONS[division - 1]! })}
              >
                ◀ BEAT
              </button>
              <button
                type="button"
                className="dj-hw-button"
                aria-label="Longer Beat FX division"
                disabled={division >= BEAT_DIVISIONS.length - 1}
                onClick={() => onMixer({ beatFxDivision: BEAT_DIVISIONS[division + 1]! })}
              >
                BEAT ▶
              </button>
            </div>
            <div className="dj-fx-targets" role="radiogroup" aria-label="Beat FX channel">
              {BEAT_FX_TARGETS.map((target, value) => (
                <button
                  key={target}
                  type="button"
                  role="radio"
                  aria-checked={mixer.beatFxTarget === value}
                  className="dj-switch-position"
                  onClick={() => onMixer({ beatFxTarget: value })}
                >
                  {target}
                </button>
              ))}
            </div>
            <div className="dj-master-row">
              <Knob label="Beat FX level and depth" caption="LEVEL/DEPTH" value={mixer.beatFxLevel} min={0} max={1} step={0.05} size={40} format={percent} onChange={(beatFxLevel) => onMixer({ beatFxLevel })} />
              <button
                type="button"
                className="dj-fx-lever"
                aria-label="Beat FX on"
                aria-pressed={mixer.beatFxOn}
                data-light={mixer.beatFxOn ? "blink" : undefined}
                onClick={() => onMixer({ beatFxOn: !mixer.beatFxOn })}
              >
                ON/OFF
              </button>
              <div className="dj-hw-column">
                <button
                  type="button"
                  className="dj-hw-button"
                  aria-label="Tap the Beat FX BPM"
                  onClick={() => {
                    const bpm = tap.current.tap(performance.now());
                    if (bpm) onMixer({ bpm });
                  }}
                >
                  TAP
                </button>
                <button type="button" className="dj-hw-button" aria-label="Beat FX BPM from the Sync Master" disabled={mixer.bpm === 0} onClick={() => onMixer({ bpm: 0 })}>
                  AUTO
                </button>
              </div>
            </div>
          </div>

          <div className="dj-hw-section" role="group" aria-label="Record">
            <span className="dj-hw-caption">REC</span>
            <div className="dj-hw-row">
              <button
                type="button"
                className="dj-hw-button dj-rec"
                aria-label={recording.on ? "Stop and save the recording" : "Record the mix"}
                aria-pressed={recording.on}
                data-light={recording.on ? "blink" : undefined}
                data-tone="red"
                disabled={!canPlay || recording.saving}
                onClick={() => props.onRecord(!recording.on)}
              >
                {recording.on ? "STOP & SAVE" : "● REC"}
              </button>
              <Switch
                label="Recording format"
                options={["WAV", "MP3"]}
                value={recording.format === "wav" ? 0 : 1}
                onChange={(value) => !recording.on && props.onRecordFormat(value === 0 ? "wav" : "mp3")}
              />
              <span className="num dj-hw-value" role="timer" aria-label="Recording time">
                {recording.saving ? "SAVING…" : formatTime(recording.seconds)}
              </span>
              {props.onAddToSong && (
                <button
                  type="button"
                  className="dj-hw-button"
                  data-tone="green"
                  aria-label="Add the recording to the song, on a new Audio Track"
                  disabled={!props.canAddToSong || recording.on || recording.saving}
                  onClick={props.onAddToSong}
                >
                  ADD TO SONG
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="dj-crossfader">
        <Switch label="Crossfader curve" options={XF_CAPTIONS} value={mixer.crossfaderCurve} onChange={(crossfaderCurve) => onMixer({ crossfaderCurve })} />
        <div className="dj-crossfader-slot">
          <span className="dj-hw-caption" aria-hidden>
            A
          </span>
          <input
            type="range"
            aria-label="Crossfader"
            aria-valuetext={mixer.crossfader === 0 ? "centre" : `${percent(Math.abs(mixer.crossfader))} to ${mixer.crossfader < 0 ? "A" : "B"}`}
            min={-1}
            max={1}
            step={0.01}
            value={mixer.crossfader}
            onChange={(event) => onMixer({ crossfader: Number(event.target.value) })}
            onDoubleClick={() => onMixer({ crossfader: 0 })}
          />
          <span className="dj-hw-caption" aria-hidden>
            B
          </span>
        </div>
        <button
          type="button"
          className="dj-hw-button"
          aria-label="Reverse the crossfader"
          aria-pressed={mixer.crossfaderReverse}
          data-light={mixer.crossfaderReverse ? "on" : undefined}
          onClick={() => onMixer({ crossfaderReverse: !mixer.crossfaderReverse })}
        >
          REVERSE
        </button>
      </div>
    </section>
  );
}
