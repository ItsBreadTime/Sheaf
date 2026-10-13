import { describe, expect, it } from "vitest";
import { planStashSearchEdit, previewStashSearchEdit } from "../src/search/stash-editing";
import { referenceForStashedTab } from "../src/search/stash-selection";
import type { SavedTabStash, StashedTab } from "../src/shared/stash-types";

function tab(stableKey: string, sourceIndex: number, groupKey: string | null = null): StashedTab {
  return { sourceTabId: sourceIndex + 1, sourceIndex, stableKey, title: stableKey, url: `https://example.com/${stableKey}`, groupKey };
}

function stash(id: string, tabs: StashedTab[], overrides: Partial<SavedTabStash> = {}): SavedTabStash {
  const groupKeys = [...new Set(tabs.flatMap((item) => item.groupKey ? [item.groupKey] : []))];
  return {
    id, name: id, createdAt: 1, updatedAt: 10, note: "", revisions: [], lastOpenedAt: null, activeWorkspaceId: null,
    status: "saved", scope: { mode: "window" }, excludedTabs: [], closeConflicts: [], restoreResult: null,
    tabs, groups: groupKeys.map((key, index) => ({ key, sourceGroupId: index + 1, sourceIndex: index, title: "Research", color: "blue", collapsed: false })),
    ...overrides,
  };
}

function ids() {
  let value = 0;
  return () => `id-${++value}`;
}

describe("destructive search stash editing", () => {
  it("removes selected tabs across stashes, keeps order, and drops only empty groups", () => {
    const a = stash("a", [tab("a1", 0, "g1"), tab("a2", 1, "g1"), tab("a3", 2, "g2")]);
    const b = stash("b", [tab("b1", 0), tab("b2", 1)]);
    const refs = [referenceForStashedTab(a, a.tabs[0]!), referenceForStashedTab(a, a.tabs[2]!), referenceForStashedTab(b, b.tabs[1]!)];
    const preview = previewStashSearchEdit([a, b], refs, "remove");
    const plan = planStashSearchEdit([a, b], refs, "remove", { reviewedSelectionToken: preview.reviewedSelectionToken, now: 20, createId: ids() });
    expect(plan.stashes[0]!.tabs.map((item) => item.stableKey)).toEqual(["a2"]);
    expect(plan.stashes[0]!.groups.map((group) => group.key)).toEqual(["g1"]);
    expect(plan.stashes[1]!.tabs.map((item) => item.stableKey)).toEqual(["b1"]);
    expect(plan.stashes.every((item) => item.updatedAt === 20 && item.revisions.length === 1)).toBe(true);
    expect(plan.stashes[0]!.revisions[0]).toMatchObject({ savedAt: 10, tabs: a.tabs, groups: a.groups });
    expect(plan.stashes[1]!.revisions[0]).toMatchObject({ savedAt: 10, tabs: b.tabs, groups: b.groups });
    expect(plan.undoPoint?.before).toEqual([a, b]);
  });

  it("moves in source order, preserves represented groups, and keeps same-named groups separate", () => {
    const a = stash("a", [tab("a-late", 8, "g"), tab("a-early", 2, "g")]);
    const b = stash("b", [tab("b", 1, "g")]);
    const target = stash("target", [tab("existing", 4, "existing")], {
      groups: [{ key: "existing", sourceGroupId: 1, sourceIndex: 4, title: "Existing", color: "red", collapsed: false }],
    });
    const refs = [referenceForStashedTab(b, b.tabs[0]!), referenceForStashedTab(a, a.tabs[0]!), referenceForStashedTab(a, a.tabs[1]!)];
    const preview = previewStashSearchEdit([a, b, target], refs, "move", { targetStashId: target.id });
    const plan = planStashSearchEdit([a, b, target], refs, "move", { targetStashId: target.id, reviewedSelectionToken: preview.reviewedSelectionToken, now: 20, createId: ids() });
    const changedTarget = plan.stashes[2]!;
    expect(changedTarget.tabs.map((item) => item.title)).toEqual(["existing", "a-early", "a-late", "b"]);
    expect(changedTarget.tabs.slice(1).map((item) => item.sourceIndex)).toEqual([5, 6, 7]);
    expect(changedTarget.groups.map((group) => group.sourceIndex)).toEqual([4, 5, 7]);
    expect(changedTarget.groups.slice(1).map((group) => group.title)).toEqual(["Research", "Research"]);
    expect(new Set(changedTarget.groups.map((group) => group.key)).size).toBe(3);
    expect(plan.stashes[0]!.tabs).toEqual([]);
    expect(plan.stashes[1]!.tabs).toEqual([]);
  });

  it("merges copies into the target while leaving every source byte-for-byte unchanged", () => {
    const source = stash("source", [tab("one", 0, "g"), tab("two", 1, "g")]);
    const target = stash("target", [tab("existing", 0)]);
    const sourceBytes = JSON.stringify(source);
    const refs = [referenceForStashedTab(source, source.tabs[1]!)];
    const preview = previewStashSearchEdit([source, target], refs, "merge", { targetStashId: target.id });
    const plan = planStashSearchEdit([source, target], refs, "merge", { targetStashId: target.id, reviewedSelectionToken: preview.reviewedSelectionToken, createId: ids() });
    expect(JSON.stringify(plan.stashes[0])).toBe(sourceBytes);
    expect(plan.undoPoint?.before.map((item) => item.id)).toEqual(["target"]);
    expect(plan.stashes[1]!.tabs.map((item) => item.title)).toEqual(["existing", "two"]);
    expect(plan.stashes[1]!.revisions[0]).toMatchObject({ tabs: target.tabs, groups: target.groups });
  });

  it("blocks active workspaces, self-targets, and missing destinations", () => {
    const source = stash("source", [tab("one", 0)], { activeWorkspaceId: "live" });
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    expect(previewStashSearchEdit([source], [ref], "remove").blockedReason).toContain("unlink the window");
    const detached = { ...source, activeWorkspaceId: null };
    const detachedRef = referenceForStashedTab(detached, detached.tabs[0]!);
    expect(previewStashSearchEdit([detached], [detachedRef], "move").blockedReason).toContain("destination");
    expect(previewStashSearchEdit([detached], [detachedRef], "merge", { targetStashId: detached.id }).blockedReason).toContain("not one of");
  });

  it("requires a fresh review token when a source changes", () => {
    const source = stash("source", [tab("one", 0)]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = previewStashSearchEdit([source], [ref], "remove");
    const changed = { ...source, updatedAt: 11, tabs: [{ ...source.tabs[0]!, title: "changed" }] };
    const plan = planStashSearchEdit([changed], [ref], "remove", { reviewedSelectionToken: preview.reviewedSelectionToken, createId: ids() });
    expect(plan.requiresReview).toBe(true);
    expect(plan.undoPoint).toBeNull();
    expect(plan.stashes).toEqual([changed]);
  });

  it("requires review when the reviewed token is omitted", () => {
    const source = stash("source", [tab("one", 0)]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const plan = planStashSearchEdit([source], [ref], "remove", { createId: ids() });
    expect(plan).toMatchObject({ requiresReview: true, undoPoint: null, stashes: [source] });
  });

  it("allocates unused negative numeric IDs even when previous edits left gaps", () => {
    const source = stash("source", [tab("one", 0, "g")]);
    const target = stash("target", [{ ...tab("existing", 4, "old"), sourceTabId: -2 }], {
      groups: [{ key: "old", sourceGroupId: -2, sourceIndex: 4, title: "Old", color: "red", collapsed: false }],
    });
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = previewStashSearchEdit([source, target], [ref], "merge", { targetStashId: target.id });
    const plan = planStashSearchEdit([source, target], [ref], "merge", {
      targetStashId: target.id, reviewedSelectionToken: preview.reviewedSelectionToken, createId: ids(),
    });
    expect(plan.stashes[1]!.tabs.map((item) => item.sourceTabId)).toEqual([-2, -1]);
    expect(plan.stashes[1]!.groups.map((group) => group.sourceGroupId)).toEqual([-2, -1]);
    expect(plan.stashes[1]!.groups.map((group) => group.sourceIndex)).toEqual([4, 5]);
  });

  it("binds review to the destructive operation", () => {
    const source = stash("source", [tab("one", 0)]);
    const target = stash("target", []);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const removePreview = previewStashSearchEdit([source, target], [ref], "remove");
    const plan = planStashSearchEdit([source, target], [ref], "move", {
      targetStashId: target.id, reviewedSelectionToken: removePreview.reviewedSelectionToken, createId: ids(),
    });
    expect(plan).toMatchObject({ requiresReview: true, undoPoint: null, stashes: [source, target] });
  });

  it("binds review to the chosen destination", () => {
    const source = stash("source", [tab("one", 0)]);
    const firstTarget = stash("first-target", []);
    const secondTarget = stash("second-target", []);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = previewStashSearchEdit([source, firstTarget, secondTarget], [ref], "move", { targetStashId: firstTarget.id });
    const plan = planStashSearchEdit([source, firstTarget, secondTarget], [ref], "move", {
      targetStashId: secondTarget.id, reviewedSelectionToken: preview.reviewedSelectionToken, createId: ids(),
    });
    expect(plan.requiresReview).toBe(true);
    expect(plan.stashes).toEqual([source, firstTarget, secondTarget]);
  });

  it("requires another review when the destination changes after preview", () => {
    const source = stash("source", [tab("one", 0)]);
    const target = stash("target", [tab("existing", 0)]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = previewStashSearchEdit([source, target], [ref], "merge", { targetStashId: target.id });
    const changedTarget = { ...target, tabs: [...target.tabs, tab("external-change", 1)] };
    const plan = planStashSearchEdit([source, changedTarget], [ref], "merge", {
      targetStashId: target.id, reviewedSelectionToken: preview.reviewedSelectionToken, createId: ids(),
    });
    expect(plan).toMatchObject({ requiresReview: true, undoPoint: null });
    expect(plan.stashes).toEqual([source, changedTarget]);
  });
});
