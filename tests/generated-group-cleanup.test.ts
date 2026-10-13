import { afterEach, describe, expect, it, vi } from "vitest";
import type { SemanticWindowState } from "../src/shared/types";
import {
  normalizeGeneratedGroupCleanupSettings,
  readGeneratedGroupCleanupLastRun,
  readGeneratedGroupCleanupSettings,
  reconcileGeneratedGroups,
  recordGeneratedGroups,
  writeGeneratedGroupCleanupLastRun,
  writeGeneratedGroupCleanupSettings,
} from "../src/storage/generated-group-cleanup";

function storageArea(values: Record<string, unknown>) {
  return {
    get: vi.fn(async (keys: string | string[]) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map((key) => [key, values[key]]));
    }),
    set: vi.fn(async (next: Record<string, unknown>) => {
      Object.assign(values, structuredClone(next));
    }),
  };
}

function installStorage() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: storageArea(local),
      session: storageArea(session),
    },
  });
  return { local, session };
}

function state(options: {
  windowId?: number;
  groups?: Array<{ id: number; title: string; color?: "blue" | "red"; tabIds: number[] }>;
  urls?: Record<number, string>;
} = {}): SemanticWindowState {
  const windowId = options.windowId ?? 7;
  const groups = options.groups ?? [{ id: 10, title: "Research", tabIds: [1, 2] }];
  const urls = options.urls ?? { 1: "https://example.com/one", 2: "https://example.com/two" };
  const groupByTab = new Map(groups.flatMap((group) => group.tabIds.map((tabId) => [tabId, group.id])));
  const tabs = Object.entries(urls).map(([rawId, url], index) => {
    const id = Number(rawId);
    return {
      id,
      windowId,
      index,
      title: `Tab ${id}`,
      url,
      groupId: groupByTab.get(id) ?? -1,
      active: index === 0,
      pinned: false,
      audible: false,
      openerTabId: null,
      lastAccessed: 1,
      splitView: { known: true as const, value: -1 },
      protectionReasons: [],
    };
  });
  return {
    windowId,
    capturedAt: 1,
    tabs,
    groups: groups.map((group) => ({
      runtimeId: group.id,
      windowId,
      title: group.title,
      color: group.color ?? "blue",
      collapsed: false,
      shared: { known: true, value: false },
      memberTabIds: group.tabIds,
      firstTabIndex: Math.min(...group.tabIds.map((id) => tabs.find((tab) => tab.id === id)?.index ?? 0)),
      protectionReasons: [],
    })),
    eligibleTabIds: tabs.map((tab) => tab.id),
    protectedTabIds: [],
    featureSupport: {
      sharedGroupProperty: true,
      splitViewIdProperty: true,
      storageSession: true,
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("generated group cleanup storage", () => {
  it("normalizes supported retention periods and rejects unknown values", async () => {
    installStorage();
    expect(normalizeGeneratedGroupCleanupSettings({ autoUngroupAfterDays: 14 }))
      .toEqual({ autoUngroupAfterDays: 14 });
    expect(normalizeGeneratedGroupCleanupSettings({ autoUngroupAfterDays: 2 }))
      .toEqual({ autoUngroupAfterDays: null });
    await writeGeneratedGroupCleanupSettings({ autoUngroupAfterDays: 7 });
    expect(await readGeneratedGroupCleanupSettings()).toEqual({ autoUngroupAfterDays: 7 });
  });

  it("persists only hashed group identity and reconciles authoritative IDs in one browser session", async () => {
    const { local } = installStorage();
    const initial = state();
    await recordGeneratedGroups([initial], [{ groupId: 10, windowId: 7, transactionId: "tx-1" }], 100);
    expect(JSON.stringify(local)).not.toContain("Research");
    expect(JSON.stringify(local)).not.toContain("example.com");

    const changed = state({ groups: [{ id: 10, title: "Renamed", color: "red", tabIds: [1] }] });
    const reconciled = await reconcileGeneratedGroups([changed], [], 200);
    expect(reconciled.matches).toHaveLength(1);
    expect(reconciled.matches[0]?.record).toMatchObject({
      groupId: 10,
      windowId: 7,
      createdAt: 100,
      lastSeenAt: 200,
      transactionId: "tx-1",
    });
  });

  it("keeps both records when two recordings overlap", async () => {
    const { local } = installStorage();
    const both = state({
      groups: [
        { id: 10, title: "Research", tabIds: [1] },
        { id: 11, title: "Reading", tabIds: [2] },
      ],
    });
    await Promise.all([
      recordGeneratedGroups([both], [{ groupId: 10, windowId: 7 }], 100),
      recordGeneratedGroups([both], [{ groupId: 11, windowId: 7 }], 100),
    ]);
    const tracked = local.generatedGroupTracking as Array<{ groupId: number }>;
    expect(tracked.map((record) => record.groupId).sort()).toEqual([10, 11]);
  });

  it("relinks an exact unique identity after a browser restart", async () => {
    const { session } = installStorage();
    await recordGeneratedGroups([state()], [{ groupId: 10, windowId: 7 }], 100);
    Object.keys(session).forEach((key) => delete session[key]);
    const restored = state({
      windowId: 8,
      groups: [{ id: 44, title: "Research", tabIds: [21, 22] }],
      urls: { 21: "https://example.com/one", 22: "https://example.com/two" },
    });
    const reconciled = await reconcileGeneratedGroups([restored], [], 200);
    expect(reconciled.matches).toHaveLength(1);
    expect(reconciled.matches[0]?.record).toMatchObject({ groupId: 44, windowId: 8, createdAt: 100 });
  });

  it("does not guess when a restart leaves an identical generated/manual collision", async () => {
    const { session } = installStorage();
    await recordGeneratedGroups([state()], [{ groupId: 10, windowId: 7 }], 100);
    Object.keys(session).forEach((key) => delete session[key]);
    const ambiguous = state({
      groups: [
        { id: 20, title: "Research", tabIds: [3, 4] },
        { id: 21, title: "Research", tabIds: [5, 6] },
      ],
      urls: {
        3: "https://example.com/one",
        4: "https://example.com/two",
        5: "https://example.com/one",
        6: "https://example.com/two",
      },
    });
    const reconciled = await reconcileGeneratedGroups([ambiguous], [], 200);
    expect(reconciled.matches).toHaveLength(0);
    expect(reconciled.records).toHaveLength(1);
  });

  it("stores a privacy-safe summary of the last cleanup run", async () => {
    installStorage();
    await writeGeneratedGroupCleanupLastRun({
      mode: "manual",
      ranAt: 500,
      groupsUngrouped: 3,
      tabsKeptOpen: 12,
      groupsSkipped: 1,
    });
    expect(await readGeneratedGroupCleanupLastRun()).toEqual({
      mode: "manual",
      ranAt: 500,
      groupsUngrouped: 3,
      tabsKeptOpen: 12,
      groupsSkipped: 1,
    });
  });
});
