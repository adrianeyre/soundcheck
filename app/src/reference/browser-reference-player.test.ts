// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

import { type AuditionContext, browserReferencePlayer, pickAudioFile } from "./browser-reference-player";

type Call = () => void;

/** The part of an AudioNode an audition touches. */
function node() {
  return { connect: vi.fn<Call>(), disconnect: vi.fn<Call>(), addEventListener: vi.fn<Call>() };
}

test("in the browser a file input chooses the file, and cancelling it chooses none", async () => {
  const click = vi.spyOn(HTMLInputElement.prototype, "click");
  const file = new File([new Uint8Array([82, 73, 70, 70])], "finished.wav");
  click.mockImplementationOnce(function (this: HTMLInputElement) {
    expect(this.accept).toContain(".flac");
    Object.defineProperty(this, "files", { value: [file] });
    this.dispatchEvent(new Event("change"));
  });
  expect(await browserReferencePlayer().chooseFile()).toEqual({ name: "finished.wav", bytes: [82, 73, 70, 70] });

  click.mockImplementationOnce(function (this: HTMLInputElement) {
    this.dispatchEvent(new Event("cancel"));
  });
  expect(await pickAudioFile()).toBeNull();
  click.mockRestore();
});

test("in the browser Web Audio plays the reference at the gain given, one at a time, in a context of its own", async () => {
  const sources: { start: ReturnType<typeof vi.fn<Call>>; stop: ReturnType<typeof vi.fn<Call>>; buffer: unknown }[] = [];
  const gains: { gain: { value: number } }[] = [];
  const decoded = { duration: 0.5 } as AudioBuffer;
  const context = {
    decodeAudioData: vi.fn<AuditionContext["decodeAudioData"]>(() => Promise.resolve(decoded)),
    createBufferSource: () => {
      const source = { ...node(), start: vi.fn<Call>(), stop: vi.fn<Call>(), buffer: null };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
    createGain: () => {
      const gain = { ...node(), gain: { value: 1 } };
      gains.push(gain);
      return gain as unknown as GainNode;
    },
    destination: {} as AudioNode,
    resume: () => Promise.resolve(),
  } satisfies AuditionContext;
  const open = vi.fn<() => AuditionContext>(() => context);
  const player = browserReferencePlayer(() => Promise.resolve(null), open);
  const sample = { name: "finished.wav", bytes: [82, 73, 70, 70] };

  await player.audition(sample, 0.25);
  expect(sources[0]!.buffer).toBe(decoded);
  expect(sources[0]!.start).toHaveBeenCalled();
  expect(gains[0]!.gain.value).toBe(0.25);

  // Auditioning again stops the first, and decodes the file only once.
  await player.audition(sample, 1);
  expect(sources[0]!.stop).toHaveBeenCalled();
  expect(gains[1]!.gain.value).toBe(1);
  expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
  await player.stopAudition();
  expect(sources[1]!.stop).toHaveBeenCalled();
  expect(open).toHaveBeenCalledTimes(1);
});
