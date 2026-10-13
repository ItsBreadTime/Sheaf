import { describe, expect, it } from "vitest";
import {
  applyClutterRules,
  isProtectedFromClutter,
  locationMatchesPattern,
  normalizeOrganizerRules,
  ruleMatchesTab,
  sanitizeOrganizerRules,
} from "../src/organizer/rules";

describe("visible organizer correction rules", () => {
  it("matches exact hostnames while retaining registrable-domain rules", () => {
    const tab = {
      id: 1,
      title: "Meet",
      hostname: "meet.google.com",
      domain: "google.com",
      path: "/room",
      recencyBucket: "unknown" as const,
      isActive: false,
      isAudible: false,
    };
    expect(ruleMatchesTab({ locationPattern: "meet.google.com/*" }, tab)).toBe(true);
    expect(ruleMatchesTab({ locationPattern: "google.com/*" }, tab)).toBe(true);
  });

  it("normalizes structured rules and removes local IDs from provider data", () => {
    const rules = normalizeOrganizerRules([
      { id: "one", kind: "assign_location", locationPattern: " Example.com/Docs/* ", groupName: " Work " },
      { id: "two", kind: "keep_location", locationPattern: "meet.google.com/*" },
      { id: "bad", kind: "rename_group", fromName: "", toName: "Nothing" },
    ]);

    expect(rules).toEqual([
      { id: "one", kind: "assign_location", locationPattern: "example.com/docs/*", groupName: "Work" },
      { id: "two", kind: "keep_location", locationPattern: "meet.google.com/*" },
    ]);
    expect(sanitizeOrganizerRules(rules)).toEqual([
      { kind: "assign_location", locationPattern: "example.com/docs/*", groupName: "Work" },
      { kind: "keep_location", locationPattern: "meet.google.com/*" },
    ]);
  });

  it("matches editable wildcard patterns without treating punctuation as regex", () => {
    expect(locationMatchesPattern("shop.example/toys/item", "shop.example/toys/*")).toBe(true);
    expect(locationMatchesPattern("shopXexample/toys/item", "shop.example/toys/*")).toBe(false);
    expect(locationMatchesPattern("meet.google.com/*", "meet.google.com/*")).toBe(true);
  });

  it("matches pathological wildcard patterns in linear time", () => {
    const pattern = `${"a*".repeat(40)}b`;
    const value = `${"a".repeat(400)}c`;
    const started = Date.now();
    expect(locationMatchesPattern(value, pattern)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("dedupes rule ids that collide only after truncation", () => {
    const prefix = "x".repeat(100);
    const rules = normalizeOrganizerRules([
      { id: `${prefix}one`, kind: "keep_location", locationPattern: "a.example.com/*" },
      { id: `${prefix}two`, kind: "keep_location", locationPattern: "b.example.com/*" },
    ]);
    // Both truncate to the same stored id, so the second is dropped rather than
    // emitted as a duplicate key.
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      id: "x".repeat(100),
      kind: "keep_location",
      locationPattern: "a.example.com/*",
    });
  });

  it("enforces never-clutter rules after provider validation", () => {
    const proposal = {
      schemaVersion: 1 as const,
      groups: [],
      untouchedTabIds: [1, 2],
      lowValueTabIds: [1, 2],
    };
    const adjusted = applyClutterRules(
      proposal,
      [
        { id: 1, title: "Keep", domain: "docs.example.com", path: "/guide", recencyBucket: "over_24_hours", meetsLowValueInactivityThreshold: true, isActive: false, isAudible: false },
        { id: 2, title: "Maybe", domain: "example.org", path: "/old", recencyBucket: "over_24_hours", meetsLowValueInactivityThreshold: true, isActive: false, isAudible: false },
      ],
      [{ kind: "never_clutter_location", locationPattern: "docs.example.com/*" }],
    );

    expect(adjusted.lowValueTabIds).toEqual([2]);
    expect(proposal.lowValueTabIds).toEqual([1, 2]);
  });

  it("drops clutter flags on tabs the request marks ineligible", () => {
    const tab = (id: number, overrides: Record<string, unknown>) => ({
      id, title: `Tab ${id}`, domain: "example.org", recencyBucket: "over_24_hours" as const,
      meetsLowValueInactivityThreshold: true, isActive: false, isAudible: false, ...overrides,
    });
    const adjusted = applyClutterRules(
      { schemaVersion: 1, groups: [], untouchedTabIds: [1, 2, 3, 4, 5], lowValueTabIds: [1, 2, 3, 4, 5] },
      [
        tab(1, {}),
        tab(2, { meetsLowValueInactivityThreshold: false }),
        tab(3, { meetsLowValueInactivityThreshold: undefined }),
        tab(4, { isActive: true }),
        tab(5, { isAudible: true }),
      ],
      [],
    );

    expect(adjusted.lowValueTabIds).toEqual([1]);
  });

  it("flags eligible exact duplicates the model missed", () => {
    const tab = (id: number, overrides: Record<string, unknown>) => ({
      id, title: "Report", domain: "example.org", recencyBucket: "over_24_hours" as const,
      meetsLowValueInactivityThreshold: true, isActive: false, isAudible: false, ...overrides,
    });
    const adjusted = applyClutterRules(
      { schemaVersion: 1, groups: [], untouchedTabIds: [1, 2, 3, 4], lowValueTabIds: [] },
      [
        tab(1, { meetsLowValueInactivityThreshold: false, isActive: true }),
        tab(2, { duplicateOfTabId: 1 }),
        tab(3, { duplicateOfTabId: 1, meetsLowValueInactivityThreshold: false }),
        tab(4, { duplicateOfTabId: 1, domain: "docs.example.com", path: "/guide" }),
      ],
      [{ kind: "never_clutter_location", locationPattern: "docs.example.com/*" }],
    );

    expect(adjusted.lowValueTabIds).toEqual([2]);
  });

  it("never lets a model flag sign-in, editor, or untitled draft pages", () => {
    const tab = (id: number, title: string, hostname: string, path: string, overrides: Record<string, unknown> = {}) => ({
      id, title, hostname, path, domain: "example.org", recencyBucket: "over_24_hours" as const,
      meetsLowValueInactivityThreshold: true, isActive: false, isAudible: false, ...overrides,
    });
    const tabs = [
      tab(1, "Log In to Canvas", "school.instructure.com", "/login/canvas"),
      tab(2, "Sign in", "accounts.zoho.com", "/signin"),
      tab(3, "Reset your password", "secure.bank.example", "/web/auth/forgot-password"),
      tab(4, "Compose - Mail", "mail.example.com", "/d/compose/:number"),
      tab(5, "Cover letter - Docs", "docs.example.com", "/document/d/:token/edit"),
      tab(6, "Untitled spreadsheet", "sheets.example.com", "/s/:token"),
      tab(7, "Page not found", "shop.example.com", "/p/:number"),
      tab(8, "Troubleshooting login errors - Help Center", "help.example.com", "/articles/login-errors"),
      tab(9, "Cover letter - Docs", "docs.example.com", "/document/d/:token/edit", { duplicateOfTabId: 5 }),
    ];
    expect(tabs.filter(isProtectedFromClutter).map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 9]);

    const adjusted = applyClutterRules(
      { schemaVersion: 1, groups: [], untouchedTabIds: tabs.map((item) => item.id), lowValueTabIds: [1, 2, 3, 4, 5, 6, 7, 8] },
      tabs,
      [],
    );
    // Duplicates stay flagged even on editor URLs: the kept copy holds the state.
    expect(adjusted.lowValueTabIds).toEqual([7, 8, 9]);
  });
});
