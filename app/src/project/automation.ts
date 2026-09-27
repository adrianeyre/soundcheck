/**
 * What each Track, Bus and the Master can automate: its volume, its pan
 * (not the Master's), its Sends' levels, the numeric settings of the
 * Effects on its Insert Chain and, on an Instrument Track, its Instrument's
 * numeric settings: the Synth's, a Plugin Instrument's, or each Drum Sampler
 * Pad's volume, pan and pitch. Mute, solo, bypass and settings that pick
 * from a list or switch on and off (a Pad's note and choke group among
 * them) stay where they are set.
 */
import { effectName, effectTable, isMissingPlugin } from "../effect/effect-table";
import { instrumentName, isMissingInstrument, pluginInstrumentTable } from "../instrument/instrument-table";
import { SYNTH_PARAMS } from "../instrument/synth-params";
import type { AutomatedSetting, Automation, Bus, DrumPad, Master, Project, Track } from "./model";

/** Whose Automation: a Track, a Bus or the Master. */
export type AutomationOwner = Track | Bus | Master;

/** One setting an owner can automate, and the range its breakpoints take. */
export interface AutomatableSetting {
  setting: AutomatedSetting;
  /** What the musician calls it: "Volume", "Send to Band", "EQ: Low gain". */
  label: string;
  /** Shown after a value, or "" when the setting has no unit. */
  unit: string;
  min: number;
  max: number;
  /** The value it keeps where it isn't automated. */
  fixed: number;
}

/** A setting's parts: its kind and, for a Send, Effect or Instrument, what. */
export type ParsedSetting =
  | { kind: "volume" | "pan" }
  | { kind: "send"; busId: string }
  | { kind: "effect"; effectId: string; param: string }
  | { kind: "instrument"; param: string };

export function parseSetting(setting: string): ParsedSetting | undefined {
  if (setting === "volume" || setting === "pan") return { kind: setting };
  const [kind, first, second, ...rest] = setting.split(":");
  if (rest.length > 0 || !first) return undefined;
  if (kind === "send" && second === undefined) return { kind, busId: first };
  if (kind === "effect" && second) return { kind, effectId: first, param: second };
  if (kind === "instrument" && second === undefined) return { kind, param: first };
  return undefined;
}

/** A Drum Sampler Pad's numbers, which Automation can move, in the order it keeps them. */
export const PAD_PARAMS = [
  { name: "volume", label: "Volume", unit: "", min: 0, max: 2 },
  { name: "pan", label: "Pan", unit: "", min: -1, max: 1 },
  { name: "pitch", label: "Pitch", unit: "st", min: -24, max: 24 },
] as const satisfies readonly { name: keyof DrumPad; label: string; unit: string; min: number; max: number }[];

export type PadParam = (typeof PAD_PARAMS)[number]["name"];

/**
 * The Instrument setting that is a Pad's number: `pad<note>.<setting>`, by
 * the note that plays the Pad, which no other Pad of its Drum Sampler has,
 * so its Automation stays with it however the Pads are listed.
 */
export function padSetting(note: number, param: PadParam): AutomatedSetting {
  return `instrument:pad${note}.${param}`;
}

/** The Pad's note and setting that an Instrument setting names, if it names one. */
export function parsePadSetting(param: string): { note: number; param: PadParam } | undefined {
  const match = /^pad(\d{1,3})\.([a-z]+)$/.exec(param);
  const found = PAD_PARAMS.find((candidate) => candidate.name === match?.[2]);
  return match && found ? { note: Number(match[1]), param: found.name } : undefined;
}

export function isMaster(owner: AutomationOwner): owner is Master {
  return !("mixer" in owner);
}

/** Everything `owner` can automate, in the order an Automation list keeps. */
export function automatableSettings(project: Pick<Project, "buses">, owner: AutomationOwner): AutomatableSetting[] {
  const settings: AutomatableSetting[] = [];
  if (isMaster(owner)) {
    settings.push({ setting: "volume", label: "Volume", unit: "", min: 0, max: 2, fixed: owner.volume });
  } else {
    settings.push(
      { setting: "volume", label: "Volume", unit: "", min: 0, max: 2, fixed: owner.mixer.volume },
      { setting: "pan", label: "Pan", unit: "", min: -1, max: 1, fixed: owner.mixer.pan },
    );
    for (const send of owner.sends) {
      const bus = project.buses.find((candidate) => candidate.id === send.busId);
      settings.push({
        setting: `send:${send.busId}`,
        label: `Send to ${bus?.name ?? send.busId}`,
        unit: "",
        min: 0,
        max: 2,
        fixed: send.level,
      });
    }
  }
  for (const [index, effect] of owner.insertChain.entries()) {
    const name = effectName(effect);
    const twin = owner.insertChain.some((other) => other !== effect && effectName(other) === name);
    const label = twin ? `${name} ${index + 1}` : name;
    const values = effect.settings as unknown as Record<string, unknown>;
    if (isMissingPlugin(effect)) {
      settings.push(...missingPluginSettings(owner, `effect:${effect.id}:`, label, effect.settings));
      continue;
    }
    for (const param of effectTable(effect)) {
      if (param.choices.length > 0) continue;
      settings.push({
        setting: `effect:${effect.id}:${param.name}`,
        label: `${label}: ${param.label}`,
        unit: param.unit,
        min: param.min,
        max: param.max,
        fixed: (values[param.name] as number | undefined) ?? param.default,
      });
    }
  }
  if ("kind" in owner && owner.kind === "instrument" && owner.instrument.type === "plugin") {
    const instrument = owner.instrument;
    const name = instrumentName(instrument);
    if (isMissingInstrument(instrument)) {
      settings.push(...missingPluginSettings(owner, "instrument:", name, instrument.settings));
    }
    for (const param of pluginInstrumentTable(instrument)) {
      settings.push({
        setting: `instrument:${param.name}`,
        label: `${name}: ${param.label}`,
        unit: param.unit,
        min: param.min,
        max: param.max,
        fixed: instrument.settings[param.name] ?? param.default,
      });
    }
  }
  if ("kind" in owner && owner.kind === "instrument" && owner.instrument.type === "drumSampler") {
    const { pads } = owner.instrument;
    for (const pad of pads) {
      const twin = pads.some((other) => other !== pad && other.name === pad.name);
      const name = twin ? `${pad.name} ${pad.note}` : pad.name;
      for (const param of PAD_PARAMS) {
        settings.push({
          setting: padSetting(pad.note, param.name),
          label: `${name}: ${param.label}`,
          unit: param.unit,
          min: param.min,
          max: param.max,
          fixed: pad[param.name],
        });
      }
    }
  }
  if ("kind" in owner && owner.kind === "instrument" && owner.instrument.type === "synth") {
    const values = owner.instrument.settings as unknown as Record<string, unknown>;
    for (const param of SYNTH_PARAMS) {
      if (param.choices.length > 0) continue;
      settings.push({
        setting: `instrument:${param.name}`,
        label: `Synth: ${param.label}`,
        unit: param.unit,
        min: param.min,
        max: param.max,
        fixed: values[param.name] as number,
      });
    }
  }
  return settings;
}

/**
 * A missing Plugin's settings: nothing says what they may be, so each keeps
 * the range its fixed value and Automation already span, and its Automation
 * is kept exactly until the Plugin is installed.
 */
function missingPluginSettings(
  owner: AutomationOwner,
  prefix: "instrument:" | `effect:${string}:`,
  label: string,
  values: Record<string, number>,
): AutomatableSetting[] {
  return Object.entries(values).map(([param, fixed]) => {
    const setting: AutomatedSetting = `${prefix}${param}`;
    const lane = owner.automation.find((candidate) => candidate.setting === setting);
    const spanned = [fixed, ...(lane?.breakpoints.map((point) => point.value) ?? [])];
    const [min, max] = [Math.min(...spanned), Math.max(...spanned)];
    return { setting, label: `${label} (missing): ${param}`, unit: "", min, max: max > min ? max : min + 1, fixed };
  });
}

export function automatableSetting(
  project: Pick<Project, "buses">,
  owner: AutomationOwner,
  setting: string,
): AutomatableSetting | undefined {
  return automatableSettings(project, owner).find((candidate) => candidate.setting === setting);
}

/**
 * A label as it reads mid-sentence: "Volume" to "volume", but one that
 * starts with a name, "EQ: Low gain", "Synth: Cutoff" or "Kick: Pitch",
 * stays.
 */
export function lowerFirst(label: string): string {
  return /^[A-Z][a-z]/.test(label) && !label.includes(": ") ? label[0]!.toLowerCase() + label.slice(1) : label;
}

const KIND_ORDER = ["volume", "pan", "send", "effect", "instrument"];

function rank(setting: string): number {
  return KIND_ORDER.indexOf(setting.split(":")[0]!);
}

/**
 * Volume, then pan, then Sends, Effects and the Instrument, each group in
 * the order of its setting's name, so the same Automation is the same data.
 */
export function sortAutomation(automation: Automation[]): Automation[] {
  return automation.toSorted(
    (a, b) => rank(a.setting) - rank(b.setting) || (a.setting < b.setting ? -1 : a.setting > b.setting ? 1 : 0),
  );
}

/**
 * Drop the Automation of settings that are gone: of a removed Effect or
 * Send, of a deleted Bus's Sends, of a Synth that was swapped for another
 * Instrument, of a Pad a newly loaded Kit hasn't got. The command that took the setting away takes its Automation
 * with it, so undoing it brings both back.
 */
export function pruneAutomation(project: Project): void {
  for (const owner of [project.master, ...project.tracks, ...project.buses]) {
    const settings = new Set(automatableSettings(project, owner).map((candidate) => candidate.setting));
    if (owner.automation.every((lane) => settings.has(lane.setting))) continue;
    owner.automation = owner.automation.filter((lane) => settings.has(lane.setting));
  }
}
