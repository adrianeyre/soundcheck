import { Circle, Headphones, Square } from "lucide-react";
import { useRef, useState } from "react";

import {
  ASSIGNS,
  BEAT_DIVISIONS,
  BEAT_FX,
  BEAT_FX_TARGETS,
  beatsLabel,
  COLOUR_FX,
  CROSSFADER_CURVES,
  FADER_CURVES,
  formatBpm,
  formatTime,
  meterFraction,
  TapTempo,
} from "./dj-logic";
import type { DjReport } from "./dj-report";
import { type ChannelState, EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB, type MixerState } from "./dj-state";
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
  const segments = 15;
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
          data-zone={index >= segments - 1 ? "clip" : index >= segments - 4 ? "hot" : "ok"}
        />
      )).toReversed()}
    </div>
  );
}

export interface MixerPanelProps {
  channels: readonly ChannelState[];
  mixer: MixerState;
  report: DjReport;
  /** How many channels to show: one for each Deck on the page. */
  count: number;
  /** Whether the headphone cue can be heard on this output. */
  headphones: boolean;
  canPlay: boolean;
  onChannel: (index: number, change: Partial<ChannelState>) => void;
  onMixer: (change: Partial<MixerState>) => void;
  recording: { on: boolean; seconds: number; format: "wav" | "mp3"; saving: boolean };
  onRecordFormat: (format: "wav" | "mp3") => void;
  onRecord: (on: boolean) => void;
}

/**
 * The DJM-V10 / A9 mixer: a channel for each Deck (trim, four-band EQ or
 * isolator, compressor, Colour FX, cue, meter, fader and crossfader assign),
 * the Colour FX and Beat FX sections, the Master and booth, the headphones,
 * recording, and the crossfader. Knobs turn with the arrow keys, and every
 * fader is a slider.
 */
export function MixerPanel(props: MixerPanelProps) {
  const { channels, mixer, report, count, headphones, canPlay, onChannel, onMixer, recording } = props;
  const tap = useRef(new TapTempo());
  const division = BEAT_DIVISIONS.indexOf(mixer.beatFxDivision);

  return (
    <section className="dj-mixer" aria-label="Mixer">
      <div className="dj-channels" style={{ gridTemplateColumns: `repeat(${count}, minmax(84px, 1fr)) minmax(200px, 1.4fr)` }}>
        {channels.slice(0, count).map((channel, index) => {
          const deck = report.decks[index]!;
          const name = `Channel ${index + 1}`;
          const set = (change: Partial<ChannelState>) => onChannel(index, change);
          return (
            <fieldset key={index} className="dj-channel" aria-label={name}>
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
                onChange={(trimDb) => set({ trimDb })}
              />
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
                      format={(v) => (v <= EQ_MIN_DB && mixer.isolator ? "KILL" : db(v))}
                      tone={killed ? "var(--record)" : undefined}
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
              <Knob
                label={`${name} compressor`}
                caption="COMP"
                value={channel.compression}
                min={0}
                max={1}
                step={0.05}
                format={(v) => (v === 0 ? "OFF" : percent(v))}
                onChange={(compression) => set({ compression })}
              />
              <span className="hint num" aria-label={`${name} gain reduction`}>
                {deck.gainReduction > 0.1 ? `−${deck.gainReduction.toFixed(1)} dB` : " "}
              </span>
              <Knob
                label={`${name} Colour FX, ${COLOUR_FX[mixer.colourType]?.label ?? ""}`}
                caption="COLOR"
                value={channel.colour}
                min={-1}
                max={1}
                centre={0}
                step={0.05}
                format={(v) => (Math.abs(v) < 0.02 ? "OFF" : `${v < 0 ? "L" : "R"} ${percent(Math.abs(v))}`)}
                tone="var(--warning)"
                onChange={(colour) => set({ colour })}
              />
              <button
                type="button"
                className="dj-toggle dj-cue-button"
                aria-pressed={channel.cue}
                aria-label={`Cue ${name} in the headphones`}
                onClick={() => set({ cue: !channel.cue })}
              >
                <Headphones size={14} aria-hidden />
                CUE
              </button>
              <div className="dj-fader-row">
                <LevelMeter label={`${name} level`} level={deck.level} />
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
              <select aria-label={`${name} fader curve`} value={channel.curve} onChange={(event) => set({ curve: Number(event.target.value) })}>
                {FADER_CURVES.map((curve, value) => (
                  <option key={curve} value={value}>
                    {curve}
                  </option>
                ))}
              </select>
              <div className="dj-assign" role="radiogroup" aria-label={`${name} crossfader assign`}>
                {ASSIGNS.map((side, value) => (
                  <button
                    key={side}
                    type="button"
                    role="radio"
                    aria-checked={channel.assign === value}
                    className="dj-assign-button"
                    onClick={() => set({ assign: value })}
                  >
                    {side}
                  </button>
                ))}
              </div>
            </fieldset>
          );
        })}

        <div className="dj-master-section">
          <fieldset className="dj-group">
            <legend>Master</legend>
            <div className="row dj-master-row">
              <Knob label="DJ master level" caption="MASTER" value={mixer.master} min={0} max={2} centre={1} step={0.02} format={gain} onChange={(master) => onMixer({ master })} />
              <Knob label="DJ booth level" caption="BOOTH" value={mixer.booth} min={0} max={2} centre={1} step={0.02} format={gain} onChange={(booth) => onMixer({ booth })} />
              <LevelMeter label="DJ master level, left" level={report.master[0]} />
              <LevelMeter label="DJ master level, right" level={report.master[1]} />
            </div>
            <label className="field-inline">
              <input type="checkbox" checked={mixer.isolator} onChange={(event) => onMixer({ isolator: event.target.checked })} />
              EQ as isolator (full kill)
            </label>
          </fieldset>

          <fieldset className="dj-group">
            <legend>Colour FX</legend>
            <div className="dj-fx-buttons" role="radiogroup" aria-label="Colour FX">
              {COLOUR_FX.map((fx, value) => (
                <button key={fx.id} type="button" role="radio" aria-checked={mixer.colourType === value} className="dj-fx-button" onClick={() => onMixer({ colourType: value })}>
                  {fx.label}
                </button>
              ))}
            </div>
            <Knob
              label="Colour FX parameter"
              caption="PARAM"
              value={mixer.colourParameter}
              min={0}
              max={1}
              step={0.05}
              format={percent}
              onChange={(colourParameter) => onMixer({ colourParameter })}
            />
          </fieldset>

          <fieldset className="dj-group dj-beat-fx">
            <legend>Beat FX</legend>
            <div className="row">
              <select aria-label="Beat FX" value={mixer.beatFxType} onChange={(event) => onMixer({ beatFxType: Number(event.target.value) })}>
                {BEAT_FX.map((fx, value) => (
                  <option key={fx.id} value={value}>
                    {fx.label}
                  </option>
                ))}
              </select>
              <select aria-label="Beat FX channel" value={mixer.beatFxTarget} onChange={(event) => onMixer({ beatFxTarget: Number(event.target.value) })}>
                {BEAT_FX_TARGETS.map((target, value) => (
                  <option key={target} value={value}>
                    {target}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <button
                type="button"
                className="btn-sm"
                aria-label="Shorter Beat FX division"
                disabled={division <= 0}
                onClick={() => onMixer({ beatFxDivision: BEAT_DIVISIONS[division - 1]! })}
              >
                ◀
              </button>
              <span className="num dj-division" aria-label="Beat FX division">
                {beatsLabel(mixer.beatFxDivision)}
              </span>
              <button
                type="button"
                className="btn-sm"
                aria-label="Longer Beat FX division"
                disabled={division >= BEAT_DIVISIONS.length - 1}
                onClick={() => onMixer({ beatFxDivision: BEAT_DIVISIONS[division + 1]! })}
              >
                ▶
              </button>
              <Knob label="Beat FX level and depth" caption="LEVEL" value={mixer.beatFxLevel} min={0} max={1} step={0.05} format={percent} onChange={(beatFxLevel) => onMixer({ beatFxLevel })} />
              <button type="button" className="dj-toggle dj-fx-on" aria-pressed={mixer.beatFxOn} onClick={() => onMixer({ beatFxOn: !mixer.beatFxOn })}>
                ON
              </button>
            </div>
            <div className="row">
              <span className="num" aria-label="Beat FX BPM">
                {formatBpm(report.masterBpm)} BPM {mixer.bpm > 0 ? "(tapped)" : "(auto)"}
              </span>
              <button
                type="button"
                className="btn-sm"
                onClick={() => {
                  const bpm = tap.current.tap(performance.now());
                  if (bpm) onMixer({ bpm });
                }}
              >
                Tap
              </button>
              <button type="button" className="btn-sm" disabled={mixer.bpm === 0} onClick={() => onMixer({ bpm: 0 })}>
                Auto
              </button>
            </div>
          </fieldset>

          <fieldset className="dj-group">
            <legend>Headphones</legend>
            <div className="row">
              <Knob label="Headphones cue and master mix" caption="MIX" value={mixer.headphoneMix} min={0} max={1} centre={0.5} step={0.05} format={(v) => `CUE ${percent(1 - v)} · MST ${percent(v)}`} onChange={(headphoneMix) => onMixer({ headphoneMix })} />
              <Knob label="Headphones level" caption="LEVEL" value={mixer.headphoneLevel} min={0} max={2} centre={0.8} step={0.02} format={gain} onChange={(headphoneLevel) => onMixer({ headphoneLevel })} />
            </div>
            <p className="hint">
              {headphones
                ? "The headphone cue plays out of outputs 3 and 4."
                : "The headphone cue plays out of outputs 3 and 4 of an audio interface that has them; this output has two."}
            </p>
          </fieldset>

          <fieldset className="dj-group">
            <legend>Record</legend>
            <div className="row">
              <button
                type="button"
                className="btn-record"
                aria-pressed={recording.on}
                disabled={!canPlay || recording.saving}
                onClick={() => props.onRecord(!recording.on)}
              >
                {recording.on ? <Square size={14} aria-hidden /> : <Circle size={14} fill="currentColor" aria-hidden />}
                {recording.on ? "Stop and save" : "Record the mix"}
              </button>
              <select
                aria-label="Recording format"
                value={recording.format}
                disabled={recording.on}
                onChange={(event) => props.onRecordFormat(event.target.value as "wav" | "mp3")}
              >
                <option value="wav">WAV</option>
                <option value="mp3">MP3</option>
              </select>
              <span className="num" role="timer" aria-label="Recording time">
                {recording.saving ? "Saving…" : formatTime(recording.seconds)}
              </span>
            </div>
          </fieldset>
        </div>
      </div>

      <div className="dj-crossfader">
        <span aria-hidden>A</span>
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
        <span aria-hidden>B</span>
        <select aria-label="Crossfader curve" value={mixer.crossfaderCurve} onChange={(event) => onMixer({ crossfaderCurve: Number(event.target.value) })}>
          {CROSSFADER_CURVES.map((curve, value) => (
            <option key={curve} value={value}>
              {curve}
            </option>
          ))}
        </select>
        <label className="field-inline">
          <input type="checkbox" checked={mixer.crossfaderReverse} onChange={(event) => onMixer({ crossfaderReverse: event.target.checked })} />
          Reverse
        </label>
      </div>
    </section>
  );
}
