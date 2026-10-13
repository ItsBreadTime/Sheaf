export const EMBEDDING_MODEL_PROFILE_VERSION = 1;

/** Which side of the retrieval pair a request belongs to. */
export type EmbeddingTaskMode = "document" | "query";

/**
 * `auto` resolves through the model-ID patterns below. Every other value is an
 * explicit user choice, which exists because a fine-tune whose name misses the
 * patterns would otherwise silently get the wrong query instruction, the wrong
 * task fields, and the wrong tail distance at once.
 */
export type EmbeddingProfileId = "auto" | "none" | "e5" | "qwen3" | "cohere" | "voyage" | "gemini";

export const EMBEDDING_PROFILE_IDS: readonly EmbeddingProfileId[] =
  ["auto", "none", "e5", "qwen3", "cohere", "voyage", "gemini"];

export interface EmbeddingModelProfile {
  id: Exclude<EmbeddingProfileId, "auto">;
  matches(modelId: string): boolean;
  formatDocument(text: string): string;
  formatQuery(query: string): string;
  /**
   * Task-typed body fields, which several providers require instead of (or as well
   * as) a text prefix: Cohere and Voyage take `input_type`, Gemini takes `taskType`.
   * They differ between the document and query calls, which a single global
   * `extraBody` cannot express — that is the bug this method exists to fix.
   */
  taskFields?(mode: EmbeddingTaskMode): Record<string, string>;
}

export function usesQwen3EmbeddingProfile(modelId: string): boolean {
  return /qwen3[-_/]embedding/i.test(modelId);
}

const e5Profile: EmbeddingModelProfile = {
  id: "e5",
  matches: (modelId) => /(^|[/_-])(?:multilingual-)?e5(?:[-_/]|$)/i.test(modelId),
  formatDocument: (text) => `passage: ${text}`,
  formatQuery: (query) => `query: ${query}`,
};

const qwen3Profile: EmbeddingModelProfile = {
  id: "qwen3",
  matches: usesQwen3EmbeddingProfile,
  formatDocument: (text) => text,
  formatQuery: (query) =>
    `Instruct: Retrieve the open or stashed browser tab that best matches the user's remembered topic, title, project intent, site, or task in any language.\nQuery:${query}`,
};

const cohereProfile: EmbeddingModelProfile = {
  id: "cohere",
  matches: (modelId) => /(^|[/_-])cohere/i.test(modelId) || /embed-(?:english|multilingual)-v\d/i.test(modelId),
  formatDocument: (text) => text,
  formatQuery: (query) => query,
  taskFields: (mode) => ({ input_type: mode === "document" ? "search_document" : "search_query" }),
};

const voyageProfile: EmbeddingModelProfile = {
  id: "voyage",
  matches: (modelId) => /(^|[/_-])voyage/i.test(modelId),
  formatDocument: (text) => text,
  formatQuery: (query) => query,
  taskFields: (mode) => ({ input_type: mode === "document" ? "document" : "query" }),
};

const geminiProfile: EmbeddingModelProfile = {
  id: "gemini",
  matches: (modelId) => /(^|[/_-])(?:gemini|text-embedding-0\d\d)/i.test(modelId),
  formatDocument: (text) => text,
  formatQuery: (query) => query,
  taskFields: (mode) => ({ taskType: mode === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY" }),
};

const unchangedProfile: EmbeddingModelProfile = {
  id: "none",
  matches: () => true,
  formatDocument: (text) => text,
  formatQuery: (query) => query,
};

/** Ordered most specific first: `qwen3-embedding` is also an `embedding` model name. */
const PROFILES = [qwen3Profile, e5Profile, cohereProfile, voyageProfile, geminiProfile, unchangedProfile] as const;

export function embeddingModelProfile(
  modelId: string,
  profileId: EmbeddingProfileId = "auto",
): EmbeddingModelProfile {
  if (profileId !== "auto") {
    return PROFILES.find((profile) => profile.id === profileId) ?? unchangedProfile;
  }
  return PROFILES.find((profile) => profile.matches(modelId)) ?? unchangedProfile;
}

/** The profile that auto-detection picks, for the settings UI to show and confirm. */
export function detectedEmbeddingProfileId(modelId: string): Exclude<EmbeddingProfileId, "auto"> {
  return embeddingModelProfile(modelId).id;
}

/**
 * Task keys a profile owns. `normalizeEmbeddingConfig` accepts a legacy `extraBody`
 * that sets one of these, but the software migrates it away rather than honouring
 * it: a single global value cannot be right for both the document and the query
 * call, so whichever the user picked, one side was wrong.
 */
export function profileOwnedTaskKeys(modelId: string, profileId: EmbeddingProfileId): readonly string[] {
  const profile = embeddingModelProfile(modelId, profileId);
  if (!profile.taskFields) return [];
  return Object.keys(profile.taskFields("document")).map((key) => key.toLocaleLowerCase());
}
