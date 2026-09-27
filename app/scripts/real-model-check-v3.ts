/**
 * The v3 PRD's stories as scenarios for the real-model check (#107): the
 * song each starts from, the Requests it sends, and the pass or fail checks
 * on the Projects that come back. `real-model-check.ts` runs them against a
 * real model; they are kept apart so that the checks can be tested on
 * scripted Projects, without one.
 *
 * Each scenario starts from the same four-Track song, not one a model built,
 * so that a failure is the Request's and not the song's. The one-loud-Track
 * clipping fix (story 16) is the `clipping` scenario, which v3 shares with
 * the MVP. Story 11 is the UI alone, so it has a waiver instead
 * (`V3_WAIVERS`). A scenario that needs audio files, the musician's library
 * or a model that hears audio says so, and `scenarioWorld` gives it them:
 * its audio is rendered by the engine when it runs, never a file in the repo.
 */
import { isDeepStrictEqual } from "node:util";

import { encode_wav, Engine } from "@engine";

import type { Listen } from "../src/assistant/assistant";
import { assistantLibrary, type AssistantLibrary } from "../src/assistant/library";
import { listenWith } from "../src/assistant/listen";
import { hearReferenceIn, type HearReference } from "../src/assistant/reference";
import { applyEngineCommand } from "../src/audio/apply-engine-command";
import type { AnalyseAudio } from "../src/audio/audio-analyser";
import { synthPreset } from "../src/instrument/synth-presets";
import { KitLibrary } from "../src/kit/kit-library";
import { memoryLibraryStorage } from "../src/preset/library-storage";
import { PresetLibrary } from "../src/preset/preset-library";
import { valueAt } from "../src/project/arrangement";
import { EngineSync, type LoadedSample } from "../src/project/engine-sync";
import {
  createAudioTrack,
  createDrumTrack,
  createInstrumentTrack,
  createProject,
  STARTER_KIT,
  type Automation,
  type Clip,
  type Effect,
  type InstrumentTrack,
  type Note,
  type PatternClip,
  type Project,
  type Track,
} from "../src/project/model";
import { barStart, signatureAt, tempoAt, tempoMapOf, TICKS_PER_BEAT } from "../src/project/time";
import { validateProject } from "../src/project/validate";
import { stereoWav } from "../src/song/test-wav";

const BEAT = TICKS_PER_BEAT;
const BAR = 4 * BEAT;

/**
 * What a check sees of one Request: its tool calls and their results, in
 * order, and how it ended. A result's `audio` is whether the model was sent
 * the sound itself with it (the app's own result holds the file).
 */
export interface Sent {
  toolCalls: readonly { name: string; input: unknown }[];
  toolResults: readonly { content: string; isError: boolean; audio?: string | boolean }[];
  changes: readonly string[];
  error: string | null;
}

export type Checks = Record<string, boolean>;

export interface V3Scenario {
  /** The PRD's user story, by its number and words. */
  story: string;
  /** Each Request of the scenario, in order: two for a Conversation. */
  prompts: readonly string[];
  /** The Project it starts from. */
  song(): Project;
  /**
   * Its Request is made as a Suggestion, whatever the Provider's default,
   * and applied only after the checks that nothing changed until then.
   */
  suggestion?: true;
  /** The audio the Project's files hold, as opening its folder would read them. */
  samples?(): Map<string, LoadedSample>;
  /** It needs the musician's library of User Presets and Kits, which holds the Kit `SAVED_KIT`. */
  library?: true;
  /**
   * It needs a model that takes audio, with listening turned on, as the
   * musician turns it on in the app. On one that doesn't, it can't run.
   */
  hearsAudio?: true;
  /** `projects` are the Project before the first Request and after each. */
  check(projects: readonly Project[], sent: readonly Sent[]): Checks;
}

/** The ids of the song's Tracks, which the checks find them by. */
export const TRACKS = { drums: "drums", bass: "bass", pad: "pad", lead: "lead", vocals: "vocals" } as const;

const SECTIONS = [
  { id: "intro", name: "Intro", startBar: 1, bars: 4 },
  { id: "verse", name: "Verse", startBar: 5, bars: 4 },
  { id: "chorus", name: "Chorus", startBar: 9, bars: 4 },
  { id: "outro", name: "Outro", startBar: 13, bars: 4 },
] as const;

function note(pitch: number, start: number, length: number, velocity: number): Note {
  return { pitch, start, length, velocity };
}

/** A four-bar Pattern Clip for a Section, its notes one bar's `notes(bar)` after another. */
function sectionClip(track: string, section: (typeof SECTIONS)[number], notes: (bar: number) => Note[]): PatternClip {
  return {
    id: `${track}-${section.id}`,
    kind: "pattern",
    start: (section.startBar - 1) * BAR,
    length: section.bars * BAR,
    notes: [...Array(section.bars).keys()].flatMap((bar) =>
      notes(bar).map((each) => ({ ...each, start: each.start + bar * BAR })),
    ),
  };
}

function synthTrack(name: string, id: string, preset: string, volume: number): InstrumentTrack {
  const track = createInstrumentTrack(name, id);
  track.instrument = { type: "synth", preset, settings: { ...synthPreset(preset)!.settings } };
  track.mixer.volume = volume;
  return track;
}

/** Each bar's root, as a MIDI note in the bass octave: I, I, IV, V. */
const ROOTS = [36, 36, 41, 43];

/**
 * Sixteen bars at 120 BPM in 4/4, as Intro, Verse, Chorus and Outro
 * Sections of four bars: “Drums” (kick, snare with a clap, and closed hats
 * on the Starter Kit), a “Bass” of one short note a beat on each bar's
 * root, a “Pad” of a triad a bar, and a “Lead” in the Chorus only. Every
 * Clip is one Section long, so each Section's Clips can be told apart, and
 * the Bass's last note ends half a beat before its Clip does.
 *
 * The Starter Kit is about 16 dB louder than the synths at the same volume,
 * so the Drums sit at 0.2 to balance them. Their hits are at full velocity
 * all the same, so that the Drums and the Master pushed to 2, the
 * `clipping` scenario's one loud Track, clip when this is the song it has.
 */
export function v3Song(): Project {
  const project = createProject("Real-model check, v3");
  const drums = createDrumTrack("Drums", TRACKS.drums);
  drums.mixer.volume = 0.2;
  const bass = synthTrack("Bass", TRACKS.bass, "Sub Bass", 0.8);
  const pad = synthTrack("Pad", TRACKS.pad, "Warm Pad", 0.8);
  const lead = synthTrack("Lead", TRACKS.lead, "Saw Lead", 0.8);
  for (const section of SECTIONS) {
    drums.clips.push(
      sectionClip(TRACKS.drums, section, () => [
        ...[0, 2].map((beat) => note(36, beat * BEAT, BEAT / 4, 1)),
        ...[1, 3].flatMap((beat) => [note(38, beat * BEAT, BEAT / 4, 1), note(39, beat * BEAT, BEAT / 4, 1)]),
        ...[...Array(8).keys()].map((eighth) => note(42, (eighth * BEAT) / 2, BEAT / 4, 0.5)),
      ]),
    );
    bass.clips.push(
      sectionClip(TRACKS.bass, section, (bar) => [0, 1, 2, 3].map((beat) => note(ROOTS[bar]!, beat * BEAT, BEAT / 2, 0.9))),
    );
    pad.clips.push(
      sectionClip(TRACKS.pad, section, (bar) => [0, 4, 7].map((third) => note(ROOTS[bar]! + 24 + third, 0, BAR, 0.6))),
    );
  }
  lead.clips.push(
    sectionClip(TRACKS.lead, SECTIONS[2], (bar) =>
      [0, 2, 4, 7, 4, 2, 0, -1].map((step, eighth) => note(ROOTS[bar]! + 36 + step, (eighth * BEAT) / 2, BEAT / 2, 0.7)),
    ),
  );
  project.tracks.push(drums, bass, pad, lead);
  project.sections.push(...SECTIONS.map((section) => ({ ...section })));
  return project;
}

/** The v3 song with the Bass pushed well above the rest, about 8 dB, for "did that fix it?". */
function loudBassSong(): Project {
  const project = v3Song();
  trackOf(project, TRACKS.bass)!.mixer.volume = 2;
  return project;
}

function trackOf(project: Project, id: string): Track | undefined {
  return project.tracks.find((track) => track.id === id);
}

/** A Track's notes where they sound in the song, in time order, lowest first at a tick. */
export function songNotes(track: Track | undefined): Note[] {
  if (!track || track.kind !== "instrument") return [];
  return track.clips
    .flatMap((clip) => clip.notes.map((each) => ({ ...each, start: clip.start + each.start })))
    .toSorted((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/** Everything but the Tracks named is as it was: the other Tracks, the Buses, the Master, the Sections and the tempo map. */
export function unchangedExcept(before: Project, after: Project, trackIds: readonly string[]): boolean {
  const others = (project: Project) => project.tracks.filter((track) => !trackIds.includes(track.id));
  return (
    isDeepStrictEqual(others(before), others(after)) &&
    isDeepStrictEqual(before.buses, after.buses) &&
    isDeepStrictEqual(before.master, after.master) &&
    isDeepStrictEqual(before.sections, after.sections) &&
    before.tempo === after.tempo &&
    isDeepStrictEqual(before.tempoChanges, after.tempoChanges)
  );
}

/** The results of every call to `name`, across the Requests. A call and its result share an index. */
export function resultsOf(sent: readonly Sent[], name: string): Sent["toolResults"][number][] {
  return sent.flatMap(({ toolCalls, toolResults }) =>
    toolCalls.flatMap((call, index) => (call.name === name && toolResults[index] ? [toolResults[index]] : [])),
  );
}

function callsOf(sent: readonly Sent[], name: string): number {
  return sent.reduce((count, { toolCalls }) => count + toolCalls.filter((call) => call.name === name).length, 0);
}

/** Story 1: the Bass's last two notes are longer, starting where they did, and nothing else changed. */
function lastTwoBassNotesLonger([before, after]: readonly Project[]): Checks {
  const was = songNotes(trackOf(before!, TRACKS.bass));
  const now = songNotes(trackOf(after!, TRACKS.bass));
  const find = (wanted: Note) => now.find((each) => each.start === wanted.start && each.pitch === wanted.pitch);
  return {
    lastTwoLonger: was.slice(-2).every((each) => (find(each)?.length ?? 0) > each.length),
    otherNotesUnchanged:
      now.length === was.length && was.slice(0, -2).every((each) => isDeepStrictEqual(find(each), each)),
    otherTracksUnchanged: unchangedExcept(before!, after!, [TRACKS.bass]),
  };
}

/** Story 2: a Bus for the rhythm section, turned down, and a Send from the Pad to another. */
function rhythmBusAndPadSend([, after]: readonly Project[]): Checks {
  const rhythm = after!.buses.find((bus) => /rhythm/i.test(bus.name));
  const space = after!.buses.find((bus) => /space/i.test(bus.name));
  return {
    rhythmBusAdded: rhythm !== undefined,
    drumsToRhythm: rhythm !== undefined && trackOf(after!, TRACKS.drums)?.output === rhythm.id,
    bassToRhythm: rhythm !== undefined && trackOf(after!, TRACKS.bass)?.output === rhythm.id,
    rhythmTurnedDown: rhythm !== undefined && rhythm.mixer.volume < 1,
    spaceBusAdded: space !== undefined,
    padSendsToSpace:
      space !== undefined && (trackOf(after!, TRACKS.pad)?.sends ?? []).some((send) => send.busId === space.id && send.level > 0),
  };
}

/** The value of a lane at the top of each bar from 1 to `bars`, or null without the lane. */
function laneByBar(project: Project, automation: readonly Automation[], setting: string, bars: number): number[] | null {
  const lane = automation.find((each) => each.setting === setting);
  if (!lane || lane.breakpoints.length === 0) return null;
  const map = tempoMapOf(project);
  return [...Array(bars).keys()].map((bar) => valueAt(lane.breakpoints, barStart(map, bar + 1)));
}

/** Story 3: the Pad's volume starts near silent and rises, never falling, to its level by bar 5. */
function padFadesIn([before, after]: readonly Project[]): Checks {
  const level = trackOf(before!, TRACKS.pad)!.mixer.volume;
  const values = laneByBar(after!, trackOf(after!, TRACKS.pad)?.automation ?? [], "volume", 5);
  return {
    padVolumeAutomated: values !== null,
    startsQuiet: values !== null && values[0]! <= 0.25 * values[4]!,
    neverFalls: values !== null && values.every((value, bar) => bar === 0 || value >= values[bar - 1]! - 1e-6),
    reachesItsLevelByBar5: values !== null && values[4]! >= 0.9 * level,
    otherTracksUnchanged: unchangedExcept(before!, after!, [TRACKS.pad]),
  };
}

/** Whether two Clips hold the same thing, wherever they start. */
function sameContent(a: Clip, b: Clip): boolean {
  const { id: _a, start: _as, ...restA } = a;
  const { id: _b, start: _bs, ...restB } = b;
  return isDeepStrictEqual(restA, restB);
}

/** Whether a Track has a Clip at `start` holding what `like` holds. */
function clipAt(track: Track | undefined, start: number, like: Clip): boolean {
  return (track?.clips as Clip[] | undefined)?.some((clip) => clip.start === start && sameContent(clip, like)) ?? false;
}

/** Story 8: a second Chorus straight after the first, with every Track's Chorus Clips, and the Outro after it. */
function chorusRepeated([before, after]: readonly Project[]): Checks {
  const map = tempoMapOf(before!);
  const chorusStart = barStart(map, 9);
  const outroStart = barStart(map, 13);
  const choruses = after!.sections.filter((section) => /chorus/i.test(section.name));
  const everyClip = (from: number, to: number, shift: number) =>
    before!.tracks.every((track) =>
      (track.clips as Clip[])
        .filter((clip) => clip.start >= from && clip.start < to)
        .every((clip) => clipAt(trackOf(after!, track.id), clip.start + shift, clip)),
    );
  return {
    twoChoruses: choruses.length === 2,
    secondChorusFollowsTheFirst: choruses.some((section) => section.startBar === 9 && section.bars === 4) &&
      choruses.some((section) => section.startBar === 13 && section.bars === 4),
    outroMovedAfterIt: after!.sections.some((section) => /outro/i.test(section.name) && section.startBar === 17),
    chorusClipsKept: everyClip(chorusStart, outroStart, 0),
    chorusClipsCopied: everyClip(chorusStart, outroStart, 4 * BAR),
    outroClipsMoved: everyClip(outroStart, Infinity, 4 * BAR),
    introAndVerseUnchanged: everyClip(0, chorusStart, 0),
  };
}

/** Every channel's Insert Chain and Automation, by channel. */
type Channel = Pick<Track, "insertChain" | "automation">;
function channels(project: Project): Map<string, Channel> {
  return new Map<string, Channel>([
    ...project.tracks.map((track): [string, Channel] => [track.id, track]),
    ...project.buses.map((bus): [string, Channel] => [bus.id, bus]),
    ["master", project.master],
  ]);
}

/** Story 9: in the Verse, the bars before the Chorus, new notes, new Automation and a changed Insert Chain. */
function buildsIntoTheChorus([before, after]: readonly Project[]): Checks {
  const map = tempoMapOf(before!);
  const from = barStart(map, 5);
  const to = barStart(map, 9);
  const inBuild = (notes: Note[]) => notes.filter((each) => each.start >= from && each.start < to);
  const was = channels(before!);
  const automatedInBuild = [...channels(after!)].some(([id, channel]) =>
    channel.automation.some(
      (lane) =>
        !was.get(id)?.automation.some((old) => isDeepStrictEqual(old, lane)) &&
        lane.breakpoints.some((point) => point.tick >= from && point.tick <= to),
    ),
  );
  return {
    notesInBuild: after!.tracks.some(
      (track) => !isDeepStrictEqual(inBuild(songNotes(track)), inBuild(songNotes(trackOf(before!, track.id)))),
    ),
    automationInBuild: automatedInBuild,
    effectsChanged: [...channels(after!)].some(([id, channel]) => !isDeepStrictEqual(channel.insertChain, was.get(id)?.insertChain ?? [])),
    chorusStillThere: after!.sections.some((section) => /chorus/i.test(section.name)),
  };
}

function active(project: Project | undefined, type: Effect["type"]): Effect[] {
  const track = project && trackOf(project, TRACKS.lead);
  return (track?.insertChain ?? []).filter((effect) => effect.type === type && !effect.bypassed);
}

/** Story 10: the Lead gets a reverb and a delay; the follow-up takes the reverb away and leaves the delay as it was. */
function reverbUndoneDelayKept([before, first, second]: readonly Project[], sent: readonly Sent[]): Checks {
  const delay = active(first, "delay")[0];
  return {
    firstAddedReverbAndDelay: active(first, "reverb").length > 0 && delay !== undefined,
    followUpRemovedTheReverb: second !== undefined && active(second, "reverb").length === 0,
    followUpKeptTheDelay: delay !== undefined && active(second, "delay").some((effect) => isDeepStrictEqual(effect, delay)),
    followUpChangedSomething: (sent[1]?.changes.length ?? 0) > 0,
    otherTracksUnchanged: second !== undefined && unchangedExcept(before!, second, [TRACKS.lead]),
  };
}

/** Story 12, once the Suggestion is applied: the Pad muted, the Bass up, and nothing else. */
function padMutedBassUp([before, after]: readonly Project[]): Checks {
  return {
    padMuted: trackOf(after!, TRACKS.pad)?.mixer.mute === true,
    bassTurnedUp: (trackOf(after!, TRACKS.bass)?.mixer.volume ?? 0) > trackOf(before!, TRACKS.bass)!.mixer.volume,
    otherTracksUnchanged: unchangedExcept(before!, after!, [TRACKS.pad, TRACKS.bass]),
  };
}

/** Story 14: the loud Bass comes down, and the Assistant heard before and after and compared the two. */
function bassDownAndCompared([before, after]: readonly Project[], sent: readonly Sent[]): Checks {
  const compared = resultsOf(sent, "compare_audio");
  return {
    bassTurnedDown: (trackOf(after!, TRACKS.bass)?.mixer.volume ?? Infinity) < trackOf(before!, TRACKS.bass)!.mixer.volume,
    analysedBeforeAndAfter: callsOf(sent, "analyse_audio") >= 2,
    comparedBeforeAndAfter: compared.some((result) => !result.isError),
  };
}

const RATE = 48_000;

/** `project` from `start` to `end`, in ticks, rendered by the engine as a 16-bit WAV. */
function renderedWav(project: Project, start: number, end: number, name: string): LoadedSample {
  const engine = new Engine(RATE);
  try {
    for (const command of new EngineSync().update(project)) applyEngineCommand(engine, command);
    return { name, bytes: [...encode_wav(engine.render_range(start, end), RATE, 16)!] };
  } finally {
    engine.free();
  }
}

/** The Project file the `audioclips` scenario's Vocals play: the Lead's first two Chorus bars, 4 s at 120 BPM. */
export const VOCAL = "audio/vocal take.wav";

/** The Project file the `reference` scenario compares with: the Verse and Chorus with the bass a finished song has. */
export const REFERENCE = "audio/reference.wav";

/** The Kit the library holds from another Project: the Starter Kit, with a Kick of its own. */
export const SAVED_KIT = "808";
const KIT_KICK = "audio/808 kick.wav";

/** The v3 song with an Audio Track, “Vocals”, playing all 4 s of `VOCAL` from the top of the Verse. */
function vocalSong(): Project {
  const project = v3Song();
  const vocals = createAudioTrack("Vocals", TRACKS.vocals);
  vocals.clips.push({ id: "vocals-verse", kind: "audio", start: 4 * BAR, duration: 4, file: VOCAL, fileOffset: 0 });
  project.tracks.push(vocals);
  return project;
}

function vocalSamples(): Map<string, LoadedSample> {
  const lead = v3Song();
  lead.tracks = lead.tracks.filter((track) => track.id === TRACKS.lead);
  return new Map([[VOCAL, renderedWav(lead, 8 * BAR, 10 * BAR, "vocal take.wav")]]);
}

/** The v3 song before anyone named its parts. */
function unnamedSong(): Project {
  const project = v3Song();
  project.sections = [];
  return project;
}

/** The v3 song with a Reference Track. */
function referencedSong(): Project {
  const project = v3Song();
  project.referenceTrack = { file: REFERENCE };
  return project;
}

/** The reference: the v3 song's Verse and Chorus with the Bass well up, rendered. */
function referenceSamples(): Map<string, LoadedSample> {
  const finished = v3Song();
  trackOf(finished, TRACKS.bass)!.mixer.volume = 2;
  return new Map([[REFERENCE, renderedWav(finished, 4 * BAR, 12 * BAR, "reference.wav")]]);
}

/** What a scenario's Requests run with besides its song: the Project's audio, how the Assistant hears, and the library. */
export interface ScenarioWorld {
  samples: Map<string, LoadedSample>;
  listen: Listen;
  hearReference: HearReference;
  library?: AssistantLibrary;
}

/**
 * The Project audio, listening and library `scenario` needs, as the app has
 * them with its folder open: `analyse` renders and measures, and the library
 * is in memory, holding the Kit `SAVED_KIT`, whose Kick is a short low tone.
 */
export async function scenarioWorld(scenario: V3Scenario, analyse: AnalyseAudio): Promise<ScenarioWorld> {
  const samples = scenario.samples?.() ?? new Map<string, LoadedSample>();
  const world: ScenarioWorld = { samples, listen: listenWith(analyse, samples), hearReference: hearReferenceIn(samples) };
  if (!scenario.library) return world;
  const storage = memoryLibraryStorage();
  const tone = Array.from({ length: RATE / 10 }, (_, at) => 0.5 * Math.sin((2 * Math.PI * 50 * at) / RATE));
  const kick = { name: "808 kick.wav", bytes: stereoWav(tone, tone, RATE) };
  const pads = STARTER_KIT.map((pad) => (pad.note === 36 ? { ...pad, name: "808 Kick", sample: KIT_KICK } : { ...pad }));
  await new KitLibrary(storage).save(SAVED_KIT, pads, new Map([[KIT_KICK, kick]]));
  const presets = new PresetLibrary(storage);
  const kits = new KitLibrary(storage);
  await Promise.all([presets.load(), kits.load()]);
  const library = assistantLibrary(presets, kits, {
    samples: () => samples,
    add: (added) => {
      for (const [path, sample] of added) samples.set(path, sample);
    },
  });
  return { ...world, library };
}

/** Whether a call to `name` succeeded. */
function succeeded(sent: readonly Sent[], name: string): boolean {
  return resultsOf(sent, name).some((result) => !result.isError);
}

/** Every beat's tick from `from` up to `to`. */
function beats(from: number, to: number): number[] {
  return [...Array((to - from) / BEAT).keys()].map((beat) => from + beat * BEAT);
}

/** Story 4: the Chorus at 100 BPM, back to 120 for the Outro, and nothing but the tempo moved. */
function chorusSlower([before, after]: readonly Project[]): Checks {
  const map = tempoMapOf(after!);
  return {
    introAndVerseAt120: beats(0, 8 * BAR).every((tick) => tempoAt(map, tick) === 120),
    chorusAt100: beats(8 * BAR, 12 * BAR).every((tick) => tempoAt(map, tick) === 100),
    outroBackAt120: beats(12 * BAR, 16 * BAR).every((tick) => tempoAt(map, tick) === 120),
    stillFourFour: beats(0, 16 * BAR).every((tick) => isDeepStrictEqual(signatureAt(map, tick), before!.timeSignature)),
    clipsAndSectionsKept: isDeepStrictEqual(before!.tracks, after!.tracks) && isDeepStrictEqual(before!.sections, after!.sections),
  };
}

function drumsOf(project: Project | undefined) {
  const track = project && trackOf(project, TRACKS.drums);
  return track?.kind === "instrument" && track.instrument.type === "drumSampler" ? track.instrument : null;
}

/** Story 5: the Pad's sound saved as a User Preset, the Drums' Pads as a Kit, then the saved Kit loaded onto the Drums. */
function presetAndKits([before, after]: readonly Project[], sent: readonly Sent[]): Checks {
  const kick = drumsOf(after)?.pads.find((pad) => pad.note === 36);
  return {
    savedThePadAsAPreset: succeeded(sent, "save_preset"),
    savedTheDrumsAsAKit: succeeded(sent, "save_kit"),
    drumsPlayTheSavedKit: drumsOf(after)?.preset === SAVED_KIT,
    // The Kit's own Kick, copied into the Project, not the Starter Kit's.
    itsKickCopiedIn: kick?.sample?.startsWith("audio/") === true,
    notesKept: isDeepStrictEqual(trackOf(before!, TRACKS.drums)?.clips, trackOf(after!, TRACKS.drums)?.clips),
    otherTracksUnchanged: unchangedExcept(before!, after!, [TRACKS.drums]),
  };
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

/** Story 6: the vocal take placed again at the Chorus, and the Verse's trimmed to its first two seconds. */
function vocalPlacedAndTrimmed([before, after]: readonly Project[]): Checks {
  const clips = (trackOf(after!, TRACKS.vocals)?.clips ?? []) as Clip[];
  const verse = clips.find((clip) => clip.id === "vocals-verse");
  const chorusStart = barStart(tempoMapOf(after!), 9);
  return {
    placedAtTheChorus: clips.some(
      (clip) =>
        clip.kind === "audio" && clip.file === VOCAL && clip.start === chorusStart && clip.fileOffset === 0 && near(clip.duration, 4),
    ),
    verseTrimmedToTwoSeconds: verse?.kind === "audio" && verse.start === 4 * BAR && verse.fileOffset === 0 && near(verse.duration, 2),
    otherTracksUnchanged: unchangedExcept(before!, after!, [TRACKS.vocals]),
  };
}

/** Story 7: the song's four parts named as Sections of four bars each, and nothing else changed. */
function partsNamed([before, after]: readonly Project[]): Checks {
  const named = (pattern: RegExp, startBar: number) =>
    after!.sections.some((section) => pattern.test(section.name) && section.startBar === startBar && section.bars === 4);
  return {
    fourSections: after!.sections.length === 4,
    intro: named(/intro/i, 1),
    verse: named(/verse/i, 5),
    chorus: named(/chorus/i, 9),
    outro: named(/outro/i, 13),
    nothingElseChanged: isDeepStrictEqual({ ...before!, sections: [] }, { ...after!, sections: [] }),
  };
}

/** Story 13: the Assistant asked to hear the sound and was sent it, and changed nothing, as asked. */
function heardTheLead([before, after]: readonly Project[], sent: readonly Sent[]): Checks {
  const listened = sent.flatMap(({ toolCalls, toolResults }) =>
    toolCalls.flatMap((call, index) => {
      const result = toolResults[index];
      const input = call.input as { listen?: unknown } | null;
      return call.name === "analyse_audio" && input?.listen === true && result ? [result] : [];
    }),
  );
  return {
    askedToHearIt: listened.length > 0,
    wasSentTheAudio: listened.some((result) => !result.isError && Boolean(result.audio)),
    changedNothing: isDeepStrictEqual(before, after),
  };
}

/** Story 15: the mix compared with the Reference Track, changed, and compared again. */
function comparedWithTheReference([before, after]: readonly Project[], sent: readonly Sent[]): Checks {
  const compared = resultsOf(sent, "compare_to_reference").filter((result) => !result.isError);
  return {
    comparedWithTheReference: compared.length > 0,
    changedTheMix: !isDeepStrictEqual(before!.tracks, after!.tracks) || !isDeepStrictEqual(before!.master, after!.master),
    comparedAgainAfter: compared.length >= 2,
    referenceKept: isDeepStrictEqual(after!.referenceTrack, before!.referenceTrack),
  };
}

/**
 * The v3 scenarios by name, as `parseArgs` takes them. The prompts are the
 * PRD's own words where it has them.
 */
export const V3_SCENARIOS = {
  notes: {
    story: "1. Change specific notes",
    prompts: ["make the last two notes of the bassline longer"],
    song: v3Song,
    check: lastTwoBassNotesLonger,
  },
  routing: {
    story: "2. Buses, Outputs and Sends",
    prompts: [
      "put the drums and the bass on a new Bus called Rhythm and turn that Bus down a little, then add a Send from the pad to a new Bus called Space",
    ],
    song: v3Song,
    check: rhythmBusAndPadSend,
  },
  automation: {
    story: "3. Draw Automation",
    prompts: ["fade the pad in over the first four bars"],
    song: v3Song,
    check: padFadesIn,
  },
  tempo: {
    story: "4. Tempo Changes",
    prompts: ["slow the chorus down to 100 BPM, then back to 120 for the outro"],
    song: v3Song,
    check: chorusSlower,
  },
  sounds: {
    story: "5. Presets and Kits",
    prompts: [
      `save the pad's sound as a User Preset called Dream Pad, save the drums' pads as a Kit called Old Drums, then load my saved ${SAVED_KIT} Kit onto the drums`,
    ],
    song: v3Song,
    library: true,
    check: presetAndKits,
  },
  audioclips: {
    story: "6. Audio Clips",
    prompts: ["put the vocal take on the Vocals track again at the start of the chorus, and trim the verse's vocal to its first two seconds"],
    song: vocalSong,
    samples: vocalSamples,
    library: true,
    check: vocalPlacedAndTrimmed,
  },
  sections: {
    story: "7. Name the parts as Sections",
    prompts: ["name the parts of my song as Sections: it's an intro, a verse, a chorus and an outro, four bars each"],
    song: unnamedSong,
    check: partsNamed,
  },
  arrangement: {
    story: "8. Duplicate a Section",
    prompts: ["repeat the chorus"],
    song: v3Song,
    check: chorusRepeated,
  },
  buildup: {
    story: "9. A build-up into a Section",
    prompts: ["add a build-up in the verse into the chorus"],
    song: v3Song,
    check: buildsIntoTheChorus,
  },
  conversation: {
    story: "10. Follow up in a Conversation",
    prompts: ["add a reverb and a delay to the lead", "undo the reverb but keep the rest"],
    song: v3Song,
    check: reverbUndoneDelayKept,
  },
  suggestion: {
    story: "12. A Suggestion on a Local model",
    prompts: ["mute the pad and turn the bass up a little"],
    song: v3Song,
    suggestion: true,
    check: padMutedBassUp,
  },
  listening: {
    story: "13. Hear the rendered audio",
    prompts: ["listen to the lead in the chorus and tell me whether it sounds harsh; don't change anything"],
    song: v3Song,
    hearsAudio: true,
    check: heardTheLead,
  },
  compare: {
    story: "14. Did that fix it? Before and after",
    prompts: ["the bass is too loud in the mix: turn it down, then check whether that fixed it"],
    song: loudBassSong,
    check: bassDownAndCompared,
  },
  reference: {
    story: "15. Compare with a Reference Track",
    prompts: ["compare my mix with the reference track and make it closer to it, then check that it is"],
    song: referencedSong,
    samples: referenceSamples,
    check: comparedWithTheReference,
  },
} as const satisfies Record<string, V3Scenario>;

/**
 * The v3 stories no real model can check, and why: each is covered by the
 * UI test named instead.
 */
export const V3_WAIVERS = {
  "11. See the Conversation and start a new one":
    "The UI alone: the transcript and the New conversation button send the model nothing a scenario could check. `RequestBox.test.tsx` covers it (“a follow-up is sent the Request before it, the transcript shows both, and New conversation clears it”); what the model is sent of a Conversation is the `conversation` scenario.",
} as const;

export type V3ScenarioName = keyof typeof V3_SCENARIOS;

/** A scenario's checks, with the ones every scenario has: no Request stopped early, and the Project still validates. */
export function checkScenario(scenario: V3Scenario, projects: readonly Project[], sent: readonly Sent[]): Checks {
  return {
    noError: sent.length === scenario.prompts.length && sent.every((each) => each.error === null),
    ...scenario.check(projects, sent),
    validates: projects.length > 1 && validateProject(projects.at(-1)!) === null,
  };
}
