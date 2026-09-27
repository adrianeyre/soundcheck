import type { EngineCommand } from "../audio/audio-output";
import { defaultEffectSettings, effectSettingsToFlat } from "../effect/effect-params";

/**
 * The Insert Chain every load-test Track runs: EQ → Compressor → Reverb, the
 * chain Milestone 0 measured. A Track's chain starts empty, and an EQ that
 * changes nothing skips its filters, so the EQ is given work on every band.
 */
export function loadTestChain(track: number): EngineCommand[] {
  const eq = {
    ...defaultEffectSettings("eq"),
    lowCut: "on" as const,
    lowShelfGainDb: 2,
    band1GainDb: 1,
    band2GainDb: -3,
    band3GainDb: 1,
    highShelfGainDb: 1.5,
    highCut: "on" as const,
  };
  return [
    { type: "insertEffect", chain: track, index: 0, effect: "eq" },
    { type: "setEffectSettings", chain: track, index: 0, settings: effectSettingsToFlat("eq", eq) },
    { type: "insertEffect", chain: track, index: 1, effect: "compressor" },
    { type: "insertEffect", chain: track, index: 2, effect: "reverb" },
  ];
}

/** The load-test chain on Tracks `from` up to (not including) `to`. */
export function loadTestChains(from: number, to: number): EngineCommand[] {
  const commands: EngineCommand[] = [];
  for (let track = from; track < to; track++) commands.push(...loadTestChain(track));
  return commands;
}
