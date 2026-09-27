/** A small but complete Project for tests: every kind of thing, once. */
import {
  createAudioTrack,
  createBus,
  createDrumTrack,
  createEffect,
  createInstrumentTrack,
  createProject,
  type Project,
} from "./model";

export function sampleProject(): Project {
  const project = createProject("Test song");
  const keys = createInstrumentTrack("Keys", "keys");
  keys.clips.push({
    id: "keys-1",
    kind: "pattern",
    start: 0,
    length: 3840,
    notes: [
      { pitch: 60, start: 0, length: 480, velocity: 0.8 },
      { pitch: 64, start: 960, length: 480, velocity: 0.7 },
    ],
  });
  keys.insertChain.push(createEffect("eq", "keys-eq"), createEffect("reverb", "keys-reverb"));
  const bass = createInstrumentTrack("Bass", "bass");
  const vocals = createAudioTrack("Vocals", "vocals");
  vocals.clips.push({ id: "vocals-1", kind: "audio", start: 3840, duration: 4, file: "audio/take1.wav", fileOffset: 0.5 });
  const drums = createDrumTrack("Drums", "drums");
  project.tracks.push(keys, bass, vocals, drums);
  const band = createBus("Band", "band");
  band.insertChain.push(createEffect("eq", "band-eq"));
  project.buses.push(band);
  bass.output = "band";
  vocals.sends.push({ busId: "band", level: 0.5 });
  project.master.insertChain.push(createEffect("compressor", "master-comp"));
  vocals.automation.push({
    setting: "volume",
    breakpoints: [
      { tick: 3840, value: 0, hold: false },
      { tick: 7680, value: 1, hold: true },
    ],
  });
  project.master.automation.push({ setting: "volume", breakpoints: [{ tick: 0, value: 0.8, hold: false }] });
  return project;
}

/** Freeze a value all the way down, so a test fails if anything changes it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
