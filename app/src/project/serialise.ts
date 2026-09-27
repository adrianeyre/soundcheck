/**
 * A Project's saved form. It is the Project's own data as JSON, with its
 * schema version, so a Project saved by an older version can be migrated
 * forward when it is opened.
 */
import { clampEffectValue, defaultEffectSettings, effectParam } from "../effect/effect-params";
import { clampSynthValue, SYNTH_PARAMS } from "../instrument/synth-params";
import { DEFAULT_SYNTH, DEFAULT_TRACK_INPUT, type Project, SCHEMA_VERSION, STARTER_KIT } from "./model";
import { ticksToSeconds } from "./time";
import { validateProject } from "./validate";

/** How to turn a Project of schema version N into N + 1, keyed by N. */
const MIGRATIONS: Record<number, (project: Record<string, unknown>) => Record<string, unknown>> = {
  // 1 -> 2: the Synth grew from six settings to the whole table (issue #9).
  // The six a version 1 Project has keep their values, brought into the
  // ranges the table now gives; the rest take their defaults, which are the
  // sound the old Synth made.
  1: (project) => ({
    ...project,
    tracks: (project.tracks as Record<string, unknown>[] | undefined)?.map((track) => {
      const instrument = track.instrument as Record<string, unknown> | undefined;
      if (instrument?.type === "drumSampler") {
        return { ...track, instrument: { ...instrument, pads: fillPads(instrument.pads) } };
      }
      if (instrument?.type !== "synth") return track;
      const old = (instrument.settings ?? {}) as Record<string, unknown>;
      const settings = { ...DEFAULT_SYNTH } as Record<string, unknown>;
      for (const param of SYNTH_PARAMS) {
        const value = old[param.name];
        if (typeof value === "number") settings[param.name] = clampSynthValue(param, value);
      }
      return { ...track, instrument: { ...instrument, settings } };
    }),
  }),
  // 2 -> 3: the EQ was built out (issue #13). Its low and high bands are now
  // shelves, its mid band is the middle of three bells, and it has two cuts.
  // Each old setting keeps its value under its new name; everything new
  // takes the default, which leaves the sound as it was.
  2: (project) => ({
    ...project,
    master: migrateChains(project.master, migrateEq),
    tracks: (project.tracks as unknown[] | undefined)?.map((track) => migrateChains(track, migrateEq)),
  }),
  // 3 -> 4: the Compressor and the Reverb were built out (issues #14, #15).
  // The Compressors a schema 3 Project has get a hard knee, the only knee they
  // had, so they sound as they did; a new Compressor starts with the table's
  // default. A Reverb's room size, which set the feedback, becomes the decay
  // time that feedback gave; its separate wet and dry levels become one mix
  // with the same balance between them.
  3: (project) => ({
    ...project,
    master: migrateChains(project.master, migrateSchema3Effect),
    tracks: (project.tracks as unknown[] | undefined)?.map((track) => migrateChains(track, migrateSchema3Effect)),
  }),
  // 4 -> 5: Tempo Changes (issue #44). A schema 4 song had one tempo, so it
  // has none. An Audio Clip's length becomes the seconds it lasted at that
  // tempo, since audio keeps its speed when the tempo changes; the engine
  // ends it on the frame it ended on before.
  4: (project) => ({
    ...project,
    tempoChanges: [],
    tracks: (project.tracks as Record<string, unknown>[] | undefined)?.map((track) =>
      track.kind !== "audio" || !Array.isArray(track.clips)
        ? track
        : { ...track, clips: track.clips.map((clip: unknown) => migrateAudioClip(clip, project.tempo)) },
    ),
  }),
  // 5 -> 6: Buses and output routing (issue #46). A schema 5 song has no
  // Buses, and every Track fed the Master, as it still does.
  5: ({ master, ...project }) => ({
    ...project,
    tracks: (project.tracks as Record<string, unknown>[] | undefined)?.map((track) => ({ ...track, output: null })),
    buses: [],
    master,
  }),
  // 6 -> 7: Automation (issue #48). A schema 6 song automates nothing, so
  // every setting keeps its fixed value.
  6: (project) => ({
    ...project,
    tracks: (project.tracks as Record<string, unknown>[] | undefined)?.map((track) => ({ ...track, automation: [] })),
    master: { ...(project.master as Record<string, unknown> | undefined), automation: [] },
  }),
  // 7 -> 8: Sends (issue #47). A schema 7 song has none: every Track and
  // Bus feeds only its output.
  7: (project) => ({
    ...project,
    tracks: (project.tracks as Record<string, unknown>[] | undefined)?.map((track) => ({ ...track, sends: [] })),
    buses: (project.buses as Record<string, unknown>[] | undefined)?.map((bus) => ({ ...bus, sends: [] })),
  }),
  // 8 -> 9: Automation of Sends, Buses, Effects and Instruments (issue #49).
  // A schema 8 Bus automated nothing; a Track's and the Master's Automation
  // is already in the new form.
  8: (project) => ({
    ...project,
    buses: (project.buses as Record<string, unknown>[] | undefined)?.map((bus) => ({ ...bus, automation: [] })),
  }),
  // 9 -> 10: WASM Plugin Effects (issue #54), which carry their Plugin's id
  // and version. A schema 9 song has none, and its built-ins are unchanged.
  9: (project) => project,
  // 10 -> 11: WASM Plugin Instruments (issue #55), which carry their
  // Plugin's id and version as a Plugin Effect does. A schema 10 song has
  // none, and its Instruments are unchanged.
  10: (project) => project,
  // 11 -> 12: Sections (issue #97). A schema 11 song has none, and nothing
  // else changes: a Section marks the song and changes nothing heard.
  11: (project) => ({ ...project, sections: [] }),
  // 12 -> 13: the Reference Track (issue #106). A schema 12 song has none,
  // and nothing else changes: a Reference Track is never in the mix.
  12: (project) => ({ ...project, referenceTrack: null }),
  // 13 -> 14: an Audio Track's Input (issue #68). A schema 13 Audio Track
  // recorded from the default input's first two channels, a mono one copied
  // to both sides, so that is its Input.
  13: (project) => ({
    ...project,
    tracks: (project.tracks as Record<string, unknown>[] | undefined)?.map((track) =>
      track.kind === "audio" ? { ...track, input: { ...DEFAULT_TRACK_INPUT } } : track,
    ),
  }),
  // 14 -> 15: Input Monitoring (issue #68). A schema 14 Audio Track was
  // never heard while armed, so it is off.
  14: (project) => ({
    ...project,
    tracks: (project.tracks as Record<string, unknown>[] | undefined)?.map((track) =>
      track.kind === "audio" ? { ...track, monitoring: false } : track,
    ),
  }),
  // 15 -> 16: VST3 Plugins (issue #70), which are Plugin Effects and
  // Instruments with a VST3 part. A schema 15 song has none.
  15: (project) => project,
  // 16 -> 17: Shared Projects (issue #76, ADR 0007), whose folder keeps the
  // Changes made since sharing beside this Project, its base. A schema 16
  // song is unchanged; the new version keeps an older Soundcheck, which
  // would open the base alone and lose every Change, from opening one.
  16: (project) => project,
};

function migrateAudioClip(clip: unknown, tempo: unknown): unknown {
  const old = clip as Record<string, unknown> | undefined;
  if (typeof old?.length !== "number" || typeof tempo !== "number") return clip;
  const { length, ...rest } = old;
  return { ...rest, duration: ticksToSeconds(length, tempo) };
}

/** The EQ's settings in schema 2, and what each is called in schema 3. */
const EQ_RENAMES: Record<string, string> = {
  lowFrequency: "lowShelfHz",
  lowGainDb: "lowShelfGainDb",
  midFrequency: "band2Hz",
  midQ: "band2Q",
  midGainDb: "band2GainDb",
  highFrequency: "highShelfHz",
  highGainDb: "highShelfGainDb",
};

/** A Track or the Master, with `migrate` applied to each Effect in its Insert Chain. */
function migrateChains(owner: unknown, migrate: (effect: unknown) => unknown): unknown {
  const chain = (owner as Record<string, unknown> | undefined)?.insertChain;
  if (!Array.isArray(chain)) return owner;
  return { ...(owner as Record<string, unknown>), insertChain: chain.map(migrate) };
}

function migrateSchema3Effect(effect: unknown): unknown {
  return migrateReverb(migrateCompressor(effect));
}

function migrateCompressor(effect: unknown): unknown {
  const old = effect as Record<string, unknown> | undefined;
  if (old?.type !== "compressor") return effect;
  return { ...old, settings: { kneeDb: 0, ...(old.settings as Record<string, unknown> | undefined) } };
}

function migrateEq(effect: unknown): unknown {
  const old = effect as Record<string, unknown> | undefined;
  if (old?.type !== "eq") return effect;
  const oldSettings = (old.settings ?? {}) as Record<string, unknown>;
  const settings = defaultEffectSettings("eq") as unknown as Record<string, unknown>;
  for (const [from, to] of Object.entries(EQ_RENAMES)) {
    const value = oldSettings[from];
    const param = effectParam("eq", to)!;
    if (typeof value === "number") settings[to] = clampEffectValue(param, value);
  }
  return { ...old, settings };
}

/**
 * Schema 3's Reverb was Freeverb's: a room size of r fed each comb back at
 * 0.7 + 0.28r, and its combs average 1378 samples at 44.1 kHz, so the tail
 * fell 60 dB in 3 × that delay ÷ -log10(feedback). Its output was
 * dry × input + wet × tail, where schema 4's is (1 - mix) × input + mix × tail.
 * Damping and width mean what they did. A setting the old one didn't have
 * takes the default.
 */
function migrateReverb(effect: unknown): unknown {
  const old = effect as Record<string, unknown> | undefined;
  if (old?.type !== "reverb") return effect;
  const oldSettings = (old.settings ?? {}) as Record<string, unknown>;
  const settings = defaultEffectSettings("reverb") as unknown as Record<string, unknown>;
  const set = (name: string, value: number) => {
    settings[name] = clampEffectValue(effectParam("reverb", name)!, value);
  };
  const number = (name: string, fallback: number) => {
    const value = oldSettings[name];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  if (typeof oldSettings.roomSize === "number") {
    const feedback = 0.7 + 0.28 * Math.min(Math.max(oldSettings.roomSize, 0), 1);
    set("decay", (3 * (1378 / 44_100)) / -Math.log10(feedback));
  }
  for (const name of ["damping", "width"]) {
    if (typeof oldSettings[name] === "number") set(name, oldSettings[name]);
  }
  if (typeof oldSettings.wet === "number" || typeof oldSettings.dry === "number") {
    const wet = Math.max(number("wet", 0.25), 0);
    const dry = Math.max(number("dry", 1), 0);
    set("mix", wet + dry > 0 ? wet / (wet + dry) : 0);
  }
  return { ...old, settings };
}

/**
 * A schema 1 Drum Sampler pad held a sample and a volume and nothing else:
 * the Drum Sampler (#10) gave a pad its name, its note, pan, pitch and a
 * choke group. The starter kit fills those in pad by pad, because the kit is
 * what those Projects were playing; a pad past the kit's end is named by its
 * number and answers the next note no other pad has taken.
 */
function fillPads(pads: unknown): unknown {
  if (!Array.isArray(pads)) return pads;
  const taken = new Set(
    pads.map((pad) => (pad as Record<string, unknown>)?.note).filter((note) => typeof note === "number"),
  );
  return pads.map((pad: unknown, index) => {
    const old = (pad ?? {}) as Record<string, unknown>;
    const kit = STARTER_KIT[index];
    const note = old.note ?? kit?.note ?? freeNote(taken);
    taken.add(note as number);
    return {
      ...old,
      name: old.name ?? kit?.name ?? `Pad ${index + 1}`,
      note,
      sample: old.sample ?? null,
      volume: old.volume ?? 1,
      pan: old.pan ?? 0,
      pitch: old.pitch ?? 0,
      chokeGroup: old.chokeGroup ?? kit?.chokeGroup ?? 0,
    };
  });
}

/** The lowest MIDI note above the kit's own that no pad answers to yet. */
function freeNote(taken: Set<unknown>): number {
  const afterTheKit = Math.max(...STARTER_KIT.map((pad) => pad.note)) + 1;
  for (let note = afterTheKit; note <= 127; note++) if (!taken.has(note)) return note;
  return 127;
}

export type ParseResult = { ok: true; project: Project } | { ok: false; error: string };

export function serialiseProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

/** Read a saved Project, migrating it to the current schema. */
export function parseProject(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "This isn't a Project file: it isn't valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "This isn't a Project file" };
  }

  let project = data as Record<string, unknown>;
  const version = project.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 1) {
    return { ok: false, error: "This Project file has no schema version" };
  }
  if ((version as number) > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This Project was saved by a newer version of Soundcheck (schema ${version}; this one reads up to ${SCHEMA_VERSION})`,
    };
  }
  for (let v = version as number; v < SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) return { ok: false, error: `No way to migrate a Project from schema ${v}` };
    project = { ...migrate(project), schemaVersion: v + 1 };
  }

  const invalid = validateProject(project);
  return invalid
    ? { ok: false, error: `This Project file is damaged: ${invalid}` }
    : { ok: true, project: project as unknown as Project };
}
