import { describe, expect, it } from "vitest";
import {
  buildStashWorkspaceDiff,
  commitWorkspaceDraft,
  matchWorkspaceWindow,
  sameWorkspaceStructure,
  trackedTabsForRestoredWindow,
} from "../src/browser/stash-workspaces";
import type { SavedTabStash, StashedGroup, StashedTab } from "../src/shared/stash-types";

const tab = (sourceIndex: number, url: string, groupKey: string | null = null): StashedTab => ({
  sourceTabId: sourceIndex + 1,
  sourceIndex,
  title: url.split("/").at(-1) ?? url,
  url,
  groupKey,
});

const group = (key: string, title: string, sourceIndex = 0): StashedGroup => ({
  key,
  sourceGroupId: sourceIndex + 10,
  sourceIndex,
  title,
  color: "blue",
  collapsed: false,
});

function stash(tabs: StashedTab[], groups: StashedGroup[] = []): SavedTabStash {
  return {
    id: "stash",
    name: "Workspace",
    createdAt: 1,
    updatedAt: 1,
    note: "",
    revisions: [], lastOpenedAt: null,
    activeWorkspaceId: "workspace",
    status: "saved",
    scope: { mode: "window" },
    tabs,
    groups,
    excludedTabs: [],
    closeConflicts: [],
    restoreResult: null,
  };
}

describe("linked stash workspace diff", () => {
  it("reports additions, removals, group renames, and reordering without mutating the stash", async () => {
    const saved = stash([
      { ...tab(0, "https://example.com/a", "g1"), stableKey: "stash:0" },
      { ...tab(1, "https://example.com/b", "g1"), stableKey: "stash:1" },
      { ...tab(2, "https://example.com/c"), stableKey: "stash:2" },
    ], [group("g1", "Research")]);
    const original = structuredClone(saved);
    const diff = await buildStashWorkspaceDiff(saved, {
      tabs: [
        { ...tab(0, "https://example.com/b", "g1"), stableKey: "stash:1" },
        { ...tab(1, "https://example.com/a", "g1"), stableKey: "stash:0" },
        { ...tab(2, "https://example.com/d"), stableKey: "workspace:new" },
      ],
      groups: [group("g1", "Reading")],
    });

    expect(diff).toEqual({
      addedTabs: 1,
      removedTabs: 1,
      changedTabs: 0,
      renamedGroups: 1,
      groupStructureChanges: 0,
      reorderedTabs: 2,
      currentTabCount: 3,
      captureToken: expect.any(String),
      addedTitles: ["d"],
      removedTitles: ["c"],
      privateTabs: 0,
    });
    expect(saved).toEqual(original);
  });

  it("distinguishes duplicate URL occurrences", async () => {
    const saved = stash([
      tab(0, "https://example.com/a"),
      tab(1, "https://example.com/a"),
    ]);
    expect(await buildStashWorkspaceDiff(saved, {
      tabs: [tab(0, "https://example.com/a")],
      groups: [],
    })).toMatchObject({ addedTabs: 0, removedTabs: 1, changedTabs: 0 });
  });

  it("reports group splits as structure changes instead of positional renames", async () => {
    const saved = stash([
      tab(0, "https://example.com/a", "g1"),
      tab(1, "https://example.com/b", "g1"),
    ], [group("g1", "Research")]);
    const diff = await buildStashWorkspaceDiff(saved, {
      tabs: [tab(0, "https://example.com/a", "g1"), tab(1, "https://example.com/b", "g2")],
      groups: [group("g1", "Research"), group("g2", "Research", 1)],
    });
    expect(diff).toMatchObject({ renamedGroups: 0, groupStructureChanges: 3 });
  });

  it("keeps duplicate-URL group identity stable when tabs are reordered", async () => {
    const first = { ...tab(0, "https://example.com/same", "g1"), stableKey: "stash:0" };
    const second = { ...tab(1, "https://example.com/same", "g2"), stableKey: "stash:1" };
    const saved = stash([first, second], [group("g1", "One"), group("g2", "Two", 1)]);
    const diff = await buildStashWorkspaceDiff(saved, {
      tabs: [
        { ...second, sourceIndex: 0 },
        { ...first, sourceIndex: 1 },
      ],
      groups: [group("g2", "Two"), group("g1", "One", 1)],
    });
    expect(diff).toMatchObject({ renamedGroups: 0, groupStructureChanges: 0, reorderedTabs: 2 });
  });

  it("reports navigation as a changed tracked tab instead of remove plus add", async () => {
    const saved = stash([{ ...tab(0, "https://example.com/old"), stableKey: "stash:0" }]);
    const diff = await buildStashWorkspaceDiff(saved, {
      tabs: [{ ...tab(0, "https://example.com/new"), stableKey: "stash:0" }],
      groups: [],
    });
    expect(diff).toMatchObject({ addedTabs: 0, removedTabs: 0, changedTabs: 1 });
  });
});

const draftOf = (tabs: StashedTab[], groups: StashedGroup[] = []) => ({ tabs, groups, capturedAt: 50, captureToken: "t" });

describe("linked workspace autosave", () => {
  const keyed = (index: number, url: string, groupKey: string | null = null): StashedTab =>
    ({ ...tab(index, url, groupKey), stableKey: `k${index}` });

  it("treats title-only differences as the same structure", () => {
    const saved = stash([keyed(0, "https://example.com/a")]);
    expect(sameWorkspaceStructure(saved, { tabs: [{ ...keyed(0, "https://example.com/a"), title: "Loaded" }], groups: [] })).toBe(true);
    expect(sameWorkspaceStructure(saved, { tabs: [keyed(0, "https://example.com/b")], groups: [] })).toBe(false);
  });

  it("detects a group rename as a structural change", () => {
    const saved = stash([keyed(0, "https://example.com/a", "g1")], [group("g1", "Research")]);
    expect(sameWorkspaceStructure(saved, {
      tabs: [keyed(0, "https://example.com/a", "g1")],
      groups: [group("g1", "Reading")],
    })).toBe(false);
  });

  it("leaves the stash alone without a draft or with an identical draft", () => {
    const saved = stash([keyed(0, "https://example.com/a")]);
    expect(commitWorkspaceDraft(saved, null, 99)).toEqual({ kind: "unchanged" });
    expect(commitWorkspaceDraft(saved, draftOf(structuredClone(saved.tabs)), 99)).toEqual({ kind: "unchanged" });
  });

  it("never replaces saved tabs with an empty window", () => {
    expect(commitWorkspaceDraft(stash([keyed(0, "https://example.com/a")]), draftOf([]), 99)).toEqual({ kind: "empty" });
  });

  it("keeps the previous contents as one revision on a structural change", () => {
    const saved = stash([keyed(0, "https://example.com/a")]);
    const result = commitWorkspaceDraft(saved, draftOf([keyed(0, "https://example.com/a"), keyed(1, "https://example.com/b")]), 99, () => "rev");
    expect(result).toMatchObject({ kind: "updated", revised: true });
    if (result.kind !== "updated") throw new Error("expected an update");
    expect(result.stash.tabs).toHaveLength(2);
    expect(result.stash.updatedAt).toBe(99);
    expect(result.stash.revisions).toEqual([{ id: "rev", savedAt: 1, tabs: saved.tabs, groups: [] }]);
  });

  it("updates titles in place without adding a revision", () => {
    const saved = stash([keyed(0, "https://example.com/a")]);
    const result = commitWorkspaceDraft(saved, draftOf([{ ...keyed(0, "https://example.com/a"), title: "Fresh" }]), 99);
    expect(result).toMatchObject({ kind: "updated", revised: false });
    if (result.kind !== "updated") throw new Error("expected an update");
    expect(result.stash.revisions).toEqual([]);
    expect(result.stash.tabs[0]!.title).toBe("Fresh");
  });

  it("matches a restored window by address and refuses ambiguous or diluted matches", () => {
    const urls = ["https://a.test/1", "https://a.test/2", "https://a.test/3", "https://a.test/4", "https://a.test/5"];
    expect(matchWorkspaceWindow(urls, [
      { windowId: 1, urls: ["https://other.test/"] },
      { windowId: 2, urls: [...urls, "https://a.test/new"] },
    ])).toBe(2);
    expect(matchWorkspaceWindow(urls, [{ windowId: 2, urls }, { windowId: 3, urls }])).toBeNull();
    expect(matchWorkspaceWindow(urls, [{ windowId: 2, urls: urls.slice(0, 3) }])).toBeNull();
    expect(matchWorkspaceWindow(urls, [{
      windowId: 2,
      urls: [...urls, ...Array.from({ length: 10 }, (_, index) => `https://noise.test/${index}`)],
    }])).toBeNull();
    expect(matchWorkspaceWindow([], [{ windowId: 2, urls }])).toBeNull();
  });

  it("keeps the identity of a restored tab that redirected on the same host", () => {
    const saved = [keyed(0, "https://a.test/x"), keyed(1, "http://b.test/login?next=1"), keyed(2, "https://c.test/short")];
    expect(trackedTabsForRestoredWindow(saved, [
      { id: 10, url: "https://a.test/x" },
      { id: 11, url: "https://www.b.test/home" },
      { id: 12, url: "https://elsewhere.test/long" },
    ])).toEqual([
      { tabId: 10, stableKey: "k0" },
      { tabId: 11, stableKey: "k1" },
    ]);
  });

  it("maps restored tabs back to their stable keys in order, including duplicates", () => {
    const saved = [keyed(0, "https://a.test/x"), keyed(1, "https://a.test/x"), keyed(2, "https://a.test/y")];
    expect(trackedTabsForRestoredWindow(saved, [
      { id: 10, url: "https://a.test/y" },
      { id: 11, url: "https://a.test/x" },
      { id: 12, url: "https://a.test/x" },
      { id: 13, url: "https://a.test/z" },
    ])).toEqual([
      { tabId: 10, stableKey: "k2" },
      { tabId: 11, stableKey: "k0" },
      { tabId: 12, stableKey: "k1" },
    ]);
  });
});
