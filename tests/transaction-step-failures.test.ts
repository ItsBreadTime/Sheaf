import { describe, expect, it } from "vitest";
import { executeTransaction, type TransactionRuntime } from "../src/background/transaction-runner";
import { planIntegratedTransaction } from "../src/browser/integrated-operation-planner";
import type { OrganizationRun, SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";

function tab(id: number): SemanticTab {
  return { id, windowId: 7, index: id - 1, title: `Tab ${id}`, url: `https://example.com/${id}`, groupId: -1, active: false, pinned: false, audible: false, openerTabId: null, lastAccessed: null, splitView: { known: true, value: -1 }, protectionReasons: [] };
}
function initial(): SemanticWindowState {
  const tabs = [tab(1), tab(2), tab(3), tab(4)];
  return { windowId: 7, capturedAt: 1, tabs, groups: [], eligibleTabIds: [1, 2, 3, 4], protectedTabIds: [], featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true } };
}
function createRun(): OrganizationRun {
  const before = initial();
  const proposal = {
    groups: [
      { temporaryId: "a", title: "A", color: "blue" as const, collapsed: false, tabIds: [1, 2] },
      { temporaryId: "b", title: "B", color: "blue" as const, collapsed: false, tabIds: [3, 4] },
    ],
    untouchedTabIds: [],
  };
  const journal = planIntegratedTransaction(before, proposal, [1, 2, 3, 4], "tx");
  return { transactionId: "tx", targetWindowId: 7, selectedTabIds: [1, 2, 3, 4], proposal, inputSnapshot: before, journal, status: "prepared", faultInjection: "none", verification: null, rollbackVerification: null, error: null };
}

function failingRuntime(failMutationCall: number): TransactionRuntime {
  const live = structuredClone(initial());
  let mutationCalls = 0;
  let nextGroupId = 70;
  const maybeFail = (): void => {
    mutationCalls += 1;
    if (mutationCalls === failMutationCall) throw new Error(`Operation failure ${failMutationCall}`);
  };
  return {
    async readWindow() { return structuredClone(live); },
    async groupTabs(_windowId, ids, existingGroupId) {
      maybeFail();
      const groupId = existingGroupId ?? nextGroupId++;
      ids.forEach((id) => { const item = live.tabs.find((candidate) => candidate.id === id); if (item) item.groupId = groupId; });
      const existing = live.groups.find((group) => group.runtimeId === groupId);
      if (existing) existing.memberTabIds = [...new Set([...existing.memberTabIds, ...ids])];
      else live.groups.push({ runtimeId: groupId, windowId: 7, title: "", color: "grey", collapsed: false, shared: { known: true, value: false }, memberTabIds: [...ids], firstTabIndex: Math.min(...ids) - 1, protectionReasons: [] });
      return groupId;
    },
    async updateGroup(groupId, update) {
      maybeFail();
      const group = live.groups.find((candidate) => candidate.runtimeId === groupId);
      if (!group) throw new Error("Missing group");
      Object.assign(group, update);
    },
    async moveGroup(groupId, index) {
      maybeFail();
      const group = live.groups.find((candidate) => candidate.runtimeId === groupId);
      if (!group) throw new Error("Missing group");
      const selected = new Set(group.memberTabIds);
      const members = live.tabs.filter((item) => selected.has(item.id));
      const remaining = live.tabs.filter((item) => !selected.has(item.id));
      remaining.splice(index, 0, ...members);
      live.tabs = remaining;
      live.tabs.forEach((item, tabIndex) => { item.index = tabIndex; });
      live.groups.forEach((item) => {
        item.firstTabIndex = Math.min(...item.memberTabIds.map((id) =>
          live.tabs.find((tabItem) => tabItem.id === id)?.index ?? 0
        ));
      });
      live.groups.sort((left, right) => left.firstTabIndex - right.firstTabIndex);
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
      ids.forEach((id) => { const item = live.tabs.find((candidate) => candidate.id === id); if (item) item.groupId = -1; });
      live.groups = live.groups.flatMap((group): SemanticGroup[] => {
        const remaining = group.memberTabIds.filter((id) => !ids.includes(id));
        return remaining.length ? [{ ...group, memberTabIds: remaining }] : [];
      });
    },
    async persist() {},
  };
}

describe("operation failure at every deterministic transaction operation", () => {
  it.each([1, 2, 3, 4, 5, 6])("rolls back when browser operation %i fails", async (operation) => {
    const result = await executeTransaction(createRun(), failingRuntime(operation), "none");
    expect(result.status).toBe("rolled_back");
    expect(result.rollbackVerification?.passed).toBe(true);
    expect(result.error).toContain(`Operation failure ${operation}`);
  });
});
