import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyUserProtections,
  protectionLocation,
  protectionPatternForUrl,
} from "../src/browser/user-protection";
import {
  normalizeProtectionRules,
  readUserProtectionState,
  writePermanentProtectionRules,
  writeSessionProtections,
} from "../src/storage/protection";
import type { SemanticWindowState } from "../src/shared/types";

function state(): SemanticWindowState {
  return {
    windowId: 7,
    capturedAt: 1,
    tabs: [
      { id: 1, windowId: 7, index: 0, title: "Docs", url: "https://docs.example.com/guide?q=private#part", groupId: 10, active: true, pinned: false, audible: false, openerTabId: null, lastAccessed: null, splitView: { known: true, value: -1 }, protectionReasons: [] },
      { id: 2, windowId: 7, index: 1, title: "Work", url: "https://work.example.org/app", groupId: 10, active: false, pinned: false, audible: false, openerTabId: null, lastAccessed: null, splitView: { known: true, value: -1 }, protectionReasons: [] },
      { id: 3, windowId: 7, index: 2, title: "Other", url: "https://other.example.net/", groupId: -1, active: false, pinned: false, audible: false, openerTabId: null, lastAccessed: null, splitView: { known: true, value: -1 }, protectionReasons: [] },
    ],
    groups: [{ runtimeId: 10, windowId: 7, title: "Project", color: "blue", collapsed: false, shared: { known: true, value: false }, memberTabIds: [1, 2], firstTabIndex: 0, protectionReasons: [] }],
    eligibleTabIds: [1, 2, 3],
    protectedTabIds: [],
    featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true },
  };
}

beforeEach(() => vi.unstubAllGlobals());

describe("semantic user protection locks", () => {
  it("removes queries/fragments from permanent local patterns", () => {
    expect(protectionLocation("https://docs.example.com/guide?q=secret#part")).toBe("docs.example.com/guide");
    expect(protectionPatternForUrl("chrome://settings/privacy")).toBe("chrome://settings/privacy");
  });

  it("cascades session group locks and permanent rules into named tab reasons", () => {
    const protectedState = applyUserProtections(
      state(),
      { tabIds: [3], groupIds: [10] },
      [
        { id: "location", kind: "location", pattern: "docs.example.com/*", createdAt: 1 },
        { id: "group", kind: "group_title", pattern: "project", createdAt: 1 },
      ],
    );

    expect(protectedState.eligibleTabIds).toEqual([]);
    expect(protectedState.protectedTabIds).toEqual([1, 2, 3]);
    expect(protectedState.tabs[0]?.protectionReasons).toEqual(expect.arrayContaining([
      "Permanent location rule",
      "User locked until browser restart",
      "Permanent group-name rule",
    ]));
    expect(protectedState.tabs[2]?.protectionReasons).toContain("User protected until browser restart");
  });

  it("keeps a protected tab's protection to that tab, not its whole group", () => {
    // Intended (C13): flowing one tab's protection to its group would freeze
    // organizing for every other tab in that group.
    const protectedState = applyUserProtections(state(), { tabIds: [1], groupIds: [] }, []);

    expect(protectedState.protectedTabIds).toEqual([1]);
    expect(protectedState.eligibleTabIds).toEqual([2, 3]);
    expect(protectedState.groups[0]?.protectionReasons).toEqual([]);
  });
});

describe("user protection storage", () => {
  it("normalizes permanent rules and keeps restart-only locks in session storage", async () => {
    const local: Record<string, unknown> = {};
    const session: Record<string, unknown> = {};
    const area = (values: Record<string, unknown>) => ({
      async get(key: string) { return key in values ? { [key]: structuredClone(values[key]) } : {}; },
      async set(items: Record<string, unknown>) { Object.assign(values, structuredClone(items)); },
    });
    vi.stubGlobal("chrome", { storage: { local: area(local), session: area(session) } });

    await writePermanentProtectionRules([
      { id: "one", kind: "location", pattern: " Docs.Example.com/* ", createdAt: 1 },
    ]);
    await writeSessionProtections({ tabIds: [3, 3], groupIds: [10] });
    expect(await readUserProtectionState()).toEqual({
      permanentRules: [{ id: "one", kind: "location", pattern: "docs.example.com/*", createdAt: 1 }],
      session: { tabIds: [3], groupIds: [10] },
    });
    expect(normalizeProtectionRules([{ id: "bad", kind: "unknown", pattern: "*" }])).toEqual([]);
  });
});
