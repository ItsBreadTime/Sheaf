import { describe, expect, it } from "vitest";
import { historyGenerationStats, summarizeWindowChanges, totalTabsMoved } from "../src/organizer/history-changes";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";

const NONE = -1;

/** Builds a window from `[tabId, groupId]` pairs in tab-strip order. */
function windowOf(
  layout: Array<[number, number]>,
  groups: Array<Pick<SemanticGroup, "runtimeId" | "title"> & Partial<SemanticGroup>> = [],
): SemanticWindowState {
  const tabs: SemanticTab[] = layout.map(([id, groupId], index) => ({
    id,
    windowId: 1,
    index,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    groupId,
    active: false,
    pinned: false,
    audible: false,
    openerTabId: null,
    lastAccessed: null,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
  }));
  return {
    windowId: 1,
    capturedAt: 0,
    tabs,
    groups: groups.map((group) => {
      const members = tabs.filter((tab) => tab.groupId === group.runtimeId);
      return {
        windowId: 1,
        color: "blue",
        collapsed: false,
        shared: { known: true, value: false },
        protectionReasons: [],
        ...group,
        memberTabIds: members.map((tab) => tab.id),
        firstTabIndex: members[0]?.index ?? 0,
      };
    }),
    eligibleTabIds: tabs.map((tab) => tab.id),
    protectedTabIds: [],
    featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true },
  };
}

describe("history window change summary", () => {
  it("counts loose tabs joining a new group", () => {
    const before = windowOf([[1, NONE], [2, NONE], [3, NONE]]);
    const after = windowOf([[1, -100], [2, -100], [3, NONE]], [{ runtimeId: -100, title: "Docs" }]);
    const { tabs, groups } = summarizeWindowChanges(before, after);
    expect(tabs).toMatchObject({ grouped: 2, regrouped: 0, ungrouped: 0, reordered: 0 });
    expect(groups).toEqual({ created: 1, renamed: 0, recolored: 0, removed: 0 });
  });

  it("counts reordering when no group membership changes", () => {
    const before = windowOf([[1, NONE], [2, NONE], [3, NONE], [4, NONE]]);
    const after = windowOf([[2, NONE], [3, NONE], [4, NONE], [1, NONE]]);
    const { tabs, groups } = summarizeWindowChanges(before, after);
    expect(tabs.reordered).toBe(1);
    expect(totalTabsMoved(tabs)).toBe(1);
    expect(groups).toEqual({ created: 0, renamed: 0, recolored: 0, removed: 0 });
  });

  it("treats a recreated group that gained one tab as that group continuing", () => {
    const before = windowOf(
      [[1, 10], [2, 10], [3, 10], [4, NONE]],
      [{ runtimeId: 10, title: "Research" }],
    );
    const after = windowOf(
      [[1, -100], [2, -100], [3, -100], [4, -100]],
      [{ runtimeId: -100, title: "Research" }],
    );
    const { tabs, groups } = summarizeWindowChanges(before, after);
    expect(tabs).toMatchObject({ grouped: 1, regrouped: 0, reordered: 0 });
    expect(groups).toEqual({ created: 0, renamed: 0, recolored: 0, removed: 0 });
  });

  it("reports merges, renames, and removed groups", () => {
    const before = windowOf(
      [[1, 10], [2, 10], [3, 10], [4, 20], [5, 20]],
      [{ runtimeId: 10, title: "Shopping" }, { runtimeId: 20, title: "Deals", color: "red" }],
    );
    const after = windowOf(
      [[1, -100], [2, -100], [3, -100], [4, -100], [5, -100]],
      [{ runtimeId: -100, title: "Buying", color: "blue" }],
    );
    const { tabs, groups } = summarizeWindowChanges(before, after, 2);
    expect(tabs).toEqual({ grouped: 0, regrouped: 2, ungrouped: 0, reordered: 0, closed: 2 });
    expect(groups).toEqual({ created: 0, renamed: 1, recolored: 0, removed: 1 });
  });

  it("counts tabs leaving a group and recolored survivors", () => {
    const before = windowOf([[1, 10], [2, 10], [3, 10]], [{ runtimeId: 10, title: "Work", color: "blue" }]);
    const after = windowOf([[1, 10], [2, 10], [3, NONE]], [{ runtimeId: 10, title: "Work", color: "green" }]);
    const { tabs, groups } = summarizeWindowChanges(before, after);
    expect(tabs).toMatchObject({ ungrouped: 1, reordered: 0 });
    expect(groups).toEqual({ created: 0, renamed: 0, recolored: 1, removed: 0 });
  });
});

describe("history generation stats", () => {
  it("is absent without usage or timing", () => {
    expect(historyGenerationStats({ repairAttempted: false })).toBeUndefined();
  });

  it("copies counts and timings without content", () => {
    expect(historyGenerationStats({
      repairAttempted: true,
      usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140, cachedTokens: 20, reasoningTokens: 12 },
      metrics: { reasoningEffort: "high", timeToFirstTokenMs: 800, providerMs: 2_000, outputTokensPerSecond: 33.3, streamed: true },
    })).toEqual({
      reasoningEffort: "high",
      timeToFirstTokenMs: 800,
      providerMs: 2_000,
      outputTokensPerSecond: 33.3,
      promptTokens: 100,
      completionTokens: 40,
      reasoningTokens: 12,
      cachedTokens: 20,
      totalTokens: 140,
      repairAttempted: true,
    });
  });
});
