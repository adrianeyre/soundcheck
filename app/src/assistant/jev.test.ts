import { expect, test } from "vitest";

import { createProject } from "../project/model";
import { ProjectHistory } from "../project/history";
import { runRequest, type ModelReply, type RequestMode, type StartConversation } from "./assistant";
import { systemPrompt } from "./context";
import { describeDecisions, jevDecide, JevError, readDecisions, type Decide, type Question } from "./jev";
import { toolDefinitions } from "./tools";

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Jev's HTTP, replaced by a stub: every reply scripted with its status, every request kept. */
function stubbed(...replies: { status?: number; body: unknown }[]) {
  const sent: Sent[] = [];
  let turn = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[turn++];
    if (!reply) throw new Error("Jev was asked more often than the script has replies");
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, body: (await request.json()) as Record<string, unknown> });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

const QUESTIONS: Record<string, Question> = {
  groove: { kind: "choice", instructions: "Which drum pattern suits the chorus?", options: { four: "Four on the floor", half: "Half-time", broken: null } },
  energy: { kind: "score", instructions: "How energetic is the brief?", levels: ["Calm", "Lively", "Frantic"] },
  swing: { kind: "noul", instructions: "Should the hats swing?" },
};

const ANSWERED = {
  model: "jev-1.13.0",
  answers: {
    groove: { type: "choice", choice: "four", confidence: 0.8, probabilities: { four: 0.9, half: 0.08, broken: 0.02 } },
    energy: { type: "score", score: 1.2, confidence: 0.7, legend: { 0: "Calm", 1: "Lively", 2: "Frantic" }, probabilities: { 0: 0, 1: 0.8, 2: 0.2 } },
    swing: { type: "noul", noul: 0.3 },
  },
  usage: { input_tokens: 120, output_tokens: 20 },
};

const noWait = () => Promise.resolve();

test("every question goes to TypeSafe in one call, typed as its API takes them, with the musician's key", async () => {
  const { fetch, sent } = stubbed({ body: ANSWERED });
  const decisions = await jevDecide({ apiKey: "ts-key" }, fetch, noWait)({ song_key: "C major" }, QUESTIONS);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(sent[0]!.headers.get("authorization")).toBe("Bearer ts-key");
  expect(sent[0]!.body).toEqual({
    model: "jev-latest",
    state: { song_key: "C major" },
    questions: {
      groove: { type: "choice", instructions: "Which drum pattern suits the chorus?", criteria: { four: "Four on the floor", half: "Half-time", broken: null } },
      energy: { type: "score", instructions: "How energetic is the brief?", criteria: ["Calm", "Lively", "Frantic"] },
      swing: { type: "noul", instructions: "Should the hats swing?" },
    },
  });
  expect(decisions).toEqual({
    model: "jev-1.13.0",
    answers: {
      groove: { kind: "choice", choice: "four", confidence: 0.8, probabilities: { four: 0.9, half: 0.08, broken: 0.02 } },
      energy: { kind: "score", score: 1.2, confidence: 0.7, levels: ["Calm", "Lively", "Frantic"], probabilities: [0, 0.8, 0.2] },
      swing: { kind: "noul", yes: 0.3 },
    },
    usage: { input: 120, output: 20 },
  });
});

test("a gateway and a pinned model are used where the musician set them", async () => {
  const { fetch, sent } = stubbed({ body: ANSWERED });
  await jevDecide({ apiKey: "k", baseUrl: "https://gateway.example.com/typesafe/", model: "jev-1.13.0" }, fetch, noWait)("x", QUESTIONS);
  expect(sent[0]!.url).toBe("https://gateway.example.com/typesafe/v1/systemone");
  expect(sent[0]!.body.model).toBe("jev-1.13.0");
});

test("a rate limit is tried again after a wait; a refused key is not", async () => {
  const waits: number[] = [];
  const wait = (ms: number) => (waits.push(ms), Promise.resolve());
  const limited = stubbed({ status: 429, body: {} }, { status: 529, body: {} }, { body: ANSWERED });
  await expect(jevDecide({ apiKey: "k" }, limited.fetch, wait)("x", QUESTIONS)).resolves.toMatchObject({ model: "jev-1.13.0" });
  expect(waits).toEqual([400, 800]);

  const refused = stubbed({ status: 401, body: { detail: "bad key" } });
  await expect(jevDecide({ apiKey: "k" }, refused.fetch, wait)("x", QUESTIONS)).rejects.toThrow(/refused the API key/);
  expect(refused.sent).toHaveLength(1);
});

test("an answer is checked, not trusted: an option it wasn't given is refused", () => {
  const wrong = { answers: { groove: { type: "choice", choice: "polka", probabilities: {}, confidence: 1 } } };
  expect(() => readDecisions(wrong, { groove: QUESTIONS.groove! })).toThrow(JevError);
  expect(() => readDecisions({}, { swing: QUESTIONS.swing! })).toThrow(/didn't answer question swing/);
});

test("a question over the API's limits isn't sent", async () => {
  const { fetch, sent } = stubbed({ body: ANSWERED });
  const one = { kind: "choice", instructions: "Pick", options: { only: null } } as const;
  await expect(jevDecide({ apiKey: "k" }, fetch, noWait)("x", { one })).rejects.toThrow(/at least two options/);
  expect(sent).toEqual([]);
});

test("the Assistant reads the answers as words: each pick with its probabilities and confidence", () => {
  const text = describeDecisions(readDecisions(ANSWERED, QUESTIONS));
  expect(text).toContain("Jev (jev-1.13.0) answered:");
  expect(text).toContain("groove: four (confidence 80%; four 90%, half 8%, broken 2%)");
  expect(text).toContain("energy: 1.20 of 0 to 2, nearest “Lively”");
  expect(text).toContain("swing: 30% likely yes");
});

/** A model that calls `decide`, then sums up; what it was offered and told is kept. */
function decidingModel(calls: unknown) {
  const offered: string[][] = [];
  const told: string[] = [];
  const modes: RequestMode[] = [];
  const start: StartConversation = (_request, _project, _library, _soFar, mode) => {
    modes.push(mode!);
    let turn = 0;
    return {
      next(results, _turnsLeft, tools) {
        offered.push(tools.map((tool) => tool.name));
        told.push(...results.map((result) => result.content));
        const replies: ModelReply[] = [{ text: "", toolCalls: [{ id: "d1", name: "decide", input: calls }] }, { text: "Done.", toolCalls: [] }];
        return Promise.resolve(replies[turn++]!);
      },
    };
  };
  return { start, offered, told, modes };
}

const CALL = {
  state: "An upbeat house track in A minor; the musician wants a chorus groove.",
  questions: [
    { id: "groove", kind: "choice", question: "Which drum pattern suits the chorus?", options: { four: "Four on the floor", half: "Half-time" } },
    { id: "swing", kind: "yes_no", question: "Should the hats swing?" },
  ],
};

test("with Jev set up, the Assistant is offered decide and told of it, and its answers go back to the model", async () => {
  const asked: Parameters<Decide>[] = [];
  const decide: Decide = (state, questions) => {
    asked.push([state, questions]);
    return Promise.resolve({
      model: "jev-1.13.0",
      answers: { groove: { kind: "choice", choice: "four", probabilities: { four: 0.7, half: 0.3 }, confidence: 0.6 }, swing: { kind: "noul", yes: 0.9 } },
      usage: { input: 1, output: 1 },
    });
  };
  const model = decidingModel(CALL);
  const outcome = await runRequest({ history: new ProjectHistory(createProject()), request: "program a chorus groove", start: model.start, decide });

  expect(outcome.error).toBeNull();
  expect(model.modes[0]!.decides).toBe(true);
  expect(systemPrompt(model.modes[0]!)).toContain("You can also ask Jev");
  expect(model.offered[0]).toContain("decide");
  expect(asked).toEqual([
    [
      CALL.state,
      {
        groove: { kind: "choice", instructions: "Which drum pattern suits the chorus?", options: { four: "Four on the floor", half: "Half-time" } },
        swing: { kind: "noul", instructions: "Should the hats swing?" },
      },
    ],
  ]);
  expect(model.told[0]).toContain("groove: four (confidence 60%; four 70%, half 30%)");
  expect(model.told[0]).toContain("swing: 90% likely yes");
  // Deciding changes nothing, so the Request is no undo step's worth of changes.
  expect(outcome.changes).toEqual([]);
});

test("without Jev, decide is neither offered nor mentioned, and a call to it is refused", async () => {
  const model = decidingModel(CALL);
  await runRequest({ history: new ProjectHistory(createProject()), request: "program a groove", start: model.start });

  expect(model.modes[0]!.decides).toBe(false);
  expect(systemPrompt(model.modes[0]!)).not.toContain("ask Jev");
  expect(model.offered[0]).not.toContain("decide");
  expect(toolDefinitions([]).map((tool) => tool.name)).not.toContain("decide");
  expect(model.told[0]).toMatch(/Jev isn't set up here/);
});

test("a malformed question is refused before Jev is asked", async () => {
  let asked = 0;
  const decide: Decide = () => {
    asked++;
    return Promise.reject(new Error("unreachable"));
  };
  const model = decidingModel({ state: "x", questions: [{ id: "a", kind: "choice", question: "Pick one" }] });
  await runRequest({ history: new ProjectHistory(createProject()), request: "go", start: model.start, decide });
  expect(asked).toBe(0);
  expect(model.told[0]).toMatch(/is a choice, so it needs options/);
});

/** Jev, overloaded. */
const overloaded: Decide = () => Promise.reject(new JevError("Jev is overloaded just now: try again in a moment."));

test("when Jev fails, the model is told to decide itself", async () => {
  const decide = overloaded;
  const model = decidingModel(CALL);
  await runRequest({ history: new ProjectHistory(createProject()), request: "go", start: model.start, decide });
  expect(model.told[0]).toBe("Jev couldn't decide: Jev is overloaded just now: try again in a moment. Decide yourself instead.");
});
