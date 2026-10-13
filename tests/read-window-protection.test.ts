import { afterEach, describe, expect, it, vi } from "vitest";
import { readSemanticWindow } from "../src/browser/read-window";

afterEach(() => vi.unstubAllGlobals());

describe("mixed protected native groups", () => {
  it("protects every member when one group tab is pinned", async () => {
    vi.stubGlobal("chrome", {
      windows: { get: vi.fn(async () => ({ id: 7, type: "normal", incognito: false })) },
      tabs: {
        query: vi.fn(async () => [
          { id: 1, windowId: 7, index: 0, title: "Pinned", url: "https://example.com/1", groupId: 50, pinned: true, incognito: false, active: false, audible: false, splitViewId: -1 },
          { id: 2, windowId: 7, index: 1, title: "Mutable-looking", url: "https://example.com/2", groupId: 50, pinned: false, incognito: false, active: false, audible: false, splitViewId: -1 },
          { id: 3, windowId: 7, index: 2, title: "Eligible", url: "https://example.com/3", groupId: -1, pinned: false, incognito: false, active: true, audible: false, splitViewId: -1 },
        ]),
      },
      tabGroups: {
        query: vi.fn(async () => [{ id: 50, windowId: 7, title: "Mixed", color: "blue", collapsed: false, shared: false }]),
      },
      storage: { session: {} },
    });
    const result = await readSemanticWindow(7);
    expect(result.protectedTabIds).toEqual([1, 2]);
    expect(result.eligibleTabIds).toEqual([3]);
    expect(result.groups[0]?.protectionReasons).toContain("Group contains a protected tab");
    expect(result.tabs[1]?.protectionReasons).toContain("Group contains a protected tab");
  });

  it("makes local and file tabs eligible only when their settings are enabled", async () => {
    vi.stubGlobal("chrome", {
      windows: { get: vi.fn(async () => ({ id: 7, type: "normal", incognito: false })) },
      tabs: {
        query: vi.fn(async () => [
          { id: 1, windowId: 7, index: 0, title: "Local app", url: "http://localhost:5173/", groupId: -1, pinned: false, incognito: false, active: true, audible: false, splitViewId: -1 },
          { id: 2, windowId: 7, index: 1, title: "Local file", url: "file:///Users/example/report.html", groupId: -1, pinned: false, incognito: false, active: false, audible: false, splitViewId: -1 },
        ]),
      },
      tabGroups: { query: vi.fn(async () => []) },
      storage: { session: {} },
    });

    const protectedState = await readSemanticWindow(7);
    expect(protectedState.protectedTabIds).toEqual([1, 2]);
    const allowedState = await readSemanticWindow(7, {
      allowLocalNetworkTabs: true,
      allowFileTabs: true,
    });
    expect(allowedState.eligibleTabIds).toEqual([1, 2]);
  });
});
