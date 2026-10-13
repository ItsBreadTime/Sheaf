import type {
  SavedTabStash,
  StashSearchEditOperation,
  StashSearchEditPlan,
  StashSearchEditPreview,
  StashSearchEditSummary,
  StashSearchEditUndoPoint,
  StashedGroup,
  StashedTab,
} from "../shared/stash-types";
import {
  orderResolvedStashTabs,
  resolveStashTabReferences,
  stashSelectionResolutionToken,
  type ResolvedStashTabReference,
  type StashTabReference,
} from "./stash-selection";

interface StashSearchEditOptions {
  targetStashId?: string | null;
  reviewedSelectionToken?: string;
  now?: number;
  createId?: () => string;
}

function summary(before: SavedTabStash, after: SavedTabStash): StashSearchEditSummary {
  return {
    stashId: before.id,
    stashName: before.name,
    beforeTabs: before.tabs.length,
    afterTabs: after.tabs.length,
    beforeGroups: before.groups.length,
    afterGroups: after.groups.length,
  };
}

function revisionOf(
  before: SavedTabStash,
  changed: SavedTabStash,
  now: number,
  createId: () => string,
): SavedTabStash {
  return {
    ...changed,
    updatedAt: now,
    revisions: [{
      id: createId(),
      savedAt: before.updatedAt,
      tabs: structuredClone(before.tabs),
      groups: structuredClone(before.groups),
    }, ...before.revisions].slice(0, 20),
    status: "saved",
    restoreResult: null,
  };
}

function removeSelected(stash: SavedTabStash, selected: readonly ResolvedStashTabReference[]): SavedTabStash {
  const selectedIds = new Set(selected.map((item) => item.stashTabId));
  const tabs = stash.tabs.filter((tab) => {
    const item = selected.find((candidate) => candidate.tab === tab);
    return !item || !selectedIds.has(item.stashTabId);
  });
  const representedGroups = new Set(tabs.flatMap((tab) => tab.groupKey === null ? [] : [tab.groupKey]));
  return { ...stash, tabs, groups: stash.groups.filter((group) => representedGroups.has(group.key)) };
}

function nextUniqueKey(prefix: string, used: Set<string>, createId: () => string): string {
  let key = `${prefix}-${createId()}`;
  while (used.has(key)) key = `${prefix}-${createId()}`;
  used.add(key);
  return key;
}

function nextUnusedNegative(used: Set<number>): number {
  let value = -1;
  while (used.has(value)) value -= 1;
  used.add(value);
  return value;
}

function appendSelection(
  target: SavedTabStash,
  selected: readonly ResolvedStashTabReference[],
  createId: () => string,
): SavedTabStash {
  const ordered = selected;
  const usedGroupKeys = new Set(target.groups.map((group) => group.key));
  const usedStableKeys = new Set(target.tabs.flatMap((tab) => tab.stableKey ? [tab.stableKey] : []));
  const usedTabIds = new Set(target.tabs.map((tab) => tab.sourceTabId));
  const usedGroupIds = new Set(target.groups.map((group) => group.sourceGroupId));
  const groupKeys = new Map<string, string>();
  const addedGroups: StashedGroup[] = [];
  const startIndex = target.tabs.reduce((maximum, tab) => Math.max(maximum, tab.sourceIndex), -1) + 1;
  for (const item of ordered) {
    if (!item.group) continue;
    const sourceKey = `${item.stashId}\u0000${item.group.key}`;
    if (groupKeys.has(sourceKey)) continue;
    const key = nextUniqueKey("search-group", usedGroupKeys, createId);
    groupKeys.set(sourceKey, key);
    const firstTabOffset = ordered.findIndex((candidate) =>
      candidate.stashId === item.stashId && candidate.group?.key === item.group?.key,
    );
    addedGroups.push({
      ...item.group,
      key,
      sourceGroupId: nextUnusedNegative(usedGroupIds),
      sourceIndex: startIndex + firstTabOffset,
    });
  }
  const addedTabs: StashedTab[] = ordered.map((item, index) => ({
    ...item.tab,
    sourceTabId: nextUnusedNegative(usedTabIds),
    sourceIndex: startIndex + index,
    stableKey: nextUniqueKey("search-tab", usedStableKeys, createId),
    groupKey: item.group ? groupKeys.get(`${item.stashId}\u0000${item.group.key}`) ?? null : null,
  }));
  return { ...target, tabs: [...target.tabs, ...addedTabs], groups: [...target.groups, ...addedGroups] };
}

function blockedReason(
  operation: StashSearchEditOperation,
  selected: readonly ResolvedStashTabReference[],
  target: SavedTabStash | undefined,
  targetStashId: string | null,
): string | null {
  if (selected.length === 0) return "Choose at least one available saved tab.";
  const activeSource = selected.find((item) => item.stash.activeWorkspaceId !== null)?.stash;
  if (activeSource) return `Save and close or unlink the window for “${activeSource.name}” before editing it.`;
  if (operation === "remove") return null;
  if (!targetStashId || !target) return "Choose an existing destination workspace.";
  if (target.activeWorkspaceId !== null) return `Save and close or unlink the window for “${target.name}” before editing it.`;
  if (selected.some((item) => item.stashId === target.id)) {
    return "Choose a destination workspace that is not one of the selected source workspaces.";
  }
  return null;
}

function stashSearchEditReviewToken(
  selectionToken: string,
  operation: StashSearchEditOperation,
  target: SavedTabStash | undefined,
): string {
  return JSON.stringify({
    selectionToken,
    operation,
    target: target ? {
      id: target.id,
      updatedAt: target.updatedAt,
      tabs: target.tabs,
      groups: target.groups,
      activeWorkspaceId: target.activeWorkspaceId,
    } : null,
  });
}

export function previewStashSearchEdit(
  stashes: readonly SavedTabStash[],
  references: readonly StashTabReference[],
  operation: StashSearchEditOperation,
  options: Pick<StashSearchEditOptions, "targetStashId"> = {},
): StashSearchEditPreview {
  const { available, stale } = resolveStashTabReferences(stashes, references);
  const targetStashId = operation === "remove" ? null : options.targetStashId ?? null;
  const target = targetStashId ? stashes.find((stash) => stash.id === targetStashId) : undefined;
  const ordered = orderResolvedStashTabs(stashes, available);
  const grouped = new Map<string, ResolvedStashTabReference[]>();
  for (const item of available) grouped.set(item.stashId, [...(grouped.get(item.stashId) ?? []), item]);
  const sourceSummaries = [...grouped.values()].map((items) => {
    const source = items[0]!.stash;
    const after = operation === "merge" ? source : removeSelected(source, items);
    return summary(source, after);
  });
  let previewId = 0;
  const targetAfter = target && operation !== "remove"
    ? appendSelection(target, ordered, () => `preview-${++previewId}`)
    : null;
  return {
    operation,
    targetStashId,
    available: available.length,
    stale: stale.length,
    changedSinceSearch: available.filter((item) => item.changedSinceSearch).length,
    reviewedSelectionToken: stashSearchEditReviewToken(
      stashSelectionResolutionToken(available, stale),
      operation,
      target,
    ),
    sourceSummaries,
    targetSummary: target && targetAfter ? summary(target, targetAfter) : null,
    blockedReason: blockedReason(operation, available, target, targetStashId),
  };
}

export function planStashSearchEdit(
  stashes: readonly SavedTabStash[],
  references: readonly StashTabReference[],
  operation: StashSearchEditOperation,
  options: StashSearchEditOptions = {},
): StashSearchEditPlan {
  const preview = previewStashSearchEdit(stashes, references, operation, options);
  if (options.reviewedSelectionToken !== preview.reviewedSelectionToken) {
    return { preview, stashes: structuredClone([...stashes]), undoPoint: null, requiresReview: true };
  }
  if (preview.blockedReason) throw new Error(preview.blockedReason);
  const now = options.now ?? Date.now();
  const createId = options.createId ?? (() => crypto.randomUUID());
  const { available } = resolveStashTabReferences(stashes, references);
  const ordered = orderResolvedStashTabs(stashes, available);
  const bySource = new Map<string, ResolvedStashTabReference[]>();
  for (const item of available) bySource.set(item.stashId, [...(bySource.get(item.stashId) ?? []), item]);
  const target = preview.targetStashId ? stashes.find((stash) => stash.id === preview.targetStashId)! : undefined;
  const changed = new Map<string, SavedTabStash>();
  if (operation !== "merge") {
    for (const [stashId, selected] of bySource) {
      const source = stashes.find((stash) => stash.id === stashId)!;
      changed.set(stashId, revisionOf(source, removeSelected(source, selected), now, createId));
    }
  }
  if (target) changed.set(target.id, revisionOf(target, appendSelection(target, ordered, createId), now, createId));
  const before = stashes.filter((stash) => changed.has(stash.id)).map((stash) => structuredClone(stash));
  const after = before.map((stash) => structuredClone(changed.get(stash.id)!));
  const undoPoint: StashSearchEditUndoPoint = {
    transactionId: createId(), operation, createdAt: now, before, after,
  };
  return {
    preview,
    stashes: stashes.map((stash) => changed.get(stash.id) ?? stash),
    undoPoint,
    requiresReview: false,
  };
}
