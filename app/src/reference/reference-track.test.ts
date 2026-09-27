import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { renderMix } from "../export/browser-mix-exporter";
import { exportRequest } from "../export/mix-exporter";
import { EngineSync, type LoadedSamples } from "../project/engine-sync";
import { createAudioTrack, createProject, type Project } from "../project/model";
import { parseProject } from "../project/serialise";
import { TICKS_PER_BEAT } from "../project/time";
import { stereoWav } from "../song/test-wav";
import { FakeFileStorage, fakeFolder } from "../storage/fake-file-storage";
import { openProject, saveProject } from "../storage/project-folder";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

const tone = (hz: number, level: number) =>
  Array.from({ length: 24_000 }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / 48_000));
const TONE = tone(440, 0.5);
const FINISHED = tone(90, 0.9);
const REFERENCE = "audio/finished.wav";
/** Two whole exports each, which take a while beside the rest of the suite. */
const RENDERS = 20_000;

/** An Audio Track playing a tone for a beat, from beat 2. */
function song(): Project {
  const project = createProject("Song");
  const track = createAudioTrack("Tone");
  track.clips = [{ id: "a", kind: "audio", start: TICKS_PER_BEAT, duration: 0.5, file: "audio/tone.wav", fileOffset: 0 }];
  project.tracks = [track];
  return project;
}

const toneSamples = () => new Map([["audio/tone.wav", { name: "tone.wav", bytes: stereoWav(TONE, TONE, 48_000) }]]);

async function exported(project: Project, samples: LoadedSamples) {
  const request = exportRequest(project, samples, { startTick: 0, endTick: 4 * TICKS_PER_BEAT }, { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } });
  return renderMix(request, { onProgress: () => {}, signal: new AbortController().signal });
}

test("a Project with a Reference Track saves, reopens and exports exactly as it would without one", async () => {
  const storage = new FakeFileStorage();
  const withReference = { ...song(), referenceTrack: { file: REFERENCE } };
  const samples = new Map([
    ...toneSamples(),
    [REFERENCE, { name: "finished.wav", bytes: stereoWav(FINISHED, FINISHED, 48_000) }],
  ]);
  const folder = fakeFolder("/songs/with-reference");
  expect(await saveProject(storage, withReference, folder, null, samples)).toEqual({ ok: true, missingAudio: [] });

  // The reference is copied into the Project, and opens with it.
  expect(storage.files(folder.id)).toContain(REFERENCE);
  const opened = await openProject(storage, folder);
  expect(opened).toEqual({ ok: true, project: withReference, missingAudio: [], samples });
  if (!opened.ok) return;

  // It is never in the mix: the engine is sent what it is sent without one,
  // and the export is the same file, byte for byte.
  const without = { ...song(), referenceTrack: null };
  expect(new EngineSync().update(opened.project, opened.samples)).toEqual(new EngineSync().update(without, toneSamples()));
  const plain = await exported(without, toneSamples());
  expect(plain!.length).toBeGreaterThan(1_000);
  expect(await exported(opened.project, opened.samples)).toEqual(plain);
}, RENDERS);

test("a Project from before Reference Tracks opens with none, and renders identically", async () => {
  const current = song();
  const { referenceTrack: _, ...older } = current;
  const parsed = parseProject(JSON.stringify({ ...older, schemaVersion: 12 }));
  expect(parsed.ok && parsed.project.referenceTrack).toBeNull();
  if (!parsed.ok) return;
  expect(parsed.project).toEqual(current);
  expect(await exported(parsed.project, toneSamples())).toEqual(await exported(current, toneSamples()));
}, RENDERS);
