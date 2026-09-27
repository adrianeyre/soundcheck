/** A frame that takes longer than this missed at least one 60 Hz refresh. */
export const LONG_FRAME_MS = 25;

/** Counts animation frames: fed each requestAnimationFrame timestamp. */
export class FpsMeter {
  #window: number;
  #stamps: number[] = [];
  #longFrames = 0;

  constructor(windowMs = 1000) {
    this.#window = windowMs;
  }

  frame(timestamp: number): void {
    const last = this.#stamps.at(-1);
    if (last !== undefined && timestamp - last > LONG_FRAME_MS) this.#longFrames += 1;
    this.#stamps.push(timestamp);
    const cutoff = timestamp - this.#window;
    while ((this.#stamps[0] ?? timestamp) < cutoff) this.#stamps.shift();
  }

  /** Frames per second over the last window. */
  get fps(): number {
    const first = this.#stamps[0];
    const last = this.#stamps.at(-1);
    if (first === undefined || last === undefined || last === first) return 0;
    return ((this.#stamps.length - 1) * 1000) / (last - first);
  }

  /** Frames longer than `LONG_FRAME_MS` since the last reset. */
  get longFrames(): number {
    return this.#longFrames;
  }

  reset(): void {
    this.#longFrames = 0;
  }
}
