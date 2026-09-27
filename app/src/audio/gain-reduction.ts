import type { GainReductionMeters } from "./audio-output";

/** The engine's number for Bus `bus`'s Insert Chain: below the Master's -1. */
export function busChain(bus: number): number {
  return -2 - bus;
}

/** The parts of the engine the gain-reduction meters are read from. */
export interface GainReductionSource {
  track_count(): number;
  bus_count(): number;
  /** -1 is the Master's chain, and -2 - b is Bus b's. */
  effect_count(chain: number): number;
  effect_gain_reduction(chain: number, index: number): number;
}

/** Every Insert Chain's gain-reduction meters, read off the engine, as the worklet reports them. */
export function readGainReduction(engine: GainReductionSource): GainReductionMeters {
  const chain = (index: number) =>
    Array.from({ length: engine.effect_count(index) }, (_, effect) => engine.effect_gain_reduction(index, effect));
  return {
    master: chain(-1),
    tracks: Array.from({ length: engine.track_count() }, (_, track) => chain(track)),
    buses: Array.from({ length: engine.bus_count() }, (_, bus) => chain(busChain(bus))),
  };
}
