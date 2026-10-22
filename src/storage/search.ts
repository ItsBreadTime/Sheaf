import type { EmbeddingConfig, EmbeddingTestResult, SearchLocalState, SearchSettings, SearchStoredState } from "../shared/search-types";
import { migrateEmbeddingExtraBody, normalizeEmbeddingConfig, normalizeEmbeddingProfileId } from "../search/embedding-config";
import { normalizeSearchPicks, recordSearchPick, type SearchPick } from "../search/search-picks";

const LOCAL_KEY = "searchLocalState";
const SESSION_API_KEY = "searchEmbeddingApiKey";
const SESSION_HEADERS = "searchEmbeddingCustomHeaders";
const SESSION_PICKS = "searchResultPicks";

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  defaultScope: "current_window",
  includeGroupNames: true,
  closeAfterFocus: true,
  semanticEnabled: false,
  semanticConsentAt: null,
  semanticIncludeGroupNames: true,
  semanticRerank: false,
  semanticAlways: false,
  semanticWhenDirectWeak: true,
  semanticIndexScope: "all_windows",
  semanticIndexPaused: false,
};

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  origin: "https://api.openai.com",
  endpointPath: "/v1/embeddings",
  model: "",
  dimensions: null,
  apiKeyStorage: "session",
  modelProfile: "auto",
  customHeaders: {},
  extraBody: {},
  timeoutMs: 30_000,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseTest(value: unknown): EmbeddingTestResult | null {
  const item = record(value);
  return typeof item.testedAt === "number" && Number.isFinite(item.testedAt) &&
    typeof item.model === "string" && typeof item.dimensions === "number" && Number.isInteger(item.dimensions) && item.dimensions > 0 &&
    typeof item.latencyMs === "number" && Number.isFinite(item.latencyMs) && item.batchInputSupported === true && item.queryDocumentCompatible === true
    ? {
        testedAt: item.testedAt,
        model: item.model,
        dimensions: item.dimensions,
        latencyMs: item.latencyMs,
        batchInputSupported: true,
        queryDocumentCompatible: true,
        retentionStatus: "not_verified",
        dimensionsHonored: item.dimensionsHonored !== false,
        normalized: item.normalized === true,
      }
    : null;
}

function parseLocal(value: unknown): SearchLocalState {
  const root = record(value);
  const settings = record(root.settings);
  const config = record(root.embeddingConfig);
  const model = typeof config.model === "string" ? config.model || "not-configured" : "not-configured";
  const modelProfile = normalizeEmbeddingProfileId(config.modelProfile);
  // A pre-profile configuration may carry `input_type` in extra body. Migrate it
  // away rather than rejecting it, so an upgrade does not reset a working provider.
  const extraBody = migrateEmbeddingExtraBody(record(config.extraBody), model, modelProfile);
  const openRouter = record(config.openRouter);
  const apiKeyStorage = config.apiKeyStorage === "persistent" ? "persistent" : "session";
  let parsedConfig: EmbeddingConfig;
  let recoveredInvalidConfig = false;
  try {
    parsedConfig = normalizeEmbeddingConfig({
      origin: typeof config.origin === "string" ? config.origin : DEFAULT_EMBEDDING_CONFIG.origin,
      endpointPath: typeof config.endpointPath === "string" ? config.endpointPath : DEFAULT_EMBEDDING_CONFIG.endpointPath,
      model,
      dimensions: typeof config.dimensions === "number" ? config.dimensions : null,
      apiKeyStorage,
      modelProfile,
      customHeaders: {},
      extraBody,
      openRouter: config.openRouter && typeof config.openRouter === "object" && !Array.isArray(config.openRouter)
        ? {
            zdr: openRouter.zdr === true,
            order: Array.isArray(openRouter.order)
              ? openRouter.order.filter((item): item is string => typeof item === "string")
              : undefined,
            sort: openRouter.sort === "price" || openRouter.sort === "throughput" || openRouter.sort === "latency"
              ? openRouter.sort
              : undefined,
            allowFallbacks: typeof openRouter.allowFallbacks === "boolean" ? openRouter.allowFallbacks : undefined,
            dataCollection: openRouter.dataCollection === "allow" || openRouter.dataCollection === "deny"
              ? openRouter.dataCollection
              : undefined,
            requireParameters: openRouter.requireParameters === true,
          }
        : undefined,
      timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : DEFAULT_EMBEDDING_CONFIG.timeoutMs,
    });
  } catch {
    parsedConfig = { ...DEFAULT_EMBEDDING_CONFIG };
    recoveredInvalidConfig = true;
  }
  if (parsedConfig.model === "not-configured") parsedConfig.model = "";
  return {
    settings: {
      defaultScope: settings.defaultScope === "all_windows" ? "all_windows" : "current_window",
      includeGroupNames: settings.includeGroupNames !== false,
      closeAfterFocus: settings.closeAfterFocus !== false,
      semanticEnabled: settings.semanticEnabled === true && typeof settings.semanticConsentAt === "number",
      semanticConsentAt: typeof settings.semanticConsentAt === "number" && Number.isFinite(settings.semanticConsentAt) ? settings.semanticConsentAt : null,
      semanticIncludeGroupNames: settings.semanticIncludeGroupNames !== false,
      semanticRerank: settings.semanticRerank === true,
      semanticAlways: settings.semanticAlways === true,
      semanticWhenDirectWeak: settings.semanticWhenDirectWeak !== false,
      semanticIndexScope: settings.semanticIndexScope === "current_window" ? "current_window" : "all_windows",
      semanticIndexPaused: settings.semanticIndexPaused === true,
    },
    embeddingConfig: parsedConfig,
    persistentApiKey: !recoveredInvalidConfig && typeof root.persistentApiKey === "string" ? root.persistentApiKey : null,
    providerTest: recoveredInvalidConfig ? null : parseTest(root.providerTest),
  };
}

export async function readSearchState(): Promise<SearchStoredState> {
  const [localValues, sessionValues] = await Promise.all([
    chrome.storage.local.get(LOCAL_KEY),
    chrome.storage.session.get([SESSION_API_KEY, SESSION_HEADERS]),
  ]);
  const local = localValues[LOCAL_KEY] === undefined
    ? { settings: { ...DEFAULT_SEARCH_SETTINGS }, embeddingConfig: { ...DEFAULT_EMBEDDING_CONFIG }, persistentApiKey: null, providerTest: null }
    : parseLocal(localValues[LOCAL_KEY]);
  const headers = record(sessionValues[SESSION_HEADERS]);
  return {
    local,
    session: {
      apiKey: local.embeddingConfig.apiKeyStorage === "persistent"
        ? local.persistentApiKey ?? ""
        : typeof sessionValues[SESSION_API_KEY] === "string" ? sessionValues[SESSION_API_KEY] : "",
      customHeaders: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    },
  };
}

export async function writeSearchSettings(settings: SearchSettings): Promise<SearchStoredState> {
  const previous = await readSearchState();
  const normalized: SearchSettings = {
    ...settings,
    defaultScope: settings.defaultScope === "all_windows" ? "all_windows" : "current_window",
    semanticIndexScope: settings.semanticIndexScope === "current_window" ? "current_window" : "all_windows",
    semanticEnabled: settings.semanticEnabled && settings.semanticConsentAt !== null,
      semanticConsentAt: settings.semanticConsentAt !== null && Number.isFinite(settings.semanticConsentAt)
        ? settings.semanticConsentAt
        : null,
  };
  await chrome.storage.local.set({ [LOCAL_KEY]: { ...previous.local, settings: normalized } });
  return readSearchState();
}

export async function writeEmbeddingProvider(options: { config: EmbeddingConfig; apiKey: string; customHeaders: Record<string, string> }): Promise<SearchStoredState> {
  const previous = await readSearchState();
  const config = normalizeEmbeddingConfig({ ...options.config, customHeaders: options.customHeaders });
  const localConfig = { ...config, customHeaders: {} };
  const local: SearchLocalState = {
    ...previous.local,
    embeddingConfig: localConfig,
    persistentApiKey: config.apiKeyStorage === "persistent" ? options.apiKey : null,
    providerTest: null,
  };
  await Promise.all([
    chrome.storage.local.set({ [LOCAL_KEY]: local }),
    chrome.storage.session.set({
      [SESSION_API_KEY]: config.apiKeyStorage === "session" ? options.apiKey : "",
      [SESSION_HEADERS]: config.customHeaders,
    }),
  ]);
  return readSearchState();
}

export async function writeEmbeddingProviderTest(result: EmbeddingTestResult): Promise<SearchStoredState> {
  const previous = await readSearchState();
  await chrome.storage.local.set({ [LOCAL_KEY]: { ...previous.local, providerTest: result } });
  return readSearchState();
}

export async function readSearchPicks(): Promise<SearchPick[]> {
  const values = await chrome.storage.session.get(SESSION_PICKS);
  return normalizeSearchPicks(values[SESSION_PICKS]);
}

/** Read-modify-write, so a second open popup's picks are kept rather than overwritten. */
export async function recordSearchPickInSession(query: string, key: string): Promise<SearchPick[]> {
  const picks = recordSearchPick(await readSearchPicks(), query, key);
  await chrome.storage.session.set({ [SESSION_PICKS]: picks });
  return picks;
}
