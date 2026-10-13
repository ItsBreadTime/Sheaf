import { describe, expect, it } from "vitest";
import {
  buildPlannedOperationProposal,
  planTransaction,
} from "../src/browser/operation-planner";
import type { SemanticTab, SemanticWindowState } from "../src/shared/types";

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

function state(): SemanticWindowState {
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

describe("planned operation planner", () => {
  it("produces the same complete plan for the same state and proposal", () => {
    const initial = state();
    const { proposal, selectedTabIds } = buildPlannedOperationProposal(initial);
    const first = planTransaction(initial, proposal, "transaction-fixed");
    const second = planTransaction(initial, proposal, "transaction-fixed");

    expect(selectedTabIds).toEqual([1, 2]);
    expect(first).toEqual(second);
    expect(first.operationPlan).toEqual([
      {
        operationId: "planned-group-1:create",
        kind: "create_group",
        groupRef: "planned-group-1",
        tabIds: [1, 2],
      },
      {
        operationId: "planned-group-1:update",
        kind: "update_group",
        groupRef: "planned-group-1",
        title: "Planned",
        color: "blue",
        collapsed: false,
      },
    ]);
    expect(first.expectedFinalState.groups[0]?.memberTabIds).toEqual([1, 2]);
    expect(first.rollbackSnapshot).not.toBe(initial);
  });

  it("fails closed when a protected tab enters the proposal", () => {
    const initial = state();
    initial.tabs[0]!.protectionReasons = ["Pinned tab"];
    initial.eligibleTabIds = [2, 3];
    expect(() =>
      planTransaction(
        initial,
        {
          groups: [
            {
              temporaryId: "unsafe",
              title: "Unsafe",
              color: "blue",
              collapsed: false,
              tabIds: [1, 2],
            },
          ],
          untouchedTabIds: [3],
        },
        "transaction-unsafe",
      ),
    ).toThrow("Tab 1 is not eligible");
  });
});
