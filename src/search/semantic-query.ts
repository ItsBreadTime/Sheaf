import type { OpenAICompatibleEmbeddingClient } from "./embedding-client";
import { normalizeEmbeddingVector } from "./semantic-indexer";
import type { EmbeddingConfig } from "../shared/search-types";
import type { PrivacySettings } from "../shared/organizer-types";
import type {
  EmbeddingRecord,
  SemanticIndexMeta,
  SemanticIndexTarget,
  SemanticTabRecord,
} from "../shared/semantic-index-types";
import {
  getEmbeddingRecords,
  quarantineSemanticMappings,
  readSemanticTabRecords,
} from "../storage/semantic-index";
import {
  buildSemanticDocument,
  computeSemanticDocumentHash,
  type SemanticDocumentSource,
} from "./semantic-document";
import { embeddingModelProfile, type EmbeddingProfileId } from "./model-profiles";
import { redactQueryText } from "../privacy/sanitize-text";

export interface SemanticQueryCandidate {
  mappingKey: string;
  target: SemanticIndexTarget;
  documentHash: string;
}

export interface SemanticQueryResult {
  mappingKey: string;
  target: SemanticIndexTarget;
  score: number;
}

export interface SemanticQueryResponse {
  results: SemanticQueryResult[];
  latencyMs: number;
  indexedCandidates: number;
  /** Records the provider changed shape under, quarantined instead of failing the query. */
  quarantined: number;
}

/**
 * The provider returned a different dimension than the index was built with.
 *
 * This is not a corrupt-record problem but a configuration one: the remedy is to
 * rebuild, so the popup needs to be able to name it rather than showing a generic
 * failure. The compatibility key cannot catch it, because it records the dimension
 * from the last provider test rather than the one the provider is using now.
 */
export class SemanticDimensionDriftError extends Error {
  constructor(readonly expected: number, readonly received: number) {
    super(`The embedding provider returned ${received} dimensions but the index was built with ${expected}; rebuild the semantic index.`);
    this.name = "SemanticDimensionDriftError";
  }
}

interface SemanticQueryDependencies {
  embedQuery: OpenAICompatibleEmbeddingClient["embedQuery"];
  readMappings?: typeof readSemanticTabRecords;
  readEmbeddings?: typeof getEmbeddingRecords;
  quarantineMappings?: (mappingKeys: readonly string[], errorCode: string) => Promise<unknown>;
  now?: () => number;
}

const SEMANTIC_QUERY_LIMIT = 10;
const SEMANTIC_QUERY_MIN_SCORE = 0.35;
const SEMANTIC_QUERY_DEFAULT_MAX_TAIL_DISTANCE = 0.14;
const SEMANTIC_QUERY_QWEN3_MAX_TAIL_DISTANCE = 0.06;

/**
 * The tail distance is chosen by the *resolved* profile rather than by a second
 * model-ID regex: a fine-tune that does not match the Qwen3 pattern used to get
 * the wrong query instruction and the wrong cutoff together, and an explicit
 * profile choice now moves both at once.
 */
export function semanticQueryMaxTailDistance(
  modelId: string,
  profileId: EmbeddingProfileId = "auto",
): number {
  return embeddingModelProfile(modelId, profileId).id === "qwen3"
    ? SEMANTIC_QUERY_QWEN3_MAX_TAIL_DISTANCE
    : SEMANTIC_QUERY_DEFAULT_MAX_TAIL_DISTANCE;
}

/**
 * Only the Qwen3 profile ships a dedicated score floor. Cosine ranges are a property of
 * the model — E5's card notes its scores sit between roughly 0.7 and 1.0 even for
 * unrelated text — so for every other profile 0.35 may reject nothing at all, and a
 * query that matches no tab still returns the least unrelated ones.
 */
export function semanticQueryRequiresOutlier(
  modelId: string,
  profileId: EmbeddingProfileId = "auto",
): boolean {
  return embeddingModelProfile(modelId, profileId).id !== "qwen3";
}

/** Robust standard deviations the top score must clear above the query's median score. */
const SEMANTIC_QUERY_MIN_OUTLIER_Z = 3;
/** Below this many scored tabs the median and spread say nothing useful. */
const SEMANTIC_QUERY_OUTLIER_MIN_POOL = 10;

function sortedMedian(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * A scale-free relevance gate: the best tab must stand out from this query's own
 * score distribution, measured with the median and the median absolute deviation
 * so a cluster of genuinely related tabs cannot drag the baseline up. It passes
 * whenever it cannot judge (a small pool, or no spread at all), so it can only
 * remove results from a query where nothing stood out.
 */
export function topScoreStandsOut(
  scores: readonly number[],
  minZ = SEMANTIC_QUERY_MIN_OUTLIER_Z,
): boolean {
  if (scores.length < SEMANTIC_QUERY_OUTLIER_MIN_POOL) return true;
  const sorted = [...scores].sort((left, right) => left - right);
  const median = sortedMedian(sorted);
  const deviations = sorted.map((score) => Math.abs(score - median)).sort((left, right) => left - right);
  const sigma = 1.4826 * sortedMedian(deviations);
  if (!(sigma > 0)) return true;
  return (sorted[sorted.length - 1]! - median) / sigma >= minZ;
}

/**
 * Documents only change when a tab's title, URL, or group (or the privacy
 * settings) change, so each query reuses the previous query's sanitizing and
 * hashing for every unchanged tab. Each call keeps only the entries it used,
 * so closed tabs fall out and the cache never outgrows one snapshot.
 */
let candidateDocumentCache = new Map<string, Promise<string | null>>();

function candidateCacheKey(source: SemanticDocumentSource, privacyKey: string): string {
  return [privacyKey, source.mappingKey, source.title, source.url, source.groupName ?? ""].join("\u0000");
}

export async function createSemanticQueryCandidates(
  sources: readonly SemanticDocumentSource[],
  privacy: PrivacySettings,
): Promise<SemanticQueryCandidate[]> {
  const privacyKey = JSON.stringify(privacy);
  const previous = candidateDocumentCache;
  const next = new Map<string, Promise<string | null>>();
  candidateDocumentCache = next;
  const hashes = sources.map((source) => {
    const key = candidateCacheKey(source, privacyKey);
    let hash = next.get(key) ?? previous.get(key);
    if (!hash) {
      const document = buildSemanticDocument(source, privacy);
      hash = document.status === "ready" ? computeSemanticDocumentHash(document.document) : Promise.resolve(null);
    }
    next.set(key, hash);
    return hash;
  });
  try {
    const resolved = await Promise.all(hashes);
    return sources.flatMap((source, index) => {
      const documentHash = resolved[index];
      return documentHash ? [{ mappingKey: source.mappingKey, target: source.target, documentHash }] : [];
    });
  } catch (error) {
    // A failed hash must not be served to the next query.
    if (candidateDocumentCache === next) candidateDocumentCache = new Map();
    throw error;
  }
}

/**
 * Whether a stored vector can be ranked: the expected dimension, finite, not
 * all zeros, and unit length. Vector records come from the popup-lifetime vector
 * cache as the same objects query after query, so each is checked once per
 * expected dimension instead of O(dimensions) work per tab per query.
 */
const vectorUsability = new WeakMap<EmbeddingRecord, { dimensions: number; usable: boolean }>();

function embeddingIsUsable(embedding: EmbeddingRecord, expectedDimensions: number): boolean {
  const cached = vectorUsability.get(embedding);
  if (cached && cached.dimensions === expectedDimensions) return cached.usable;
  const squaredMagnitude = embedding.vector.reduce((sum, component) => sum + component * component, 0);
  const usable = !(
    embedding.dimensions !== expectedDimensions ||
    embedding.dimensions !== embedding.vector.length ||
    embedding.vector.some((component) => !Number.isFinite(component)) ||
    embedding.vector.every((component) => component === 0) ||
    !Number.isFinite(squaredMagnitude) ||
    Math.abs(squaredMagnitude - 1) > 0.001
  );
  vectorUsability.set(embedding, { dimensions: expectedDimensions, usable });
  return usable;
}

function dot(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error("Embedding dimension mismatch.");
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index]! * right[index]!;
  }
  return score;
}

export function rankSemanticMappings(
  queryVector: Float32Array,
  mappings: readonly SemanticTabRecord[],
  embeddings: ReadonlyMap<string, EmbeddingRecord>,
  candidates: readonly SemanticQueryCandidate[],
  limit = SEMANTIC_QUERY_LIMIT,
  maxTailDistance = SEMANTIC_QUERY_DEFAULT_MAX_TAIL_DISTANCE,
  requireOutlier = false,
): SemanticQueryResult[] {
  const candidatesByKey = new Map(candidates.map((candidate) => [candidate.mappingKey, candidate]));
  const normalizedQuery = normalizeEmbeddingVector(queryVector);
  const ranked = mappings.flatMap((mapping) => {
    if (
      mapping.status !== "ready" ||
      !mapping.embeddingKey ||
      !candidatesByKey.has(mapping.mappingKey) ||
      candidatesByKey.get(mapping.mappingKey)?.documentHash !== mapping.documentHash
    ) return [];
    const embedding = embeddings.get(mapping.embeddingKey);
    if (!embedding) return [];
    const score = dot(normalizedQuery, embedding.vector);
    return Number.isFinite(score)
      ? [{ mappingKey: mapping.mappingKey, target: mapping.target, score }]
      : [];
  }).sort((left, right) =>
    right.score - left.score || left.mappingKey.localeCompare(right.mappingKey),
  );
  const topScore = ranked[0]?.score;
  if (topScore === undefined || topScore < SEMANTIC_QUERY_MIN_SCORE) return [];
  if (requireOutlier && !topScoreStandsOut(ranked.map((result) => result.score))) return [];
  return ranked
    .filter((result) =>
      result.score >= SEMANTIC_QUERY_MIN_SCORE &&
      topScore - result.score <= maxTailDistance,
    )
    .slice(0, Math.max(1, limit));
}

export async function querySemanticTabs(options: {
  query: string;
  candidates: readonly SemanticQueryCandidate[];
  meta: SemanticIndexMeta;
  config: EmbeddingConfig;
  apiKey: string;
  expectedDimensions: number;
  signal?: AbortSignal;
  dependencies: SemanticQueryDependencies;
}): Promise<SemanticQueryResponse> {
  // The search box is free text: redact identifiers before the query leaves
  // the device (a pasted token or email should not egress verbatim).
  const query = redactQueryText(options.query);
  if (!query) return { results: [], latencyMs: 0, indexedCandidates: 0, quarantined: 0 };
  if (!options.meta.modelKey || options.meta.ready === 0) {
    throw new Error("The semantic index has no ready tabs.");
  }
  const candidatesByKey = new Map(options.candidates.map((candidate) => [candidate.mappingKey, candidate]));
  const readMappings = options.dependencies.readMappings ?? readSemanticTabRecords;
  const readEmbeddings = options.dependencies.readEmbeddings ?? getEmbeddingRecords;
  const mappings = (await readMappings([...candidatesByKey.keys()], options.meta.total)).filter((mapping) =>
    mapping.status === "ready" &&
    mapping.embeddingKey !== null &&
    candidatesByKey.has(mapping.mappingKey) &&
    candidatesByKey.get(mapping.mappingKey)?.documentHash === mapping.documentHash,
  );
  const embeddingKeys = [...new Set(mappings.flatMap((mapping) => mapping.embeddingKey ? [mapping.embeddingKey] : []))];
  const embeddings = await readEmbeddings(embeddingKeys);
  const unusable = new Set<string>();
  for (const embedding of embeddings.values()) {
    // A model change is a global incompatibility, not one record's problem: no
    // subset of the old vectors is valid against a new model's space.
    if (embedding.modelKey !== options.meta.modelKey) {
      throw new Error("The semantic index is incompatible with the current provider.");
    }
    if (!embeddingIsUsable(embedding, options.expectedDimensions)) unusable.add(embedding.key);
  }
  const quarantinedKeys = mappings.flatMap((mapping) =>
    mapping.embeddingKey !== null && unusable.has(mapping.embeddingKey) ? [mapping.mappingKey] : []);
  let quarantined = 0;
  if (quarantinedKeys.length > 0) {
    // One write, before ranking, so the bad records stop being re-read on every
    // query. They stay out of this ranking too, via `unusable` above.
    const written = await (options.dependencies.quarantineMappings ?? quarantineSemanticMappings)(
      quarantinedKeys,
      "invalid_record",
    );
    quarantined = typeof written === "number" ? written : quarantinedKeys.length;
  }
  const availableMappings = mappings.filter((mapping) =>
    mapping.embeddingKey !== null && embeddings.has(mapping.embeddingKey) && !unusable.has(mapping.embeddingKey),
  );
  if (availableMappings.length === 0) return { results: [], latencyMs: 0, indexedCandidates: 0, quarantined };
  const now = options.dependencies.now ?? (() => performance.now());
  const startedAt = now();
  const queryVector = await options.dependencies.embedQuery(
    query,
    options.config,
    options.apiKey,
    options.signal,
  );
  if (queryVector.length !== options.expectedDimensions) {
    throw new SemanticDimensionDriftError(options.expectedDimensions, queryVector.length);
  }
  const results = rankSemanticMappings(
    queryVector,
    availableMappings,
    embeddings,
    options.candidates,
    SEMANTIC_QUERY_LIMIT,
    semanticQueryMaxTailDistance(options.config.model, options.config.modelProfile),
    semanticQueryRequiresOutlier(options.config.model, options.config.modelProfile),
  );
  return {
    results,
    latencyMs: Math.max(0, Math.round(now() - startedAt)),
    indexedCandidates: availableMappings.length,
    quarantined,
  };
}
