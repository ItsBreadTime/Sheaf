import type { SemanticWindowState } from "../shared/types";
import type {
  SavedTabStash,
  StashExcludedTab,
  StashedGroup,
  StashedTab,
  TabStashPreview,
  TabStashScope,
} from "../shared/stash-types";

function stashTabReasons(tab: SemanticWindowState["tabs"][number]): string[] {
  const reasons = [...tab.protectionReasons];
  if (tab.audible && !reasons.includes("Audible tab")) reasons.push("Audible tab");
  return reasons;
}

export function buildTabStashPreview(
  state: SemanticWindowState,
  scope: TabStashScope,
  now = Date.now(),
): TabStashPreview {
  const selectedGroup = scope.mode === "group"
    ? state.groups.find((group) => group.runtimeId === scope.groupId)
    : null;
  if (scope.mode === "group" && !selectedGroup) {
    throw new Error("The selected tab group no longer exists.");
  }
  const selectedTabIds = scope.mode === "selection" ? new Set(scope.tabIds) : null;
  const candidates = scope.mode === "window"
    ? state.tabs
    : scope.mode === "group"
      ? state.tabs.filter((tab) => tab.groupId === scope.groupId)
      : state.tabs.filter((tab) => selectedTabIds!.has(tab.id));
  const groupKeys = new Map<number, string>();
  state.groups.forEach((group, index) => groupKeys.set(group.runtimeId, `group-${index + 1}`));
  const tabs: StashedTab[] = [];
  const excludedTabs: StashExcludedTab[] = [];
  candidates.forEach((tab) => {
    const reasons = stashTabReasons(tab);
    if (reasons.length > 0) {
      excludedTabs.push({
        sourceTabId: tab.id,
        sourceIndex: tab.index,
        title: tab.title,
        reasons,
      });
      return;
    }
    tabs.push({
      sourceTabId: tab.id,
      sourceIndex: tab.index,
      title: tab.title,
      url: tab.url,
      groupKey: tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
        ? null
        : groupKeys.get(tab.groupId) ?? null,
      stableKey: crypto.randomUUID(),
    });
  });
  const usedGroupKeys = new Set(tabs.flatMap((tab) => tab.groupKey ? [tab.groupKey] : []));
  const groups: StashedGroup[] = state.groups.flatMap((group) => {
    const key = groupKeys.get(group.runtimeId);
    if (!key || !usedGroupKeys.has(key)) return [];
    return [{
      key,
      sourceGroupId: group.runtimeId,
      sourceIndex: group.firstTabIndex,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
    }];
  });
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  return {
    name: scope.mode === "group"
      ? selectedGroup!.title.trim() || "Untitled group"
      : scope.mode === "selection"
        ? `Cleanup · ${formatted}`
        : `Window · ${formatted}`,
    scope,
    tabs,
    groups,
    excludedTabs,
  };
}

export function savedStashFromPreview(
  preview: TabStashPreview,
  createdAt = Date.now(),
): SavedTabStash {
  return {
    ...structuredClone(preview),
    id: crypto.randomUUID(),
    createdAt,
    updatedAt: createdAt,
    note: "",
    revisions: [],
    lastOpenedAt: null,
    activeWorkspaceId: null,
    status: "saved",
    closeConflicts: [],
    restoreResult: null,
  };
}
