import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceForStashedTab } from "../src/search/stash-selection";
import type { SavedTabStash } from "../src/shared/stash-types";
import {
  applyStoredStashSearchEdit,
  previewStoredStashSearchEdit,
  readStashSearchEditUndoPoint,
  undoStoredStashSearchEdit,
} from "../src/storage/stash-search-edits";
import { readTabStashes, writeTabStashes } from "../src/storage/stashes";

afterEach(() => vi.unstubAllGlobals());

function stash(id: string, keys: string[]): SavedTabStash {
  return {
    id, name: id, createdAt: 1, updatedAt: 10, note: "", revisions: [], lastOpenedAt: null, activeWorkspaceId: null,
    status: "saved", scope: { mode: "window" }, excludedTabs: [], closeConflicts: [], restoreResult: null,
    tabs: keys.map((key, index) => ({
      sourceTabId: index + 1, sourceIndex: index, stableKey: key, title: key,
      url: `https://example.com/${key}`, groupKey: keys.length > 1 ? "g" : null,
    })),
    groups: keys.length > 1
      ? [{ key: "g", sourceGroupId: 1, sourceIndex: 0, title: "Group", color: "blue", collapsed: false }]
      : [],
  };
}

function installChromeStorage(options: { corruptFirstStashWrite?: boolean } = {}) {
  const values: Record<string, unknown> = {};
  let stashWrites = 0;
  let ignoreUndoClear = false;
  let ignoreUndoWrites = false;
  let undoGets = 0;
  let failUndoGetAt = -1;
  vi.stubGlobal("chrome", {
    tabGroups: { TAB_GROUP_ID_NONE: -1 },
    storage: {
      local: {
        async get(key: string | string[]) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.flatMap((item) => item in values ? [[item, structuredClone(values[item])]] : []));
        },
        async set(items: Record<string, unknown>) {
          if ("workspaces" in items) stashWrites += 1;
          if (options.corruptFirstStashWrite && stashWrites === 2) {
            values.workspaces = [];
            return;
          }
          Object.assign(values, structuredClone(items));
        },
      },
      session: {
        async get(key: string) {
          if (key === "workspaceSearchEditUndoPoint") {
            undoGets += 1;
            if (undoGets === failUndoGetAt) throw new Error("Injected session read failure");
          }
          return key in values ? { [key]: structuredClone(values[key]) } : {};
        },
        async set(items: Record<string, unknown>) {
          if ("workspaceSearchEditUndoPoint" in items && (ignoreUndoWrites || (ignoreUndoClear && items.workspaceSearchEditUndoPoint === null))) return;
          Object.assign(values, structuredClone(items));
        },
      },
    },
  });
  return {
    values,
    get stashWrites() { return stashWrites; },
    setIgnoreUndoClear(value: boolean) { ignoreUndoClear = value; },
    setIgnoreUndoWrites(value: boolean) { ignoreUndoWrites = value; },
    failUndoGetAfter(offset: number) { failUndoGetAt = undoGets + offset; },
  };
}

describe("stored destructive stash edits", () => {
  it("applies a reviewed edit, verifies it, and restores exact snapshots through undo", async () => {
    installChromeStorage();
    const source = stash("source", ["one", "two"]);
    const original = structuredClone(source);
    await writeTabStashes([source]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = await previewStoredStashSearchEdit([ref], "remove");
    const result = await applyStoredStashSearchEdit([ref], "remove", null, preview.reviewedSelectionToken);
    expect(result).toMatchObject({ applied: true, requiresReview: false });
    expect((await readTabStashes())[0]!.tabs.map((tab) => tab.title)).toEqual(["two"]);
    expect(await readStashSearchEditUndoPoint()).toMatchObject({ transactionId: result.transactionId, before: [original] });
    expect(await undoStoredStashSearchEdit(result.transactionId!)).toEqual({ undone: true, unavailableReason: null });
    expect(await readTabStashes()).toEqual([original]);
    expect(await readStashSearchEditUndoPoint()).toBeNull();
  });

  it("returns requiresReview without writing when the reviewed state is stale", async () => {
    const storage = installChromeStorage();
    const source = stash("source", ["one"]);
    await writeTabStashes([source]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = await previewStoredStashSearchEdit([ref], "remove");
    await writeTabStashes([{ ...source, updatedAt: 11, tabs: [{ ...source.tabs[0]!, title: "external" }] }]);
    const writesBeforeApply = storage.stashWrites;
    const result = await applyStoredStashSearchEdit([ref], "remove", null, preview.reviewedSelectionToken);
    expect(result).toMatchObject({ applied: false, requiresReview: true, transactionId: null });
    expect(storage.stashWrites).toBe(writesBeforeApply);
  });

  it("rolls back the entire stash list when persistence verification fails", async () => {
    installChromeStorage({ corruptFirstStashWrite: true });
    const source = stash("source", ["one", "two"]);
    const untouched = stash("untouched", ["safe"]);
    await writeTabStashes([source, untouched]);
    const before = await readTabStashes();
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = await previewStoredStashSearchEdit([ref], "remove");
    await expect(applyStoredStashSearchEdit([ref], "remove", null, preview.reviewedSelectionToken)).rejects.toThrow("could not be verified");
    expect(await readTabStashes()).toEqual(before);
    expect(await readStashSearchEditUndoPoint()).toBeNull();
  });

  it("refuses undo after an affected stash changes externally", async () => {
    installChromeStorage();
    const source = stash("source", ["one", "two"]);
    await writeTabStashes([source]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = await previewStoredStashSearchEdit([ref], "remove");
    const applied = await applyStoredStashSearchEdit([ref], "remove", null, preview.reviewedSelectionToken);
    const edited = (await readTabStashes())[0]!;
    const external = { ...edited, note: "changed later" };
    await writeTabStashes([external]);
    expect(await undoStoredStashSearchEdit(applied.transactionId!)).toEqual({
      undone: false,
      unavailableReason: "An affected workspace changed after this edit, so undo was not applied.",
    });
    expect(await readTabStashes()).toEqual([external]);
  });

  it("serializes overlapping applies so only the reviewed current state can commit", async () => {
    installChromeStorage();
    const source = stash("source", ["one", "two"]);
    await writeTabStashes([source]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = await previewStoredStashSearchEdit([ref], "remove");
    const results = await Promise.all([
      applyStoredStashSearchEdit([ref], "remove", null, preview.reviewedSelectionToken),
      applyStoredStashSearchEdit([ref], "remove", null, preview.reviewedSelectionToken),
    ]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(results.filter((result) => result.requiresReview)).toHaveLength(1);
    expect((await readTabStashes())[0]!.tabs.map((tab) => tab.title)).toEqual(["two"]);
  });

  it("rolls apply back when the session undo write is ignored", async () => {
    const storage = installChromeStorage();
    const source = stash("source", ["one"]);
    await writeTabStashes([source]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = await previewStoredStashSearchEdit([ref], "remove");
    storage.setIgnoreUndoWrites(true);
    await expect(applyStoredStashSearchEdit([ref], "remove", null, preview.reviewedSelectionToken)).rejects.toThrow("undo point");
    expect(await readTabStashes()).toEqual([source]);
  });

  it("rolls undo back when clearing its session record is ignored", async () => {
    const storage = installChromeStorage();
    const source = stash("source", ["one", "two"]);
    await writeTabStashes([source]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = await previewStoredStashSearchEdit([ref], "remove");
    const applied = await applyStoredStashSearchEdit([ref], "remove", null, preview.reviewedSelectionToken);
    const edited = await readTabStashes();
    storage.setIgnoreUndoClear(true);
    await expect(undoStoredStashSearchEdit(applied.transactionId!)).rejects.toThrow("could not be cleared");
    expect(await readTabStashes()).toEqual(edited);
    expect(await readStashSearchEditUndoPoint()).toMatchObject({ transactionId: applied.transactionId });
  });

  it("rolls back local changes when session verification reads fail", async () => {
    const storage = installChromeStorage();
    const source = stash("source", ["one"]);
    await writeTabStashes([source]);
    const ref = referenceForStashedTab(source, source.tabs[0]!);
    const preview = await previewStoredStashSearchEdit([ref], "remove");
    storage.failUndoGetAfter(2);
    await expect(applyStoredStashSearchEdit([ref], "remove", null, preview.reviewedSelectionToken)).rejects.toThrow("Injected session read failure");
    expect(await readTabStashes()).toEqual([source]);
  });

  it("rejects malformed, duplicate, empty, and oversized session undo records", async () => {
    const storage = installChromeStorage();
    const valid = stash("source", ["one"]);
    const cases = [
      { transactionId: "", operation: "remove", createdAt: 1, before: [valid], after: [valid] },
      { transactionId: "tx", operation: "remove", createdAt: Number.NaN, before: [valid], after: [valid] },
      { transactionId: "tx", operation: "remove", createdAt: 1, before: [], after: [] },
      { transactionId: "tx", operation: "remove", createdAt: 1, before: [valid, valid], after: [valid, valid] },
      { transactionId: "tx", operation: "remove", createdAt: 1, before: Array(51).fill(valid), after: Array(51).fill(valid) },
    ];
    for (const value of cases) {
      storage.values.workspaceSearchEditUndoPoint = value;
      expect(await readStashSearchEditUndoPoint()).toBeNull();
    }
  });
});
