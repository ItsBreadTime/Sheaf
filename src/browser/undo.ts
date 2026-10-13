import { quotedTabTitle } from "./drift-check";
import { UNGROUPED_GROUP_ID } from "../shared/constants";
import type { UndoPoint } from "../shared/transaction-types";
import type { SemanticGroup, SemanticWindowState } from "../shared/types";
import {
  restoreSnapshotMembership,
  type TransactionRuntime,
} from "../background/transaction-runner";

function groupForTab(state: SemanticWindowState, tabId: number): SemanticGroup | null {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || tab.groupId === UNGROUPED_GROUP_ID) return null;
  return state.groups.find((group) => group.runtimeId === tab.groupId) ?? null;
}

function sameGroupSemantics(left: SemanticGroup | null, right: SemanticGroup | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.title === right.title &&
    left.color === right.color &&
    left.collapsed === right.collapsed &&
    JSON.stringify(left.memberTabIds) === JSON.stringify(right.memberTabIds)
  );
}

export async function executeConflictAwareUndo(
  point: UndoPoint,
  runtime: TransactionRuntime,
): Promise<UndoPoint> {
  const live = await runtime.readWindow(point.targetWindowId);
  const beforeTabs = new Map(point.before.tabs.map((tab) => [tab.id, tab]));
  const expectedTabs = new Map(point.expectedAfter.tabs.map((tab) => [tab.id, tab]));
  const liveTabs = new Map(live.tabs.map((tab) => [tab.id, tab]));
  const conflicts: string[] = [];
  const safe = new Set<number>();

  for (const tabId of point.touchedTabIds) {
    const before = beforeTabs.get(tabId);
    const expected = expectedTabs.get(tabId);
    const observed = liveTabs.get(tabId);
    const tab = quotedTabTitle(before?.title ?? expected?.title ?? observed?.title);
    if (!before || !expected || !observed) {
      conflicts.push(`${tab} was closed, so Undo skipped it.`);
      continue;
    }
    if (observed.url !== expected.url || observed.title !== expected.title) {
      conflicts.push(`${tab} navigated to another page, so Undo left it where it is.`);
      continue;
    }
    if (!sameGroupSemantics(groupForTab(point.expectedAfter, tabId), groupForTab(live, tabId))) {
      conflicts.push(`${tab} was regrouped after organizing, so Undo left it where it is.`);
      continue;
    }
    safe.add(tabId);
  }

  // Restore original groups atomically: if one touched member conflicts, do not
  // partially reconstruct that original group around later user changes.
  for (const group of point.before.groups) {
    const touchedMembers = group.memberTabIds.filter((id) => point.touchedTabIds.includes(id));
    if (touchedMembers.some((id) => !safe.has(id))) {
      touchedMembers.forEach((id) => safe.delete(id));
    }
  }

  await restoreSnapshotMembership(point.before, [...safe], runtime);
  return {
    ...point,
    status: conflicts.length === 0 ? "completed" : "partial",
    conflicts,
  };
}
