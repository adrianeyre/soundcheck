/**
 * One Request, start to finish.
 *
 * The Assistant sends the Request and the Project to the model, applies the
 * tool calls that come back, sends it the results, and goes round again
 * until it has nothing more to do. Everything it changes goes through
 * `ProjectHistory` inside one group, so the whole Request is one undo step.
 * The group is the Assistant's alone: the Project can't be edited or undone
 * from under it while the Request is running.
 *
 * The model is behind `Conversation`, so tests script the tool calls and
 * never touch the real API. It listens through `Listen`, which renders the
 * Project as it stands at that moment, this Request's changes and all.
 * Each analysis is kept for the rest of the Request, so `compare_audio`
 * can tell the model what its changes did to the sound (`compare.ts`).
 *
 * A Request starts with the core tools, and `load_tools` adds a group of
 * them for the rest of it: each turn is sent the tools loaded so far, and a
 * call to a tool in a group that isn't loaded is refused.
 *
 * The app's library (`library.ts`) is outside the Project: a Preset or Kit
 * a Request saves into it stays saved when the Request is undone, and is
 * there for the rest of the Request to load.
 *
 * The library also lists the sample browser's folders and copies a sample
 * into the Project for `place_audio_clip`, as a drop does. The copy is
 * loaded audio, not a change to the Project: the Clip that plays it is,
 * and undoes with the rest.
 *
 * A Request may follow up earlier ones in a Conversation. It is sent what
 * each asked, the Assistant's reply and the changes it reported, not its
 * tool calls, and whether the musician has undone it (or redone it) since;
 * the groups they loaded stay loaded. Each is still its own undo step.
 *
 * A Request's `mode` says which core it starts with, the whole one or the
 * smaller one a Local model gets, and whether it is a Suggestion. A
 * Suggestion runs against a copy of the Project, which `analyse_audio`
 * renders, while the real history is held still, as for any Request, and
 * left exactly as it was. Every call that changed the copy is kept with the
 * ids it made, and applying the Suggestion runs them again against the real
 * Project, as one undo step: on the Project the Suggestion was worked out
 * from, they make the same commands, and on one the musician has changed
 * since, each is worked out afresh, keeping the musician's edit, and one
 * that no longer applies is reported. Presets and Kits it saves are saved
 * only then, as they are outside the Project and not undone.
 *
 * `separate_stems` waits inside the Request for a Stem Separation, which
 * takes minutes, then places the Stems as part of its undo step; the wait
 * is no turn of `MAX_TURNS`. It is shown to the musician with its progress
 * and a Cancel (`onSeparation`); cancelling fails the call, and the model is
 * asked for its summary. A Suggestion never separates twice: the Stems its
 * run separated, whose audio joins the loaded audio so the rest of it can
 * hear them, are kept with the call and placed again on Apply, and their
 * audio leaves the loaded audio if it is discarded.
 */
import type { Analysed, AnalysisRange } from "../audio/audio-analyser";
import { type ProjectGroup, ProjectHistory } from "../project/history";
import { clipFileName } from "../export/mix-exporter";
import { type AudioClip, type Project, withIds } from "../project/model";
import type { AssistantStems } from "../stems/assistant-stems";
import type { Stem } from "../stems/stem-separator";
import { audioFiles as filesNamedBy } from "../storage/project-folder";
import type { Capabilities } from "./catalogue";
import { analysisId, chooseAnalyses, compareAnalyses, type KeptAnalysis } from "./compare";
import { describeDecisions, type Decide } from "./jev";
import { type AssistantLibrary, EMPTY_LIBRARY, type LibraryContents } from "./library";
import { compareToReference, type HearReference } from "./reference";
import {
  InvalidToolCall,
  loadedReport,
  planToolCall,
  AUDIO_ATTACHED,
  AUDIO_NOTE_START,
  SPECTROGRAM_ATTACHED,
  toolDefinitions,
  toolGroupOf,
  truePeakNote,
  type ToolCall,
  type ToolDefinition,
  type ToolGroup,
  type ToolPlan,
} from "./tools";

/** What the Assistant tells the model a tool call did, or why it didn't. */
export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
  /** A picture to show the model with `content`, as a base64 PNG. */
  image?: string;
  /** Audio for the model to hear with `content`, as a base64 file in `LISTENING`'s format. */
  audio?: string;
}

/**
 * A result as a model that can't see images is sent it: without its
 * picture, and saying so, so the model reads the measurements instead.
 */
export function withoutImage(result: ToolResult): ToolResult {
  if (result.image === undefined) return result;
  const { image: _, ...rest } = result;
  const content = result.content.replace(SPECTROGRAM_ATTACHED, "");
  return { ...rest, content: `${content}\nNo spectrogram is attached: this model can't take images, so read the measurements instead.` };
}

/**
 * A result as a model that isn't sent audio is sent it: without its audio,
 * and saying so, so the model reads the measurements instead. A result that
 * asked for audio it didn't get says so too.
 */
export function withoutAudio(result: ToolResult): ToolResult {
  if (result.audio === undefined && !result.content.includes(AUDIO_ATTACHED)) return result;
  const { audio: _, ...rest } = result;
  // The line on what the audio is of goes with it.
  const content = result.content
    .replace(AUDIO_ATTACHED, "")
    .split("\n")
    .filter((line) => !line.startsWith(AUDIO_NOTE_START))
    .join("\n");
  return { ...rest, content: `${content}\nNo audio is attached: this model isn't sent audio here, so read the measurements instead.` };
}

/** A result as a model that can do what `capabilities` say is sent it: without what it can't take. */
export function sentTo(capabilities: Pick<Capabilities, "imageInput" | "audioInput">, result: ToolResult): ToolResult {
  const seen = capabilities.imageInput ? result : withoutImage(result);
  return capabilities.audioInput ? seen : withoutAudio(seen);
}

/** One reply from the model: what it says, and what it wants to do. */
export interface ModelReply {
  text: string;
  toolCalls: ToolCall[];
  /** The tokens the turn cost, where the provider says; a server that doesn't counts none. */
  usage?: TokenUsage;
}

/**
 * The tokens a turn, a Request or a Conversation cost: what the provider
 * bills for. `input` is everything the model was sent, cached or not, and
 * `output` everything it wrote back, its thinking included.
 */
export interface TokenUsage {
  input: number;
  output: number;
}

export const NO_TOKENS: TokenUsage = { input: 0, output: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  return b ? { input: a.input + b.input, output: a.output + b.output } : a;
}

/**
 * What a running Request is doing, for the musician to watch: waiting for
 * the model's reply, or carrying out one of its tool calls, and the tokens
 * it has cost so far.
 */
export interface RequestStatus {
  /** The turn it is on, from 1. */
  turn: number;
  /** The model is writing its reply, or the tool being called. */
  doing: { kind: "thinking" } | { kind: "tool"; name: string };
  usage: TokenUsage;
  /** How many tokens the latest turn held, sent and written together; 0 before the first reply. */
  context: number;
}

/**
 * One Request's worth of talking to the model. The first `next` sends the
 * Request itself, and each one after it sends the results of the tool calls
 * from the reply before, and tells the model `turnsLeft`: how many replies,
 * this one included, may still call tools. At 0 the reply can't call any,
 * and the model is asked for its summary instead.
 *
 * `tools` are the definitions the model has this turn: the core ones, and
 * those of every group loaded so far. They only grow, and a Provider sends
 * whatever it is given, even at 0, for the calls already made.
 */
export interface Conversation {
  next(results: readonly ToolResult[], turnsLeft: number, tools: readonly ToolDefinition[]): Promise<ModelReply>;
}

/**
 * Render `range` of `project` offline and measure it, for `analyse_audio`.
 * Resolves to the measurements as the engine writes them, and the
 * spectrogram if the range asks for one.
 */
export type Listen = (project: Project, range: AnalysisRange) => Promise<Analysed>;

/**
 * An earlier Request of the Conversation, as a follow-up is sent it: what
 * the musician asked, what the Assistant said and the changes it reported.
 */
export interface EarlierRequest {
  request: string;
  message: string;
  changes: string[];
  error: string | null;
  /**
   * What the musician has done with its undo step: "undone" while it is
   * undone, "redone" if it is back since a Request was told it was undone,
   * "discarded" for a Suggestion they didn't apply, and null otherwise.
   */
  since: "undone" | "redone" | "discarded" | null;
}

/** What a follow-up is sent of the Conversation before it. */
export interface ConversationSoFar {
  /** Oldest first. */
  earlier: readonly EarlierRequest[];
  /** The tool groups loaded earlier in the Conversation, which stay loaded. */
  loaded: readonly ToolGroup[];
}

/**
 * Opens a conversation about `request`, given the Project as it stands,
 * what is in the musician's library (their User Presets and saved Kits)
 * and, for a follow-up, the Conversation so far.
 */
export type StartConversation = (
  request: string,
  project: Project,
  library?: LibraryContents,
  conversation?: ConversationSoFar,
  mode?: RequestMode,
) => Conversation;

/** How a Request runs, as the musician set the Assistant up for its Provider. */
export interface RequestMode {
  /** It starts with the smaller core (`SMALL_CORE_TOOL_DEFINITIONS`): a Local model's default. */
  smallCore: boolean;
  /** Its changes are a Suggestion, applied only when the musician says so: a Local model's default. */
  suggestion: boolean;
  /**
   * `analyse_audio` can attach the render as audio: the model takes audio
   * and the musician allows it, which is off by default. Left out, it can't.
   */
  hearsAudio?: boolean;
  /** It can ask the Decision Engine (Jev) with `decide`. Left out, it can't. */
  decides?: boolean;
}

/** The whole core, with changes applied as they are made. */
export const DIRECT: RequestMode = { smallCore: false, suggestion: false };

/** What applying a Suggestion did. */
export interface Applied {
  /** One line per change made, as a Request's are. */
  changes: string[];
  /** One line per suggested change that couldn't be made, and why. */
  failed: string[];
  /** The Project had changed since the Suggestion, so each call was worked out again against it. */
  reworked: boolean;
}

/**
 * A Request's changes, worked out against a copy of the Project and waiting
 * for the musician. The outcome's `changes` are what it would change.
 */
export interface Suggestion {
  /** Waiting to be applied or discarded, or which of those it was. */
  readonly status: "pending" | "applied" | "discarded";
  /** What applying it did, once it has been. */
  readonly applied: Applied | null;
  /**
   * Make its changes to the real Project as one undo step. Only a pending
   * Suggestion applies, and only while the history isn't busy.
   */
  apply(): Promise<Applied>;
  /** Drop it: nothing in the Project changes. */
  discard(): void;
}

/** What one Request did, for the summary the musician reads. */
export interface RequestOutcome {
  /** The Assistant's own words. */
  message: string;
  /** One line per change made, in the order they were made. */
  changes: string[];
  /** Why the Request stopped early, or null. */
  error: string | null;
  /** Every tool group loaded by its end, which stay loaded for the Conversation's next Request. */
  loaded: ToolGroup[];
  /** Whether its undo step is undone now. Never, for a Request that changed nothing. */
  undone: () => boolean;
  /** Which of the Conversation's earlier Requests it was told were undone, in order. */
  toldUndone: boolean[];
  /** For a Request made as a Suggestion, the Suggestion; null otherwise. */
  suggestion: Suggestion | null;
  /** The tokens it cost, over all its turns, a failed one's up to where it stopped. */
  usage: TokenUsage;
  /**
   * How many tokens its last turn held, sent and written together: how
   * full the model's context got. 0 where the server said nothing.
   */
  context: number;
}

/** A Request of a Conversation that has run: what the musician asked, and what it did. */
export interface FinishedRequest {
  /** What the model was sent. */
  request: string;
  /** What the musician typed, where the model was sent something else: a Skill's command, sent as its instructions. */
  typed?: string;
  outcome: RequestOutcome;
}

/** The undo step a Request becomes, whatever it changed. */
export const REQUEST_LABEL = "Request";

/**
 * How many replies of a Request may call tools; one more, without tools,
 * follows for the summary. A per-Track clipping fix made one call per turn
 * on four Tracks takes 9 (the mix, each Track, the fix, a check, the
 * Master, a check), so 12 leaves room for a mistake or two and still stops
 * a loop. Made as the system prompt asks, a turn's independent calls
 * together, the same fix takes 5.
 */
export const MAX_TURNS = 12;

export interface RunRequestOptions {
  history: ProjectHistory;
  request: string;
  start: StartConversation;
  /** How the Assistant hears the Project; without it, it can't listen. */
  listen?: Listen;
  /** How it measures the Reference Track; without it, it can't compare the mix with one. */
  hearReference?: HearReference;
  /**
   * The musician's library of User Presets and saved Kits, which its tools
   * load from and save into; without it, there are none, and nothing saves.
   */
  library?: AssistantLibrary;
  /** The Requests before this one in its Conversation, oldest first; none for a new one. */
  conversation?: readonly FinishedRequest[];
  /** Its core and whether it is a Suggestion; left out, the whole core, applied as it goes. */
  mode?: RequestMode;
  /** How it separates an Audio Clip into Stems; without it, it can't. */
  stems?: AssistantStems;
  /** How it asks the Decision Engine (Jev); without it, `decide` isn't offered. */
  decide?: Decide;
  /** Told when a Stem Separation starts, each time it gets further, and, with null, when it ends. */
  onSeparation?: (separation: RunningSeparation | null) => void;
  /** Told what it is doing each time that changes, so the musician can see it hasn't stalled. */
  onStatus?: (status: RequestStatus) => void;
}

/** A Stem Separation a Request is waiting for, as the musician is shown it. */
export interface RunningSeparation {
  /** The name the Clip being separated shows. */
  clipName: string;
  /** How far it has got, 0 to 1. */
  progress: number;
  /** Stop it: the call fails, nothing changes, and the Assistant sums up. */
  cancel: () => void;
}

/** Why `separate_stems` failed, as the model is told. */
export const STEMS_UNAVAILABLE = "Stem Separation isn't available here.";
export const STEMS_NOT_INSTALLED =
  "The separation model isn't installed; the musician can install it from Separate into Stems on any Audio Clip. Nothing was changed.";
export const STEMS_CANCELLED = "Cancelled by the musician. Nothing was changed.";

/** What a call made after the musician cancelled a Stem Separation is told, in the same turn. */
const AFTER_CANCEL = "Not made: the musician cancelled the Stem Separation, so the Request is ending. Nothing was changed.";

/** A call that changed the Project, kept to be made again: with the ids it made, and its line of the summary. */
interface KeptCall {
  call: ToolCall;
  ids: string[];
  change: string | undefined;
  /** For `separate_stems`, the Stems it separated, placed again rather than separated again. */
  stems?: readonly Stem[];
  /** The files it added to the loaded audio, to take out again if the Suggestion is discarded. */
  added?: readonly string[];
}

/** What one Request has to hand while it applies its tool calls. */
interface RequestState {
  group: ProjectGroup;
  /** One line per change made, for the outcome. */
  changes: string[];
  listen: Listen | undefined;
  hearReference: HearReference | undefined;
  library: AssistantLibrary | undefined;
  /** What is in the library now: as the Request started, and what it has saved since. */
  contents: LibraryContents;
  /** Each successful analysis, for compare_audio. */
  analyses: KeptAnalysis[];
  /** The groups `load_tools` has loaded, which a group's tool must be in. */
  loaded: Set<ToolGroup>;
  smallCore: boolean;
  /** The model is sent the audio `analyse_audio` asks for. */
  hearsAudio: boolean;
  /**
   * For a Suggestion, every call that changed the copy, and Presets and
   * Kits are saved only in `contents`: the library waits for Apply.
   */
  kept: KeptCall[] | null;
  stems: AssistantStems | undefined;
  decide: Decide | undefined;
  onSeparation: ((separation: RunningSeparation | null) => void) | undefined;
  /** The musician cancelled a Stem Separation: the Request goes straight to its summary. */
  cancelled: boolean;
}

/**
 * Carry out one Request. Changes apply as they are made, and undo together;
 * in Suggestion mode they are made to a copy, and wait for the musician.
 */
export async function runRequest({
  history,
  request,
  start,
  listen,
  hearReference,
  library,
  conversation: finished = [],
  mode: asked = DIRECT,
  stems,
  decide,
  onSeparation,
  onStatus,
}: RunRequestOptions): Promise<RequestOutcome> {
  // The model is told of `decide`, and offered it, only where Jev can be asked.
  const mode: RequestMode = { ...asked, decides: decide !== undefined };
  let message = "";
  let error: string | null = null;
  let usage = NO_TOKENS;
  let context = 0;

  const toldUndone = finished.map(({ outcome }) => outcome.undone());
  const soFar = conversationSoFar(finished, toldUndone);
  // The real history is held still either way; a Suggestion's changes go to a copy.
  const held = history.beginGroup(REQUEST_LABEL);
  const from = history.project;
  const copy = mode.suggestion ? new ProjectHistory(from) : null;
  const group = copy ? copy.beginGroup(REQUEST_LABEL) : held;
  const project = () => (copy ?? history).project;
  const loaded = new Set(soFar.loaded);
  const state: RequestState = {
    group,
    changes: [],
    listen,
    hearReference,
    library,
    contents: EMPTY_LIBRARY,
    analyses: [],
    loaded,
    smallCore: mode.smallCore,
    hearsAudio: mode.hearsAudio ?? false,
    kept: copy ? [] : null,
    stems,
    decide,
    onSeparation,
    cancelled: false,
  };
  try {
    if (library) state.contents = await library.contents(from);
    const conversation = start(request, from, state.contents, soFar, mode);
    let results: ToolResult[] = [];
    // The last turn, at 0, has no tools: the model sums up, so a Request
    // that uses every turn still ends with the Assistant's own words.
    for (let turnsLeft = MAX_TURNS; turnsLeft >= 0; turnsLeft--) {
      // A cancelled Stem Separation ends the Request: the next reply is its summary.
      if (state.cancelled) turnsLeft = 0;
      const turn = MAX_TURNS - turnsLeft + 1;
      onStatus?.({ turn, doing: { kind: "thinking" }, usage, context });
      const reply = await conversation.next(results, turnsLeft, toolDefinitions(state.loaded, mode.smallCore, state.hearsAudio, mode.decides));
      usage = addUsage(usage, reply.usage);
      // Each turn is sent everything before it, so the latest holds the most.
      if (reply.usage) context = reply.usage.input + reply.usage.output;
      if (reply.text.trim()) message = reply.text.trim();
      if (reply.toolCalls.length === 0) break;
      // A model that calls tools when it has none left is not obeyed.
      if (turnsLeft === 0) {
        error = `The Assistant is still going after ${MAX_TURNS} turns, so it was stopped.`;
        break;
      }

      // In order: each call sees the Project as the ones before it left it.
      results = [];
      for (const call of reply.toolCalls) {
        if (!state.cancelled) onStatus?.({ turn, doing: { kind: "tool", name: call.name }, usage, context });
        results.push(state.cancelled ? { callId: call.id, content: AFTER_CANCEL, isError: true } : await apply(state, project(), call));
      }
    }
  } catch (reason) {
    error = reasonText(reason);
  } finally {
    group.end();
    held.end();
  }

  const outcome = { message, changes: state.changes, error, loaded: [...loaded], toldUndone, usage, context };
  if (!state.kept) return { ...outcome, undone: () => group.undone, suggestion: null };
  // Nothing to apply is no Suggestion: a question, or a Request that failed.
  if (state.kept.length === 0) return { ...outcome, undone: () => false, suggestion: null };
  const suggestion = suggestionOf(history, from, state.kept, { listen, library, smallCore: mode.smallCore, stems });
  // Until it is applied, none of its changes are in the Project.
  return { ...outcome, undone: () => suggestion.undone(), suggestion };
}

/**
 * The Suggestion of `kept` calls, worked out against `from`, to apply to
 * `history`. `undone` says whether its changes are out of the Project:
 * until it is applied, and once the step it became is undone.
 */
function suggestionOf(
  history: ProjectHistory,
  from: Project,
  kept: readonly KeptCall[],
  { listen, library, smallCore, stems }: Pick<RequestState, "listen" | "library" | "smallCore" | "stems">,
): Suggestion & { undone: () => boolean } {
  let status: Suggestion["status"] = "pending";
  let applied: Applied | null = null;
  let step: ProjectGroup | null = null;
  // The Stems' audio its run added that the Project doesn't name now: a
  // discarded Suggestion's, or one whose Clip had gone by Apply.
  const dropStems = () => {
    const named = new Set(filesNamedBy(history.project));
    const unused = kept.flatMap(({ added }) => added ?? []).filter((path) => !named.has(path));
    if (unused.length > 0) stems?.remove(unused);
  };
  return {
    get status() {
      return status;
    },
    get applied() {
      return applied;
    },
    undone: () => step === null || step.undone,
    discard() {
      if (status !== "pending") return;
      status = "discarded";
      dropStems();
    },
    async apply() {
      if (status !== "pending") throw new Error(`The Suggestion has been ${status} already.`);
      if (history.busy) throw new Error(BUSY_NOW);
      status = "applied";
      const reworked = history.project !== from;
      const group = history.beginGroup(REQUEST_LABEL);
      step = group;
      const state: RequestState = {
        group,
        changes: [],
        listen,
        // compare_to_reference changes nothing either, so it is never made again.
        hearReference: undefined,
        library,
        contents: EMPTY_LIBRARY,
        analyses: [],
        loaded: new Set(),
        smallCore,
        // Only analyse_audio attaches audio, and it changes nothing, so it is never made again.
        hearsAudio: false,
        kept: null,
        stems,
        // decide changes nothing, so it is never made again.
        decide: undefined,
        // Its Stems were separated when it was worked out, so nothing is separated now.
        onSeparation: undefined,
        cancelled: false,
      };
      const failed: string[] = [];
      try {
        if (library) state.contents = await library.contents(history.project);
        for (const made of kept) {
          // The ids it made before, so later calls that name them find them.
          const result = await apply(state, history.project, made.call, made);
          if (result.isError) failed.push(`${made.change ?? made.call.name}: ${result.content}`);
        }
      } finally {
        group.end();
        dropStems();
      }
      applied = { changes: state.changes, failed, reworked };
      return applied;
    },
  };
}

/** Why a Suggestion can't be applied just now. */
const BUSY_NOW = "The Project is being changed. Apply the Suggestion when that has finished.";

/**
 * The Conversation as a follow-up is sent it, given which of its Requests
 * are undone now. One the last Request was told was undone and isn't any
 * more has been redone.
 */
function conversationSoFar(finished: readonly FinishedRequest[], undone: readonly boolean[]): ConversationSoFar {
  const last = finished.at(-1)?.outcome;
  const earlier = finished.map(({ request, outcome }, index): EarlierRequest => {
    const { suggestion } = outcome;
    return {
      request,
      message: outcome.message,
      // An applied Suggestion's are what applying it made.
      changes: suggestion?.applied?.changes ?? outcome.changes,
      error: outcome.error,
      since:
        suggestion && suggestion.status !== "applied"
          ? "discarded"
          : undone[index]
            ? "undone"
            : last?.toldUndone[index]
              ? "redone"
              : null,
    };
  });
  return { earlier, loaded: last?.loaded ?? [] };
}

/**
 * One tool call: checked, applied, listened to, compared or saved, and
 * answered. A successful analysis is added to the Request's `analyses`, a
 * group `load_tools` loads to its `loaded`, and a Preset or Kit saved, or a
 * sample copied into the Project, to its `contents`.
 */
async function apply(
  state: RequestState,
  project: Project,
  call: ToolCall,
  again?: Pick<KeptCall, "ids" | "stems">,
): Promise<ToolResult> {
  const { group, changes, listen, hearReference, library, analyses, loaded, kept: suggested } = state;
  const needs = toolGroupOf(call.name, state.smallCore);
  // A Suggestion applied again had its groups loaded when it was worked out.
  if (needs && !loaded.has(needs) && !again) {
    const content = `${call.name} is one of the ${needs} tools, which aren't loaded: call load_tools with group "${needs}", then call ${call.name} in a later turn. Nothing was changed.`;
    return { callId: call.id, content, isError: true };
  }

  // The ids the call makes: the ones it made before, when it is made again,
  // and a Suggestion's are kept to be made again.
  const queue = [...(again?.ids ?? [])];
  const ids: string[] = [];
  const makeId = () => {
    const id = queue.shift() ?? crypto.randomUUID();
    ids.push(id);
    return id;
  };
  // A separation's Stems, and the files they added to the loaded audio.
  let separated: readonly Stem[] | undefined;
  let added: string[] = [];
  const keep = () => suggested?.push({ call, ids, change: plan.change, ...(separated && { stems: separated, added }) });

  let plan: ToolPlan;
  try {
    plan = withIds(makeId, () => planToolCall(call, project, state.contents));
  } catch (reason) {
    if (!(reason instanceof InvalidToolCall)) throw reason;
    return { callId: call.id, content: `${sentence(reason.message)} Nothing was changed.`, isError: true };
  }

  if (plan.load) {
    loaded.add(plan.load);
    return { callId: call.id, content: loadedReport(plan.load, state.smallCore), isError: false };
  }

  if (plan.decide) {
    if (!state.decide) return { callId: call.id, content: "Jev isn't set up here, so nothing can be decided with it.", isError: true };
    try {
      const decisions = await state.decide(plan.decide.state, plan.decide.questions);
      return { callId: call.id, content: describeDecisions(decisions), isError: false };
    } catch (reason) {
      return { callId: call.id, content: `Jev couldn't decide: ${reasonText(reason)} Decide yourself instead.`, isError: true };
    }
  }

  if (plan.reference && plan.listen) {
    if (!listen || !hearReference) return { callId: call.id, content: "Listening isn't available here.", isError: true };
    let reference: string;
    try {
      reference = await hearReference(plan.reference.file);
    } catch (reason) {
      return { callId: call.id, content: `The Reference Track couldn't be measured: ${reasonText(reason)}`, isError: true };
    }
    try {
      const { measurements } = await listen(project, plan.listen);
      const mix: KeptAnalysis = { id: analysisId(analyses.length + 1), ...plan.heard!, start: plan.listen.start, end: plan.listen.end, measurements };
      analyses.push(mix);
      return { callId: call.id, content: compareToReference(mix, plan.reference.name, reference), isError: false };
    } catch (reason) {
      return { callId: call.id, content: `The audio couldn't be analysed: ${reasonText(reason)}`, isError: true };
    }
  }

  if (plan.listen) {
    if (!listen) return { callId: call.id, content: "Listening isn't available here.", isError: true };
    try {
      // Audio is rendered only for a model that is sent it.
      const hears = state.hearsAudio && plan.listen.audio === true;
      const { measurements, spectrogram, audio } = await listen(project, { ...plan.listen, audio: hears });
      const id = analysisId(analyses.length + 1);
      analyses.push({ id, ...plan.heard!, start: plan.listen.start, end: plan.listen.end, measurements });
      const kept = `Its analysisId is ${id}, which compare_audio takes.`;
      const content = [plan.report, kept, plan.audioNote ?? null, measurements, truePeakNote(measurements)]
        .filter((line) => line !== null)
        .join("\n");
      const result: ToolResult = {
        callId: call.id,
        content,
        isError: false,
        ...(spectrogram !== undefined && { image: spectrogram }),
        ...(audio !== undefined && { audio: audio.data }),
      };
      return hears && audio !== undefined ? result : withoutAudio(result);
    } catch (reason) {
      return { callId: call.id, content: `The audio couldn't be analysed: ${reasonText(reason)}`, isError: true };
    }
  }

  if (plan.compare) {
    try {
      const [before, after] = chooseAnalyses(analyses, plan.compare.before, plan.compare.after);
      return { callId: call.id, content: compareAnalyses(before, after), isError: false };
    } catch (reason) {
      if (!(reason instanceof InvalidToolCall)) throw reason;
      return { callId: call.id, content: reason.message, isError: true };
    }
  }

  if (plan.save) {
    if (!library) return { callId: call.id, content: "There is no library here to save into. Nothing was saved.", isError: true };
    // A Suggestion saves when it is applied: until then, only this Request has it.
    if (suggested) {
      const id = makeId();
      if ("preset" in plan.save) {
        const { target, name, settings } = plan.save.preset;
        state.contents = { ...state.contents, userPresets: [...state.contents.userPresets, { id, name, target, settings }] };
      } else {
        const { name, pads } = plan.save.kit;
        state.contents = { ...state.contents, savedKits: [...state.contents.savedKits, { id, name, pads }] };
      }
      keep();
      if (plan.change) changes.push(plan.change);
      return { callId: call.id, content: plan.report, isError: false };
    }
    // The library refuses a name already taken rather than saving over it.
    try {
      if ("preset" in plan.save) {
        const { target, name, settings } = plan.save.preset;
        const saved = await library.savePreset(target, name, settings);
        state.contents = { ...state.contents, userPresets: [...state.contents.userPresets, saved] };
      } else {
        const saved = await library.saveKit(plan.save.kit.name, plan.save.kit.pads);
        state.contents = { ...state.contents, savedKits: [...state.contents.savedKits, saved] };
      }
    } catch (reason) {
      return { callId: call.id, content: `${sentence(reasonText(reason))} Nothing was saved.`, isError: true };
    }
    if (plan.change) changes.push(plan.change);
    return { callId: call.id, content: plan.report, isError: false };
  }

  if (plan.listSamples) {
    if (!library) return { callId: call.id, content: "The sample browser isn't available here.", isError: true };
    // A folder that can't be read is reported with the rest, not instead of them.
    const files = await Promise.all(
      plan.listSamples.folders.map((folder) =>
        library.listSamples(folder).catch((reason: unknown) => new Error(reasonText(reason))),
      ),
    );
    return { callId: call.id, content: plan.listSamples.report(files), isError: false };
  }

  if (plan.copySample) {
    if (!library) return { callId: call.id, content: "The sample browser isn't available here. Nothing was changed.", isError: true };
    let copied;
    try {
      copied = await library.copySample(plan.copySample.sample, project);
    } catch (reason) {
      return { callId: call.id, content: `${sentence(reasonText(reason))} Nothing was changed.`, isError: true };
    }
    const { audioFiles } = state.contents;
    if (!audioFiles.some(({ file }) => file === copied.file)) {
      state.contents = { ...state.contents, audioFiles: [...audioFiles, copied].toSorted((a, b) => a.file.localeCompare(b.file)) };
    }
    const { next } = plan.copySample;
    plan = withIds(makeId, () => next(copied));
  }

  if (plan.separate) {
    const { stems } = state;
    if (!stems) return { callId: call.id, content: STEMS_UNAVAILABLE, isError: true };
    const { clip, next } = plan.separate;
    const got = again?.stems ?? (await separate(state, stems, clip));
    if (typeof got === "string") return { callId: call.id, content: got, isError: true };
    const before = stems.samples();
    let placed;
    try {
      placed = withIds(makeId, () => next(got, before));
    } catch (reason) {
      if (!(reason instanceof InvalidToolCall)) throw reason;
      return { callId: call.id, content: `${sentence(reason.message)} Nothing was changed.`, isError: true };
    }
    separated = got;
    added = [...placed.samples.keys()].filter((path) => !before.has(path));
    // Before the Clips naming it are added, as for an import.
    stems.add(placed.samples);
    // Each Stem lasts as long as the stretch of the Clip it was separated from.
    const files = state.contents.audioFiles.filter(({ file }) => !placed.samples.has(file));
    const separatedFiles = [...placed.samples.keys()].map((file) => ({ file, seconds: clip.duration }));
    state.contents = {
      ...state.contents,
      audioFiles: [...files, ...separatedFiles].toSorted((a, b) => a.file.localeCompare(b.file)),
    };
    plan = placed.plan;
  }

  let commands = plan.commands;
  if (plan.loadKit) {
    if (!library) return { callId: call.id, content: "Saved Kits can't be loaded here. Nothing was changed.", isError: true };
    try {
      commands = [await library.loadKit(plan.loadKit.trackId, plan.loadKit.kit, project)];
    } catch (reason) {
      return { callId: call.id, content: `${sentence(reasonText(reason))} Nothing was changed.`, isError: true };
    }
  }

  // A command can still refuse what the tool accepted; then nothing changes.
  const result = group.execute(commands);
  if (!result.ok) {
    if (added.length > 0) state.stems?.remove(added);
    return { callId: call.id, content: `${result.error}. Nothing was changed.`, isError: true };
  }

  // A read changes nothing, so there is nothing to make again.
  if (commands.length > 0) keep();
  if (plan.change) changes.push(plan.change);
  return { callId: call.id, content: plan.report, isError: false };
}

/**
 * Separate `clip` into its Stems, showing the musician its progress and a
 * Cancel while the Request waits, or say why it wasn't.
 */
async function separate(state: RequestState, stems: AssistantStems, clip: AudioClip): Promise<readonly Stem[] | string> {
  let status;
  try {
    status = await stems.status();
  } catch (reason) {
    return `${sentence(reasonText(reason))} Nothing was changed.`;
  }
  if (status.kind === "unavailable") return STEMS_UNAVAILABLE;
  if (status.kind === "notInstalled") return STEMS_NOT_INSTALLED;
  const { onSeparation } = state;
  const controller = new AbortController();
  const { signal } = controller;
  const clipName = clipFileName(clip);
  const show = (progress: number) => onSeparation?.({ clipName, progress, cancel: () => controller.abort() });
  const cancelled = () => {
    state.cancelled = true;
    return STEMS_CANCELLED;
  };
  show(0);
  try {
    const got = await stems.separate(clip, { signal, onProgress: (progress) => signal.aborted || show(progress) });
    return !got || signal.aborted ? cancelled() : got;
  } catch (reason) {
    return signal.aborted ? cancelled() : `The Stem Separation failed: ${sentence(reasonText(reason))} Nothing was changed.`;
  } finally {
    onSeparation?.(null);
  }
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** A message as a sentence, ending in a full stop, for "Nothing was changed." to follow. */
function sentence(message: string): string {
  return message.endsWith(".") ? message : `${message}.`;
}

/** The summary of a Request, in the musician's words rather than the model's. */
export function summarise(outcome: Pick<RequestOutcome, "changes">): string {
  if (outcome.changes.length === 0) return "Nothing changed.";
  return outcome.changes.map((change) => `${change}.`).join(" ");
}
