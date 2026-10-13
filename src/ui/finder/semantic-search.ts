import { safeEmbeddingErrorCode, withEmbeddingRetry } from "../../search/embedding-errors";
import { noteProviderRetryAfter } from "../../search/provider-rate-limit";
import type { SearchableStashedTab, SearchableTab } from "../../search/direct-search";
import type { SemanticDocumentSource } from "../../search/semantic-document";
import { semanticMappingKey, semanticStashMappingKey } from "../../search/semantic-indexer";
import { querySemanticTabs, type SemanticQueryResult } from "../../search/semantic-query";
import { createQueryVectorCache, createSemanticVectorCache } from "../../search/semantic-vector-cache";
import type { SemanticIndexMeta } from "../../shared/semantic-index-types";
import { prepareSemanticTabQuery } from "../action/semantic-tab-query";

// The finder's search by meaning, loaded on first use. Direct search is what the
// finder shows the moment it opens; the sanitizers, the public-suffix list, and
// the embedding client behind this module only load once a query needs them.

const queryVectorCache = createQueryVectorCache();
const semanticVectorCache = createSemanticVectorCache();

/** Whether this query's vector is already cached, so the typing debounce can be skipped. */
export function queryVectorCached(query: string): boolean {
  return queryVectorCache.has(query);
}

function semanticSources(
  openTabs: readonly SearchableTab[],
  savedTabs: readonly SearchableStashedTab[],
): SemanticDocumentSource[] {
  const open = openTabs.map((tab) => ({
    mappingKey: semanticMappingKey(tab),
    target: { kind: "open" as const, tabId: tab.id, windowId: tab.windowId },
    title: tab.title,
    url: tab.url,
    groupName: tab.groupName,
  }));
  const saved = savedTabs.map((tab) => ({
    mappingKey: semanticStashMappingKey(tab.stashId, tab.sourceIndex),
    target: { kind: "stash" as const, stashId: tab.stashId, sourceIndex: tab.sourceIndex },
    title: tab.title,
    url: tab.url,
    groupName: tab.groupName,
  }));
  return [...open, ...saved];
}

/** Runs one query; resolves to null when it was cancelled. */
export async function searchByMeaning(options: {
  query: string;
  meta: SemanticIndexMeta;
  openTabs: readonly SearchableTab[];
  savedTabs: readonly SearchableStashedTab[];
  signal: AbortSignal;
}): Promise<SemanticQueryResult[] | null> {
  const { meta } = options;
  try {
    const prepared = await prepareSemanticTabQuery({
      sources: semanticSources(options.openTabs, options.savedTabs),
      meta,
      requireConsent: true,
    });
    const response = await querySemanticTabs({
      query: options.query,
      candidates: prepared.candidates,
      meta,
      config: prepared.config,
      apiKey: prepared.apiKey,
      expectedDimensions: prepared.providerTest.dimensions,
      signal: options.signal,
      dependencies: {
        embedQuery: (text, config, apiKey, signal) => queryVectorCache.embed(prepared.compatibilityKey, text, () => withEmbeddingRetry(
          () => prepared.client.embedQuery(text, config, apiKey, signal),
          {
            attempts: 3,
            maxAddedWaitMs: 1_500,
            onRetry: ({ code, delayMs }) => {
              if (code === "rate_limited") void noteProviderRetryAfter(delayMs);
            },
          },
        )),
        readEmbeddings: (keys) => semanticVectorCache.read(keys, `${meta.modelKey ?? ""}@${meta.updatedAt}`),
      },
    });
    return response.results;
  } catch (error) {
    if (safeEmbeddingErrorCode(error) === "cancelled") return null;
    throw error;
  }
}
