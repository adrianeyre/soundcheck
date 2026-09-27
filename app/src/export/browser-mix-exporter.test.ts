import { readFileSync } from "node:fs";

import { audio_file_summary, encode_wav, Engine, initSync } from "@engine";
import { beforeAll, expect, test, vi } from "vitest";

import { defaultEffectSettings } from "../effect/effect-params";
import { sampleProject } from "../project/fixtures";
import {
  type AudioClip,
  createAudioTrack,
  createBus,
  createEffect,
  createProject,
  type EffectType,
  type Project,
} from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { stereoWav } from "../song/test-wav";
import { applyCommand, renderClip, renderMix } from "./browser-mix-exporter";
import {
  BIT_DEPTHS,
  clipExportRequest,
  type ClipExportRequest,
  exportRequest,
  MP3_BITRATES,
  SAMPLE_RATES,
  songEndTick,
  TAIL_SECONDS,
} from "./mix-exporter";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

const whole = (endTick: number) => ({ startTick: 0, endTick });

/** A WAV's data chunk. */
function dataOf(wav: Uint8Array): DataView {
  const at = new TextDecoder("latin1").decode(wav).indexOf("data");
  return new DataView(wav.buffer, wav.byteOffset + at + 8);
}

/** A 32-bit float WAV's samples, interleaved. */
function samplesOf(wav: Uint8Array): Float32Array {
  const data = dataOf(wav);
  return new Float32Array(data.byteLength / 4).map((_, index) => data.getFloat32(index * 4, true));
}

function peak(samples: Float32Array): number {
  return samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
}

/** An Audio Track playing `audio/tone.wav` for a beat, from beat 2. */
function song(): Project {
  const project = createProject();
  const track = createAudioTrack("Tone");
  track.clips = [{ id: "a", kind: "audio", start: TICKS_PER_BEAT, duration: 0.5, file: "audio/tone.wav", fileOffset: 0 }];
  project.tracks = [track];
  return project;
}

test("the export plays Audio Clips, through the Track's Insert Chain", async () => {
  // Half a second of a 440 Hz tone, from beat 2 of an Audio Track.
  const tone = Array.from({ length: 24_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  const samples = new Map([["audio/tone.wav", { name: "tone.wav", bytes: stereoWav(tone, tone, 48_000) }]]);
  const exported = async (project: Project) => {
    const request = exportRequest(project, samples, whole(4 * TICKS_PER_BEAT), { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } });
    return samplesOf((await renderMix(request, { onProgress: () => {}, signal: new AbortController().signal }))!);
  };

  // At 120 BPM a beat is 24,000 frames: silence until the Clip starts.
  const dry = await exported(song());
  expect(peak(dry.subarray(0, 2 * 24_000))).toBe(0);
  expect(peak(dry.subarray(2 * 24_000, 2 * 48_000))).toBeGreaterThan(0.1);

  // An EQ that takes 18 dB off everything is heard in the file.
  const cut = song();
  const eq = createEffect("eq", "e");
  eq.settings = { ...defaultEffectSettings("eq"), lowShelfHz: 20_000, lowShelfGainDb: -18 };
  cut.tracks[0]!.insertChain.push(eq);
  expect(peak(await exported(cut))).toBeLessThan(peak(dry) / 4);

  // So is one on the Master, and bypassing it gives the dry mix back.
  const master = song();
  master.master.insertChain.push({ ...eq, id: "m" });
  expect(peak(await exported(master))).toBeLessThan(peak(dry) / 4);
  master.master.insertChain[0]!.bypassed = true;
  expect(await exported(master)).toEqual(dry);
});

// A quarter-second take at 44.1 kHz, saved as 24 bits as the desktop saves
// one, placed on beat 2 where it was played.
/**
 * A quarter-second take at 44.1 kHz, saved as 24 bits as the desktop saves
 * one. Built once the WASM build has loaded.
 */
function takeSamples() {
  const rate = 44_100;
  const take = Float32Array.from({ length: rate / 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * (i >> 1)) / rate));
  return new Map([["audio/Tone take.wav", { name: "Tone take.wav", bytes: [...encode_wav(take, rate, 24)!] }]]);
}

/**
 * `song` with the take recorded onto beat 2 of its Track, and an Effect of
 * `type` on `chain`: on a Bus, the Track feeds it.
 */
function recorded(chain: "track" | "master" | "bus" | null, type: EffectType, settings: Record<string, number>): Project {
  const project = song();
  project.tracks[0]!.clips = [
    { id: "take", kind: "audio", start: TICKS_PER_BEAT, duration: 0.25, file: "audio/Tone take.wav", fileOffset: 0 },
  ];
  const effect = createEffect(type, "fx");
  Object.assign(effect.settings, settings);
  if (chain === "track") project.tracks[0]!.insertChain.push(effect);
  if (chain === "master") project.master.insertChain.push(effect);
  if (chain === "bus") {
    const bus = createBus("Bus", "bus");
    bus.insertChain.push(effect);
    project.buses.push(bus);
    project.tracks[0]!.output = bus.id;
  }
  return project;
}

test("the export plays a recorded take through a Compressor and a Reverb, on its Track, a Bus or the Master", async () => {
  const samples = takeSamples();
  const exported = async (project: Project) => {
    const request = exportRequest(project, samples, whole(4 * TICKS_PER_BEAT), { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } });
    return samplesOf((await renderMix(request, { onProgress: () => {}, signal: new AbortController().signal }))!);
  };
  // Beats 3 and 4, after the take has ended.
  const after = (rendered: Float32Array) => peak(rendered.subarray(2 * 48_000, 2 * 96_000));

  const dry = await exported(recorded(null, "eq", {}));
  expect(peak(dry.subarray(0, 2 * 24_000))).toBe(0);
  expect(peak(dry.subarray(2 * 24_000, 2 * 48_000))).toBeGreaterThan(0.1);
  expect(after(dry)).toBe(0);

  for (const chain of ["track", "master", "bus"] as const) {
    const squashed = await exported(recorded(chain, "compressor", { thresholdDb: -40, ratio: 20, attack: 0.1, makeupDb: 0, kneeDb: 0 }));
    expect(peak(squashed), `the Compressor on the ${chain}`).toBeLessThan(peak(dry) / 4);
    const wet = await exported(recorded(chain, "reverb", { preDelay: 0, mix: 1 }));
    expect(after(wet), `the Reverb's tail on the ${chain}`).toBeGreaterThan(1e-3);
    expect(await exported(recorded(chain, "reverb", { mix: 0 })), `a Reverb with no mix on the ${chain}`).toEqual(dry);
  }
});

test("the song ends where its last Clip does, on any kind of Track", () => {
  const project = sampleProject();
  // The Vocals' Audio Clip runs from bar 3 to bar 7.
  expect(songEndTick(project)).toBe(3_840 + 7_680);
  project.tracks = [];
  expect(songEndTick(project)).toBe(0);
});

test("an export of a song with a Tempo Change follows the tempo map, as playback does", async () => {
  // A bar at 120 (2 s), then 60 from bar 2 (4 s a bar), and half a second
  // of tone from bar 3.
  const tone = Array.from({ length: 24_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  const samples = new Map([["audio/tone.wav", { name: "tone.wav", bytes: stereoWav(tone, tone, 48_000) }]]);
  const project = song();
  project.tempoChanges = [{ id: "slow", tick: 3_840, tempo: 60, timeSignature: null }];
  project.tracks[0]!.clips[0]!.start = 7_680;
  // Its half second at 60 is half a beat.
  expect(songEndTick(project)).toBe(7_680 + 480);

  const request = exportRequest(project, samples, whole(songEndTick(project)), { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } });
  expect(request.commands).toContainEqual({ type: "setTempoChanges", changes: [3_840, 60, 4, 4] });
  const exported = samplesOf((await renderMix(request, { onProgress: () => {}, signal: new AbortController().signal }))!);
  // Silence for the 6 s before bar 3, then the tone.
  const bar3 = 6 * 48_000 * 2;
  expect(peak(exported.subarray(0, bar3))).toBe(0);
  expect(peak(exported.subarray(bar3, bar3 + 24_000 * 2))).toBeGreaterThan(0.1);
  expect(exported.length).toBeGreaterThanOrEqual(bar3 + 24_000 * 2);
});

test("an export plays a Track's and the Master's Automation, as playback does", async () => {
  const tone = Array.from({ length: 48_000 }, () => 0.5);
  const samples = new Map([["audio/tone.wav", { name: "tone.wav", bytes: stereoWav(tone, tone, 48_000) }]]);
  const project = song();
  // The Track steps from full to silent on beat 2, half way through its
  // second of tone; the Master holds at half all the way.
  (project.tracks[0]!.clips[0] as AudioClip).duration = 1;
  project.tracks[0]!.automation = [
    {
      setting: "volume",
      breakpoints: [
        { tick: 0, value: 1, hold: true },
        { tick: 2 * TICKS_PER_BEAT, value: 0, hold: false },
      ],
    },
  ];
  project.master.automation = [{ setting: "volume", breakpoints: [{ tick: 0, value: 0.5, hold: false }] }];

  const request = exportRequest(project, samples, whole(songEndTick(project)), { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } });
  expect(request.commands).toContainEqual({ type: "setAutomation", target: 0, setting: "volume", points: [0, 1, 1, 1_920, 0, 0] });
  expect(request.commands).toContainEqual({ type: "setAutomation", target: -1, setting: "volume", points: [0, 0.5, 0] });
  const exported = samplesOf((await renderMix(request, { onProgress: () => {}, signal: new AbortController().signal }))!);
  // Beat 1 to beat 2 plays, at half the fader; from beat 2 on it is silent.
  const beat = 24_000 * 2;
  const fixed = song();
  (fixed.tracks[0]!.clips[0] as AudioClip).duration = 1;
  fixed.master.volume = 0.5;
  const plain = samplesOf(
    (await renderMix(exportRequest(fixed, samples, whole(songEndTick(fixed)), { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } }), {
      onProgress: () => {},
      signal: new AbortController().signal,
    }))!,
  );
  expect(peak(exported.subarray(beat, 2 * beat))).toBeGreaterThan(0.01);
  expect(exported.subarray(0, 2 * beat)).toEqual(plain.subarray(0, 2 * beat));
  expect(peak(exported.subarray(2 * beat))).toBe(0);
});

test("the exported file is the offline render of the same range, sample for sample", async () => {
  const project = sampleProject();
  const request = exportRequest(project, new Map(), whole(3_840), { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } });
  const wav = (await renderMix(request, { onProgress: () => {}, signal: new AbortController().signal }))!;
  const data = dataOf(wav);
  const exported = new Float32Array(data.byteLength / 4).map((_, index) => data.getFloat32(index * 4, true));

  // A bar at 120 BPM, then a tail of at most ten seconds.
  const range = 96_000 * 2;
  expect(exported.length).toBeGreaterThan(range);
  expect(exported.length).toBeLessThanOrEqual(range + TAIL_SECONDS * 48_000 * 2);

  // The same range and its tail: a longer offline render of the same song.
  const engine = new Engine(48_000);
  try {
    for (const command of request.commands) applyCommand(engine, command);
    const render = engine.render_range(0, 3_840 * 20);
    expect(exported).toEqual(render.subarray(0, exported.length));
  } finally {
    engine.free();
  }
});

test("a 16-bit file at 44.1 kHz says so in its header", async () => {
  const request = exportRequest(sampleProject(), new Map(), whole(960), { sampleRate: 44_100, encoding: { kind: "wav", bits: 16 } });
  const wav = (await renderMix(request, { onProgress: () => {}, signal: new AbortController().signal }))!;
  const header = new DataView(wav.buffer, wav.byteOffset);
  expect(header.getUint32(24, true)).toBe(44_100);
  expect(header.getUint16(34, true)).toBe(16);
});

test("an MP3 is the same render, encoded at the bitrate chosen", async () => {
  const signal = new AbortController().signal;
  const range = whole(3_840);
  const wav = (await renderMix(exportRequest(sampleProject(), new Map(), range, { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } }), { onProgress: () => {}, signal }))!;
  const small = (await renderMix(exportRequest(sampleProject(), new Map(), range, { sampleRate: 48_000, encoding: { kind: "mp3", kbps: 128 } }), { onProgress: () => {}, signal }))!;
  const large = (await renderMix(exportRequest(sampleProject(), new Map(), range, { sampleRate: 48_000, encoding: { kind: "mp3", kbps: 320 } }), { onProgress: () => {}, signal }))!;

  // Every MP3 frame starts with eleven set bits.
  expect(small[0]).toBe(0xff);
  expect(small[1]! & 0xe0).toBe(0xe0);
  expect(large.length).toBeGreaterThan(2 * small.length);

  // As long as the WAV, give or take the encoder's padding, and as loud.
  const seconds = dataOf(wav).byteLength / 8 / 48_000;
  const [length, loudest] = audio_file_summary(small, 1);
  expect(length).toBeGreaterThanOrEqual(seconds);
  expect(length).toBeLessThan(seconds + 0.1);
  const data = dataOf(wav);
  const exported = new Float32Array(data.byteLength / 4).map((_, index) => data.getFloat32(index * 4, true));
  expect(loudest).toBeCloseTo(peak(exported), 1);
});

test("progress rises to one", async () => {
  const onProgress = vi.fn<(fraction: number) => void>();
  const request = exportRequest(sampleProject(), new Map(), whole(3_840), { sampleRate: 48_000, encoding: { kind: "wav", bits: 24 } });
  await renderMix(request, { onProgress, signal: new AbortController().signal });
  const reports = onProgress.mock.calls.map(([fraction]) => fraction);
  expect(reports[0]).toBe(0);
  expect(reports.at(-1)).toBe(1);
  expect(reports.some((fraction) => fraction > 0 && fraction < 1)).toBe(true);
});

test("aborting stops the render and writes nothing", async () => {
  const abort = new AbortController();
  const request = exportRequest(sampleProject(), new Map(), whole(3_840), { sampleRate: 48_000, encoding: { kind: "wav", bits: 16 } });
  const rendering = renderMix(request, {
    onProgress: (fraction) => {
      if (fraction > 0) abort.abort();
    },
    signal: abort.signal,
  });
  expect(await rendering).toBeNull();
});

/** A second of a stereo ramp at 48 kHz, as a 32-bit float WAV: every sample its own. */
function rampSamples() {
  const rate = 48_000;
  const ramp = Float32Array.from({ length: rate * 2 }, (_, i) => (i % 2 === 0 ? 1 : -1) * ((i >> 1) / rate - 0.5));
  return { ramp, samples: new Map([["audio/Stem vocals.wav", { name: "Stem vocals.wav", bytes: [...encode_wav(ramp, rate, 32)!] }]]) };
}

/** An Audio Track playing a quarter to three quarters of the ramp, from beat 2. */
function trimmed(): Project {
  const project = createProject();
  const track = createAudioTrack("Vocals");
  track.clips = [
    { id: "v", kind: "audio", start: TICKS_PER_BEAT, duration: 0.5, file: "audio/Stem vocals.wav", fileOffset: 0.25 },
  ];
  project.tracks = [track];
  return project;
}

const watching = () => ({ onProgress: () => {}, signal: new AbortController().signal });

async function clipExported(project: Project, samples: ReturnType<typeof rampSamples>["samples"], format: Pick<ClipExportRequest, "sampleRate" | "encoding">) {
  const request = clipExportRequest(project.tracks[0]!.clips[0] as AudioClip, samples, format)!;
  return (await renderClip(request, watching()))!;
}

test("a trimmed Clip exported at its file's rate is exactly its stretch, sample for sample", async () => {
  const { ramp, samples } = rampSamples();
  const wav = await clipExported(trimmed(), samples, { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } });
  // 0.25 s in, for 0.5 s: frames 12,000 to 36,000.
  expect(samplesOf(wav)).toEqual(ramp.subarray(2 * 12_000, 2 * 36_000));
});

test("a Clip exports as WAV at each bit depth and rate, and as MP3 at each bitrate", async () => {
  const { samples } = rampSamples();
  for (const sampleRate of SAMPLE_RATES) {
    for (const bits of BIT_DEPTHS) {
      const wav = await clipExported(trimmed(), samples, { sampleRate, encoding: { kind: "wav", bits } });
      expect(new DataView(wav.buffer).getUint32(24, true)).toBe(sampleRate);
      expect(dataOf(wav).byteLength, `${bits}-bit at ${sampleRate}`).toBe((sampleRate / 2) * 2 * (bits / 8));
    }
  }
  for (const kbps of MP3_BITRATES) {
    const mp3 = await clipExported(trimmed(), samples, { sampleRate: 44_100, encoding: { kind: "mp3", kbps } });
    const [seconds, loudest] = audio_file_summary(mp3, 1);
    // The encoder pads to whole frames and adds its own delay.
    expect(seconds, `${kbps} kbps`).toBeGreaterThanOrEqual(0.5);
    expect(seconds, `${kbps} kbps`).toBeLessThan(0.6);
    // The stretch runs from -0.25 to 0.25.
    expect(loudest, `${kbps} kbps`).toBeCloseTo(0.25, 1);
  }
});

test("the Track's fader, pan, Effects, Sends and Automation don't change a Clip's file", async () => {
  const { samples } = rampSamples();
  const format = { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } } as const;
  const plain = await clipExported(trimmed(), samples, format);

  const mixed = trimmed();
  const track = mixed.tracks[0]!;
  track.mixer = { ...track.mixer, volume: 0.2, pan: -0.8 };
  const eq = createEffect("eq", "e");
  eq.settings = { ...defaultEffectSettings("eq"), lowShelfHz: 20_000, lowShelfGainDb: -18 };
  track.insertChain.push(eq);
  track.automation = [{ setting: "volume", breakpoints: [{ tick: 0, value: 0, hold: true }] }];
  const bus = createBus("Reverb", "bus");
  mixed.buses.push(bus);
  track.sends = [{ busId: bus.id, level: 1 }];
  mixed.master.volume = 0.1;
  expect(await clipExported(mixed, samples, format)).toEqual(plain);

  // As the mix exports it, the same Clip is changed.
  const mix = exportRequest(mixed, samples, whole(songEndTick(mixed)), format);
  const rendered = samplesOf((await renderMix(mix, watching()))!);
  expect(peak(rendered)).toBeLessThan(peak(samplesOf(plain)) / 4);
});

test("a Clip's export reports progress to 1, and aborting it gives nothing", async () => {
  const { samples } = rampSamples();
  const request = clipExportRequest(trimmed().tracks[0]!.clips[0] as AudioClip, samples, {
    sampleRate: 48_000,
    encoding: { kind: "wav", bits: 16 },
  })!;
  const reports: number[] = [];
  await renderClip(request, { onProgress: (fraction) => reports.push(fraction), signal: new AbortController().signal });
  expect(reports[0]).toBe(0);
  expect(reports.at(-1)).toBe(1);
  expect(reports.length).toBeGreaterThan(2);
  const abort = new AbortController();
  abort.abort();
  expect(await renderClip(request, { onProgress: () => {}, signal: abort.signal })).toBeNull();
});

test("a Clip whose file isn't in memory has nothing to export", () => {
  expect(clipExportRequest(trimmed().tracks[0]!.clips[0] as AudioClip, new Map(), { sampleRate: 48_000, encoding: { kind: "wav", bits: 16 } })).toBeNull();
});
