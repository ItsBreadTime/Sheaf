import { describe, expect, it } from "vitest";
import {
  cleanupSuggestionFilterCounts,
  cleanupSuggestionMatchesFilter,
  findCleanupSuggestions,
  INACTIVE_TAB_AGE_MS,
  LOW_VALUE_TAB_AGE_MS,
} from "../src/browser/cleanup-suggestions";
import type { SemanticTab, SemanticWindowState } from "../src/shared/types";

function tab(
  id: number,
  url: string,
  overrides: Partial<SemanticTab> = {},
): SemanticTab {
  return {
    id,
    windowId: 7,
    index: id - 1,
    title: `Tab ${id}`,
    url,
    groupId: -1,
    active: false,
    pinned: false,
    audible: false,
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
    eligibleTabIds: tabs.map((item) => item.id),
    protectedTabIds: [],
    featureSupport: {
      sharedGroupProperty: true,
      splitViewIdProperty: true,
      storageSession: true,
    },
  };
}

describe("cleanup suggestions", () => {
  it("keeps the active duplicate and suggests other exact pages despite fragments", () => {
    const suggestions = findCleanupSuggestions(
      state([
        tab(1, "https://example.com/docs#intro", { active: true }),
        tab(2, "https://example.com/docs#api"),
        tab(3, "https://example.com/docs?mode=print"),
      ]),
      1_000_000,
    );
    expect(suggestions).toEqual([
      expect.objectContaining({
        tabId: 2,
        reasons: ["duplicate"],
        duplicate: expect.objectContaining({ kind: "fragment", keeperTabId: 1 }),
      }),
    ]);
  });

  it("does not suggest a duplicate whose activity is unknown", () => {
    const suggestions = findCleanupSuggestions(
      state([
        tab(1, "https://example.com/docs", { lastAccessed: 900 }),
        tab(2, "https://example.com/docs", { lastAccessed: null }),
      ]),
      1_000_000,
    );
    expect(suggestions).toEqual([]);
  });

  it("uses the documented keeper priority and explains the decision", () => {
    const suggestions = findCleanupSuggestions(
      state([
        tab(1, "https://example.com/report", { groupId: 10, lastAccessed: 9_000 }),
        tab(2, "https://example.com/report", { pinned: true, lastAccessed: 1_000 }),
      ]),
      10_000,
    );
    expect(suggestions).toEqual([
      expect.objectContaining({
        tabId: 1,
        reasons: ["duplicate"],
        duplicate: expect.objectContaining({
          kind: "exact",
          keeperTabId: 2,
          keeperReason: "The pinned copy will stay open.",
        }),
      }),
    ]);
  });

  it("distinguishes tracking variants from possible equivalents", () => {
    const suggestions = findCleanupSuggestions(
      state([
        tab(1, "https://example.com/story?utm_source=newsletter", { active: true }),
        tab(2, "https://example.com/story?fbclid=abc"),
        tab(3, "http://www.example.com/story"),
      ]),
      1_000_000,
    );
    expect(suggestions).toEqual([
      expect.objectContaining({
        tabId: 2,
        reasons: ["duplicate"],
        duplicate: expect.objectContaining({ kind: "tracking" }),
      }),
      expect.objectContaining({
        tabId: 3,
        reasons: ["possible_duplicate"],
        duplicate: expect.objectContaining({ kind: "possible" }),
      }),
    ]);
  });

  it("suggests tabs unused for 24 hours but not unknown or recent tabs", () => {
    const now = 10 * INACTIVE_TAB_AGE_MS;
    const suggestions = findCleanupSuggestions(
      state([
        tab(1, "https://old.example/", { lastAccessed: now - INACTIVE_TAB_AGE_MS }),
        tab(2, "https://recent.example/", { lastAccessed: now - INACTIVE_TAB_AGE_MS + 1 }),
        tab(3, "https://unknown.example/", { lastAccessed: null }),
      ]),
      now,
    );
    expect(suggestions.map((item) => item.tabId)).toEqual([1]);
    expect(suggestions[0]?.reasons).toEqual(["inactive"]);
    expect(suggestions[0]?.inactiveForMs).toBe(INACTIVE_TAB_AGE_MS);
  });

  it("never suggests active, pinned, audible, protected, or split-view tabs as inactive", () => {
    const now = 10 * INACTIVE_TAB_AGE_MS;
    const old = now - INACTIVE_TAB_AGE_MS;
    const suggestions = findCleanupSuggestions(
      state([
        tab(1, "https://safe.example/", { lastAccessed: old }),
        tab(2, "https://active.example/", { active: true, lastAccessed: old }),
        tab(3, "https://pinned.example/", { pinned: true, lastAccessed: old }),
        tab(4, "https://audible.example/", { audible: true, lastAccessed: old }),
        tab(5, "chrome://settings/", { protectionReasons: ["Protected"], lastAccessed: old }),
        tab(6, "about:blank", { lastAccessed: old }),
        tab(7, "https://split.example/", { splitView: { known: true, value: 12 }, lastAccessed: old }),
      ]),
      now,
    );
    expect(suggestions.map((item) => [item.tabId, item.reasons])).toEqual([
      [1, ["inactive"]],
      [6, ["blank"]],
    ]);
  });

  it("suggests blank new tabs without any inactivity limit", () => {
    const now = 10 * INACTIVE_TAB_AGE_MS;
    const browserPage = ["Browser page"];
    const suggestions = findCleanupSuggestions(
      state([
        tab(1, "chrome://newtab/", { lastAccessed: now, protectionReasons: browserPage }),
        tab(2, "about:blank", { lastAccessed: null, protectionReasons: browserPage }),
        tab(3, "chrome://newtab/", { active: true, protectionReasons: browserPage }),
        tab(4, "chrome://newtab/", { pinned: true, protectionReasons: browserPage }),
        tab(5, "chrome://newtab/", { groupId: 9, protectionReasons: browserPage }),
        tab(6, "chrome://newtab/", {
          protectionReasons: [...browserPage, "User protected until browser restart"],
        }),
        tab(7, "chrome://newtab/", { splitView: { known: true, value: 12 }, protectionReasons: browserPage }),
        tab(8, "https://recent.example/", { lastAccessed: now }),
      ]),
      now,
    );
    expect(suggestions.map((item) => [item.tabId, item.reasons])).toEqual([
      [1, ["blank"]],
      [2, ["blank"]],
    ]);
    expect(cleanupSuggestionMatchesFilter(suggestions[0]!, "clutter")).toBe(true);
    expect(cleanupSuggestionMatchesFilter(suggestions[0]!, "inactive")).toBe(false);
  });

  it("combines duplicate and inactive reasons without duplicate rows", () => {
    const now = 10 * INACTIVE_TAB_AGE_MS;
    const suggestions = findCleanupSuggestions(
      state([
        tab(1, "https://example.com/", { active: true, lastAccessed: now }),
        tab(2, "https://example.com/", { lastAccessed: now - INACTIVE_TAB_AGE_MS }),
      ]),
      now,
    );
    expect(suggestions).toEqual([
      expect.objectContaining({ tabId: 2, reasons: ["inactive", "duplicate"] }),
    ]);
  });

  it("uses an independent threshold for tabs the AI marked low-value", () => {
    const now = 10 * INACTIVE_TAB_AGE_MS;
    const suggestions = findCleanupSuggestions(
      state([
        tab(1, "https://random.example/", { lastAccessed: now - LOW_VALUE_TAB_AGE_MS }),
        tab(2, "https://ordinary.example/", { lastAccessed: now - LOW_VALUE_TAB_AGE_MS }),
      ]),
      now,
      {
        inactiveAfterMs: INACTIVE_TAB_AGE_MS,
        lowValueAfterMs: LOW_VALUE_TAB_AGE_MS,
        lowValueTabIds: [1],
      },
    );
    expect(suggestions).toEqual([
      expect.objectContaining({ tabId: 1, reasons: ["low_value"] }),
    ]);
  });

  it("filters combined reasons into duplicate, clutter, inactive, or all", () => {
    const suggestions = [
      { tabId: 1, title: "One", url: "https://one.example", inactiveForMs: INACTIVE_TAB_AGE_MS, reasons: ["duplicate", "inactive"] },
      { tabId: 2, title: "Two", url: "https://two.example", inactiveForMs: LOW_VALUE_TAB_AGE_MS, reasons: ["low_value"] },
      { tabId: 3, title: "Three", url: "https://three.example", inactiveForMs: null, reasons: ["possible_duplicate"] },
    ] satisfies ReturnType<typeof findCleanupSuggestions>;
    expect(cleanupSuggestionFilterCounts(suggestions)).toEqual({
      all: 3,
      duplicate: 2,
      clutter: 1,
      inactive: 1,
    });
    expect(
      suggestions.filter((suggestion) =>
        cleanupSuggestionMatchesFilter(suggestion, "duplicate"),
      ).map((suggestion) => suggestion.tabId),
    ).toEqual([1, 3]);
    expect(cleanupSuggestionMatchesFilter(suggestions[1]!, "inactive")).toBe(false);
  });
});
