import { describe, expect, it } from "vitest";
import { computeProviderFingerprint } from "../src/provider/fingerprint";
import {
  normalizeCustomHeaders,
  normalizeProviderConfig,
  normalizeProviderEndpoint,
  validateExtraBody,
} from "../src/provider/request-policy";
import type { OpenAICompatibleConfig } from "../src/shared/organizer-types";
import { ORGANIZER_RESPONSE_JSON_SCHEMA } from "../src/provider/protocol";
import { LIMITS } from "../src/shared/limits";

function config(overrides: Partial<OpenAICompatibleConfig> = {}): OpenAICompatibleConfig {
  return {
    origin: "https://api.example.com",
    endpointPath: "/v1/chat/completions",
    model: "example-model",
    customHeaders: {},
    extraBody: {},
    manualStreamingEnabled: false,
    ...overrides,
  };
}

describe("provider endpoint and override policy", () => {
  it("limits structured-output colors to Chrome's native enum plus null fallback", () => {
    const schema = ORGANIZER_RESPONSE_JSON_SCHEMA;
    const groupItems = schema.properties.groups.items;
    expect(groupItems.required).toContain("color");
    expect(groupItems.properties.color.enum).toEqual([
      "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", null,
    ]);
  });

  it("does not impose an artificial structured-output group-count cap", () => {
    const groups = ORGANIZER_RESPONSE_JSON_SCHEMA.properties.groups;
    expect("maxItems" in groups).toBe(false);
    expect(groups.items.properties.tabIds.minItems).toBe(LIMITS.MIN_GROUP_SIZE);
    expect(groups.items.properties.tabIds.maxItems).toBe(LIMITS.MAX_TABS_PER_GROUP);
  });

  it("allows HTTPS and loopback HTTP while producing an exact-origin pattern", () => {
    expect(normalizeProviderEndpoint("https://api.example.com", "/v1/chat/completions")).toEqual({
      origin: "https://api.example.com",
      endpointPath: "/v1/chat/completions",
      url: "https://api.example.com/v1/chat/completions",
      permissionPattern: "https://api.example.com/*",
    });
    expect(normalizeProviderEndpoint("http://localhost:11434", "/v1/chat/completions").origin).toBe(
      "http://localhost:11434",
    );
    expect(
      normalizeProviderEndpoint("http://localhost:11434", "/v1/chat/completions")
        .permissionPattern,
    ).toBe("http://localhost/*");
  });

  it.each([
    ["insecure public origin", "http://api.example.com", "/v1/chat/completions"],
    ["embedded credentials", "https://user:secret@api.example.com", "/v1/chat/completions"],
    ["cross-origin path", "https://api.example.com", "https://evil.example/v1"],
    ["query in endpoint", "https://api.example.com", "/v1/chat?token=secret"],
  ])("rejects %s", (_label, origin, path) => {
    expect(() => normalizeProviderEndpoint(origin, path)).toThrow();
  });

  it("blocks adapter-owned and unsafe custom headers case-insensitively", () => {
    expect(() => normalizeCustomHeaders({ Authorization: "secret" })).toThrow(/controlled/);
    expect(() => normalizeCustomHeaders({ "X-Test": "ok\nInjected: yes" })).toThrow(/line break/);
    expect(normalizeCustomHeaders({ "X-Zeta": "2", "x-alpha": "1" })).toEqual({
      "x-alpha": "1",
      "x-zeta": "2",
    });
  });

  it("rejects adapter-owned and dangerous extra-body keys", () => {
    expect(() => validateExtraBody({ model: "override" })).toThrow(/adapter-owned/);
    expect(() => validateExtraBody({ reasoning_effort: "high" })).toThrow(/adapter-owned/);
    expect(() => validateExtraBody({ provider: { zdr: true } })).toThrow(/adapter-owned/);
    const dangerous = JSON.parse('{"nested":{"__proto__":{"polluted":true}}}') as Record<
      string,
      unknown
    >;
    expect(() => validateExtraBody(dangerous)).toThrow(/dangerous key/);
  });

  it("normalizes OpenRouter routing preferences", () => {
    expect(normalizeProviderConfig(config({
      origin: "https://openrouter.ai",
      openRouter: {
        zdr: true,
        order: [" openai ", "anthropic", "openai"],
        sort: "throughput",
        allowFallbacks: false,
        dataCollection: "deny",
        requireParameters: true,
      },
    })).openRouter).toEqual({
      zdr: true,
      order: ["openai", "anthropic"],
      sort: "throughput",
      allowFallbacks: false,
      dataCollection: "deny",
      requireParameters: true,
    });
    expect(() => normalizeProviderConfig(config({
      openRouter: { order: "openai" as unknown as string[] },
    }))).toThrow(/list of provider slugs/);
  });

  it("includes OpenRouter routing preferences in provider fingerprints", async () => {
    const capabilities = { structuredOutput: "json_schema" as const, streaming: false as const };
    const base = normalizeProviderConfig(config({ origin: "https://openrouter.ai" }));
    const withZdr = normalizeProviderConfig(config({
      origin: "https://openrouter.ai",
      openRouter: { zdr: true },
    }));
    expect(await computeProviderFingerprint(withZdr, capabilities)).not.toBe(
      await computeProviderFingerprint(base, capabilities),
    );
  });

  it("validates standard Chat Completions reasoning effort values", () => {
    expect(normalizeProviderConfig(config({ reasoningEffort: "minimal" })).reasoningEffort).toBe("minimal");
    expect(() => normalizeProviderConfig(config({
      reasoningEffort: "extreme" as OpenAICompatibleConfig["reasoningEffort"],
    }))).toThrow(/Reasoning effort/);
  });

  it("normalizes non-secret configuration and fingerprints it deterministically", async () => {
    const normalized = normalizeProviderConfig(
      config({ customHeaders: { "X-Zeta": "secret", "X-Alpha": "secret-2" } }),
    );
    const capabilities = { structuredOutput: "json_schema" as const, streaming: false as const };
    const first = await computeProviderFingerprint(normalized, capabilities);
    const second = await computeProviderFingerprint(
      { ...normalized, customHeaders: { "x-alpha": "changed", "x-zeta": "changed" } },
      capabilities,
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds saved provider capability tests to the current structured-output contract", async () => {
    const normalized = normalizeProviderConfig(config());
    const capabilities = { structuredOutput: "json_schema" as const, streaming: false as const };
    const current = await computeProviderFingerprint(normalized, capabilities);
    const schema = ORGANIZER_RESPONSE_JSON_SCHEMA as unknown as {
      properties: { lowValueTabIds: { items: { type: string } } };
    };
    const originalItemType = schema.properties.lowValueTabIds.items.type;
    try {
      schema.properties.lowValueTabIds.items.type = "number";
      const changedContract = await computeProviderFingerprint(normalized, capabilities);
      expect(changedContract).not.toBe(current);
    } finally {
      schema.properties.lowValueTabIds.items.type = originalItemType;
    }
  });
});
