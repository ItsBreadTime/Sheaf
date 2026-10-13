import type { UserProtectionRule } from "./protection-types";
import type { SearchWorkspaceCreationResult, StashCopyOpenResult, StashRestoreOptions, StashRestoreResult, StashSearchEditApplyResult, StashSearchEditOperation, StashSearchEditPreview, StashSearchEditUndoResult, StashWorkspaceDiff, TabStashScope } from "./stash-types";
import type { StashTabReference } from "../search/stash-selection";
import type { SemanticIndexMeta } from "./semantic-index-types";
import type {
  GeneratedGroupAutoCleanupDays,
  GeneratedGroupCleanupResult,
  GeneratedGroupCleanupSummary,
  GroupManagerApplyResult,
  GroupManagerEditDraft,
  GroupManagerEditPreview,
  GroupManagerRemovalMode,
  GroupManagerRemovalPreview,
  GroupManagerState,
  GroupManagerUndoResult,
} from "./group-manager-types";

export type FeatureValue<T> =
  | { known: true; value: T }
  | { known: false; value: null };

export interface SemanticTab {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  groupId: number;
  active: boolean;
  highlighted?: boolean;
  pinned: boolean;
  audible: boolean;
  openerTabId: number | null;
  lastAccessed: number | null;
  splitView: FeatureValue<number>;
  protectionReasons: string[];
}

export interface SemanticGroup {
  runtimeId: number;
  windowId: number;
  title: string;
  color: chrome.tabGroups.TabGroup["color"];
  collapsed: boolean;
  shared: FeatureValue<boolean>;
  memberTabIds: number[];
  firstTabIndex: number;
  protectionReasons: string[];
}

export interface SemanticWindowState {
  windowId: number;
  capturedAt: number;
  tabs: SemanticTab[];
  groups: SemanticGroup[];
  eligibleTabIds: number[];
  protectedTabIds: number[];
  featureSupport: {
    sharedGroupProperty: boolean;
    splitViewIdProperty: boolean;
    storageSession: boolean;
  };
}

export interface SemanticComparison {
  matches: boolean;
  issues: string[];
}

export interface CompatibilityVerification {
  passed: boolean;
  checkedAt: number;
  issues: string[];
}

export interface EditorSessionState {
  targetWindowId: number;
  editorWindowId: number | null;
  capturedState: SemanticWindowState;
  openedAt: number;
  lastEditorClosedAt: number | null;
  lastEditorClosedWindowId: number | null;
  error: string | null;
}

export interface WindowCaptureViewState {
  editor: EditorSessionState | null;
  editorLease: import("./proposal-review-types").EditorLease | null;
  transactionRun: OrganizationRun | null;
  undoPoint: import("./transaction-types").UndoPoint | null;
}

export interface ProposedGroup {
  temporaryId: string;
  title: string;
  color: chrome.tabGroups.TabGroup["color"];
  collapsed: boolean;
  tabIds: number[];
}

export interface OrganizationProposal {
  groups: ProposedGroup[];
  untouchedTabIds: number[];
  /** Subset of untouchedTabIds that leave their current native group. */
  ungroupTabIds?: number[];
  lowValueTabIds?: number[];
}

export type BrowserOperation =
  | {
      operationId: string;
      kind: "create_group";
      groupRef: string;
      tabIds: number[];
    }
  | {
      operationId: string;
      kind: "update_group";
      groupRef: string;
      title: string;
      color: chrome.tabGroups.TabGroup["color"];
      collapsed: boolean;
    }
  | {
      operationId: string;
      kind: "move_group";
      groupRef: string;
      index: number;
    }
  | {
      /** Reorders a group in place; index is the group's first tab. */
      operationId: string;
      kind: "order_group";
      groupRef: string;
      tabIds: number[];
      index: number;
    }
  | {
      operationId: string;
      kind: "ungroup_tabs";
      tabIds: number[];
    }
  | {
      /** Moves ungrouped tabs, in this order, to the end of the window. */
      operationId: string;
      kind: "arrange_loose_tabs";
      tabIds: number[];
    };

export type TransactionStatus =
  | "prepared"
  | "applying"
  | "verifying"
  | "rolling_back";

export interface TransactionJournal {
  transactionId: string;
  targetWindowId: number;
  rollbackSnapshot: SemanticWindowState;
  expectedFinalState: SemanticWindowState;
  operationPlan: BrowserOperation[];
  /** Tabs whose group membership changes. */
  touchedTabIds: number[];
  /** Ungrouped tabs that only change position; restored with touched tabs on rollback. */
  arrangedTabIds?: number[];
  runtimeGroupIds: Record<string, number>;
  inFlightOperation: number | null;
  completedThrough: number;
  status: TransactionStatus;
}

export type OrganizationRunStatus =
  | "prepared"
  | "applying"
  | "verifying"
  | "completed"
  | "rolling_back"
  | "rolled_back"
  | "rollback_partial"
  | "interrupted"
  | "failed";

export type FaultInjectionMode = "none" | "apply_failure" | "rollback_failure";

export interface OrganizationRun {
  transactionId: string;
  targetWindowId: number;
  selectedTabIds: number[];
  proposal: OrganizationProposal;
  inputSnapshot: SemanticWindowState;
  journal: TransactionJournal;
  status: OrganizationRunStatus;
  faultInjection: FaultInjectionMode;
  verification: CompatibilityVerification | null;
  rollbackVerification: CompatibilityVerification | null;
  blankTabCloseResult?: {
    requested: number;
    closed: number;
    skipped: number;
  };
  error: string | null;
}

export type WindowCaptureMessage =
  | { type: "window-capture:get-state" }
  | {
      type: "popup:initialize";
      targetWindowId: number;
      ownerContextId: string;
    }
  | {
      type: "popup:heartbeat";
      targetWindowId: number;
      ownerContextId: string;
    }
  | { type: "window-capture:refresh" }
  | {
      type: "organization:generate";
      targetWindowId: number;
      scope: import("./organizer-types").OrganizationScope;
    }
  | { type: "organization:cancel-generate" }
  | {
      type: "organization:apply";
      reviewId: string;
      ownerContextId: string;
      /** The caller closes once Apply starts, so the outcome is reported by notification. */
      reportOutcome?: boolean;
    }
  | { type: "organization:undo"; transactionId: string }
  | { type: "group-manager:get-state"; currentWindowId: number | null }
  | { type: "group-manager:set-managed"; groupIds: number[]; managed: boolean }
  | { type: "group-manager:preview-edit"; draft: GroupManagerEditDraft }
  | { type: "group-manager:apply-edit"; preview: GroupManagerEditPreview }
  | {
      type: "group-manager:preview-remove";
      groupIds: number[];
      mode: GroupManagerRemovalMode;
      includeActive: boolean;
    }
  | { type: "group-manager:apply-remove"; preview: GroupManagerRemovalPreview }
  | { type: "group-manager:undo" }
  | { type: "generated-groups:get-cleanup" }
  | { type: "generated-groups:set-cleanup"; autoUngroupAfterDays: GeneratedGroupAutoCleanupDays }
  | { type: "generated-groups:clear" }
  | {
      type: "cleanup:close-suggested-tabs";
      targetWindowId: number;
      tabIds: number[];
    }
  | {
      type: "protection:protect-tabs";
      targetWindowId: number;
      tabIds: number[];
      permanence: "session" | "permanent";
    }
  | {
      type: "protection:lock-groups";
      targetWindowId: number;
      groupIds: number[];
      permanence: "session" | "permanent";
    }
  | { type: "protection:update-rules"; rules: UserProtectionRule[] }
  | {
      type: "protection:release-session";
      targetWindowId: number;
      tabIds: number[];
      groupIds: number[];
    }
  | {
      type: "workspace:create";
      targetWindowId: number;
      scope: TabStashScope;
      expectedTabIds: number[];
      name: string;
      keepOpen?: boolean;
    }
  | {
      type: "workspace:restore";
      stashId: string;
      targetWindowId: number;
      sourceIndexes?: number[];
      options?: StashRestoreOptions;
      revisionId?: string;
    }
  | { type: "workspace:open-tab"; stashId: string; sourceIndex: number; targetWindowId: number; active: boolean }
  | {
      type: "workspace:open-copies";
      items: StashTabReference[];
      targetWindowId: number;
      destination: "current_window" | "new_window";
      duplicateHandling: "reuse" | "skip" | "duplicate";
    }
  | {
      type: "workspace:create-from-selection";
      items: StashTabReference[];
      targetWindowId: number;
      name: string;
      preserveGroups: boolean;
      sourceQueries: string[];
      reviewedSelectionToken: string;
    }
  | {
      type: "workspace:preview-search-edit";
      items: StashTabReference[];
      operation: StashSearchEditOperation;
      targetStashId?: string | null;
    }
  | {
      type: "workspace:apply-search-edit";
      items: StashTabReference[];
      operation: StashSearchEditOperation;
      targetStashId?: string | null;
      reviewedSelectionToken: string;
    }
  | { type: "workspace:undo-search-edit"; transactionId: string }
  | { type: "workspace:window-diff"; stashId: string }
  | { type: "workspace:window-save"; stashId: string; putAway: boolean; expectedCaptureToken: string }
  | { type: "workspace:window-unlink"; stashId: string }
  | { type: "workspace:update-metadata"; stashId: string; name: string; note: string }
  | { type: "workspace:delete"; stashId: string }
  | { type: "workspace:recover-interrupted"; stashId: string }
  | { type: "workspace:window-close"; stashId: string; discardChanges: boolean }
  | { type: "workspace:window-focus"; stashId: string }
  | { type: "workspace:trash-restore"; stashId: string }
  | { type: "workspace:trash-purge"; stashId: string }
  | { type: "workspace:revision-restore"; stashId: string; revisionId: string }
  | { type: "auto-filing:get-state" }
  | { type: "auto-filing:undo"; entryId?: string }
  | { type: "auto-filing:never-file"; entryId: string }
  | { type: "auto-filing:accept-suggestion" }
  | { type: "auto-filing:dismiss-suggestion" }
  | { type: "semantic-index:get-state" }
  | { type: "semantic-index:build"; targetWindowId: number }
  | { type: "semantic-index:resume" }
  | { type: "semantic-index:cancel" }
  | { type: "semantic-index:clear" };

export type WindowCaptureResponse =
  | {
      ok: true;
      state: WindowCaptureViewState;
      cleanupCloseResult?: {
        requested: number;
        closed: number;
        skipped: number;
      };
      semanticIndexMeta?: SemanticIndexMeta;
      stashWorkspaceDiff?: StashWorkspaceDiff;
      stashWorkspaceParkResult?: { windowClosed: boolean };
      stashCopyOpenResult?: StashCopyOpenResult;
      stashRestoreResult?: StashRestoreResult;
      searchWorkspaceCreationResult?: SearchWorkspaceCreationResult;
      stashSearchEditPreview?: StashSearchEditPreview;
      stashSearchEditApplyResult?: StashSearchEditApplyResult;
      stashSearchEditUndoResult?: StashSearchEditUndoResult;
      groupManagerState?: GroupManagerState;
      groupManagerEditPreview?: GroupManagerEditPreview;
      groupManagerRemovalPreview?: GroupManagerRemovalPreview;
      groupManagerApplyResult?: GroupManagerApplyResult;
      groupManagerUndoResult?: GroupManagerUndoResult;
      generatedGroupCleanupSummary?: GeneratedGroupCleanupSummary;
      generatedGroupCleanupResult?: GeneratedGroupCleanupResult;
      autoFilingView?: import("./auto-filing-types").AutoFilingViewState;
      /** A sentence for the popup's notice after an auto-filing action. */
      autoFilingMessage?: string;
    }
  | { ok: false; error: string; state: WindowCaptureViewState; semanticIndexMeta?: SemanticIndexMeta };
