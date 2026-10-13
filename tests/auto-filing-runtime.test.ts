import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoFilingTabCreated,
  autoFilingWindowRemoved,
  installAutoFiling,
  resetAutoFilingRuntimeForTests,
  undoAutoFiling,
} from "../src/background/auto-filing-runtime";
import { readAutoFilingView, writeAutoFilingSettings } from "../src/storage/auto-filing";
import { writeOrganizerRules } from "../src/storage/organizer-state";
import { DEFAULT_AUTO_FILING_SETTINGS } from "../src/shared/auto-filing-types";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";

const WINDOW_ID = 1;
const UNGROUPED = -1;
const TARGET_GROUP_ID = 20;
const SETTLE_MS = 1_500;

interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  groupId: number;
}

interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
}

interface ChromeHarness {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  tabs: Map<number, FakeTab>;
  groups: Map<number, FakeGroup>;
}

function tab(id: number, url: string, title: string, groupId = UNGROUPED): FakeTab {
  return { id, windowId: WINDOW_ID, index: id, url, title, groupId };
}

function windowStateFor(harness: ChromeHarness, windowId: number): SemanticWindowState {
  const tabs = [...harness.tabs.values()].filter((item) => item.windowId === windowId);
  const groups = [...harness.groups.values()].filter((group) => group.windowId === windowId);
  return {
    windowId,
    capturedAt: 0,
    tabs: tabs.map((item): SemanticTab => ({
      id: item.id,
      windowId: item.windowId,
      index: item.index,
      title: item.title,
      url: item.url,
      groupId: item.groupId,
      active: false,
      pinned: false,
      audible: false,
      openerTabId: null,
      lastAccessed: null,
      splitView: { known: true, value: -1 },
      protectionReasons: [],
    })),
    groups: groups.map((group): SemanticGroup => ({
      runtimeId: group.id,
      windowId: group.windowId,
      title: group.title,
      color: "blue",
      collapsed: false,
      shared: { known: true, value: false },
      memberTabIds: tabs.filter((item) => item.groupId === group.id).map((item) => item.id),
      firstTabIndex: -1,
      protectionReasons: [],
    })),
    eligibleTabIds: tabs.map((item) => item.id),
    protectedTabIds: [],
    featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true },
  };
}

function storageArea(store: Record<string, unknown>) {
  return {
    get: vi.fn(async (keys: string | string[] | null | undefined) => {
      if (keys === null || keys === undefined) return { ...store };
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]]));
    }),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, structuredClone(values)); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }),
  };
}

/**
 * A chrome surface with real tab/group state, so the apply path moves an actual
 * tab and the undo path has something to move back. Only the APIs the runtime
 * touches are provided; anything else is a bug in the runtime, not the harness.
 */
function installChrome(seedTabs: readonly FakeTab[]): ChromeHarness {
  const harness: ChromeHarness = {
    local: {},
    session: {},
    tabs: new Map(seedTabs.map((item) => [item.id, { ...item }])),
    groups: new Map([[TARGET_GROUP_ID, { id: TARGET_GROUP_ID, windowId: WINDOW_ID, title: "Lisbon Trip" }]]),
  };
  const tabs = harness.tabs;
  const groups = harness.groups;
  vi.stubGlobal("chrome", {
    storage: {
      local: storageArea(harness.local),
      session: storageArea(harness.session),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      async get(tabId: number) {
        const found = tabs.get(tabId);
        if (!found) throw new Error("No tab with id");
        return { ...found };
      },
      async query(query: chrome.tabs.QueryInfo = {}) {
        return [...tabs.values()].filter((item) =>
          (query.windowId === undefined || item.windowId === query.windowId) &&
          (query.groupId === undefined || item.groupId === query.groupId));
      },
      async group(options: { tabIds: number[]; groupId?: number }) {
        for (const tabId of options.tabIds) {
          const found = tabs.get(tabId);
          if (found && options.groupId !== undefined) found.groupId = options.groupId;
        }
      },
      async ungroup(tabId: number) {
        const found = tabs.get(tabId);
        if (found) found.groupId = UNGROUPED;
      },
      async move(tabId: number, options: { windowId?: number; index?: number }) {
        const found = tabs.get(tabId);
        if (found && options.windowId !== undefined) found.windowId = options.windowId;
      },
    },
    tabGroups: {
      async get(groupId: number) {
        const found = groups.get(groupId);
        if (!found) throw new Error("No group with id");
        return { ...found };
      },
      async query(query: chrome.tabGroups.QueryInfo = {}) {
        return [...groups.values()].filter((group) =>
          query.windowId === undefined || group.windowId === query.windowId);
      },
    },
    windows: {
      async getAll() {
        return [{ id: WINDOW_ID, incognito: false, type: "normal" }];
      },
      async get(windowId: number) {
        if (windowId !== WINDOW_ID) throw new Error("No window with id");
        return { id: windowId };
      },
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    notifications: { create: vi.fn(async () => "id") },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  });
  return harness;
}

/** The host the service worker installs, with every side effect under test control. */
function installHost(harness: ChromeHarness): void {
  installAutoFiling({
    async readWindow(windowId) { return windowStateFor(harness, windowId); },
    async isBusy() { return false; },
    async runMutation(task) { return await task(); },
    async linkedWorkspaceWindowIds() { return new Set<number>(); },
    async reviewOpen() { return false; },
    async startOrganize() { return true; },
    async reportError() {},
  });
}

/** Auto-filing on, with one rule that files the site into the seeded group. */
async function seedEnabledFiling(maxFilingsPerWindowPerMinute: number): Promise<void> {
  await writeAutoFilingSettings({
    ...DEFAULT_AUTO_FILING_SETTINGS,
    enabled: true,
    escalation: "off",
    maxFilingsPerWindowPerMinute,
  });
  await writeOrganizerRules([
    { id: "rule-1", kind: "assign_location", locationPattern: "pasteisdebelem.pt/*", groupName: "Lisbon Trip" },
  ]);
}

async function settleBatch(advanceMs = SETTLE_MS + 100): Promise<void> {
  await vi.advanceTimersByTimeAsync(advanceMs);
}

beforeEach(() => {
  resetAutoFilingRuntimeForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
});

afterEach(() => {
  resetAutoFilingRuntimeForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("auto-filing runtime", () => {
  it("files a tab by rule, records it, and puts it back on undo", async () => {
    const harness = installChrome([tab(4, "https://pasteisdebelem.pt/", "Pastéis de Belém opening hours")]);
    installHost(harness);
    await seedEnabledFiling(6);

    autoFilingTabCreated({ ...harness.tabs.get(4)!, id: 4 } as chrome.tabs.Tab);
    await settleBatch();

    expect(harness.tabs.get(4)?.groupId).toBe(TARGET_GROUP_ID);
    const view = await readAutoFilingView();
    expect(view.log).toHaveLength(1);
    expect(view.log[0]).toMatchObject({ tabId: 4, toGroupId: TARGET_GROUP_ID, source: "rule" });

    const undone = await undoAutoFiling();
    expect(undone.restored).toBe(true);
    expect(harness.tabs.get(4)?.groupId).toBe(UNGROUPED);
  });

  it("defers the filings the per-minute cap blocks instead of dropping them", async () => {
    const harness = installChrome([
      tab(4, "https://pasteisdebelem.pt/menu", "Menu"),
      tab(5, "https://pasteisdebelem.pt/history", "History"),
    ]);
    installHost(harness);
    await seedEnabledFiling(1);

    autoFilingTabCreated({ ...harness.tabs.get(4)!, id: 4 } as chrome.tabs.Tab);
    autoFilingTabCreated({ ...harness.tabs.get(5)!, id: 5 } as chrome.tabs.Tab);
    await settleBatch();

    // One filing fits the cap; the other is held, not lost.
    expect(harness.tabs.get(4)?.groupId).toBe(TARGET_GROUP_ID);
    expect(harness.tabs.get(5)?.groupId).toBe(UNGROUPED);
    expect((await readAutoFilingView()).log).toHaveLength(1);

    // The deferred tab is asked again once the minute has passed.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(harness.tabs.get(5)?.groupId).toBe(TARGET_GROUP_ID);
    expect((await readAutoFilingView()).log).toHaveLength(2);
  });

  it("keeps the rate window across a worker restart", async () => {
    const harness = installChrome([tab(4, "https://pasteisdebelem.pt/menu", "Menu")]);
    installHost(harness);
    await seedEnabledFiling(1);

    autoFilingTabCreated({ ...harness.tabs.get(4)!, id: 4 } as chrome.tabs.Tab);
    await settleBatch();
    expect(harness.tabs.get(4)?.groupId).toBe(TARGET_GROUP_ID);
    // The window is written to session storage, which outlives the worker.
    await vi.advanceTimersByTimeAsync(600);
    expect(harness.session.autoFilingRecentFilings).toBeDefined();

    resetAutoFilingRuntimeForTests();
    installHost(harness);
    harness.tabs.set(6, tab(6, "https://pasteisdebelem.pt/tickets", "Tickets"));

    autoFilingTabCreated({ ...harness.tabs.get(6)!, id: 6 } as chrome.tabs.Tab);
    await settleBatch();

    expect(harness.tabs.get(6)?.groupId).toBe(UNGROUPED);
    expect((await readAutoFilingView()).log).toHaveLength(1);
  });

  it("drops only the removed window's filings when the worker had not loaded them", async () => {
    const harness = installChrome([tab(4, "https://pasteisdebelem.pt/menu", "Menu")]);
    installHost(harness);
    // A cold worker: the window it is told about is only in session storage.
    const now = Date.now();
    harness.session.autoFilingRecentFilings = { 1: [now], 2: [now] };

    autoFilingWindowRemoved(2);
    await vi.advanceTimersByTimeAsync(600);

    expect(harness.session.autoFilingRecentFilings).toEqual({ 1: [now] });
  });
});
