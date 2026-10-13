import { OpenAICompatibleEmbeddingClient } from "../../search/embedding-client";
import { computeSemanticCompatibilityKey, semanticDocumentPrivacy } from "../../search/semantic-document";
import { createSemanticQueryCandidates, type SemanticQueryCandidate } from "../../search/semantic-query";
import type { SemanticDocumentSource } from "../../search/semantic-document";
import { readOrganizerState } from "../../storage/organizer-state";
import { readSearchState } from "../../storage/search";
import type { SemanticIndexMeta } from "../../shared/semantic-index-types";

/**
 * The shared front half of a semantic ("search by meaning") query: fresh
 * storage reads, the consent and provider-test guards, document candidate
 * building, and the index-freshness check. Callers finish the query
 * themselves because the embedding dependencies legitimately differ — the
 * search drawer retries transient failures and reads a vector cache, the
 * group manager does neither.
 */
export async function prepareSemanticTabQuery(options: {
  sources: SemanticDocumentSource[];
  meta: SemanticIndexMeta;
  /** The search drawer additionally refuses to run without explicit consent. */
  requireConsent?: boolean;
}) {
  const [latestSearch, latestOrganizer] = await Promise.all([
    readSearchState(),
    readOrganizerState(),
  ]);
  if (
    options.requireConsent &&
    (!latestSearch.local.settings.semanticEnabled ||
      latestSearch.local.settings.semanticConsentAt === null)
  ) throw new Error("Semantic search is disabled.");
  const providerTest = latestSearch.local.providerTest;
  if (!providerTest) throw new Error("Test the embedding provider before searching by meaning.");
  const privacy = semanticDocumentPrivacy(
    latestOrganizer.local.privacy,
    latestSearch.local.settings.semanticIncludeGroupNames,
  );
  const candidates: SemanticQueryCandidate[] = await createSemanticQueryCandidates(
    options.sources,
    privacy,
  );
  const config = {
    ...latestSearch.local.embeddingConfig,
    customHeaders: latestSearch.session.customHeaders,
  };
  const compatibilityKey = await computeSemanticCompatibilityKey(
    config,
    privacy,
    providerTest.dimensions,
  );
  if (compatibilityKey !== options.meta.modelKey) throw new Error("The semantic index is out of date.");
  const client = new OpenAICompatibleEmbeddingClient();
  return {
    candidates,
    config,
    compatibilityKey,
    providerTest,
    client,
    apiKey: latestSearch.session.apiKey,
    searchState: latestSearch,
    organizer: latestOrganizer,
  };
}
