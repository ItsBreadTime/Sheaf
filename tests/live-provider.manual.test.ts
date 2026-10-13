import { describe, expect, it } from "vitest";
import { testProviderConnection } from "../src/provider/connection-test";
import { generateValidatedProposal } from "../src/provider/generate-proposal";
import type { ImmutableRequestBundle, OpenAICompatibleConfig } from "../src/shared/organizer-types";

const apiKey = process.env.LIVE_PROVIDER_KEY ?? "";
const origin = process.env.LIVE_PROVIDER_ORIGIN ?? "";
const model = process.env.LIVE_PROVIDER_MODEL ?? "";
const enabled = Boolean(apiKey && origin && model);

function config(): OpenAICompatibleConfig {
  return {
    origin,
    endpointPath: "/v1/chat/completions",
    model,
    customHeaders: {},
    extraBody: {},
    manualStreamingEnabled: false,
  };
}

function request(): ImmutableRequestBundle {
  const approvedRequest = {
    schemaVersion: 1 as const,
    privacyLevel: 2 as const,
    existingGroupMetadataIncluded: false,
    inactivityPolicy: { generalSuggestionAfterHours: 24, lowValueSuggestionAfterHours: 6, closingRequiresManualReview: true as const },
    tabs: [
      { id: 1, title: "Example documentation", domain: "example.com", path: "/docs", recencyBucket: "unknown" as const, isActive: true, isAudible: false },
      { id: 2, title: "Reference guide", domain: "example.org", path: "/reference", recencyBucket: "unknown" as const, isActive: false, isAudible: false },
      { id: 3, title: "API overview", domain: "example.net", path: "/api", recencyBucket: "unknown" as const, isActive: false, isAudible: false },
    ],
  };
  const requestJson = JSON.stringify(approvedRequest, null, 2);
  return {
    approvedRequest,
    requestJson,
    submittedTabIds: [1, 2, 3],
    ephemeralToBrowserTabId: { 1: 101, 2: 102, 3: 103 },
    excludedTabs: [],
    byteLength: new TextEncoder().encode(requestJson).byteLength,
  };
}

describe.skipIf(!enabled)("manual live OpenAI-compatible provider smoke", () => {
  it("tests with fake records and generates a locally validated proposal", async () => {
    const connection = await testProviderConnection({ config: config(), apiKey });
    expect(connection.providerOrigin).toBe(origin);
    expect(["json_schema", "json_object", "prompt"]).toContain(connection.capabilities.structuredOutput);
    const bundle = request();
    const result = await generateValidatedProposal({
      config: config(),
      apiKey,
      connectionTest: connection,
      request: bundle,
    });
    expect(result.status).toBe("validated");
    expect(result.proposal).not.toBeNull();
    const assigned = [
      ...(result.proposal?.groups.flatMap((group) => group.tabIds) ?? []),
      ...(result.proposal?.untouchedTabIds ?? []),
    ].sort((left, right) => left - right);
    expect(assigned).toEqual([1, 2, 3]);
  }, 180_000);
});
