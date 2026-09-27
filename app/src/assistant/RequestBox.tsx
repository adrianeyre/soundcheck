import { BookOpen, Check, MessageSquarePlus, RotateCcw, Settings as SettingsIcon, Sparkles, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { ProjectHistory } from "../project/history";
import type { AssistantStems } from "../stems/assistant-stems";
import {
  addUsage,
  NO_TOKENS,
  runRequest,
  summarise,
  type FinishedRequest,
  type Listen,
  type RequestOutcome,
  type RequestStatus,
  type RunningSeparation,
  type StartConversation,
  type TokenUsage,
} from "./assistant";
import { useAssistantSettings } from "./assistant-settings";
import { assistantModel, effortsFor, findModel, provider as providerOf, type ProviderId } from "./catalogue";
import { chosenConnection, contextWindowFor, requestModeFor, type Connection } from "./connection";
import type { KeyStore } from "./key-store";
import type { AssistantLibrary } from "./library";
import { conversationsFor } from "./providers";
import type { HearReference } from "./reference";
import { SKILLS, skillCommand, skillRequest, skillSuggestions, type Skill } from "./skills";
import { SkillsDialog } from "./SkillsDialog";

export interface RequestBoxProps {
  history: ProjectHistory;
  keyStore: KeyStore;
  /**
   * Told whenever a Request starts and finishes, so the page can keep the
   * Project still while the Assistant works on it.
   */
  onRunning?: (running: boolean) => void;
  /** How the requests to the model go out: the platform's fetch, or the global one. */
  fetch?: typeof fetch;
  /** How to reach the model over a provider's connection. Its SDK, through `fetch`, unless a test says otherwise. */
  conversations?: (connection: Connection, provider: ProviderId) => StartConversation;
  /** How the Assistant listens to the Project, where it can. */
  listen?: Listen;
  /** How it measures the Reference Track, where it can. */
  hearReference?: HearReference;
  /** The musician's User Presets and saved Kits, which the Assistant loads from and saves into. */
  library?: AssistantLibrary;
  /**
   * Why a Request can't start just now, such as a take being recorded into
   * the Project; null when it can.
   */
  waitFor?: string | null;
  /** Opens the Assistant's settings, where the provider and key are chosen. */
  onOpenSettings?: () => void;
  /** The Skills a Request can start with; the repo's own unless a test says otherwise. */
  skills?: readonly Skill[];
  /** How the Assistant separates an Audio Clip into Stems, where it can. */
  stems?: AssistantStems;
}

/** The tallest the list of Skills a slash opens gets, and its distance from the prompt, in pixels. */
const LIST_HEIGHT = 260;
const GAP = 4;

/** What a Request that was working on a Project that has gone is told. */
const REPLACED = "The Project was replaced while the Assistant was working, so what it did was dropped.";

/** The Conversation so far, and the Project history it is about. */
interface Transcript {
  history: ProjectHistory;
  requests: FinishedRequest[];
  /** The tokens its Requests cost, with those that failed before they got a reply. */
  usage: TokenUsage;
  /** What the latest Request cost, or null before the first. */
  last: TokenUsage | null;
  /**
   * Where the musician refreshed the context: the index of the first
   * Request after each refresh, oldest first. A Request is sent only those
   * since the latest.
   */
  refreshedAt: number[];
  /** How many tokens the latest Request's last turn held, or null before one, and since a refresh. */
  context: number | null;
}

/**
 * Where the musician types a Request, and reads what it changed.
 *
 * The provider and its API key are chosen in Settings (`AssistantSettings`)
 * and kept by the platform's key store, never in the Project. Changes apply
 * as they are made, and the whole Request undoes in one go; or, in
 * Suggestion mode (a Local model's default), they are listed with Apply and
 * Discard, and nothing changes until the musician applies them, as one
 * undo step. A new Request waits until the Suggestion is one or the other.
 *
 * Each Request follows up the ones before it in the Conversation, which the
 * box shows as a transcript until the musician starts a new one. New or Open
 * gives the page a new history, and a Conversation belongs to one history,
 * so it starts a new one too. It is kept here, never in the Project.
 *
 * A Request that starts with a Skill's slash command, such as
 * `/fix-clipping`, is sent as the Skill's instructions and what follows the
 * command. Typing a slash lists the Skills whose command matches (a
 * combobox: the arrows choose one, Enter or Tab completes it, Escape closes
 * the list), and View skills shows them one at a time.
 *
 * While a Request waits for a Stem Separation, the box shows its progress
 * and a Cancel, which fails that tool call and lets the Assistant sum up.
 *
 * While a Request runs, the box says what it is doing: waiting for the
 * model, or which tool it is using, and on which turn. Under the prompt it
 * shows the Token Usage of the latest Request and of the Conversation, so
 * the musician can see what the Assistant is costing them, and how full the
 * model's context got, as a share of its Context Window. Refresh context
 * clears it: the Requests before stay in the transcript, and in the
 * Conversation's Token Usage, but the next Request is sent none of them, as
 * a new Conversation's first isn't.
 */
export function RequestBox({
  history,
  keyStore,
  onRunning,
  fetch,
  conversations = (connection, provider) => conversationsFor(provider, connection, fetch),
  listen,
  hearReference,
  library,
  waitFor = null,
  onOpenSettings,
  skills = SKILLS,
  stems,
}: RequestBoxProps) {
  const [{ settings, loaded }] = useAssistantSettings(keyStore);
  const connection = chosenConnection(settings);
  const [request, setRequest] = useState("");
  const [running, setRunning] = useState(false);
  const [transcript, setTranscript] = useState<Transcript>(() => fresh(history));
  // A Conversation about a Project that has since been replaced is over.
  const current = transcript.history === history ? transcript : fresh(history);
  const requests = current.requests;
  const [status, setStatus] = useState<RequestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [separation, setSeparation] = useState<RunningSeparation | null>(null);
  const separating = useRef<RunningSeparation | null>(null);
  const showSeparation = (shown: RunningSeparation | null) => {
    separating.current = shown;
    setSeparation(shown);
  };
  // The suggested Skill the arrows are on, and whether Escape has closed the list until the next keystroke.
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const promptRef = useRef<HTMLInputElement>(null);
  const focusPrompt = useRef(false);
  const listId = useId();
  // The Project as it is now, to compare a finished Request against.
  const latest = useRef(history);
  useEffect(() => {
    latest.current = history;
    // New or Open drops what a Request did, so a Stem Separation it waits for is cancelled; so is one when the box goes.
    return () => separating.current?.cancel();
  }, [history, latest, separating]);
  // Undo and redo change which Requests the transcript shows as undone, and
  // applying or discarding a Suggestion what it shows of it.
  const [, historyChanged] = useReducer((count: number) => count + 1, 0);
  useEffect(() => history.subscribe(historyChanged), [history]);

  const send = async () => {
    if (!settings || !connection) return;
    const its = history;
    const asked = request;
    const command = skillCommand(asked, skills);
    const sent = command && "skill" in command ? skillRequest(command.skill, command.rest) : asked;
    const earlier = requests;
    // Only the Requests since the latest refresh are sent.
    const since = current.refreshedAt.at(-1) ?? 0;
    setRunning(true);
    onRunning?.(true);
    setError(null);
    const result = await runRequest({
      history: its,
      request: sent,
      start: conversations(connection, settings.provider),
      listen,
      hearReference,
      library,
      conversation: earlier.slice(since),
      mode: requestModeFor(settings.provider, connection),
      stems,
      onSeparation: showSeparation,
      onStatus: setStatus,
    });
    setRunning(false);
    setStatus(null);
    onRunning?.(false);
    // New or Open replaced the Project mid-Request: what the Assistant did
    // went with it, so it is not reported as though it had happened.
    if (latest.current !== its) {
      setError(REPLACED);
      return;
    }
    // A Request that neither changed anything nor had a reply, such as one
    // whose key was refused, is no part of the Conversation; what it cost still counts.
    const kept = result.changes.length > 0 || !!result.message;
    setTranscript({
      ...current,
      history: its,
      requests: kept ? [...earlier, { request: sent, typed: sent === asked ? undefined : asked, outcome: result }] : earlier,
      usage: addUsage(current.usage, result.usage),
      last: result.usage,
      // A Request dropped from the transcript still filled the model's context, but the next isn't sent it.
      context: kept ? result.context : current.context,
    });
    setError(result.error);
    if (!result.error) setRequest("");
  };

  // Nothing to refresh until a Request since the last refresh has run.
  const canRefresh = requests.length > (current.refreshedAt.at(-1) ?? 0);
  const refresh = () => {
    // A waiting Suggestion is the model's own; the refresh waits until it is applied or discarded.
    setTranscript({ ...current, refreshedAt: [...current.refreshedAt, requests.length], context: null });
  };

  const startAgain = () => {
    // A Suggestion still waiting goes with its Conversation, and its Stems' audio with it.
    pending?.discard();
    setTranscript(fresh(history));
    setError(null);
  };

  // Only the latest Request can be a Suggestion still waiting.
  const waiting = requests.at(-1)?.outcome.suggestion;
  const pending = waiting?.status === "pending" ? waiting : null;

  const applySuggestion = async () => {
    if (!pending) return;
    setRunning(true);
    onRunning?.(true);
    setError(null);
    try {
      await pending.apply();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    setRunning(false);
    onRunning?.(false);
    historyChanged();
  };

  const discardSuggestion = () => {
    pending?.discard();
    historyChanged();
  };

  const command = skillCommand(request, skills);
  const suggestions = running || pending ? [] : skillSuggestions(request, skills);
  const listed = suggestions.length > 0 && !dismissed;
  const chosen = Math.min(active, suggestions.length - 1);
  // A command no Skill has is only wrong once nothing being typed could still become one.
  const unknown = command && "unknown" in command && suggestions.length === 0 ? command.unknown : null;
  const blocked = running || !request.trim() || !!waitFor || !!pending || !!unknown;

  const type = (value: string) => {
    setRequest(value);
    setActive(0);
    setDismissed(false);
  };

  const complete = (skill: Skill) => {
    type(`/${skill.name} `);
    promptRef.current?.focus();
  };

  const onPromptKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!listed) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const by = event.key === "ArrowDown" ? 1 : -1;
      setActive((chosen + by + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      complete(suggestions[chosen]!);
    } else if (event.key === "Escape") {
      // The list closes; the Widget and any dialog around it stay as they are.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    }
  };

  // The list hangs under the prompt, or over it where there is no room below, above the page: a
  // Widget is often too short to hold it, and would clip it.
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!listed) return;
    const follow = () => {
      const at = promptRef.current?.getBoundingClientRect();
      if (!at) return;
      const below = window.innerHeight - at.bottom - GAP;
      const up = below < LIST_HEIGHT && at.top - GAP > below;
      setPlace({
        left: at.left,
        width: at.width,
        maxHeight: Math.min(LIST_HEIGHT, (up ? at.top : below) - GAP),
        ...(up ? { bottom: window.innerHeight - at.top + GAP } : { top: at.bottom + GAP }),
      });
    };
    follow();
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, [listed]);

  // A Skill used from View skills starts the Request: the prompt takes focus once the dialog has handed it back.
  useEffect(() => {
    if (skillsOpen || !focusPrompt.current) return;
    focusPrompt.current = false;
    promptRef.current?.focus();
  }, [skillsOpen]);

  const canUse = !!connection && !running && !pending;
  const described = [
    pending ? "assistant-suggestion" : waitFor && !running ? "assistant-wait" : null,
    unknown ? "assistant-unknown-skill" : command && "skill" in command ? "assistant-skill" : null,
  ].filter(Boolean);

  return (
    <section aria-labelledby="assistant-heading" className="panel">
      <div className="panel-head">
        <h2 id="assistant-heading">
          <Sparkles size={18} aria-hidden />
          Assistant
        </h2>
        {settings && connection && (
          <span className="hint">
            Using <strong>{describe(settings.provider, connection)}</strong>
          </span>
        )}
        <button type="button" className="btn-ghost btn-sm" aria-haspopup="dialog" onClick={() => setSkillsOpen(true)}>
          <BookOpen size={14} aria-hidden />
          View skills
        </button>
        {requests.length > 0 && (
          <button type="button" className="btn-ghost btn-sm" disabled={running} onClick={startAgain}>
            <MessageSquarePlus size={14} aria-hidden />
            New conversation
          </button>
        )}
      </div>
      {!loaded ? null : !connection ? (
        <div className="notice">
          <p>
            The Assistant needs a model to talk to. Choose a provider and enter its key in Settings; it stays on this
            machine.
          </p>
          {onOpenSettings && (
            <button type="button" className="btn-sm" onClick={onOpenSettings}>
              <SettingsIcon size={14} aria-hidden />
              Set up the Assistant
            </button>
          )}
        </div>
      ) : (
        <form
          className="assistant-bar"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked) void send();
          }}
        >
          <label htmlFor="assistant-request" className="visually-hidden">
            Request
          </label>
          <input
            ref={promptRef}
            id="assistant-request"
            className="prompt"
            value={request}
            disabled={running || !!pending}
            placeholder="Ask for a change, such as “add a four-on-the-floor kick”, or type / for a Skill"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listed}
            aria-controls={listed ? listId : undefined}
            aria-activedescendant={listed ? `${listId}-${chosen}` : undefined}
            aria-describedby={described.length > 0 ? described.join(" ") : undefined}
            autoComplete="off"
            onChange={(event) => type(event.target.value)}
            onKeyDown={onPromptKey}
            onBlur={() => setDismissed(true)}
          />
          <button type="submit" className="btn-primary" disabled={blocked} aria-busy={running}>
            <Sparkles size={16} aria-hidden />
            {running ? "Working…" : "Send"}
          </button>
          {listed &&
            createPortal(
              <ul id={listId} role="listbox" aria-label="Skills" className="skill-suggestions" style={place ?? undefined}>
                {suggestions.map((skill, index) => (
                  <li
                    key={skill.name}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === chosen}
                    className="skill-option"
                    // The prompt keeps focus, so typing carries on after a click.
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => complete(skill)}
                  >
                    <code className="skill-command">/{skill.name}</code>
                    <span className="skill-option-text">{skill.description}</span>
                  </li>
                ))}
              </ul>,
              document.body,
            )}
          {unknown ? (
            <p id="assistant-unknown-skill" className="hint skill-line">
              There&apos;s no Skill called <code>/{unknown}</code>. View skills lists them.
            </p>
          ) : (
            command &&
            "skill" in command && (
              <p id="assistant-skill" className="hint skill-line">
                Using the Skill <strong>{command.skill.title}</strong>
                {command.skill.argumentHint && `: add ${command.skill.argumentHint} after the command, or send it as it is.`}
              </p>
            )
          )}
          {running && status && (
            <p role="status" aria-label="What the Assistant is doing" className="hint assistant-status">
              {doing(status)}
            </p>
          )}
          {current.last && (
            <p aria-label="Token usage" className="hint assistant-usage">
              Last Request: {tokens(current.last)} · This Conversation: {tokens(current.usage)}
            </p>
          )}
          {settings && connection && (running ? status && status.context > 0 : canRefresh || current.refreshedAt.length > 0) && (
            <div className="assistant-context">
              <ContextMeter
                used={running ? (status?.context ?? 0) : current.context}
                window={contextWindowFor(settings.provider, connection)}
              />
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={running || !!pending || !canRefresh}
                aria-describedby="assistant-refresh-help"
                onClick={refresh}
              >
                <RotateCcw size={14} aria-hidden />
                Refresh context
              </button>
              <span id="assistant-refresh-help" className="visually-hidden">
                The next Request starts afresh, without the ones before it. They stay in the transcript.
              </span>
            </div>
          )}
        </form>
      )}
      <SkillsDialog
        open={skillsOpen}
        onClose={() => setSkillsOpen(false)}
        skills={skills}
        onUse={
          canUse
            ? (skill) => {
                type(`/${skill.name} `);
                focusPrompt.current = true;
                setSkillsOpen(false);
              }
            : undefined
        }
      />
      {separation && (
        <div className="notice stem-separation mt-3" role="group" aria-label="Stem Separation">
          <span>Separating {separation.clipName} into Stems…</span>
          <progress aria-label="Stem Separation progress" value={separation.progress} max={1} />
          <button type="button" onClick={separation.cancel}>
            <X size={16} aria-hidden />
            Cancel Stem Separation
          </button>
        </div>
      )}
      <div aria-live="polite" className={requests.length > 0 || waitFor ? "stack mt-3" : "stack"}>
        {waitFor && !running && (
          <p id="assistant-wait" className="hint">
            {waitFor}
          </p>
        )}
        {requests.length > 0 && (
          <ol aria-label="Conversation" className="transcript">
            {requests.map(({ request: sent, typed, outcome }, index) => (
              // A Request is never edited or removed on its own, so its place is its key.
              <li key={index} className="stack">
                {current.refreshedAt.includes(index) && (
                  <p role="separator" className="hint context-refreshed">
                    Context refreshed: the Assistant started afresh from here.
                  </p>
                )}
                <p aria-label="What you asked">
                  <strong>{typed ?? sent}</strong>
                  {mark(outcome) && <span className="hint"> ({mark(outcome)})</span>}
                </p>
                <ChangesOf outcome={outcome} />
                {outcome.message && (
                  <p aria-label="What the Assistant said" className="muted">
                    {outcome.message}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
        {pending && (
          <div className="row">
            <p id="assistant-suggestion" className="hint">
              Nothing has changed yet: apply the Suggestion, as one undo step, or discard it.
            </p>
            <button type="button" className="btn-primary btn-sm" disabled={running || !!waitFor} onClick={() => void applySuggestion()}>
              <Check size={14} aria-hidden />
              Apply
            </button>
            <button type="button" className="btn-ghost btn-sm" disabled={running} onClick={discardSuggestion}>
              <X size={14} aria-hidden />
              Discard
            </button>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="alert mt-3">
          {error}
        </p>
      )}
    </section>
  );
}

/** A Conversation about `history` with no Requests yet. */
function fresh(history: ProjectHistory): Transcript {
  return { history, requests: [], usage: NO_TOKENS, last: null, refreshedAt: [], context: null };
}

/**
 * How full the model's context got on the latest turn, as a share of its
 * Context Window; since a refresh, that it is empty.
 */
function ContextMeter({ used, window }: { used: number | null; window: number }) {
  if (used === null) {
    return (
      <span aria-label="Context used" className="hint">
        Context refreshed: the next Request starts afresh.
      </span>
    );
  }
  const share = Math.min(used / window, 1);
  return (
    <span aria-label="Context used" className="hint context-meter" data-full={share >= 0.8}>
      <meter min={0} max={1} low={0.5} high={0.8} optimum={0} value={share} aria-hidden />
      {contextUsed(used, window)}
    </span>
  );
}

/** How full the context is, in words: a percent, at least 1 once anything is in it. */
export function contextUsed(used: number, window: number): string {
  const percent = used === 0 ? 0 : Math.max(1, Math.round((used / window) * 100));
  return `Context: ${Math.min(percent, 100)}% used (${grouped(used)} of ${grouped(window)} tokens)`;
}

/** What a running Request is doing, in words, with what it has cost so far. */
export function doing({ turn, doing: now, usage }: RequestStatus): string {
  const what = now.kind === "thinking" ? "waiting for the model" : `using ${now.name.replaceAll("_", " ")}`;
  const spent = usage.input + usage.output > 0 ? ` (${grouped(usage.input + usage.output)} tokens so far)` : "";
  return `Turn ${turn}: ${what}…${spent}`;
}

/** A Token Usage, as the musician reads it. */
export function tokens({ input, output }: TokenUsage): string {
  return `${grouped(input + output)} tokens (${grouped(input)} in, ${grouped(output)} out)`;
}

function grouped(n: number): string {
  return n.toLocaleString("en-GB");
}

/** What the transcript says has happened to a Request since, if anything. */
function mark({ suggestion, undone }: RequestOutcome): string | null {
  if (suggestion?.status === "pending") return "suggested";
  if (suggestion?.status === "discarded") return "discarded";
  return undone() ? "undone" : null;
}

/**
 * What a Request changed: for a Suggestion, what it would change until it
 * is applied, and then what applying it changed, and what it couldn't.
 */
function ChangesOf({ outcome }: { outcome: RequestOutcome }) {
  const applied = outcome.suggestion?.applied;
  if (!applied) return <p aria-label="What changed">{summarise(outcome)}</p>;
  return (
    <>
      <p aria-label="What changed">{summarise(applied)}</p>
      {applied.failed.length > 0 && (
        <div role="note" aria-label="What couldn't be applied" className="alert">
          <p>
            {applied.reworked ? "The Project had changed since the Suggestion, and some" : "Some"} of its changes no longer
            apply:
          </p>
          <ul>
            {applied.failed.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** The line beside the Assistant heading: provider, model, version and effort. */
export function describe(provider: ProviderId, connection: Connection): string {
  const model = assistantModel(provider, connection.model);
  const found = findModel(provider, model);
  const name = `${providerOf(provider).name} ${found ? `${found.family.name} ${found.version.name}` : model}`;
  const effort = connection.effort && effortsFor(provider, model).includes(connection.effort) ? connection.effort : null;
  return `${name}, ${effort ?? "default"} effort`;
}
