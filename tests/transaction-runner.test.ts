import { describe, expect, it } from "vitest";
import {
  executeTransaction,
  rollbackTransaction,
  type TransactionRuntime,
} from "../src/background/transaction-runner";
import {
  buildPlannedOperationProposal,
  planTransaction,
} from "../src/browser/operation-planner";
import { planIntegratedTransaction } from "../src/browser/integrated-operation-planner";
import type {
  OrganizationRun,
  SemanticGroup,
  SemanticTab,
  SemanticWindowState,
} from "../src/shared/types";

function tab(id: number, index: number): SemanticTab {
  return {
    id,
    windowId: 7,
    index,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    groupId: -1,
    active: id === 1,
    pinned: false,
    audible: false,
    openerTabId: null,
    lastAccessed: null,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
  };
}

function existingGroup(id: number, members: number[]): SemanticGroup {
  return {
    runtimeId: id,
    windowId: 7,
    title: "Existing",
    color: "red",
    collapsed: true,
    shared: { known: true, value: false },
    memberTabIds: members,
    firstTabIndex: 0,
    protectionReasons: [],
  };
}

function initialState(): SemanticWindowState {
  const tabs = [tab(1, 0), tab(2, 1), tab(3, 2)];
  return {
    windowId: 7,
    capturedAt: 100,
    tabs,
    groups: [],
    eligibleTabIds: tabs.map((item) => item.id),
    protectedTabIds: [],
    featureSupport: {
      sharedGroupProperty: true,
      splitViewIdProperty: true,
      storageSession: true,
    },
  };
}

function createRun(initial: SemanticWindowState): OrganizationRun {
  const { proposal, selectedTabIds } = buildPlannedOperationProposal(initial);
  const journal = planTransaction(initial, proposal, "tx-1");
  return {
    transactionId: "tx-1",
    targetWindowId: 7,
    selectedTabIds,
    proposal,
    inputSnapshot: structuredClone(initial),
    journal,
    status: "prepared",
    faultInjection: "none",
    verification: null,
    rollbackVerification: null,
    error: null,
  };
}

function fakeRuntime(initial: SemanticWindowState): {
  runtime: TransactionRuntime;
  events: string[];
  readState: () => SemanticWindowState;
} {
  const state = structuredClone(initial);
  let nextGroupId = 77;
  const events: string[] = [];
  const reindex = (): void => {
    state.tabs.forEach((item, index) => { item.index = index; });
    const indexById = new Map(state.tabs.map((item) => [item.id, item.index]));
    state.groups.forEach((group) => {
      group.memberTabIds.sort((left, right) =>
        (indexById.get(left) ?? 0) - (indexById.get(right) ?? 0)
      );
      group.firstTabIndex = Math.min(...group.memberTabIds.map((id) => indexById.get(id) ?? 0));
    });
    state.groups.sort((left, right) => left.firstTabIndex - right.firstTabIndex);
  };
  const moveTabs = (tabIds: readonly number[], index: number): void => {
    // Like chrome.tabs.move, the moved tabs land in the order given.
    const selected = new Set(tabIds);
    const members = tabIds.flatMap((id) => state.tabs.find((item) => item.id === id) ?? []);
    const remaining = state.tabs.filter((item) => !selected.has(item.id));
    remaining.splice(index < 0 ? remaining.length : index, 0, ...members);
    state.tabs = remaining;
    reindex();
  };
  const runtime: TransactionRuntime = {
    async readWindow() {
      events.push("read");
      return structuredClone(state);
    },
    async groupTabs(_windowId, tabIds, existingGroupId) {
      events.push("mutate:group");
      const runtimeId = existingGroupId ?? nextGroupId++;
      const selected = new Set(tabIds);
      const insertionIndex = Math.min(
        ...state.tabs.flatMap((item, index) => selected.has(item.id) ? [index] : []),
      );
      const members = state.tabs.filter((item) => selected.has(item.id));
      const remaining = state.tabs.filter((item) => !selected.has(item.id));
      remaining.splice(insertionIndex, 0, ...members);
      state.tabs = remaining;
      reindex();
      for (const item of state.tabs) {
        if (tabIds.includes(item.id)) item.groupId = runtimeId;
      }
      // Like Chrome, grouping a tab removes it from its previous group.
      state.groups = state.groups.flatMap((group) => {
        if (group.runtimeId === runtimeId) return [group];
        const memberTabIds = group.memberTabIds.filter((id) => !tabIds.includes(id));
        return memberTabIds.length === 0 ? [] : [{ ...group, memberTabIds }];
      });
      const existing = state.groups.find((group) => group.runtimeId === runtimeId);
      if (existing) {
        existing.memberTabIds = [...new Set([...existing.memberTabIds, ...tabIds])];
        return runtimeId;
      }
      state.groups.push({
        runtimeId,
        windowId: 7,
        title: "",
        color: "grey",
        collapsed: false,
        shared: { known: true, value: false },
        memberTabIds: [...tabIds],
        firstTabIndex: Math.min(
          ...state.tabs.filter((item) => tabIds.includes(item.id)).map((item) => item.index),
        ),
        protectionReasons: [],
      });
      return runtimeId;
    },
    async updateGroup(groupId, update) {
      events.push("mutate:update");
      const group = state.groups.find((item) => item.runtimeId === groupId);
      if (!group) throw new Error("Missing fake group.");
      Object.assign(group, update);
    },
    async moveGroup(groupId, index) {
      events.push("mutate:move-group");
      const group = state.groups.find((item) => item.runtimeId === groupId);
      if (!group) throw new Error("Missing fake group.");
      moveTabs(group.memberTabIds, index);
    },
    async moveTabs(tabIds, index) {
      events.push("mutate:move-tabs");
      moveTabs(tabIds, index);
    },
    async ungroupTabs(tabIds) {
      events.push("mutate:ungroup");
      // Like Chrome, a tab leaving the middle of a group lands just after it.
      for (const tabId of tabIds) {
        const item = state.tabs.find((candidate) => candidate.id === tabId);
        if (!item || item.groupId === -1) continue;
        const group = state.groups.find((candidate) => candidate.runtimeId === item.groupId);
        item.groupId = -1;
        if (!group) continue;
        group.memberTabIds = group.memberTabIds.filter((id) => id !== tabId);
        if (group.memberTabIds.length > 0) {
          const remaining = state.tabs.filter((candidate) => candidate.id !== tabId);
          const lastIndex = Math.max(...group.memberTabIds.map(
            (id) => remaining.findIndex((candidate) => candidate.id === id),
          ));
          remaining.splice(lastIndex + 1, 0, item);
          state.tabs = remaining;
        }
      }
      state.groups = state.groups.filter((group) => group.memberTabIds.length > 0);
      reindex();
    },
    async persist(run) {
      events.push(`persist:${run.status}:${run.journal.inFlightOperation ?? "idle"}`);
    },
  };
  return { runtime, events, readState: () => structuredClone(state) };
}

describe("organization transaction runner", () => {
  it("aborts without mutating when a target changes after planning", async () => {
    const initial = initialState();
    const { runtime, events, readState } = fakeRuntime(initial);
    const originalRead = runtime.readWindow;
    let firstRead = true;
    runtime.readWindow = async (windowId) => {
      const snapshot = await originalRead(windowId);
      if (firstRead) {
        firstRead = false;
        // Simulate the user pinning a target tab between planning and apply.
        snapshot.tabs[0]!.pinned = true;
      }
      return snapshot;
    };

    const result = await executeTransaction(createRun(initial), runtime, "none");

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/changed just before applying/);
    expect(result.error).toMatch(/changed pinned state/);
    expect(events.some((event) => event.startsWith("mutate:"))).toBe(false);
    expect(readState()).toEqual(initial);
  });

  it("does not mutate when the initial journal durability barrier fails", async () => {
    const initial = initialState();
    const { runtime, events } = fakeRuntime(initial);
    runtime.persist = async () => {
      events.push("persist:failed");
      throw new Error("Session storage unavailable.");
    };

    await expect(
      executeTransaction(createRun(initial), runtime, "none"),
    ).rejects.toThrow("Session storage unavailable");
    expect(events).not.toContain("mutate:group");
  });

  it("commits the journal before mutation and verifies the final queried state", async () => {
    const initial = initialState();
    const { runtime, events, readState } = fakeRuntime(initial);
    const result = await executeTransaction(createRun(initial), runtime, "none");

    expect(result.status).toBe("completed");
    expect(result.verification?.passed).toBe(true);
    expect(events.indexOf("persist:prepared:idle")).toBeLessThan(
      events.indexOf("mutate:group"),
    );
    expect(events).toContain("persist:applying:0");
    expect(readState().groups[0]).toMatchObject({
      title: "Planned",
      color: "blue",
      memberTabIds: [1, 2],
    });
  });

  it("accepts native contiguous-block reordering while applying interleaved groups", async () => {
    const initial = initialState();
    initial.tabs = [tab(1, 0), tab(2, 1), tab(3, 2), tab(4, 3), tab(5, 4)];
    initial.eligibleTabIds = initial.tabs.map((item) => item.id);
    const proposal = {
      groups: [
        { temporaryId: "topic-a", title: "Topic A", color: "blue" as const, collapsed: false, tabIds: [1, 3] },
        { temporaryId: "topic-b", title: "Topic B", color: "blue" as const, collapsed: false, tabIds: [2, 4] },
      ],
      untouchedTabIds: [5],
    };
    const run: OrganizationRun = {
      transactionId: "tx-interleaved",
      targetWindowId: 7,
      selectedTabIds: [1, 2, 3, 4, 5],
      proposal,
      inputSnapshot: structuredClone(initial),
      journal: planIntegratedTransaction(
        initial,
        proposal,
        [1, 2, 3, 4, 5],
        "tx-interleaved",
      ),
      status: "prepared",
      faultInjection: "none",
      verification: null,
      rollbackVerification: null,
      error: null,
    };
    const fake = fakeRuntime(initial);

    const result = await executeTransaction(run, fake.runtime, "none");

    expect(result.status).toBe("completed");
    expect(result.verification?.passed).toBe(true);
    expect(fake.readState().tabs.map((item) => item.id)).toEqual([1, 3, 2, 4, 5]);
    expect(fake.readState().groups.map((item) => item.memberTabIds)).toEqual([
      [1, 3],
      [2, 4],
    ]);

    const restored = await rollbackTransaction(result, fake.runtime);
    expect(restored.status).toBe("rolled_back");
    expect(restored.rollbackVerification?.passed).toBe(true);
    expect(fake.readState()).toEqual(initial);
  });

  it("rolls back a forced apply failure and reports complete restoration", async () => {
    const initial = initialState();
    const { runtime, readState } = fakeRuntime(initial);
    const result = await executeTransaction(
      createRun(initial),
      runtime,
      "apply_failure",
    );

    expect(result.status).toBe("rolled_back");
    expect(result.rollbackVerification?.passed).toBe(true);
    expect(readState()).toEqual(initial);
  });

  it("still restores the window when the session store fills up mid-apply", async () => {
    const initial = initialState();
    const { runtime, readState, events } = fakeRuntime(initial);
    const persist = runtime.persist.bind(runtime);
    let writes = 0;
    runtime.persist = async (run) => {
      writes += 1;
      // prepared, applying, and the first in-flight operation fit; nothing after that does.
      if (writes > 3) throw new Error("Session storage reserve would be crossed.");
      await persist(run);
    };
    const result = await executeTransaction(createRun(initial), runtime, "none");

    expect(events.some((event) => event.startsWith("mutate:"))).toBe(true);
    expect(result.status).toBe("rolled_back");
    expect(result.rollbackVerification?.passed).toBe(true);
    expect(result.error).toMatch(/Session storage reserve would be crossed\./);
    expect(result.error).toMatch(/rollback could not be recorded/);
    expect(readState()).toEqual(initial);
  });

  it("reports partial rollback when fault injection blocks restoration", async () => {
    const initial = initialState();
    const { runtime, readState } = fakeRuntime(initial);
    const result = await executeTransaction(
      createRun(initial),
      runtime,
      "rollback_failure",
    );

    expect(result.status).toBe("rollback_partial");
    expect(result.rollbackVerification?.passed).toBe(false);
    expect(result.rollbackVerification?.issues).toContain(
      "Injected rollback failure prevented the ungroup operation.",
    );
    expect(readState().groups).toHaveLength(1);
  });

  it("restores original mutable group membership and metadata after failure", async () => {
    const initial = initialState();
    initial.tabs[0]!.groupId = 40;
    initial.tabs[1]!.groupId = 40;
    initial.groups = [existingGroup(40, [1, 2])];
    const proposal = {
      groups: [{ temporaryId: "new", title: "New", color: "blue" as const, collapsed: false, tabIds: [1, 2] }],
      untouchedTabIds: [3],
    };
    const run = createRun(initialState());
    run.proposal = proposal;
    run.inputSnapshot = structuredClone(initial);
    run.journal = {
      ...run.journal,
      rollbackSnapshot: structuredClone(initial),
      touchedTabIds: [1, 2],
    };
    const fake = fakeRuntime(initial);
    const result = await executeTransaction(run, fake.runtime, "apply_failure");
    expect(result.status).toBe("rolled_back");
    expect(fake.readState().groups[0]).toMatchObject({
      title: "Existing",
      color: "red",
      collapsed: true,
      memberTabIds: [1, 2],
    });
    expect(new Set(fake.readState().tabs.slice(0, 2).map((item) => item.groupId)).size).toBe(1);
  });

  describe("arrangement", () => {
    function arrangementState(): SemanticWindowState {
      const initial = initialState();
      initial.tabs = [1, 2, 3, 4, 5, 6, 7].map((id, index) => tab(id, index));
      initial.tabs[4]!.groupId = 100;
      initial.tabs[5]!.groupId = 100;
      initial.groups = [{ ...existingGroup(100, [5, 6]), title: "Reddit", firstTabIndex: 4 }];
      initial.eligibleTabIds = initial.tabs.map((item) => item.id);
      return initial;
    }

    function arrangementRun(initial: SemanticWindowState, arrangeLooseTabs: boolean): OrganizationRun {
      const proposal = {
        groups: [
          { temporaryId: "topic", title: "Topic", color: "blue" as const, collapsed: false, tabIds: [3, 1] },
        ],
        untouchedTabIds: [4, 2, 6, 5, 7],
        ungroupTabIds: [5, 6],
      };
      return {
        transactionId: "tx-arrange",
        targetWindowId: 7,
        selectedTabIds: [1, 2, 3, 4, 5, 6, 7],
        proposal,
        inputSnapshot: structuredClone(initial),
        journal: planIntegratedTransaction(
          initial,
          proposal,
          [1, 2, 3, 4, 5, 6, 7],
          "tx-arrange",
          { arrangeLooseTabs },
        ),
        status: "prepared",
        faultInjection: "none",
        verification: null,
        rollbackVerification: null,
        error: null,
      };
    }

    it("orders group members, dissolves a site group, and arranges loose tabs at the end", async () => {
      const initial = arrangementState();
      const run = arrangementRun(initial, true);
      expect(run.journal.operationPlan.map((operation) => operation.kind)).toEqual([
        "create_group",
        "update_group",
        "move_group",
        "order_group",
        "ungroup_tabs",
        "arrange_loose_tabs",
      ]);
      expect(run.journal.touchedTabIds).toEqual([3, 1, 5, 6]);
      expect(run.journal.arrangedTabIds).toEqual([4, 2, 7]);
      const fake = fakeRuntime(initial);

      const result = await executeTransaction(run, fake.runtime, "none");

      expect(result.error).toBeNull();
      expect(result.status).toBe("completed");
      expect(fake.readState().tabs.map((item) => item.id)).toEqual([3, 1, 4, 2, 6, 5, 7]);
      expect(fake.readState().groups.map((item) => [item.title, item.memberTabIds])).toEqual([
        ["Topic", [3, 1]],
      ]);

      const restored = await rollbackTransaction(result, fake.runtime);
      expect(restored.status).toBe("rolled_back");
      expect(fake.readState().tabs.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(fake.readState().groups.map((item) => [item.title, item.memberTabIds])).toEqual([
        ["Reddit", [5, 6]],
      ]);
    });

    it("moves only tabs leaving a group when loose arrangement is off", async () => {
      const initial = arrangementState();
      const run = arrangementRun(initial, false);
      expect(run.journal.arrangedTabIds).toEqual([]);
      const fake = fakeRuntime(initial);

      const result = await executeTransaction(run, fake.runtime, "none");

      expect(result.status).toBe("completed");
      expect(fake.readState().tabs.map((item) => item.id)).toEqual([3, 1, 2, 4, 7, 6, 5]);
    });

    it("plans no loose move when loose tabs already end the window in order", () => {
      const initial = initialState();
      initial.tabs = [1, 2, 3, 4].map((id, index) => tab(id, index));
      initial.eligibleTabIds = [1, 2, 3, 4];
      const journal = planIntegratedTransaction(
        initial,
        {
          groups: [{ temporaryId: "a", title: "A", color: "blue", collapsed: false, tabIds: [1, 2] }],
          untouchedTabIds: [3, 4],
        },
        [1, 2, 3, 4],
        "tx-idle",
        { arrangeLooseTabs: true },
      );
      expect(journal.operationPlan.map((operation) => operation.kind)).not.toContain("arrange_loose_tabs");
      expect(journal.arrangedTabIds).toEqual([]);
    });

    it("leaves pinned and ineligible loose tabs in place", () => {
      const initial = initialState();
      initial.tabs = [1, 2, 3, 4].map((id, index) => tab(id, index));
      initial.tabs[0]!.pinned = true;
      initial.eligibleTabIds = [1, 2, 3];
      const journal = planIntegratedTransaction(
        initial,
        { groups: [], untouchedTabIds: [4, 3, 2, 1] },
        [1, 2, 3, 4],
        "tx-pinned",
        { arrangeLooseTabs: true },
      );
      expect(journal.operationPlan).toEqual([
        { operationId: "loose:arrange", kind: "arrange_loose_tabs", tabIds: [3, 2] },
      ]);
    });
  });
});
