import { parseNormalizeAndValidateOrganizerResponse } from "../organizer/validate";
import { computeProviderFingerprint } from "./fingerprint";
import { ProviderHttpError, ProviderTransportError, requestChatCompletion } from "./openai-chat-completions";
import { normalizeProviderConfig, normalizeProviderEndpoint } from "./request-policy";
import { LIMITS } from "../shared/limits";
import type {
  ConnectionTestRecord,
  OpenAICompatibleConfig,
  ProviderCapabilities,
  StructuredOutputMode,
} from "../shared/organizer-types";

const FAKE_REQUEST_JSON = JSON.stringify(
  {
    schemaVersion: 1,
    privacyLevel: 2,
    existingGroupMetadataIncluded: false,
    inactivityPolicy: {
      generalSuggestionAfterHours: 24,
      lowValueSuggestionAfterHours: 6,
      closingRequiresManualReview: true,
    },
    tabs: [
      {
        id: 1,
        title: "Example documentation",
        domain: "example.com",
        hostname: "docs.example.com",
        path: "/docs/overview",
        recencyBucket: "under_20_minutes",
        inactiveForMinutes: 2,
        meetsLowValueInactivityThreshold: false,
        isActive: true,
        isAudible: false,
      },
      {
        id: 2,
        title: "Example project",
        domain: "example.org",
        hostname: "work.example.org",
        path: "/project/status",
        recencyBucket: "1_to_6_hours",
        inactiveForMinutes: 180,
        meetsLowValueInactivityThreshold: false,
        isActive: false,
        isAudible: false,
      },
    ],
  },
  null,
  2,
);

export interface ConnectionTestOptions {
  config: OpenAICompatibleConfig;
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function testProviderConnection(
  options: ConnectionTestOptions,
): Promise<ConnectionTestRecord> {
  const config = normalizeProviderConfig(options.config);
  // Settings mistakes surface once, before any request, instead of once per output mode.
  normalizeProviderEndpoint(config.origin, config.endpointPath);
  const deadlineAt = Date.now() + LIMITS.MANUAL_TOTAL_DEADLINE_MS;
  const modes: StructuredOutputMode[] = ["json_schema", "json_object", "prompt"];
  const failures: string[] = [];
  for (const mode of modes) {
    try {
      const content = await requestChatCompletion(
        {
          config,
          apiKey: options.apiKey,
          mode,
          requestJson: FAKE_REQUEST_JSON,
          deadlineAt,
          signal: options.signal,
        },
        options.fetchImpl,
      );
      const parsed = JSON.parse(content) as unknown;
      parseNormalizeAndValidateOrganizerResponse(parsed, [1, 2]);
      const capabilities: ProviderCapabilities = {
        structuredOutput: mode,
        streaming: false,
      };
      return {
        fingerprint: await computeProviderFingerprint(config, capabilities),
        testedAt: Date.now(),
        providerOrigin: config.origin,
        capabilities,
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Only a format complaint means the next output mode might work. A bad
      // key, missing model, rate limit, outage, or network failure would fail
      // the same way three times, so report it once and stop sending requests.
      if (!isFormatFailure(error)) throw error;
      failures.push(`${mode}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  throw new Error(
    `The provider answered, but none of its replies could be used as a tab plan. Choose a model that supports JSON output. Details: ${failures.join(" | ")}`,
  );
}

function isFormatFailure(error: unknown): boolean {
  if (error instanceof ProviderTransportError) return false;
  if (error instanceof ProviderHttpError) return error.status === 400 || error.status === 422;
  return true;
}
