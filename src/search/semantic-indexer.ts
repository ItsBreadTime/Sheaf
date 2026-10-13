import type { PrivacySettings } from "../shared/organizer-types";
import type { EmbeddingConfig } from "../shared/search-types";
import type {
  SemanticIndexMeta,
  SemanticQueueRecord,
  SemanticTabRecord,
} from "../shared/semantic-index-types";
import {
  buildSemanticDocument,
  computeSemanticCompatibilityKey,
  computeSemanticDocumentHash,
  computeSemanticEmbeddingKey,
  type SemanticDocumentSource,
} from "./semantic-document";

export interface SemanticIndexPlan {
  mappings: SemanticTabRecord[];
  queue: SemanticQueueRecord[];
  meta: SemanticIndexMeta;
}

/**
 * A cheap identity for the planning inputs: the sorted `(mappingKey, title, url,
 * group)` tuples that decide every document. One hash over the tuple list instead
 * of a document build plus two hashes per source, which is what makes it worth
 * checking before planning rather than after.
 */
export async function semanticSourceFingerprint(
  sources: readonly SemanticDocumentSource[],
): Promise<string> {
  const tuples = sources
    .map((source) => [source.mappingKey, source.title, source.url, source.groupName ?? ""].join("\u0000"))
    .sort();
  return computeSemanticDocumentHash(tuples.join("\u0001"));
}

/** Takes the tab itself, so its two IDs cannot be passed in the wrong order. */
export function semanticMappingKey(tab: { readonly id: number; readonly windowId: number }): string {
  return `window:${tab.windowId}:tab:${tab.id}`;
}

export function semanticStashMappingKey(stashId: string, sourceIndex: number): string {
  return `stash:${stashId}:tab:${sourceIndex}`;
}

export function normalizeEmbeddingVector(vector: Float32Array): Float32Array {
  let squaredMagnitude = 0;
  for (const component of vector) {
    if (!Number.isFinite(component)) throw new Error("Embedding vector contains a non-finite value.");
    squaredMagnitude += component * component;
  }
  const magnitude = Math.sqrt(squaredMagnitude);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error("Embedding vector cannot be normalized.");
  const normalized = Float32Array.from(vector, (component) => component / magnitude);
  if ([...normalized].some((component) => !Number.isFinite(component))) {
    throw new Error("Normalized embedding vector contains a non-finite value.");
  }
  return normalized;
}

export async function createSemanticIndexPlan(
  sources: readonly SemanticDocumentSource[],
  privacy: PrivacySettings,
  config: EmbeddingConfig,
  cachedEmbeddingKeys: ReadonlySet<string>,
  now = Date.now(),
  resolvedDimensions: number | null = config.dimensions,
  context: { indexScope?: "current_window" | "all_windows"; targetWindowId?: number | null } = {},
): Promise<SemanticIndexPlan> {
  const modelKey = await computeSemanticCompatibilityKey(config, privacy, resolvedDimensions);
  const mappings: SemanticTabRecord[] = [];
  const queueByKey = new Map<string, SemanticQueueRecord>();
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const source of sources) {
    const mappingKey = source.mappingKey;
    const result = buildSemanticDocument(source, privacy);
    if (result.status === "excluded") {
      mappings.push({
        mappingKey,
        target: source.target,
        documentHash: "",
        embeddingKey: null,
        status: "excluded",
        errorCode: result.errorCode,
        updatedAt: now,
      });
      continue;
    }
    const [documentHash, embeddingKey] = await Promise.all([
      computeSemanticDocumentHash(result.document),
      computeSemanticEmbeddingKey(modelKey, result.document),
    ]);
    const cached = cachedEmbeddingKeys.has(embeddingKey);
    mappings.push({
      mappingKey,
      target: source.target,
      documentHash,
      embeddingKey,
      status: cached ? "ready" : "pending",
      updatedAt: now,
    });
    if (cached) {
      cacheHits += 1;
      continue;
    }
    cacheMisses += 1;
    const queued = queueByKey.get(embeddingKey);
    if (queued) queued.mappingKeys.push(mappingKey);
    else queueByKey.set(embeddingKey, {
      key: embeddingKey,
      modelKey,
      document: result.document,
      mappingKeys: [mappingKey],
      retryCount: 0,
      nextEligibleRetryAt: now,
      createdAt: now,
    });
  }

  const ready = mappings.filter((mapping) => mapping.status === "ready").length;
  const pending = mappings.filter((mapping) => mapping.status === "pending").length;
  const excluded = mappings.filter((mapping) => mapping.status === "excluded").length;
  return {
    mappings,
    queue: [...queueByKey.values()],
    meta: {
      id: "current",
      modelKey,
      ...context,
      status: pending > 0 ? "building" : "complete",
      total: mappings.length,
      ready,
      pending,
      excluded,
      failed: 0,
      lastCompletedBatchAt: null,
      lastErrorCode: null,
      cacheHits,
      cacheMisses,
      sourceFingerprint: await semanticSourceFingerprint(sources),
      updatedAt: now,
    },
  };
}
