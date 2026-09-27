/**
 * The Preset library: the musician's User Presets, kept outside any Project
 * so a Preset saved in one loads into every other (#50), listed alongside
 * the Factory Presets that ship with the app.
 *
 * A User Preset is a named copy of a Synth's, a Plugin Instrument's or an
 * Effect's settings. Loading
 * one copies its settings into the Project, as a Factory Preset's are, so the
 * Project never depends on the library: renaming or deleting a Preset later
 * changes nothing that has already loaded it.
 *
 * Each User Preset is one file, `presets/<id>.json`, in the library. Names
 * are unique among one Synth's or Effect's Presets, Factory and User alike,
 * so the pickers and the Assistant can name a Preset without ambiguity.
 * Factory Presets can't be renamed, deleted or saved over.
 */
import {
  defaultEffectSettings,
  EFFECT_NAMES,
  EFFECT_TYPES,
  type EffectSettings,
  type EffectType,
} from "../effect/effect-params";
import { effectPresets } from "../effect/effect-presets";
import { defaultSynthSettings, type SynthSettings } from "../instrument/synth-params";
import { SYNTH_PRESETS } from "../instrument/synth-presets";
import { pluginManifest } from "../plugin/plugins";
import type { Command } from "../project/commands";
import { type Effect, newId, type PluginInstrument } from "../project/model";
import { LIMITS, validateEffectSettings, validatePluginSettings, validateSynthSettings } from "../project/validate";
import type { LibraryStorage } from "./library-storage";

/**
 * What a Preset is for: the Synth, one kind of built-in Effect, or one
 * Plugin, by its id, whatever version of it is installed.
 */
export type PresetTarget = "synth" | EffectType | `plugin:${string}`;

export const PRESET_TARGETS: readonly PresetTarget[] = ["synth", ...EFFECT_TYPES];

/** A Preset's settings: a Synth's, a built-in Effect's, or a Plugin's numbers by name. */
export type PresetSettings = SynthSettings | EffectSettings | Record<string, number>;

/** The Presets an Effect loads and saves. */
export function presetTargetOf(effect: Effect): PresetTarget {
  return effect.type === "plugin" ? `plugin:${effect.plugin.id}` : effect.type;
}

/** The Presets a Plugin Instrument loads and saves: its Plugin's, as a Plugin Effect's are. */
export function instrumentPresetTarget(instrument: PluginInstrument): PresetTarget {
  return `plugin:${instrument.plugin.id}`;
}

/** The Plugin id a target is for, or null for the Synth or a built-in. */
function pluginOf(target: PresetTarget): string | null {
  return target.startsWith("plugin:") ? target.slice("plugin:".length) : null;
}

function isPresetTarget(target: unknown): target is PresetTarget {
  if (typeof target !== "string") return false;
  const plugin = pluginOf(target as PresetTarget);
  return plugin === null ? PRESET_TARGETS.includes(target as PresetTarget) : plugin.length > 0;
}

export interface UserPreset {
  /** Names its file in the library; never shown. */
  id: string;
  name: string;
  target: PresetTarget;
  settings: PresetSettings;
}

/** A Preset as a picker lists it: Factory and User together, marked. */
export interface ListedPreset {
  name: string;
  source: "factory" | "user";
  /** What it sounds like; Factory Presets have one. */
  description?: string;
  /** A Synth Factory Preset's category: bass, lead, pad, pluck or keys. */
  category?: string;
  settings: PresetSettings;
}

/** The folder of the library the Presets are kept in. */
const FOLDER = "presets";

/** The file format's version, so a later app can read an older library. */
const FILE_VERSION = 1;

/** "Synth" or the Effect's name, for messages. */
export function targetName(target: PresetTarget): string {
  const plugin = pluginOf(target);
  if (plugin !== null) return pluginManifest(plugin)?.name ?? plugin;
  return target === "synth" ? "Synth" : EFFECT_NAMES[target as EffectType];
}

/** The Factory Presets for `target`, in the order the pickers list them. */
export function factoryPresets(target: PresetTarget): ListedPreset[] {
  // Plugins ship no Factory Presets yet.
  if (pluginOf(target) !== null) return [];
  const factory = target === "synth" ? SYNTH_PRESETS : effectPresets(target as EffectType);
  return factory.map((preset) => ({ ...preset, source: "factory" }));
}

/**
 * Every Preset for `target`: the Factory Presets first, in their order, then
 * the User Presets by name.
 */
export function presetsFor(target: PresetTarget, userPresets: readonly UserPreset[]): ListedPreset[] {
  const user = userPresets
    .filter((preset) => preset.target === target)
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((preset): ListedPreset => ({ name: preset.name, source: "user", settings: preset.settings }));
  return [...factoryPresets(target), ...user];
}

/**
 * The Preset for `target` called `name`, Factory or User, or undefined. An
 * exact match first, then one that differs only in case, as a musician or
 * the Assistant might type it.
 */
export function findPreset(
  target: PresetTarget,
  name: string,
  userPresets: readonly UserPreset[],
): ListedPreset | undefined {
  const all = presetsFor(target, userPresets);
  return all.find((preset) => preset.name === name) ?? all.find((preset) => sameName(preset.name, name));
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The command that loads `preset` into a Track's Synth: a Factory Preset by
 * name, as it always has, and a User Preset with its settings.
 */
export function synthPresetCommand(trackId: string, preset: ListedPreset): Command {
  return preset.source === "factory"
    ? { type: "setSynthPreset", trackId, preset: preset.name }
    : { type: "setSynthPreset", trackId, preset: preset.name, settings: { ...(preset.settings as SynthSettings) } };
}

/** A User Preset's name can't be saved: the reason is the message. */
export class PresetRefused extends Error {}

/**
 * The library's User Presets, and the ways to change them. Reads once with
 * `load`, then keeps its list in step with every change it writes.
 */
export class PresetLibrary {
  private presets: UserPreset[] = [];

  constructor(private readonly storage: LibraryStorage) {}

  /** Every User Preset, as last loaded or changed. */
  get userPresets(): readonly UserPreset[] {
    return this.presets;
  }

  /**
   * Read every User Preset in the library. A file that can't be read, or
   * doesn't hold a Preset this app can load, is left out rather than
   * stopping the rest.
   */
  async load(): Promise<readonly UserPreset[]> {
    const files = await this.storage.listFiles(FOLDER);
    const read = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            return parsePreset(presetId(file), await this.storage.readText(file));
          } catch {
            return null;
          }
        }),
    );
    this.presets = [];
    for (const preset of read) {
      // A name used twice (a file copied in by hand) keeps the first.
      if (preset && !this.presets.some((other) => other.target === preset.target && sameName(other.name, preset.name))) {
        this.presets.push(preset);
      }
    }
    return this.presets;
  }

  /** Save `settings` as a new User Preset for `target` called `name`. */
  async save(target: PresetTarget, name: string, settings: PresetSettings): Promise<UserPreset> {
    const trimmed = this.checkName(target, name);
    const problem = settingsProblem(target, settings);
    if (problem) throw new PresetRefused(problem);
    const preset: UserPreset = { id: newId(), name: trimmed, target, settings: { ...settings } };
    await this.write(preset);
    this.presets = [...this.presets, preset];
    return preset;
  }

  /** Rename the User Preset for `target` called `name`. */
  async rename(target: PresetTarget, name: string, newName: string): Promise<UserPreset> {
    const preset = this.userPreset(target, name);
    const trimmed = this.checkName(target, newName, preset);
    const renamed = { ...preset, name: trimmed };
    await this.write(renamed);
    this.presets = this.presets.map((other) => (other === preset ? renamed : other));
    return renamed;
  }

  /** Delete the User Preset for `target` called `name`. */
  async delete(target: PresetTarget, name: string): Promise<void> {
    const preset = this.userPreset(target, name);
    await this.storage.deleteFile(presetPath(preset.id));
    this.presets = this.presets.filter((other) => other !== preset);
  }

  private userPreset(target: PresetTarget, name: string): UserPreset {
    const preset = this.presets.find((other) => other.target === target && other.name === name);
    if (preset) return preset;
    if (factoryPresets(target).some((factory) => factory.name === name)) {
      throw new PresetRefused(`“${name}” is a Factory Preset, which can't be changed`);
    }
    throw new PresetRefused(`The ${targetName(target)} has no User Preset called “${name}”`);
  }

  /** The name, trimmed, if `target` can have a User Preset called it. */
  private checkName(target: PresetTarget, name: string, renaming?: UserPreset): string {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > LIMITS.nameLength) {
      throw new PresetRefused(`A Preset's name must be 1 to ${LIMITS.nameLength} characters`);
    }
    if (factoryPresets(target).some((factory) => sameName(factory.name, trimmed))) {
      throw new PresetRefused(`“${trimmed}” is a Factory Preset's name, and Factory Presets can't be changed`);
    }
    const taken = this.presets.some(
      (other) => other !== renaming && other.target === target && sameName(other.name, trimmed),
    );
    if (taken) throw new PresetRefused(`The ${targetName(target)} already has a Preset called “${trimmed}”`);
    return trimmed;
  }

  private async write(preset: UserPreset): Promise<void> {
    const file = { version: FILE_VERSION, name: preset.name, target: preset.target, settings: preset.settings };
    await this.storage.writeText(presetPath(preset.id), JSON.stringify(file, null, 2));
  }
}

function presetPath(id: string): string {
  return `${FOLDER}/${id}.json`;
}

function presetId(file: string): string {
  return file.slice(FOLDER.length + 1, -".json".length);
}

function settingsProblem(target: PresetTarget, settings: unknown): string | null {
  const plugin = pluginOf(target);
  if (plugin !== null) return validatePluginSettings(pluginManifest(plugin), settings);
  return target === "synth" ? validateSynthSettings(settings) : validateEffectSettings(target as EffectType, settings);
}

/**
 * What a Preset for `target` holds before its file is read: the defaults,
 * or, for a Plugin that isn't installed, nothing, so the file's settings
 * are kept as they are.
 */
function presetDefaults(target: PresetTarget, settings: object): Record<string, unknown> {
  const plugin = pluginOf(target);
  if (plugin !== null) {
    const manifest = pluginManifest(plugin);
    if (!manifest) return { ...settings };
    return Object.fromEntries(manifest.settings.map((param) => [param.name, param.default]));
  }
  return { ...(target === "synth" ? defaultSynthSettings() : defaultEffectSettings(target as EffectType)) };
}

/**
 * A User Preset from its file, or null if it isn't one. Settings the app has
 * gained since the Preset was saved take their defaults, and settings it no
 * longer has are dropped, so an older library still loads.
 */
function parsePreset(id: string, text: string): UserPreset | null {
  const file: unknown = JSON.parse(text);
  if (typeof file !== "object" || file === null) return null;
  const { name, target, settings } = file as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (!isPresetTarget(target)) return null;
  if (typeof settings !== "object" || settings === null) return null;
  const presetTarget = target;
  const defaults = presetDefaults(presetTarget, settings);
  for (const key of Object.keys(defaults)) {
    if (key in settings) defaults[key] = (settings as Record<string, unknown>)[key];
  }
  if (settingsProblem(presetTarget, defaults)) return null;
  return { id, name: name.trim(), target: presetTarget, settings: defaults as unknown as UserPreset["settings"] };
}
