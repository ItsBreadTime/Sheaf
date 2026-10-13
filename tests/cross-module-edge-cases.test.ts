import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeOrganizationScope,
  organizationScopeLabel,
  tabIsInOrganizationScope,
  validateOrganizationScope,
  WHOLE_WINDOW_SCOPE,
} from "../src/organizer/scope";
import { estimateUsageCost } from "../src/diagnostics/events";
import { sanitizeTabTitle, redactSensitiveIdentifiers } from "../src/privacy/sanitize-text";
import { describeOrganizerRule, sanitizedTabLocation } from "../src/organizer/rules";
import { normalizeSessionProtections } from "../src/storage/protection";
import { profileOwnedTaskKeys, usesQwen3EmbeddingProfile } from "../src/search/model-profiles";
import {
  appendCountsOnlyHistory,
  readUndoPoint,
  updateLatestHistoryUndoStatus,
  writeUndoPoint,
} from "../src/storage/organization-history";
import {
  compareSemanticStates,
} from "../src/browser/semantic-compare";
import { executeConflictAwareUndo } from "../src/browser/undo";
import { readBodyWithLimit } from "../src/provider/openai-chat-completions";
import { captureLinkedWorkspace, stashWorkspaceCaptureToken } from "../src/browser/stash-workspaces";
import { groupManagerFingerprint } from "../src/browser/group-manager";
import {
  normalizeGeneratedGroupCleanupRun,
  normalizeGeneratedGroupCleanupSettings,
  normalizeGeneratedGroupTracking,
} from "../src/storage/generated-group-cleanup";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";
import type { OrganizationHistoryReport, UndoPoint, UndoStatus } from "../src/shared/transaction-types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function tab(overrides: Partial<SemanticTab> & { id: number; index: number }): SemanticTab {
  return {
    windowId: 7,
    title: `Tab ${overrides.id}`,
    url: `https://example.com/${overrides.id}`,
    groupId: -1,
    active: false,
    pinned: false,
    audible: false,
    openerTabId: null,
    lastAccessed: null,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
    ...overrides,
  };
}

function windowState(overrides: Partial<SemanticWindowState> = {}): SemanticWindowState {
  return {
    windowId: 7,
    capturedAt: 1,
    tabs: [tab({ id: 1, index: 0 }), tab({ id: 2, index: 1 })],
    groups: [],
    eligibleTabIds: [1, 2],
    protectedTabIds: [],
    featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true },
    ...overrides,
  };
}

function installStorage(initial: Record<string, unknown> = {}) {
  const local = new Map<string, unknown>(Object.entries(initial));
  const session = new Map<string, unknown>();
  const api = {
    local: {
      get: vi.fn(async (key: string) => (local.has(key) ? { [key]: local.get(key) } : {})),
      set: vi.fn(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) local.set(key, value);
      }),
      remove: vi.fn(async (key: string) => { local.delete(key); }),
    },
    session: {
      get: vi.fn(async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {})),
      set: vi.fn(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) session.set(key, value);
      }),
      remove: vi.fn(async (key: string) => { session.delete(key); }),
    },
  };
  vi.stubGlobal("chrome", { storage: api });
  return { local, session };
}

describe("Edge cases: organizer scope", () => {
  const state = windowState({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, groupId: 42 }),
      tab({ id: 3, index: 2, highlighted: true }),
    ],
    groups: [
      { runtimeId: 42, windowId: 7, title: "  ", color: "blue", collapsed: false, shared: { known: true, value: false }, memberTabIds: [2], firstTabIndex: 1, protectionReasons: [] },
      { runtimeId: 43, windowId: 7, title: "Named", color: "red", collapsed: false, shared: { known: true, value: false }, memberTabIds: [], firstTabIndex: -1, protectionReasons: [] },
    ],
  });

  it("normalizes a stale group scope to the first group, then to the whole window", () => {
    expect(normalizeOrganizationScope(state, { mode: "group", groupId: 999 })).toEqual({ mode: "group", groupId: 42 });
    const noGroups = windowState({ groups: [] });
    expect(normalizeOrganizationScope(noGroups, { mode: "group", groupId: 999 })).toEqual(WHOLE_WINDOW_SCOPE);
  });

  it("dedupes and filters exclude_groups ids, and passes other modes through", () => {
    expect(normalizeOrganizationScope(state, { mode: "exclude_groups", groupIds: [42, 42, 999, 43] }))
      .toEqual({ mode: "exclude_groups", groupIds: [42, 43] });
    expect(normalizeOrganizationScope(state, { mode: "window" })).toEqual({ mode: "window" });
    expect(normalizeOrganizationScope(state, { mode: "selected_tabs" })).toEqual({ mode: "selected_tabs" });
  });

  it("classifies tabs for every scope mode", () => {
    const [plain, grouped, highlighted] = state.tabs;
    expect(tabIsInOrganizationScope(plain!, { mode: "window" })).toBe(true);
    expect(tabIsInOrganizationScope(highlighted!, { mode: "selected_tabs" })).toBe(true);
    expect(tabIsInOrganizationScope(plain!, { mode: "selected_tabs" })).toBe(false);
    expect(tabIsInOrganizationScope(grouped!, { mode: "group", groupId: 42 })).toBe(true);
    expect(tabIsInOrganizationScope(plain!, { mode: "group", groupId: 42 })).toBe(false);
    expect(tabIsInOrganizationScope(plain!, { mode: "ungrouped" })).toBe(true);
    expect(tabIsInOrganizationScope(grouped!, { mode: "ungrouped" })).toBe(false);
    expect(tabIsInOrganizationScope(grouped!, { mode: "exclude_groups", groupIds: [42] })).toBe(false);
    expect(tabIsInOrganizationScope(plain!, { mode: "exclude_groups", groupIds: [42] })).toBe(true);
  });

  it("rejects unavailable scopes and empty selections with specific copy", () => {
    expect(() => validateOrganizationScope(state, { mode: "group", groupId: 999 }))
      .toThrow("The selected tab group is no longer available.");
    expect(() => validateOrganizationScope(state, { mode: "exclude_groups", groupIds: [] }))
      .toThrow("Choose at least one group to leave unchanged.");
    expect(() => validateOrganizationScope(windowState({ tabs: [tab({ id: 1, index: 0 })] }), { mode: "selected_tabs" }))
      .toThrow("No highlighted tabs are available. Select tabs in the tab strip first.");
    const onlyGroups = windowState({
      tabs: [tab({ id: 2, index: 0, groupId: 42 })],
      groups: [{ runtimeId: 42, windowId: 7, title: "G", color: "blue", collapsed: false, shared: { known: true, value: false }, memberTabIds: [2], firstTabIndex: 0, protectionReasons: [] }],
    });
    expect(() => validateOrganizationScope(onlyGroups, { mode: "ungrouped" }))
      .toThrow("The selected scope contains no tabs.");
    expect(() => validateOrganizationScope(state, { mode: "window" })).not.toThrow();
  });

  it("labels every scope mode", () => {
    expect(organizationScopeLabel(state, { mode: "window" })).toBe("Current window");
    expect(organizationScopeLabel(state, { mode: "selected_tabs" })).toBe("1 selected tab");
    expect(organizationScopeLabel(state, { mode: "group", groupId: 43 })).toBe("Group: Named");
    expect(organizationScopeLabel(state, { mode: "group", groupId: 42 })).toBe("Group: Untitled group");
    expect(organizationScopeLabel(state, { mode: "ungrouped" })).toBe("Ungrouped tabs");
    expect(organizationScopeLabel(state, { mode: "exclude_groups", groupIds: [42] })).toBe("Window except 1 group");
    expect(organizationScopeLabel(state, { mode: "exclude_groups", groupIds: [42, 43] })).toBe("Window except 2 groups");
  });
});

describe("Edge cases: privacy text", () => {
  it("falls back to a placeholder for empty titles and strips control characters", () => {
    expect(sanitizeTabTitle("   ")).toBe("Untitled tab");
    expect(sanitizeTabTitle("A\u0000B\u200fC")).toBe("A BC");
  });

  it("redacts emails, uuids, long numbers and opaque tokens but leaves slugs", () => {
    expect(redactSensitiveIdentifiers("mail me at a.b+tag@example.co.uk now")).toBe("mail me at :email now");
    expect(redactSensitiveIdentifiers("id 123e4567-e89b-42d3-a456-426614174000"))
      .toBe("id :uuid");
    expect(redactSensitiveIdentifiers("order 1234567")).toBe("order :number");
    expect(redactSensitiveIdentifiers("token abc123def456ghi789")).toBe("token :token");
    expect(redactSensitiveIdentifiers("slug my-long-readable-slug")).toBe("slug my-long-readable-slug");
  });
});

describe("Edge cases: rules and locations", () => {
  it("derives the sanitized location and describes every rule kind", () => {
    expect(sanitizedTabLocation({ domain: "example.com", hostname: "WWW.Example.com", path: "/Docs" }))
      .toBe("www.example.com/docs");
    expect(sanitizedTabLocation({ domain: "example.com", hostname: undefined, path: undefined })).toBe("example.com/*");
    expect(describeOrganizerRule({ id: "a", kind: "assign_location", locationPattern: "x.com/*", groupName: "Docs" }))
      .toBe("x.com/* → Docs");
    expect(describeOrganizerRule({ id: "b", kind: "keep_location", locationPattern: "x.com/*" }))
      .toBe("Never move x.com/*");
    expect(describeOrganizerRule({ id: "c", kind: "rename_group", fromName: "Old", toName: "New" }))
      .toBe("Prefer “New” over “Old”");
    expect(describeOrganizerRule({ id: "d", kind: "never_clutter_location", locationPattern: "mail.example.com/*" }))
      .toBe("Never flag mail.example.com/* as clutter");
  });
});

describe("Edge cases: session protection normalization", () => {
  it("keeps only safe non-negative integer ids, deduped", () => {
    expect(normalizeSessionProtections({ tabIds: [3, 3, -1, 4.5, "9", 2], groupIds: null }))
      .toEqual({ tabIds: [3, 2], groupIds: [] });
    expect(normalizeSessionProtections("junk")).toEqual({ tabIds: [], groupIds: [] });
  });
});

describe("Edge cases: embedding profiles", () => {
  it("recognizes qwen3 models and reports task keys only for task-field profiles", () => {
    expect(usesQwen3EmbeddingProfile("alibaba/qwen3-embedding-8b")).toBe(true);
    expect(usesQwen3EmbeddingProfile("text-embedding-3-small")).toBe(false);
    // qwen3 steers through the query prefix, so it owns no task-field keys.
    expect(profileOwnedTaskKeys("alibaba/qwen3-embedding-8b", "auto")).toEqual([]);
    expect(profileOwnedTaskKeys("text-embedding-3-small", "auto")).toEqual([]);
    expect(profileOwnedTaskKeys("embed-multilingual-v3.0", "auto")).toEqual(["input_type"]);
    expect(profileOwnedTaskKeys("anything", "gemini")).toEqual(["tasktype"]);
  });
});

describe("Edge cases: diagnostics cost estimate", () => {
  it("estimates cost only when token counts are known", () => {
    expect(estimateUsageCost({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 0 }, 2, 8)).toBe(2);
    expect(estimateUsageCost({ promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000, cachedTokens: 0 }, 2, 8)).toBe(10);
    expect(estimateUsageCost({ promptTokens: null, completionTokens: 5, totalTokens: null, cachedTokens: 0 }, 2, 8)).toBeNull();
    expect(estimateUsageCost(null, 2, 8)).toBeNull();
  });
});

describe("Edge cases: counts-only history and undo point", () => {
  const report = (undoStatus: UndoStatus): OrganizationHistoryReport => ({
    timestamp: Date.now(),
    providerType: "openai_compatible",
    providerOrigin: "https://api.example.com",
    model: "m",
    tabsSubmitted: 5,
    tabsChanged: 1,
    tabsMoved: 1,
    groupsCreated: 1,
    scopeMode: "window",
    resultStatus: "completed",
    rollbackStatus: "not_needed",
    undoStatus,
  });

  it("round-trips the undo point and clears it on null", async () => {
    const { session } = installStorage();
    expect(await readUndoPoint()).toBeNull();
    const emptyState = { windowId: 7, tabs: [], groups: [] };
    const point = {
      transactionId: "tx-1",
      targetWindowId: 7,
      before: emptyState,
      expectedAfter: emptyState,
      touchedTabIds: [],
      createdAt: 1,
      status: "available",
      conflicts: [],
    } as unknown as UndoPoint;
    await writeUndoPoint(point);
    expect(await readUndoPoint()).toEqual(point);
    await writeUndoPoint(null);
    expect(await readUndoPoint()).toBeNull();
    expect(session.size).toBe(0);
  });

  it("expires earlier undo availability and is a no-op on empty history", async () => {
    installStorage();
    await updateLatestHistoryUndoStatus("completed");
    await appendCountsOnlyHistory(report("available"));
    await appendCountsOnlyHistory(report("available"));
    const stored = (await (await import("../src/storage/organization-history")).readCountsOnlyHistory());
    expect(stored.map((item) => item.undoStatus)).toEqual(["unavailable", "available"]);
    await updateLatestHistoryUndoStatus("partial", 2);
    const updated = await (await import("../src/storage/organization-history")).readCountsOnlyHistory();
    expect(updated.at(-1)).toMatchObject({ undoStatus: "partial", undoConflictCount: 2 });
    await expect(appendCountsOnlyHistory(report("available"))).resolves.toBeUndefined();
    const capped = await (await import("../src/storage/organization-history")).readCountsOnlyHistory();
    expect(capped.length).toBeLessThanOrEqual(50);
  });
});

describe("Edge cases: semantic comparison", () => {
  const group = (runtimeId: number, members: number[]): SemanticGroup => ({
    runtimeId, windowId: 7, title: "T", color: "blue", collapsed: false,
    shared: { known: true, value: false }, memberTabIds: members, firstTabIndex: 0, protectionReasons: [],
  });

  it("reports membership, navigation, title and group drift", () => {
    const expected = windowState({ groups: [group(42, [2])], tabs: [tab({ id: 1, index: 0 }), tab({ id: 2, index: 1, groupId: 42 })] });
    expect(compareSemanticStates(expected, expected)).toEqual({ matches: true, issues: [] });
    const reordered = { ...expected, tabs: [expected.tabs[1]!, expected.tabs[0]!] };
    expect(compareSemanticStates(expected, reordered).issues).toContain("Tab membership or relative ordering changed.");
    const missing = { ...expected, tabs: [expected.tabs[0]!] };
    expect(compareSemanticStates(expected, missing).issues).toEqual(expect.arrayContaining([
      "Tab membership or relative ordering changed.",
      "Tab 2 is missing.",
    ]));
    const navigated = { ...expected, tabs: [expected.tabs[0]!, { ...expected.tabs[1]!, url: "https://elsewhere.test/" }] };
    expect(compareSemanticStates(expected, navigated).issues).toEqual(["Tab 2 navigated."]);
    const groupDrift = { ...expected, groups: [{ ...group(42, [2]), color: "green" as const }] };
    expect(compareSemanticStates(expected, groupDrift).issues).toEqual(["Native group semantics differ from the captured state."]);
  });
});

describe("Edge cases: conflict-aware undo", () => {
  function runtimeFor(live: SemanticWindowState) {
    const restored: number[][] = [];
    return {
      restored,
      runtime: {
        readWindow: vi.fn(async () => live),
        groupTabs: vi.fn(async () => 1),
        updateGroup: vi.fn(async () => {}),
        moveGroup: vi.fn(async () => {}),
        moveTabs: vi.fn(async () => {}),
        ungroupTabs: vi.fn(async (tabIds: number[]) => { restored.push(tabIds); }),
        persist: vi.fn(async () => {}),
      },
    };
  }

  it("skips closed, navigated and group-conflicting tabs and marks partial", async () => {
    const before = windowState({ tabs: [tab({ id: 1, index: 0 }), tab({ id: 2, index: 1 }), tab({ id: 3, index: 2 })] });
    const expectedAfter = windowState({
      tabs: [tab({ id: 1, index: 0 }), tab({ id: 2, index: 1 }), tab({ id: 3, index: 2 })],
    });
    const live = windowState({
      tabs: [
        tab({ id: 1, index: 0 }),
        tab({ id: 2, index: 1, url: "https://moved.test/" }),
        tab({ id: 3, index: 2, groupId: 42 }),
      ],
      groups: [groupEntry(42, [3])],
    });
    const { runtime, restored } = runtimeFor(live);
    const point: UndoPoint = {
      status: "available",
      conflicts: [],
      targetWindowId: 7,
      before,
      expectedAfter,
      touchedTabIds: [1, 2, 3, 4],
    } as unknown as UndoPoint;
    const result = await executeConflictAwareUndo(point, runtime as never);
    expect(result.status).toBe("partial");
    expect(result.conflicts).toEqual([
      "“Tab 2” navigated to another page, so Undo left it where it is.",
      "“Tab 3” was regrouped after organizing, so Undo left it where it is.",
      "An untitled tab was closed, so Undo skipped it.",
    ]);
    expect(restored).toEqual([[1]]);
  });

  it("restores the whole original group when every touched member is safe", async () => {
    const before = windowState({
      tabs: [tab({ id: 1, index: 0, groupId: 42 }), tab({ id: 2, index: 1, groupId: 42 })],
      groups: [groupEntry(42, [1, 2])],
    });
    const live = windowState({
      tabs: [tab({ id: 1, index: 0 }), tab({ id: 2, index: 1 })],
      groups: [],
    });
    const { runtime, restored } = runtimeFor(live);
    const point: UndoPoint = {
      status: "available",
      conflicts: [],
      targetWindowId: 7,
      before,
      expectedAfter: live,
      touchedTabIds: [1, 2],
    } as unknown as UndoPoint;
    const result = await executeConflictAwareUndo(point, runtime as never);
    expect(result.status).toBe("completed");
    expect(result.conflicts).toEqual([]);
    expect(restored).toEqual([[1, 2]]);
  });

  it("drops the whole original group when one touched member conflicts", async () => {
    const before = windowState({
      tabs: [tab({ id: 1, index: 0, groupId: 42 }), tab({ id: 2, index: 1, groupId: 42 }), tab({ id: 5, index: 2 })],
      groups: [groupEntry(42, [1, 2])],
    });
    const live = windowState({
      tabs: [tab({ id: 1, index: 0 }), tab({ id: 2, index: 1, url: "https://moved.test/" }), tab({ id: 5, index: 2 })],
      groups: [],
    });
    // expectedAfter is the post-organization state; tab 2 has since navigated.
    const expectedAfter = windowState({
      tabs: [tab({ id: 1, index: 0 }), tab({ id: 2, index: 1 }), tab({ id: 5, index: 2 })],
      groups: [],
    });
    const { runtime, restored } = runtimeFor(live);
    const point: UndoPoint = {
      status: "available",
      conflicts: [],
      targetWindowId: 7,
      before,
      expectedAfter,
      touchedTabIds: [1, 2, 5],
    } as unknown as UndoPoint;
    const result = await executeConflictAwareUndo(point, runtime as never);
    expect(result.status).toBe("partial");
    expect(restored).toEqual([[5]]);
  });
});

describe("Edge cases: linked workspace capture", () => {
  function installChrome(tabs: Record<string, unknown>[], groups: Record<string, unknown>[] = []) {
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn(async () => tabs) },
      tabGroups: { query: vi.fn(async () => groups), TAB_GROUP_ID_NONE: -1 },
    });
  }

  const workspace = (overrides: Record<string, unknown>) => ({
    id: "ws-1", stashId: "s-1", windowId: 7, mode: "tracked_tabs",
    trackedTabIds: [1], trackedTabs: [], startedAt: 1, updatedAt: 2, ...overrides,
  }) as never;

  it("captures a whole window in index order with group keys in first-tab order", async () => {
    installChrome([
      { id: 3, index: 1, title: "B", url: "https://b.test/", groupId: 55, windowId: 7 },
      { id: 1, index: 0, title: "A", url: "https://a.test/", groupId: -1, windowId: 7 },
      { id: 2, index: 2, title: "C", url: "https://c.test/", groupId: 66, windowId: 7 },
    ], [
      { id: 66, windowId: 7, title: "Second", color: "red", collapsed: false },
      { id: 55, windowId: 7, title: "First", color: "blue", collapsed: true },
    ]);
    const capture = await captureLinkedWorkspace(workspace({ mode: "whole_window" }));
    expect(capture.tabs.map((t) => [t.sourceTabId, t.groupKey])).toEqual([[1, null], [3, "group-1"], [2, "group-2"]]);
    expect(capture.groups.map((g) => [g.key, g.title, g.collapsed])).toEqual([
      ["group-1", "First", true],
      ["group-2", "Second", false],
    ]);
    expect(capture.tabs[0]!.stableKey).toBe("workspace:ws-1:1");
  });

  it("follows the opener chain for tracked-mode workspaces", async () => {
    installChrome([
      { id: 10, index: 0, title: "Root", url: "https://root.test/", groupId: -1, windowId: 7 },
      { id: 11, index: 1, title: "Child", url: "https://child.test/", groupId: -1, windowId: 7, openerTabId: 10 },
      { id: 12, index: 2, title: "Grandchild", url: "https://gc.test/", groupId: -1, windowId: 7, openerTabId: 11 },
      { id: 13, index: 3, title: "Unrelated", url: "https://other.test/", groupId: -1, windowId: 7, openerTabId: 99 },
    ]);
    const capture = await captureLinkedWorkspace(workspace({ trackedTabIds: [10] }));
    expect(capture.tabs.map((t) => t.sourceTabId)).toEqual([10, 11, 12]);
    const tokenA = await stashWorkspaceCaptureToken(capture);
    const tokenB = await stashWorkspaceCaptureToken(capture);
    expect(tokenA).toBe(tokenB);
    expect(tokenA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops tabs without a URL and prefers caller-supplied stable keys", async () => {
    installChrome([
      { id: 1, index: 0, title: "Pending", pendingUrl: "https://pending.test/", groupId: -1, windowId: 7 },
      { id: 2, index: 1, title: "Nothing", groupId: -1, windowId: 7 },
    ]);
    const capture = await captureLinkedWorkspace(workspace({
      mode: "whole_window",
      trackedTabs: [{ tabId: 1, stableKey: "known-key" }],
    }));
    expect(capture.tabs).toHaveLength(1);
    expect(capture.tabs[0]).toMatchObject({ sourceTabId: 1, url: "https://pending.test/", stableKey: "known-key" });
  });
});

describe("Edge cases: group manager fingerprint", () => {
  it("is order-independent across windows and sensitive to content", async () => {
    const left = windowState({ windowId: 7, tabs: [tab({ id: 1, index: 0 })] });
    const right = windowState({ windowId: 3, tabs: [tab({ id: 9, index: 0 })] });
    const a = await groupManagerFingerprint([left, right]);
    const b = await groupManagerFingerprint([right, left]);
    expect(a).toBe(b);
    const renamed = { ...left, tabs: [{ ...left.tabs[0]!, title: "Different" }] };
    expect(await groupManagerFingerprint([renamed, right])).not.toBe(a);
  });
});

describe("Edge cases: generated-group cleanup normalization", () => {
  const record = (overrides: Record<string, unknown>) => ({
    id: "r1", groupId: 5, windowId: 7, browserSessionId: "session-1",
    createdAt: 1, lastSeenAt: 10, fingerprint: null, ...overrides,
  });

  it("drops malformed records, dedupes by id keeping the last, and sorts by lastSeenAt", () => {
    const normalized = normalizeGeneratedGroupTracking([
      record({ id: "a", lastSeenAt: 1 }),
      record({ id: "a", lastSeenAt: 9 }),
      record({ id: "b", lastSeenAt: 5 }),
      record({ id: "c", groupId: -1 }),
      record({ id: "", lastSeenAt: 50 }),
      "junk",
      null,
      record({ id: "d", fingerprint: undefined }),
    ]);
    expect(normalized.map((item) => item.id)).toEqual(["a", "b"]);
    expect(normalized[0]!.lastSeenAt).toBe(9);
    expect(normalizeGeneratedGroupTracking("junk")).toEqual([]);
  });

  it("accepts only complete cleanup runs", () => {
    expect(normalizeGeneratedGroupCleanupRun({
      mode: "manual", ranAt: 5, groupsUngrouped: 1, tabsKeptOpen: 2, groupsSkipped: 0,
    })).toEqual({ mode: "manual", ranAt: 5, groupsUngrouped: 1, tabsKeptOpen: 2, groupsSkipped: 0 });
    expect(normalizeGeneratedGroupCleanupRun({ mode: "automatic", ranAt: 5, groupsUngrouped: 1 })).toBeNull();
    expect(normalizeGeneratedGroupCleanupRun({ mode: "later", ranAt: 5, groupsUngrouped: 1, tabsKeptOpen: 2, groupsSkipped: 0 })).toBeNull();
    expect(normalizeGeneratedGroupCleanupRun(undefined)).toBeNull();
  });

  it("normalizes the auto-cleanup window to the allowed set", () => {
    expect(normalizeGeneratedGroupCleanupSettings({ autoUngroupAfterDays: 7 })).toEqual({ autoUngroupAfterDays: 7 });
    expect(normalizeGeneratedGroupCleanupSettings({ autoUngroupAfterDays: 2 })).toEqual({ autoUngroupAfterDays: null });
    expect(normalizeGeneratedGroupCleanupSettings("junk")).toEqual({ autoUngroupAfterDays: null });
  });
});

function groupEntry(runtimeId: number, members: number[]): SemanticGroup {
  return {
    runtimeId, windowId: 7, title: "T", color: "blue" as const, collapsed: false,
    shared: { known: true, value: false }, memberTabIds: members, firstTabIndex: 0, protectionReasons: [],
  };
}

describe("Edge cases: provider body limits", () => {
  function responseOf(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream);
  }

  it("returns the body untouched below the limit and empty for a missing body", async () => {
    expect(await readBodyWithLimit(responseOf(["hello ", "world"]), 1024, false)).toBe("hello world");
    expect(await readBodyWithLimit(new Response(null), 1024, false)).toBe("");
  });

  it("truncates with a marker when allowed and throws when not", async () => {
    const truncated = await readBodyWithLimit(responseOf(["abcdefghij"]), 4, true);
    expect(truncated).toBe("abcd\n[truncated]");
    await expect(readBodyWithLimit(responseOf(["abcdefghij"]), 4, false))
      .rejects.toThrow("Provider response exceeded the 4-byte limit.");
  });
});
