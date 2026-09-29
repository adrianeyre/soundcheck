import { expect, test } from "vitest";

import { sampleProject } from "./fixtures";
import { EFFECT_TYPES } from "../effect/effect-params";
import { createEffect, DEFAULT_EFFECT_SETTINGS, DEFAULT_SYNTH, FIRST_STARTER_KIT, SCHEMA_VERSION, STARTER_KIT, type Track } from "./model";
import { EngineSync } from "./engine-sync";
import { parseProject, serialiseProject } from "./serialise";

test("a Project round-trips through its saved form unchanged, schema version included", () => {
  const project = sampleProject();
  const saved = serialiseProject(project);
  expect(JSON.parse(saved).schemaVersion).toBe(SCHEMA_VERSION);
  expect(parseProject(saved)).toEqual({ ok: true, project });
});

test("a Project from a newer version is refused, not misread", () => {
  const saved = JSON.stringify({ ...sampleProject(), schemaVersion: SCHEMA_VERSION + 1 });
  const result = parseProject(saved);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error).toMatch(/newer version/);
});

test("files that aren't Projects, or are damaged, are refused with a reason", () => {
  expect(parseProject("not json").ok).toBe(false);
  expect(parseProject("[1, 2]").ok).toBe(false);
  expect(parseProject(JSON.stringify({ name: "x" })).ok).toBe(false);

  const damaged = sampleProject() as unknown as { tracks: { clips: unknown[] }[] };
  damaged.tracks[2]!.clips.push({ id: "p", kind: "pattern", start: 0, length: 960, notes: [] });
  const result = parseProject(JSON.stringify(damaged));
  expect(!result.ok && result.error).toMatch(/damaged: .*only holds Audio Clips/);
});

test("a schema 1 Project opens with its Synth settings kept and the new ones defaulted", () => {
  // Schema 1's Synth had six settings, and allowed an attack of 0, which is
  // now below the shortest stage the Synth allows.
  const project = sampleProject() as unknown as Record<string, unknown>;
  const tracks = structuredClone(project.tracks) as Record<string, unknown>[];
  (tracks[0]!.instrument as Record<string, unknown>).settings = {
    cutoffHz: 800,
    resonance: 4,
    attack: 0,
    decay: 0.1,
    sustain: 0.4,
    release: 1.5,
  };
  const saved = JSON.stringify({ ...project, schemaVersion: 1, tracks });

  const result = parseProject(saved);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.schemaVersion).toBe(SCHEMA_VERSION);
  const instrument = result.project.tracks[0]!;
  if (instrument.kind !== "instrument" || instrument.instrument.type !== "synth") throw new Error("a Synth");
  expect(instrument.instrument.settings).toEqual({
    ...DEFAULT_SYNTH,
    cutoffHz: 800,
    resonance: 4,
    attack: 0.001, // brought up to the shortest stage the Synth allows
    decay: 0.1,
    sustain: 0.4,
    release: 1.5,
  });
});

test("a schema 1 Project with a Drum Track opens, its pads filled in from the starter kit", () => {
  // Schema 1's pads held a sample and a volume and nothing else: #10 gave a
  // pad its name, its note, pan, pitch and a choke group.
  const project = sampleProject() as unknown as Record<string, unknown>;
  const tracks = structuredClone(project.tracks) as Record<string, unknown>[];
  const drums = tracks[3]!.instrument as Record<string, unknown>;
  drums.pads = [
    { sample: null, volume: 1 },
    { sample: "audio/my-snare.wav", volume: 0.8 },
    ...FIRST_STARTER_KIT.slice(2).map(() => ({ sample: null, volume: 1 })),
    // A ninth pad, past the end of the kit those Projects played: it still
    // needs a name and a note of its own, and no other pad's note, as it
    // always did, although the Starter Kit has since grown past eight.
    { sample: "audio/shaker.wav", volume: 0.5 },
  ];
  const saved = JSON.stringify({ ...project, schemaVersion: 1, tracks });

  const result = parseProject(saved);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const track = result.project.tracks[3]!;
  if (track.kind !== "instrument" || track.instrument.type !== "drumSampler") throw new Error("a Drum Sampler");
  const pads = track.instrument.pads;
  expect(pads[0]).toEqual({ ...STARTER_KIT[0], sample: null, volume: 1 });
  // The musician's own sample and volume survive the migration.
  expect(pads[1]).toEqual({ ...STARTER_KIT[1], sample: "audio/my-snare.wav", volume: 0.8 });
  expect(pads[8]).toEqual({
    name: "Pad 9",
    note: expect.any(Number),
    sample: "audio/shaker.wav",
    volume: 0.5,
    pan: 0,
    pitch: 0,
    chokeGroup: 0,
  });
  expect(new Set(pads.map((pad) => pad.note)).size).toBe(pads.length);
  expect(pads[8]!.note).toBe(57);
  expect(pads).toHaveLength(9);
});

test("a Project saved with the eight-pad Starter Kit opens with its eight pads, as saved", () => {
  // Before the kit grew, a new Drum Sampler got its first eight pads: such a
  // Project keeps them, and gains none of the new ones.
  const project = sampleProject();
  const tracks = structuredClone(project.tracks);
  const drums = tracks.find((track) => track.kind === "instrument" && track.instrument.type === "drumSampler");
  if (!drums || drums.kind !== "instrument" || drums.instrument.type !== "drumSampler") throw new Error("a Drum Sampler");
  drums.instrument.pads = FIRST_STARTER_KIT.map((pad) => ({ ...pad }));
  const result = parseProject(serialiseProject({ ...project, tracks }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const opened = result.project.tracks.find((track) => track.id === drums.id)!;
  if (opened.kind !== "instrument" || opened.instrument.type !== "drumSampler") throw new Error("a Drum Sampler");
  expect(opened.instrument.pads).toEqual(FIRST_STARTER_KIT);
  // A new Drum Sampler has the whole kit.
  expect(STARTER_KIT.length).toBe(22);
});

test("a schema 2 Project opens with its EQs' bands kept under their new names", () => {
  // Schema 2's EQ had a low and a high band and one in the middle.
  const project = sampleProject() as unknown as Record<string, unknown>;
  const tracks = structuredClone(project.tracks) as Record<string, unknown>[];
  const chain = tracks[0]!.insertChain as Record<string, unknown>[];
  chain[0]!.settings = {
    lowFrequency: 120,
    lowGainDb: 2,
    midFrequency: 900,
    midQ: 1.5,
    midGainDb: -3,
    highFrequency: 6000,
    highGainDb: 30, // out of range, so brought into it
  };
  const master = { volume: 1, insertChain: [{ ...chain[0]!, id: "master-eq" }] };
  const saved = JSON.stringify({ ...project, schemaVersion: 2, tracks, master });

  const result = parseProject(saved);
  expect(result.ok && result.project.schemaVersion).toBe(SCHEMA_VERSION);
  if (!result.ok) return;
  const expected = {
    ...DEFAULT_EFFECT_SETTINGS.eq,
    lowShelfHz: 120,
    lowShelfGainDb: 2,
    band2Hz: 900,
    band2Q: 1.5,
    band2GainDb: -3,
    highShelfHz: 6000,
    highShelfGainDb: 24,
  };
  expect(result.project.tracks[0]!.insertChain[0]!.settings).toEqual(expected);
  expect(result.project.master.insertChain[0]!.settings).toEqual(expected);
  // The rest of the chain is as it was.
  expect(result.project.tracks[0]!.insertChain[1]).toEqual((project.tracks as Track[])[0]!.insertChain[1]);
});

test("a schema 3 Project opens with its Compressors given the hard knee they had", () => {
  const project = sampleProject() as unknown as Record<string, unknown>;
  const master = structuredClone(project.master) as { insertChain: { type: string; settings: object }[] };
  const compressor = master.insertChain.find((effect) => effect.type === "compressor")!;
  const { kneeDb: _, ...schema3 } = { ...DEFAULT_EFFECT_SETTINGS.compressor, ratio: 8 };
  compressor.settings = schema3;
  const saved = JSON.stringify({ ...project, schemaVersion: 3, master });

  const result = parseProject(saved);
  expect(result.ok && result.project.schemaVersion).toBe(SCHEMA_VERSION);
  if (!result.ok) return;
  const migrated = result.project.master.insertChain.find((effect) => effect.type === "compressor")!;
  expect(migrated.settings).toEqual({ ...DEFAULT_EFFECT_SETTINGS.compressor, ratio: 8, kneeDb: 0 });
  expect(DEFAULT_EFFECT_SETTINGS.compressor.kneeDb).toBe(6);
});

test("a schema 3 Project opens with its Reverbs' sound carried over to the new settings", () => {
  // Schema 3's Reverb was Freeverb's controls: a room size and separate wet
  // and dry levels.
  const project = sampleProject() as unknown as Record<string, unknown>;
  const tracks = structuredClone(project.tracks) as Record<string, unknown>[];
  const chain = tracks[0]!.insertChain as Record<string, unknown>[];
  expect(chain[1]!.type).toBe("reverb");
  chain[1]!.settings = { roomSize: 0.7, damping: 0.3, wet: 0.25, dry: 1, width: 0.5 };
  const biggest = { ...chain[1]!, id: "master-reverb", settings: { roomSize: 1, wet: 1, dry: 0 } };
  const master = { volume: 1, insertChain: [biggest] };
  const saved = JSON.stringify({ ...project, schemaVersion: 3, tracks, master });

  const result = parseProject(saved);
  expect(result.ok && result.project.schemaVersion).toBe(SCHEMA_VERSION);
  if (!result.ok) return;
  const reverb = result.project.tracks[0]!.insertChain[1]!.settings;
  const kept = { damping: 0.3, width: 0.5, mix: 0.2 };
  expect(reverb).toEqual({ ...DEFAULT_EFFECT_SETTINGS.reverb, ...kept, decay: expect.any(Number) });
  // Room size 0.7 was a tail of about two seconds.
  expect((reverb as { decay: number }).decay).toBeCloseTo(1.96, 1);
  // The biggest room rang longer than the longest decay, so it gets that;
  // fully wet with no dry is a mix of 1.
  const expected = { ...DEFAULT_EFFECT_SETTINGS.reverb, decay: 10, mix: 1 };
  expect(result.project.master.insertChain[0]!.settings).toEqual(expected);
  // The EQ before it is untouched.
  expect(result.project.tracks[0]!.insertChain[0]).toEqual((project.tracks as Track[])[0]!.insertChain[0]);
});

test("a schema 3 Project with both a Compressor and a Reverb migrates both", () => {
  const project = sampleProject() as unknown as Record<string, unknown>;
  const { kneeDb: _, ...oldCompressor } = DEFAULT_EFFECT_SETTINGS.compressor;
  const master = {
    volume: 1,
    insertChain: [
      { id: "c", type: "compressor", bypassed: false, settings: oldCompressor },
      { id: "r", type: "reverb", bypassed: false, settings: { roomSize: 0.7, wet: 1, dry: 1 } },
    ],
  };
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 3, master }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const [compressor, reverb] = result.project.master.insertChain;
  expect((compressor!.settings as { kneeDb: number }).kneeDb).toBe(0);
  expect((reverb!.settings as { mix: number }).mix).toBeCloseTo(0.5);
  expect(reverb!.settings).not.toHaveProperty("roomSize");
});

test("a schema 4 Project opens with no Tempo Changes and its Audio Clips' lengths as seconds", () => {
  const project = sampleProject() as unknown as Record<string, unknown>;
  const { tempoChanges: _, ...schema4 }: Record<string, unknown> = { ...project, tempo: 90 };
  const tracks = structuredClone(project.tracks) as { kind: string; clips: Record<string, unknown>[] }[];
  const vocals = tracks.find((track) => track.kind === "audio")!;
  const { duration: __, ...clip } = vocals.clips[0]!;
  // Three bars of 4/4 at 90 bpm: 8 seconds.
  vocals.clips[0] = { ...clip, length: 3 * 3840 };
  const result = parseProject(JSON.stringify({ ...schema4, schemaVersion: 4, tracks }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.tempoChanges).toEqual([]);
  const migrated = result.project.tracks.find((track) => track.kind === "audio")!.clips[0]!;
  expect(migrated).toEqual({ ...clip, duration: 8 });
  expect(migrated).not.toHaveProperty("length");
  // Pattern Clips keep their length in ticks.
  const keys = result.project.tracks.find((track) => track.kind === "instrument")!.clips[0]!;
  expect(keys).toHaveProperty("length");
});

test("a schema 5 Project opens with no Buses and every Track feeding the Master", () => {
  const { buses: _, ...project } = sampleProject() as unknown as Record<string, unknown>;
  const tracks = (project.tracks as Record<string, unknown>[]).map(({ output: __, ...track }) => track);
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 5, tracks }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.schemaVersion).toBe(SCHEMA_VERSION);
  expect(result.project.buses).toEqual([]);
  expect(result.project.tracks.map((track) => track.output)).toEqual([null, null, null, null]);
});

test("a Project whose Buses feed each other in a loop is refused, naming the loop", () => {
  const project = sampleProject();
  project.buses.push({ ...project.buses[0]!, id: "drum-bus", name: "Drums", insertChain: [], output: "band" });
  project.buses[0]!.output = "drum-bus";
  expect(parseProject(serialiseProject(project))).toEqual({
    ok: false,
    error: "This Project file is damaged: The Buses feed each other in a loop (Band → Drums → Band), so the signal would never reach the Master",
  });
});

test("a Project routing a Track to a Bus it hasn't got is refused", () => {
  const project = sampleProject();
  project.tracks[0]!.output = "gone";
  const result = parseProject(serialiseProject(project));
  expect(result.ok || result.error).toContain("Track Keys's output must be the Master (null) or a Bus in the Project");
});

test("a schema 6 Project opens with nothing automated", () => {
  const { master, ...project } = sampleProject();
  const tracks = project.tracks.map(({ automation: __, ...track }) => track);
  const { automation: _, ...oldMaster } = master;
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 6, tracks, master: oldMaster }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.schemaVersion).toBe(SCHEMA_VERSION);
  expect(result.project.tracks.map((track) => track.automation)).toEqual([[], [], [], []]);
  expect(result.project.master.automation).toEqual([]);
});

/** The sample song changed by `change`, saved and opened: "opened", or why it was refused. */
function refused(change: (project: ReturnType<typeof sampleProject>) => void): string {
  const project = sampleProject();
  change(project);
  const result = parseProject(serialiseProject(project));
  return result.ok ? "opened" : result.error;
}

/** The Vocals' volume Automation in the sample song. */
function vocalsVolume(project: ReturnType<typeof sampleProject>) {
  return project.tracks[2]!.automation[0]!;
}

/** The sample song's Drums with a Pad setting of theirs automated at `value`. */
function padAutomated(setting: `instrument:${string}`, value: number) {
  return (project: ReturnType<typeof sampleProject>) =>
    project.tracks[3]!.automation.push({ setting, breakpoints: [{ tick: 0, value, hold: false }] });
}

test("Automation that breaks its rules is refused with a reason", () => {

  expect(refused((project) => project.master.automation.push({ setting: "pan", breakpoints: [{ tick: 0, value: 0, hold: false }] }))).toMatch(
    /The Master has no setting pan to automate/,
  );
  expect(refused((project) => project.tracks[2]!.automation.push({ ...vocalsVolume(project) }))).toMatch(/automates its volume twice/);
  expect(refused((project) => (vocalsVolume(project).breakpoints = []))).toMatch(/has 1 to 4096 breakpoints/);
  expect(refused((project) => (vocalsVolume(project).breakpoints = vocalsVolume(project).breakpoints.toReversed()))).toMatch(/must be in order, one to a tick/);
  expect(
    refused((project) => project.buses[0]!.automation.push({ setting: "effect:keys-eq:lowShelfGainDb", breakpoints: [{ tick: 0, value: 0, hold: false }] })),
  ).toMatch(/Bus Band has no setting effect:keys-eq:lowShelfGainDb to automate/);
  expect(
    refused((project) => project.tracks[0]!.automation.push({ setting: "instrument:cutoffHz", breakpoints: [{ tick: 0, value: 5, hold: false }] })),
  ).toMatch(/synth: cutoff breakpoint's value must be a number from 20 to 20000/);
  // A Drum Sampler Pad's numbers, by the note that plays it.
  expect(refused(padAutomated("instrument:pad36.pitch", -24))).toBe("opened");
  expect(refused(padAutomated("instrument:pad36.pitch", 25))).toMatch(/kick: pitch breakpoint's value must be a number from -24 to 24/);
  expect(refused(padAutomated("instrument:pad36.chokeGroup", 0))).toMatch(/Track Drums has no setting instrument:pad36\.chokeGroup to automate/);
  expect(refused(padAutomated("instrument:pad99.volume", 1))).toMatch(/Track Drums has no setting instrument:pad99\.volume to automate/);
  expect(refused((project) => (vocalsVolume(project).breakpoints[0]!.value = 3))).toMatch(/volume breakpoint's value must be a number from 0 to 2/);
  expect(refused((project) => (vocalsVolume(project).breakpoints[0]!.tick = 1.5))).toMatch(/whole number of ticks/);
  expect(
    refused((project) => project.tracks[0]!.automation.push({ setting: "pan", breakpoints: [{ tick: 0, value: -1, hold: true }] })),
  ).toBe("opened");
});

test("a schema 7 Project opens with no Sends", () => {
  const project = sampleProject();
  const tracks = project.tracks.map(({ sends: __, ...track }) => track);
  const buses = project.buses.map(({ sends: __, ...bus }) => bus);
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 7, tracks, buses }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.schemaVersion).toBe(SCHEMA_VERSION);
  expect(result.project.tracks.map((track) => track.sends)).toEqual([[], [], [], []]);
  expect(result.project.buses.map((bus) => bus.sends)).toEqual([[]]);
});

test("the sample song's Send survives a save and open", () => {
  const result = parseProject(serialiseProject(sampleProject()));
  expect(result.ok && result.project.tracks[2]!.sends).toEqual([{ busId: "band", level: 0.5 }]);
});

/** A second Bus, Drums, feeding Band. */
function withDrums(project: ReturnType<typeof sampleProject>) {
  project.buses.push({ ...project.buses[0]!, id: "drum-bus", name: "Drums", insertChain: [], output: "band", sends: [] });
}

test("Sends that break their rules, or loop, are refused with a reason", () => {
  expect(refused((project) => project.tracks[0]!.sends.push({ busId: "gone", level: 1 }))).toMatch(
    /Track Keys's Send must feed a Bus in the Project, not "gone"/,
  );
  expect(refused((project) => project.tracks[2]!.sends.push({ busId: "band", level: 1 }))).toMatch(/Track Vocals has two Sends to one Bus/);
  expect(refused((project) => (project.tracks[2]!.sends[0]!.level = -1))).toMatch(/Send level must be a number from 0 to 2/);
  expect(refused((project) => project.buses[0]!.sends.push({ busId: "band", level: 1 }))).toMatch(
    /The Buses feed each other in a loop \(Band → Band\)/,
  );
  expect(
    refused((project) => {
      withDrums(project);
      project.buses[0]!.sends.push({ busId: "drum-bus", level: 1 });
    }),
  ).toMatch(/The Buses feed each other in a loop \(Band → Drums → Band\)/);
  expect(
    refused((project) => {
      withDrums(project);
      project.buses[1]!.sends.push({ busId: "band", level: 1 });
    }),
  ).toBe("opened");
});

test("a schema 8 Project opens with its Buses automating nothing", () => {
  const project = sampleProject();
  const buses = project.buses.map(({ automation: __, ...bus }) => bus);
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 8, buses }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.schemaVersion).toBe(SCHEMA_VERSION);
  expect(result.project.buses.map((bus) => bus.automation)).toEqual([[]]);
  expect(result.project.tracks[2]!.automation).toEqual(project.tracks[2]!.automation);
});

test("a schema 9 Project opens as it was: a Plugin Effect is new in schema 10", () => {
  const project = sampleProject();
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 9 }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual({ ...project, schemaVersion: SCHEMA_VERSION });
});

test("a Plugin Effect keeps its Plugin's id, version and settings, and is refused if they break their rules", () => {
  const project = sampleProject();
  const plugin = { id: "fx", type: "plugin", bypassed: false, plugin: { id: "dev.example.fx", version: "1.2.0" }, settings: { drive: 0.3 } };
  const withPlugin = { ...project, master: { ...project.master, insertChain: [plugin] } };
  const saved = parseProject(JSON.stringify(withPlugin));
  expect(saved.ok && saved.project.master.insertChain).toEqual([plugin]);

  for (const [broken, reason] of [
    [{ ...plugin, plugin: { id: "", version: "1" } }, "id"],
    [{ ...plugin, plugin: { id: "dev.example.fx" } }, "version"],
    [{ ...plugin, settings: { drive: "loud" } }, "drive"],
    [{ ...plugin, extra: true }, "extra"],
  ] as const) {
    const result = parseProject(JSON.stringify({ ...project, master: { ...project.master, insertChain: [broken] } }));
    expect({ reason, ok: result.ok }).toEqual({ reason, ok: false });
  }
});

test("a schema 10 Project opens as it was: a Plugin Instrument is new in schema 11", () => {
  const project = sampleProject();
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 10 }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual({ ...project, schemaVersion: SCHEMA_VERSION });
});

test("a Plugin Instrument keeps its Plugin's id, version and settings, and is refused if they break their rules", () => {
  const project = sampleProject();
  const index = project.tracks.findIndex((track) => track.kind === "instrument");
  const withInstrument = (instrument: unknown) => ({
    ...project,
    tracks: project.tracks.map((track, i) => (i === index ? { ...track, instrument } : track)),
  });
  const plugin = { type: "plugin", plugin: { id: "dev.example.keys", version: "0.3.0" }, settings: { level: 0.4, attack: 12 } };
  const saved = parseProject(JSON.stringify(withInstrument(plugin)));
  expect(saved.ok && saved.project.tracks[index]).toMatchObject({ instrument: plugin });

  for (const [broken, reason] of [
    [{ ...plugin, plugin: { id: "", version: "1" } }, "id"],
    [{ ...plugin, plugin: { id: "dev.example.keys" } }, "version"],
    [{ ...plugin, settings: { level: "loud" } }, "level"],
    [{ ...plugin, preset: null }, "preset"],
  ] as const) {
    const result = parseProject(JSON.stringify(withInstrument(broken)));
    expect({ reason, ok: result.ok }).toEqual({ reason, ok: false });
  }
});

test("a schema 15 Project opens as it was: a VST3 Plugin is new in schema 16", () => {
  const project = sampleProject();
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 15 }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual({ ...project, schemaVersion: SCHEMA_VERSION });
});

test("a schema 16 Project opens as it was: Shared Projects are new in schema 17", () => {
  const project = sampleProject();
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 16 }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual({ ...project, schemaVersion: SCHEMA_VERSION });
});

test("a schema 17 Project opens as it was: the Saturator and seven more Effects are new in schema 18", () => {
  const project = sampleProject();
  const result = parseProject(JSON.stringify({ ...project, schemaVersion: 17 }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual({ ...project, schemaVersion: SCHEMA_VERSION });
});

test("every built-in Effect saves and opens with its settings", () => {
  const project = sampleProject();
  // More than one Insert Chain holds: the first sixteen on a Track, the rest on the Master.
  const index = project.tracks.findIndex((track) => track.kind === "instrument");
  const effects = EFFECT_TYPES.map((type) => createEffect(type, `fx-${type}`));
  project.tracks[index]!.insertChain = effects.slice(0, 16);
  project.master.insertChain = effects.slice(16);
  expect(project.master.insertChain.length).toBeLessThanOrEqual(16);
  const result = parseProject(serialiseProject(project));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual(project);
});

test("a VST3 Plugin keeps its name, vendor and state exactly, and is refused if they break their rules", () => {
  const project = sampleProject();
  const index = project.tracks.findIndex((track) => track.kind === "instrument");
  const vst3 = { name: "Tilt", vendor: "Tilters", state: { component: "AAEC/w==", controller: "" } };
  const effect = {
    id: "fx",
    type: "plugin",
    bypassed: false,
    plugin: { id: "vst3.0123456789abcdef0123456789abcdef", version: "1.0.2" },
    settings: { p0: 0.5, p7: 1 },
    vst3,
  };
  const instrument = { type: "plugin", plugin: { id: "vst3.fedcba9876543210fedcba9876543210", version: "2" }, settings: {}, vst3 };
  const withBoth = (fx: unknown, keys: unknown) => ({
    ...project,
    master: { ...project.master, insertChain: [fx] },
    tracks: project.tracks.map((track, i) => (i === index ? { ...track, instrument: keys } : track)),
  });
  const saved = parseProject(JSON.stringify(withBoth(effect, instrument)));
  expect(saved.ok && saved.project.master.insertChain).toEqual([effect]);
  expect(saved.ok && saved.project.tracks[index]).toMatchObject({ instrument });

  // Just over 16 MB once decoded.
  const huge = "A".repeat(Math.ceil((16 * 1024 * 1024) / 3) * 4 + 4);
  for (const [broken, reason] of [
    [{ ...effect, vst3: { ...vst3, state: { component: huge, controller: "" } } }, "a state over 16 MB"],
    [{ ...effect, vst3: { ...vst3, state: { component: "not base64!", controller: "" } } }, "a state that isn't base64"],
    [{ ...effect, vst3: { ...vst3, state: { component: "" } } }, "no controller state"],
    [{ ...effect, vst3: { ...vst3, name: "" } }, "no name"],
    [{ ...effect, vst3: { ...vst3, path: "C:/Plugins/Tilt.vst3" } }, "a path"],
    [{ ...effect, vst3: undefined }, "a VST3 id without its VST3 part"],
    [{ ...effect, plugin: { id: "dev.example.fx", version: "1" } }, "a VST3 part on a WASM Plugin"],
  ] as const) {
    const result = parseProject(JSON.stringify(withBoth(broken, instrument)));
    expect({ reason, ok: result.ok }).toEqual({ reason, ok: false });
  }
  const noState = parseProject(JSON.stringify(withBoth(effect, { ...instrument, vst3: { ...vst3, state: null } })));
  expect({ reason: "an Instrument with no state", ok: noState.ok }).toEqual({ reason: "an Instrument with no state", ok: false });
});

test("a schema 11 Project opens with no Sections, and the engine is sent exactly what it was", () => {
  const project = sampleProject();
  const { sections: __, ...schema11 } = project;
  const result = parseProject(JSON.stringify({ ...schema11, schemaVersion: 11 }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual({ ...project, schemaVersion: SCHEMA_VERSION, sections: [] });
  // A Section changes nothing heard: the same song with Sections plays the same.
  const withSections = { ...result.project, sections: [{ id: "intro", name: "Intro", startBar: 1, bars: 4 }] };
  expect(new EngineSync().update(withSections)).toEqual(new EngineSync().update(result.project));
});

test("Sections survive a save and open, and ones that overlap or break their rules are refused", () => {
  const project = sampleProject();
  const intro = { id: "intro", name: "Intro", startBar: 1, bars: 4 };
  const verse = { id: "verse", name: "Verse", startBar: 5, bars: 8 };
  const saved = parseProject(serialiseProject({ ...project, sections: [intro, verse] }));
  expect(saved.ok && saved.project.sections).toEqual([intro, verse]);

  for (const [sections, reason] of [
    [[intro, { ...verse, startBar: 4 }], /Section “Verse” \(bars 4–11\) overlaps “Intro” \(bars 1–4\)/],
    [[intro, { ...verse, startBar: 1, bars: 1 }], /overlaps/],
    [[verse, intro], /bar order/],
    [[{ ...intro, startBar: 0 }], /whole bar from 1/],
    [[{ ...intro, bars: 0.5 }], /whole number of bars/],
    [[{ ...intro, name: "" }], /Section name/],
    [[{ ...intro, id: "keys" }], /already used/],
    [[{ ...intro, colour: "red" }], /unknown fields: colour/],
  ] as const) {
    const result = parseProject(JSON.stringify({ ...project, sections }));
    expect(!result.ok && result.error).toMatch(reason);
  }
});

test("a schema 12 Project opens with no Reference Track, and the engine is sent exactly what it was", () => {
  const project = sampleProject();
  const { referenceTrack: __, ...schema12 } = project;
  const result = parseProject(JSON.stringify({ ...schema12, schemaVersion: 12 }));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual({ ...project, schemaVersion: SCHEMA_VERSION, referenceTrack: null });
  // A Reference Track is never in the mix: the same song with one plays the same.
  const withReference = { ...result.project, referenceTrack: { file: "audio/finished.wav" } };
  expect(new EngineSync().update(withReference)).toEqual(new EngineSync().update(result.project));
});

test("a Reference Track survives a save and open, and a damaged one is refused", () => {
  const project = { ...sampleProject(), referenceTrack: { file: "audio/finished.wav" } };
  expect(parseProject(serialiseProject(project))).toEqual({ ok: true, project });

  for (const [referenceTrack, reason] of [
    [{ file: "" }, /Reference Track needs a file/],
    [{}, /Reference Track is missing: file/],
    [{ file: "audio/finished.wav", gain: 1 }, /unknown fields: gain/],
    ["audio/finished.wav", /Reference Track must be an object/],
  ] as const) {
    const result = parseProject(JSON.stringify({ ...project, referenceTrack }));
    expect(!result.ok && result.error).toMatch(reason);
  }
});

test("a schema 13 Project opens with every Audio Track on the default input's first two channels, as it recorded then", () => {
  const project = sampleProject();
  const schema13 = {
    ...project,
    schemaVersion: 13,
    tracks: project.tracks.map((track) => {
      if (track.kind !== "audio") return track;
      const { input: __, ...old } = track;
      return old;
    }),
  };
  const result = parseProject(JSON.stringify(schema13));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual({ ...project, schemaVersion: SCHEMA_VERSION });
  const vocals = result.project.tracks.find((track) => track.kind === "audio");
  expect(vocals).toMatchObject({ input: { device: null, channels: null } });
  expect(result.project.tracks.filter((track) => "input" in track)).toEqual([vocals]);
});

test("an Audio Track's Input survives a save and open, and a damaged one is refused", () => {
  const project = sampleProject();
  const vocals = project.tracks.find((track) => track.kind === "audio")!;
  vocals.input = { device: "Scarlett 18i20", channels: [4] };
  expect(parseProject(serialiseProject(project))).toEqual({ ok: true, project });
  vocals.input = { device: "Scarlett 18i20", channels: [2, 3] };
  expect(parseProject(serialiseProject(project))).toEqual({ ok: true, project });

  for (const [input, reason] of [
    [{ device: null }, /Input is missing: channels/],
    [{ device: null, channels: null, gain: 1 }, /unknown fields: gain/],
    [{ device: 3, channels: null }, /Input device must be a name/],
    [{ device: null, channels: [] }, /Input channels must be null, one channel or a pair/],
    [{ device: null, channels: [0.5] }, /Input channels must be null, one channel or a pair/],
    [{ device: null, channels: [1, 1] }, /two different channels/],
  ] as const) {
    const damaged = { ...project, tracks: project.tracks.map((track) => (track === vocals ? { ...track, input } : track)) };
    const result = parseProject(JSON.stringify(damaged));
    expect(!result.ok && result.error).toMatch(reason);
  }
});

test("a schema 14 Project opens with Input Monitoring off on every Audio Track", () => {
  const project = sampleProject();
  const schema14 = {
    ...project,
    schemaVersion: 14,
    tracks: project.tracks.map((track) => {
      if (track.kind !== "audio") return track;
      const { monitoring: __, ...old } = track;
      return old;
    }),
  };
  const result = parseProject(JSON.stringify(schema14));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toEqual({ ...project, schemaVersion: SCHEMA_VERSION });
  const vocals = result.project.tracks.find((track) => track.kind === "audio");
  expect(vocals).toMatchObject({ monitoring: false });
  expect(result.project.tracks.filter((track) => "monitoring" in track)).toEqual([vocals]);
});

test("Input Monitoring survives a save and open, and one that isn't on or off is refused", () => {
  const project = sampleProject();
  const vocals = project.tracks.find((track) => track.kind === "audio")!;
  vocals.monitoring = true;
  expect(parseProject(serialiseProject(project))).toEqual({ ok: true, project });

  const damaged = { ...project, tracks: project.tracks.map((track) => (track === vocals ? { ...track, monitoring: "auto" } : track)) };
  const result = parseProject(JSON.stringify(damaged));
  expect(!result.ok && result.error).toMatch(/Input Monitoring must be on or off/);
  const { monitoring: __, ...missing } = vocals;
  const without = { ...project, tracks: project.tracks.map((track) => (track === vocals ? missing : track)) };
  const unsaved = parseProject(JSON.stringify(without));
  expect(!unsaved.ok && unsaved.error).toMatch(/missing: monitoring/);
});
