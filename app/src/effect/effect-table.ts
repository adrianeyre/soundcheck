/**
 * An Effect in a Project as the rest of the UI sees it, whether it is one of
 * the engine's own or a WASM Plugin (ADR 0003): its name, the settings it
 * declares and their flat form. Drawing its controls, listing its Automation
 * lanes, saving its Presets, checking the Assistant's changes and syncing
 * the engine all read an Effect through here, so a Plugin goes down the
 * same paths as a built-in.
 *
 * A Plugin's settings come from its manifest, found by its id among the
 * installed Plugins, or for a VST3 Plugin among the loaded ones. A Plugin
 * this machine hasn't got declares nothing: its settings are kept as they
 * were saved, and it passes audio through.
 */
import { pluginManifest, type PluginManifest } from "../plugin/plugins";
import { type Effect, newId, type PluginEffect } from "../project/model";
import { EFFECT_NAMES, type EffectParam, effectParams, effectSettingsToFlat } from "./effect-params";

/** One setting of any Effect: a built-in's or a Plugin's. */
export type TableParam = Omit<EffectParam, "name"> & { name: string };

/** The manifest of a Plugin Effect's Plugin, or undefined for a built-in or a missing Plugin. */
export function pluginManifestOf(effect: Effect): PluginManifest | undefined {
  if (effect.type !== "plugin") return undefined;
  const manifest = pluginManifest(effect.plugin.id);
  return manifest?.kind === "effect" ? manifest : undefined;
}

/**
 * Whether `effect` is a Plugin Effect whose Plugin isn't installed: an
 * installed Plugin that is an Instrument counts as missing here.
 */
export function isMissingPlugin(effect: Effect): effect is PluginEffect {
  return effect.type === "plugin" && pluginManifestOf(effect) === undefined;
}

/** What the UI calls it: "EQ", a Plugin's own name, or a missing Plugin's id, or a VST3 Plugin's saved name. */
export function effectName(effect: Effect): string {
  if (effect.type !== "plugin") return EFFECT_NAMES[effect.type];
  return pluginManifestOf(effect)?.name ?? effect.vst3?.name ?? effect.plugin.id;
}

/** Every setting it declares, in the order the engine takes them; none for a missing Plugin. */
export function effectTable(effect: Effect): readonly TableParam[] {
  if (effect.type !== "plugin") return effectParams(effect.type);
  return pluginManifestOf(effect)?.settings ?? [];
}

/** Its settings in the engine's flat form: a Plugin's setting it has no value for takes the default. */
export function effectFlat(effect: Effect): number[] {
  if (effect.type !== "plugin") return effectSettingsToFlat(effect.type, effect.settings);
  return effectTable(effect).map((param) => effect.settings[param.name] ?? param.default);
}

/** A Plugin Effect of the Plugin `manifest` describes, at its defaults. */
export function createPluginEffect(manifest: PluginManifest, id = newId()): PluginEffect {
  return {
    id,
    type: "plugin",
    bypassed: false,
    plugin: { id: manifest.id, version: manifest.version },
    settings: Object.fromEntries(manifest.settings.map((param) => [param.name, param.default])),
    ...vst3Part(manifest),
  };
}

/** A new VST3 Plugin's own part: no state yet, so it loads as it comes. */
export function vst3Part(manifest: PluginManifest): { vst3?: NonNullable<PluginEffect["vst3"]> } {
  return manifest.vst3 ? { vst3: { ...manifest.vst3, state: { component: "", controller: "" } } } : {};
}
