import type {
  OpenAICompatibleConfig,
  ProviderCapabilities,
} from "../shared/organizer-types";
import { ORGANIZER_RESPONSE_JSON_SCHEMA } from "./protocol";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export async function computeProviderFingerprint(
  config: OpenAICompatibleConfig,
  capabilities: ProviderCapabilities,
): Promise<string> {
  const payload = stableValue({
    origin: config.origin,
    endpointPath: config.endpointPath,
    model: config.model,
    customHeaderNames: Object.keys(config.customHeaders).map((name) => name.toLowerCase()).sort(),
    extraBody: config.extraBody,
    temperature: config.temperature ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
    // Only a hand-picked method counts, so adding the setting kept earlier tests valid.
    ...(config.reasoningOffMethod && config.reasoningOffMethod !== "auto"
      ? { reasoningOffMethod: config.reasoningOffMethod }
      : {}),
    reasoning: config.reasoning ?? null,
    openRouter: config.openRouter ?? null,
    manualStreamingEnabled: config.manualStreamingEnabled,
    capabilities,
    structuredOutputContract: ORGANIZER_RESPONSE_JSON_SCHEMA,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
