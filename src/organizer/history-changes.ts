import { UNGROUPED_GROUP_ID } from "../shared/constants";
import type {
  HistoryGenerationStats,
  HistoryGroupChanges,
  HistoryTabChanges,
} from "../shared/transaction-types";
import type { ProviderJobResult } from "../shared/organizer-types";
import type { SemanticWindowState } from "../shared/types";

/**
 * Maps each group in `after` to the group in `before` it continues, or null for
 * a group with no predecessor. A surviving group continues itself. A newly
 * created group continues the unclaimed source that supplied most of its tabs,
 * so "one tab joined Research" reads as one tab moving, not as a whole new group.
 */
function groupContinuations(
  before: SemanticWindowState,
  after: SemanticWindowState,
): Map<number, number | null> {
  const beforeGroupIds = new Set(before.groups.map((group) => group.runtimeId));
  const beforeTabGroup = new Map(before.tabs.map((tab) => [tab.id, tab.groupId]));
  const continuation = new Map<number, number | null>();
  const claimed = new Set<number>();
  for (const group of after.groups) {
    if (!beforeGroupIds.has(group.runtimeId)) continue;
    continuation.set(group.runtimeId, group.runtimeId);
    claimed.add(group.runtimeId);
  }
  const created = after.groups
    .filter((group) => !continuation.has(group.runtimeId))
    .sort((left, right) => right.memberTabIds.length - left.memberTabIds.length);
  for (const group of created) {
    const sources = new Map<number, number>();
    for (const tabId of group.memberTabIds) {
      const source = beforeTabGroup.get(tabId);
      if (source === undefined || source === UNGROUPED_GROUP_ID) continue;
      sources.set(source, (sources.get(source) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestCount = 0;
    for (const [source, count] of sources) {
      if (!claimed.has(source) && count > bestCount) {
        best = source;
        bestCount = count;
      }
    }
    continuation.set(group.runtimeId, best);
    if (best !== null) claimed.add(best);
  }
  return continuation;
}

/** Length-preserving longest increasing subsequence; returns the kept positions. */
function longestIncreasingIndexes(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]!]! < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  });
  const kept = new Set<number>();
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    kept.add(cursor);
    cursor = previous[cursor]!;
  }
  return kept;
}

export function summarizeWindowChanges(
  before: SemanticWindowState,
  after: SemanticWindowState,
  closedTabs = 0,
): { tabs: HistoryTabChanges; groups: HistoryGroupChanges } {
  const continuation = groupContinuations(before, after);
  const beforeTabs = new Map(before.tabs.map((tab) => [tab.id, tab]));
  const beforeGroups = new Map(before.groups.map((group) => [group.runtimeId, group]));
  const tabs: HistoryTabChanges = { grouped: 0, regrouped: 0, ungrouped: 0, reordered: 0, closed: closedTabs };
  // Before-window positions of tabs whose group did not change, in their new
  // order. The fewest tabs that must move to produce that order are the ones
  // outside its longest increasing run.
  const stayedPositions: number[] = [];
  for (const tab of [...after.tabs].sort((left, right) => left.index - right.index)) {
    const previous = beforeTabs.get(tab.id);
    if (!previous) continue;
    const wasGrouped = previous.groupId !== UNGROUPED_GROUP_ID;
    const isGrouped = tab.groupId !== UNGROUPED_GROUP_ID;
    if (!wasGrouped && isGrouped) tabs.grouped += 1;
    else if (wasGrouped && !isGrouped) tabs.ungrouped += 1;
    else if (wasGrouped && isGrouped && continuation.get(tab.groupId) !== previous.groupId) tabs.regrouped += 1;
    else stayedPositions.push(previous.index);
  }
  tabs.reordered = stayedPositions.length - longestIncreasingIndexes(stayedPositions).size;

  const groups: HistoryGroupChanges = { created: 0, renamed: 0, recolored: 0, removed: 0 };
  const continued = new Set<number>();
  for (const group of after.groups) {
    const source = continuation.get(group.runtimeId) ?? null;
    if (source === null) {
      groups.created += 1;
      continue;
    }
    continued.add(source);
    const previous = beforeGroups.get(source);
    if (!previous) continue;
    if (previous.title.trim() !== group.title.trim()) groups.renamed += 1;
    if (previous.color !== group.color) groups.recolored += 1;
  }
  groups.removed = before.groups.filter((group) => !continued.has(group.runtimeId)).length;
  return { tabs, groups };
}

export function totalTabsMoved(changes: HistoryTabChanges): number {
  return changes.grouped + changes.regrouped + changes.ungrouped + changes.reordered;
}

export function historyGenerationStats(
  job: Pick<ProviderJobResult, "usage" | "metrics" | "repairAttempted"> | null | undefined,
): HistoryGenerationStats | undefined {
  if (!job?.metrics && !job?.usage) return undefined;
  return {
    reasoningEffort: job.metrics?.reasoningEffort ?? null,
    timeToFirstTokenMs: job.metrics?.timeToFirstTokenMs ?? null,
    providerMs: job.metrics?.providerMs ?? null,
    outputTokensPerSecond: job.metrics?.outputTokensPerSecond ?? null,
    promptTokens: job.usage?.promptTokens ?? null,
    completionTokens: job.usage?.completionTokens ?? null,
    reasoningTokens: job.usage?.reasoningTokens ?? null,
    cachedTokens: job.usage?.cachedTokens ?? null,
    totalTokens: job.usage?.totalTokens ?? null,
    repairAttempted: job.repairAttempted,
  };
}
