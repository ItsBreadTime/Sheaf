import type { TabSearchScope } from "../search/direct-search";
import type { EmbeddingProfileId } from "../search/model-profiles";
import type { OpenRouterProviderPreferences } from "./organizer-types";

export type SemanticIndexScope = "current_window" | "all_windows";
export type EmbeddingApiKeyStorage = "session" | "persistent";

export interface EmbeddingConfig {
  origin: string;
  endpointPath: string;
  model: string;
  dimensions: number | null;
  apiKeyStorage: EmbeddingApiKeyStorage;
  /**
   * Which prompt/task convention to use. `auto` resolves from the model ID, which
   * is what almost every user wants; an explicit value is for models whose name
   * matches nothing (a fine-tune, an internal alias) and must be part of the
   * compatibility key, because it changes the request and therefore the vectors.
   */
  modelProfile: EmbeddingProfileId;
  customHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  openRouter?: OpenRouterProviderPreferences;
  timeoutMs: number;
}

export interface SearchSettings {
  defaultScope: TabSearchScope;
  includeGroupNames: boolean;
  closeAfterFocus: boolean;
  semanticEnabled: boolean;
  semanticConsentAt: number | null;
  /**
   * Whether group titles join the documents sent to the embedding provider.
   *
   * Separate from the organizer's `includeExistingGroups` and from direct search's
   * `includeGroupNames`: the first governs what the organizer prompt sends, the
   * second only matches locally, and this one widens what leaves the device for
   * indexing and search. Group titles are the single most valuable field available
   * to semantic search, which is why it is a separate setting.
   */
  semanticIncludeGroupNames: boolean;
  /**
   * Whether a near-tie may be broken by one chat request to the organizer's model.
   * The widest payload in the search path — a shortlist of tabs in one request — so
   * it is its own consent, off by default, and it only fires on a measured near-tie.
   */
  semanticRerank: boolean;
  semanticAlways: boolean;
  semanticWhenDirectWeak: boolean;
  semanticIndexScope: SemanticIndexScope;
}

export interface EmbeddingTestResult {
  testedAt: number;
  model: string;
  dimensions: number;
  latencyMs: number;
  batchInputSupported: true;
  queryDocumentCompatible: true;
  retentionStatus: "not_verified";
  /** Did the provider return the requested `dimensions` instead of ignoring it? */
  dimensionsHonored?: boolean;
  /** Is a returned vector already unit-length, or does the client have to normalise? */
  normalized?: boolean;
}

export interface SearchLocalState {
  settings: SearchSettings;
  embeddingConfig: EmbeddingConfig;
  persistentApiKey: string | null;
  providerTest: EmbeddingTestResult | null;
}

export interface SearchSessionState {
  apiKey: string;
  customHeaders: Record<string, string>;
}

export interface SearchStoredState {
  local: SearchLocalState;
  session: SearchSessionState;
}

export type SemanticSearchStatus = "idle" | "debouncing" | "loading" | "ready" | "empty" | "no_candidates" | "unavailable";
