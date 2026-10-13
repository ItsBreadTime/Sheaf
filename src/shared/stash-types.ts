export type TabStashScope =
  | { mode: "group"; groupId: number }
  | { mode: "selection"; tabIds: number[] }
  | { mode: "window" };

export interface StashedTab {
  sourceTabId: number;
  sourceIndex: number;
  title: string;
  url: string;
  groupKey: string | null;
  stableKey?: string;
}

export interface StashedGroup {
  key: string;
  sourceGroupId: number;
  sourceIndex: number;
  title: string;
  color: chrome.tabGroups.TabGroup["color"];
  collapsed: boolean;
}

export interface StashExcludedTab {
  sourceTabId: number;
  sourceIndex: number;
  title: string;
  reasons: string[];
}

export interface TabStashPreview {
  name: string;
  scope: TabStashScope;
  tabs: StashedTab[];
  groups: StashedGroup[];
  excludedTabs: StashExcludedTab[];
}

export interface TabStashRevision {
  id: string;
  savedAt: number;
  tabs: StashedTab[];
  groups: StashedGroup[];
}

export type StashRestoreDestination = "new_window" | "current_window";
export type StashDuplicateHandling = "reuse" | "skip" | "duplicate";
export type StashAfterRestore = "keep" | "linked_workspace";

export interface StashRestoreOptions {
  destination: StashRestoreDestination;
  duplicateHandling: StashDuplicateHandling;
  afterRestore: StashAfterRestore;
}

// The latest capture of a linked window, kept while the window is open so it
// can be saved after the window (and with it the live tabs) is gone.
export interface LinkedStashWorkspaceDraft {
  tabs: StashedTab[];
  groups: StashedGroup[];
  capturedAt: number;
  captureToken: string;
}

export interface LinkedStashWorkspace {
  id: string;
  stashId: string;
  windowId: number;
  mode: "whole_window" | "tracked_tabs";
  trackedTabIds: number[];
  trackedTabs?: Array<{ tabId: number; stableKey: string }>;
  startedAt: number;
  updatedAt: number;
  draft?: LinkedStashWorkspaceDraft | null;
}

export interface StashWorkspaceDiff {
  addedTabs: number;
  removedTabs: number;
  changedTabs: number;
  renamedGroups: number;
  groupStructureChanges: number;
  reorderedTabs: number;
  currentTabCount: number;
  captureToken: string;
  addedTitles?: string[];
  removedTitles?: string[];
  /** Open tabs in the linked window that are private and never saved. */
  privateTabs?: number;
}

export interface StashCopyOpenResult {
  requested: number;
  opened: number;
  reused: number;
  skipped: number;
  failed: number;
  stale: number;
  restoredGroups: number;
  conflicts: string[];
  retryItems: import("../search/stash-selection").StashTabReference[];
}

export type TabStashStatus = "saved" | "restored" | "restore_partial" | "closing_interrupted";

export type TabStashAutoDeleteDays = 1 | 7 | 30 | 90 | null;

export interface TabStashSettings {
  autoDeleteAfterDays: TabStashAutoDeleteDays;
}

export interface SavedTabStash extends TabStashPreview {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  note: string;
  revisions: TabStashRevision[];
  activeWorkspaceId: string | null;
  status: TabStashStatus;
  closeConflicts: string[];
  restoreResult: StashRestoreResult | null;
  provenance?: {
    kind: "search_selection";
    createdAt: number;
    sources: Array<{ stashId: string; stashTabId: string }>;
    sourceQueries: string[];
  };
}

export type TrashedTabStashReason = "deleted" | "expired";

export interface TrashedTabStash {
  stash: SavedTabStash;
  trashedAt: number;
  reason: TrashedTabStashReason;
}

export interface SearchWorkspaceCreationResult {
  stashId: string | null;
  available: number;
  stale: number;
  opened: number;
  failed: number;
  conflicts: string[];
  requiresReview?: boolean;
}

export type StashSearchEditOperation = "remove" | "move" | "merge";

export interface StashSearchEditSummary {
  stashId: string;
  stashName: string;
  beforeTabs: number;
  afterTabs: number;
  beforeGroups: number;
  afterGroups: number;
}

export interface StashSearchEditPreview {
  operation: StashSearchEditOperation;
  targetStashId: string | null;
  available: number;
  stale: number;
  changedSinceSearch: number;
  reviewedSelectionToken: string;
  sourceSummaries: StashSearchEditSummary[];
  targetSummary: StashSearchEditSummary | null;
  blockedReason: string | null;
}

export interface StashSearchEditUndoPoint {
  transactionId: string;
  operation: StashSearchEditOperation;
  createdAt: number;
  before: SavedTabStash[];
  after: SavedTabStash[];
}

export interface StashSearchEditPlan {
  preview: StashSearchEditPreview;
  stashes: SavedTabStash[];
  undoPoint: StashSearchEditUndoPoint | null;
  requiresReview: boolean;
}

export interface StashSearchEditApplyResult {
  preview: StashSearchEditPreview;
  applied: boolean;
  requiresReview: boolean;
  transactionId: string | null;
}

export interface StashSearchEditUndoResult {
  undone: boolean;
  unavailableReason: string | null;
}

export interface StashRestoreResult {
  restoredAt: number;
  openedTabs: number;
  reusedTabs?: number;
  skippedTabs?: number;
  restoredGroups: number;
  conflicts: string[];
}
