/**
 * The Decision Engine: TypeSafe's Jev, a model that answers only the
 * questions it is asked, each by picking one of the options given it
 * (Choice), a level of a rubric (Score) or yes or no (Noul), with a
 * probability for every answer. It can't chat or call tools, so it is never
 * a Provider: the Assistant asks it for quick bounded musical choices
 * (`decide`), and the Chords Widget for the next chord of a progression.
 * Code keeps control: it chooses the options, and turns a pick into notes.
 *
 * It is reached over `POST /v1/systemone` with the musician's own TypeSafe
 * key, or through a gateway at another base URL, and through the
 * platform's fetch, as the Providers are. Its key is kept with theirs in
 * the platform's key store, never in a Project.
 */

/** The musician's Jev connection. */
export interface JevConnection {
  apiKey: string;
  /** Where to send requests instead of TypeSafe's own API, such as a gateway. */
  baseUrl?: string;
  /** Unset means `jev-latest`, the latest stable release. */
  model?: string;
}

export const JEV_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";

/** The models the settings offer; any versioned id, such as `jev-1.13.0`, is accepted too. */
export const JEV_MODELS = [
  { id: "jev-latest", name: "Jev latest (stable)" },
  { id: "jev-preview", name: "Jev preview" },
  { id: "jev-1.13.0", name: "Jev 1.13.0 (pinned)" },
] as const;

/** At most this many options per Choice, as the API allows. */
export const MAX_OPTIONS = 255;
/** At most this many levels per Score, as the API allows, and at least two. */
export const MAX_LEVELS = 10;
/** At most this many questions in one call from the Assistant, to keep the request small. */
export const MAX_QUESTIONS = 32;

/** One question, as the app asks it. */
export type Question =
  | { kind: "choice"; instructions: string; options: Record<string, string | null> }
  | { kind: "score"; instructions: string; levels: string[] }
  | { kind: "noul"; instructions: string; yes?: string; no?: string };

/** One answer, as the app reads it. */
export type Answer =
  | { kind: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { kind: "score"; score: number; levels: string[]; probabilities: number[]; confidence: number }
  | { kind: "noul"; yes: number };

/** What one call answered. */
export interface Decisions {
  /** The versioned model that answered, such as `jev-1.13.0`. */
  model: string;
  answers: Record<string, Answer>;
  usage: { input: number; output: number };
}

/** Asks the Decision Engine `questions` about `state`, all at once. */
export type Decide = (state: unknown, questions: Record<string, Question>) => Promise<Decisions>;

/** Why a call to Jev failed, in words the musician or the Assistant can act on. */
export class JevError extends Error {}

/** What is wrong with a Jev connection the musician entered, or null when nothing is. */
export function checkJevConnection(connection: JevConnection): string | null {
  if (!connection.apiKey.trim()) return "Enter your TypeSafe API key.";
  const baseUrl = connection.baseUrl?.trim();
  if (baseUrl && !/^https?:\/\/[^/\s]+/.test(baseUrl)) return "The base URL must start with https:// or http://.";
  return null;
}

/** The request body for `questions` about `state`, as the API takes it. */
export function jevRequestBody(model: string, state: unknown, questions: Record<string, Question>): unknown {
  return {
    model,
    state,
    questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, wire(question)])),
  };
}

function wire(question: Question): unknown {
  switch (question.kind) {
    case "choice":
      return { type: "choice", instructions: question.instructions, criteria: question.options };
    case "score":
      return { type: "score", instructions: question.instructions, criteria: question.levels };
    case "noul":
      return {
        type: "noul",
        instructions: question.instructions,
        ...((question.yes || question.no) && {
          criteria: { ...(question.yes && { true: question.yes }), ...(question.no && { false: question.no }) },
        }),
      };
  }
}

/** Checks `question` against the API's limits; throws `JevError` saying what is wrong. */
export function checkQuestion(id: string, question: Question): void {
  if (!question.instructions.trim()) throw new JevError(`Question ${id} has no instructions.`);
  if (question.kind === "choice") {
    const options = Object.keys(question.options).length;
    if (options < 2) throw new JevError(`Question ${id} needs at least two options.`);
    if (options > MAX_OPTIONS) throw new JevError(`Question ${id} has ${options} options; Jev takes at most ${MAX_OPTIONS}.`);
  }
  if (question.kind === "score" && (question.levels.length < 2 || question.levels.length > MAX_LEVELS)) {
    throw new JevError(`Question ${id} needs from 2 to ${MAX_LEVELS} levels.`);
  }
}

/** Reads the API's response, which is checked field by field rather than trusted. */
export function readDecisions(body: unknown, questions: Record<string, Question>): Decisions {
  const parsed = record(body);
  const answers = record(parsed.answers);
  const usage = record(parsed.usage);
  const read: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = record(answers[id]);
    if (answer.type !== question.kind) throw new JevError(`Jev didn't answer question ${id}.`);
    read[id] = readAnswer(id, question, answer);
  }
  return {
    model: typeof parsed.model === "string" ? parsed.model : "jev",
    answers: read,
    usage: { input: count(usage.input_tokens), output: count(usage.output_tokens) },
  };
}

function readAnswer(id: string, question: Question, answer: Record<string, unknown>): Answer {
  const probabilities = record(answer.probabilities);
  switch (question.kind) {
    case "choice": {
      const options = Object.keys(question.options);
      if (typeof answer.choice !== "string" || !options.includes(answer.choice)) {
        throw new JevError(`Jev answered question ${id} with an option it wasn't given.`);
      }
      return {
        kind: "choice",
        choice: answer.choice,
        probabilities: Object.fromEntries(options.map((option) => [option, share(probabilities[option])])),
        confidence: share(answer.confidence),
      };
    }
    case "score":
      if (typeof answer.score !== "number") throw new JevError(`Jev didn't score question ${id}.`);
      return {
        kind: "score",
        score: answer.score,
        levels: question.levels,
        probabilities: question.levels.map((_, level) => share(probabilities[String(level)])),
        confidence: share(answer.confidence),
      };
    case "noul":
      if (typeof answer.noul !== "number") throw new JevError(`Jev didn't answer question ${id}.`);
      return { kind: "noul", yes: share(answer.noul) };
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function share(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/** What a failed response means, by its status, as TypeSafe documents them. */
function failure(status: number, detail: string): JevError {
  const why =
    status === 401
      ? "TypeSafe refused the API key: check it in Settings → Assistant → Jev."
      : status === 422
        ? `TypeSafe couldn't read the question${detail ? `: ${detail}` : "."}`
        : status === 429
          ? "Jev's rate limit was reached: try again in a moment."
          : status === 529
            ? "Jev is overloaded just now: try again in a moment."
            : `Jev failed with status ${status}${detail ? `: ${detail}` : "."}`;
  return new JevError(why);
}

/** How many times a rate-limited or overloaded call is tried again, and the first wait, in ms. */
const RETRIES = 2;
const BACKOFF_MS = 400;

/**
 * Asking Jev over `connection`, through `fetch`: every question in one
 * call, as the API answers them in parallel. A 429 or 529 is tried again
 * after a short wait, as TypeSafe's SDKs do.
 */
export function jevDecide(
  connection: JevConnection,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Decide {
  const url = `${(connection.baseUrl?.trim() || JEV_BASE_URL).replace(/\/+$/, "")}/v1/systemone`;
  const model = connection.model?.trim() || JEV_DEFAULT_MODEL;
  return async (state, questions) => {
    for (const [id, question] of Object.entries(questions)) checkQuestion(id, question);
    const body = JSON.stringify(jevRequestBody(model, state, questions));
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${connection.apiKey.trim()}`, "Content-Type": "application/json" },
          body,
        });
      } catch (reason) {
        throw new JevError(`Jev couldn't be reached: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
      if (response.ok) return readDecisions(await response.json(), questions);
      if ((response.status === 429 || response.status === 529) && attempt < RETRIES) {
        await wait(BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw failure(response.status, (await response.text().catch(() => "")).slice(0, 300));
    }
  };
}

/** The option with the highest probability first, as the Assistant and the musician read them. */
export function ranked(answer: Extract<Answer, { kind: "choice" }>): [string, number][] {
  return Object.entries(answer.probabilities).toSorted(([, a], [, b]) => b - a);
}

/** Answers, in words, for the Assistant: each question's pick, its probabilities and confidence. */
export function describeDecisions(decisions: Decisions): string {
  const lines = Object.entries(decisions.answers).map(([id, answer]) => {
    switch (answer.kind) {
      case "choice":
        return `${id}: ${answer.choice} (confidence ${percent(answer.confidence)}; ${ranked(answer)
          .slice(0, 5)
          .map(([option, p]) => `${option} ${percent(p)}`)
          .join(", ")})`;
      case "score": {
        const level = Math.round(answer.score);
        return `${id}: ${answer.score.toFixed(2)} of 0 to ${answer.levels.length - 1}, nearest “${answer.levels[level]}” (confidence ${percent(answer.confidence)})`;
      }
      case "noul":
        return `${id}: ${percent(answer.yes)} likely yes`;
    }
  });
  return [`Jev (${decisions.model}) answered:`, ...lines].join("\n");
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
