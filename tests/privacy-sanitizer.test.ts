import { describe, expect, it } from "vitest";
import { normalizeDomainRules } from "../src/privacy/domain-policy";
import { buildSanitizedRequest, serializeOrganizationRequest } from "../src/privacy/request-builder";
import { sanitizeTabTitleForProvider, sanitizeText } from "../src/privacy/sanitize-text";
import { sanitizePublicLocation } from "../src/privacy/sanitize-url";
import type { PrivacySettings } from "../src/shared/organizer-types";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";

function tab(
  id: number,
  index: number,
  url: string,
  overrides: Partial<SemanticTab> = {},
): SemanticTab {
  return {
    id,
    windowId: 7,
    index,
    title: ` Tab ${id}\u202e  title `,
    url,
    groupId: -1,
    active: id === 1,
    pinned: false,
    audible: id === 2,
    openerTabId: null,
    lastAccessed: 1_000_000,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
    ...overrides,
  };
}

function state(tabs: SemanticTab[]): SemanticWindowState {
  return {
    windowId: 7,
    capturedAt: 1_000_000,
    tabs,
    groups: [],
    eligibleTabIds: tabs.filter((item) => item.protectionReasons.length === 0).map((item) => item.id),
    protectedTabIds: tabs.filter((item) => item.protectionReasons.length > 0).map((item) => item.id),
    featureSupport: {
      sharedGroupProperty: true,
      splitViewIdProperty: true,
      storageSession: true,
    },
  };
}

function withGroups(
  snapshot: SemanticWindowState,
  groups: SemanticGroup[],
): SemanticWindowState {
  return { ...snapshot, groups };
}

const settings: PrivacySettings = {
  level: 2,
  includeExistingGroups: false,
  allowLocalNetworkTabs: false,
  allowFileTabs: false,
  closeInactiveBlankTabs: false,
  allowlist: [],
  denylist: [],
};

describe("privacy text and URL sanitization", () => {
  it("removes control and bidi formatting characters", () => {
    expect(sanitizeText(" hello\u0000  world\u202e ", 100)).toBe("hello world");
  });

  it("does not let URL-like browser titles bypass safe-route redaction", () => {
    const unsafeTitle = "accounts.google.com/info/sessionexpired?TL=A6Fvya9tYsbm0gEXNovbtp8TpAMs5rSOiakuDv6I92X9_aQJtfPDf3yNg5B9LrX&checkConnection=youtube%3A529&continue=https%3A%2F%2Fdrive.google.com%3Fauthuser%3D6";
    expect(
      sanitizeTabTitleForProvider(
        unsafeTitle,
        "accounts.google.com/info/sessionexpired",
      ),
    ).toBe("accounts.google.com/info/sessionexpired");
    expect(
      sanitizeTabTitleForProvider(
        "Reset alice@example.com order 123456 token Ab3dE5fG7hJ9kL2mN4pQ",
        "example.com/reset",
      ),
    ).toBe("Reset :email order :number token :token");
  });

  it("strips query strings and fragments from titles that are not full URLs", () => {
    expect(
      sanitizeTabTitleForProvider("Checkout?session=SECRETVALUE", "shop.example.com/cart"),
    ).toBe("Checkout");
    expect(
      sanitizeTabTitleForProvider("Receipt #SECRETFRAGMENT", "shop.example.com/cart"),
    ).toBe("Receipt");
  });

  it("treats scheme, host:port, IP-literal, and non-ASCII hosts as location-bearing", () => {
    const cases: Array<[string, string]> = [
      ["See:example.com/secret?token=x", "example.com/secret"],
      ["192.168.1.5:8080/reset?token=SECRETVALUE123", "192.168.1.5/reset"],
      ["localhost:5173/admin?token=x", "localhost/admin"],
      ["пример.рф/secret?token=abc", "пример.рф/secret"],
      ["https://example.com/secret?token=x", "example.com/secret"],
    ];
    for (const [title, label] of cases) {
      expect(sanitizeTabTitleForProvider(title, label)).toBe(label);
    }
  });

  it("keeps the query out of the exact provider request for URL-shaped titles", () => {
    const bundle = buildSanitizedRequest(
      state([tab(1, 0, "https://shop.example.com/cart", { title: "Checkout?session=SECRETVALUE" })]),
      settings,
    );
    expect(bundle.approvedRequest.tabs[0]?.title).toBe("Checkout");
    expect(bundle.requestJson).not.toContain("SECRETVALUE");
  });

  it("derives private-suffix-aware registrable domains and removes query data", () => {
    expect(
      sanitizePublicLocation(
        "https://user:secret@project.github.io/issues/123456?token=secret#private",
        2,
      ),
    ).toEqual({
      hostname: "project.github.io",
      domain: "project.github.io",
      path: "/issues/:number",
    });
  });

  it("applies all three metadata levels", () => {
    const url = "https://docs.example.co.uk/team/550e8400-e29b-41d4-a716-446655440000?q=x#y";
    expect(sanitizePublicLocation(url, 1)).toEqual({
      hostname: "docs.example.co.uk",
      domain: "example.co.uk",
    });
    expect(sanitizePublicLocation(url, 2).path).toBe("/team/:uuid");
    // Level 3 keeps the path verbatim except for identifier redaction — it is
    // a strict superset of level 2's redaction, not a way around it.
    expect(sanitizePublicLocation(url, 3).path).toBe("/team/:uuid");
    expect(sanitizePublicLocation("https://docs.example.co.uk/team/quarterly-report", 3).path).toBe(
      "/team/quarterly-report",
    );
    expect(
      sanitizePublicLocation(
        "https://example.com/session/aB3dE5fG7hJ9kL2mN4pQ",
        2,
      ).path,
    ).toBe("/session/:token");
  });

  it("redacts identifiers in existing group names", () => {
    const grouped = tab(1, 0, "https://shop.example.com/cart", { groupId: 42 });
    const snapshot = withGroups(state([grouped]), [{
      runtimeId: 42,
      windowId: 7,
      title: "Client boss@acme-example.com rollout",
      color: "blue",
      collapsed: false,
      shared: { known: true, value: false },
      memberTabIds: [1],
      firstTabIndex: 0,
      protectionReasons: [],
    }]);
    const bundle = buildSanitizedRequest(snapshot, { ...settings, includeExistingGroups: true });
    expect(bundle.approvedRequest.tabs[0]?.existingGroup).toBe("Client :email rollout");
    expect(bundle.requestJson).not.toContain("boss@acme-example.com");
  });

  it("keeps readable route context while redacting identifiers inside mixed slugs", () => {
    expect(
      sanitizePublicLocation(
        "https://classroom.example.com/courses/Physics%20Class/lesson-123456/550e8400-e29b-41d4-a716-446655440000-notes",
        2,
      ),
    ).toEqual({
      hostname: "classroom.example.com",
      domain: "example.com",
      path: "/courses/Physics Class/lesson-:number/:uuid-notes",
    });
    expect(
      sanitizePublicLocation("https://example.com/users/alice@example.com/profile", 2).path,
    ).toBe("/users/:email/profile");
    expect(
      sanitizePublicLocation("https://example.com/courses/physics-class-101", 2).path,
    ).toBe("/courses/physics-class-101");
  });
});

describe("immutable request builder", () => {
  it("marks less recently used exact-URL duplicates without matching redacted lookalikes", () => {
    const snapshot = state([
      tab(10, 0, "https://docs.example.com/d/abc123/edit#heading=1", { lastAccessed: 500, active: false }),
      tab(11, 1, "https://docs.example.com/d/abc123/edit", { lastAccessed: 900, active: false }),
      tab(12, 2, "https://docs.example.com/d/xyz789/edit", { lastAccessed: 100, active: false }),
      tab(13, 3, "https://docs.example.com/d/abc123/edit", { lastAccessed: 100, active: true }),
    ]);
    const bundle = buildSanitizedRequest(snapshot, settings, 1_000_000);

    expect(bundle.approvedRequest.tabs.map((item) => item.duplicateOfTabId)).toEqual([4, 4, undefined, undefined]);
  });

  it("uses ephemeral IDs, submitted-only opener IDs, and a deeply frozen exact object", () => {
    const snapshot = state([
      tab(41, 0, "https://alpha.example.com/a", { openerTabId: 777 }),
      tab(99, 1, "https://beta.example.org/b", { openerTabId: 41 }),
    ]);
    const bundle = buildSanitizedRequest(snapshot, settings, 1_000_000 + 25 * 60_000);

    expect(bundle.submittedTabIds).toEqual([1, 2]);
    expect(bundle.ephemeralToBrowserTabId).toEqual({ 1: 41, 2: 99 });
    expect(bundle.approvedRequest.tabs[0]).not.toHaveProperty("openerTabId");
    expect(bundle.approvedRequest.tabs[1]?.openerTabId).toBe(1);
    expect(bundle.approvedRequest.tabs[0]?.recencyBucket).toBe("20_to_59_minutes");
    expect(bundle.approvedRequest.tabs[0]?.hostname).toBe("alpha.example.com");
    expect(bundle.approvedRequest.tabs.map((tab) => tab.isCurrentlyGrouped)).toEqual([false, false]);
    expect(bundle.approvedRequest.tabs[0]?.inactiveForMinutes).toBe(25);
    expect(bundle.approvedRequest.tabs[0]?.meetsLowValueInactivityThreshold).toBe(false);
    expect(bundle.approvedRequest.inactivityPolicy).toEqual({
      generalSuggestionAfterHours: 24,
      lowValueSuggestionAfterHours: 6,
      closingRequiresManualReview: true,
    });
    expect(bundle.approvedRequest.groupColorMode).toBe("deterministic");
    expect(bundle.requestJson).toBe(serializeOrganizationRequest(bundle.approvedRequest));
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.approvedRequest.tabs)).toBe(true);
    expect(Object.isFrozen(bundle.approvedRequest.tabs[0])).toBe(true);
    expect(bundle.requestJson).not.toContain("?token");
  });

  it("serializes one compact tab object per line inside a readable envelope", () => {
    const bundle = buildSanitizedRequest(
      state([tab(1, 0, "https://a.example/one"), tab(2, 1, "https://b.example/two")]),
      settings,
    );
    const lines = bundle.requestJson.split("\n");
    expect(JSON.parse(bundle.requestJson)).toEqual(bundle.approvedRequest);
    expect(lines).toContain('  "schemaVersion": 1,');
    expect(lines).toContain(`    ${JSON.stringify(bundle.approvedRequest.tabs[0])},`);
    expect(lines).toContain(`    ${JSON.stringify(bundle.approvedRequest.tabs[1])}`);
    expect(bundle.requestJson.endsWith("\n  ]\n}")).toBe(true);
    expect(bundle.byteLength).toBeLessThan(
      JSON.stringify(bundle.approvedRequest, null, 2).length,
    );
  });

  it("keeps exact hostnames out of domain-only requests", () => {
    const bundle = buildSanitizedRequest(
      state([tab(1, 0, "https://docs.example.com/guides/start")]),
      { ...settings, level: 1 },
    );
    expect(bundle.approvedRequest.tabs[0]).toMatchObject({ domain: "example.com" });
    expect(bundle.approvedRequest.tabs[0]).not.toHaveProperty("hostname");
    expect(bundle.approvedRequest.tabs[0]).not.toHaveProperty("path");
  });

  it("removes query-bearing URL titles from the exact provider request", () => {
    const unsafeTitle = "accounts.google.com/info/sessionexpired?TL=A6Fvya9tYsbm0gEXNovbtp8TpAMs5rSOiakuDv6I92X9_aQJtfPDf3yNg5B9LrX&continue=https%3A%2F%2Fdrive.google.com%3Fauthuser%3D6";
    const bundle = buildSanitizedRequest(
      state([tab(1, 0, "https://accounts.google.com/info/sessionexpired?TL=raw-secret", { title: unsafeTitle })]),
      settings,
    );
    expect(bundle.approvedRequest.tabs[0]?.title).toBe("accounts.google.com/info/sessionexpired");
    expect(bundle.requestJson).not.toContain("TL=");
    expect(bundle.requestJson).not.toContain("drive.google.com");
    expect(bundle.requestJson).not.toContain("authuser");
  });

  it("always exposes group membership without exposing group names", () => {
    const snapshot = withGroups(
      state([
        tab(1, 0, "https://example.com/grouped", { groupId: 10 }),
        tab(2, 1, "https://example.com/ungrouped"),
      ]),
      [{ runtimeId: 10, windowId: 7, title: "Private project", color: "blue", collapsed: false, shared: { known: true, value: false }, memberTabIds: [1], firstTabIndex: 0, protectionReasons: [] }],
    );
    const bundle = buildSanitizedRequest(snapshot, settings);

    expect(bundle.approvedRequest.tabs).toMatchObject([
      { isCurrentlyGrouped: true },
      { isCurrentlyGrouped: false },
    ]);
    expect(bundle.requestJson).not.toContain("Private project");
  });

  it("includes configured inactivity periods in the exact provider request", () => {
    const bundle = buildSanitizedRequest(
      state([tab(1, 0, "https://example.com/")]),
      settings,
      1_000_000,
      {
        inactiveSuggestionHours: 72,
        lowValueSuggestionHours: 12,
        includeInactivityDuration: true,
      },
    );
    expect(bundle.approvedRequest.inactivityPolicy).toEqual({
      generalSuggestionAfterHours: 72,
      lowValueSuggestionAfterHours: 12,
      closingRequiresManualReview: true,
    });
    expect(bundle.requestJson).toContain('"generalSuggestionAfterHours": 72');
    expect(bundle.requestJson).toContain('"lowValueSuggestionAfterHours": 12');
  });

  it("freezes optional AI color selection into the provider request", () => {
    const bundle = buildSanitizedRequest(
      state([tab(1, 0, "https://example.com/")]),
      settings,
      1_000_000,
      {
        inactiveSuggestionHours: 24,
        lowValueSuggestionHours: 6,
        includeInactivityDuration: true,
        aiGroupColors: true,
      },
    );
    expect(bundle.approvedRequest.groupColorMode).toBe("ai");
    expect(bundle.requestJson).toContain('"groupColorMode": "ai"');
  });

  it("precomputes the low-value inactivity boundary without model arithmetic", () => {
    const thresholdStart = 1_000_000;
    const thresholdMs = 6 * 60 * 60_000;
    const bundle = buildSanitizedRequest(
      state([
        tab(3, 0, "https://example.com/just-under", { lastAccessed: thresholdStart + 1 }),
        tab(4, 1, "https://example.com/at-threshold", { lastAccessed: thresholdStart }),
      ]),
      settings,
      thresholdStart + thresholdMs,
    );

    expect(bundle.approvedRequest.tabs).toMatchObject([
      { inactiveForMinutes: 359, meetsLowValueInactivityThreshold: false },
      { inactiveForMinutes: 360, meetsLowValueInactivityThreshold: true },
    ]);
    expect(bundle.requestJson).toContain('"meetsLowValueInactivityThreshold":true');
  });

  it("omits elapsed inactivity when the user disables it", () => {
    const bundle = buildSanitizedRequest(
      state([tab(1, 0, "https://example.com/")]),
      settings,
      2_000_000,
      {
        inactiveSuggestionHours: 24,
        lowValueSuggestionHours: 6,
        includeInactivityDuration: false,
      },
    );
    expect(bundle.approvedRequest.tabs[0]).not.toHaveProperty("inactiveForMinutes");
    expect(bundle.approvedRequest.tabs[0]).not.toHaveProperty("meetsLowValueInactivityThreshold");
  });

  it("applies denylist before allowlist and records exclusions", () => {
    const snapshot = state([
      tab(1, 0, "https://docs.example.com/a"),
      tab(2, 1, "https://work.example.org/b"),
      tab(3, 2, "https://private.example.net/c"),
    ]);
    const bundle = buildSanitizedRequest(snapshot, {
      ...settings,
      allowlist: ["*.example.com", "example.org"],
      denylist: ["docs.example.com"],
    });

    expect(bundle.ephemeralToBrowserTabId).toEqual({ 1: 2 });
    expect(bundle.excludedTabs.map((item) => item.reason)).toEqual([
      "Domain is excluded by the privacy denylist",
      "Domain is not included in the privacy allowlist",
    ]);
  });

  it("never submits protected tabs", () => {
    const snapshot = state([
      tab(1, 0, "https://example.com/a", { protectionReasons: ["Pinned tab"] }),
      tab(2, 1, "https://example.org/b"),
    ]);
    const bundle = buildSanitizedRequest(snapshot, settings);
    expect(bundle.ephemeralToBrowserTabId).toEqual({ 1: 2 });
    expect(bundle.excludedTabs[0]).toMatchObject({
      browserTabId: 1,
      reason: "Pinned tab",
    });
  });

  it("enforces never-move rules before transmission and exposes sanitized rules", () => {
    const snapshot = state([
      tab(1, 0, "https://meet.google.com/abc-defg-hij"),
      tab(2, 1, "https://shop.example/toys/item"),
    ]);
    const bundle = buildSanitizedRequest(
      snapshot,
      settings,
      1_000_000,
      undefined,
      undefined,
      [
        { id: "keep", kind: "keep_location", locationPattern: "google.com/*" },
        { id: "assign", kind: "assign_location", locationPattern: "shop.example/toys/*", groupName: "Toy catalog" },
      ],
    );

    expect(bundle.ephemeralToBrowserTabId).toEqual({ 1: 2 });
    expect(bundle.excludedTabs).toMatchObject([
      { browserTabId: 1, reason: "User rule: never move this location" },
    ]);
    expect(bundle.approvedRequest.organizerRules).toEqual([
      { kind: "keep_location", locationPattern: "google.com/*" },
      { kind: "assign_location", locationPattern: "shop.example/toys/*", groupName: "Toy catalog" },
    ]);
    expect(bundle.requestJson).not.toContain('"id": "keep"');
    expect(bundle.requestJson).not.toContain('"id": "assign"');
  });

  it("sends only repeatedly approved group names as preferred vocabulary", () => {
    const bundle = buildSanitizedRequest(
      state([tab(1, 0, "https://example.com/a")]),
      settings,
      1,
      undefined,
      undefined,
      [],
      [
        { name: "Toy catalog", approvalCount: 3, lastApprovedAt: 20 },
        { name: "Physics class", approvalCount: 1, lastApprovedAt: 30 },
      ],
    );
    expect(bundle.approvedRequest.preferredGroupNames).toEqual(["Toy catalog"]);
    expect(bundle.requestJson).not.toContain("approvalCount");
    expect(bundle.requestJson).not.toContain("lastApprovedAt");
  });

  it("limits selected-tab requests to native highlighted tabs", () => {
    const snapshot = state([
      tab(1, 0, "https://example.com/a", { highlighted: true }),
      tab(2, 1, "https://example.com/b", { highlighted: false }),
      tab(3, 2, "https://example.com/c", { highlighted: true }),
    ]);
    const bundle = buildSanitizedRequest(
      snapshot,
      settings,
      1_000_000,
      undefined,
      { mode: "selected_tabs" },
    );

    expect(bundle.ephemeralToBrowserTabId).toEqual({ 1: 1, 2: 3 });
    expect(bundle.scope).toEqual({ mode: "selected_tabs" });
    expect(bundle.outOfScopeTabCount).toBe(1);
  });

  it("supports one group, ungrouped tabs, and explicit group exclusions", () => {
    const snapshot = withGroups(
      state([
        tab(1, 0, "https://example.com/a", { groupId: 10 }),
        tab(2, 1, "https://example.com/b", { groupId: 10 }),
        tab(3, 2, "https://example.com/c", { groupId: 20 }),
        tab(4, 3, "https://example.com/d"),
      ]),
      [
        { runtimeId: 10, windowId: 7, title: "First", color: "blue", collapsed: false, shared: { known: true, value: false }, memberTabIds: [1, 2], firstTabIndex: 0, protectionReasons: [] },
        { runtimeId: 20, windowId: 7, title: "Second", color: "red", collapsed: false, shared: { known: true, value: false }, memberTabIds: [3], firstTabIndex: 2, protectionReasons: [] },
      ],
    );

    expect(buildSanitizedRequest(snapshot, settings, 1, undefined, { mode: "group", groupId: 10 }).ephemeralToBrowserTabId).toEqual({ 1: 1, 2: 2 });
    expect(buildSanitizedRequest(snapshot, settings, 1, undefined, { mode: "ungrouped" }).ephemeralToBrowserTabId).toEqual({ 1: 4 });
    expect(buildSanitizedRequest(snapshot, settings, 1, undefined, { mode: "exclude_groups", groupIds: [10] }).ephemeralToBrowserTabId).toEqual({ 1: 3, 2: 4 });
  });

  it("requires a concrete selection for partial scopes", () => {
    const snapshot = state([
      tab(1, 0, "https://example.com/a", { highlighted: false }),
    ]);
    expect(() => buildSanitizedRequest(snapshot, settings, 1, undefined, { mode: "selected_tabs" })).toThrow("No highlighted tabs");
    expect(() => buildSanitizedRequest(snapshot, settings, 1, undefined, { mode: "exclude_groups", groupIds: [] })).toThrow("Choose at least one group");
  });

  it("submits explicitly allowed local topics without exposing file paths", () => {
    const snapshot = state([
      tab(1, 0, "http://localhost:5173/projects/sheaf?token=secret"),
      tab(2, 1, "https://192.168.1.20/home/overview"),
      tab(3, 2, "file:///Users/example/Private Plan.html"),
    ]);
    const bundle = buildSanitizedRequest(snapshot, {
      ...settings,
      allowLocalNetworkTabs: true,
      allowFileTabs: true,
    });

    expect(bundle.approvedRequest.tabs).toMatchObject([
      { domain: "localhost", path: "/projects/sheaf" },
      { domain: "192.168.1.20", path: "/home/overview" },
      { domain: "local-file" },
    ]);
    expect(bundle.requestJson).not.toContain("Users/example");
    expect(bundle.requestJson).not.toContain("token=secret");
  });

  it("normalizes domain rules deterministically", () => {
    expect(
      normalizeDomainRules([" *.Example.com ", "https://docs.example.org/path", "example.com"]),
    ).toEqual(["*.example.com", "docs.example.org", "example.com"]);
  });

  it("fails before transmission when more than 200 tabs are eligible", () => {
    const tabs = Array.from({ length: 201 }, (_, index) =>
      tab(index + 1, index, `https://site${index}.example.com/path`),
    );
    expect(() => buildSanitizedRequest(state(tabs), settings)).toThrow(/at most 200/);
  });
});
