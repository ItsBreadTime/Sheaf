import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EMBEDDING_CONFIG, DEFAULT_SEARCH_SETTINGS, readSearchState, writeEmbeddingProvider, writeSearchSettings } from "../src/storage/search";

describe("search settings storage", () => {
  beforeEach(() => {
    const local: Record<string, unknown> = {};
    const session: Record<string, unknown> = {};
    const area = (store: Record<string, unknown>) => ({
      get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]]))),
      set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, structuredClone(values))),
    });
    vi.stubGlobal("chrome", { storage: { local: area(local), session: area(session) } });
  });

  it("keeps semantic search disabled until consent is present", async () => {
    expect((await readSearchState()).local.settings).toEqual(DEFAULT_SEARCH_SETTINGS);
    const written = await writeSearchSettings({ ...DEFAULT_SEARCH_SETTINGS, semanticEnabled: true, semanticConsentAt: null });
    expect(written.local.settings.semanticEnabled).toBe(false);
  });

  it("remembers historical consent when semantic search is disabled", async () => {
    const enabled = await writeSearchSettings({ ...DEFAULT_SEARCH_SETTINGS, semanticEnabled: true, semanticConsentAt: 123 });
    const disabled = await writeSearchSettings({ ...enabled.local.settings, semanticEnabled: false, semanticConsentAt: 123 });
    expect(disabled.local.settings).toMatchObject({ semanticEnabled: false, semanticConsentAt: 123 });
  });

  it("persists the always-use-semantic-search preference", async () => {
    const written = await writeSearchSettings({
      ...DEFAULT_SEARCH_SETTINGS,
      semanticEnabled: true,
      semanticConsentAt: 123,
      semanticAlways: true,
    });
    expect(written.local.settings).toMatchObject({
      semanticEnabled: true,
      semanticAlways: true,
      semanticWhenDirectWeak: true,
    });
  });

  it("stores session credentials separately from non-secret local configuration", async () => {
    const state = await writeEmbeddingProvider({
      config: { ...DEFAULT_EMBEDDING_CONFIG, origin: "https://embed.example", model: "embed-v1" },
      apiKey: "session-secret",
      customHeaders: { "x-route": "private-route" },
    });
    expect(state.local.embeddingConfig.customHeaders).toEqual({});
    expect(state.local.persistentApiKey).toBeNull();
    expect(state.session).toEqual({ apiKey: "session-secret", customHeaders: { "x-route": "private-route" } });
  });

  it("persists OpenRouter embedding routing preferences", async () => {
    const state = await writeEmbeddingProvider({
      config: {
        ...DEFAULT_EMBEDDING_CONFIG,
        origin: "https://openrouter.ai",
        endpointPath: "/api/v1/embeddings",
        model: "openai/text-embedding-3-small",
        openRouter: { zdr: true, order: ["openai", "azure"], allowFallbacks: false, dataCollection: "deny" },
      },
      apiKey: "",
      customHeaders: {},
    });
    expect(state.local.embeddingConfig.openRouter).toEqual({
      zdr: true,
      order: ["openai", "azure"],
      allowFallbacks: false,
      dataCollection: "deny",
    });
  });

  it("recovers from invalid stored provider fields without breaking direct search settings", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({ searchLocalState: {
          settings: { defaultScope: "all_windows", includeGroupNames: false },
          embeddingConfig: { origin: "not a url", endpointPath: "bad", model: "x", timeoutMs: 1 },
          persistentApiKey: "stale-secret",
          providerTest: { testedAt: 1, model: "stale", dimensions: 3, latencyMs: 1, batchInputSupported: true, queryDocumentCompatible: true },
          } })),
        },
        session: { get: vi.fn(async () => ({})) },
      },
    });
    const state = await readSearchState();
    expect(state.local.settings).toMatchObject({ defaultScope: "all_windows", includeGroupNames: false });
    expect(state.local.embeddingConfig).toEqual(DEFAULT_EMBEDDING_CONFIG);
    expect(state.local.persistentApiKey).toBeNull();
    expect(state.local.providerTest).toBeNull();
  });
});
