import type {
  ImmutableRequestBundle,
  OrganizerStoredState,
  ProviderJobResult,
} from "../../shared/organizer-types";
import type { ProposalReviewState } from "../../shared/proposal-review-types";
import type { SearchStoredState } from "../../shared/search-types";
import { EMPTY_SEMANTIC_INDEX_META, type SemanticIndexMeta } from "../../shared/semantic-index-types";
import type { SavedTabStash, TabStashSettings } from "../../shared/stash-types";
import type { WindowCaptureViewState } from "../../shared/types";
import { DEFAULT_TAB_STASH_SETTINGS } from "../../storage/stashes";
import { DEFAULT_EMBEDDING_CONFIG, DEFAULT_SEARCH_SETTINGS } from "../../storage/search";

/**
 * The popup state more than one module reads or writes. main.ts loads and
 * redraws it; the panel modules import it here instead of reaching it through
 * accessor pairs in their contexts. State only one module uses stays in that
 * module.
 */
export const popupState = {
  targetWindowId: null as number | null,
  viewState: {
    editor: null,
    editorLease: null,
    transactionRun: null,
    undoPoint: null,
  } as WindowCaptureViewState,
  organizerData: null as OrganizerStoredState | null,
  immutableRequest: null as ImmutableRequestBundle | null,
  proposalReview: null as ProposalReviewState | null,
  providerJob: null as ProviderJobResult | null,
  providerReady: false,
  searchState: {
    local: {
      settings: { ...DEFAULT_SEARCH_SETTINGS },
      embeddingConfig: { ...DEFAULT_EMBEDDING_CONFIG },
      persistentApiKey: null,
      providerTest: null,
    },
    session: { apiKey: "", customHeaders: {} },
  } as SearchStoredState,
  semanticIndexMeta: { ...EMPTY_SEMANTIC_INDEX_META } as SemanticIndexMeta,
  savedStashes: [] as SavedTabStash[],
  stashSettings: { ...DEFAULT_TAB_STASH_SETTINGS } as TabStashSettings,
  notice: null as { tone: "error" | "info" | "success"; text: string } | null,
  /** Focus key to restore after the next render. */
  pendingFocusKey: null as string | null,
  discardedPlanReason: null as string | null,
  /** Which utility drawer is open (at most one). */
  searchOpen: false,
  groupsOpen: false,
  stashesOpen: false,
};
