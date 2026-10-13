import { describe, expect, it } from "vitest";
import {
  buildStashedSearchSnapshot,
  directStashedTabSearch,
  directResultsAreStrong,
  directTabSearch,
  searchableLocation,
  type SearchableTab,
} from "../src/search/direct-search";
import type { SavedTabStash } from "../src/shared/stash-types";

function tab(overrides: Partial<SearchableTab> & Pick<SearchableTab, "id" | "title">): SearchableTab {
  return {
    windowId: 1,
    windowLabel: "Current window",
    url: "https://example.com/",
    hostname: "example.com",
    path: "/",
    groupName: null,
    ...overrides,
  };
}

describe("direct tab search", () => {
  const snapshot = [
    tab({ id: 1, title: "Chrome Extensions", url: "https://developer.chrome.com/docs/extensions", hostname: "developer.chrome.com", path: "/docs/extensions", groupName: "Browser work" }),
    tab({ id: 2, title: "Extensions migration notes", url: "https://example.com/migration", path: "/migration" }),
    tab({ id: 3, title: "Inbox", url: "https://mail.google.com/mail/u/0/", hostname: "mail.google.com", path: "/mail/u/0/", groupName: "Communication" }),
  ];

  it("keeps exact titles ahead of title substrings and URL matches", () => {
    expect(directTabSearch(snapshot, "Chrome Extensions").map((result) => [result.tab.id, result.tier])).toEqual([[1, 0]]);
    expect(directTabSearch(snapshot, "extensions").map((result) => result.tab.id)).toEqual([2, 1]);
    expect(directTabSearch(snapshot, "migration").map((result) => [result.tab.id, result.reasons])).toEqual([[2, ["Title", "URL"]]]);
  });

  it("re-prepares a document whose fields change in place", () => {
    const mutable = tab({ id: 9, title: "Quarterly report" });
    expect(directTabSearch([mutable], "quarterly").map((result) => result.tab.id)).toEqual([9]);
    mutable.title = "Weekly notes";
    mutable.groupName = "Planning";
    expect(directTabSearch([mutable], "quarterly")).toEqual([]);
    expect(directTabSearch([mutable], "planning")[0]).toMatchObject({ tier: 1, reasons: ["Group"] });
    expect(directTabSearch([mutable], "planning", { includeGroupNames: false })).toEqual([]);
  });

  it("matches hostnames and group names without requiring semantic search", () => {
    expect(directTabSearch(snapshot, "mail.google.com")[0]).toMatchObject({ tab: { id: 3 }, tier: 1, reasons: ["URL"] });
    expect(directTabSearch(snapshot, "communication")[0]).toMatchObject({ tab: { id: 3 }, tier: 1, reasons: ["Group"] });
    expect(directTabSearch(snapshot, "communication", { includeGroupNames: false })).toEqual([]);
  });

  it("supports token and conservative one-edit fuzzy matching", () => {
    expect(directTabSearch(snapshot, "developer extensions")[0]).toMatchObject({ tab: { id: 1 }, reasons: ["Title", "URL"] });
    expect(directTabSearch(snapshot, "extensons")[0]).toMatchObject({ tab: { id: 1 }, tier: 6 });
    expect(directTabSearch(snapshot, "exns")).toEqual([]);
  });

  it("treats a mid-word title hit as weaker than a word match", () => {
    const words = [
      tab({ id: 1, title: "Algorithm notes" }),
      tab({ id: 2, title: "Go by example" }),
    ];
    expect(directTabSearch(words, "go").map((result) => [result.tab.id, result.tier])).toEqual([[2, 2], [1, 4]]);
    expect(directResultsAreStrong(directTabSearch([words[0]!], "go"))).toBe(false);
  });

  it("keeps substring matches strong in scripts written without spaces", () => {
    const thai = [tab({ id: 1, title: "วิธีทำขนมปังโฮลวีต" })];
    expect(directTabSearch(thai, "ขนมปัง")[0]).toMatchObject({ tab: { id: 1 }, tier: 3 });
  });

  it("ranks whole-word and title hits ahead of weaker hits in the same tier", () => {
    const scattered = [
      tab({ id: 1, title: "Alpha", url: "https://example.com/beta-notes", path: "/beta-notes" }),
      tab({ id: 2, title: "Alpha beta notes" }),
    ];
    expect(directTabSearch(scattered, "notes alpha").map((result) => result.tab.id)).toEqual([2, 1]);
  });

  it("breaks ties between equally strong matches by recent use", () => {
    const sameSite = [
      tab({ id: 1, title: "Issues", hostname: "github.com", url: "https://github.com/a", lastAccessed: 100 }),
      tab({ id: 2, title: "Pulls", hostname: "github.com", url: "https://github.com/b", lastAccessed: 300 }),
      tab({ id: 3, title: "Actions", hostname: "github.com", url: "https://github.com/c", lastAccessed: 200 }),
    ];
    expect(directTabSearch(sameSite, "github").map((result) => result.tab.id)).toEqual([2, 3, 1]);
  });

  it("handles decoded paths and malformed URLs", () => {
    expect(searchableLocation("https://example.com/toy%20shelf?q=private")).toEqual({ hostname: "example.com", path: "/toy shelf" });
    expect(searchableLocation("not a URL")).toEqual({ hostname: "", path: "not a URL" });
  });

  it("classifies exact, prefix, substring, and several literal matches as strong", () => {
    expect(directResultsAreStrong(directTabSearch(snapshot, "Chrome Extensions"))).toBe(true);
    expect(directResultsAreStrong(directTabSearch(snapshot, "extensons"))).toBe(false);
    expect(directResultsAreStrong([])).toBe(false);
  });

  it("searches reusable stashed tabs separately and excludes interrupted stashes", () => {
    const stash = (overrides: Partial<SavedTabStash>): SavedTabStash => ({
      id: "stash-a",
      name: "Research later",
      createdAt: 10,
      updatedAt: 10,
      note: "",
      revisions: [], lastOpenedAt: null,
      activeWorkspaceId: null,
      status: "saved",
      scope: { mode: "group", groupId: 1 },
      tabs: [{ sourceTabId: 7, sourceIndex: 2, title: "Qwen embedding notes", url: "https://docs.example.com/semantic%20search", groupKey: "g" }],
      groups: [{ key: "g", sourceGroupId: 1, sourceIndex: 0, title: "ML reading", color: "blue", collapsed: false }],
      excludedTabs: [],
      closeConflicts: [],
      restoreResult: null,
      ...overrides,
    });
    const snapshot = buildStashedSearchSnapshot([
      stash({}),
      stash({ id: "stash-b", status: "closing_interrupted" }),
    ]);
    expect(snapshot).toHaveLength(1);
    expect(directStashedTabSearch(snapshot, "semantic search")[0]).toMatchObject({
      tab: {
        key: "stash:stash-a:source:2",
        stashName: "Research later",
        stashRevisionId: "current:10",
        stashTabId: "source:2",
        groupKey: "g",
      },
      reasons: ["URL"],
    });
    expect(directStashedTabSearch(snapshot, "ML reading")[0]).toMatchObject({ reasons: ["Group"] });
    expect(directStashedTabSearch(snapshot, "ML reading", { includeGroupNames: false })).toEqual([]);
  });

  it("keeps duplicate source tab identities unique across stashes", () => {
    const base = {
      name: "One",
      createdAt: 10,
      updatedAt: 10,
      note: "",
      revisions: [], lastOpenedAt: null,
      activeWorkspaceId: null,
      status: "saved" as const,
      scope: { mode: "window" as const },
      tabs: [{ sourceTabId: 7, sourceIndex: 0, title: "Saved report", url: "https://example.com/report", groupKey: null }],
      groups: [],
      excludedTabs: [],
      closeConflicts: [],
      restoreResult: null,
    };
    const snapshot = buildStashedSearchSnapshot([{ ...base, id: "one" }, { ...base, id: "two", name: "Two" }]);
    expect(directStashedTabSearch(snapshot, "Saved report").map((result) => result.tab.key))
      .toEqual(["stash:one:source:0", "stash:two:source:0"]);
  });
});
