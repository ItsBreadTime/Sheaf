import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentSemanticIndex,
  prepareSemanticIndex,
  refreshSemanticIndexCompatibility,
  resumeSemanticIndex,
  runSemanticIndexMaintenance,
  semanticPlanIsCurrent,
} from "../src/background/semantic-index-runtime";
import {
  quarantineSemanticMappings,
  readAllSemanticQueue,
  readSemanticIndexMeta,
  readSemanticTabRecords,
} from "../src/storage/semantic-index";
import { semanticSourceFingerprint } from "../src/search/semantic-indexer";
import { writePrivacySettings } from "../src/storage/organizer-state";
import { DEFAULT_PRIVACY_SETTINGS } from "../src/storage/organizer-state";
import { readSearchState, writeEmbeddingProvider, writeEmbeddingProviderTest, writeSearchSettings } from "../src/storage/search";
import { writeTabStashes } from "../src/storage/stashes";
import { DEFAULT_SEARCH_SETTINGS } from "../src/storage/search";
import type { SavedTabStash } from "../src/shared/stash-types";
import { EMPTY_SEMANTIC_INDEX_META } from "../src/shared/semantic-index-types";
import { createFakeEmbeddingProvider, type FakeEmbeddingFailure } from "./helpers/fake-embedding-provider";

const API_KEY = "test-api-key";
const WINDOW_ID = 1;
const MODEL = "test-embedding-model";

interface Harness {
  provider: ReturnType<typeof createFakeEmbeddingProvider>;
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
    clear: vi.fn(async () => { for (const key of Object.keys(store)) delete store[key]; }),
  };
}

/**
 * Installs a chrome surface sufficient for the semantic index runtime: storage
 * areas, a queryable tab/group set, window existence and alarms. The surface is
 * always complete, because teardown and deferred reconciliation both touch it.
 */
function installChrome(options: {
  tabs?: Array<{ id: number; windowId: number; title: string; url: string; groupId?: number }>;
  groups?: Array<{ id: number; windowId: number; title: string }>;
  openWindowIds?: number[];
} = {}) {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const tabs = options.tabs ?? [];
  const groups = options.groups ?? [];
  const openWindowIds = new Set(options.openWindowIds ?? [WINDOW_ID]);
  const alarmNames = new Set<string>();
  const chromeMock = {
    storage: {
      local: storageArea(local),
      session: storageArea(session),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(async (query: chrome.tabs.QueryInfo = {}) =>
        tabs.filter((tab) => query.windowId === undefined || tab.windowId === query.windowId)),
    },
    tabGroups: {
      query: vi.fn(async (query: chrome.tabGroups.QueryInfo = {}) =>
        groups.filter((group) => query.windowId === undefined || group.windowId === query.windowId)),
    },
    windows: {
      get: vi.fn(async (windowId: number) => {
        if (!openWindowIds.has(windowId)) throw new Error("No window with id");
        return { id: windowId };
      }),
    },
    alarms: {
      create: vi.fn(async (name: string) => { alarmNames.add(name); }),
      clear: vi.fn(async (name: string) => alarmNames.delete(name)),
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  return { chromeMock, openWindowIds, alarmNames };
}

async function seedEnabledSearch(failures: FakeEmbeddingFailure[] = [], dimensions = 8): Promise<Harness> {
  const provider = createFakeEmbeddingProvider({ dimensions, failures });
  vi.stubGlobal("fetch", provider.fetchImpl);
  await writeSearchSettings({
    ...DEFAULT_SEARCH_SETTINGS,
    semanticEnabled: true,
    semanticConsentAt: 1,
    semanticIncludeGroupNames: false,
    semanticIndexScope: "current_window",
  });
  await writeEmbeddingProvider({
    config: {
      origin: "https://embeddings.example",
      endpointPath: "/v1/embeddings",
      model: MODEL,
      dimensions: null,
      apiKeyStorage: "session",
      modelProfile: "auto",
      customHeaders: {},
      extraBody: {},
      timeoutMs: 5_000,
    },
    apiKey: API_KEY,
    customHeaders: {},
  });
  await writeEmbeddingProviderTest({
    testedAt: 1,
    model: MODEL,
    dimensions,
    latencyMs: 1,
    batchInputSupported: true,
    queryDocumentCompatible: true,
    retentionStatus: "not_verified",
  });
  return { provider };
}

/** The runtime processes in the background; drain its microtask turns. */
async function settle(limit = 400): Promise<Awaited<ReturnType<typeof readSemanticIndexMeta>>> {
  return settleUntil((meta) => meta.status !== "building", "index to leave the building state", limit);
}

/**
 * A transient provider failure deliberately leaves the build in the `building`
 * state with a future `nextRetryAt`, so tests that cover retry bookkeeping wait
 * on the queue condition rather than on the build finishing.
 */
async function settleUntil(
  predicate: (meta: Awaited<ReturnType<typeof readSemanticIndexMeta>>) => boolean,
  description: string,
  limit = 400,
): Promise<Awaited<ReturnType<typeof readSemanticIndexMeta>>> {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const meta = await readSemanticIndexMeta();
    if (predicate(meta)) return meta;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(await readSemanticIndexMeta())}`);
}

const baseTabs = [
  { id: 11, windowId: WINDOW_ID, title: "Billing dashboard", url: "https://example.com/billing?token=secret#top", groupId: 7 },
  { id: 12, windowId: WINDOW_ID, title: "Release checklist", url: "https://example.com/releases/v2" },
  { id: 13, windowId: 2, title: "Other window tab", url: "https://elsewhere.example/page" },
];
const baseGroups = [{ id: 7, windowId: WINDOW_ID, title: "Finance" }];

beforeEach(() => {
  // Faking only Date keeps real timers working for IndexedDB and the settle loop
  // while still letting a test jump the clock past a retry backoff.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  // The runtime is a module singleton, so a mutation can leave a deferred
  // reconciliation queued. With a complete chrome surface installed it drains
  // harmlessly, and it must drain before the database is deleted.
  installChrome();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await runSemanticIndexMaintenance().catch(() => undefined);
  await clearCurrentSemanticIndex();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("semantic index runtime orchestration", () => {
  it("indexes the selected window in batches, excludes other windows, and completes", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    const { provider } = await seedEnabledSearch();

    const meta = await prepareSemanticIndex(WINDOW_ID);
    expect(meta.status).toBe("building");
    const settled = await settle();

    expect(settled).toMatchObject({
      status: "complete",
      indexScope: "current_window",
      targetWindowId: WINDOW_ID,
      total: 2,
      ready: 2,
      pending: 0,
      failed: 0,
      cacheMisses: 2,
    });
    expect(await readAllSemanticQueue()).toEqual([]);
    const mappings = await readSemanticTabRecords();
    expect(mappings.map((mapping) => mapping.status)).toEqual(["ready", "ready"]);
    expect(mappings.map((mapping) => mapping.target)).toEqual([
      { kind: "open", tabId: 11, windowId: WINDOW_ID },
      { kind: "open", tabId: 12, windowId: WINDOW_ID },
    ]);
    expect(provider.documentInputs()).toHaveLength(2);
    expect(provider.requests.every((request) => request.model === MODEL)).toBe(true);
    expect(provider.requests.every((request) => request.authorization === `Bearer ${API_KEY}`)).toBe(true);
  });

  it("never sends a query string or fragment to the embedding provider", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    const { provider } = await seedEnabledSearch();
    await prepareSemanticIndex(WINDOW_ID);
    await settle();

    for (const input of provider.inputs()) {
      expect(input).not.toContain("?");
      expect(input).not.toContain("#");
      expect(input).not.toContain("token=secret");
    }
    // The indexed path is still visible, only the query part is dropped.
    expect(provider.documentInputs().some((input) => input.includes("Path: /billing"))).toBe(true);
  });

  it("indexes group titles only under the search consent, never the organizer flag", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    const { provider } = await seedEnabledSearch();
    // The organizer may send group titles to the chat provider; that is a different
    // promise, and turning it on must not start sending them to the embedder.
    await writePrivacySettings({ ...DEFAULT_PRIVACY_SETTINGS, includeExistingGroups: true });
    await prepareSemanticIndex(WINDOW_ID);
    await settle();
    expect(provider.documentInputs().some((input) => input.includes("Group:"))).toBe(false);

    const withoutGroups = await readSemanticTabRecords();
    await writeSearchSettings({
      ...DEFAULT_SEARCH_SETTINGS,
      semanticEnabled: true,
      semanticConsentAt: 1,
      semanticIncludeGroupNames: true,
      semanticIndexScope: "current_window",
    });
    // The consent is part of the compatibility key, so opting in invalidates the
    // index rather than silently mixing two document shapes.
    const stale = await refreshSemanticIndexCompatibility();
    expect(stale).toMatchObject({ status: "stale", lastErrorCode: "configuration_changed" });
    expect((await prepareSemanticIndex(WINDOW_ID)).status).toBe("building");
    await settle();
    expect(provider.documentInputs()).toContain(
      "Title: billing dashboard\nHost: example.com\nPath: /billing\nGroup: finance",
    );
    const withGroups = await readSemanticTabRecords();
    expect(withGroups.map((mapping) => mapping.embeddingKey)).not.toEqual(
      withoutGroups.map((mapping) => mapping.embeddingKey),
    );
  });

  it("recognizes a plan that cannot have changed, and refuses when it might", async () => {
    const complete = { ...EMPTY_SEMANTIC_INDEX_META, status: "complete" as const, failed: 0, sourceFingerprint: "same" };
    expect(await semanticPlanIsCurrent(complete, true, "same")).toBe(true);
    // A queued record means there is work, whoever put it there.
    expect(await semanticPlanIsCurrent(complete, false, "same")).toBe(false);
    // A quarantined record means a mapping needs re-queueing, so planning must run.
    expect(await semanticPlanIsCurrent({ ...complete, failed: 1 }, true, "same")).toBe(false);
    // Sources moved: the stored plan is stale.
    expect(await semanticPlanIsCurrent(complete, true, "different")).toBe(false);
    // No fingerprint at all predates the fingerprint column.
    expect(await semanticPlanIsCurrent({ ...complete, sourceFingerprint: null }, true, "same")).toBe(false);
    expect(await semanticPlanIsCurrent({ ...complete, status: "building" }, true, "same")).toBe(false);
    // The fingerprint itself is order-insensitive but content-sensitive.
    const sources = [
      { mappingKey: "window:1:tab:1", target: { kind: "open" as const, tabId: 1, windowId: 1 }, title: "A", url: "https://a.example/", groupName: null },
      { mappingKey: "window:1:tab:2", target: { kind: "open" as const, tabId: 2, windowId: 1 }, title: "B", url: "https://b.example/", groupName: "Work" },
    ];
    expect(await semanticSourceFingerprint(sources)).toBe(await semanticSourceFingerprint([...sources].reverse()));
    expect(await semanticSourceFingerprint([{ ...sources[0]!, title: "A changed" }, sources[1]!]))
      .not.toBe(await semanticSourceFingerprint(sources));
    expect(await semanticSourceFingerprint([{ ...sources[0]!, groupName: "Work" }, sources[1]!]))
      .not.toBe(await semanticSourceFingerprint(sources));
  });

  it("re-queues a quarantined document instead of leaving the index broken", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    const { provider } = await seedEnabledSearch();
    await prepareSemanticIndex(WINDOW_ID);
    await settle();
    const healthy = await readSemanticIndexMeta();

    // Simulate what a query does when it finds a vector the provider changed shape
    // under: delete it and mark the mapping failed.
    const before = await readSemanticTabRecords();
    await quarantineSemanticMappings(before.map((mapping) => mapping.mappingKey), "invalid_record");
    expect(await readSemanticIndexMeta()).toMatchObject({ failed: 2, ready: 0 });

    // `failed > 0` is what makes resume run a reconcile, and the reconcile is what
    // turns the quarantined mappings back into queued work.
    const resumed = await resumeSemanticIndex();
    expect(resumed.status).toBe("building");
    await settle();
    const healed = await readSemanticIndexMeta();
    expect(healed).toMatchObject({ status: "complete", ready: 2, failed: 0 });
    expect(healed.sourceFingerprint).toBe(healthy.sourceFingerprint);
    expect(provider.documentInputs().length).toBeGreaterThan(2);
  });

  it("reuses cached vectors and re-embeds nothing when the tabs are unchanged", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    const { provider } = await seedEnabledSearch();
    await prepareSemanticIndex(WINDOW_ID);
    await settle();
    const requestsAfterFirstBuild = provider.requests.length;

    const second = await prepareSemanticIndex(WINDOW_ID);
    expect(second).toMatchObject({ status: "complete", ready: 2, pending: 0, cacheHits: 2, cacheMisses: 0 });
    expect(provider.requests.length).toBe(requestsAfterFirstBuild);
  });

  it("holds new tabs back from the provider while paused and sends them on resume", async () => {
    const tabs = [...baseTabs];
    installChrome({ tabs, groups: baseGroups });
    const { provider } = await seedEnabledSearch();
    await prepareSemanticIndex(WINDOW_ID);
    await settle();
    const requestsAfterBuild = provider.requests.length;

    const settings = (await readSearchState()).local.settings;
    await writeSearchSettings({ ...settings, semanticIndexPaused: true });
    tabs.push({ id: 14, windowId: WINDOW_ID, title: "Quarterly roadmap", url: "https://example.com/roadmap" });
    const paused = await runSemanticIndexMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(paused).toMatchObject({ status: "building", ready: 2, pending: 1 });
    expect(provider.requests.length).toBe(requestsAfterBuild);

    await writeSearchSettings({ ...settings, semanticIndexPaused: false });
    await runSemanticIndexMaintenance();
    expect(await settle()).toMatchObject({ status: "complete", ready: 3, pending: 0 });
    expect(provider.requests.length).toBe(requestsAfterBuild + 1);
  });

  it("ends a pause when a build is requested", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    await seedEnabledSearch();
    await writeSearchSettings({ ...(await readSearchState()).local.settings, semanticIndexPaused: true });

    await prepareSemanticIndex(WINDOW_ID);
    expect(await settle()).toMatchObject({ status: "complete", ready: 2 });
    expect((await readSearchState()).local.settings.semanticIndexPaused).toBe(false);
  });

  it("retries a rate-limited batch after its backoff and then completes", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    await seedEnabledSearch([{ kind: "http_status", status: 429, retryAfter: "1", times: 1 }]);

    await prepareSemanticIndex(WINDOW_ID);
    const afterFailure = await settleUntil(
      (meta) => meta.lastErrorCode === "rate_limited",
      "the rate-limited retry to be recorded",
    );

    // A transient failure keeps the build alive and schedules a retry instead of
    // failing the whole index.
    expect(afterFailure).toMatchObject({ status: "building", lastErrorCode: "rate_limited", failed: 0 });
    expect(afterFailure.nextRetryAt).toBeGreaterThan(Date.now());
    const queued = await readAllSemanticQueue();
    expect(queued).toHaveLength(2);
    expect(queued.every((record) => record.retryCount === 1 && record.lastErrorCode === "rate_limited")).toBe(true);

    // Jump past the first backoff delay, then resume the way the alarm would.
    vi.setSystemTime(new Date(Date.now() + 6_000));
    expect(await resumeSemanticIndex()).toMatchObject({ status: "building" });
    const recovered = await settle();
    expect(recovered).toMatchObject({ status: "complete", ready: 2, pending: 0, lastErrorCode: null });
    expect(await readAllSemanticQueue()).toEqual([]);
  });

  it("fails the whole build on a non-retryable provider error", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    await seedEnabledSearch([{ kind: "http_status", status: 401 }]);

    const meta = await prepareSemanticIndex(WINDOW_ID);
    expect(meta.status).toBe("building");
    const settled = await settle();

    expect(settled).toMatchObject({ status: "failed", lastErrorCode: "authentication", failed: 2, pending: 0, nextRetryAt: null });
    expect(await readAllSemanticQueue()).toEqual([]);
    const mappings = await readSemanticTabRecords();
    expect(mappings.every((mapping) => mapping.status === "failed" && mapping.errorCode === "authentication")).toBe(true);
  });

  it("fails the build when the provider returns a wrong-dimension vector", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    await seedEnabledSearch([{ kind: "wrong_dimension" }]);

    await prepareSemanticIndex(WINDOW_ID);
    const settled = await settle();
    // A provider that ignores the configured shape is an invalid response, not a
    // transient fault, so it must not be retried indefinitely.
    expect(settled.status).toBe("failed");
    expect(settled.lastErrorCode).toBe("invalid_response");
    expect(settled.failed).toBe(2);
  });

  it("marks the index stale when the embedding configuration changes", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    await seedEnabledSearch();
    await prepareSemanticIndex(WINDOW_ID);
    await settle();

    await writeEmbeddingProvider({
      config: {
        origin: "https://embeddings.example",
        endpointPath: "/v1/embeddings",
        model: "replacement-model",
        dimensions: null,
        apiKeyStorage: "session",
        modelProfile: "auto",
        customHeaders: {},
        extraBody: {},
        timeoutMs: 5_000,
      },
      apiKey: API_KEY,
      customHeaders: {},
    });
    const stale = await refreshSemanticIndexCompatibility();

    expect(stale).toMatchObject({
      status: "stale",
      lastErrorCode: "configuration_changed",
      total: 0,
      ready: 0,
      pending: 0,
      nextRetryAt: null,
    });
    expect(await readSemanticTabRecords()).toEqual([]);
    expect(await readAllSemanticQueue()).toEqual([]);
  });

  it("marks a current-window index stale when its window closes", async () => {
    const { openWindowIds } = installChrome({ tabs: baseTabs, groups: baseGroups });
    await seedEnabledSearch();
    await prepareSemanticIndex(WINDOW_ID);
    await settle();

    openWindowIds.delete(WINDOW_ID);
    const stale = await runSemanticIndexMaintenance();

    expect(stale).toMatchObject({
      status: "stale",
      lastErrorCode: "target_window_closed",
      total: 0,
      ready: 0,
      pending: 0,
    });
    expect(await readSemanticTabRecords()).toEqual([]);
  });

  it("keeps retry state when reconciliation finds the same tabs", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    await seedEnabledSearch([{ kind: "http_status", status: 429 }]);
    await prepareSemanticIndex(WINDOW_ID);
    await settleUntil((meta) => meta.lastErrorCode === "rate_limited", "the retry to be recorded");

    const before = await readAllSemanticQueue();
    expect(before.every((record) => record.retryCount === 1)).toBe(true);
    await runSemanticIndexMaintenance();
    const after = await readAllSemanticQueue();
    expect(after.map((record) => [record.key, record.retryCount, record.lastErrorCode]).sort())
      .toEqual(before.map((record) => [record.key, record.retryCount, record.lastErrorCode]).sort());
  });

  it("indexes stashed tabs alongside open tabs", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    const { provider } = await seedEnabledSearch();
    const stash: SavedTabStash = {
      id: "stash-1",
      name: "Reading",
      createdAt: 1,
      updatedAt: 1,
      note: "",
      revisions: [], lastOpenedAt: null,
      activeWorkspaceId: null,
      status: "saved",
      scope: { mode: "group", groupId: 7 },
      tabs: [{
        sourceTabId: 99,
        sourceIndex: 0,
        title: "Stashed vector cache notes",
        url: "https://example.com/stash/doc",
        groupKey: "g1",
      }],
      groups: [{ key: "g1", sourceGroupId: 7, sourceIndex: 0, title: "Docs", color: "blue", collapsed: false }],
      excludedTabs: [],
      closeConflicts: [],
      restoreResult: null,
    };
    // The stash write reconciles the index locally, so seed it before the build.
    await writeTabStashes([stash]);

    const meta = await prepareSemanticIndex(WINDOW_ID);
    const settled = await settle();

    expect(meta.total).toBe(3);
    expect(settled).toMatchObject({ status: "complete", ready: 3, pending: 0 });
    const mappings = await readSemanticTabRecords();
    expect(mappings.some((mapping) => mapping.target.kind === "stash" && mapping.target.stashId === "stash-1")).toBe(true);
    expect(provider.documentInputs().some((input) => input.includes("stashed vector cache notes"))).toBe(true);
  });

  it("refuses to build when consent is missing", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    const provider = createFakeEmbeddingProvider();
    vi.stubGlobal("fetch", provider.fetchImpl);
    await writeSearchSettings({ ...DEFAULT_SEARCH_SETTINGS, semanticEnabled: true, semanticConsentAt: null });

    await expect(prepareSemanticIndex(WINDOW_ID)).rejects.toThrow(/privacy disclosure/i);
    expect(provider.requests).toEqual([]);
  });

  it("refuses to build before the embedding provider has been tested", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    const provider = createFakeEmbeddingProvider();
    vi.stubGlobal("fetch", provider.fetchImpl);
    await writeSearchSettings({ ...DEFAULT_SEARCH_SETTINGS, semanticEnabled: true, semanticConsentAt: 1 });
    await writeEmbeddingProvider({
      config: {
        origin: "https://embeddings.example",
        endpointPath: "/v1/embeddings",
        model: MODEL,
        dimensions: null,
        apiKeyStorage: "session",
        modelProfile: "auto",
        customHeaders: {},
        extraBody: {},
        timeoutMs: 5_000,
      },
      apiKey: API_KEY,
      customHeaders: {},
    });

    await expect(prepareSemanticIndex(WINDOW_ID)).rejects.toThrow(/Test the embedding provider/i);
    expect(provider.requests).toEqual([]);
  });

  it("excludes tabs rejected by the privacy denylist without contacting the provider", async () => {
    installChrome({ tabs: baseTabs, groups: baseGroups });
    const { provider } = await seedEnabledSearch();
    await writePrivacySettings({
      level: 2,
      includeExistingGroups: false,
      allowLocalNetworkTabs: false,
      allowFileTabs: false,
      closeInactiveBlankTabs: false,
      allowlist: [],
      denylist: ["example.com"],
    });

    const meta = await prepareSemanticIndex(WINDOW_ID);
    await settle();

    expect(meta).toMatchObject({ total: 2, excluded: 2, ready: 0 });
    expect(provider.requests).toEqual([]);
    const mappings = await readSemanticTabRecords();
    expect(mappings.every((mapping) => mapping.status === "excluded" && mapping.errorCode === "privacy_rule")).toBe(true);
  });
});
