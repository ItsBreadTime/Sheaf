import type { SemanticWindowState } from "./types";

export type GroupOwnershipOrigin = "created" | "managed";
export type GroupManagerScope = "current_window" | "all_windows";
export type GroupManagerOwnershipFilter = "managed" | "all";

export const DEFAULT_GROUP_MANAGER_OWNERSHIP_FILTER = "all" satisfies GroupManagerOwnershipFilter;
export type GroupManagerRemovalMode = "ungroup" | "close";

export type GeneratedGroupAutoCleanupDays = 1 | 3 | 7 | 14 | 30 | 90 | null;

export interface GeneratedGroupCleanupSettings {
  autoUngroupAfterDays: GeneratedGroupAutoCleanupDays;
}

export interface GeneratedGroupTrackingRecord {
  id: string;
  groupId: number;
  windowId: number;
  browserSessionId: string;
  createdAt: number;
  lastSeenAt: number;
  fingerprint: string | null;
  transactionId?: string;
}

export interface GeneratedGroupCleanupRun {
  mode: "automatic" | "manual";
  ranAt: number;
  groupsUngrouped: number;
  tabsKeptOpen: number;
  groupsSkipped: number;
}

export interface GeneratedGroupCleanupSummary {
  settings: GeneratedGroupCleanupSettings;
  trackedGroups: number;
  liveGeneratedGroups: number;
  eligibleGeneratedGroups: number;
  blockedGeneratedGroups: number;
  nextCleanupAt: number | null;
  lastRun: GeneratedGroupCleanupRun | null;
}

export interface GeneratedGroupCleanupResult extends GeneratedGroupCleanupRun {
  conflicts: string[];
}

export interface GroupOwnershipRecord {
  groupId: number;
  windowId: number;
  origin: GroupOwnershipOrigin;
  managed: boolean;
  recordedAt: number;
  transactionId?: string;
}

export interface GroupStashLink {
  groupId: number;
  windowId: number;
  stashId: string;
  memberTabIds: number[];
  title: string;
  color: chrome.tabGroups.TabGroup["color"];
  collapsed: boolean;
  recordedAt: number;
}

export interface GroupManagerProvenance {
  groupId: number;
  origin: GroupOwnershipOrigin;
  managed?: boolean;
  transactionId?: string;
  stashLink?: GroupStashLink;
}

export interface GroupManagerPendingPreview {
  previewToken: string;
  recordedAt: number;
  provenance: GroupManagerProvenance[];
}

export interface GroupManagerTab {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  hostname: string;
  groupId: number;
  active: boolean;
  audible: boolean;
  protected: boolean;
  protectionReasons: string[];
}

export type GroupManagerBadge =
  | "created"
  | "managed"
  | "stashed"
  | "stash_changed"
  | "linked"
  | "protected"
  | "partly_protected"
  | "active";

export interface GroupManagerGroup {
  id: number;
  windowId: number;
  windowLabel: string;
  title: string;
  color: chrome.tabGroups.TabGroup["color"];
  collapsed: boolean;
  tabIds: number[];
  tabCount: number;
  firstTabIndex: number;
  active: boolean;
  managed: boolean;
  ownership: GroupOwnershipOrigin | null;
  badges: GroupManagerBadge[];
  protectedTabCount: number;
  audibleTabCount: number;
}

export interface GroupManagerUndoPoint {
  transactionId: string;
  createdAt: number;
  points: Array<{
    targetWindowId: number;
    before: SemanticWindowState;
    expectedAfter: SemanticWindowState;
    touchedTabIds: number[];
    provenance?: GroupManagerProvenance[];
  }>;
}

export interface GroupManagerState {
  groups: GroupManagerGroup[];
  tabs: GroupManagerTab[];
  ownership: GroupOwnershipRecord[];
  capturedAt: number;
  canUndo: boolean;
}

export interface GroupManagerEditDraft {
  groupId: number;
  title: string;
  color: chrome.tabGroups.TabGroup["color"];
  collapsed: boolean;
  tabIds: number[];
}

export interface GroupManagerEditPreview {
  kind: "edit";
  previewToken: string;
  draft: GroupManagerEditDraft;
  windowId: number;
  beforeTabCount: number;
  afterTabCount: number;
  addedTabIds: number[];
  removedTabIds: number[];
  reordered: boolean;
  emptiedSourceGroupIds: number[];
  provenance?: {
    origin: GroupOwnershipOrigin;
    managed?: boolean;
    transactionId?: string;
    stashLink?: GroupStashLink;
  };
}

export interface GroupManagerRemovalBlockedGroup {
  groupId: number;
  reason: string;
}

export interface GroupManagerRemovalPreview {
  kind: "removal";
  previewToken: string;
  mode: GroupManagerRemovalMode;
  requestedGroupIds: number[];
  eligibleGroupIds: number[];
  eligibleTabIds: number[];
  blockedGroups: GroupManagerRemovalBlockedGroup[];
  activeGroupIds: number[];
  includeActive: boolean;
  provenance?: GroupManagerProvenance[];
}

export interface GroupManagerApplyResult {
  transactionId: string | null;
  groupsChanged: number;
  tabsChanged: number;
  skippedGroups: number;
  recoveryStashId: string | null;
  conflicts: string[];
}

export interface GroupManagerUndoResult {
  undone: boolean;
  conflicts: string[];
}

export interface GroupSemanticScore {
  groupId: number;
  score: number;
  matchingMembers: number;
}
