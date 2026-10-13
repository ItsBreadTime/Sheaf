import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
) as {
  description?: string;
  homepage_url?: string;
  permissions?: string[];
  commands?: Record<string, { description?: string }>;
};

describe("keyboard and context-menu entry points", () => {
  it("describes current features without claiming hardening or review", () => {
    expect(manifest.description).toBe(
      "Organizes tabs into groups and auto-files new ones, finds tabs by meaning, tracks model usage, saves workspaces, offers undo.",
    );
    expect(manifest.description).not.toMatch(/hardened|reviewed/i);
  });

  it("ships no test-only pages", () => {
    // Smoke-only pages live in scripts/fixtures and are added to a copy of the build.
    const shipped = readdirSync(new URL("../public", import.meta.url)).filter((name) => name.endsWith(".html"));
    expect(shipped).toEqual([]);
  });

  it("links a homepage and discloses every permission in the privacy policy", () => {
    expect(manifest.homepage_url).toMatch(/^https:\/\//);
    const policy = readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
    for (const permission of manifest.permissions ?? []) {
      expect(policy).toContain(`\`${permission}\``);
    }
  });

  it("declares context-menu access and user-assignable commands", () => {
    expect(manifest.permissions).toContain("contextMenus");
    expect(manifest.permissions).toEqual(expect.arrayContaining(["alarms", "notifications"]));
    expect(Object.keys(manifest.commands ?? {})).toEqual([
      "_execute_action",
      "organize-window",
      "search-tabs",
      "organize-selected-tabs",
      "protect-selected-tabs",
      "undo-last-organization",
      "undo-last-auto-filing",
      "save-and-close-linked-window",
    ]);
    expect(Object.values(manifest.commands ?? {}).every((command) => command.description)).toBe(true);
    // Only organize and search carry suggested keys; the rest stay user-assigned.
    const commands = (manifest.commands ?? {}) as Record<string, { suggested_key?: { default?: string } }>;
    const suggested = Object.entries(commands)
      .filter(([, command]) => command.suggested_key)
      .map(([name, command]) => [name, command.suggested_key?.default]);
    expect(suggested).toEqual([
      ["organize-window", "Alt+Shift+O"],
      ["search-tabs", "Alt+Shift+F"],
    ]);
  });

  it("ships PNG extension icons and reuses them for notifications", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
    ) as chrome.runtime.ManifestV3;
    const iconPaths = new Set([
      ...Object.values(manifest.icons ?? {}),
      ...Object.values((manifest.action?.default_icon ?? {}) as Record<string, string>),
    ]);
    expect(Object.keys(manifest.icons ?? {})).toEqual(["16", "32", "48", "128"]);
    for (const path of iconPaths) {
      const icon = readFileSync(new URL(`../public/${path}`, import.meta.url));
      expect([...icon.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    const worker = readFileSync(
      new URL("../src/background/service-worker.ts", import.meta.url),
      "utf8",
    );
    // Chrome notifications reject SVG icons, so the worker must point at a PNG.
    expect(worker).toContain(`getURL("${manifest.icons?.["128"]}")`);
  });

  it("wires semantic lifecycle reconciliation to browser and stash changes", () => {
    const worker = readFileSync(
      new URL("../src/background/service-worker.ts", import.meta.url),
      "utf8",
    );
    for (const listener of [
      "chrome.tabs.onCreated",
      "chrome.tabs.onUpdated",
      "chrome.tabs.onRemoved",
      "chrome.tabs.onMoved",
      "chrome.tabs.onAttached",
      "chrome.tabs.onDetached",
      "chrome.tabs.onReplaced",
      "chrome.tabGroups.onUpdated",
    ]) expect(worker).toContain(`${listener}.addListener`);
    expect(worker).toContain("changes[STASHES_KEY]");
    expect(worker).toContain("SEMANTIC_INDEX_MAINTENANCE_ALARM");
  });

  it("feeds linked-window autosave from tab, group, and window events", () => {
    const worker = readFileSync(
      new URL("../src/background/service-worker.ts", import.meta.url),
      "utf8",
    );
    expect(worker.match(/scheduleWorkspaceDraft\(/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(worker).toContain("if (removeInfo.isWindowClosing) noteWindowClosing(removeInfo.windowId);");
    expect(worker).toContain("await commitClosedWorkspaceWindow(windowId)");
    expect(worker.match(/scheduleStartupWorkspaceReconciliation\(\);/g)).toHaveLength(2);
  });
});
