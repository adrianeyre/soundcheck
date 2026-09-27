/**
 * What the Stem Separation overlay says: the stage in words, and roughly how
 * long is left, worked out from how fast the chunks have gone so far.
 */
import type { SeparationStage } from "./stem-separator";

/** Each stage, as the musician is told it. The percentage is said beside it, so this changes only with the stage. */
export function stageText(stage: SeparationStage): string {
  switch (stage) {
    case "reading":
      return "Reading the audio…";
    case "loadingModel":
      return "Loading the model (about 300 MB)…";
    case "separating":
      return "Separating the drums, bass, other and vocals…";
    case "finishing":
      return "Making the four Stems…";
  }
}

/** How far it has got, as a whole percentage: never 100% until it is. */
export function percentText(progress: number): string {
  return `${Math.floor(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

/**
 * Milliseconds left at `progress`, if it has gone at the same rate since
 * `since`, or null until there's enough to go on: a few seconds and a few
 * percent.
 */
export function timeLeft(progress: number, since: { at: number; progress: number } | null, now: number): number | null {
  if (!since) return null;
  const done = progress - since.progress;
  const elapsed = now - since.at;
  if (done < 0.02 || elapsed < 3_000) return null;
  return Math.max(0, (elapsed / done) * (1 - progress));
}

/** A time left, as a person would say it roughly: "about 2 min 10 s left". */
export function timeLeftText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `about ${seconds} s left`;
  const minutes = Math.floor(seconds / 60);
  // Past a minute, to the nearest 10 s: it's an estimate.
  const rest = Math.round((seconds % 60) / 10) * 10;
  if (rest === 60) return `about ${minutes + 1} min left`;
  return rest === 0 ? `about ${minutes} min left` : `about ${minutes} min ${rest} s left`;
}
