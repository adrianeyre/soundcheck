import { Check, KeyRound, Trash2, X } from "lucide-react";
import { useId, useState } from "react";

import { LISTENING } from "../audio/listening";
import { useAssistantSettings } from "./assistant-settings";
import {
  ADJUSTABLE_CAPABILITIES,
  assistantFamilies,
  capabilitiesOf,
  defaultModel,
  effortsFor,
  LOCAL_CONTEXT,
  provider as providerOf,
  PROVIDERS,
  type AdjustableCapability,
  type Capabilities,
  type ProviderId,
} from "./catalogue";
import type { RequestMode } from "./assistant";
import { capabilitiesFor, isContextWindow, requestModeFor, type Connection, type Settings } from "./connection";
import type { KeyStore } from "./key-store";

export interface AssistantSettingsProps {
  keyStore: KeyStore;
}

/**
 * The Assistant's connection, on the Settings page: the provider, its API
 * key, model and effort, how its Requests run, and a gateway or local
 * server to reach it through. What is saved here the Request box on the Editor page uses at once.
 */
export function AssistantSettings({ keyStore }: AssistantSettingsProps) {
  const [{ settings, loaded, error }, store] = useAssistantSettings(keyStore);
  // Each save starts the form afresh from what was saved, with the key field empty.
  const [saves, setSaves] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  if (!loaded) return <p className="hint">Reading the saved connection…</p>;

  return (
    <div className="stack">
      <ConnectionForm
        key={saves}
        saved={settings}
        onSave={async (provider, connection) => {
          setStatus(null);
          if (await store.save(provider, connection)) {
            setSaves((count) => count + 1);
            setStatus(`Saved. The Assistant will use ${providerOf(provider).name}.`);
          }
        }}
      />
      {settings && (
        <div className="row">
          <button
            type="button"
            className="btn-sm"
            onClick={async () => {
              await store.forget();
              setSaves((count) => count + 1);
              setStatus("The API key was forgotten.");
            }}
          >
            <Trash2 size={14} aria-hidden />
            Forget API key
          </button>
        </div>
      )}
      <p role="status" className="hint">
        {status}
      </p>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** What the form holds for one provider while it is being edited. */
interface Draft {
  entered: string;
  baseUrl: string;
  customHeaders: string;
  model: string;
  effort: string;
  /** What the musician changed of the model's capabilities, where the provider lets them. */
  capabilities: NonNullable<Connection["capabilities"]>;
  /** What the musician set of how Requests run, where it isn't the provider's default. */
  smallCore?: boolean;
  suggestion?: boolean;
  /** Whether a model that takes audio hears `analyse_audio`'s render: off unless ticked. */
  hearAudio: boolean;
  /** The server's context window, as typed, where the server decides it; blank for Ollama's default. */
  contextWindow: string;
}

/** What the settings call each capability. */
const CAPABILITY_LABELS: Record<keyof Capabilities, string> = {
  toolUse: "Uses tools",
  imageInput: "Sees images, such as spectrograms",
  audioInput: "Hears audio",
  parallelToolCalls: "Makes several tool calls a turn",
};

function draft(provider: ProviderId, saved: Connection | undefined): Draft {
  return {
    entered: "",
    baseUrl: saved?.baseUrl ?? "",
    customHeaders: saved?.customHeaders ?? "",
    model: saved?.model ?? defaultModel(provider),
    effort: saved?.effort ?? "",
    capabilities: saved?.capabilities ?? {},
    ...(saved?.smallCore !== undefined && { smallCore: saved.smallCore }),
    ...(saved?.suggestion !== undefined && { suggestion: saved.suggestion }),
    hearAudio: saved?.hearAudio ?? false,
    contextWindow: saved?.contextWindow === undefined ? "" : String(saved.contextWindow),
  };
}

/**
 * The provider, its API key, model and effort, and optionally a gateway to
 * reach it through. Each provider keeps its own entries, so switching to
 * another and back loses nothing. Editing a saved connection shows its base
 * URL and headers; a blank key keeps the saved one, which is never shown.
 */
function ConnectionForm({
  saved,
  onSave,
}: {
  saved: Settings | null;
  onSave: (provider: ProviderId, connection: Connection) => void | Promise<void>;
}) {
  const [chosen, setChosen] = useState<ProviderId>(saved?.provider ?? "claude");
  const [drafts, setDrafts] = useState(
    () => Object.fromEntries(PROVIDERS.map(({ id }) => [id, draft(id, saved?.connections[id])])) as Record<ProviderId, Draft>,
  );
  const provider = providerOf(chosen);
  const savedConnection = saved?.connections[chosen];
  const { entered, baseUrl, customHeaders, model, effort, capabilities: changed, smallCore, suggestion, hearAudio, contextWindow } = drafts[chosen];
  const edit = (change: Partial<Draft>) => setDrafts((all) => ({ ...all, [chosen]: { ...all[chosen], ...change } }));
  // Another model starts from what it declares.
  const pick = (next: string) => edit({ model: next, capabilities: {} });
  const apiKey = entered.trim() || savedConnection?.apiKey || "";
  // Only a model that can use tools can be the Assistant, so only those are offered.
  const families = assistantFamilies(chosen);
  const listed = families.find((each) => each.versions.some((version) => version.id === model));
  const found = listed && { family: listed, version: listed.versions.find((version) => version.id === model)! };
  const efforts = effortsFor(chosen, model);
  const capabilities = capabilitiesFor(chosen, { apiKey, model, capabilities: changed });
  const declared = capabilitiesOf(chosen, model);
  // Only what differs from the catalogue is kept, so another model chosen later starts from its own.
  const adjusted = provider.adjustableCapabilities
    ? Object.fromEntries(ADJUSTABLE_CAPABILITIES.filter((name) => capabilities[name] !== declared[name]).map((name) => [name, capabilities[name]]))
    : {};
  const mode = requestModeFor(chosen, { apiKey, smallCore, suggestion });
  // As with capabilities, only what differs from the provider's default is kept.
  const byDefault = requestModeFor(chosen, { apiKey });
  const typedWindow = Number(contextWindow.trim());
  const serverWindow = provider.adjustableCapabilities && isContextWindow(typedWindow) ? typedWindow : undefined;
  const modelName = found ? `${found.family.name} ${found.version.name}` : model;
  const keyLabel = provider.needsKey ? `${provider.name} API key` : "API key (optional)";
  const ids = useId();
  const keyHelp = `${ids}-key-help`;
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (provider.needsKey && !apiKey) return;
        void onSave(chosen, {
          apiKey,
          baseUrl,
          customHeaders,
          ...(model !== defaultModel(chosen) && { model }),
          ...(effort && efforts.includes(effort) && { effort }),
          ...(Object.keys(adjusted).length > 0 && { capabilities: adjusted }),
          ...(mode.smallCore !== byDefault.smallCore && { smallCore: mode.smallCore }),
          ...(mode.suggestion !== byDefault.suggestion && { suggestion: mode.suggestion }),
          // Off is the default, and only a model that takes audio can have it on.
          ...(capabilities.audioInput && hearAudio && { hearAudio: true }),
          ...(serverWindow !== undefined && { contextWindow: serverWindow }),
        });
      }}
    >
      <div className="row row-end">
        <label className="field">
          Provider
          <select value={chosen} onChange={(event) => setChosen(event.target.value as ProviderId)}>
            {PROVIDERS.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: "1 1 18rem" }}>
          {keyLabel}
          <input
            type="password"
            value={entered}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={keyHelp}
            placeholder={savedConnection?.apiKey ? "Saved — leave blank to keep it" : undefined}
            onChange={(event) => edit({ entered: event.target.value })}
          />
        </label>
      </div>
      <p id={keyHelp} className="hint">
        <KeyRound size={14} aria-hidden /> Kept on this machine in the credential store, never in a Project.
      </p>
      <div className="row row-end">
        <label className="field">
          Model
          <select
            value={found?.family.name ?? ""}
            onChange={(event) => {
              const next = families.find((each) => each.name === event.target.value);
              if (next) pick(next.versions[0]!.id);
            }}
          >
            {families.map((family) => (
              <option key={family.name} value={family.name}>
                {family.name}
              </option>
            ))}
            {/* A model this app doesn't list, saved by hand or by a newer version, stays choosable. */}
            {!found && <option value="">{model}</option>}
          </select>
        </label>
        <label className="field">
          Version
          <select value={model} onChange={(event) => pick(event.target.value)}>
            {(found?.family.versions ?? [{ name: model, id: model }]).map((version, index) => (
              <option key={version.id} value={version.id}>
                {found && index === 0 ? `${version.name} (default)` : version.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Effort
          <select
            value={efforts.includes(effort) ? effort : ""}
            disabled={efforts.length === 0}
            aria-describedby={efforts.length === 0 ? `${ids}-no-effort` : undefined}
            onChange={(event) => edit({ effort: event.target.value })}
          >
            <option value="">the model&apos;s default</option>
            {efforts.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
      {efforts.length === 0 && (
        <p id={`${ids}-no-effort`} className="hint">
          {modelName} has no effort setting.
        </p>
      )}
      <ModelCapabilities
        model={modelName}
        capabilities={capabilities}
        adjustable={provider.adjustableCapabilities}
        onChange={(name, on) => edit({ capabilities: { ...changed, [name]: on } })}
      />
      <RequestModeFields mode={mode} smallModels={provider.smallModels} onChange={(change) => edit(change)} />
      {capabilities.audioInput && <HearAudioField hearAudio={hearAudio} onChange={(on) => edit({ hearAudio: on })} />}
      <details open={Boolean(savedConnection?.baseUrl || savedConnection?.customHeaders || !provider.needsKey)}>
        <summary>{provider.needsKey ? "Gateway (optional)" : "Server"}</summary>
        <div className="stack mt-3">
          <label className="field">
            Base URL
            <input
              inputMode="url"
              value={baseUrl}
              spellCheck={false}
              placeholder={provider.baseUrl}
              onChange={(event) => edit({ baseUrl: event.target.value })}
            />
          </label>
          <label className="field">
            Custom headers
            <textarea
              value={customHeaders}
              rows={3}
              spellCheck={false}
              placeholder="Name: value, one per line"
              onChange={(event) => edit({ customHeaders: event.target.value })}
            />
          </label>
          {provider.adjustableCapabilities && (
            <>
              <label className="field">
                Context window (tokens)
                <input
                  inputMode="numeric"
                  value={contextWindow}
                  spellCheck={false}
                  aria-describedby={`${ids}-context-help`}
                  placeholder={String(LOCAL_CONTEXT)}
                  onChange={(event) => edit({ contextWindow: event.target.value })}
                />
              </label>
              <p id={`${ids}-context-help`} className="hint">
                What the server gives the model, so the Assistant can show how full it is. Ollama gives{" "}
                {LOCAL_CONTEXT.toLocaleString("en-GB")} unless it is started with a larger <code>OLLAMA_CONTEXT_LENGTH</code>;{" "}
                <code>ollama ps</code> shows it.
              </p>
            </>
          )}
        </div>
      </details>
      <div className="row">
        <button type="submit" className="btn-primary" disabled={provider.needsKey && !apiKey}>
          {saved ? "Save" : "Save key"}
        </button>
      </div>
    </form>
  );
}

/**
 * What the chosen model can do. A provider whose models vary by how they are
 * run lets the musician say, starting from what the catalogue declares; tool
 * use is never theirs to turn off, since without it the model can't be the
 * Assistant at all.
 */
function ModelCapabilities({
  model,
  capabilities,
  adjustable,
  onChange,
}: {
  model: string;
  capabilities: Capabilities;
  adjustable: boolean;
  onChange: (name: AdjustableCapability, on: boolean) => void;
}) {
  const heading = useId();
  const fixed = (Object.keys(CAPABILITY_LABELS) as (keyof Capabilities)[]).filter(
    (name) => !adjustable || !(ADJUSTABLE_CAPABILITIES as readonly string[]).includes(name),
  );
  return (
    <fieldset className="stack" aria-labelledby={heading}>
      <legend id={heading} className="field-legend">What {model} can do</legend>
      <ul className="stack capability-list">
        {fixed.map((name) => (
          <li key={name}>
            {CAPABILITY_LABELS[name]}:{" "}
            <span className="capability-value" data-on={capabilities[name]}>
              {capabilities[name] ? <Check size={14} aria-hidden /> : <X size={14} aria-hidden />}
              {capabilities[name] ? "yes" : "no"}
            </span>
          </li>
        ))}
      </ul>
      {adjustable && (
        <>
          {ADJUSTABLE_CAPABILITIES.map((name) => (
            <label key={name} className="field-inline">
              <input type="checkbox" checked={capabilities[name]} onChange={(event) => onChange(name, event.target.checked)} />
              {CAPABILITY_LABELS[name]}
            </label>
          ))}
          <p className="hint">The same model can be run with or without these: tick what your server gives it.</p>
        </>
      )}
    </fieldset>
  );
}

/**
 * Whether a model that takes audio hears the render itself when it listens,
 * as well as reading its measurements: off by default, since audio costs
 * more, and offered only for such a model.
 */
function HearAudioField({ hearAudio, onChange }: { hearAudio: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="stack">
      <label className="field-inline">
        <input type="checkbox" checked={hearAudio} onChange={(event) => onChange(event.target.checked)} />
        Let the Assistant hear the audio when it listens
      </label>
      <p className="hint">
        It hears up to {LISTENING.maxSeconds} seconds at a time, in mono, as well as reading the measurements. Audio costs more than
        the numbers alone.
      </p>
    </div>
  );
}

/**
 * How Requests run: as a Suggestion, for any provider, and with the smaller
 * core, for one with small models, which starts with both.
 */
function RequestModeFields({
  mode,
  smallModels,
  onChange,
}: {
  mode: RequestMode;
  smallModels: boolean;
  onChange: (change: Partial<RequestMode>) => void;
}) {
  const heading = useId();
  return (
    <fieldset className="stack" aria-labelledby={heading}>
      <legend id={heading} className="field-legend">How the Assistant works</legend>
      <label className="field-inline">
        <input type="checkbox" checked={mode.suggestion} onChange={(event) => onChange({ suggestion: event.target.checked })} />
        Suggest changes for me to apply
      </label>
      {smallModels && (
        <label className="field-inline">
          <input type="checkbox" checked={mode.smallCore} onChange={(event) => onChange({ smallCore: event.target.checked })} />
          Start with fewer, simpler tools
        </label>
      )}
      <p className="hint">
        {smallModels
          ? "A smaller model is more reliable with fewer tools to choose from, and a Suggestion lets you check its changes before they are made."
          : "A Suggestion is worked out on a copy of the Project, and nothing changes until you apply it."}
      </p>
    </fieldset>
  );
}
