import { normalizeCustomHeaders, normalizeOpenRouterPreferences, normalizeProviderEndpoint, validateExtraBody } from "../provider/request-policy";
import type { EmbeddingConfig } from "../shared/search-types";
import {
  EMBEDDING_PROFILE_IDS,
  embeddingModelProfile,
  profileOwnedTaskKeys,
  type EmbeddingProfileId,
} from "./model-profiles";

const EMBEDDING_OWNED_KEYS = new Set(["input", "dimensions", "encoding_format"]);
export const MAX_EMBEDDING_DIMENSIONS = 65_536;

export function normalizeEmbeddingProfileId(value: unknown): EmbeddingProfileId {
  return EMBEDDING_PROFILE_IDS.includes(value as EmbeddingProfileId)
    ? value as EmbeddingProfileId
    : "auto";
}

/**
 * Drops a legacy `extraBody` copy of a task field the model profile now owns.
 *
 * Before profiles carried task fields, the only way to set `input_type` for Cohere
 * or Voyage was `extraBody`, and that single global value was necessarily wrong on
 * one of the two calls. Existing configurations migrate here instead of failing
 * validation, so a working setup does not reset to defaults when it upgrades.
 */
export function migrateEmbeddingExtraBody(
  extraBody: Record<string, unknown>,
  modelId: string,
  profileId: EmbeddingProfileId = "auto",
): Record<string, unknown> {
  const owned = profileOwnedTaskKeys(modelId, profileId);
  if (owned.length === 0) return extraBody;
  return Object.fromEntries(Object.entries(extraBody).filter(
    ([key]) => !owned.includes(key.toLocaleLowerCase()),
  ));
}

export function normalizeEmbeddingConfig(config: EmbeddingConfig): EmbeddingConfig {
  const endpoint = normalizeProviderEndpoint(config.origin, config.endpointPath);
  const model = config.model.trim();
  if (!model) throw new Error("Embedding model is required.");
  if (config.dimensions !== null && (!Number.isInteger(config.dimensions) || config.dimensions < 1 || config.dimensions > MAX_EMBEDDING_DIMENSIONS)) {
    throw new Error("Embedding dimensions must be a whole number from 1 to 65,536.");
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 120_000) {
    throw new Error("Embedding timeout must be 1,000–120,000 ms.");
  }
  for (const key of Object.keys(config.extraBody)) {
    if (EMBEDDING_OWNED_KEYS.has(key.toLocaleLowerCase())) {
      throw new Error(`Extra body cannot override embedding field ${key}.`);
    }
  }
  validateExtraBody(config.extraBody);
  const modelProfile = normalizeEmbeddingProfileId(config.modelProfile);
  const ownedTaskKeys = profileOwnedTaskKeys(model.slice(0, 200), modelProfile);
  for (const key of Object.keys(config.extraBody)) {
    if (ownedTaskKeys.includes(key.toLocaleLowerCase())) {
      throw new Error(
        `Extra body cannot set ${key}: the ${embeddingModelProfile(model, modelProfile).id} profile sends a different value for indexing and for searching. Remove it from extra body to use the profile's task typing.`,
      );
    }
  }
  return {
    ...config,
    origin: endpoint.origin,
    endpointPath: endpoint.endpointPath,
    model: model.slice(0, 200),
    modelProfile,
    apiKeyStorage: config.apiKeyStorage === "persistent" ? "persistent" : "session",
    customHeaders: normalizeCustomHeaders(config.customHeaders),
    openRouter: normalizeOpenRouterPreferences(config.openRouter),
  };
}
