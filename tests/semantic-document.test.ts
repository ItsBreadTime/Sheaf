import { describe, expect, it } from "vitest";
import { buildSemanticDocument, computeSemanticCompatibilityKey, computeSemanticEmbeddingKey, semanticDocumentPrivacy } from "../src/search/semantic-document";
import { sanitizeGroupTitle } from "../src/privacy/sanitize-text";
import { LIMITS } from "../src/shared/limits";
import { DEFAULT_PRIVACY_SETTINGS } from "../src/storage/organizer-state";
import { DEFAULT_EMBEDDING_CONFIG } from "../src/storage/search";
import { shouldReadAllSemanticMappings } from "../src/storage/semantic-index";
import type { SemanticTabRecord } from "../src/shared/semantic-index-types";
import { createSemanticIndexPlan, normalizeEmbeddingVector } from "../src/search/semantic-indexer";
import {
  isRetryableSemanticErrorCode,
  semanticMappingsChanged,
  semanticSourcesFromChromeTabs,
  semanticSourcesFromStashes,
} from "../src/background/semantic-index-runtime";

const source = (tabId: number, windowId: number, rest: { title: string; url: string; groupName: string | null }) => ({
  mappingKey: `window:${windowId}:tab:${tabId}`,
  target: { kind: "open" as const, tabId, windowId },
  ...rest,
});

describe("semantic documents", () => {
  it("uses organizer sanitization and omits raw identifiers and state", () => {
    const result = buildSemanticDocument(source(42, 7, {
      title: " Issue\u202e 123 ",
      url: "https://github.com/owner/repo/actions/123456789?token=private#secret",
      groupName: " Project work ",
    }), { ...DEFAULT_PRIVACY_SETTINGS, level: 2, includeExistingGroups: true });
    expect(result).toMatchObject({ status: "ready", target: { kind: "open", tabId: 42, windowId: 7 } });
    if (result.status !== "ready") return;
    expect(result.document).toBe("Title: issue 123\nHost: github.com\nPath: /owner/repo/actions/:number\nGroup: project work");
    expect(result.document).not.toMatch(/private|secret|123456789|tabId|active|audible/);
  });

  it("excludes disallowed and unsupported locations before indexing", () => {
    expect(buildSemanticDocument(source(1, 1, { title: "Private", url: "https://private.example/x", groupName: null }), {
      ...DEFAULT_PRIVACY_SETTINGS,
      denylist: ["*.example"],
    })).toMatchObject({ status: "excluded", errorCode: "privacy_rule" });
    expect(buildSemanticDocument(source(2, 1, { title: "Chrome", url: "chrome://settings", groupName: null }), DEFAULT_PRIVACY_SETTINGS))
      .toMatchObject({ status: "excluded", errorCode: "unsupported_location" });
  });

  it("keeps domain-only privacy at the registrable-domain boundary", () => {
    const result = buildSemanticDocument(source(1, 1, {
      title: "Tenant dashboard",
      url: "https://private-tenant.example.com/account/secret",
      groupName: null,
    }), { ...DEFAULT_PRIVACY_SETTINGS, level: 1 });
    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") return;
    expect(result.document).toBe("Title: tenant dashboard\nHost: example.com");
    expect(result.document).not.toContain("private-tenant");
  });

  it("produces identical documents for cosmetically drifted tabs", () => {
    // Rank instability tracks document-text changes, not scorer noise, so a
    // cosmetic edit must not reach the text at all.
    const variations = [
      { title: "Billing dashboard", url: "https://example.com/billing" },
      { title: "Billing Dashboard", url: "https://example.com/billing/" },
      { title: "BILLING DASHBOARD", url: "https://example.com//billing" },
      { title: "  billing   dashboard  ", url: "https://example.com/billing///" },
    ];
    const documents = variations.map((variation) => {
      const result = buildSemanticDocument(source(1, 1, { ...variation, groupName: null }), DEFAULT_PRIVACY_SETTINGS);
      if (result.status !== "ready") throw new Error("Expected a ready document.");
      return result.document;
    });
    expect(new Set(documents).size).toBe(1);
    expect(documents[0]).toBe("Title: billing dashboard\nHost: example.com\nPath: /billing");
  });

  it("normalizes case and path shape without changing what the sanitizer redacted", () => {
    const result = buildSemanticDocument(source(1, 1, {
      title: "Invoice ACCT-123456789 for Person@Example.COM",
      url: "https://example.com/orders/123456789/",
      groupName: null,
    }), DEFAULT_PRIVACY_SETTINGS);
    if (result.status !== "ready") throw new Error("Expected a ready document.");
    // Redaction still runs first, so placeholders survive the case fold intact.
    expect(result.document).toContain(":number");
    expect(result.document).toContain(":email");
    expect(result.document).not.toContain("123456789");
    expect(result.document).not.toContain("Person@Example.COM");
    expect(result.document).toBe(
      "Title: invoice acct-:number for :email\nHost: example.com\nPath: /orders/:number",
    );
  });

  it("separates a path that only differs by a trailing slash from a distinct one", () => {
    const withoutSlash = buildSemanticDocument(source(1, 1, {
      title: "Docs",
      url: "https://example.com/guide/intro",
      groupName: null,
    }), DEFAULT_PRIVACY_SETTINGS);
    const withSlash = buildSemanticDocument(source(1, 1, {
      title: "Docs",
      url: "https://example.com/guide/intro/",
      groupName: null,
    }), DEFAULT_PRIVACY_SETTINGS);
    const different = buildSemanticDocument(source(1, 1, {
      title: "Docs",
      url: "https://example.com/guide/advanced",
      groupName: null,
    }), DEFAULT_PRIVACY_SETTINGS);
    if (withoutSlash.status !== "ready" || withSlash.status !== "ready" || different.status !== "ready") {
      throw new Error("Expected ready documents.");
    }
    expect(withSlash.document).toBe(withoutSlash.document);
    expect(different.document).not.toBe(withoutSlash.document);
    // A root path is not stripped to an empty one.
    expect(buildSemanticDocument(source(1, 1, {
      title: "Root",
      url: "https://example.com/",
      groupName: null,
    }), DEFAULT_PRIVACY_SETTINGS)).toMatchObject({ document: "Title: root\nHost: example.com\nPath: /" });
  });

  it("changes compatibility and embedding keys only across relevant boundaries", async () => {
    const config = { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1" };
    const first = await computeSemanticCompatibilityKey(config, DEFAULT_PRIVACY_SETTINGS);
    const same = await computeSemanticCompatibilityKey({ ...config, customHeaders: {} }, { ...DEFAULT_PRIVACY_SETTINGS });
    const changed = await computeSemanticCompatibilityKey({ ...config, model: "embed-v2" }, DEFAULT_PRIVACY_SETTINGS);
    const changedResolvedDimensions = await computeSemanticCompatibilityKey(config, DEFAULT_PRIVACY_SETTINGS, 4096);
    const firstHeader = await computeSemanticCompatibilityKey({ ...config, customHeaders: { "x-route": "deployment-a" } }, DEFAULT_PRIVACY_SETTINGS);
    const changedHeader = await computeSemanticCompatibilityKey({ ...config, customHeaders: { "X-Route": "deployment-b" } }, DEFAULT_PRIVACY_SETTINGS);
    const changedRouting = await computeSemanticCompatibilityKey({ ...config, openRouter: { zdr: true } }, DEFAULT_PRIVACY_SETTINGS);
    expect(first).toBe(same);
    expect(changed).not.toBe(first);
    expect(changedResolvedDimensions).not.toBe(first);
    expect(changedHeader).not.toBe(firstHeader);
    expect(changedRouting).not.toBe(first);
    expect(await computeSemanticEmbeddingKey(first, "Title: One")).not.toBe(
      await computeSemanticEmbeddingKey(first, "Title: Two"),
    );
  });

  it("takes group titles from the search consent, not from the organizer setting", async () => {
    // Two promises: the organizer flag governs the organizer prompt, the search
    // consent governs the index. Neither may move the other, in either direction.
    expect(semanticDocumentPrivacy({ ...DEFAULT_PRIVACY_SETTINGS, includeExistingGroups: false }, true))
      .toMatchObject({ includeExistingGroups: true });
    expect(semanticDocumentPrivacy({ ...DEFAULT_PRIVACY_SETTINGS, includeExistingGroups: true }, false))
      .toMatchObject({ includeExistingGroups: false });
    const config = { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1" };
    const baseline = await computeSemanticCompatibilityKey(config, semanticDocumentPrivacy(DEFAULT_PRIVACY_SETTINGS, false));
    expect(await computeSemanticCompatibilityKey(config, semanticDocumentPrivacy({ ...DEFAULT_PRIVACY_SETTINGS, includeExistingGroups: true }, false)))
      .toBe(baseline);
    expect(await computeSemanticCompatibilityKey(config, semanticDocumentPrivacy(DEFAULT_PRIVACY_SETTINGS, true)))
      .not.toBe(baseline);
    // Allow and deny rules still come from the privacy settings, untouched by the view.
    expect(semanticDocumentPrivacy({ ...DEFAULT_PRIVACY_SETTINGS, denylist: ["*.example"], includeExistingGroups: true }, false))
      .toMatchObject({ denylist: ["*.example"] });
  });

  it("keeps long group titles in the index while the organizer prompt keeps its own cap", () => {
    const tab = source(1, 1, {
      title: "Search rework",
      url: "https://example.com/x",
      groupName: "Sheaf search rework planning notes",
    });
    const indexed = buildSemanticDocument(tab, semanticDocumentPrivacy(DEFAULT_PRIVACY_SETTINGS, true));
    if (indexed.status !== "ready") throw new Error("Expected a ready document.");
    expect(indexed.document).toContain("Group: sheaf search rework planning notes");
    // 34 characters: truncated at 24 today, and this is the field that measurably
    // carries topic intent, so the search index gets the longer cap.
    expect(sanitizeGroupTitle(tab.groupName!)).toHaveLength(24);
    expect(sanitizeGroupTitle(tab.groupName!, LIMITS.MAX_SEARCH_GROUP_TITLE_CHARS))
      .toBe("Sheaf search rework planning notes");
    // And with the consent off, the compatible-key view omits groups entirely.
    const withoutConsent = buildSemanticDocument(tab, semanticDocumentPrivacy(DEFAULT_PRIVACY_SETTINGS, false));
    expect(withoutConsent).toMatchObject({ document: "Title: search rework\nHost: example.com\nPath: /x" });
  });
});

describe("semantic source capture", () => {
  it("excludes incognito tabs and maps permitted group titles", () => {
    const tabs = [
      { id: 1, windowId: 2, incognito: false, title: "Normal", url: "https://example.com", groupId: 10 },
      { id: 2, windowId: 3, incognito: true, title: "Private", url: "https://secret.example.com", groupId: -1 },
    ] as chrome.tabs.Tab[];
    const groups = [{ id: 10, title: "Research" }] as chrome.tabGroups.TabGroup[];
    expect(semanticSourcesFromChromeTabs(tabs, groups)).toEqual([{
      mappingKey: "window:2:tab:1",
      target: { kind: "open", tabId: 1, windowId: 2 },
      title: "Normal",
      url: "https://example.com",
      groupName: "Research",
    }]);
  });

  it("waits for both useful title and URL metadata before indexing a new tab", () => {
    const tabs = [
      { id: 1, windowId: 2, incognito: false, title: "", url: "https://example.com", groupId: -1 },
      { id: 2, windowId: 2, incognito: false, title: "Loaded", url: "", groupId: -1 },
      { id: 3, windowId: 2, incognito: false, title: "Ready", url: "https://example.com", groupId: -1 },
    ] as chrome.tabs.Tab[];
    expect(semanticSourcesFromChromeTabs(tabs, [])).toEqual([expect.objectContaining({
      mappingKey: "window:2:tab:3",
    })]);
  });

  it("captures replayable stashes with collision-free targets and skips interrupted stashes", () => {
    const base = {
      id: "saved",
      name: "Saved reading",
      createdAt: 1,
      updatedAt: 1,
      note: "",
      revisions: [], lastOpenedAt: null,
      activeWorkspaceId: null,
      scope: { mode: "window" as const },
      status: "saved" as const,
      groups: [{ key: "g1", title: "Reference", color: "blue" as const, collapsed: false, sourceGroupId: 4, sourceIndex: 0 }],
      tabs: [{ sourceTabId: 1, sourceIndex: 0, title: "Guide", url: "https://example.com/guide", groupKey: "g1" }],
      excludedTabs: [],
      closeConflicts: [],
      restoreResult: null,
    };
    expect(semanticSourcesFromStashes([base])).toEqual([{
      mappingKey: "stash:saved:tab:0",
      target: { kind: "stash", stashId: "saved", sourceIndex: 0 },
      title: "Guide",
      url: "https://example.com/guide",
      groupName: "Reference",
    }]);
    expect(semanticSourcesFromStashes([{ ...base, id: "broken", status: "closing_interrupted" }])).toEqual([]);
  });

  it("retries only transient provider failures", () => {
    expect(["timeout", "network", "rate_limited", "provider_unavailable"].every(isRetryableSemanticErrorCode)).toBe(true);
    expect(["authentication", "insufficient_balance", "provider_rejected", "invalid_response", "index_runtime"]
      .some(isRetryableSemanticErrorCode)).toBe(false);
  });
});

describe("semantic index planning", () => {
  it("switches mapping reads at the one-third density crossover", () => {
    expect(shouldReadAllSemanticMappings(2_999, 10_000)).toBe(false);
    expect(shouldReadAllSemanticMappings(3_334, 10_000)).toBe(true);
    expect(shouldReadAllSemanticMappings(101, 100)).toBe(false);
    expect(shouldReadAllSemanticMappings(10)).toBe(false);
  });

  it("reconciles only canonical mapping changes and ignores timestamps", () => {
    const current: SemanticTabRecord[] = [{
      mappingKey: "window:1:tab:1",
      target: { kind: "open", tabId: 1, windowId: 1 },
      documentHash: "same",
      embeddingKey: "vector",
      status: "ready",
      updatedAt: 1,
    }];
    expect(semanticMappingsChanged(current, [{ ...current[0]!, updatedAt: 2 }])).toBe(false);
    expect(semanticMappingsChanged(current, [{ ...current[0]!, status: "pending", updatedAt: 2 }])).toBe(false);
    expect(semanticMappingsChanged(current, [{ ...current[0]!, documentHash: "changed", updatedAt: 2 }])).toBe(true);
    expect(semanticMappingsChanged(current, [])).toBe(true);
  });

  it("deduplicates documents while retaining separate tab mappings", async () => {
    const config = { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1" };
    const sources = [
      source(1, 9, { title: "Same", url: "https://example.com/guide", groupName: null }),
      source(2, 9, { title: "Same", url: "https://example.com/guide", groupName: null }),
    ];
    const first = await createSemanticIndexPlan(sources, DEFAULT_PRIVACY_SETTINGS, config, new Set(), 10);
    expect(first.mappings).toHaveLength(2);
    expect(first.queue).toHaveLength(1);
    expect(first.queue[0]?.mappingKeys).toHaveLength(2);
    expect(first.meta).toMatchObject({ total: 2, pending: 2, cacheHits: 0, cacheMisses: 2 });

    const cached = new Set([first.queue[0]!.key]);
    const second = await createSemanticIndexPlan(sources, DEFAULT_PRIVACY_SETTINGS, config, cached, 20);
    expect(second.queue).toHaveLength(0);
    expect(second.mappings.every((mapping) => mapping.status === "ready")).toBe(true);
    expect(second.meta).toMatchObject({ ready: 2, pending: 0, cacheHits: 2, cacheMisses: 0 });
  });

  it("freezes current-window index identity in metadata", async () => {
    const plan = await createSemanticIndexPlan(
      [source(1, 9, { title: "One", url: "https://example.com/one", groupName: null })],
      DEFAULT_PRIVACY_SETTINGS,
      { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1" },
      new Set(),
      10,
      null,
      { indexScope: "current_window", targetWindowId: 9 },
    );
    expect(plan.meta).toMatchObject({ indexScope: "current_window", targetWindowId: 9 });
    expect(plan.queue[0]).not.toHaveProperty("indexScope");
  });

  it("normalizes document vectors and rejects unusable vectors", () => {
    expect([...normalizeEmbeddingVector(Float32Array.from([3, 4]))]).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(() => normalizeEmbeddingVector(Float32Array.from([0, 0]))).toThrow(/cannot be normalized/i);
    expect(() => normalizeEmbeddingVector(Float32Array.from([Number.NaN, 1]))).toThrow(/non-finite/i);
  });
});
