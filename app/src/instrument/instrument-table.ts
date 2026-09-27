/**
 * A Plugin Instrument in a Project as the rest of the UI sees it: its name,
 * the settings its manifest declares and their flat form, as
 * `effect/effect-table.ts` gives an Effect's. Its controls, its Automation
 * lanes, the Assistant's checks and EngineSync all read it through here.
 *
 * A Plugin counts as installed only when the installed one is an
 * Instrument: one that isn't declares nothing here, so the Track keeps its
 * settings as they were saved and stays silent, as a missing one does.
 */
import { pluginManifest, type PluginManifest } from "../plugin/plugins";
import type { Instrument, PluginInstrument } from "../project/model";
import { type TableParam, vst3Part } from "../effect/effect-table";

/** The manifest of a Plugin Instrument's Plugin, or undefined for a built-in or a missing Plugin. */
export function instrumentManifestOf(instrument: Instrument): PluginManifest | undefined {
  if (instrument.type !== "plugin") return undefined;
  const manifest = pluginManifest(instrument.plugin.id);
  return manifest?.kind === "instrument" ? manifest : undefined;
}

/** Whether `instrument` is a Plugin Instrument whose Plugin isn't installed. */
export function isMissingInstrument(instrument: Instrument): boolean {
  return instrument.type === "plugin" && instrumentManifestOf(instrument) === undefined;
}

/** What the UI calls it: "Synth", "Drum Sampler", a Plugin's own name, or a missing Plugin's id. */
export function instrumentName(instrument: Instrument): string {
  if (instrument.type === "synth") return "Synth";
  if (instrument.type === "drumSampler") return "Drum Sampler";
  return instrumentManifestOf(instrument)?.name ?? instrument.vst3?.name ?? instrument.plugin.id;
}

/** Every setting a Plugin Instrument declares, in the engine's order; none for a missing one. */
export function pluginInstrumentTable(instrument: PluginInstrument): readonly TableParam[] {
  return instrumentManifestOf(instrument)?.settings ?? [];
}

/** Its settings in the engine's flat form: a setting it has no value for takes the default. */
export function pluginInstrumentFlat(instrument: PluginInstrument): number[] {
  return pluginInstrumentTable(instrument).map((param) => instrument.settings[param.name] ?? param.default);
}

/** A Plugin Instrument of the Plugin `manifest` describes, at its defaults. */
export function createPluginInstrument(manifest: PluginManifest): PluginInstrument {
  return {
    type: "plugin",
    plugin: { id: manifest.id, version: manifest.version },
    settings: Object.fromEntries(manifest.settings.map((param) => [param.name, param.default])),
    ...vst3Part(manifest),
  };
}
