/**
 * How the Assistant hears a Project: as the commands that bring a fresh
 * engine to it — the same ones `EngineSync` sends the engine that plays —
 * rendered and measured by the platform's `AnalyseAudio`.
 */
import type { AnalyseAudio } from "../audio/audio-analyser";
import { EngineSync, type LoadedSamples } from "../project/engine-sync";
import type { Listen } from "./assistant";

/** `samples` are the WAVs loaded onto pads, so the analysis hears them too. */
export function listenWith(analyse: AnalyseAudio, samples: LoadedSamples = new Map()): Listen {
  return (project, range) => analyse(new EngineSync().update(project, samples), range);
}
