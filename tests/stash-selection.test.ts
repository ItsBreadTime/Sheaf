import { describe, expect, it } from "vitest";
import type { SavedTabStash } from "../src/shared/stash-types";
import { canonicalExactUrl, createStashFromResolvedSelection, orderResolvedStashTabs, possibleDuplicateUrl, referenceForStashedTab, resolveStashTabReferences, stashSelectionResolutionToken } from "../src/search/stash-selection";

function stash(overrides: Partial<SavedTabStash> = {}): SavedTabStash {
  return {
    id: "stash-a", name: "Research", createdAt: 1, updatedAt: 10, note: "", revisions: [], lastOpenedAt: null,
    activeWorkspaceId: null, status: "saved", scope: { mode: "window" }, excludedTabs: [], closeConflicts: [],
    restoreResult: null,
    tabs: [{ sourceTabId: 1, sourceIndex: 2, stableKey: "stable-a", title: "Qwen", url: "https://example.com/qwen", groupKey: "g" }],
    groups: [{ key: "g", sourceGroupId: 4, sourceIndex: 1, title: "Models", color: "blue", collapsed: false }],
    ...overrides,
  };
}

describe("stashed search selection identities", () => {
  it("re-resolves stable tab identities after a stash revision changes", () => {
    const original = stash();
    const reference = referenceForStashedTab(original, original.tabs[0]!);
    const updated = stash({ updatedAt: 20, tabs: [{ ...original.tabs[0]!, title: "Qwen notes", sourceIndex: 8 }] });
    const resolved = resolveStashTabReferences([updated], [reference]);
    expect(resolved.stale).toEqual([]);
    expect(resolved.available[0]).toMatchObject({ changedSinceSearch: true, tab: { title: "Qwen notes", sourceIndex: 8 }, group: { title: "Models" } });
  });

  it("reports removed tabs and never substitutes another URL match", () => {
    const original = stash();
    const reference = referenceForStashedTab(original, original.tabs[0]!);
    const updated = stash({ updatedAt: 20, tabs: [{ ...original.tabs[0]!, stableKey: "other", sourceIndex: 9 }] });
    expect(resolveStashTabReferences([updated], [reference])).toMatchObject({
      available: [],
      stale: [{ stashId: "stash-a", stashTabId: "stable-a", reason: "tab_removed" }],
    });
  });

  it("normalizes exact URLs conservatively and only warns on related URL variants", () => {
    expect(canonicalExactUrl("HTTPS://Example.COM/")).toBe("https://example.com/");
    expect(canonicalExactUrl("https://example.com/doc?q=1#part")).toBe("https://example.com/doc?q=1#part");
    expect(possibleDuplicateUrl("https://example.com/doc?q=1", "https://example.com/doc?q=2")).toBe(true);
    expect(possibleDuplicateUrl("https://example.com/doc", "https://example.com/other")).toBe(false);
  });

  it("creates a new stash from only the selected tabs and keeps same-named source groups separate", () => {
    const first = stash();
    const second = stash({ id: "stash-b", name: "Other", tabs: [{ ...stash().tabs[0]!, stableKey: "stable-b", title: "Vercel", url: "https://example.com/vercel" }] });
    const sourceBytes = JSON.stringify([first, second]);
    const references = [referenceForStashedTab(first, first.tabs[0]!), referenceForStashedTab(second, second.tabs[0]!)];
    const resolved = resolveStashTabReferences([first, second], references).available;
    const created = createStashFromResolvedSelection(resolved, "Provider research", { preserveGroups: true, sourceQueries: ["qwen", "vercel"], now: 50 });
    expect(created).toMatchObject({
      name: "Provider research",
      createdAt: 50,
      tabs: [{ title: "Qwen", groupKey: "group-1" }, { title: "Vercel", groupKey: "group-2" }],
      groups: [{ title: "Models", key: "group-1" }, { title: "Models", key: "group-2" }],
      provenance: { kind: "search_selection", sourceQueries: ["qwen", "vercel"] },
    });
    expect(JSON.stringify([first, second])).toBe(sourceBytes);
  });

  it("orders multi-query selections by stash and saved tab order", () => {
    const first = stash({ tabs: [
      { ...stash().tabs[0]!, sourceIndex: 8, stableKey: "late", title: "Late" },
      { ...stash().tabs[0]!, sourceIndex: 2, stableKey: "early", title: "Early" },
    ] });
    const second = stash({ id: "stash-b", tabs: [{ ...stash().tabs[0]!, stableKey: "second", title: "Second" }] });
    const refs = [
      referenceForStashedTab(second, second.tabs[0]!),
      referenceForStashedTab(first, first.tabs[0]!),
      referenceForStashedTab(first, first.tabs[1]!),
    ];
    const available = resolveStashTabReferences([first, second], refs).available;
    expect(orderResolvedStashTabs([first, second], available).map((item) => item.tab.title)).toEqual(["Early", "Late", "Second"]);
  });

  it("changes the reviewed token when a stash changes after preflight", () => {
    const original = stash();
    const reference = referenceForStashedTab(original, original.tabs[0]!);
    const first = resolveStashTabReferences([original], [reference]);
    const updated = stash({ updatedAt: 11, tabs: [{ ...original.tabs[0]!, title: "Updated after review" }] });
    const second = resolveStashTabReferences([updated], [reference]);
    expect(stashSelectionResolutionToken(first.available, first.stale)).not.toBe(
      stashSelectionResolutionToken(second.available, second.stale),
    );
  });
});
