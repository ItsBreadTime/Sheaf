import { SemanticSearchFailureGate } from "../../search/semantic-search-failure";
import { safeEmbeddingErrorCode, withEmbeddingRetry } from "../../search/embedding-errors";
import { createQueryVectorCache, createSemanticVectorCache } from "../../search/semantic-vector-cache";
import { noteProviderRetryAfter } from "../../search/provider-rate-limit";
import {
  rerankSemanticResults,
  shouldRerankSemanticResults,
  type RerankCandidate,
} from "../../search/semantic-rerank";
import { SemanticDimensionDriftError } from "../../search/semantic-query";
import {
  buildStashedSearchSnapshot,
  directResultsAreStrong,
  directStashedTabSearch,
  directTabSearch,
  type DirectStashedTabSearchResult,
  type DirectTabSearchResult,
  type SearchableStashedTab,
  type SearchableTab,
  type TabSearchScope,
} from "../../search/direct-search";
import {
  querySemanticTabs,
  type SemanticQueryCandidate,
  type SemanticQueryResponse,
  type SemanticQueryResult,
} from "../../search/semantic-query";
import { prepareSemanticTabQuery } from "./semantic-tab-query";
import {
  computeSemanticCompatibilityKey,
  semanticDocumentPrivacy,
  buildSemanticDocument,
  type SemanticDocumentSource,
} from "../../search/semantic-document";
import { semanticMappingKey, semanticStashMappingKey } from "../../search/semantic-indexer";
import { readSearchPicks, readSearchState, recordSearchPickInSession } from "../../storage/search";
import {
  openSearchPickKey,
  searchPickBoosts,
  stashSearchPickKey,
  type SearchPick,
} from "../../search/search-picks";
import { readTabStashes } from "../../storage/stashes";
import { captureOpenTabSnapshot } from "../../search/open-tab-snapshot";
import { semanticSearchAvailability } from "../../search/semantic-availability";
import { readOrganizerState } from "../../storage/organizer-state";
import type {
  StashSearchEditOperation,
  StashSearchEditPreview,
} from "../../shared/stash-types";
import {
  canonicalExactUrl,
  possibleDuplicateUrl,
  resolveStashTabReferences,
  stashSelectionResolutionToken,
  type StashTabReference,
} from "../../search/stash-selection";
import { isBlankNewTabUrl } from "../../browser/domain-policy";
import type {
  SearchSettings,
  SemanticSearchStatus,
} from "../../shared/search-types";
import type {
  WindowCaptureMessage,
  SemanticTab,
} from "../../shared/types";
import type { WindowCaptureResponseFor } from "../../shared/message-state";
import type { OrganizerStoredState } from "../../shared/organizer-types";
import { SEMANTIC_SEARCH_DEBOUNCE_MS } from "../../shared/constants";
import { popupState } from "./popup-store";

// DOM and action helpers owned by main.ts, injected so the search drawer stays a
// leaf module without importing the main entry. Shared state is in popup-store.
export interface TabSearchPanelContext {
  element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K];
  input(value: string, type?: HTMLInputElement["type"]): HTMLInputElement;
  field(label: string, control: HTMLElement, help?: string): HTMLElement;
  button(
    label: string,
    variant: "primary" | "secondary" | "quiet" | "danger",
    onClick: () => void,
    options?: { disabled?: boolean; actionName?: string; busyLabel?: string },
  ): HTMLButtonElement;
  formatCount(count: number, singular: string, plural?: string): string;
  iconButton(
    label: string,
    icon: "search",
    onClick: () => void,
    options?: { disabled?: boolean; actionName?: string; busyLabel?: string },
  ): HTMLButtonElement;
  send<Message extends WindowCaptureMessage>(message: Message): Promise<WindowCaptureResponseFor<Message>>;
  perform(actionName: string, action: () => Promise<void>): Promise<void>;
  render(): void;
  /** Rebuilds only the open drawer, for changes that stay inside it. */
  redraw(): void;
  actionRoot(): HTMLElement;
  /** The popup's prime action, kept reachable while Search owns the column. */
  openAdvancedSettings(section?: string): void;
  semanticIndexRetryDetail(): string | null;
  buildSemanticIndex(): Promise<void>;
  cancelSemanticIndexBuild(): Promise<void>;
  semanticIndexBuildRequirement(): string | null;
  revealStashFromSearch(stashId: string): void;
  semanticSearchFailureLabel(code: string | null): string;
  searchTabUserProtectionReasons(tab: SearchableTab): string[];
  protectSearchTab(tab: SearchableTab, permanence: "session" | "permanent"): Promise<void>;
  openProtectionManager(): void;
  check(
    label: string,
    copy: string,
    checked: boolean,
  ): { wrapper: HTMLLabelElement; control: HTMLInputElement };
}

let panelContext: TabSearchPanelContext | null = null;

// Registers the panel context once at startup so render-time helpers such as
// closableBlankTabs work before the search drawer has ever rendered — main.ts
// renders review and result views that read tab-search state on every path.
// renderTabSearch and refreshSearchSnapshots re-set the same object.
export function setTabSearchPanelContext(context: TabSearchPanelContext): void {
  panelContext = context;
}

function ui(): TabSearchPanelContext {
  if (!panelContext) throw new Error("The tab search panel context is unavailable.");
  return panelContext;
}

export function setSearchScope(scope: TabSearchScope): void {
  searchScope = scope;
}

export function setSearchAutofocusPending(value: boolean): void {
  searchAutofocusPending = value;
}

export function resetSearchSelection(): void {
  searchSelectedIndex = 0;
}

export function semanticSearchPending(): boolean {
  return semanticSearchController !== null || semanticSearchTimer !== null || semanticSearchState.status !== "idle";
}

export function redrawSearchPanel(): void {
  semanticSearchRedraw?.();
}

export function clearSearchRedraw(): void {
  semanticSearchRedraw = null;
}

export function clearSearchFailureGate(): void {
  semanticFailure.clear();
}

// True when the stashes drawer should reveal a specific stashed tab that a
// search result pointed at; the target is written by the search drawer.
export function stashRevealMatches(stashId: string, stashTabId: string): boolean {
  return stashRevealTarget?.stashId === stashId && stashRevealTarget.stashTabId === stashTabId;
}

let searchSnapshot: SearchableTab[] = [];
let searchPicks: SearchPick[] = [];
let stashedSearchSnapshot: SearchableStashedTab[] = [];
let searchSnapshotStatus: "idle" | "loading" | "ready" | "error" = "idle";
let searchQuery = "";
let searchScope: TabSearchScope = "current_window";
let searchSelectedIndex = 0;
let searchAutofocusPending = false;
let stashRevealTarget: { stashId: string; stashTabId: string } | null = null;
interface SearchSelectedItem {
  reference: StashTabReference;
  title: string;
  url: string;
  stashName: string;
  groupName: string | null;
  sourceQueries: string[];
}
const searchBatchSelection = new Map<string, SearchSelectedItem>();
let searchSelectionMode = false;
let searchSelectionTrayOpen = false;
let searchOpenPreview: {
  destination: "current_window" | "new_window";
  duplicateHandling: "reuse" | "skip" | "duplicate";
  exactOpen: number;
  possibleDuplicates: number;
  changed: number;
  stale: number;
} | null = null;
let searchRangeAnchor = -1;
let searchWorkspaceDraft: { name: string; preserveGroups: boolean; changed: number; stale: number; reviewedSelectionToken: string } | null = null;
let searchEditDraft: {
  operation: StashSearchEditOperation;
  targetStashId: string | null;
  preview: StashSearchEditPreview | null;
} | null = null;
let searchEditUndo: { transactionId: string; message: string } | null = null;
let searchEditPendingFocus: "operation" | "target" | "confirm" | "trigger" | null = null;
let semanticSearchState: {
  key: string | null;
  status: SemanticSearchStatus;
  results: SemanticQueryResult[];
  latencyMs: number | null;
  /**
   * The background second opinion's round trip, when one landed. Kept apart from
   * `latencyMs` because the user never waited for it: the vector order was on screen.
   */
  rerankLatencyMs?: number | null;
  indexedCandidates: number | null;
  /** Why the last attempt failed, so the UI can name the class and the remedy. */
  errorCode: string | null;
} = { key: null, status: "idle", results: [], latencyMs: null, indexedCandidates: null, errorCode: null };
let semanticSearchController: AbortController | null = null;
/** The post-render second opinion, tracked separately so a new query can cancel it. */
let semanticRerankController: AbortController | null = null;
let semanticSearchTimer: ReturnType<typeof setTimeout> | null = null;
let semanticSearchGeneration = 0;
let semanticSearchRedraw: (() => void) | null = null;
const semanticFailure = new SemanticSearchFailureGate(() => semanticSearchRedraw?.());
const semanticVectorCache = createSemanticVectorCache();
const queryVectorCache = createQueryVectorCache();

function captureSearchSnapshot(): Promise<SearchableTab[]> {
  return captureOpenTabSnapshot(popupState.targetWindowId);
}

export async function refreshSearchSnapshots(context: TabSearchPanelContext, runSemanticMaintenance = true): Promise<void> {
  panelContext = context;
  searchSnapshotStatus = "loading";
  try {
    const [openTabs, stashes, nextSearchState, nextOrganizerData, picks] = await Promise.all([
      captureSearchSnapshot(),
      readTabStashes(),
      readSearchState(),
      readOrganizerState(),
      // Learned picks only reorder results; losing them must not lose the search.
      readSearchPicks().catch(() => []),
    ]);
    searchPicks = picks;
    popupState.searchState = nextSearchState;
    popupState.organizerData = nextOrganizerData;
    const semanticState = runSemanticMaintenance && popupState.searchState.local.settings.semanticEnabled
      ? await ui().send({ type: "semantic-index:get-state" })
      : null;
    searchSnapshot = openTabs;
    popupState.savedStashes = stashes;
    stashedSearchSnapshot = buildStashedSearchSnapshot(stashes);
    if (semanticState?.semanticIndexMeta) popupState.semanticIndexMeta = semanticState.semanticIndexMeta;
    searchSnapshotStatus = "ready";
  } catch (error) {
    searchSnapshotStatus = "error";
    throw error;
  }
}

function semanticSearchKey(query = searchQuery, scope = searchScope): string {
  return `${scope}:${query.normalize("NFKC").trim().toLocaleLowerCase()}`;
}

export function cancelSemanticSearch(clear = true): void {
  semanticSearchGeneration += 1;
  if (semanticSearchTimer) clearTimeout(semanticSearchTimer);
  semanticSearchTimer = null;
  semanticSearchController?.abort();
  semanticSearchController = null;
  // The rerank outlives the search that started it, so it needs its own handle: without
  // one, a new keystroke would leave the old model call running to its deadline.
  semanticRerankController?.abort();
  semanticRerankController = null;
  if (clear) semanticSearchState = { key: null, status: "idle", results: [], latencyMs: null, indexedCandidates: null, errorCode: null };
}

function semanticSourcesForSearch(scope: TabSearchScope): SemanticDocumentSource[] {
  const openSources = (scope === "all_windows"
    ? searchSnapshot
    : searchSnapshot.filter((tab) => tab.windowId === popupState.targetWindowId)
  ).map((tab) => ({
    mappingKey: semanticMappingKey(tab),
    target: { kind: "open" as const, tabId: tab.id, windowId: tab.windowId },
    title: tab.title,
    url: tab.url,
    groupName: tab.groupName,
  }));
  const stashSources = stashedSearchSnapshot.map((tab) => ({
    mappingKey: semanticStashMappingKey(tab.stashId, tab.sourceIndex),
    target: { kind: "stash" as const, stashId: tab.stashId, sourceIndex: tab.sourceIndex },
    title: tab.title,
    url: tab.url,
    groupName: tab.groupName,
  }));
  return [...openSources, ...stashSources];
}

export { semanticSearchAvailability } from "../../search/semantic-availability";

/** The index's identity: both parts must match for a cached vector to be current. */
function semanticVectorCacheGuard(): string {
  const semanticIndexMeta = popupState.semanticIndexMeta;
  return `${semanticIndexMeta.modelKey ?? ""}@${semanticIndexMeta.updatedAt}`;
}

/**
 * Optional second opinion on a near-tie, applied after the results are already visible.
 *
 * Gated on the failure shape it addresses — a top-1/top-2 margin at or below 0.02,
 * with no strong direct results to answer the query instead — and on its own consent.
 * Every way it can go wrong ends in the vector order that is already on screen,
 * because a rerank is an improvement, never a dependency.
 */
async function refineSemanticSearchResults(options: {
  captured: { query: string; scope: TabSearchScope; key: string; generation: number };
  response: SemanticQueryResponse;
  candidates: readonly SemanticQueryCandidate[];
  organizerData: OrganizerStoredState;
  settings: SearchSettings;
  compatibilityKey: string;
}): Promise<void> {
  const results = options.response.results;
  if (!options.settings.semanticRerank || results.length < 2) return;
  const scoped = options.captured.scope === "all_windows"
    ? searchSnapshot
    : searchSnapshot.filter((tab) => tab.windowId === popupState.targetWindowId);
  const directRows = [
    ...directTabSearch(scoped, options.captured.query, {
      includeGroupNames: options.settings.includeGroupNames,
      limit: 10,
    }).map((result) => ({ id: `open:${result.tab.id}`, tier: result.tier })),
    ...directStashedTabSearch(stashedSearchSnapshot, options.captured.query, {
      includeGroupNames: options.settings.includeGroupNames,
      limit: 10,
    }).map((result) => ({ id: `stash:${result.tab.sourceIndex}`, tier: result.tier })),
  ];
  const margin = results[0]!.score - results[1]!.score;
  if (!shouldRerankSemanticResults({
    margin,
    directResultsWeak: !directResultsAreStrong(directRows),
  })) return;
  // The candidate text is the indexed document, which is the only text this feature
  // may send: it is what the embedder already received, and nothing more.
  const documents = semanticSourcesForSearch(options.captured.scope);
  const documentById = new Map(documents.flatMap((source) => {
    const built = buildSemanticDocument(
      source,
      semanticDocumentPrivacy(
        options.organizerData.local.privacy,
        options.settings.semanticIncludeGroupNames,
      ),
    );
    return built.status === "ready" ? [[source.mappingKey, built.document] as const] : [];
  }));
  const shortlist: RerankCandidate[] = results.flatMap((result: SemanticQueryResult) => {
    const document = documentById.get(result.mappingKey);
    return document ? [{ id: result.mappingKey, document }] : [];
  });
  const controller = new AbortController();
  semanticRerankController = controller;
  const outcome = await rerankSemanticResults({
    query: options.captured.query,
    results,
    candidates: shortlist,
    config: options.organizerData.local.provider,
    apiKey: options.organizerData.session.apiKey,
    signal: controller.signal,
  });
  if (semanticRerankController === controller) semanticRerankController = null;
  if (!outcome.reranked) return;
  // The user may have typed on, switched scope, or closed the popup while the model was
  // thinking. Applying the order to a query it did not answer for would be a reorder
  // nobody asked for, so every guard that admitted the search has to still hold.
  if (
    controller.signal.aborted ||
    options.captured.generation !== semanticSearchGeneration ||
    options.captured.key !== semanticSearchKey() ||
    !popupState.searchOpen ||
    semanticSearchState.key !== options.captured.key ||
    semanticSearchState.status !== "ready"
  ) return;
  const [confirmedSearchState] = await Promise.all([readSearchState()]);
  if (
    options.captured.generation !== semanticSearchGeneration ||
    options.captured.key !== semanticSearchKey() ||
    !popupState.searchOpen ||
    !confirmedSearchState.local.settings.semanticEnabled ||
    confirmedSearchState.local.settings.semanticConsentAt === null ||
    !confirmedSearchState.local.settings.semanticRerank
  ) return;
  semanticSearchState = {
    ...semanticSearchState,
    results: outcome.results,
    // Reported apart from the vector latency: the user waited for the first number,
    // and the second one is a background improvement that arrived after the fact.
    latencyMs: semanticSearchState.latencyMs,
    rerankLatencyMs: outcome.latencyMs,
  };
  semanticSearchRedraw?.();
}

async function executeSemanticSearch(captured: {
  query: string;
  scope: TabSearchScope;
  key: string;
  generation: number;
}): Promise<void> {
  const controller = new AbortController();
  semanticSearchController = controller;
  semanticSearchState = { key: captured.key, status: "loading", results: [], latencyMs: null, indexedCandidates: null, errorCode: null };
  semanticSearchRedraw?.();
  try {
    const prepared = await prepareSemanticTabQuery({
      sources: semanticSourcesForSearch(captured.scope),
      meta: popupState.semanticIndexMeta,
      requireConsent: true,
    });
    const response = await querySemanticTabs({
      query: captured.query,
      candidates: prepared.candidates,
      meta: popupState.semanticIndexMeta,
      config: prepared.config,
      apiKey: prepared.apiKey,
      expectedDimensions: prepared.providerTest.dimensions,
      signal: controller.signal,
      dependencies: {
        // A single transient 429 used to cost the user their search for 20 seconds
        // while a background build retried happily; the same request is retried here.
        embedQuery: (query, config, apiKey, signal) => queryVectorCache.embed(prepared.compatibilityKey, query, () => withEmbeddingRetry(
          () => prepared.client.embedQuery(query, config, apiKey, signal),
          {
            attempts: 3,
            maxAddedWaitMs: 1_500,
            // Tell the background build to back off too: it uses the same key, and
            // its batches are what make a rate limit worse.
            onRetry: ({ code, delayMs }) => {
              if (code === "rate_limited") void noteProviderRetryAfter(delayMs);
            },
          },
        )),
        readEmbeddings: (keys) => semanticVectorCache.read(keys, semanticVectorCacheGuard()),
      },
    });
    const [confirmedSearchState, confirmedOrganizerData] = await Promise.all([
      readSearchState(),
      readOrganizerState(),
    ]);
    const confirmedConfig = {
      ...confirmedSearchState.local.embeddingConfig,
      customHeaders: confirmedSearchState.session.customHeaders,
    };
    const confirmedDimensions = confirmedSearchState.local.providerTest?.dimensions ?? null;
    const confirmedCompatibilityKey = confirmedDimensions === null
      ? null
      : await computeSemanticCompatibilityKey(
          confirmedConfig,
          semanticDocumentPrivacy(
            confirmedOrganizerData.local.privacy,
            confirmedSearchState.local.settings.semanticIncludeGroupNames,
          ),
          confirmedDimensions,
        );
    if (
      controller.signal.aborted ||
      captured.generation !== semanticSearchGeneration ||
      captured.key !== semanticSearchKey() ||
      !popupState.searchOpen ||
      !confirmedSearchState.local.settings.semanticEnabled ||
      confirmedSearchState.local.settings.semanticConsentAt === null ||
      confirmedCompatibilityKey !== prepared.compatibilityKey
    ) return;
    // The vector order is rendered first, always: it is already good enough to use, and
    // the cost of waiting for a second opinion is real. On a reasoning organizer model
    // the rerank cannot answer inside any budget a search may spend, so blocking would
    // make every gated search slower for no gain at all. The rerank therefore runs
    // after the results are on screen, and only ever reorders the same query's results.
    semanticSearchState = {
      key: captured.key,
      status: response.indexedCandidates === 0
        ? "no_candidates"
        : response.results.length > 0 ? "ready" : "empty",
      results: response.results,
      latencyMs: response.latencyMs,
      indexedCandidates: response.indexedCandidates,
      // Quarantined records are reported, not hidden: the user needs to know the
      // index has holes and that rebuilding is what closes them.
      errorCode: response.quarantined > 0 ? "invalid_record" : null,
    };
    semanticSearchRedraw?.();
    semanticFailure.clear();
    // Quarantined records are repaired by the next reconcile, so ask for one
    // rather than waiting for a tab change to trigger it.
    if (response.quarantined > 0) void ui().send({ type: "semantic-index:resume" });
    void refineSemanticSearchResults({
      captured,
      response,
      candidates: prepared.candidates,
      organizerData: prepared.organizer,
      settings: prepared.searchState.local.settings,
      compatibilityKey: prepared.compatibilityKey,
    });
  } catch (error) {
    if (controller.signal.aborted || captured.generation !== semanticSearchGeneration) return;
    const drift = error instanceof SemanticDimensionDriftError ? error : null;
    const code = drift ? "configuration_changed" : safeEmbeddingErrorCode(error);
    if (code === "cancelled") return;
    semanticSearchState = {
      key: captured.key,
      status: "unavailable",
      results: [],
      latencyMs: null,
      indexedCandidates: null,
      errorCode: code,
    };
    // Permanent classes block everything until settings change; transient ones cool
    // down this query only, and doubling on repeats.
    semanticFailure.note(captured.key, code);
  } finally {
    if (semanticSearchController === controller) semanticSearchController = null;
    semanticSearchRedraw?.();
  }
}

function scheduleSemanticSearch(explicit: boolean): void {
  const query = searchQuery.normalize("NFKC").trim();
  const availability = semanticSearchAvailability(popupState.searchState, searchScope, popupState.semanticIndexMeta, popupState.targetWindowId);
  if (!query || availability || semanticFailure.blocks(semanticSearchKey(query, searchScope))) return;
  cancelSemanticSearch(false);
  const generation = semanticSearchGeneration;
  const captured = { query, scope: searchScope, key: semanticSearchKey(query, searchScope), generation };
  semanticSearchState = { key: captured.key, status: explicit ? "loading" : "debouncing", results: [], latencyMs: null, indexedCandidates: null, errorCode: null };
  // A cached query costs no provider call, so there is nothing to debounce.
  if (explicit || queryVectorCache.has(query)) {
    void executeSemanticSearch(captured);
    return;
  }
  semanticSearchTimer = setTimeout(() => {
    semanticSearchTimer = null;
    void executeSemanticSearch(captured);
  }, SEMANTIC_SEARCH_DEBOUNCE_MS);
}

/**
 * Awaited before the browser is touched: focusing another window closes the popup,
 * and a write still in flight then would be lost.
 */
async function rememberSearchPick(key: string): Promise<void> {
  try {
    searchPicks = await recordSearchPickInSession(searchQuery, key);
  } catch {
    // Learning is a convenience; opening the tab is the action.
  }
}

async function focusSearchResult(result: DirectTabSearchResult): Promise<void> {
  await rememberSearchPick(openSearchPickKey(result.tab.id));
  let updated: chrome.tabs.Tab;
  try {
    const activated = await chrome.tabs.update(result.tab.id, { active: true });
    if (!activated) throw new Error("The selected tab is no longer available.");
    updated = activated;
  } catch {
    searchSnapshot = searchSnapshot.filter((tab) => tab.id !== result.tab.id);
    popupState.notice = { tone: "error", text: "That tab is no longer available. Search results were refreshed." };
    ui().render();
    return;
  }

  try {
    await chrome.windows.update(updated.windowId, { focused: true });
  } catch {
    popupState.notice = {
      tone: "error",
      text: "The tab was activated, but its browser window could not be brought forward.",
      };
    ui().render();
    return;
  }

  if (popupState.searchState.local.settings.closeAfterFocus) popupState.searchOpen = false;
  ui().render();
}

async function openStashedSearchResult(result: DirectStashedTabSearchResult): Promise<void> {
  await rememberSearchPick(stashSearchPickKey(result.tab.stashId, result.tab.stashTabId));
  let created: chrome.tabs.Tab;
  const currentTargetWindowId = popupState.targetWindowId;
  try {
    const opened = await chrome.tabs.create({
      ...(currentTargetWindowId === null ? {} : { windowId: currentTargetWindowId }),
      url: result.tab.url,
      active: true,
    });
    created = opened;
  } catch {
    popupState.notice = { tone: "error", text: "That saved tab could not be opened. The workspace was left unchanged." };
    ui().render();
    return;
  }

  try {
    await chrome.windows.update(created.windowId, { focused: true });
  } catch {
    popupState.notice = {
      tone: "error",
      text: "The saved tab was opened, but its browser window could not be brought forward.",
      };
    ui().render();
    return;
  }

  popupState.notice = { tone: "success", text: `Opened from “${result.tab.stashName}”. The workspace remains saved.` };
  if (popupState.searchState.local.settings.closeAfterFocus) popupState.searchOpen = false;
  ui().render();
}

function searchReference(result: DirectStashedTabSearchResult) {
  return {
    stashId: result.tab.stashId,
    stashRevisionId: result.tab.stashRevisionId,
    stashTabId: result.tab.stashTabId,
  };
}

async function openStashedSearchCopies(
  results: readonly DirectStashedTabSearchResult[],
  destination: "current_window" | "new_window",
): Promise<void> {
  const currentTargetWindowId = popupState.targetWindowId;
  if (currentTargetWindowId === null) throw new Error("No browser window is selected.");
  const response = await ui().send({
    type: "workspace:open-copies",
    items: results.map(searchReference),
    targetWindowId: currentTargetWindowId,
    destination,
    duplicateHandling: "duplicate",
  });
  if (!response.ok) throw new Error(response.error);
  const outcome = response.stashCopyOpenResult;
  if (!outcome) throw new Error("The open result was unavailable.");
  popupState.notice = {
    tone: outcome.failed || outcome.stale ? "error" : "success",
    text: `${outcome.opened} tab${outcome.opened === 1 ? "" : "s"} opened${outcome.restoredGroups ? ` in ${outcome.restoredGroups} saved group${outcome.restoredGroups === 1 ? "" : "s"}` : ""}.${outcome.stale ? ` ${outcome.stale} stale selection${outcome.stale === 1 ? " was" : "s were"} skipped.` : ""} Source workspaces remain unchanged.`,
  };
}

function viewSearchResultInStash(result: DirectStashedTabSearchResult): void {
  stashRevealTarget = { stashId: result.tab.stashId, stashTabId: result.tab.stashTabId };
  ui().revealStashFromSearch(result.tab.stashId);
  ui().render();
  queueMicrotask(() => {
    const target = ui().actionRoot().querySelector<HTMLElement>(`[data-stash-tab-id="${CSS.escape(result.tab.stashTabId)}"]`);
    target?.scrollIntoView({ block: "center" });
    target?.focus();
  });
}

export function closableBlankTabs(): SemanticTab[] {
  if (!popupState.organizerData?.local.privacy.closeInactiveBlankTabs) return [];
  return (popupState.viewState.editor?.capturedState.tabs ?? []).filter(
    (tab: SemanticTab) =>
      !tab.active &&
      !tab.pinned &&
      !tab.audible &&
      tab.groupId === -1 &&
      tab.splitView.known &&
      tab.splitView.value === -1 &&
      isBlankNewTabUrl(tab.url),
  );
}

function renderSearchSemanticReadiness(): HTMLElement | null {
  const settings = popupState.searchState.local.settings;
  const providerReady = Boolean(
    popupState.searchState.local.providerTest && popupState.searchState.local.embeddingConfig.model.trim(),
  );
  const indexReady = popupState.semanticIndexMeta.modelKey !== null && popupState.semanticIndexMeta.ready > 0 &&
    (popupState.semanticIndexMeta.status === "complete" || popupState.semanticIndexMeta.status === "building");
  if (settings.semanticEnabled && providerReady && indexReady && popupState.semanticIndexMeta.status !== "building") {
    return null;
  }

  const setup = ui().element("section", "tab-search__setup");
  const copy = ui().element("div", "tab-search__setup-copy");
  const title = ui().element("strong", undefined, "Search by meaning");
  const description = ui().element("span");
  copy.append(title, description);
  setup.append(copy);

  if (!settings.semanticEnabled || !providerReady) {
    description.textContent = !settings.semanticEnabled
      ? "Find related tabs by topic, not just exact words."
      : "Finish verifying the embeddings model before building the index.";
    setup.append(ui().button("Set up", "secondary", () => ui().openAdvancedSettings("search")));
    return setup;
  }

  if (popupState.semanticIndexMeta.status === "building") {
    const retryDetail = ui().semanticIndexRetryDetail();
    description.textContent = retryDetail ?? `${popupState.semanticIndexMeta.ready} of ${popupState.semanticIndexMeta.total} tabs indexed. Meaning search is usable now; ${popupState.semanticIndexMeta.pending} remain.`;
    const progress = ui().element("progress", "tab-search__setup-progress");
    progress.max = Math.max(1, popupState.semanticIndexMeta.total);
    progress.value = popupState.semanticIndexMeta.ready + popupState.semanticIndexMeta.excluded + popupState.semanticIndexMeta.failed;
    progress.setAttribute("aria-label", "Semantic index progress");
    const actions = ui().element("div", "tab-search__setup-actions");
    if (popupState.semanticIndexMeta.lastErrorCode) {
      actions.append(ui().button(`Retry ${popupState.semanticIndexMeta.pending} remaining now`, "primary", () => {
        void ui().perform("build-semantic-index", ui().buildSemanticIndex);
      }, { actionName: "build-semantic-index", busyLabel: "Retrying…" }));
    }
    actions.append(ui().button("Cancel", "quiet", () => {
        void ui().perform("cancel-semantic-index", ui().cancelSemanticIndexBuild);
      }, { actionName: "cancel-semantic-index", busyLabel: "Cancelling…" }));
    setup.append(progress, actions);
    return setup;
  }

  const hasIndexData = popupState.semanticIndexMeta.modelKey !== null && popupState.semanticIndexMeta.status !== "idle";
  description.textContent = hasIndexData
    ? "The index needs refreshing before related-topic search can run."
    : "Build the private, local vector index required for related-topic search.";
  setup.append(ui().button(hasIndexData ? "Refresh index" : "Build index", "primary", () => {
    void ui().perform("build-semantic-index", ui().buildSemanticIndex);
  }, {
    disabled: ui().semanticIndexBuildRequirement() !== null,
    actionName: "build-semantic-index",
    busyLabel: "Preparing…",
  }));
  return setup;
}

function searchBatchKey(reference: StashTabReference): string {
  return `${reference.stashId}\u0000${reference.stashTabId}`;
}

function toggleSearchBatchItem(result: DirectStashedTabSearchResult, selected?: boolean): void {
  const reference = searchReference(result);
  const key = searchBatchKey(reference);
  const shouldSelect = selected ?? !searchBatchSelection.has(key);
  if (!shouldSelect) {
    searchBatchSelection.delete(key);
  } else {
    const previous = searchBatchSelection.get(key);
    const query = searchQuery.trim();
    searchBatchSelection.set(key, {
      reference,
      title: result.tab.title,
      url: result.tab.url,
      stashName: result.tab.stashName,
      groupName: result.tab.groupName,
      sourceQueries: [...new Set([...(previous?.sourceQueries ?? []), ...(query ? [query] : [])])],
    });
  }
  searchOpenPreview = null;
  searchWorkspaceDraft = null;
  searchEditDraft = null;
}

async function prepareSearchOpenPreview(): Promise<void> {
  if (searchBatchSelection.size === 0) return;
  const openUrls = (await chrome.tabs.query({})).flatMap((tab) => {
    const url = tab.url ?? tab.pendingUrl;
    return url ? [url] : [];
  });
  const latestStashes = await readTabStashes();
  const resolution = resolveStashTabReferences(latestStashes, [...searchBatchSelection.values()].map((item) => item.reference));
  let exactOpen = 0;
  let possibleDuplicates = 0;
  for (const item of resolution.available) {
    if (openUrls.some((url) => canonicalExactUrl(url) === canonicalExactUrl(item.tab.url))) exactOpen += 1;
    else if (openUrls.some((url) => possibleDuplicateUrl(url, item.tab.url))) possibleDuplicates += 1;
  }
  const sourceStashes = new Set(resolution.available.map((item) => item.stashId)).size;
  searchOpenPreview = {
    destination: searchBatchSelection.size > 5 || sourceStashes > 1 ? "new_window" : "current_window",
    duplicateHandling: "reuse",
    exactOpen,
    possibleDuplicates,
    changed: resolution.available.filter((item) => item.changedSinceSearch).length,
    stale: resolution.stale.length,
  };
}

async function openSearchBatch(): Promise<void> {
  const currentTargetWindowId = popupState.targetWindowId;
  if (!searchOpenPreview || currentTargetWindowId === null) return;
  const response = await ui().send({
    type: "workspace:open-copies",
    items: [...searchBatchSelection.values()].map((item) => item.reference),
    targetWindowId: currentTargetWindowId,
    destination: searchOpenPreview.destination,
    duplicateHandling: searchOpenPreview.duplicateHandling,
  });
  if (!response.ok) throw new Error(response.error);
  const outcome = response.stashCopyOpenResult;
  if (!outcome) throw new Error("The open result was unavailable.");
  popupState.notice = {
    tone: outcome.failed || outcome.stale || outcome.conflicts.length ? "error" : "success",
    text: `${outcome.opened} opened · ${outcome.reused} reused · ${outcome.skipped} skipped${outcome.failed ? ` · ${outcome.failed} failed` : ""}${outcome.stale ? ` · ${outcome.stale} changed or removed` : ""}. Source workspaces remain unchanged.`,
  };
  const retryKeys = new Set(outcome.retryItems.map(searchBatchKey));
  for (const key of [...searchBatchSelection.keys()]) {
    if (!retryKeys.has(key)) searchBatchSelection.delete(key);
  }
  searchOpenPreview = null;
  searchSelectionMode = searchBatchSelection.size > 0;
}

async function prepareSearchWorkspaceDraft(): Promise<void> {
  const resolution = resolveStashTabReferences(await readTabStashes(), [...searchBatchSelection.values()].map((item) => item.reference));
  searchOpenPreview = null;
  searchWorkspaceDraft = {
    name: suggestedSearchWorkspaceName(),
    preserveGroups: true,
    changed: resolution.available.filter((item) => item.changedSinceSearch).length,
    stale: resolution.stale.length,
    reviewedSelectionToken: stashSelectionResolutionToken(resolution.available, resolution.stale),
  };
}

function suggestedSearchWorkspaceName(): string {
  const queries = [...new Set([...searchBatchSelection.values()].flatMap((item) => item.sourceQueries))];
  if (queries.length > 0) {
    const words = queries.slice(0, 2).map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean);
    return `${words.join(" and ")} research`.slice(0, 120);
  }
  const groups = [...searchBatchSelection.values()].flatMap((item) => item.groupName ? [item.groupName] : []);
  const common = groups.sort((left, right) => groups.filter((value) => value === right).length - groups.filter((value) => value === left).length)[0];
  return (common ? `${common} workspace` : "Search workspace").slice(0, 120);
}

async function createSearchWorkspace(): Promise<void> {
  const currentTargetWindowId = popupState.targetWindowId;
  if (!searchWorkspaceDraft || currentTargetWindowId === null) return;
  const sourceQueries = [...new Set([...searchBatchSelection.values()].flatMap((item) => item.sourceQueries))];
  const response = await ui().send({
    type: "workspace:create-from-selection",
    items: [...searchBatchSelection.values()].map((item) => item.reference),
    targetWindowId: currentTargetWindowId,
    name: searchWorkspaceDraft.name,
    preserveGroups: searchWorkspaceDraft.preserveGroups,
    sourceQueries,
    reviewedSelectionToken: searchWorkspaceDraft.reviewedSelectionToken,
  });
  if (!response.ok) {
    popupState.savedStashes = await readTabStashes();
    throw new Error(response.error);
  }
  const outcome = response.searchWorkspaceCreationResult;
  if (outcome?.requiresReview) {
    await prepareSearchWorkspaceDraft();
    throw new Error("The selection changed after review. Review the latest available tabs before continuing.");
  }
  if (!outcome?.stashId) throw new Error("The selected tabs are no longer available. Review the selection and try again.");
  popupState.savedStashes = await readTabStashes();
  searchBatchSelection.clear();
  searchWorkspaceDraft = null;
  searchSelectionMode = false;
  popupState.notice = {
    tone: outcome.stale || outcome.failed || outcome.conflicts.length ? "error" : "success",
    text: `Created a workspace in a linked window: ${outcome.opened} opened${outcome.failed ? ` · ${outcome.failed} failed. The new workspace remains complete; open it from Workspaces to retry` : ""}.${outcome.stale ? ` ${outcome.stale} removed selection${outcome.stale === 1 ? " was" : "s were"} skipped.` : ""}${outcome.conflicts.length ? ` ${outcome.conflicts.join(" ")}` : ""} Source workspaces remain unchanged.`,
  };
}

function openSearchEditDraft(): void {
  searchOpenPreview = null;
  searchWorkspaceDraft = null;
  searchEditDraft = { operation: "remove", targetStashId: null, preview: null };
  searchEditPendingFocus = "operation";
}

async function prepareSearchEditPreview(): Promise<void> {
  if (!searchEditDraft || searchBatchSelection.size === 0) return;
  const response = await ui().send({
    type: "workspace:preview-search-edit",
    items: [...searchBatchSelection.values()].map((item) => item.reference),
    operation: searchEditDraft.operation,
    targetStashId: searchEditDraft.targetStashId,
  });
  if (!response.ok) throw new Error(response.error);
  if (!response.stashSearchEditPreview) throw new Error("The workspace edit preview was unavailable.");
  searchEditDraft.preview = response.stashSearchEditPreview;
  searchEditPendingFocus = "confirm";
}

async function applySearchEdit(): Promise<void> {
  if (!searchEditDraft?.preview) return;
  const response = await ui().send({
    type: "workspace:apply-search-edit",
    items: [...searchBatchSelection.values()].map((item) => item.reference),
    operation: searchEditDraft.operation,
    targetStashId: searchEditDraft.targetStashId,
    reviewedSelectionToken: searchEditDraft.preview.reviewedSelectionToken,
  });
  if (!response.ok) throw new Error(response.error);
  const outcome = response.stashSearchEditApplyResult;
  if (!outcome) throw new Error("The workspace edit result was unavailable.");
  if (outcome.requiresReview || !outcome.applied || !outcome.transactionId) {
    searchEditDraft.preview = outcome.preview;
    searchEditPendingFocus = "confirm";
    throw new Error("The selected tabs or destination changed after review. Review the latest preview before confirming.");
  }
  const count = outcome.preview.available;
  const action = outcome.preview.operation === "remove"
    ? "Removed"
    : outcome.preview.operation === "move" ? "Moved" : "Copied";
  searchEditUndo = {
    transactionId: outcome.transactionId,
    message: `${action} ${count} tab${count === 1 ? "" : "s"}.`,
  };
  searchBatchSelection.clear();
  searchEditDraft = null;
  searchSelectionMode = false;
  popupState.notice = { tone: "success", text: `${action} ${count} selected tab${count === 1 ? "" : "s"}. You can undo this edit below.` };
  try {
    await refreshSearchSnapshots(ui(), false);
  } catch {
    popupState.notice = { tone: "info", text: `${action} ${count} selected tab${count === 1 ? "" : "s"}, but the search list could not refresh. Reopen Search to reload it. Undo is still available below.` };
  }
}

async function undoSearchEdit(): Promise<void> {
  if (!searchEditUndo) return;
  const transactionId = searchEditUndo.transactionId;
  const response = await ui().send({ type: "workspace:undo-search-edit", transactionId });
  if (!response.ok) throw new Error(response.error);
  const outcome = response.stashSearchEditUndoResult;
  if (!outcome) throw new Error("The undo result was unavailable.");
  if (!outcome.undone) {
    searchEditUndo = null;
    throw new Error(outcome.unavailableReason ?? "This workspace edit could not be undone.");
  }
  searchEditUndo = null;
  popupState.notice = { tone: "success", text: "The workspace edit was undone and every affected workspace was restored." };
  try {
    await refreshSearchSnapshots(ui(), false);
  } catch {
    popupState.notice = { tone: "info", text: "The workspace edit was undone, but the search list could not refresh. Reopen Search to reload it." };
  }
}

function restoreSearchEditFocus(): void {
  const focus = searchEditPendingFocus;
  if (!focus) return;
  searchEditPendingFocus = null;
  queueMicrotask(() => {
    if (focus === "trigger") {
      const trigger = ui().actionRoot().querySelector<HTMLButtonElement>("[data-search-edit-trigger]");
      const menu = trigger?.closest("details");
      if (menu) menu.open = true;
      trigger?.focus();
      return;
    }
    ui().actionRoot().querySelector<HTMLElement>(`[data-search-edit-focus="${focus}"]`)?.focus();
  });
}

function appendSearchEditPanel(container: HTMLElement, redraw: () => void): void {
  if (searchEditDraft) {
    const draft = searchEditDraft;
    const panel = ui().element("section", "tab-search__edit-panel");
    panel.append(
      ui().element("strong", undefined, "Edit saved workspaces"),
      ui().element("p", "tab-search__edit-warning", "This changes saved workspaces. Open tabs and linked windows are never changed."),
    );
    const operation = ui().element("select", "input");
    ([
      ["remove", "Remove from source workspaces"],
      ["move", "Move to another workspace"],
      ["merge", "Copy into another workspace"],
    ] as const).forEach(([value, label]) => {
      const option = ui().element("option", undefined, label);
      option.value = value;
      option.selected = draft.operation === value;
      operation.append(option);
    });
    operation.addEventListener("change", () => {
      if (!searchEditDraft) return;
      searchEditDraft.operation = operation.value as StashSearchEditOperation;
      searchEditDraft.targetStashId = null;
      searchEditDraft.preview = null;
      searchEditPendingFocus = "operation";
      redraw();
    });
    operation.dataset.searchEditFocus = "operation";
    panel.append(ui().field("Change", operation));
    if (draft.operation !== "remove") {
      const sourceIds = new Set([...searchBatchSelection.values()].map((item) => item.reference.stashId));
      const target = ui().element("select", "input");
      const placeholder = ui().element("option", undefined, "Choose a destination workspace");
      placeholder.value = "";
      placeholder.selected = draft.targetStashId === null;
      target.append(placeholder);
      popupState.savedStashes.filter((stash) => !sourceIds.has(stash.id)).forEach((stash) => {
        const option = ui().element("option", undefined, `${stash.name} · ${ui().formatCount(stash.tabs.length, "tab")}${stash.activeWorkspaceId ? " · linked" : ""}`);
        option.value = stash.id;
        option.disabled = stash.activeWorkspaceId !== null;
        option.selected = draft.targetStashId === stash.id;
        target.append(option);
      });
      target.addEventListener("change", () => {
        if (!searchEditDraft) return;
        searchEditDraft.targetStashId = target.value || null;
        searchEditDraft.preview = null;
        searchEditPendingFocus = "target";
        redraw();
      });
      target.dataset.searchEditFocus = "target";
      panel.append(ui().field("Destination", target, "Workspaces open in a linked window cannot be edited."));
    }
    if (draft.preview) {
      const preview = draft.preview;
      const facts = ui().element("div", "tab-search__edit-facts");
      preview.sourceSummaries.forEach((item) => {
        facts.append(ui().element(
          "p",
          undefined,
          `${item.stashName}: ${ui().formatCount(item.beforeTabs, "tab")} → ${ui().formatCount(item.afterTabs, "tab")} · ${ui().formatCount(item.beforeGroups, "group")} → ${ui().formatCount(item.afterGroups, "group")}`,
        ));
      });
      if (preview.targetSummary) {
        const item = preview.targetSummary;
        facts.append(ui().element(
          "p",
          undefined,
          `${item.stashName} (destination): ${ui().formatCount(item.beforeTabs, "tab")} → ${ui().formatCount(item.afterTabs, "tab")} · ${ui().formatCount(item.beforeGroups, "group")} → ${ui().formatCount(item.afterGroups, "group")}`,
        ));
      }
      panel.append(facts);
      if (preview.changedSinceSearch || preview.stale) {
        panel.append(ui().element(
          "p",
          "tab-search__stale-warning",
          `${preview.changedSinceSearch} changed since search · ${preview.stale} removed · ${preview.available} available. This exact current state is what confirmation will edit.`,
        ));
      }
      if (preview.blockedReason) panel.append(ui().element("p", "tab-search__edit-blocked", preview.blockedReason));
    }
    const actions = ui().element("div", "tab-search__preview-actions");
    actions.append(ui().button("Cancel", "quiet", () => {
      searchEditDraft = null;
      searchEditPendingFocus = "trigger";
      redraw();
    }));
    if (!draft.preview) {
      actions.append(ui().button("Review changes", "secondary", () => {
        void ui().perform("preview-search-edit", prepareSearchEditPreview);
      }, {
        disabled: draft.operation !== "remove" && draft.targetStashId === null,
        actionName: "preview-search-edit",
        busyLabel: "Reviewing…",
      }));
    } else {
      const label = draft.operation === "remove" ? "Confirm removal" : draft.operation === "move" ? "Confirm move" : "Confirm copy";
      const confirm = ui().button(label, "danger", () => {
        void ui().perform("apply-search-edit", applySearchEdit);
      }, {
        disabled: draft.preview.blockedReason !== null,
        actionName: "apply-search-edit",
        busyLabel: "Saving…",
      });
      confirm.dataset.searchEditFocus = "confirm";
      actions.append(confirm);
    }
    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      searchEditDraft = null;
      searchEditPendingFocus = "trigger";
      redraw();
    });
    panel.append(actions);
    container.append(panel);
  }
  if (searchEditUndo) {
    const undo = ui().element("section", "tab-search__edit-undo");
    undo.append(
      ui().element("span", undefined, `${searchEditUndo.message} Saved workspaces now reflect the reviewed edit.`),
      ui().button("Undo", "secondary", () => void ui().perform("undo-search-edit", undoSearchEdit), {
        actionName: "undo-search-edit",
        busyLabel: "Restoring…",
      }),
    );
    container.append(undo);
  }
  restoreSearchEditFocus();
}

export function renderTabSearch(shell: HTMLElement, context: TabSearchPanelContext): void {
  panelContext = context;
  const includeGroupNames = popupState.searchState.local.settings.includeGroupNames;
  const panel = ui().element("section", "tab-search");
  const heading = ui().element("h2", "tab-search__heading", "Find a tab");
  const scope = ui().element("div", "tab-search__scope");
  scope.setAttribute("role", "group");
  scope.setAttribute("aria-label", "Open-tab scope");
  ([
    ["current_window", "This window"],
    ["all_windows", "All windows"],
  ] as const).forEach(([value, label]) => {
    const control = ui().element(
      "button",
      `tab-search__scope-button${searchScope === value ? " tab-search__scope-button--active" : ""}`,
      label,
    );
    control.type = "button";
    control.dataset.searchScope = value;
    control.setAttribute("aria-pressed", String(searchScope === value));
    control.addEventListener("click", () => {
      cancelSemanticSearch();
      searchScope = value;
      searchSelectedIndex = 0;
      ui().redraw();
      queueMicrotask(() => ui().actionRoot().querySelector<HTMLButtonElement>(`[data-search-scope="${value}"]`)?.focus());
    });
    scope.append(control);
  });
  scope.title = "Applies to open tabs; saved workspaces are always searched";

  const semanticReadiness = renderSearchSemanticReadiness();

  const searchField = ui().element("div", "tab-search__field");
  const searchLabel = ui().element("label", undefined, "Search open and saved tabs");
  const searchInput = ui().input(searchQuery, "search");
  searchInput.id = "tab-search-input";
  searchInput.placeholder = includeGroupNames ? "Title, site, path, or group" : "Title, site, or path";
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchInput.setAttribute("aria-controls", "tab-search-results");
  searchInput.disabled = searchSnapshotStatus !== "ready";
  searchLabel.htmlFor = searchInput.id;
  const resultStatus = ui().element("p", "tab-search__status visually-hidden");
  resultStatus.setAttribute("role", "status");
  resultStatus.setAttribute("aria-live", "polite");
  const semanticActions = ui().element("div", "tab-search__semantic-actions");
  semanticActions.setAttribute("aria-live", "polite");
  searchField.append(searchLabel, searchInput, resultStatus);

  const resultList = ui().element("div", "tab-search__results");
  resultList.id = "tab-search-results";
  resultList.setAttribute("role", "region");
  resultList.setAttribute("aria-label", "Matching tabs");
  const batchControls = ui().element("div", "tab-search__batch-controls");

  type SearchSelection =
    | { kind: "open"; result: DirectTabSearchResult; related: boolean }
    | { kind: "stash"; result: DirectStashedTabSearchResult; related: boolean };
  let currentSelections: SearchSelection[] = [];
  // The one row wearing the selected style. Tracking it here is what keeps a
  // pointer sweep from re-scanning every row on each entry.
  let selectedResultRow: HTMLElement | null = null;
  const selectionKey = (selection: SearchSelection): string => selection.kind === "open"
    ? semanticMappingKey(selection.result.tab)
    : semanticStashMappingKey(selection.result.tab.stashId, selection.result.tab.sourceIndex);
  const resultsForScope = (): SearchableTab[] => searchScope === "all_windows"
    ? searchSnapshot
    : searchSnapshot.filter((tab) => tab.windowId === popupState.targetWindowId);
  const drawResults = (allowAutoSemantic = true): void => {
    const previouslySelectedKey = currentSelections[searchSelectedIndex]
      ? selectionKey(currentSelections[searchSelectedIndex]!)
      : null;
    const openResults = directTabSearch(resultsForScope(), searchQuery, {
      includeGroupNames,
    });
    const stashResults = directStashedTabSearch(stashedSearchSnapshot, searchQuery, {
      includeGroupNames,
    });
    const directMappingKeys = new Set([
      ...openResults.map((result) => semanticMappingKey(result.tab)),
      ...stashResults.map((result) => semanticStashMappingKey(result.tab.stashId, result.tab.sourceIndex)),
    ]);
    const semanticForQuery = semanticSearchState.key === semanticSearchKey()
      ? semanticSearchState.results
      : [];
    const semanticKeys = new Set(semanticForQuery.map((result) => result.mappingKey));
    // A tab the user already chose for this query leads, whatever its tier: that
    // choice is better evidence than any text match.
    const pickBoosts = searchPickBoosts(searchPicks, searchQuery);
    const openPick = (tab: SearchableTab): number => pickBoosts.get(openSearchPickKey(tab.id)) ?? 0;
    const stashPick = (tab: SearchableStashedTab): number =>
      pickBoosts.get(stashSearchPickKey(tab.stashId, tab.stashTabId)) ?? 0;
    const boostedOpenResults = [...openResults].sort((left, right) =>
      openPick(right.tab) - openPick(left.tab) ||
      left.tier - right.tier ||
      Number(semanticKeys.has(semanticMappingKey(right.tab))) -
        Number(semanticKeys.has(semanticMappingKey(left.tab))),
    );
    const boostedStashResults = [...stashResults].sort((left, right) =>
      stashPick(right.tab) - stashPick(left.tab) ||
      left.tier - right.tier ||
      Number(semanticKeys.has(semanticStashMappingKey(right.tab.stashId, right.tab.sourceIndex))) -
        Number(semanticKeys.has(semanticStashMappingKey(left.tab.stashId, left.tab.sourceIndex))),
    );
    const directOpen: SearchSelection[] = boostedOpenResults.map((result) => ({
      kind: "open",
      result,
      related: semanticKeys.has(semanticMappingKey(result.tab)),
    }));
    const directStashes: SearchSelection[] = boostedStashResults.map((result) => ({
      kind: "stash",
      result,
      related: semanticKeys.has(semanticStashMappingKey(result.tab.stashId, result.tab.sourceIndex)),
    }));
    const relatedOpen: SearchSelection[] = [];
    const relatedStashes: SearchSelection[] = [];
    for (const semantic of semanticForQuery) {
      if (directMappingKeys.has(semantic.mappingKey)) continue;
      if (semantic.target.kind === "open") {
        const target = semantic.target;
        const tab = resultsForScope().find((candidate) =>
          candidate.id === target.tabId && candidate.windowId === target.windowId,
        );
        if (tab) relatedOpen.push({ kind: "open", result: { tab, tier: 7, reasons: [] }, related: true });
      } else {
        const target = semantic.target;
        const tab = stashedSearchSnapshot.find((candidate) =>
          candidate.stashId === target.stashId && candidate.sourceIndex === target.sourceIndex,
        );
        if (tab) relatedStashes.push({ kind: "stash", result: { tab, tier: 7, reasons: [] }, related: true });
      }
    }
    const selectionPick = (selection: SearchSelection): number =>
      selection.kind === "open" ? openPick(selection.result.tab) : stashPick(selection.result.tab);
    relatedOpen.sort((left, right) => selectionPick(right) - selectionPick(left));
    relatedStashes.sort((left, right) => selectionPick(right) - selectionPick(left));
    const directSelections = [...directOpen, ...directStashes];
    const relatedSelections = [...relatedOpen, ...relatedStashes];
    // Tiers 5 and 6 are scattered tokens and one-edit typos. A related result has
    // passed the score floor and the tail cutoff, so it is the better answer and
    // goes first; any literal match at tier 4 or better, or one picked before, still leads.
    const relatedFirst = relatedSelections.length > 0 &&
      directSelections.every((selection) => selection.result.tier >= 5 && selectionPick(selection) === 0);
    // One section per kind of tab, not per kind of match: related rows join their
    // section with a "Related" tag, and lead it when the literal matches are weak.
    const semanticReady = semanticSearchState.key === semanticSearchKey() && (
      semanticSearchState.status === "ready" ||
      semanticSearchState.status === "empty" ||
      semanticSearchState.status === "no_candidates" ||
      semanticSearchState.status === "unavailable"
    );
    const shownRelatedOpen = semanticReady ? relatedOpen : [];
    const shownRelatedStashes = semanticReady ? relatedStashes : [];
    const openSection = relatedFirst
      ? [...shownRelatedOpen, ...directOpen]
      : [...directOpen, ...shownRelatedOpen];
    const stashSection = relatedFirst
      ? [...shownRelatedStashes, ...directStashes]
      : [...directStashes, ...shownRelatedStashes];
    currentSelections = [...openSection, ...stashSection];
    const selectionIndexes = new Map(currentSelections.map((selection, index) => [selection, index]));
    const preservedIndex = previouslySelectedKey === null
      ? -1
      : currentSelections.findIndex((selection) => selectionKey(selection) === previouslySelectedKey);
    searchSelectedIndex = preservedIndex >= 0
      ? preservedIndex
      : Math.min(searchSelectedIndex, Math.max(0, currentSelections.length - 1));
    resultList.replaceChildren();
    selectedResultRow = null;
    semanticActions.replaceChildren();
    batchControls.replaceChildren();
    if (!searchQuery.trim()) {
      resultStatus.textContent = searchSnapshotStatus === "loading"
        ? "Loading open and saved tabs…"
        : searchSnapshotStatus === "error"
          ? "Tabs could not be loaded. Direct and related search have not run."
          : `${ui().formatCount(resultsForScope().length, "open tab")} and ${ui().formatCount(stashedSearchSnapshot.length, "workspace tab")} ready to search`;
      // The placeholder already says what to type; only a load failure needs words.
      if (searchSnapshotStatus === "error") {
        const empty = ui().element("div", "tab-search__empty");
        empty.append(
          ui().element("strong", undefined, "Search data is unavailable"),
          ui().button("Reload tabs", "secondary", () => {
            void ui().perform("search-tabs", () => refreshSearchSnapshots(ui()));
          }, { actionName: "search-tabs", busyLabel: "Loading…" }),
        );
        resultList.append(empty);
      }
      if (searchBatchSelection.size > 0) {
        const queries = new Set([...searchBatchSelection.values()].flatMap((item) => item.sourceQueries));
        const bar = ui().element("div", "tab-search__selection-bar");
        const summary = ui().element("button", "tab-search__selection-summary", `${searchBatchSelection.size} selected${queries.size > 1 ? ` from ${queries.size} searches` : ""}`);
        summary.type = "button";
        summary.addEventListener("click", () => { searchSelectionTrayOpen = !searchSelectionTrayOpen; ui().redraw(); });
        const clear = ui().element("button", "tab-search__selection-clear", "Clear");
        clear.type = "button";
        clear.addEventListener("click", () => { searchBatchSelection.clear(); searchOpenPreview = null; searchEditDraft = null; ui().redraw(); });
        const actions = ui().element("div", "tab-search__selection-actions");
        actions.append(
          ui().button("Open selected", "primary", () => void ui().perform("prepare-search-open", prepareSearchOpenPreview), { actionName: "prepare-search-open", busyLabel: "Checking…" }),
          ui().button("Open in linked window", "secondary", () => void ui().perform("prepare-search-workspace", prepareSearchWorkspaceDraft), { actionName: "prepare-search-workspace", busyLabel: "Reviewing…" }),
        );
        const more = ui().element("details", "tab-search__selection-more");
        more.append(ui().element("summary", undefined, "Workspace actions"));
        const moreMenu = ui().element("div");
        const edit = ui().element("button", undefined, "Edit source workspaces…");
        edit.type = "button";
        edit.dataset.searchEditTrigger = "true";
        edit.addEventListener("click", () => { more.open = false; openSearchEditDraft(); ui().redraw(); });
        moreMenu.append(edit);
        more.append(moreMenu);
        actions.append(more);
        bar.append(summary, clear, actions);
        batchControls.append(bar);
        if (searchSelectionTrayOpen) {
          const tray = ui().element("ul", "tab-search__selection-tray");
          for (const [key, item] of searchBatchSelection) {
            const trayRow = ui().element("li");
            const copy = ui().element("span");
            copy.append(ui().element("strong", undefined, item.title), ui().element("small", undefined, [item.stashName, item.groupName].filter(Boolean).join(" · ")));
            const remove = ui().element("button", undefined, "Remove");
            remove.type = "button";
            remove.setAttribute("aria-label", `Remove ${item.title} from selection`);
            remove.addEventListener("click", () => { searchBatchSelection.delete(key); searchEditDraft = null; ui().redraw(); });
            trayRow.append(copy, remove);
            tray.append(trayRow);
          }
          batchControls.append(tray);
        }
        if (searchOpenPreview) {
          const preview = ui().element("section", "tab-search__open-preview");
          preview.append(
            ui().element("strong", undefined, `Open ${searchBatchSelection.size} selected tabs`),
            ui().element("p", undefined, `${searchOpenPreview.exactOpen} exact match${searchOpenPreview.exactOpen === 1 ? "" : "es"} already open. ${searchOpenPreview.possibleDuplicates} possible duplicate${searchOpenPreview.possibleDuplicates === 1 ? "" : "s"}.`),
          );
          const actions = ui().element("div", "tab-search__preview-actions");
          actions.append(
            ui().button("Cancel", "quiet", () => { searchOpenPreview = null; ui().redraw(); }),
            ui().button("Open with recommended settings", "primary", () => void ui().perform("open-search-selection", openSearchBatch), { actionName: "open-search-selection", busyLabel: "Opening…" }),
          );
          preview.append(actions);
          batchControls.append(preview);
        }
        if (searchWorkspaceDraft) {
          const form = ui().element("section", "tab-search__workspace-form");
          const name = ui().input(searchWorkspaceDraft.name);
          name.maxLength = 120;
          name.addEventListener("input", () => { if (searchWorkspaceDraft) searchWorkspaceDraft.name = name.value; });
          form.append(ui().element("strong", undefined, `Create a linked window from ${ui().formatCount(searchBatchSelection.size, "tab")}`), ui().field("Name", name));
          const actions = ui().element("div", "tab-search__preview-actions");
          actions.append(
            ui().button("Cancel", "quiet", () => { searchWorkspaceDraft = null; ui().redraw(); }),
            ui().button("Create and open", "primary", () => void ui().perform("create-search-workspace", createSearchWorkspace), { actionName: "create-search-workspace", busyLabel: "Creating…" }),
          );
          form.append(actions);
          batchControls.append(form);
        }
      }
      appendSearchEditPanel(batchControls, ui().render);
      return;
    }
    resultStatus.textContent = `${ui().formatCount(openResults.length + stashResults.length, "direct match", "direct matches")}`;
    const availability = semanticSearchAvailability(popupState.searchState, searchScope, popupState.semanticIndexMeta, popupState.targetWindowId);
    const relatedButton = ui().iconButton(
      semanticSearchState.status === "loading" ? "Searching by meaning…" : "Search by meaning",
      "search",
      () => scheduleSemanticSearch(true),
      {
        disabled: Boolean(availability) || semanticSearchState.status === "loading"
          || semanticFailure.blocks(semanticSearchKey()),
        actionName: "find-related-tabs",
      },
    );
    const semanticStatus = ui().element("span", "tab-search__semantic-status");
    const semanticStateForQuery = semanticSearchState.key === semanticSearchKey()
      ? semanticSearchState
      : null;
    // When the setup prompt below already explains why, the status stays quiet.
    semanticStatus.textContent = availability
      ? (semanticReadiness ? "" : availability)
      : (semanticStateForQuery?.status === "ready"
        // A reorder that arrives after the list is on screen explains itself, so the
        // status says the order moved rather than leaving the user to notice a jump.
        ? `${semanticStateForQuery.results.length} related tab${semanticStateForQuery.results.length === 1 ? "" : "s"} found${semanticStateForQuery.rerankLatencyMs ? " · reordered" : ""}`
        : semanticStateForQuery?.status === "empty"
          ? "No related matches"
          : semanticStateForQuery?.status === "no_candidates"
            ? "Nothing indexed here; refresh the index"
          : semanticStateForQuery?.status === "unavailable"
            ? semanticFailureText(semanticStateForQuery.errorCode)
      : semanticStateForQuery?.errorCode === "invalid_record"
        ? "Some indexed tabs were skipped"
      : semanticFailure.blocks(semanticSearchKey())
        ? semanticFailureText(semanticFailure.errorCode())
        : semanticSearchState.status === "loading" || semanticSearchState.status === "debouncing"
          ? "Searching by meaning…"
          : "Enter to search by meaning");
    semanticActions.append(semanticStatus, relatedButton);
    let selectModePlaced = false;
    const appendSection = (
      parent: HTMLElement,
      label: string,
      selections: readonly SearchSelection[],
    ): void => {
      if (selections.length === 0) return;
      const sectionHeading = ui().element("div", "tab-search__section-heading");
      sectionHeading.append(ui().element("span", undefined, `${label} · ${selections.length}`));
      if (!selectModePlaced && selections.some((selection) => selection.kind === "stash")) {
        selectModePlaced = true;
        const selectMode = ui().element("button", "tab-search__select-mode", searchSelectionMode ? "Done" : "Select");
        selectMode.type = "button";
        selectMode.setAttribute("aria-label", searchSelectionMode ? "Done selecting" : "Select saved tabs");
        selectMode.setAttribute("aria-pressed", String(searchSelectionMode));
        selectMode.addEventListener("click", () => {
          searchSelectionMode = !searchSelectionMode;
          searchOpenPreview = null;
          drawResults(false);
        });
        sectionHeading.append(selectMode);
      }
      parent.append(sectionHeading);
      selections.forEach((selection) => {
        const index = selectionIndexes.get(selection) ?? -1;
        const result = selection.result;
        const title = result.tab.title;
        const row = ui().element("div", `tab-search__result${index === searchSelectedIndex ? " tab-search__result--selected" : ""}`);
        if (index === searchSelectedIndex) selectedResultRow = row;
        row.id = selection.kind === "open"
          ? `tab-search-open-${selection.result.tab.id}`
          : `tab-search-stash-${selection.result.tab.stashId}-${selection.result.tab.sourceIndex}`;
        const copy = ui().element("span", "tab-search__result-copy");
        copy.append(ui().element("strong", undefined, title));
        const location = selection.kind === "open"
          ? [selection.result.tab.hostname || "Local page", selection.result.tab.groupName, selection.result.tab.windowLabel]
          : [selection.result.tab.hostname || "Local page", selection.result.tab.groupName, selection.result.tab.stashName];
        copy.append(ui().element("span", undefined, location.filter(Boolean).join(" · ")));
        // Match reasons stay in the accessible name; the section already says
        // whether a row is open, saved, or related.
        const reasons = ui().element("span", "tab-search__reasons");
        const userProtectionReasons = selection.kind === "open"
          ? ui().searchTabUserProtectionReasons(selection.result.tab)
          : [];
        // A related-only row matched by meaning, not by any word the user typed.
        if (selection.related && result.reasons.length === 0) {
          reasons.append(ui().element("span", "tab-search__related-tag", "Related"));
        }
        if (userProtectionReasons.length > 0) {
          const protectedBadge = ui().element("span", "tab-search__protected-badge", "Protected");
          protectedBadge.title = userProtectionReasons.join(" · ");
          reasons.append(protectedBadge);
        }
        // A generic div ignores aria-label; role="group" gives the row the
        // accessible name the label describes.
        row.setAttribute("role", "group");
        row.setAttribute(
          "aria-label",
          `${selection.kind === "open" ? "Focus open tab" : `Open tab saved in ${selection.result.tab.stashName}:`} ${title}. ${location.filter(Boolean).join(", ")}. ${selection.related && result.reasons.length === 0 ? "Related by meaning." : `Matches ${[...result.reasons, ...(selection.related ? ["Related"] : [])].join(" and ")}.`}${userProtectionReasons.length > 0 ? ` Protected: ${userProtectionReasons.join(", ")}.` : ""}`,
        );
        const mainAction = ui().element("button", "tab-search__result-main");
        mainAction.type = "button";
        mainAction.append(copy);
        if (reasons.childElementCount > 0) mainAction.append(reasons);
        const actions = ui().element("span", "tab-search__result-actions");
        if (selection.kind === "open") {
          const menu = ui().element("details", "tab-search__overflow");
          const menuSummary = ui().element("summary", undefined, "⋯");
          menuSummary.setAttribute("aria-label", `More actions for ${title}`);
          menu.append(menuSummary);
          const menuItems = ui().element("span", "tab-search__overflow-menu");
          const addMenuAction = (label: string, action: () => void): void => {
            const control = ui().element("button", undefined, label);
            control.type = "button";
            control.addEventListener("click", () => { menu.open = false; action(); });
            menuItems.append(control);
          };
          if (userProtectionReasons.length > 0) {
            addMenuAction("Manage protection rules", ui().openProtectionManager);
          } else {
            addMenuAction("Protect until restart", () => {
              void ui().perform(`search-protect-session-${selection.result.tab.id}`, () =>
                ui().protectSearchTab(selection.result.tab, "session"));
            });
            addMenuAction("Protect whenever open", () => {
              void ui().perform(`search-protect-permanent-${selection.result.tab.id}`, () =>
                ui().protectSearchTab(selection.result.tab, "permanent"));
            });
          }
          menu.append(menuItems);
          actions.append(menu);
        }
        if (selection.kind === "stash") {
          const menu = ui().element("details", "tab-search__overflow");
          const menuSummary = ui().element("summary", undefined, "⋯");
          menuSummary.setAttribute("aria-label", `More actions for ${title}`);
          menu.append(menuSummary);
          const menuItems = ui().element("span", "tab-search__overflow-menu");
          const addMenuAction = (label: string, action: () => void): void => {
            const control = ui().element("button", undefined, label);
            control.type = "button";
            control.addEventListener("click", () => { menu.open = false; action(); });
            menuItems.append(control);
          };
          addMenuAction("Open in new window", () => void ui().perform(`search-open-window-${selection.result.tab.key}`, () => openStashedSearchCopies([selection.result], "new_window")));
          if (selection.result.tab.groupKey) {
            const groupResults = stashedSearchSnapshot
              .filter((tab) => tab.stashId === selection.result.tab.stashId && tab.groupKey === selection.result.tab.groupKey)
              .map((tab) => ({ tab, tier: 0, reasons: [] } satisfies DirectStashedTabSearchResult));
            addMenuAction(`Open containing group (${groupResults.length})`, () => void ui().perform(`search-open-group-${selection.result.tab.key}`, () => openStashedSearchCopies(groupResults, "new_window")));
            if (searchSelectionMode) {
              addMenuAction(`Select containing group (${groupResults.length})`, () => {
                groupResults.forEach((groupResult) => toggleSearchBatchItem(groupResult, true));
                drawResults(false);
              });
            }
          }
          addMenuAction("View in workspace", () => viewSearchResultInStash(selection.result));
          addMenuAction("Copy URL", () => void navigator.clipboard.writeText(selection.result.tab.url).then(() => {
            popupState.notice = { tone: "success", text: "URL copied. The workspace is unchanged." }; ui().render();
          }));
          menu.append(menuItems);
          actions.append(menu);
        }
        if (selection.kind === "stash" && searchSelectionMode) {
          const choice = ui().element("label", "tab-search__result-check");
          const control = ui().element("input");
          control.type = "checkbox";
          control.checked = searchBatchSelection.has(searchBatchKey(searchReference(selection.result)));
          control.setAttribute("aria-label", `Select ${title} from ${selection.result.tab.stashName}`);
          control.addEventListener("change", () => {
            toggleSearchBatchItem(selection.result, control.checked);
            drawResults(false);
          });
          choice.append(control);
          row.append(choice);
        }
        row.append(mainAction, actions);
        row.addEventListener("pointerenter", () => {
          if (selectedResultRow === row) return;
          searchSelectedIndex = index;
          selectedResultRow?.classList.remove("tab-search__result--selected");
          row.classList.add("tab-search__result--selected");
          selectedResultRow = row;
        });
        mainAction.addEventListener("click", () => {
          if (selection.kind === "open") void focusSearchResult(selection.result);
          else void openStashedSearchResult(selection.result);
        });
        mainAction.addEventListener("keydown", (event) => {
          if (event.key === " " && selection.kind === "stash") {
            event.preventDefault();
            searchSelectionMode = true;
            if (event.shiftKey && searchRangeAnchor >= 0) {
              const start = Math.min(searchRangeAnchor, index);
              const end = Math.max(searchRangeAnchor, index);
              currentSelections.slice(start, end + 1).forEach((item) => {
                if (item.kind === "stash") toggleSearchBatchItem(item.result, true);
              });
            } else {
              toggleSearchBatchItem(selection.result);
              searchRangeAnchor = index;
            }
            drawResults(false);
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && searchBatchSelection.size > 0) {
            event.preventDefault();
            void ui().perform("prepare-search-open", prepareSearchOpenPreview);
          }
          if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "a") {
            event.preventDefault();
            searchSelectionMode = true;
            currentSelections.forEach((item) => { if (item.kind === "stash") toggleSearchBatchItem(item.result, true); });
            drawResults(false);
          }
        });
        parent.append(row);
      });
    };
    const semanticStateIsCurrent = semanticSearchState.key === semanticSearchKey();
    if (currentSelections.length > 0) {
      appendSection(resultList, "Open tabs", openSection);
      appendSection(resultList, "Saved tabs", stashSection);
    } else {
      const empty = ui().element("div", "tab-search__empty tab-search__empty--compact");
      const semanticPending = semanticStateIsCurrent && (
        semanticSearchState.status === "loading" || semanticSearchState.status === "debouncing"
      );
      empty.append(
        ui().element("strong", undefined, semanticPending ? "Searching by meaning…" : "No matches yet"),
        ui().element(
          "span",
          undefined,
          semanticPending
            ? "Direct search found nothing. Related results will appear here when ready."
            : semanticSearchState.status === "empty" && semanticStateIsCurrent
              ? "No strong direct or related matches were found."
              : semanticSearchState.status === "no_candidates" && semanticStateIsCurrent
                ? "No indexed tabs were available for this search scope. Refresh the index and try again."
              : semanticSearchState.status === "unavailable" && semanticStateIsCurrent
                ? `Nothing matched directly, and search by meaning failed: ${semanticFailureText(semanticSearchState.errorCode)}.`
                : "Press Enter to search by meaning, or try another remembered word.",
        ),
      );
      resultList.append(empty);
    }
    if (
      allowAutoSemantic &&
      !availability &&
      (
        popupState.searchState.local.settings.semanticAlways ||
        (
          popupState.searchState.local.settings.semanticWhenDirectWeak &&
          !directResultsAreStrong([...openResults, ...stashResults])
        )
      ) &&
      semanticSearchState.key !== semanticSearchKey()
    ) scheduleSemanticSearch(false);

    if (searchBatchSelection.size > 0) {
      const queries = new Set([...searchBatchSelection.values()].flatMap((item) => item.sourceQueries));
      const bar = ui().element("div", "tab-search__selection-bar");
      const summary = ui().element("button", "tab-search__selection-summary", `${searchBatchSelection.size} selected${queries.size > 1 ? ` from ${queries.size} searches` : ""}`);
      summary.type = "button";
      summary.setAttribute("aria-expanded", String(searchSelectionTrayOpen));
      summary.addEventListener("click", () => { searchSelectionTrayOpen = !searchSelectionTrayOpen; drawResults(false); });
      const clear = ui().element("button", "tab-search__selection-clear", "Clear");
      clear.type = "button";
      clear.addEventListener("click", () => { searchBatchSelection.clear(); searchOpenPreview = null; searchEditDraft = null; drawResults(false); });
      const batchActions = ui().element("div", "tab-search__selection-actions");
      batchActions.append(ui().button("Open selected", "primary", () => {
        void ui().perform("prepare-search-open", prepareSearchOpenPreview);
      }, { actionName: "prepare-search-open", busyLabel: "Checking…" }));
      batchActions.append(ui().button("Open in linked window", "secondary", () => {
        void ui().perform("prepare-search-workspace", prepareSearchWorkspaceDraft);
      }, { actionName: "prepare-search-workspace", busyLabel: "Reviewing…" }));
      const shortcuts = ui().element("details", "tab-search__selection-more");
      shortcuts.append(ui().element("summary", undefined, "Workspace actions"));
      const shortcutMenu = ui().element("div");
      const addShortcut = (label: string, selections: readonly SearchSelection[]): void => {
        const control = ui().element("button", undefined, label);
        control.type = "button";
        control.addEventListener("click", () => {
          selections.forEach((item) => { if (item.kind === "stash") toggleSearchBatchItem(item.result, true); });
          shortcuts.open = false;
          drawResults(false);
        });
        shortcutMenu.append(control);
      };
      addShortcut("Select visible saved", [...directStashes, ...relatedStashes]);
      addShortcut("Select direct saved", directStashes);
      addShortcut("Select related saved", relatedStashes);
      const editStashes = ui().element("button", undefined, "Edit source workspaces…");
      editStashes.type = "button";
      editStashes.dataset.searchEditTrigger = "true";
      editStashes.addEventListener("click", () => {
        shortcuts.open = false;
        openSearchEditDraft();
        drawResults(false);
      });
      shortcutMenu.append(editStashes);
      shortcuts.append(shortcutMenu);
      batchActions.append(shortcuts);
      bar.append(summary, clear, batchActions);
      batchControls.append(bar);

      if (searchSelectionTrayOpen) {
        const tray = ui().element("ul", "tab-search__selection-tray");
        for (const [key, item] of searchBatchSelection) {
          const trayRow = ui().element("li");
          const trayCopy = ui().element("span");
          trayCopy.append(ui().element("strong", undefined, item.title), ui().element("small", undefined, [item.stashName, item.groupName].filter(Boolean).join(" · ")));
          const remove = ui().element("button", undefined, "Remove");
          remove.type = "button";
          remove.setAttribute("aria-label", `Remove ${item.title} from selection`);
          remove.addEventListener("click", () => { searchBatchSelection.delete(key); searchOpenPreview = null; searchEditDraft = null; drawResults(false); });
          trayRow.append(trayCopy, remove);
          tray.append(trayRow);
        }
        batchControls.append(tray);
      }

      if (searchOpenPreview) {
        const preview = ui().element("section", "tab-search__open-preview");
        preview.append(ui().element("strong", undefined, `Open ${searchBatchSelection.size} selected tabs`));
        const sources = new Set([...searchBatchSelection.values()].map((item) => item.reference.stashId)).size;
        const groups = new Set([...searchBatchSelection.values()].flatMap((item) => item.groupName ? [`${item.reference.stashId}\u0000${item.groupName}`] : [])).size;
        preview.append(ui().element("p", undefined, `From ${sources} workspace${sources === 1 ? "" : "s"} · ${groups} saved group${groups === 1 ? "" : "s"}`));
        const destination = ui().element("select", "input");
        ([['current_window', 'Current window'], ['new_window', 'New window']] as const).forEach(([value, label]) => {
          const option = ui().element("option", undefined, label);
          option.value = value;
          option.selected = searchOpenPreview!.destination === value;
          destination.append(option);
        });
        destination.addEventListener("change", () => { if (searchOpenPreview) searchOpenPreview.destination = destination.value as "current_window" | "new_window"; });
        const duplicates = ui().element("select", "input");
        ([['reuse', 'Reuse exact matches'], ['skip', 'Skip exact matches'], ['duplicate', 'Open another copy']] as const).forEach(([value, label]) => {
          const option = ui().element("option", undefined, label);
          option.value = value;
          option.selected = searchOpenPreview!.duplicateHandling === value;
          duplicates.append(option);
        });
        duplicates.addEventListener("change", () => { if (searchOpenPreview) searchOpenPreview.duplicateHandling = duplicates.value as "reuse" | "skip" | "duplicate"; });
        preview.append(
          ui().field("Destination", destination),
          ui().field("Already open", duplicates, `${searchOpenPreview.exactOpen} exact match${searchOpenPreview.exactOpen === 1 ? "" : "es"} found`),
        );
        if (searchOpenPreview.possibleDuplicates > 0) {
          preview.append(ui().element("p", "tab-search__possible-duplicates", `${searchOpenPreview.possibleDuplicates} possible duplicate${searchOpenPreview.possibleDuplicates === 1 ? "" : "s"} will not be reused automatically.`));
        }
        if (searchOpenPreview.changed > 0 || searchOpenPreview.stale > 0) {
          preview.append(ui().element(
            "p",
            "tab-search__stale-warning",
            `${searchOpenPreview.changed + searchOpenPreview.stale} selected tab${searchOpenPreview.changed + searchOpenPreview.stale === 1 ? " has" : "s have"} changed since search · ${searchOpenPreview.changed} still available · ${searchOpenPreview.stale} removed. Continue opens only currently available tabs.`,
          ));
        }
        const previewActions = ui().element("div", "tab-search__preview-actions");
        previewActions.append(
          ui().button("Cancel", "quiet", () => { searchOpenPreview = null; drawResults(false); }),
          ui().button("Open tabs", "primary", () => void ui().perform("open-search-selection", openSearchBatch), { actionName: "open-search-selection", busyLabel: "Opening…" }),
        );
        preview.append(previewActions);
        batchControls.append(preview);
      }
      if (searchWorkspaceDraft) {
        const form = ui().element("section", "tab-search__workspace-form");
        form.append(
          ui().element("strong", undefined, `Create a linked window from ${ui().formatCount(searchBatchSelection.size, "tab")}`),
          ui().element("p", undefined, "Creates a new workspace in a linked window. Every source workspace stays unchanged."),
        );
        const name = ui().input(searchWorkspaceDraft.name);
        name.maxLength = 120;
        name.addEventListener("input", () => { if (searchWorkspaceDraft) searchWorkspaceDraft.name = name.value; });
        const preserve = ui().check("Preserve saved groups", "Only selected group members are included. Same-named groups from different workspaces remain separate.", searchWorkspaceDraft.preserveGroups);
        preserve.control.addEventListener("change", () => { if (searchWorkspaceDraft) searchWorkspaceDraft.preserveGroups = preserve.control.checked; });
        form.append(ui().field("Name", name), preserve.wrapper);
        if (searchWorkspaceDraft.changed > 0 || searchWorkspaceDraft.stale > 0) {
          form.append(ui().element(
            "p",
            "tab-search__stale-warning",
            `${searchWorkspaceDraft.changed + searchWorkspaceDraft.stale} selected tab${searchWorkspaceDraft.changed + searchWorkspaceDraft.stale === 1 ? " has" : "s have"} changed since search · ${searchWorkspaceDraft.changed} still available · ${searchWorkspaceDraft.stale} removed. Review the tray, then continue with currently available tabs.`,
          ));
        }
        const formActions = ui().element("div", "tab-search__preview-actions");
        formActions.append(
          ui().button("Cancel", "quiet", () => { searchWorkspaceDraft = null; drawResults(false); }),
          ui().button(searchWorkspaceDraft.changed || searchWorkspaceDraft.stale ? "Continue with available tabs" : "Create and open", "primary", () => void ui().perform("create-search-workspace", createSearchWorkspace), { actionName: "create-search-workspace", busyLabel: "Creating…" }),
        );
        form.append(formActions);
        batchControls.append(form);
      }
    }
    appendSearchEditPanel(batchControls, () => drawResults(false));
  };
  searchInput.addEventListener("input", () => {
    cancelSemanticSearch();
    searchQuery = searchInput.value;
    searchSelectedIndex = 0;
    currentSelections = [];
    drawResults();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (searchOpenPreview || searchWorkspaceDraft || searchEditDraft) {
        searchOpenPreview = null;
        searchWorkspaceDraft = null;
        searchEditDraft = null;
        searchEditPendingFocus = "trigger";
        drawResults(false);
        return;
      }
      if (searchBatchSelection.size > 0) {
        searchBatchSelection.clear();
        drawResults(false);
        return;
      }
      cancelSemanticSearch();
      popupState.searchOpen = false;
      ui().render();
      queueMicrotask(() => ui().actionRoot().querySelector<HTMLButtonElement>("[data-search-trigger]")?.focus());
      return;
    }
    if (event.key === "Enter" && currentSelections.length > 0) {
      event.preventDefault();
      const selection = currentSelections[searchSelectedIndex]!;
      if (selection.kind === "open") void focusSearchResult(selection.result);
      else void openStashedSearchResult(selection.result);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      scheduleSemanticSearch(true);
      return;
    }
    if (currentSelections.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      searchSelectedIndex = (searchSelectedIndex + direction + currentSelections.length) % currentSelections.length;
      drawResults(false);
      resultList.querySelector<HTMLElement>(".tab-search__result--selected")?.scrollIntoView({ block: "nearest" });
    }
  });
  // The live field sits where the popup's command field was. Scope and search by
  // meaning share one row beneath it; setup follows the results.
  const toolbar = ui().element("div", "tab-search__toolbar");
  toolbar.append(scope, semanticActions);
  searchField.append(toolbar);
  panel.append(heading, searchField, batchControls, resultList);
  if (semanticReadiness) panel.append(semanticReadiness);
  shell.append(panel);
  semanticSearchRedraw = () => {
    if (panel.isConnected) drawResults(false);
  };
  drawResults();
  if (searchAutofocusPending) {
    searchAutofocusPending = false;
    queueMicrotask(() => {
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    });
  }
}

// The specific reason first, with a real wait time when the gate knows one, so a
// rate limit reads differently from a bad key or an empty index.
function semanticFailureText(code: string | null): string {
  const label = ui().semanticSearchFailureLabel(code);
  const seconds = semanticFailure.retryInSeconds(semanticSearchKey());
  return seconds === null ? label : label.replace(/try again shortly$/, `try again in ${seconds} s`);
}
