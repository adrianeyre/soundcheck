/**
 * The MVP's acceptance criterion for Projects: a song of four Instrument
 * Tracks and two Audio Tracks, built edit by edit as the UI builds one,
 * saved, closed, reopened and exported to WAV, without a single edit lost.
 * The folder is the in-memory storage, and the export is the Browser
 * Version's, on the real WASM engine.
 */
import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { renderMix } from "../export/browser-mix-exporter";
import { exportRequest, songEndTick } from "../export/mix-exporter";
import type { Command } from "../project/commands";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import {
  createAudioTrack,
  createBus,
  createDrumTrack,
  createEffect,
  createInstrumentTrack,
  createProject,
  type Project,
} from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { stereoWav } from "../song/test-wav";
import { FakeFileStorage, fakeFolder } from "./fake-file-storage";
import { DATA_FILE, openProject, saveProject } from "./project-folder";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

const BEAT = TICKS_PER_BEAT;
const BAR = 4 * BEAT;
const RATE = 48_000;

/** `seconds` of a tone at `hz`, as a WAV the musician imported. */
function tone(name: string, hz: number, seconds: number): LoadedSample {
  const wave = Array.from({ length: seconds * RATE }, (_, at) => 0.4 * Math.sin((2 * Math.PI * hz * at) / RATE));
  return { name, bytes: stereoWav(wave, wave, RATE) };
}

/** The audio the song's files hold, as importing them left it in memory. */
const SAMPLES: LoadedSamples = new Map([
  ["audio/kick.wav", tone("kick.wav", 55, 0.2)],
  ["audio/vocal.wav", tone("vocal.wav", 330, 4)],
  ["audio/guitar.wav", tone("guitar.wav", 196, 3)],
  ["audio/reference.wav", tone("reference.wav", 440, 2)],
]);

/** One bar of a note on every beat, at `pitch`. */
function beats(pitch: number, velocity = 0.8) {
  return [0, 1, 2, 3].map((beat) => ({ pitch, start: beat * BEAT, length: BEAT / 2, velocity }));
}

/**
 * Every edit of the song, in the order a musician might make them: four
 * Instrument Tracks (three Synths and a Drum Sampler with a sample of its
 * own on the Kick) and two Audio Tracks, with Clips, notes, a trim, a Bus
 * fed by an Output and a Send, Effects, Automation, a Tempo Change, a
 * Section, the mixer and a Reference Track.
 */
function edits(): Command[] {
  const keys = createInstrumentTrack("Keys", "keys");
  const bass = createInstrumentTrack("Bass", "bass");
  const lead = createInstrumentTrack("Lead", "lead");
  const drums = createDrumTrack("Drums", "drums");
  const vocals = createAudioTrack("Vocals", "vocals");
  const guitar = createAudioTrack("Guitar", "guitar");
  const band = createBus("Band", "band");
  const pattern = (id: string, start: number, bars: number) => ({ id, kind: "pattern" as const, start, length: bars * BAR, notes: [] });
  return [
    { type: "setProjectName", name: "Round trip" },
    { type: "setTempo", tempo: 110 },
    ...[keys, bass, lead, drums, vocals, guitar].map((track): Command => ({ type: "addTrack", track })),
    { type: "setSynthPreset", trackId: "bass", preset: "Sub Bass" },
    { type: "setSynthSettings", trackId: "lead", settings: { cutoffHz: 2_400, attack: 0.02 } },
    { type: "setDrumPad", trackId: "drums", pad: 0, settings: { sample: "audio/kick.wav", volume: 0.9 } },
    { type: "addClip", trackId: "keys", clip: pattern("keys-1", 0, 4) },
    { type: "setPatternNotes", clipId: "keys-1", notes: [{ pitch: 60, start: 0, length: 2 * BAR, velocity: 0.6 }, { pitch: 64, start: 2 * BAR, length: 2 * BAR, velocity: 0.6 }] },
    { type: "addClip", trackId: "bass", clip: { ...pattern("bass-1", 0, 1), notes: beats(36) } },
    { type: "addClip", trackId: "lead", clip: { ...pattern("lead-1", 2 * BAR, 2), notes: beats(72, 0.7) } },
    { type: "addClip", trackId: "drums", clip: { ...pattern("drums-1", 0, 4), notes: [...beats(36, 1), ...beats(42, 0.5)] } },
    { type: "addClip", trackId: "vocals", clip: { id: "vocals-1", kind: "audio", start: BAR, duration: 4, file: "audio/vocal.wav", fileOffset: 0 } },
    { type: "trimClip", clipId: "vocals-1", start: BAR + BEAT, length: 3 * BEAT, fileOffset: 0.5 },
    { type: "addClip", trackId: "guitar", clip: { id: "guitar-1", kind: "audio", start: 2 * BAR, duration: 3, file: "audio/guitar.wav", fileOffset: 0 } },
    { type: "moveClip", clipId: "bass-1", start: BAR },
    { type: "addBus", bus: band },
    { type: "setTrackOutput", trackId: "bass", output: "band" },
    { type: "addSend", from: { trackId: "vocals" }, busId: "band", level: 0.4 },
    { type: "addEffect", target: { busId: "band" }, effect: createEffect("reverb", "band-reverb") },
    { type: "addEffect", target: { trackId: "keys" }, effect: createEffect("eq", "keys-eq") },
    { type: "setEffectSettings", effectId: "keys-eq", settings: { lowShelfGainDb: -6 } },
    { type: "addEffect", target: "master", effect: createEffect("compressor", "master-comp") },
    {
      type: "setAutomation",
      target: { trackId: "vocals" },
      setting: "volume",
      breakpoints: [
        { tick: BAR, value: 0.2, hold: false },
        { tick: 2 * BAR, value: 1, hold: true },
      ],
    },
    { type: "setTrackMixer", trackId: "guitar", mixer: { volume: 0.7, pan: -0.3 } },
    { type: "setBusMixer", busId: "band", mixer: { volume: 0.8 } },
    { type: "addTempoChange", tempoChange: { id: "slower", tick: 3 * BAR, tempo: 90, timeSignature: null } },
    { type: "addSection", section: { id: "verse", name: "Verse", startBar: 1, bars: 4 } },
    { type: "setMasterVolume", volume: 0.9 },
    { type: "setReferenceTrack", referenceTrack: { file: "audio/reference.wav" } },
  ];
}

/** The whole song exported as a 24-bit WAV, from the top to its last Clip. */
async function exported(project: Project, samples: LoadedSamples): Promise<Uint8Array> {
  const request = exportRequest(project, samples, { startTick: 0, endTick: songEndTick(project) }, {
    sampleRate: RATE,
    encoding: { kind: "wav", bits: 24 },
  });
  return (await renderMix(request, { onProgress: () => {}, signal: new AbortController().signal }))!;
}

test("a song of four Instrument Tracks and two Audio Tracks is saved, closed, reopened and exported without an edit lost", async () => {
  // Built one edit at a time, each its own undo step, as the UI makes them.
  const history = new ProjectHistory(createProject());
  for (const edit of edits()) {
    const done = history.execute(edit);
    if (!done.ok) throw new Error(`${edit.type} was refused: ${done.error}`);
  }
  expect(history.canUndo).toBe(true);
  const built = history.project;
  expect(built.tracks.filter((track) => track.kind === "instrument")).toHaveLength(4);
  expect(built.tracks.filter((track) => track.kind === "audio")).toHaveLength(2);

  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/round-trip");
  expect(await saveProject(storage, built, folder, null, SAMPLES)).toEqual({ ok: true, missingAudio: [] });
  expect(storage.files(folder.id)).toEqual([...[...SAMPLES.keys()].toSorted(), DATA_FILE]);
  const original = await exported(built, SAMPLES);

  // Closed: nothing but the folder is left, and it opens as the same song, every file whole.
  const opened = await openProject(storage, folder);
  if (!opened.ok) throw new Error(opened.error);
  expect(opened.project).toEqual(built);
  expect(opened.project).not.toBe(built);
  expect(opened.missingAudio).toEqual([]);
  expect(opened.samples).toEqual(SAMPLES);

  // Exported, it is the file the song made before it was closed, and it has sound in it.
  const again = await exported(opened.project, opened.samples);
  expect(new TextDecoder().decode(again.subarray(0, 4))).toBe("RIFF");
  expect(again.length).toBeGreaterThan(44 + 3 * RATE * 2 * 3);
  // Byte for byte: a mismatch as one line rather than millions.
  expect(Buffer.compare(again, original)).toBe(0);
  const silent = again.subarray(44).every((byte) => byte === 0);
  expect(silent).toBe(false);
  // The Audio Tracks and the Kick's sample are in it: without their files it is another song.
  expect(Buffer.compare(await exported(opened.project, new Map()), original)).not.toBe(0);
  // Three renders of the whole song, reverb tail and all, while every other test file runs beside it.
}, 30_000);
