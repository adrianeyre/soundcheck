/**
 * The MVP PRD's Assistant scenarios (#27) and the v3 PRD's stories (#107),
 * run against a real model.
 *
 * This spends money, so it is only ever run by hand:
 *
 *     pnpm engine:build
 *     pnpm --filter @soundcheck/app real-model-check [mvp] [v3] [build] [clipping] [notes] … \
 *       [--provider claude] [--model Opus] [--version 5.5] [--effort high]
 *
 * It is not a test and nothing in `pnpm test` or CI runs it. It drives the
 * app's own code: `conversationsFor` talks to the chosen provider's model as
 * the Assistant does, `runRequest` applies its tool calls through
 * `ProjectHistory`, and the real WASM engine renders and analyses the
 * Project, as `analyse_audio` does in the app. With no options it runs every
 * scenario on Claude's default model from the catalogue. Each Request runs
 * in the mode the app would give the provider (`requestModeFor`): a Local
 * model's smaller core and Suggestions, which the check applies as the
 * musician would, except in `suggestion`, which checks that nothing changes
 * until then. The v3 scenarios and their checks are in `real-model-check-v3.ts`,
 * and so is what each needs besides its song (`scenarioWorld`): audio files
 * rendered for it, the library, or listening, which is turned on only for a
 * model that takes audio; on one that doesn't, that scenario is skipped.
 * Each Request's first message is counted against the summary's token
 * budget (`SUMMARY_TOKEN_BUDGET`), beside the first call's whole prompt as
 * the API counted it.
 *
 * The key, base URL and custom headers come from the provider's environment
 * variables (`ENVIRONMENT`: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and
 * `ANTHROPIC_CUSTOM_HEADERS` for Claude). The custom headers are sent, and a
 * request without them isn't: behind a gateway, a routing header can be
 * what stops a Claude request being answered by another provider's account. Every response's model is recorded and
 * must be the provider's own, or the check stops and the run counts as not
 * run (`watchedFetch`). No key is ever printed. Renders and a JSON record of
 * every run go to `temp/real-model-check/` at the repo root (gitignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { encode_wav, Engine, initSync } from "@engine";

import {
  REQUEST_LABEL,
  runRequest,
  type Applied,
  type FinishedRequest,
  type Listen,
  type RequestMode,
  type StartConversation,
} from "../src/assistant/assistant";
import { provider as providerOf } from "../src/assistant/catalogue";
import { capabilitiesFor, headersOf, requestModeFor } from "../src/assistant/connection";
import { estimatedTokens, requestMessage, SUMMARY_TOKEN_BUDGET } from "../src/assistant/context";
import type { AssistantLibrary } from "../src/assistant/library";
import { listenWith } from "../src/assistant/listen";
import { conversationsFor } from "../src/assistant/providers";
import type { HearReference } from "../src/assistant/reference";
import { TRUE_PEAK_CEILING_DBTP } from "../src/assistant/tools";
import { applyEngineCommand } from "../src/audio/apply-engine-command";
import { wasmAudioAnalyser } from "../src/audio/audio-analyser";
import { songEndTick } from "../src/export/mix-exporter";
import { EngineSync } from "../src/project/engine-sync";
import { ProjectHistory } from "../src/project/history";
import { createProject, type Project, type Track } from "../src/project/model";
import { barTicks } from "../src/project/time";
import { validateProject } from "../src/project/validate";
import {
  connectionFromEnvironment,
  cost,
  parseArgs,
  watchedFetch,
  type RequestRecord,
  type Usage,
} from "./real-model-check-api";
import {
  checkScenario,
  scenarioWorld,
  V3_SCENARIOS,
  V3_WAIVERS,
  v3Song,
  type V3Scenario,
  type V3ScenarioName,
} from "./real-model-check-v3";

const OUT = new URL("../../temp/real-model-check/", import.meta.url);
const SAMPLE_RATE = 48_000;
const RUNS = 2;

const PROMPTS = {
  build: "make a 4-bar drum beat at 120 BPM with a bassline",
  clipping: "the mix is clipping — fix it",
} as const;

/** What one Request did: every tool call and result in order, the model's words, and its token use. */
interface Transcript {
  toolCalls: { name: string; input: unknown }[];
  /** Each result's start, and whether the model was sent audio with it. */
  toolResults: { content: string; isError: boolean; audio: boolean }[];
  message: string;
  changes: string[];
  error: string | null;
  /** The tool groups loaded by its end. */
  loaded: string[];
  /** Its first message's tokens, counted as the summary budget counts them. */
  summaryTokens: number;
  /** For a Suggestion, what applying it did, or null while it hasn't been. */
  suggested: { applied: Applied | null } | null;
  /** Every API response's status and the model that answered. */
  responses: RequestRecord["responses"];
  /** Each wait on a busy API. */
  waits: RequestRecord["waits"];
  usage: Usage;
  firstPrompt: RequestRecord["firstPrompt"];
}

/** The whole-mix levels the checks read from a fresh analysis. */
interface Levels {
  samplePeakDb: number | null;
  truePeakDbtp: number | null;
  clippedSamples: number;
  integratedLufs: number | null;
}

/** The chosen provider's `fetch`, set up by `main`. */
let gateway: ReturnType<typeof watchedFetch>;
/** The model the run asked for. */
let model: string;
/** How the app would run a Request on it. */
let mode: RequestMode;
/** Whether the model takes audio, as the catalogue (or, for Local, the connection) declares. */
let takesAudio: boolean;

/**
 * A Request that stopped because the API couldn't prove it was the chosen
 * model answering, or wasn't there to answer. It is recorded, but it isn't a
 * result, and nothing more is sent.
 */
class NotRun extends Error {
  constructor(
    reason: string,
    readonly transcript: Transcript,
  ) {
    super(reason);
  }
}

/**
 * Records each reply's tool calls on their way to `runRequest`, and their
 * results on their way back, and counts the Request's first message.
 */
function recorded(
  start: StartConversation,
  calls: Transcript["toolCalls"],
  results: Transcript["toolResults"],
  first: { tokens: number },
): StartConversation {
  return (request, project, library, soFar, requestMode) => {
    first.tokens = estimatedTokens(requestMessage(request, project, library, soFar));
    const conversation = start(request, project, library, soFar, requestMode);
    return {
      async next(toolResults, turnsLeft, tools) {
        for (const result of toolResults) {
          results.push({ content: result.content.slice(0, 400), isError: result.isError, audio: result.audio !== undefined });
        }
        const reply = await conversation.next(toolResults, turnsLeft, tools);
        for (const call of reply.toolCalls) calls.push({ name: call.name, input: call.input });
        return reply;
      },
    };
  };
}

const analyse = wasmAudioAnalyser(() => Promise.resolve());
const listen = listenWith(analyse);

async function levels(project: Project): Promise<Levels> {
  const end = songEndTick(project);
  if (end === 0) return { samplePeakDb: null, truePeakDbtp: null, clippedSamples: 0, integratedLufs: null };
  const { measurements } = await listen(project, { start: 0, end, track: null });
  const measured = JSON.parse(measurements) as {
    sample_peak_db: number | null;
    true_peak_dbtp: number | null;
    clipping: { clipped_samples: number };
    loudness: { integrated_lufs: number | null };
  };
  return {
    samplePeakDb: measured.sample_peak_db,
    truePeakDbtp: measured.true_peak_dbtp,
    clippedSamples: measured.clipping.clipped_samples,
    integratedLufs: measured.loudness.integrated_lufs,
  };
}

/** The Project rendered from the top to its last Clip, as a 24-bit WAV a person can listen to. */
function writeWav(project: Project, name: string): string {
  const engine = new Engine(SAMPLE_RATE);
  try {
    for (const command of new EngineSync().update(project)) applyEngineCommand(engine, command);
    const audio = engine.render_range(0, songEndTick(project));
    const file = new URL(name, OUT);
    writeFileSync(file, encode_wav(audio, SAMPLE_RATE, 24)!);
    return `temp/real-model-check/${name}`;
  } finally {
    engine.free();
  }
}

interface SendOptions {
  /** The Conversation's Requests before this one. */
  conversation?: readonly FinishedRequest[];
  /** Made as a Suggestion whatever the provider's default. */
  suggestion?: boolean;
  /** Leave a Suggestion waiting rather than apply it as the musician would. */
  keepSuggestion?: boolean;
  /** Listening turned on, as the musician turns it on for a model that takes audio. */
  hearsAudio?: boolean;
  /** How the Assistant hears the Project, with its audio files; the Project alone, without. */
  listen?: Listen;
  hearReference?: HearReference;
  library?: AssistantLibrary;
}

/**
 * One Request, sent to the real model; the Project before it and after it.
 * A Suggestion is applied, unless it is to be kept, so `after` has its changes.
 */
async function sendRequest(start: StartConversation, history: ProjectHistory, text: string, options: SendOptions = {}) {
  const record = gateway.beginRequest();
  const toolCalls: Transcript["toolCalls"] = [];
  const toolResults: Transcript["toolResults"] = [];
  const first = { tokens: 0 };
  const before = history.project;
  const outcome = await runRequest({
    history,
    request: text,
    start: recorded(start, toolCalls, toolResults, first),
    listen: options.listen ?? listen,
    hearReference: options.hearReference,
    library: options.library,
    conversation: options.conversation,
    mode: { ...mode, ...(options.suggestion && { suggestion: true }), ...(options.hearsAudio && { hearsAudio: true }) },
  });
  const { suggestion } = outcome;
  if (suggestion && !options.keepSuggestion) await suggestion.apply();
  const transcript: Transcript = {
    toolCalls,
    toolResults,
    message: outcome.message,
    changes: outcome.changes,
    error: outcome.error,
    loaded: outcome.loaded,
    summaryTokens: first.tokens,
    suggested: suggestion && { applied: suggestion.applied },
    ...record,
  };
  if (gateway.stopped !== null) throw new NotRun(gateway.stopped, transcript);
  return { before, after: history.project, transcript, outcome };
}

/**
 * Undoing once a Request, newest first, puts back exactly the Project from
 * before each: `befores` are those Projects, oldest first.
 */
function undoRestores(history: ProjectHistory, ...befores: Project[]) {
  const labels: (string | null)[] = [];
  let pass = true;
  for (const before of befores.toReversed()) {
    // A Request that changed nothing leaves no step, and nothing to undo.
    if (history.project === before) continue;
    const label = history.undoLabel;
    labels.push(label);
    const undone = history.undo();
    pass = pass && label === REQUEST_LABEL && undone && isDeepStrictEqual(history.project, before);
  }
  return { pass: pass && !history.canUndo, labels, identical: history.project === befores[0] };
}

/** Notes that start before `end`, on any of the Track's Pattern Clips. */
function notesWithin(track: Track, end: number): number {
  let count = 0;
  for (const clip of track.clips) {
    if (clip.kind !== "pattern") continue;
    count += clip.notes.filter((note) => note.length > 0 && clip.start + note.start < end).length;
  }
  return count;
}

function trackSummary(track: Track) {
  const instrument =
    track.kind !== "instrument"
      ? "audio"
      : track.instrument.type === "plugin"
        ? `plugin ${track.instrument.plugin.id}`
        : `${track.instrument.type} (${track.instrument.preset ?? "no preset"})`;
  const notes = track.clips.reduce((sum, clip) => sum + (clip.kind === "pattern" ? clip.notes.length : 0), 0);
  return `“${track.name}”: ${instrument}, ${track.clips.length} Clip(s), ${notes} notes, volume ${track.mixer.volume}`;
}

async function buildABeat(start: StartConversation, run: number) {
  const history = new ProjectHistory(createProject("Untitled"));
  const { before, after, transcript } = await sendRequest(start, history, PROMPTS.build);
  const fourBars = 4 * barTicks(after.timeSignature);
  const drums = after.tracks.filter((track) => track.kind === "instrument" && track.instrument.type === "drumSampler");
  const bass = after.tracks.filter(
    (track) =>
      track.kind === "instrument" &&
      track.instrument.type === "synth" &&
      /bass/i.test(`${track.name} ${track.instrument.preset ?? ""}`),
  );
  const heard = await levels(after);
  const wav = songEndTick(after) > 0 ? writeWav(after, `build-run-${run}.wav`) : null;
  const checks = {
    noError: transcript.error === null,
    tempo120: after.tempo === 120,
    drumTrackWithNotes: drums.some((track) => notesWithin(track, fourBars) > 0),
    bassTrackWithNotes: bass.some((track) => notesWithin(track, fourBars) > 0),
    validates: validateProject(after) === null,
    nonSilent: heard.samplePeakDb !== null && heard.samplePeakDb > -40,
    notClipping: heard.clippedSamples === 0,
  };
  const undo = undoRestores(history, before);
  return {
    scenario: "build",
    run,
    transcript,
    tempo: after.tempo,
    songEndTick: songEndTick(after),
    tracks: after.tracks.map(trackSummary),
    validation: validateProject(after),
    levels: heard,
    wav,
    checks,
    undo,
    project: after,
  };
}

/**
 * How the song is made to clip: `track` pushes its loudest Track and the
 * Master to the top of their range, so lowering either stops the clipping, as
 * the MVP PRD says ("finds the loud Track or the Master"), though v3 wants the
 * Track lowered (#80); `everything` pushes every Track and the Master.
 */
type Loud = "track" | "everything";

const MASTER = "the Master";

/** `song` pushed up until a fresh analysis hears it clip, and which channels were pushed. */
async function madeToClip(song: Project, loud: Loud) {
  const project = structuredClone(song);
  project.master.volume = 2;
  const pushed = [MASTER];
  if (loud === "everything") {
    for (const track of project.tracks) {
      track.mixer.volume = 2;
      pushed.push(track.id);
    }
  } else {
    const soloPeaks = await Promise.all(
      project.tracks.map(async (_, index) => {
        const { measurements } = await listen(project, { start: 0, end: songEndTick(project), track: index });
        return (JSON.parse(measurements) as { sample_peak_db: number | null }).sample_peak_db ?? -Infinity;
      }),
    );
    const loudest = project.tracks[soloPeaks.indexOf(Math.max(...soloPeaks))]!;
    loudest.mixer.volume = 2;
    pushed.push(loudest.id);
  }
  return { project, pushed, levels: await levels(project) };
}

function volumeOf(project: Project, target: string): number | undefined {
  if (target === MASTER) return project.master.volume;
  return project.tracks.find((track) => track.id === target)?.mixer.volume;
}

function channelName(project: Project, target: string): string {
  return target === MASTER ? MASTER : `“${project.tracks.find((track) => track.id === target)?.name ?? target}”`;
}

async function fixTheClipping(start: StartConversation, song: Project, loud: Loud, run: number) {
  const clipping = await madeToClip(song, loud);
  if (clipping.levels.clippedSamples === 0) throw new Error("couldn't make the Project clip, so the scenario can't run");
  const history = new ProjectHistory(clipping.project);
  const { before, after, transcript } = await sendRequest(start, history, PROMPTS.clipping);
  const heard = await levels(after);
  const lowered = [MASTER, ...before.tracks.map((track) => track.id)]
    .map((target) => ({
      channel: channelName(before, target),
      target,
      before: volumeOf(before, target)!,
      after: volumeOf(after, target),
    }))
    .filter((channel) => channel.after !== undefined && channel.after < channel.before);
  const checks = {
    noError: transcript.error === null,
    clippedBefore: clipping.levels.clippedSamples > 0,
    calledAnalyseAudio: transcript.toolCalls.some((call) => call.name === "analyse_audio"),
    loweredAPushedChannel: lowered.some((channel) => clipping.pushed.includes(channel.target)),
    noClippingAfter: heard.clippedSamples === 0,
    // v3 (#80): the mix ends under the true-peak ceiling, and with one loud
    // Track, that Track is the one that came down.
    withinCeilingAfter: heard.truePeakDbtp === null || heard.truePeakDbtp <= TRUE_PEAK_CEILING_DBTP,
    ...(loud === "track" && { loweredTheLoudTrack: lowered.some((channel) => channel.target === clipping.pushed[1]) }),
    validates: validateProject(after) === null,
  };
  const undo = undoRestores(history, before);
  return {
    scenario: `clipping (${loud})`,
    loud,
    run,
    pushedUp: clipping.pushed.map((target) => channelName(before, target)),
    transcript,
    levelsBefore: clipping.levels,
    levelsAfter: heard,
    lowered: lowered.map(({ channel, before: from, after: to }) => ({ channel, from, to })),
    checks,
    undo,
  };
}

function passed(checks: Record<string, boolean>): boolean {
  return Object.values(checks).every(Boolean);
}

interface Printed {
  scenario: string;
  run: number;
  checks: Record<string, boolean>;
  undo: { pass: boolean };
}

/** A scenario's result, and each of its Requests: a Conversation's are two. */
function print(result: Printed, transcripts: readonly Transcript[]) {
  console.log(`\n== ${result.scenario} run ${result.run}: ${passed(result.checks) && result.undo.pass ? "PASS" : "FAIL"}`);
  for (const [index, transcript] of transcripts.entries()) {
    const which = transcripts.length > 1 ? ` (Request ${index + 1})` : "";
    console.log(`   tool calls${which}: ${transcript.toolCalls.map((call) => call.name).join(", ") || "none"}`);
    const refused = transcript.toolResults.filter((toolResult) => toolResult.isError);
    for (const toolResult of refused) console.log(`   tool error: ${toolResult.content}`);
    if (transcript.error) console.log(`   error: ${transcript.error}`);
  }
  for (const [name, ok] of Object.entries(result.checks)) console.log(`   ${ok ? "pass" : "FAIL"} ${name}`);
  console.log(`   ${result.undo.pass ? "pass" : "FAIL"} undoRestores`);
  console.log(`   answered by: ${answeredBy(transcripts) || "no response"}`);
  for (const [index, transcript] of transcripts.entries()) {
    const which = transcripts.length > 1 ? ` (Request ${index + 1})` : "";
    for (const wait of transcript.waits) console.log(`   waited ${wait.seconds} s on a ${wait.status}`);
    const { calls, input, output, cacheWrite, cacheRead } = transcript.usage;
    console.log(
      `   usage${which}: ${calls} API calls, in ${input}, out ${output}, cache write ${cacheWrite}, cache read ${cacheRead}: ${dollars(cost(model, transcript.usage))}`,
    );
    console.log(`   ${budgetLine(transcript)}`);
  }
}

/** A Request's first message against the summary budget, and the first call's whole prompt. */
function budgetLine({ summaryTokens, firstPrompt }: Transcript): string {
  const within = summaryTokens <= SUMMARY_TOKEN_BUDGET ? "within" : "OVER";
  const prompt = firstPrompt === null ? "no first call counted" : `${firstPrompt} tokens as the API counted it`;
  return `first message ~${summaryTokens} tokens, ${within} the ${SUMMARY_TOKEN_BUDGET}-token summary budget; first call's whole prompt ${prompt}`;
}

/**
 * One v3 scenario: its Requests in one Conversation, from its song, with
 * the audio files, library and listening it needs, then its checks, and one
 * undo a Request putting back the song.
 */
async function runV3(start: StartConversation, name: V3ScenarioName, run: number) {
  const scenario: V3Scenario = V3_SCENARIOS[name];
  const world = await scenarioWorld(scenario, analyse);
  const history = new ProjectHistory(scenario.song());
  const projects = [history.project];
  const transcripts: Transcript[] = [];
  const finished: FinishedRequest[] = [];
  // Only the Suggestion scenario: its changes wait, and change nothing until applied.
  let suggestionChecks: Record<string, boolean> = {};
  for (const prompt of scenario.prompts) {
    const suggestion = scenario.suggestion === true;
    const sent = await sendRequest(start, history, prompt, {
      conversation: finished,
      suggestion,
      keepSuggestion: suggestion,
      hearsAudio: scenario.hearsAudio === true,
      listen: world.listen,
      hearReference: world.hearReference,
      library: world.library,
    });
    transcripts.push(sent.transcript);
    finished.push({ request: prompt, outcome: sent.outcome });
    if (suggestion) {
      const pending = sent.outcome.suggestion;
      const unchanged = history.project === sent.before && !history.canUndo;
      const applied = pending ? await pending.apply() : null;
      sent.transcript.suggested = pending && { applied };
      suggestionChecks = {
        offeredASuggestion: pending !== null && sent.outcome.changes.length > 0,
        unchangedUntilApplied: unchanged,
        appliedEveryChange: applied !== null && applied.failed.length === 0,
      };
    }
    projects.push(history.project);
  }
  const checks = { ...checkScenario(scenario, projects, transcripts), ...suggestionChecks };
  const undo = undoRestores(history, ...projects.slice(0, -1));
  const after = projects.at(-1)!;
  return {
    scenario: name,
    story: scenario.story,
    prompts: scenario.prompts,
    mode: { ...mode, ...(scenario.suggestion && { suggestion: true }), ...(scenario.hearsAudio && { hearsAudio: true }) },
    run,
    transcripts,
    tracks: after.tracks.map(trackSummary),
    buses: after.buses.map((bus) => `“${bus.name}”: volume ${bus.mixer.volume}`),
    sections: after.sections.map((section) => `${section.name} ${section.startBar}+${section.bars}`),
    checks,
    undo,
  };
}

/** The models that answered, with how many responses each: the proof of which model a run tested. */
function answeredBy(transcripts: readonly Transcript[]): string {
  const counts = new Map<string, number>();
  for (const { model: answered } of transcripts.flatMap((transcript) => transcript.responses)) {
    if (answered !== null) counts.set(answered, (counts.get(answered) ?? 0) + 1);
  }
  return [...counts].map(([answered, count]) => `${answered} ×${count}`).join(", ");
}

function dollars(amount: number | null): string {
  return amount === null ? `no price on record for ${model}` : `$${amount.toFixed(4)}`;
}

async function main() {
  const choice = parseArgs(process.argv.slice(2));
  const connection = connectionFromEnvironment(choice, process.env);
  const { name } = providerOf(choice.provider);
  model = choice.model;
  // The custom headers go on every request: a gateway may route by them.
  const requiredHeaders = Object.keys(headersOf(connection));
  gateway = watchedFetch({ provider: choice.provider, model, fetch: (input, init) => fetch(input, init), requiredHeaders });

  initSync({ module: readFileSync(new URL("../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  mkdirSync(OUT, { recursive: true });
  const start = conversationsFor(choice.provider, connection, gateway.fetch);
  mode = requestModeFor(choice.provider, connection);
  takesAudio = capabilitiesFor(choice.provider, connection).audioInput;
  console.log(`${name}, model ${model}, effort ${choice.effort ?? "the model's default"}, ${new Date().toISOString()}`);
  console.log(
    `   ${mode.smallCore ? "the smaller core" : "the whole core"}; changes ${mode.suggestion ? "as Suggestions, which the check applies" : "applied as they are made"}`,
  );
  console.log(
    `   base URL ${connection.baseUrl ?? "the provider's own"}; custom headers sent: ${requiredHeaders.join(", ") || "none"}`,
  );

  const builds: Awaited<ReturnType<typeof buildABeat>>[] = [];
  const fixes: Awaited<ReturnType<typeof fixTheClipping>>[] = [];
  const stories: Awaited<ReturnType<typeof runV3>>[] = [];
  /** Scenarios that can't run on this model, and why: not results. */
  const skipped: { scenario: string; story: string; reason: string }[] = [];
  let notRun: { reason: string; transcript: Transcript } | null = null;
  try {
    if (choice.scenarios.includes("build")) {
      for (let run = 1; run <= RUNS; run++) {
        const result = await buildABeat(start, run);
        print(result, [result.transcript]);
        console.log(`   tempo ${result.tempo}; ${result.tracks.join("; ")}`);
        console.log(`   mix: peak ${result.levels.samplePeakDb} dBFS, ${result.levels.clippedSamples} clipped; ${result.wav}`);
        builds.push(result);
      }
    }
    if (choice.scenarios.includes("clipping")) {
      // The song to push into clipping: the first beat the model built that
      // passed, or the saved one from an earlier run when only this scenario
      // runs, or else the v3 scenarios' song.
      const saved = new URL("song.json", OUT);
      const song =
        builds.find((build) => passed(build.checks))?.project ??
        (existsSync(saved) ? (JSON.parse(readFileSync(saved, "utf8")) as Project) : null) ??
        v3Song();
      console.log(`\nThe song made to clip: “${song.name}”, ${song.tracks.map((track) => track.name).join(", ")}`);
      for (const loud of ["track", "everything"] as const) {
        for (let run = 1; run <= RUNS; run++) {
          const result = await fixTheClipping(start, song, loud, run);
          print(result, [result.transcript]);
          console.log(`   pushed up to volume 2: ${result.pushedUp.join(", ")}`);
          console.log(
            `   before: peak ${result.levelsBefore.samplePeakDb} dBFS, ${result.levelsBefore.clippedSamples} clipped; after: peak ${result.levelsAfter.samplePeakDb} dBFS, ${result.levelsAfter.clippedSamples} clipped`,
          );
          console.log(`   lowered: ${JSON.stringify(result.lowered)}`);
          fixes.push(result);
        }
      }
    }
    for (const scenario of choice.scenarios) {
      if (!(scenario in V3_SCENARIOS)) continue;
      const { story, hearsAudio } = V3_SCENARIOS[scenario as V3ScenarioName] as V3Scenario;
      if (hearsAudio && !takesAudio) {
        // Listening needs a model that takes audio: on any other it isn't a result.
        const reason = `${model} doesn't take audio, so it can't be sent the render`;
        console.log(`\n== ${scenario}: SKIPPED (${reason})`);
        skipped.push({ scenario, story, reason });
        continue;
      }
      for (let run = 1; run <= RUNS; run++) {
        const result = await runV3(start, scenario as V3ScenarioName, run);
        print(result, result.transcripts);
        console.log(`   tracks: ${result.tracks.join("; ")}`);
        if (result.buses.length > 0) console.log(`   buses: ${result.buses.join("; ")}`);
        console.log(`   sections: ${result.sections.join(", ")}`);
        stories.push(result);
      }
    }
  } catch (error) {
    if (!(error instanceof NotRun)) throw error;
    notRun = { reason: error.message, transcript: error.transcript };
  }

  const song = builds.find((build) => passed(build.checks))?.project;
  if (song) writeFileSync(new URL("song.json", OUT), JSON.stringify(song, null, 1));
  const record = new URL(`results-${Date.now()}.json`, OUT);
  const run = { provider: choice.provider, model, effort: choice.effort ?? null, mode, builds, fixes, stories, skipped, waived: V3_WAIVERS, notRun };
  writeFileSync(record, JSON.stringify(run, null, 1));
  const transcripts = [...[...builds, ...fixes].map((result) => result.transcript), ...stories.flatMap((result) => result.transcripts)];
  if (notRun) transcripts.push(notRun.transcript);
  const usage = transcripts.reduce(
    (sum, { usage: each }) => ({
      calls: sum.calls + each.calls,
      input: sum.input + each.input,
      output: sum.output + each.output,
      cacheWrite: sum.cacheWrite + each.cacheWrite,
      cacheRead: sum.cacheRead + each.cacheRead,
    }),
    { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  );
  console.log(`\nResults, ${name} ${model}, ${mode.smallCore ? "the smaller core" : "the whole core"}:`);
  for (const result of [...builds, ...fixes, ...stories]) {
    const failing = [...Object.entries(result.checks).filter(([, ok]) => !ok).map(([check]) => check), ...(result.undo.pass ? [] : ["undoRestores"])];
    console.log(`   ${result.scenario} run ${result.run}: ${failing.length === 0 ? "PASS" : `FAIL (${failing.join(", ")})`}`);
  }
  for (const { scenario, reason } of skipped) console.log(`   ${scenario}: SKIPPED (${reason})`);
  const largest = Math.max(0, ...transcripts.map((transcript) => transcript.summaryTokens));
  console.log(`   the largest first message: ~${largest} of the ${SUMMARY_TOKEN_BUDGET}-token summary budget`);
  console.log(`\nAnswered by: ${answeredBy(transcripts) || "no response"}`);
  console.log(
    `${transcripts.length} Requests, ${usage.calls} API calls, estimated ${dollars(cost(model, usage))}. Record: temp/real-model-check/${record.pathname.split("/").pop()}`,
  );
  if (notRun) {
    console.log(`\nNOT RUN. The check stopped during a Request, and is not a result for ${name} ${model}:\n${notRun.reason}`);
    process.exitCode = 1;
  }
}

await main();
