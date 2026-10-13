import type { OrganizationProposal, OrganizationRun, SemanticWindowState } from "./types";
import type { OrganizationScope, ReasoningEffort } from "./organizer-types";

export type UndoStatus = "available" | "running" | "completed" | "partial" | "unavailable";

export interface UndoPoint {
  transactionId: string;
  targetWindowId: number;
  before: SemanticWindowState;
  expectedAfter: SemanticWindowState;
  touchedTabIds: number[];
  createdAt: number;
  status: UndoStatus;
  conflicts: string[];
}

export interface OrganizationSessionState {
  activeRun: OrganizationRun | null;
  undoPoint: UndoPoint | null;
}

/** What happened to tabs, measured from the window before and after the run. */
export interface HistoryTabChanges {
  /** Ungrouped tabs that joined a group. */
  grouped: number;
  /** Tabs that left one group for another. */
  regrouped: number;
  /** Tabs that left a group and stayed loose. */
  ungrouped: number;
  /** Tabs that kept their group but changed position. */
  reordered: number;
  /** Inactive blank tabs closed after the run. */
  closed: number;
}

export interface HistoryGroupChanges {
  created: number;
  renamed: number;
  recolored: number;
  /** Groups that no longer exist afterwards: merged into another or emptied. */
  removed: number;
}

export interface HistoryGenerationStats {
  reasoningEffort: ReasoningEffort | null;
  timeToFirstTokenMs: number | null;
  providerMs: number | null;
  outputTokensPerSecond: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  repairAttempted: boolean;
}

export interface OrganizationHistoryReport {
  timestamp: number;
  providerType: "openai_compatible";
  providerOrigin: string;
  model: string;
  tabsSubmitted: number;
  tabsChanged: number;
  tabsMoved?: number;
  eligibleUngroupedSubmitted?: number;
  newlyGrouped?: number;
  remainingUngrouped?: number;
  groupsCreated: number;
  groupsRenamed?: number;
  groupsMerged?: number;
  groupsSplit?: number;
  groupCount?: number;
  durationMs?: number;
  scopeMode?: OrganizationScope["mode"];
  resultStatus: OrganizationRun["status"];
  rollbackStatus: "not_needed" | "complete" | "partial";
  undoStatus: UndoStatus;
  undoConflictCount?: number;
  /** Absent on runs recorded before tab-level history existed. */
  tabChanges?: HistoryTabChanges;
  groupChanges?: HistoryGroupChanges;
  generation?: HistoryGenerationStats;
}

export interface IntegratedProposal {
  proposal: OrganizationProposal;
  browserTabIds: number[];
}
