import { describe, expect, it } from "vitest";
import {
  aggregateGroupSemanticScores,
  buildGroupManagerState,
  previewGroupEdit,
  previewGroupRemoval,
  rankGroupSearch,
} from "../src/browser/group-manager";
import { DEFAULT_GROUP_MANAGER_OWNERSHIP_FILTER } from "../src/shared/group-manager-types";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";

function tab(id: number, groupId: number, options: Partial<SemanticTab> = {}): SemanticTab {
  return {
    id,
    windowId: 7,
    index: id - 1,
    title: `Tab ${id}`,
    url: `https://${id === 1 ? "planning" : "research"}.example.com/${id}`,
    groupId,
    active: id === 1,
    pinned: false,
    audible: false,
    openerTabId: null,
    lastAccessed: null,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
    ...options,
  };
}

function group(id: number, title: string, members: number[], options: Partial<SemanticGroup> = {}): SemanticGroup {
  return {
    runtimeId: id,
    windowId: 7,
    title,
    color: "blue",
    collapsed: false,
    shared: { known: true, value: false },
    memberTabIds: members,
    firstTabIndex: Math.min(...members) - 1,
    protectionReasons: [],
    ...options,
  };
}

function state(): SemanticWindowState {
  const tabs = [tab(1, 10), tab(2, 10), tab(3, 20), tab(4, 20)];
  return {
    windowId: 7,
    capturedAt: 1,
    tabs,
    groups: [group(10, "Q2 Planning", [1, 2]), group(20, "Research", [3, 4])],
    eligibleTabIds: tabs.map((item) => item.id),
    protectedTabIds: [],
    featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true },
  };
}

describe("group manager projections", () => {
  it("shows native groups by default even before the extension manages them", () => {
    expect(DEFAULT_GROUP_MANAGER_OWNERSHIP_FILTER).toBe("all");
  });

  it("derives verified ownership, active, linked, and stash badges", () => {
    const live = state();
    const result = buildGroupManagerState({
      states: [live],
      ownership: [{ groupId: 10, windowId: 7, origin: "created", managed: true, recordedAt: 1 }],
      stashLinks: [{ groupId: 10, windowId: 7, stashId: "s", memberTabIds: [1, 2], title: "Q2 Planning", color: "blue", collapsed: false, recordedAt: 1 }],
      stashes: [],
      workspaces: [],
      canUndo: true,
      currentWindowId: 7,
    });
    expect(result.groups[0]).toMatchObject({ ownership: "created", active: true, windowLabel: "Current window" });
    expect(result.groups[0]?.badges).toEqual(["created", "stashed", "active"]);
    expect(result.canUndo).toBe(true);
  });

  it("marks a changed stash snapshot instead of claiming it is current", () => {
    const result = buildGroupManagerState({
      states: [state()],
      ownership: [],
      stashLinks: [{ groupId: 20, windowId: 7, stashId: "s", memberTabIds: [3], title: "Research", color: "blue", collapsed: false, recordedAt: 1 }],
      stashes: [],
      workspaces: [],
      canUndo: false,
      currentWindowId: 7,
    });
    expect(result.groups.find((item) => item.id === 20)?.badges).toContain("stash_changed");
  });

  it("keeps created provenance visible after management opt-out", () => {
    const result = buildGroupManagerState({
      states: [state()],
      ownership: [{ groupId: 10, windowId: 7, origin: "created", managed: false, recordedAt: 1 }],
      stashLinks: [],
      stashes: [],
      workspaces: [],
      canUndo: false,
      currentWindowId: 7,
    });
    expect(result.groups[0]).toMatchObject({ ownership: "created", managed: false });
    expect(result.groups[0]?.badges).toContain("created");
    expect(result.groups[0]?.badges).not.toContain("managed");
  });
});

describe("group manager planning", () => {
  it("previews metadata, membership, order, and emptied source groups", () => {
    const preview = previewGroupEdit(state(), {
      groupId: 10,
      title: "Quarter plan",
      color: "purple",
      collapsed: true,
      tabIds: [2, 3],
    }, "token");
    expect(preview).toMatchObject({
      addedTabIds: [3],
      removedTabIds: [1],
      reordered: false,
      emptiedSourceGroupIds: [],
      beforeTabCount: 2,
      afterTabCount: 2,
    });
  });

  it("rejects protected members and empty groups", () => {
    const protectedState = state();
    protectedState.tabs[1]!.protectionReasons = ["Protected"];
    expect(() => previewGroupEdit(protectedState, {
      groupId: 10,
      title: "Q2",
      color: "blue",
      collapsed: false,
      tabIds: [1],
    }, "token")).toThrow("Protected tabs");
    expect(() => previewGroupEdit(state(), {
      groupId: 10,
      title: "Q2",
      color: "blue",
      collapsed: false,
      tabIds: [],
    }, "token")).toThrow("Keep at least one tab");
  });

  it("defines inactive per window and blocks unsafe close targets", () => {
    const live = state();
    live.tabs[2]!.audible = true;
    const preview = previewGroupRemoval([live], [10, 20], "close", false, "token");
    expect(preview.eligibleGroupIds).toEqual([]);
    expect(preview.activeGroupIds).toEqual([10]);
    expect(preview.blockedGroups).toEqual([
      { groupId: 10, reason: "The active group is excluded until Include active group is confirmed." },
      { groupId: 20, reason: "Groups with audible tabs must be reviewed after audio stops." },
    ]);
    expect(previewGroupRemoval([live], [10, 20], "ungroup", false, "token").eligibleGroupIds).toEqual([10, 20]);
  });
});

describe("group manager search", () => {
  const manager = buildGroupManagerState({
    states: [state()], ownership: [], stashLinks: [], stashes: [], workspaces: [], canUndo: false, currentWindowId: 7,
  });

  it("keeps direct title and member-host matches ahead of semantic-only groups", () => {
    const semantic = [{ groupId: 20, score: 0.95, matchingMembers: 2 }];
    expect(rankGroupSearch(manager, "planning", semantic)).toEqual([10, 20]);
    expect(rankGroupSearch(manager, "research.example.com", [])).toEqual([10, 20]);
  });

  it("aggregates semantic tab results by strongest member and coverage", () => {
    expect(aggregateGroupSemanticScores([
      { tabId: 3, score: 0.8 },
      { tabId: 4, score: 0.7 },
      { tabId: 1, score: 0.75 },
    ], manager.tabs)).toEqual([
      { groupId: 20, score: 0.8, matchingMembers: 2 },
      { groupId: 10, score: 0.75, matchingMembers: 1 },
    ]);
  });
});
