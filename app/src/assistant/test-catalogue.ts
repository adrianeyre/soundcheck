/**
 * Changes to the catalogue, for tests: a model that can't use tools (every
 * model the catalogue lists can), and other capabilities declared. Each lasts
 * until the test finishes.
 */
import { onTestFinished } from "vitest";

import { defaultModel, findModel, provider, type Capabilities, type ModelVersion, type ProviderId } from "./catalogue";

export const TEXT_ONLY_MODEL: ModelVersion = {
  name: "text-only:1b",
  id: "text-only:1b",
  efforts: [],
  capabilities: { toolUse: false, imageInput: false, audioInput: false, parallelToolCalls: false },
};

/** Adds `TEXT_ONLY_MODEL` to Local's Qwen family. */
export function addTextOnlyModel(): void {
  const versions = provider("local").families.find((family) => family.name === "Qwen")!.versions as ModelVersion[];
  versions.push(TEXT_ONLY_MODEL);
  onTestFinished(() => void versions.splice(versions.indexOf(TEXT_ONLY_MODEL), 1));
}

/** Declares `change` for provider `id`'s default model until the test finishes, as if its docs said so. */
export function declareCapabilities(id: ProviderId, change: Partial<Capabilities>): void {
  const { version } = findModel(id, defaultModel(id))!;
  const declared = version.capabilities;
  version.capabilities = { ...declared, ...change };
  onTestFinished(() => void (version.capabilities = declared));
}
