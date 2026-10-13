import { describe, expect, it } from "vitest";
import {
  mapReviewToBrowserProposal,
  planIntegratedTransaction,
} from "../src/browser/integrated-operation-planner";
import { deterministicGroupColor } from "../src/organizer/group-colors";
import type { ImmutableRequestBundle, ValidatedProposal } from "../src/shared/organizer-types";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";

function tab(id: number, index: number, groupId = -1): SemanticTab {
  return { id, windowId: 7, index, title: `Tab ${id}`, url: `https://example.com/${id}`, groupId, active: false, pinned: false, audible: false, openerTabId: null, lastAccessed: null, splitView: { known: true, value: -1 }, protectionReasons: [] };
}
function group(runtimeId: number, members: number[]): SemanticGroup {
  return { runtimeId, windowId: 7, title: "Old", color: "red", collapsed: true, shared: { known: true, value: false }, memberTabIds: members, firstTabIndex: 0, protectionReasons: [] };
}
function state(): SemanticWindowState {
  const tabs = [tab(10, 0, 50), tab(11, 1, 50), tab(12, 2)];
  return { windowId: 7, capturedAt: 1, tabs, groups: [group(50, [10, 11])], eligibleTabIds: [10, 11, 12], protectedTabIds: [], featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true } };
}

describe("integrated organization planning", () => {
  it("maps ephemeral request IDs without exposing browser IDs to the provider proposal", () => {
    const proposal: ValidatedProposal = { schemaVersion: 1, groups: [{ temporaryId: "g1", title: "Work", tabIds: [1, 2] }], untouchedTabIds: [3] };
    const request = { submittedTabIds: [1, 2, 3], ephemeralToBrowserTabId: { 1: 10, 2: 11, 3: 12 } } as unknown as ImmutableRequestBundle;
    expect(mapReviewToBrowserProposal(proposal, request)).toMatchObject({
      browserTabIds: [10, 11, 12],
      proposal: { groups: [{ tabIds: [10, 11], title: "Work" }], untouchedTabIds: [12] },
    });
  });

  it("assigns stable native colors from group titles", () => {
    const proposal: ValidatedProposal = {
      schemaVersion: 1,
      groups: [
        { temporaryId: "g1", title: "Work", tabIds: [1, 2] },
        { temporaryId: "g2", title: "Read", tabIds: [3, 4] },
      ],
      untouchedTabIds: [],
    };
    const request = {
      submittedTabIds: [1, 2, 3, 4],
      ephemeralToBrowserTabId: { 1: 10, 2: 11, 3: 12, 4: 13 },
    } as unknown as ImmutableRequestBundle;

    const colors = mapReviewToBrowserProposal(proposal, request).proposal.groups.map((item) => item.color);
    expect(colors).toEqual([
      deterministicGroupColor("Work"),
      deterministicGroupColor("Read"),
    ]);
    expect(deterministicGroupColor("  WORK  ")).toBe(deterministicGroupColor("Work"));
  });

  it("uses frozen valid AI colors and ignores them in deterministic or legacy requests", () => {
    const proposal: ValidatedProposal = {
      schemaVersion: 1,
      groups: [{ temporaryId: "g1", title: "Gardening", color: "green", tabIds: [1, 2] }],
      untouchedTabIds: [],
    };
    const base = {
      submittedTabIds: [1, 2],
      ephemeralToBrowserTabId: { 1: 10, 2: 11 },
    };
    const request = (groupColorMode?: "ai" | "deterministic") => ({
      ...base,
      approvedRequest: groupColorMode ? { groupColorMode } : {},
    }) as unknown as ImmutableRequestBundle;

    expect(mapReviewToBrowserProposal(proposal, request("ai")).proposal.groups[0]?.color)
      .toBe("green");
    expect(mapReviewToBrowserProposal(proposal, request("deterministic")).proposal.groups[0]?.color)
      .toBe(deterministicGroupColor("Gardening"));
    expect(mapReviewToBrowserProposal(proposal, request()).proposal.groups[0]?.color)
      .toBe(deterministicGroupColor("Gardening"));
    const invalid = structuredClone(proposal) as ValidatedProposal;
    invalid.groups[0]!.color = "teal" as "green";
    expect(mapReviewToBrowserProposal(invalid, request("ai")).proposal.groups[0]?.color)
      .toBe(deterministicGroupColor("Gardening"));
  });

  it("reuses an exactly matching mutable group and applies compact visual metadata", () => {
    const proposal = { groups: [{ temporaryId: "g1", title: "Renamed", color: "blue" as const, collapsed: false, tabIds: [10, 11] }], untouchedTabIds: [12] };
    const journal = planIntegratedTransaction(state(), proposal, [10, 11, 12], "tx");
    expect(journal.operationPlan).toEqual([
      { operationId: "g1:update", kind: "update_group", groupRef: "g1", title: "Renamed", color: "red", collapsed: true },
      { operationId: "g1:move", kind: "move_group", groupRef: "g1", index: 0 },
    ]);
    expect(journal.runtimeGroupIds).toEqual({ g1: 50 });
    expect(journal.expectedFinalState.groups[0]).toMatchObject({ title: "Renamed", color: "red", collapsed: true, memberTabIds: [10, 11] });
  });

  it("can pull tabs from separate existing groups into one merged proposal", () => {
    const live = state();
    live.tabs.push(tab(13, 3, 60));
    live.tabs[2]!.groupId = 60;
    live.groups.push({ ...group(60, [12, 13]), firstTabIndex: 2 });
    live.eligibleTabIds.push(13);
    const proposal = {
      groups: [{
        temporaryId: "merged",
        title: "Combined work",
        color: "blue" as const,
        collapsed: false,
        tabIds: [10, 11, 12, 13],
      }],
      untouchedTabIds: [],
    };

    const journal = planIntegratedTransaction(live, proposal, [10, 11, 12, 13], "tx-merge");
    expect(journal.operationPlan[0]).toMatchObject({
      kind: "create_group",
      tabIds: [10, 11, 12, 13],
    });
    expect(journal.expectedFinalState.groups).toHaveLength(1);
    expect(journal.expectedFinalState.groups[0]?.memberTabIds).toEqual([10, 11, 12, 13]);
  });

  it("keeps an untouched tab in its original group while another member leaves", () => {
    const proposal = {
      groups: [{
        temporaryId: "focused",
        title: "Focused work",
        color: "blue" as const,
        collapsed: false,
        tabIds: [11, 12],
      }],
      untouchedTabIds: [10],
    };

    const journal = planIntegratedTransaction(state(), proposal, [10, 11, 12], "tx-split");
    expect(journal.expectedFinalState.groups.find((item) => item.runtimeId === 50)).toMatchObject({
      title: "Old",
      color: "red",
      collapsed: true,
      memberTabIds: [10],
    });
    expect(journal.expectedFinalState.groups.find((item) => item.title === "Focused work")?.memberTabIds)
      .toEqual([11, 12]);
    expect(journal.touchedTabIds).toEqual([11, 12]);
  });

  it("fails closed when a proposed changed tab is no longer eligible", () => {
    const live = state();
    live.eligibleTabIds = [11, 12];
    live.tabs[0]!.protectionReasons = ["Pinned tab"];
    const proposal = { groups: [{ temporaryId: "g1", title: "Work", color: "blue" as const, collapsed: false, tabIds: [10, 11] }], untouchedTabIds: [12] };
    expect(() => planIntegratedTransaction(live, proposal, [10, 11, 12], "tx")).toThrow("no longer eligible");
  });

  it("orders proposed group blocks by their earliest input-snapshot tab", () => {
    const live = state();
    live.tabs.forEach((item) => { item.groupId = -1; });
    live.groups = [];
    const proposal = {
      groups: [
        { temporaryId: "later", title: "Later", color: "blue" as const, collapsed: false, tabIds: [11, 12] },
        { temporaryId: "earlier", title: "Earlier", color: "blue" as const, collapsed: false, tabIds: [10, 11] },
      ],
      untouchedTabIds: [],
    };
    // Use disjoint members while preserving intentionally reversed group-card order.
    live.tabs.push(tab(13, 3));
    live.eligibleTabIds.push(13);
    proposal.groups[0]!.tabIds = [12, 13];
    const journal = planIntegratedTransaction(live, proposal, [10, 11, 12, 13], "tx");
    expect(journal.operationPlan.map((operation) => "groupRef" in operation ? operation.groupRef : null)).toEqual([
      "earlier",
      "earlier",
      "earlier",
      "later",
      "later",
      "later",
    ]);
  });

  it("projects Chrome's contiguous blocks for interleaved non-adjacent groups", () => {
    const live = state();
    const pinnedTab = tab(8, 0);
    pinnedTab.pinned = true;
    pinnedTab.protectionReasons = ["Pinned tab"];
    const protectedTab = tab(9, 1);
    protectedTab.protectionReasons = ["Internal browser page"];
    live.tabs = [pinnedTab, protectedTab, tab(10, 2), tab(11, 3), tab(12, 4), tab(13, 5), tab(14, 6)];
    live.tabs[3]!.active = true;
    live.groups = [];
    live.eligibleTabIds = [10, 11, 12, 13, 14];
    live.protectedTabIds = [8, 9];
    const proposal = {
      groups: [
        { temporaryId: "topic-a", title: "Topic A", color: "blue" as const, collapsed: false, tabIds: [12, 10] },
        { temporaryId: "topic-b", title: "Topic B", color: "blue" as const, collapsed: false, tabIds: [13, 11] },
      ],
      untouchedTabIds: [14],
    };

    const journal = planIntegratedTransaction(
      live,
      proposal,
      [10, 11, 12, 13, 14],
      "tx-interleaved",
    );

    expect(journal.operationPlan.filter((operation) => operation.kind === "create_group")).toMatchObject([
      { groupRef: "topic-a", tabIds: [10, 12] },
      { groupRef: "topic-b", tabIds: [11, 13] },
    ]);
    // Groups are created in tab-strip order, then reordered to the proposal's order.
    expect(journal.operationPlan.filter((operation) => operation.kind === "order_group")).toMatchObject([
      { groupRef: "topic-a", tabIds: [12, 10], index: 1 },
      { groupRef: "topic-b", tabIds: [13, 11], index: 3 },
    ]);
    expect(journal.expectedFinalState.tabs.map((item) => item.id)).toEqual([
      8,
      12,
      10,
      13,
      11,
      9,
      14,
    ]);
    expect(journal.expectedFinalState.tabs.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(journal.expectedFinalState.groups.map((groupItem) => ({
      title: groupItem.title,
      members: groupItem.memberTabIds,
      firstTabIndex: groupItem.firstTabIndex,
    }))).toEqual([
      { title: "Topic A", members: [12, 10], firstTabIndex: 1 },
      { title: "Topic B", members: [13, 11], firstTabIndex: 3 },
    ]);
    expect(journal.expectedFinalState.groups.map((groupItem) => groupItem.collapsed)).toEqual([
      true,
      false,
    ]);
    expect(journal.operationPlan.filter((operation) => operation.kind === "move_group")).toEqual([
      { operationId: "topic-a:move", kind: "move_group", groupRef: "topic-a", index: 1 },
      { operationId: "topic-b:move", kind: "move_group", groupRef: "topic-b", index: 3 },
    ]);
  });
});
