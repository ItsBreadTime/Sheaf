import type { TabSearchScope } from "./direct-search";
import type { SearchStoredState } from "../shared/search-types";
import type { SemanticIndexMeta } from "../shared/semantic-index-types";

/** Why search by meaning cannot run right now, or null when it can. */
export function semanticSearchAvailability(
  searchState: SearchStoredState,
  scope: TabSearchScope,
  semanticIndexMeta: SemanticIndexMeta,
  currentTargetWindowId: number | null,
): string | null {
  const settings = searchState.local.settings;
  if (!settings.semanticEnabled || settings.semanticConsentAt === null) return "Related search is off";
  if (!searchState.local.providerTest || !searchState.local.embeddingConfig.model.trim()) return "Test the embedding provider in Settings";
  if (!semanticIndexMeta.modelKey || semanticIndexMeta.ready === 0) {
    return semanticIndexMeta.status === "building"
      ? "Indexing… 0 tabs ready"
      : semanticIndexMeta.status === "stale"
        ? "Semantic index is out of date"
        : "Build the semantic index in Settings";
  }
  if (
    semanticIndexMeta.indexScope === "current_window" &&
    semanticIndexMeta.targetWindowId !== null &&
    semanticIndexMeta.targetWindowId !== undefined &&
    currentTargetWindowId !== semanticIndexMeta.targetWindowId
  ) return "Semantic index was built for another window";
  if (scope === "all_windows" && semanticIndexMeta.indexScope === "current_window") {
    return "Build an all-windows index for all-windows related search";
  }
  return null;
}
