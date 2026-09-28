import { FileAudio, Piano, Search, X } from "lucide-react";
import { useId, useState, type DragEvent } from "react";

import { PresetActions, PresetSelect } from "../preset/PresetControls";
import type { ListedPreset } from "../preset/preset-library";
import { KEYS_PARAMS, noteName, type KeysParam, type KeysSettings } from "./keys-params";
import { KEYS_CATEGORIES, KEYS_PRESETS, type KeysCategory } from "./keys-presets";

export interface KeysPanelProps {
  trackName: string;
  preset: string | null;
  settings: KeysSettings;
  /** The name of the sample the Keys play, or null for none. */
  sampleName: string | null;
  /** Only the settings given change. */
  onChange: (settings: Partial<KeysSettings>) => void;
  /** Load one of the Keys' Presets, Factory or User. */
  onPreset: (preset: ListedPreset) => void;
  /** Play `file` across the keyboard, from the root note. */
  onLoadSample: (file: File) => void;
  /** Take the sample off; the Keys go back to the piano. */
  onClearSample: () => void;
  /** A file dropped from the sample browser, where there is one. */
  onDropSample?: (transfer: DataTransfer) => void;
}

/** The settings each group of controls holds, in the order the panel lists them; the piano's only where it plays. */
const GROUPS: readonly { title: string; piano: boolean; names: readonly (keyof KeysSettings)[] }[] = [
  { title: "Hammer and strings", piano: true, names: ["brightness", "hammerPosition", "hammerNoise", "strings", "detune", "partials", "inharmonicity"] },
  { title: "Envelope", piano: false, names: ["attack", "decay", "highDamping", "release"] },
  { title: "Tines and drive", piano: true, names: ["bell", "bellRatio", "bellDecay", "drive"] },
  { title: "Tone and motion", piano: false, names: ["toneHz", "tremoloDepth", "tremoloRateHz", "tremoloStereo", "width"] },
  { title: "Playing", piano: false, names: ["velocitySense", "voices", "level"] },
];

/** The settings only the piano model uses, so the sample source leaves them out. */
const PIANO_ONLY = new Set<keyof KeysSettings>(["decay", "highDamping"]);

const PARAMS = new Map(KEYS_PARAMS.map((param) => [param.name, param]));

/** Every MIDI note, for the root note picker. */
const NOTES = Array.from({ length: 128 }, (_, note) => note);

/**
 * The Keys: pick a piano from their 33 factory sounds, or play a sample of
 * your own at each key's pitch, then shape either with the controls below.
 *
 * The sound browser lists the factory Presets as cards, by category, with a
 * search; the picker beside the heading holds the User Presets too. The
 * sample side takes a WAV from a file or the sample browser, and a root
 * note: the key that plays it as recorded.
 */
export function KeysPanel({
  trackName,
  preset,
  settings,
  sampleName,
  onChange,
  onPreset,
  onLoadSample,
  onClearSample,
  onDropSample,
}: KeysPanelProps) {
  const ids = useId();
  const [category, setCategory] = useState<KeysCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const piano = settings.source === "piano";
  const found = query.trim().toLowerCase();
  const shown = KEYS_PRESETS.filter(
    (each) =>
      (category === "all" || each.category === category) &&
      (!found || `${each.name} ${each.description}`.toLowerCase().includes(found)),
  );

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) onLoadSample(file);
    else onDropSample?.(event.dataTransfer);
  };

  return (
    <section aria-label={`${trackName} Keys`} className="panel keys-panel">
      <div className="panel-head">
        <h2 className="kind-stripe" data-track-kind="instrument">
          <Piano size={18} aria-hidden />
          Keys — {trackName}
          {piano && preset ? ` (${preset})` : ""}
        </h2>
        <div className="row">
          <PresetSelect
            target="keys"
            label={`${trackName} Keys preset`}
            value={piano ? preset : null}
            placeholder={piano ? "All presets…" : "Load a piano preset…"}
            onPick={onPreset}
          />
          <PresetActions target="keys" label={`${trackName} Keys`} settings={settings} />
        </div>
      </div>

      <fieldset className="stack keys-source">
        <legend className="field-legend">Sound source</legend>
        <div className="choice-group">
          <label className="choice">
            <input type="radio" name={`${ids}-source`} checked={piano} onChange={() => onChange({ source: "piano" })} />
            <Piano size={16} aria-hidden />
            Piano sounds
          </label>
          <label className="choice">
            <input type="radio" name={`${ids}-source`} checked={!piano} onChange={() => onChange({ source: "sample" })} />
            <FileAudio size={16} aria-hidden />
            Your sample
          </label>
        </div>
      </fieldset>

      {piano ? (
        <div className="stack">
          <div className="row keys-browser-bar">
            <div role="radiogroup" aria-label="Sound category" className="keys-categories">
              {[{ id: "all" as const, name: "All" }, ...KEYS_CATEGORIES].map((each) => (
                <button
                  key={each.id}
                  type="button"
                  role="radio"
                  aria-checked={category === each.id}
                  className="keys-category"
                  data-category={each.id}
                  onClick={() => setCategory(each.id)}
                >
                  {each.name}
                </button>
              ))}
            </div>
            <label className="keys-search">
              <Search size={16} aria-hidden />
              <span className="visually-hidden">Find a piano sound</span>
              <input type="search" value={query} placeholder="Find a sound" onChange={(event) => setQuery(event.target.value)} />
            </label>
          </div>
          <ul className="keys-browser" aria-label="Piano sounds">
            {shown.map((each) => (
              <li key={each.name}>
                <button
                  type="button"
                  className="keys-preset"
                  data-category={each.category}
                  aria-pressed={preset === each.name}
                  onClick={() => onPreset({ ...each, source: "factory" })}
                >
                  <span className="keys-preset-name">{each.name}</span>
                  <span className="keys-preset-description">{each.description}</span>
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 && (
            <p className="hint">
              No sound matches “{query}”.{" "}
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  setQuery("");
                  setCategory("all");
                }}
              >
                Show them all
              </button>
            </p>
          )}
        </div>
      ) : (
        <div className="stack">
          <div
            className="keys-drop"
            data-dragging={dragging}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
          >
            <FileAudio size={20} aria-hidden />
            <div className="stack keys-drop-text">
              <strong>{sampleName ?? "No sample yet"}</strong>
              <span className="hint">
                {sampleName
                  ? "Each key plays it at its own pitch; the root note plays it as recorded."
                  : "Drop a WAV here, or from the sample browser, or choose one."}
              </span>
            </div>
            <label className="keys-file">
              Choose a WAV…
              <input
                type="file"
                accept=".wav,audio/wav,audio/x-wav"
                className="visually-hidden"
                aria-label={`${trackName} Keys sample`}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onLoadSample(file);
                  event.target.value = "";
                }}
              />
            </label>
            {sampleName && (
              <button type="button" className="btn-ghost btn-sm" onClick={onClearSample}>
                <X size={14} aria-hidden />
                Remove sample
              </button>
            )}
          </div>
          <label className="field-inline">
            Root note
            <select
              aria-describedby={`${ids}-root-help`}
              value={settings.rootNote}
              onChange={(event) => onChange({ rootNote: Number(event.target.value) })}
            >
              {NOTES.map((note) => (
                <option key={note} value={note}>
                  {noteName(note)}
                  {note === 60 ? " (middle C)" : ""}
                </option>
              ))}
            </select>
          </label>
          <p id={`${ids}-root-help`} className="hint">
            The note the sample was recorded at: the key that plays it back unchanged. Keys above play it higher and faster, keys below lower and
            slower. To play only the Song Key&apos;s notes, tick <strong>Only the key&apos;s notes</strong> on the Keyboard.
          </p>
        </div>
      )}

      {GROUPS.filter((group) => piano || !group.piano).map((group, index) => (
        <details key={group.title} className="keys-group" open={index === 0}>
          <summary>{group.title}</summary>
          <div className="param-grid">
            {group.names
              .filter((name) => piano || !PIANO_ONLY.has(name))
              .map((name) => (
                <Control key={name} param={PARAMS.get(name)!} settings={settings} onChange={onChange} />
              ))}
          </div>
        </details>
      ))}
    </section>
  );
}

function Control({ param, settings, onChange }: { param: KeysParam; settings: KeysSettings; onChange: (settings: Partial<KeysSettings>) => void }) {
  const value = settings[param.name] as number;
  return (
    <label className="param">
      <span className="num">
        {param.label}: {readable(value)}
        {param.unit && ` ${param.unit}`}
      </span>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={param.step > 0 ? param.step : "any"}
        value={value}
        onChange={(event) => onChange({ [param.name]: Number(event.target.value) } as Partial<KeysSettings>)}
      />
    </label>
  );
}

/** Enough decimals to read a setting, without a long tail of them. */
function readable(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
