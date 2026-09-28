/**
 * The providers the Assistant can talk to, and the models each offers.
 *
 * Every provider's catalogue has the same shape: families (the Model
 * picker), each with its versions (the Version picker), each version with
 * the effort levels it takes. The provider's own default comes first, and a
 * family's default version first within it. The lists are the current model
 * ids from each provider's documentation, September 2026:
 *
 * - Claude: platform.claude.com/docs/en/about-claude/models/overview, and
 *   the effort levels per model from /docs/en/build-with-claude/effort.
 * - OpenAI: developers.openai.com/api/docs/models.
 * - Gemini: ai.google.dev/gemini-api/docs/models, and the thinking levels
 *   per model from /gemini-api/docs/thinking.
 * - Grok: docs.x.ai/docs/models, and the reasoning efforts per model from
 *   /docs/guides/reasoning (Grok 4.5 takes up to `high`; an `xhigh` sent it
 *   is treated as `high`, so it isn't offered).
 * - Meta AI: dev.meta.ai/docs/models, the Muse Spark models of Meta's Model
 *   API, and the reasoning efforts from /docs/reasoning (`minimal` to
 *   `xhigh`, and `max` on Muse Spark 1.3 only; reasoning can't be turned
 *   off, so there is no `none`). The -contributor versions, which let Meta
 *   train on what they are sent, are left out.
 * - Local: ollama.com/library, the tool-capable tags of its Llama, Qwen,
 *   Mistral and Gemma families.
 *
 * Each version's capabilities are from the same docs, September 2026:
 *
 * - Claude: every current model takes text and images and uses tools
 *   (/docs/en/about-claude/models/overview, and each model's page), with
 *   several calls a turn on by default
 *   (/docs/en/agents-and-tools/tool-use/parallel-tool-use). None takes audio.
 * - OpenAI: each model's page at developers.openai.com/api/docs/models/<id>
 *   gives image input, no audio, and function calling, and
 *   /api/docs/guides/function-calling several calls a turn.
 * - Gemini: each model's page at ai.google.dev/gemini-api/docs/models/<id>
 *   gives text, image, video, audio and PDF input and function calling, and
 *   /gemini-api/docs/function-calling parallel function calling.
 * - Grok: each model's page at docs.x.ai/docs/models/<id> gives text and
 *   image input and function calling, and /docs/guides/function-calling
 *   several calls a turn, on by default. None takes audio.
 * - Meta AI: dev.meta.ai/docs/models gives every Muse Spark model text,
 *   image, video, audio and PDF input and tool calling, with parallel tool
 *   calls. 1.3's audio is "not fully supported", and Meta suggests 1.2 for
 *   audio, so 1.2 and 1.1 hear audio and 1.3 doesn't.
 * - Local: every tag above is marked "tools" by ollama.com/library, so each
 *   uses tools. Whether it sees images or hears audio depends on how it is
 *   run (llama.cpp's server sees images only with the model's projector
 *   loaded), and Ollama doesn't say which models make several calls a turn,
 *   so each starts with none of those, and the musician turns on what their
 *   server does. Ollama marks llama4, qwen3.6, mistral-small3.2, ministral-3
 *   and gemma4 "vision", and gemma4 "audio".
 */

export type ProviderId = "claude" | "openai" | "gemini" | "grok" | "meta" | "local";

export interface ModelVersion {
  /** What the Version picker shows, such as "5.5". */
  name: string;
  /** What the provider's API calls it. */
  id: string;
  /** The effort levels it takes, lowest first; none means it has no setting. */
  efforts: readonly string[];
  /** What it can do, from its provider's documentation. */
  capabilities: Capabilities;
  /**
   * How many tokens a turn can hold, what it is sent and what it writes
   * back together; unset where the server decides (Local).
   */
  contextWindow?: number;
}

/**
 * What a model can do, as its provider documents it. Code that uses one of
 * these asks here, never which provider it is talking to.
 */
export interface Capabilities {
  /** It can call tools. The Assistant does everything with tools, so a model without can't be it. */
  toolUse: boolean;
  /** It can see an image, such as `analyse_audio`'s spectrogram. */
  imageInput: boolean;
  /** It can hear audio sent to it. */
  audioInput: boolean;
  /** It can make several tool calls in one reply. */
  parallelToolCalls: boolean;
}

/** The capabilities a musician can change, for a provider whose models vary by how they are run. */
export type AdjustableCapability = Exclude<keyof Capabilities, "toolUse">;
export const ADJUSTABLE_CAPABILITIES: readonly AdjustableCapability[] = ["imageInput", "audioInput", "parallelToolCalls"];

export interface ModelFamily {
  /** What the Model picker shows, such as "Opus". */
  name: string;
  versions: readonly ModelVersion[];
}

export interface Provider {
  id: ProviderId;
  name: string;
  /** Local needs none. */
  needsKey: boolean;
  /** Where requests go when no base URL is set, as the Base URL field suggests it. */
  baseUrl: string;
  families: readonly ModelFamily[];
  /**
   * The musician can change its models' capabilities, since the same model
   * can be run with or without them; what the catalogue declares is where
   * they start.
   */
  adjustableCapabilities: boolean;
  /**
   * Its models are often small, and less reliable at structured edits, so a
   * Request starts with the smaller core and makes a Suggestion unless the
   * musician turns either off.
   */
  smallModels: boolean;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Opus 4.6 and Sonnet 4.6 take `max` but not `xhigh`. */
const CLAUDE_EFFORTS_4_6 = ["low", "medium", "high", "max"] as const;
const OPENAI_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Context windows, from the same docs, September 2026: every Claude model
 * here but Haiku 4.5 has 1M tokens, and it 200k
 * (/docs/en/build-with-claude/context-windows); each GPT-6 1,050,000
 * (developers.openai.com/api/docs/models); each Gemini model's page gives
 * an input limit of 1,048,576; each Grok model's page 500,000 for Grok 4.7,
 * 4.6 and 4.5, and 1,000,000 for Grok 4.3; each Muse Spark model 1,048,576
 * (dev.meta.ai/docs/models). A local model's is set on its server:
 * Ollama gives 4k under 24 GiB of VRAM (docs.ollama.com/context-length).
 */
const CLAUDE_CONTEXT = 1_000_000;
const OPENAI_CONTEXT = 1_050_000;
const GEMINI_CONTEXT = 1_048_576;
export const LOCAL_CONTEXT = 4_096;

const CLAUDE_CAPABILITIES: Capabilities = { toolUse: true, imageInput: true, audioInput: false, parallelToolCalls: true };
const OPENAI_CAPABILITIES: Capabilities = { toolUse: true, imageInput: true, audioInput: false, parallelToolCalls: true };
const GEMINI_CAPABILITIES: Capabilities = { toolUse: true, imageInput: true, audioInput: true, parallelToolCalls: true };
const GROK_CAPABILITIES: Capabilities = { toolUse: true, imageInput: true, audioInput: false, parallelToolCalls: true };
const META_CAPABILITIES: Capabilities = { toolUse: true, imageInput: true, audioInput: false, parallelToolCalls: true };
const META_CONTEXT = 1_048_576;
const META_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
/** Where a local model starts, whatever it can do when run another way: see above. */
const LOCAL_CAPABILITIES: Capabilities = { toolUse: true, imageInput: false, audioInput: false, parallelToolCalls: false };

function claude(name: string, id: string, efforts: readonly string[] = CLAUDE_EFFORTS, contextWindow = CLAUDE_CONTEXT): ModelVersion {
  return { name, id, efforts, capabilities: CLAUDE_CAPABILITIES, contextWindow };
}

function openai(id: string, efforts: readonly string[]): ModelVersion {
  return { name: "6", id, efforts, capabilities: OPENAI_CAPABILITIES, contextWindow: OPENAI_CONTEXT };
}

function gemini(name: string, id: string, efforts: readonly string[]): ModelVersion {
  return { name, id, efforts, capabilities: GEMINI_CAPABILITIES, contextWindow: GEMINI_CONTEXT };
}

function grok(name: string, efforts: readonly string[], contextWindow: number): ModelVersion {
  return { name, id: `grok-${name}`, efforts, capabilities: GROK_CAPABILITIES, contextWindow };
}

function muse(name: string, efforts: readonly string[] = META_EFFORTS, hears = true): ModelVersion {
  return { name, id: `muse-spark-${name}`, efforts, capabilities: { ...META_CAPABILITIES, audioInput: hears }, contextWindow: META_CONTEXT };
}

/** Ollama names a model `family:tag`, and the tag is the version. */
function ollama(id: string): ModelVersion {
  return { name: id, id, efforts: [], capabilities: LOCAL_CAPABILITIES };
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: "claude",
    name: "Claude",
    needsKey: true,
    baseUrl: "https://api.anthropic.com",
    adjustableCapabilities: false,
    smallModels: false,
    families: [
      {
        name: "Opus",
        versions: [
          claude("5.5", "claude-opus-5-5"),
          claude("5", "claude-opus-5"),
          claude("4.8", "claude-opus-4-8"),
          claude("4.7", "claude-opus-4-7"),
          claude("4.6", "claude-opus-4-6", CLAUDE_EFFORTS_4_6),
        ],
      },
      {
        name: "Sonnet",
        versions: [claude("5", "claude-sonnet-5"), claude("4.6", "claude-sonnet-4-6", CLAUDE_EFFORTS_4_6)],
      },
      { name: "Haiku", versions: [claude("4.5", "claude-haiku-4-5", [], 200_000)] },
      { name: "Fable", versions: [claude("5.1", "claude-fable-5-1"), claude("5", "claude-fable-5")] },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    needsKey: true,
    baseUrl: "https://api.openai.com/v1",
    adjustableCapabilities: false,
    smallModels: false,
    families: [
      { name: "GPT-6 Astra", versions: [openai("gpt-6-astra", OPENAI_EFFORTS.slice(1))] },
      { name: "GPT-6 Sol", versions: [openai("gpt-6-sol", OPENAI_EFFORTS)] },
      { name: "GPT-6 Luna", versions: [openai("gpt-6-luna", OPENAI_EFFORTS)] },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    needsKey: true,
    baseUrl: "https://generativelanguage.googleapis.com",
    adjustableCapabilities: false,
    smallModels: false,
    families: [
      {
        name: "Flash",
        versions: [
          gemini("3.8", "gemini-3.8-flash", ["low", "medium", "high"]),
          gemini("3.7", "gemini-3.7-flash", ["low", "medium", "high"]),
          gemini("3.6", "gemini-3.6-flash", ["minimal", "low", "medium", "high"]),
        ],
      },
      {
        name: "Flash-Lite",
        versions: [
          gemini("3.5", "gemini-3.5-flash-lite", ["minimal", "low", "medium", "high"]),
          // Its page documents thinking, but only ever at `high`.
          gemini("3.1", "gemini-3.1-flash-lite", ["high"]),
        ],
      },
      { name: "Pro", versions: [gemini("3.1 (preview)", "gemini-3.1-pro-preview", ["low", "medium", "high"])] },
    ],
  },
  {
    id: "grok",
    name: "xAI Grok",
    needsKey: true,
    baseUrl: "https://api.x.ai/v1",
    adjustableCapabilities: false,
    smallModels: false,
    families: [
      {
        name: "Grok",
        versions: [
          grok("4.7", ["low", "medium", "high", "xhigh"], 500_000),
          grok("4.6", ["low", "medium", "high", "xhigh"], 500_000),
          grok("4.5", ["low", "medium", "high"], 500_000),
          grok("4.3", ["none", "low", "medium", "high", "xhigh"], 1_000_000),
        ],
      },
    ],
  },
  {
    id: "meta",
    name: "Meta AI",
    needsKey: true,
    baseUrl: "https://api.meta.ai/v1",
    adjustableCapabilities: false,
    smallModels: false,
    families: [
      {
        name: "Muse Spark",
        versions: [muse("1.3", [...META_EFFORTS, "max"], false), muse("1.2"), muse("1.1")],
      },
    ],
  },
  {
    id: "local",
    name: "Local (Ollama / llama.cpp)",
    needsKey: false,
    baseUrl: "http://localhost:11434/v1",
    adjustableCapabilities: true,
    smallModels: true,
    families: [
      {
        name: "Llama",
        versions: ["llama3.1:8b", "llama3.1:70b", "llama3.2:3b", "llama3.3:70b", "llama4:16x17b"].map(ollama),
      },
      {
        name: "Qwen",
        versions: ["qwen3:8b", "qwen3:4b", "qwen3:14b", "qwen3:32b", "qwen3.6:27b", "qwen3.6:35b"].map(ollama),
      },
      {
        name: "Mistral",
        versions: ["mistral:7b", "mistral-nemo:12b", "mistral-small3.2:24b", "ministral-3:8b"].map(ollama),
      },
      { name: "Gemma", versions: ["gemma4:e4b", "gemma4:12b", "gemma4:26b", "gemma4:31b"].map(ollama) },
    ],
  },
];

export const DEFAULT_PROVIDER: ProviderId = "claude";

export function provider(id: ProviderId): Provider {
  return PROVIDERS.find((each) => each.id === id)!;
}

export function isProviderId(value: unknown): value is ProviderId {
  return PROVIDERS.some((each) => each.id === value);
}

/** The model a provider uses when none is chosen: its first that can use tools. */
export function defaultModel(id: ProviderId): string {
  return assistantFamilies(id)[0]!.versions[0]!.id;
}

/**
 * The families and versions the Assistant can be: those that can use tools.
 * A family with none is left out.
 */
export function assistantFamilies(id: ProviderId): readonly ModelFamily[] {
  return provider(id)
    .families.map((family) => ({ ...family, versions: family.versions.filter((version) => version.capabilities.toolUse) }))
    .filter((family) => family.versions.length > 0);
}

/**
 * What a model can do. A model the catalogue doesn't list, such as one saved
 * by a newer version or typed by hand, is taken to do what its provider's
 * default does.
 */
export function capabilitiesOf(id: ProviderId, model: string): Capabilities {
  return (findModel(id, model) ?? findModel(id, defaultModel(id))!).version.capabilities;
}

/**
 * How many tokens a turn of `model` can hold, or null where the server
 * decides. A model the catalogue doesn't list is taken to hold what its
 * provider's default does.
 */
export function contextWindowOf(id: ProviderId, model: string): number | null {
  return (findModel(id, model) ?? findModel(id, defaultModel(id))!).version.contextWindow ?? null;
}

/** The model the Assistant uses for `model`: it, unless it can't use tools, when it is the provider's default. */
export function assistantModel(id: ProviderId, model: string | undefined): string {
  return model && capabilitiesOf(id, model).toolUse ? model : defaultModel(id);
}

/** Where a model id sits in its provider's catalogue, if it is there. */
export function findModel(id: ProviderId, model: string): { family: ModelFamily; version: ModelVersion } | null {
  for (const family of provider(id).families) {
    const version = family.versions.find((each) => each.id === model);
    if (version) return { family, version };
  }
  return null;
}

/**
 * The effort levels a model takes. A model the catalogue doesn't list, such
 * as one saved by a newer version, is offered all of its provider's levels.
 */
export function effortsFor(id: ProviderId, model: string): readonly string[] {
  const found = findModel(id, model);
  if (found) return found.version.efforts;
  // Every version's levels are a subset of the longest, in the same order.
  const versions = provider(id).families.flatMap((family) => family.versions);
  return versions.reduce<readonly string[]>((most, version) => (version.efforts.length > most.length ? version.efforts : most), []);
}
