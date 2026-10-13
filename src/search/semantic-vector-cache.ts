import type { EmbeddingRecord } from "../shared/semantic-index-types";
import { getEmbeddingRecords } from "../storage/semantic-index";

export interface SemanticVectorCacheDependencies {
  load?: (keys: readonly string[]) => Promise<Map<string, EmbeddingRecord>>;
}

export interface SemanticVectorCacheStats {
  hits: number;
  misses: number;
}

/**
 * Popup-lifetime vector cache.
 *
 * Every semantic query used to re-read every vector from IndexedDB: at 4096
 * dimensions and 500 tabs that is roughly 8 MB of structured clone per keystroke,
 * on top of the provider round trip, and it is the part of the pipeline that
 * degrades visibly as a tab collection grows.
 *
 * Identity is the caller's guard string — the index's model key plus its last
 * update stamp. Any batch commit, rebuild, clear or configuration change moves it,
 * which drops the whole cache rather than leaving a stale vector in place. The
 * cache never invents a vector: a miss just reads through.
 */
export function createSemanticVectorCache(dependencies: SemanticVectorCacheDependencies = {}) {
  const load = dependencies.load ?? getEmbeddingRecords;
  let identity: string | null = null;
  let vectors = new Map<string, EmbeddingRecord>();
  const stats: SemanticVectorCacheStats = { hits: 0, misses: 0 };

  const invalidate = (): void => {
    vectors = new Map();
    identity = null;
  };

  return {
    /** The shape `querySemanticTabs` expects for its `readEmbeddings` dependency. */
    read: async (keys: readonly string[], guard: string): Promise<Map<string, EmbeddingRecord>> => {
      if (identity !== guard) invalidate();
      identity = guard;
      const found = new Map<string, EmbeddingRecord>();
      const missing: string[] = [];
      for (const key of keys) {
        const cached = vectors.get(key);
        if (cached) {
          found.set(key, cached);
          stats.hits += 1;
        } else {
          missing.push(key);
        }
      }
      if (missing.length === 0) return found;
      stats.misses += missing.length;
      const loaded = await load(missing);
      // Replace rather than accumulate: the guard has not moved, so anything the
      // loader returns is current, and anything it omits is gone.
      loaded.forEach((record, key) => {
        vectors.set(key, record);
        found.set(key, record);
      });
      return found;
    },
    invalidate,
    stats: (): SemanticVectorCacheStats => ({ ...stats }),
    size: (): number => vectors.size,
  };
}

const QUERY_VECTOR_CACHE_CAPACITY = 32;

/**
 * Popup-lifetime cache of query embeddings.
 *
 * Backspacing and retyping, switching scope, or reopening the drawer on the same
 * text used to buy the same vector from the provider again. A query vector depends
 * only on the provider configuration, so the guard is the compatibility key, and a
 * hit also lets the drawer skip the typing debounce.
 */
export function createQueryVectorCache(capacity = QUERY_VECTOR_CACHE_CAPACITY) {
  const vectors = new Map<string, Float32Array>();
  let lastGuard: string | null = null;
  const keyFor = (guard: string, query: string): string => `${guard}\u0000${query}`;

  return {
    embed: async (guard: string, query: string, embed: () => Promise<Float32Array>): Promise<Float32Array> => {
      lastGuard = guard;
      const key = keyFor(guard, query);
      const cached = vectors.get(key);
      if (cached) {
        // Refresh recency so the eviction below drops the least recently used query.
        vectors.delete(key);
        vectors.set(key, cached);
        return cached;
      }
      const vector = await embed();
      vectors.set(key, vector);
      while (vectors.size > capacity) vectors.delete(vectors.keys().next().value!);
      return vector;
    },
    /** Whether the query is cached under the configuration last used. */
    has: (query: string): boolean => lastGuard !== null && vectors.has(keyFor(lastGuard, query)),
    clear: (): void => {
      vectors.clear();
      lastGuard = null;
    },
    size: (): number => vectors.size,
  };
}
