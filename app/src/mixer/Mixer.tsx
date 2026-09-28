import { ChevronLeft, ChevronRight, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Meters } from "../audio/audio-output";
import { InsertChainPanel } from "../effect/InsertChainPanel";
import type { Command } from "../project/commands";
import {
  type AutomatedSetting,
  type Automation,
  createBus,
  type Mixer as MixerSettings,
  type Output,
  type Project,
  type Send,
  trackKind,
  type TrackKind,
} from "../project/model";
import { type Channel as ChannelId, DEFAULT_SEND_LEVEL, routingProblem, sendProblem, silencedChannels } from "../project/routing";
import { LIMITS } from "../project/validate";
import { CLIP_GAIN, formatDb, gainToDb, levelFraction } from "./level";
import { holdPeak, type PeakHold } from "./MeterBridge";

const METER_HEIGHT = 120;

export interface MixerProps {
  project: Project;
  /** The engine's own peak levels, or null when no audio is running. */
  meters: Meters | null;
  onTrackMixer: (trackId: string, mixer: Partial<MixerSettings>) => void;
  onMasterVolume: (volume: number) => void;
  /** Edits to an Insert Chain, as Project commands so they undo. */
  onCommand: (command: Command) => void;
}

/**
 * The mixer: one channel per Track, then one per Bus, then the Master. Each
 * Track and Bus feeds the Master or a Bus, chosen on its strip, and can send
 * to more Buses after its fader, each at its own level. Every control
 * writes to the Project through a command, and the meters only show what the
 * Audio Engine measured — the UI never looks at audio itself. Each channel's
 * FX button opens its Insert Chain below the strips.
 */
export function Mixer({ project, meters, onTrackMixer, onMasterVolume, onCommand }: MixerProps) {
  // The Track or Bus whose Insert Chain is open, "master", or null for none.
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (chain: string) => setOpen((current) => (current === chain ? null : chain));
  const openTrack = project.tracks.find((track) => track.id === open);
  const openBus = project.buses.find((bus) => bus.id === open);
  // Meters come back in engine-Track and engine-Bus order, which is the
  // Track list's and the Bus list's.
  const silenced = silencedChannels(project);
  const meterOf = (index: number) => meters?.tracks[index] ?? 0;
  const addBus = () => {
    const names = new Set(project.buses.map((bus) => bus.name));
    let number = project.buses.length + 1;
    while (names.has(`Bus ${number}`)) number++;
    onCommand({ type: "addBus", bus: createBus(`Bus ${number}`) });
  };
  const outputPicker = (name: string, channel: ChannelId, output: Output, choose: (output: Output) => void) => (
    <OutputPicker project={project} name={name} channel={channel} output={output} onChange={choose} />
  );
  const sendsOf = (name: string, from: ChannelId, sends: readonly Send[], automation: readonly Automation[]) => (
    <Sends
      project={project}
      name={name}
      from={from}
      sends={sends}
      automated={automation.map((lane) => lane.setting)}
      onCommand={onCommand}
    />
  );

  return (
    <section aria-labelledby="mixer-heading" className="panel">
      <div className="panel-head">
        <h2 id="mixer-heading">
          <SlidersHorizontal size={18} aria-hidden />
          Mixer
        </h2>
        <button type="button" className="btn-sm" onClick={addBus}>
          <Plus size={14} aria-hidden />
          Add Bus
        </button>
      </div>
      <ol aria-label="Mixer channels" className="mixer-strips">
        {project.tracks.map((track, index) => (
          <li key={track.id}>
            <Channel
              name={track.name}
              trackKind={trackKind(track)}
              mixer={track.mixer}
              automated={track.automation.map((lane) => lane.setting)}
              level={meterOf(index)}
              silenced={silenced.has(track.id)}
              onChange={(change) => onTrackMixer(track.id, change)}
              effects={track.insertChain.length}
              chainOpen={open === track.id}
              onChain={() => toggle(track.id)}
              output={outputPicker(track.name, { trackId: track.id }, track.output, (output) =>
                onCommand({ type: "setTrackOutput", trackId: track.id, output }),
              )}
              sends={sendsOf(track.name, { trackId: track.id }, track.sends, track.automation)}
            />
          </li>
        ))}
        {project.buses.map((bus, index) => (
          <li key={bus.id}>
            <Channel
              name={bus.name}
              bus
              mixer={bus.mixer}
              automated={bus.automation.map((lane) => lane.setting)}
              level={meters?.buses?.[index] ?? 0}
              silenced={silenced.has(bus.id)}
              onChange={(mixer) => onCommand({ type: "setBusMixer", busId: bus.id, mixer })}
              effects={bus.insertChain.length}
              chainOpen={open === bus.id}
              onChain={() => toggle(bus.id)}
              output={outputPicker(bus.name, { busId: bus.id }, bus.output, (output) =>
                onCommand({ type: "setBusOutput", busId: bus.id, output }),
              )}
              sends={sendsOf(bus.name, { busId: bus.id }, bus.sends, bus.automation)}
              onRename={(name) => onCommand({ type: "renameBus", busId: bus.id, name })}
              onDelete={() => onCommand({ type: "deleteBus", busId: bus.id })}
              // Its place among the Buses, which the Timeline lists them in too.
              onMove={(by) => onCommand({ type: "moveBus", busId: bus.id, index: index + by })}
              place={{ index, count: project.buses.length }}
            />
          </li>
        ))}
        <li>
          <Channel
            name="Master"
            master
            mixer={{ volume: project.master.volume, pan: 0, mute: false, solo: false }}
            automated={project.master.automation.map((lane) => lane.setting)}
            level={meters?.master ?? 0}
            silenced={false}
            onChange={({ volume }) => volume !== undefined && onMasterVolume(volume)}
            effects={project.master.insertChain.length}
            chainOpen={open === "master"}
            onChain={() => toggle("master")}
          />
        </li>
      </ol>
      {openTrack && (
        <InsertChainPanel
          name={openTrack.name}
          target={{ trackId: openTrack.id }}
          chain={openTrack.insertChain}
          onCommand={onCommand}
          gainReduction={meters?.gainReduction?.tracks[project.tracks.indexOf(openTrack)]}
        />
      )}
      {openBus && (
        <InsertChainPanel
          name={openBus.name}
          target={{ busId: openBus.id }}
          chain={openBus.insertChain}
          onCommand={onCommand}
          gainReduction={meters?.gainReduction?.buses?.[project.buses.indexOf(openBus)]}
        />
      )}
      {open === "master" && (
        <InsertChainPanel
          name="Master"
          target="master"
          chain={project.master.insertChain}
          onCommand={onCommand}
          gainReduction={meters?.gainReduction?.master}
        />
      )}
    </section>
  );
}

interface OutputPickerProps {
  project: Project;
  name: string;
  channel: ChannelId;
  output: Output;
  onChange: (output: Output) => void;
}

/**
 * Where a Track or Bus sends its signal: the Master or a Bus. A Bus that
 * would make a loop is offered but can't be chosen, and says why.
 */
function OutputPicker({ project, name, channel, output, onChange }: OutputPickerProps) {
  const own = "busId" in channel ? channel.busId : null;
  return (
    <label className="param">
      <span>Output</span>
      <select
        aria-label={`${name} output`}
        value={output ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">Master</option>
        {project.buses
          .filter((bus) => bus.id !== own)
          .map((bus) => {
            const problem = routingProblem(project, channel, bus.id);
            return (
              <option key={bus.id} value={bus.id} disabled={problem !== null} title={problem ?? undefined}>
                {problem ? `${bus.name} (would loop)` : bus.name}
              </option>
            );
          })}
      </select>
    </label>
  );
}

interface SendsProps {
  project: Project;
  name: string;
  from: ChannelId;
  sends: readonly Send[];
  /** The owner's automated settings: a Send's level may be one. */
  automated: readonly AutomatedSetting[];
  onCommand: (command: Command) => void;
}

/**
 * A Track's or Bus's Sends: each to a Bus, after the fader, at a level of its
 * own. A Bus it can't send to, because that would make a loop or it already
 * sends there, is offered but can't be chosen, and says why.
 */
function Sends({ project, name, from, sends, automated, onCommand }: SendsProps) {
  const own = "busId" in from ? from.busId : null;
  const targets = project.buses.filter((bus) => bus.id !== own);
  if (targets.length === 0 && sends.length === 0) return null;
  const busName = (busId: string) => project.buses.find((bus) => bus.id === busId)?.name ?? busId;
  const [minLevel, maxLevel] = LIMITS.volume;
  return (
    <div className="sends">
      {sends.map((send) => {
        const label = `${name} Send to ${busName(send.busId)}`;
        return (
          <div key={send.busId} className="param">
            <span className="strip-row">
              <span>
                {busName(send.busId)} <span className="num">{formatDb(send.level)}</span>
                {automated.includes(`send:${send.busId}`) && (
                  <>
                    {" "}
                    <span className="automated" title="Its Automation overrides this while the song plays">
                      Automated
                    </span>
                  </>
                )}
              </span>
              <button
                type="button"
                className="btn-sm btn-icon"
                aria-label={`Remove ${label}`}
                title="Remove Send"
                onClick={() => onCommand({ type: "removeSend", from, busId: send.busId })}
              >
                <X size={14} aria-hidden />
              </button>
            </span>
            <input
              type="range"
              aria-label={`${label} level`}
              aria-valuetext={formatDb(send.level)}
              min={minLevel}
              max={maxLevel}
              step={0.01}
              value={send.level}
              onChange={(event) =>
                onCommand({ type: "setSendLevel", from, busId: send.busId, level: Number(event.target.value) })
              }
            />
          </div>
        );
      })}
      {targets.length > 0 && (
        <select
          aria-label={`${name} add Send`}
          value=""
          onChange={(event) =>
            event.target.value !== "" &&
            onCommand({ type: "addSend", from, busId: event.target.value, level: DEFAULT_SEND_LEVEL })
          }
        >
          <option value="">Add Send…</option>
          {targets.map((bus) => {
            const problem = sendProblem(project, from, bus.id);
            const already = sends.some((send) => send.busId === bus.id);
            return (
              <option key={bus.id} value={bus.id} disabled={problem !== null} title={problem ?? undefined}>
                {problem && !already ? `${bus.name} (would loop)` : bus.name}
              </option>
            );
          })}
        </select>
      )}
    </div>
  );
}

interface ChannelProps {
  name: string;
  /** Whether it is the Master's strip, which feeds nothing else. */
  master?: boolean;
  /** Whether it is a Bus's strip, which is renamed and deleted here. */
  bus?: boolean;
  mixer: MixerSettings;
  /** The settings Automation moves while the song plays, overriding these. */
  automated?: readonly AutomatedSetting[];
  level: number;
  silenced: boolean;
  onChange: (mixer: Partial<MixerSettings>) => void;
  /** How many Effects its Insert Chain holds. */
  effects: number;
  chainOpen: boolean;
  onChain: () => void;
  /** Where it sends its signal; the Master has none. */
  output?: ReactNode;
  /** Its Sends to Buses; the Master has none. */
  sends?: ReactNode;
  /** A Track's kind, whose coloured stripe its strip has down its left edge; a Bus and the Master have none. */
  trackKind?: TrackKind;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  /** Moves a Bus's strip one place left (-1) or right (1) among the Buses; the Master stays last. */
  onMove?: (by: -1 | 1) => void;
  /** A Bus's place among the Buses, which says whether it can move left or right. */
  place?: { index: number; count: number };
}

/** One channel strip: fader, pan, mute, solo, meter, Insert Chain, output and Sends. */
function Channel(props: ChannelProps) {
  const { name, master = false, bus = false, mixer, level, silenced, onChange, effects, chainOpen, onChain, output, sends } = props;
  const [minVolume, maxVolume] = LIMITS.volume;
  const automated = props.automated ?? [];
  const note = (setting: AutomatedSetting) =>
    automated.includes(setting) && (
      <span className="automated" title="Its Automation overrides this while the song plays">
        Automated
      </span>
    );
  return (
    <div
      className={props.trackKind ? "strip kind-stripe" : "strip"}
      data-master={master}
      data-bus={bus}
      data-track-kind={props.trackKind}
      style={{ opacity: silenced ? 0.5 : 1 }}
    >
      {bus && props.onRename ? (
        <BusName name={name} onRename={props.onRename} />
      ) : (
        <strong className="strip-name" title={name}>
          {name}
        </strong>
      )}
      <div className="strip-row">
        <input
          type="range"
          aria-label={`${name} volume`}
          aria-valuetext={formatDb(mixer.volume)}
          min={minVolume}
          max={maxVolume}
          step={0.01}
          value={mixer.volume}
          // Vertical faders in the browser need a transform; a horizontal
          // one reads the same to a screen reader and to a mouse.
          onChange={(event) => onChange({ volume: Number(event.target.value) })}
          style={{ width: "100%", minWidth: 0 }}
        />
        <Meter name={name} level={level} />
      </div>
      <span className="num">{formatDb(mixer.volume)}</span>
      {note("volume")}
      <button
        type="button"
        className="btn-sm"
        aria-label={`FX${effects > 0 ? ` (${effects})` : ""}: ${name} Insert Chain`}
        aria-pressed={chainOpen}
        onClick={onChain}
      >
        FX{effects > 0 ? ` (${effects})` : ""}
      </button>
      {!master && (
        <>
          <label className="param">
            <span className="pan-label">
              <PanDial pan={mixer.pan} />
              Pan <span className="num">{panText(mixer.pan)}</span> {note("pan")}
            </span>
            <input
              type="range"
              aria-label={`${name} pan`}
              aria-valuetext={panText(mixer.pan)}
              min={LIMITS.pan[0]}
              max={LIMITS.pan[1]}
              step={0.01}
              value={mixer.pan}
              onChange={(event) => onChange({ pan: Number(event.target.value) })}
            />
          </label>
          <div className="strip-row">
            <button
              type="button"
              className="btn-sm btn-mute"
              aria-label={`Mute ${name}`}
              title="Mute"
              aria-pressed={mixer.mute}
              onClick={() => onChange({ mute: !mixer.mute })}
            >
              M
            </button>
            <button
              type="button"
              className="btn-sm btn-solo"
              aria-label={`Solo ${name}`}
              title="Solo"
              aria-pressed={mixer.solo}
              onClick={() => onChange({ solo: !mixer.solo })}
            >
              S
            </button>
          </div>
          {output}
          {sends}
          {bus && props.onMove && props.place && (
            <div className="strip-row">
              <button
                type="button"
                className="btn-sm btn-icon"
                aria-label={`Move ${name} left`}
                title="Move left"
                disabled={props.place.index === 0}
                onClick={() => props.onMove?.(-1)}
              >
                <ChevronLeft size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="btn-sm btn-icon"
                aria-label={`Move ${name} right`}
                title="Move right"
                disabled={props.place.index === props.place.count - 1}
                onClick={() => props.onMove?.(1)}
              >
                <ChevronRight size={14} aria-hidden />
              </button>
            </div>
          )}
          {bus && props.onDelete && (
            <button type="button" className="btn-sm" aria-label={`Delete ${name}`} title="Delete Bus" onClick={props.onDelete}>
              <Trash2 size={14} aria-hidden />
            </button>
          )}
          {silenced && <span className="hint">Silent</span>}
        </>
      )}
    </div>
  );
}

/** A Bus's name, edited in place; the change is sent when it's committed. */
function BusName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  const [shown, setShown] = useState(name);
  // A rename from elsewhere (undo, the Assistant) replaces the draft.
  if (shown !== name) {
    setShown(name);
    setDraft(name);
  }
  const commit = () => {
    if (draft.trim() === "") setDraft(name);
    else if (draft !== name) onRename(draft);
  };
  return (
    <input
      className="strip-name"
      aria-label={`${name} name`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(name);
      }}
    />
  );
}

const METER_TICKS_DB = [0, -12, -24, -48];

/**
 * A peak meter, showing exactly what the engine measured, green to amber to
 * red up its scale, with the loudest recent peak held as a line and the
 * decibels marked beside it.
 */
function Meter({ name, level }: { name: string; level: number }) {
  const clipping = level >= CLIP_GAIN;
  const [peak, setPeak] = useState<PeakHold>({ db: -Infinity, age: 0 });
  const [seen, setSeen] = useState(level);
  if (seen !== level) {
    setSeen(level);
    setPeak((held) => holdPeak(held, gainToDb(level)));
  }
  const peakFraction = Number.isFinite(peak.db) ? levelFraction(10 ** (peak.db / 20)) : 0;
  return (
    <div className="meter-with-scale">
      <div
        role="meter"
        aria-label={`${name} level`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(levelFraction(level).toFixed(3))}
        aria-valuetext={clipping ? `${formatDb(level)}, clipping` : formatDb(level)}
        className="meter"
        data-clipping={clipping}
        style={{ width: 12, height: METER_HEIGHT }}
      >
        <div
          aria-hidden
          className="meter-fill meter-gradient"
          style={{ bottom: 0, width: "100%", height: `${levelFraction(level) * 100}%`, backgroundSize: `100% ${METER_HEIGHT}px` }}
        />
        {peakFraction > 0 && <div aria-hidden className="meter-peak" style={{ bottom: `${peakFraction * 100}%` }} />}
      </div>
      <div className="meter-ticks" aria-hidden style={{ height: METER_HEIGHT }}>
        {METER_TICKS_DB.map((db) => (
          <span key={db} style={{ bottom: `${levelFraction(10 ** (db / 20)) * 100}%` }}>
            {db}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Where the pan sits, as a knob's pointer on an arc from hard left to hard right. */
function PanDial({ pan }: { pan: number }) {
  const angle = (pan * 135 * Math.PI) / 180;
  const [cx, cy, r] = [14, 14, 11];
  const arc = (from: number, to: number) => {
    const point = (a: number) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
    return `M${point(from)} A${r},${r} 0 ${Math.abs(to - from) > Math.PI ? 1 : 0} ${to > from ? 1 : 0} ${point(to)}`;
  };
  return (
    <svg aria-hidden className="pan-dial" width={28} height={28} viewBox="0 0 28 28">
      <path d={arc((-135 * Math.PI) / 180, (135 * Math.PI) / 180)} fill="none" stroke="var(--lane-line)" strokeWidth={3} />
      {pan !== 0 && <path d={arc(0, angle)} fill="none" stroke="var(--primary)" strokeWidth={3} />}
      <line x1={cx} y1={cy} x2={cx + r * Math.sin(angle)} y2={cy - r * Math.cos(angle)} stroke="var(--text)" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

/** Where a Track sits between the speakers, as the strip labels it. */
function panText(pan: number): string {
  if (pan === 0) return "Centre";
  const side = pan < 0 ? "L" : "R";
  return `${side}${Math.round(Math.abs(pan) * 100)}`;
}
