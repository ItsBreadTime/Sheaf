import { describe, expect, it } from "vitest";
import { compareSemanticStates } from "../src/browser/semantic-compare";
import type {
  SemanticGroup,
  SemanticTab,
  SemanticWindowState,
} from "../src/shared/types";

function tab(id: number, index: number, groupId = -1): SemanticTab {
  return {
    id,
    windowId: 7,
    index,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    groupId,
    active: id === 1,
    pinned: false,
    audible: false,
    openerTabId: null,
    lastAccessed: null,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
  };
}

function group(runtimeId: number): SemanticGroup {
  return {
    runtimeId,
    windowId: 7,
    title: "Work",
    color: "blue",
    collapsed: false,
    shared: { known: true, value: false },
    memberTabIds: [1, 2],
    firstTabIndex: 0,
    protectionReasons: [],
  };
}

function state(
  tabs: SemanticTab[],
  groups: SemanticGroup[] = [],
): SemanticWindowState {
  return {
    windowId: 7,
    capturedAt: Date.now(),
    tabs,
    groups,
    eligibleTabIds: tabs
      .filter((item) => item.protectionReasons.length === 0)
      .map((item) => item.id),
    protectedTabIds: tabs
      .filter((item) => item.protectionReasons.length > 0)
      .map((item) => item.id),
    featureSupport: {
      sharedGroupProperty: true,
      splitViewIdProperty: true,
      storageSession: true,
    },
  };
}

describe("semantic state comparison", () => {
  it("does not use native group ID as semantic identity", () => {
    const expected = state([tab(1, 0, 11), tab(2, 1, 11)], [group(11)]);
    const observed = state([tab(1, 0, 99), tab(2, 1, 99)], [group(99)]);
    expect(compareSemanticStates(expected, observed)).toEqual({
      matches: true,
      issues: [],
    });
  });

  it("detects ordering and group metadata drift", () => {
    const expected = state([tab(1, 0, 11), tab(2, 1, 11)], [group(11)]);
    const changed = group(99);
    changed.title = "Changed";
    const observed = state([tab(2, 0, 99), tab(1, 1, 99)], [changed]);
    const comparison = compareSemanticStates(expected, observed);
    expect(comparison.matches).toBe(false);
    expect(comparison.issues).toContain("Tab membership or relative ordering changed.");
    expect(comparison.issues).toContain(
      "Native group semantics differ from the captured state.",
    );
  });
});
