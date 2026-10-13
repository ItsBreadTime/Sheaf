import type { FilingLocation, FilingLogEntry } from "../shared/auto-filing-types";
import type { TabRef } from "../shared/tab-ref";

/**
 * The filing log is separate from the organize undo point: a quiet filing must
 * never replace the user's last organize undo. Undo is conflict-aware in the
 * same spirit as `executeConflictAwareUndo`: a tab goes back only if it is
 * still where filing put it.
 */

export const FILING_LOG_LIMIT = 20;

export function appendFilingLog(log: readonly FilingLogEntry[], entry: FilingLogEntry): FilingLogEntry[] {
  return [entry, ...log.filter((item) => item.tabId !== entry.tabId)].slice(0, FILING_LOG_LIMIT);
}

export interface LiveTabPlacement {
  windowId: number;
  groupId: FilingLocation;
}

export type FilingUndoPlan =
  | ({ action: "restore"; groupId: FilingLocation; index: number } & TabRef)
  | ({ action: "ungroup"; index: number } & TabRef)
  | { action: "skip"; reason: "tab_closed" | "moved_since" };

/**
 * `liveGroupIds` are the groups that still exist. If the original group is
 * gone, the tab is left ungrouped at its previous index.
 */
export function planFilingUndo(
  entry: FilingLogEntry,
  live: LiveTabPlacement | null,
  liveGroupIds: ReadonlySet<number>,
): FilingUndoPlan {
  if (!live) return { action: "skip", reason: "tab_closed" };
  if (live.windowId !== entry.windowId || live.groupId !== entry.toGroupId) {
    return { action: "skip", reason: "moved_since" };
  }
  const windowId = entry.previousWindowId ?? entry.windowId;
  if (entry.fromGroupId === null || !liveGroupIds.has(entry.fromGroupId)) {
    return { action: "ungroup", tabId: entry.tabId, windowId, index: entry.previousIndex };
  }
  return { action: "restore", tabId: entry.tabId, windowId, groupId: entry.fromGroupId, index: entry.previousIndex };
}
