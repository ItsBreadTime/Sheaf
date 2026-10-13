import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTabStashPreview, savedStashFromPreview } from "../src/browser/tab-stashes";
import {
  clearTabStashQuarantine,
  pruneExpiredTabStashes,
  readTabStashTrash,
  tabStashExpiresAt,
  readTabStashQuarantine,
  readTabStashes,
  readTabStashSettings,
  updateTabStashes,
  updateTabStashesAndTrash,
  writeTabStashes,
  writeTabStashSettings,
  readLinkedStashWorkspaces,
  writeLinkedStashWorkspaces,
} from "../src/storage/stashes";
import type { SemanticWindowState } from "../src/shared/types";

afterEach(() => vi.unstubAllGlobals());

function state(): SemanticWindowState {
  const tab = (
    id: number,
    index: number,
    title: string,
    groupId: number,
    options: { audible?: boolean; reasons?: string[] } = {},
  ) => ({
    id,
    windowId: 7,
    index,
    title,
    url: `https://example.com/${id}`,
    groupId,
    active: id === 1,
    pinned: false,
    audible: options.audible ?? false,
    openerTabId: null,
    lastAccessed: 1,
    splitView: { known: true as const, value: -1 },
    protectionReasons: options.reasons ?? [],
  });
  return {
    windowId: 7,
    capturedAt: 1,
    tabs: [
      tab(1, 0, "Project one", 10),
      tab(2, 1, "Project two", 10),
      tab(3, 2, "Pinned reference", -1, { reasons: ["Pinned tab"] }),
      tab(4, 3, "Playing audio", -1, { audible: true }),
      tab(5, 4, "Loose tab", -1),
    ],
    groups: [{
      runtimeId: 10,
      windowId: 7,
      title: "Project",
      color: "blue",
      collapsed: true,
      shared: { known: true, value: false },
      memberTabIds: [1, 2],
      firstTabIndex: 0,
      protectionReasons: [],
    }],
    eligibleTabIds: [1, 2, 4, 5],
    protectedTabIds: [3],
    featureSupport: {
      sharedGroupProperty: true,
      splitViewIdProperty: true,
      storageSession: true,
    },
  };
}

function installChromeStorage(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    tabGroups: { TAB_GROUP_ID_NONE: -1 },
    storage: {
      local: {
        async get(key: string | string[]) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(
            keys.flatMap((item) => item in values ? [[item, structuredClone(values[item])]] : []),
          );
        },
        async set(items: Record<string, unknown>) {
          Object.assign(values, structuredClone(items));
        },
      },
      session: {
        async get(key: string) {
          const sessionKey = `session:${key}`;
          return sessionKey in values ? { [key]: structuredClone(values[sessionKey]) } : {};
        },
        async set(items: Record<string, unknown>) {
          Object.entries(items).forEach(([key, value]) => { values[`session:${key}`] = structuredClone(value); });
        },
        async remove(key: string) {
          delete values[`session:${key}`];
        },
      },
    },
  });
  return values;
}

describe("tab stashes", () => {
  it("previews one group with its native structure", () => {
    installChromeStorage();
    const preview = buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1);
    expect(preview.name).toBe("Project");
    expect(preview.tabs.map((tab) => tab.sourceTabId)).toEqual([1, 2]);
    expect(preview.groups).toEqual([expect.objectContaining({
      title: "Project",
      color: "blue",
      collapsed: true,
    })]);
    expect(preview.excludedTabs).toEqual([]);
  });

  it("previews a whole window while keeping protected and audible tabs open", () => {
    installChromeStorage();
    const preview = buildTabStashPreview(state(), { mode: "window" }, 1);
    expect(preview.tabs.map((tab) => tab.sourceTabId)).toEqual([1, 2, 5]);
    expect(preview.tabs.find((tab) => tab.sourceTabId === 5)?.groupKey).toBeNull();
    expect(preview.excludedTabs).toEqual([
      expect.objectContaining({ sourceTabId: 3, reasons: ["Pinned tab"] }),
      expect.objectContaining({ sourceTabId: 4, reasons: ["Audible tab"] }),
    ]);
  });

  it("previews an explicit cleanup selection", () => {
    installChromeStorage();
    const preview = buildTabStashPreview(
      state(),
      { mode: "selection", tabIds: [2, 3] },
      1,
    );
    expect(preview.name).toMatch(/^Cleanup/);
    expect(preview.tabs.map((tab) => tab.sourceTabId)).toEqual([2]);
    expect(preview.excludedTabs.map((tab) => tab.sourceTabId)).toEqual([3]);
  });

  it("persists full URLs locally and quarantines corrupt stash data", async () => {
    const values = installChromeStorage();
    const preview = buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1);
    const saved = savedStashFromPreview(preview, 2);
    await writeTabStashes([saved]);
    expect((await readTabStashes())[0]?.tabs[0]?.url).toBe("https://example.com/1");
    expect((await readTabStashes())[0]).toMatchObject({ updatedAt: 2, note: "", revisions: [], activeWorkspaceId: null });

    values.workspaces = [{ id: "bad" }, saved];
    expect((await readTabStashes()).map((stash) => stash.id)).toEqual([saved.id]);
    expect(values.workspaces).toEqual([expect.objectContaining({ id: saved.id })]);
    expect(await readTabStashQuarantine()).toEqual([{ quarantinedAt: expect.any(Number), value: { id: "bad" } }]);

    values.workspaces = "not-a-list";
    expect(await readTabStashes()).toEqual([]);
    expect((await readTabStashQuarantine()).map((entry) => entry.value)).toEqual([{ id: "bad" }, "not-a-list"]);
    await clearTabStashQuarantine();
    expect(await readTabStashQuarantine()).toEqual([]);
  });

  it("keeps an unreadable quarantine instead of overwriting it", async () => {
    const values = installChromeStorage();
    values.workspaceQuarantine = "opaque";
    values.workspaces = [{ id: "bad" }];
    await readTabStashes();
    expect((await readTabStashQuarantine()).map((entry) => entry.value)).toEqual(["opaque", { id: "bad" }]);
  });

  it("quarantines corrupt records when retention settings are saved", async () => {
    const values = installChromeStorage();
    const saved = savedStashFromPreview(buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1), 2);
    values.workspaces = [saved, { id: "bad" }];
    const written = await writeTabStashSettings({ autoDeleteAfterDays: null });
    expect(written.stashes.map((stash) => stash.id)).toEqual([saved.id]);
    expect((await readTabStashQuarantine()).map((entry) => entry.value)).toEqual([{ id: "bad" }]);
  });

  it("marks local-only semantic stash mutations in the same storage write", async () => {
    const values = installChromeStorage();
    const saved = savedStashFromPreview(buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1), 2);
    await writeTabStashes([saved], { semanticMutation: "local_only" });
    expect(values.workspaces).toEqual([saved]);
    expect(values.workspaceSemanticMutation).toMatchObject({ mode: "local_only", nonce: expect.any(String) });
  });

  it("quarantines malformed revision records instead of trusting shallow arrays", async () => {
    const values = installChromeStorage();
    const saved = savedStashFromPreview(buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1), 2);
    values.workspaces = [{ ...saved, revisions: [{ id: "broken" }] }];
    expect(await readTabStashes()).toEqual([]);
    expect(await readTabStashQuarantine()).toHaveLength(1);
  });

  it("quarantines malformed restore reports before the UI can dereference them", async () => {
    const values = installChromeStorage();
    const saved = savedStashFromPreview(buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1), 2);
    values.workspaces = [{ ...saved, restoreResult: { conflicts: "not-an-array" } }];
    expect(await readTabStashes()).toEqual([]);
    expect(await readTabStashQuarantine()).toHaveLength(1);
  });

  it("persists linked workspace ownership separately from immutable stash snapshots", async () => {
    installChromeStorage();
    const workspace = {
      id: "workspace-1",
      stashId: "stash-1",
      windowId: 9,
      mode: "whole_window" as const,
      trackedTabIds: [3, 4],
      startedAt: 10,
      updatedAt: 10,
    };
    await writeLinkedStashWorkspaces([workspace]);
    expect(await readLinkedStashWorkspaces()).toEqual([workspace]);
  });

  it("keeps stashes until optional age-based auto-delete removes them", async () => {
    installChromeStorage();
    const preview = buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1);
    const now = Date.now();
    const recent = savedStashFromPreview(preview, now - 24 * 60 * 60_000);
    const old = {
      ...savedStashFromPreview(preview, now - 31 * 24 * 60 * 60_000),
      id: "old-stash",
    };
    await writeTabStashes([recent, old]);

    const written = await writeTabStashSettings({ autoDeleteAfterDays: 30 });
    expect(written.stashes.map((stash) => stash.id)).toEqual([recent.id]);
    expect(await readTabStashSettings()).toEqual({ autoDeleteAfterDays: 30 });
    expect(pruneExpiredTabStashes([recent, old], { autoDeleteAfterDays: null }, now)).toHaveLength(2);
  });

  it("never auto-deletes a stash while its linked workspace is active", () => {
    installChromeStorage();
    const preview = buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1);
    const oldActive = {
      ...savedStashFromPreview(preview, 1),
      activeWorkspaceId: "workspace-1",
    };
    expect(pruneExpiredTabStashes([oldActive], { autoDeleteAfterDays: 1 }, Date.now())).toEqual([oldActive]);
  });

  it("counts expiry from the last open or change, not from creation", () => {
    installChromeStorage();
    const preview = buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1);
    const day = 24 * 60 * 60_000;
    const now = 100 * day;
    const reopened = { ...savedStashFromPreview(preview, 0), lastOpenedAt: 95 * day };
    expect(tabStashExpiresAt(reopened, { autoDeleteAfterDays: 7 })).toBe(102 * day);
    expect(pruneExpiredTabStashes([reopened], { autoDeleteAfterDays: 7 }, now)).toEqual([reopened]);
    expect(pruneExpiredTabStashes([reopened], { autoDeleteAfterDays: 1 }, now)).toEqual([]);
    expect(tabStashExpiresAt(reopened, { autoDeleteAfterDays: null })).toBeNull();
  });

  it("moves expired stashes to the trash and purges the trash after seven days", async () => {
    const values = installChromeStorage();
    const preview = buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1);
    const day = 24 * 60 * 60_000;
    const old = { ...savedStashFromPreview(preview, Date.now() - 40 * day), id: "old" };
    const stale = { ...savedStashFromPreview(preview, 1), id: "stale-trash" };
    values.workspaceSettings = { autoDeleteAfterDays: 30 };
    values.workspaces = [old];
    values.workspaceTrash = [{ stash: stale, trashedAt: Date.now() - 8 * day, reason: "deleted" }];
    expect(await readTabStashes()).toEqual([]);
    expect((await readTabStashTrash()).map((entry) => [entry.stash.id, entry.reason])).toEqual([["old", "expired"]]);
  });

  it("upgrades lastOpenedAt from an older restore report", async () => {
    const values = installChromeStorage();
    const saved = savedStashFromPreview(buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1), 2);
    const legacy: Record<string, unknown> = {
      ...saved,
      restoreResult: { restoredAt: 5, openedTabs: 1, restoredGroups: 0, conflicts: [] },
    };
    delete legacy.lastOpenedAt;
    values.workspaces = [legacy];
    expect((await readTabStashes())[0]!.lastOpenedAt).toBe(5);
  });

  it("keeps a workspace saved while another save is still in flight", async () => {
    const values = installChromeStorage();
    const preview = buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1);
    const first = savedStashFromPreview(preview, 2);
    const second = savedStashFromPreview(preview, 3);
    await Promise.all([
      updateTabStashes((current) => [first, ...current]),
      updateTabStashes((current) => [second, ...current]),
    ]);
    expect((values.workspaces as Array<{ id: string }>).map((stash) => stash.id).sort())
      .toEqual([first.id, second.id].sort());
  });

  it("leaves the list untouched when an update throws", async () => {
    const values = installChromeStorage();
    const saved = savedStashFromPreview(buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1), Date.now());
    await writeTabStashes([saved]);
    await expect(updateTabStashesAndTrash(() => { throw new Error("gone"); })).rejects.toThrow("gone");
    await expect(updateTabStashes((current) => [...current, saved, saved].concat(Array(60).fill(saved))))
      .rejects.toThrow(/at most|already have/);
    expect((values.workspaces as Array<{ id: string }>).map((stash) => stash.id)).toEqual([saved.id]);
  });

  it("moves storage from the stash-era keys once, without overwriting newer data", async () => {
    vi.resetModules();
    const values = installChromeStorage();
    const storage = (globalThis as unknown as { chrome: { storage: { local: Record<string, unknown> } } }).chrome.storage.local;
    storage.remove = async (keys: string[]) => { keys.forEach((key) => { delete values[key]; }); };
    const saved = savedStashFromPreview(buildTabStashPreview(state(), { mode: "group", groupId: 10 }, 1), Date.now());
    values.tabStashes = [saved];
    values.tabStashSettings = { autoDeleteAfterDays: 7 };
    values.workspaceSettings = { autoDeleteAfterDays: 90 };
    const fresh = await import("../src/storage/stashes");
    expect((await fresh.readTabStashes()).map((stash) => stash.id)).toEqual([saved.id]);
    expect(await fresh.readTabStashSettings()).toEqual({ autoDeleteAfterDays: 90 });
    expect(values.tabStashes).toBeUndefined();
    expect(values.tabStashSettings).toBeUndefined();
    expect(values.workspaces).toEqual([expect.objectContaining({ id: saved.id })]);
  });
});
