import { describe, expect, it } from "vitest";
import { executeConflictAwareUndo } from "../src/browser/undo";
import type { TransactionRuntime } from "../src/background/transaction-runner";
import type { UndoPoint } from "../src/shared/transaction-types";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";

function tab(id: number, groupId = -1): SemanticTab {
  return { id, windowId: 7, index: id - 1, title: `Tab ${id}`, url: `https://example.com/${id}`, groupId, active: false, pinned: false, audible: false, openerTabId: null, lastAccessed: null, splitView: { known: true, value: -1 }, protectionReasons: [] };
}
function state(grouped: boolean, title = "Work"): SemanticWindowState {
  const tabs = [tab(1, grouped ? 77 : -1), tab(2, grouped ? 77 : -1), tab(3)];
  const groups: SemanticGroup[] = grouped ? [{ runtimeId: 77, windowId: 7, title, color: "blue", collapsed: false, shared: { known: true, value: false }, memberTabIds: [1, 2], firstTabIndex: 0, protectionReasons: [] }] : [];
  return { windowId: 7, capturedAt: 1, tabs, groups, eligibleTabIds: [1, 2, 3], protectedTabIds: [], featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true } };
}
function runtime(initial: SemanticWindowState): { runtime: TransactionRuntime; current: () => SemanticWindowState } {
  const live = structuredClone(initial);
  const value: TransactionRuntime = {
    async readWindow() { return structuredClone(live); },
    async groupTabs(_windowId, ids, existing) {
      const groupId = existing ?? 99;
      ids.forEach((id) => { const item = live.tabs.find((tab) => tab.id === id); if (item) item.groupId = groupId; });
      if (!live.groups.some((group) => group.runtimeId === groupId)) live.groups.push({ runtimeId: groupId, windowId: 7, title: "", color: "grey", collapsed: false, shared: { known: true, value: false }, memberTabIds: [...ids], firstTabIndex: 0, protectionReasons: [] });
      return groupId;
    },
    async updateGroup(id, update) {
      const group = live.groups.find((candidate) => candidate.runtimeId === id);
      if (!group) throw new Error("Missing group");
      Object.assign(group, update);
    },
    async moveGroup(groupId, index) {
      const group = live.groups.find((candidate) => candidate.runtimeId === groupId);
      if (!group) throw new Error("Missing group");
      const selected = new Set(group.memberTabIds);
      const members = live.tabs.filter((item) => selected.has(item.id));
      const remaining = live.tabs.filter((item) => !selected.has(item.id));
      remaining.splice(index, 0, ...members);
      live.tabs = remaining;
      live.tabs.forEach((item, tabIndex) => { item.index = tabIndex; });
    },
    async moveTabs(ids, index) {
      const selected = new Set(ids);
      const members = live.tabs.filter((item) => selected.has(item.id));
      const remaining = live.tabs.filter((item) => !selected.has(item.id));
      remaining.splice(index < 0 ? remaining.length : index, 0, ...members);
      live.tabs = remaining;
      live.tabs.forEach((item, tabIndex) => { item.index = tabIndex; });
    },
    async ungroupTabs(ids) {
      ids.forEach((id) => { const item = live.tabs.find((tab) => tab.id === id); if (item) item.groupId = -1; });
      live.groups = live.groups.flatMap((group) => {
        const members = group.memberTabIds.filter((id) => !ids.includes(id));
        return members.length ? [{ ...group, memberTabIds: members }] : [];
      });
    },
    async persist() {},
  };
  return { runtime: value, current: () => structuredClone(live) };
}
function point(): UndoPoint {
  return { transactionId: "tx", targetWindowId: 7, before: state(false), expectedAfter: state(true), touchedTabIds: [1, 2], createdAt: 1, status: "available", conflicts: [] };
}

describe("conflict-aware organization undo", () => {
  it("restores unchanged touched tabs and completes the single undo point", async () => {
    const fake = runtime(state(true));
    const result = await executeConflictAwareUndo(point(), fake.runtime);
    expect(result.status).toBe("completed");
    expect(fake.current().groups).toEqual([]);
    expect(fake.current().tabs.map((tab) => tab.groupId)).toEqual([-1, -1, -1]);
  });

  it("does not overwrite a later user group change", async () => {
    const changed = state(true, "User changed this");
    const fake = runtime(changed);
    const result = await executeConflictAwareUndo(point(), fake.runtime);
    expect(result.status).toBe("partial");
    expect(result.conflicts).toHaveLength(2);
    expect(fake.current().groups[0]?.title).toBe("User changed this");
    expect(fake.current().tabs.slice(0, 2).map((tab) => tab.groupId)).toEqual([77, 77]);
  });
});
