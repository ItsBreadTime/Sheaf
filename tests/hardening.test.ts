import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failStrandedTransaction, interruptActiveTransaction } from "../src/background/recovery-boundary";
import { buildSanitizedRequest } from "../src/privacy/request-builder";
import { ensureSessionStorageCapacity } from "../src/storage/session-budget";
import type { OrganizationRun, SemanticTab, SemanticWindowState } from "../src/shared/types";

afterEach(() => vi.unstubAllGlobals());

function tab(id: number): SemanticTab {
  return {
    id,
    windowId: 7,
    index: id - 1,
    title: `Public tab ${id}`,
    url: `https://example${id % 7}.com/items/${id}?secret=never-sent#fragment`,
    groupId: -1,
    active: id === 1,
    pinned: false,
    audible: false,
    openerTabId: null,
    lastAccessed: null,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
  };
}

function state(count: number): SemanticWindowState {
  const tabs = Array.from({ length: count }, (_, index) => tab(index + 1));
  return {
    windowId: 7,
    capturedAt: 1,
    tabs,
    groups: [],
    eligibleTabIds: tabs.map((item) => item.id),
    protectedTabIds: [],
    featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true },
  };
}

const privacy = {
  level: 2 as const,
  includeExistingGroups: false,
  allowLocalNetworkTabs: false,
  allowFileTabs: false,
  closeInactiveBlankTabs: false,
  allowlist: [],
  denylist: [],
};

describe("request stress", () => {
  it.each([50, 200])("builds and freezes an exact privacy-safe %i-tab request", (count) => {
    const bundle = buildSanitizedRequest(state(count), privacy, 1);
    expect(bundle.submittedTabIds).toHaveLength(count);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.approvedRequest.tabs)).toBe(true);
    expect(bundle.requestJson).not.toContain("?secret");
    expect(bundle.requestJson).not.toContain("#fragment");
    expect(bundle.byteLength).toBeLessThanOrEqual(512_000);
  });

  it("rejects a 201-tab request before provider transmission", () => {
    expect(() => buildSanitizedRequest(state(201), privacy, 1)).toThrow("at most 200");
  });
});

describe("storage reserve", () => {
  it("evicts nonessential session diagnostics before the soft budget", async () => {
    const remove = vi.fn(async () => undefined);
    const getBytesInUse = vi.fn()
      .mockResolvedValueOnce(7_450_000)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1_000_000)
      .mockResolvedValueOnce(0);
    vi.stubGlobal("chrome", { storage: { session: { getBytesInUse, remove } } });
    await ensureSessionStorageCapacity({ organizationRunActiveRun: { value: "x".repeat(100_000) } });
    expect(remove).toHaveBeenCalledWith(expect.arrayContaining(["organizerProviderJob"]));
  });

  it("fails before a journal write when the 1.5 MB reserve cannot be maintained", async () => {
    const getBytesInUse = vi.fn()
      .mockResolvedValueOnce(7_500_000)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(7_450_000)
      .mockResolvedValueOnce(0);
    vi.stubGlobal("chrome", { storage: { session: { getBytesInUse, remove: vi.fn() } } });
    await expect(
      ensureSessionStorageCapacity({ organizationRunActiveRun: { value: "x".repeat(100_000) } }),
    ).rejects.toThrow("reserve would be crossed");
  });
});

describe("recovery boundary", () => {
  it.each(["prepared", "applying", "verifying", "rolling_back"] as const)(
    "marks %s as interrupted without replaying the operation cursor",
    (status) => {
      const run = {
        status,
        journal: { completedThrough: 3, inFlightOperation: 4 },
      } as unknown as OrganizationRun;
      const recovered = interruptActiveTransaction(run);
      expect(recovered).toMatchObject({
        status: "interrupted",
        journal: { completedThrough: 3, inFlightOperation: 4 },
      });
      expect(recovered?.error).toMatch(/not replayed automatically/);
    },
  );

  it("recovers a prepared run stranded before the durability barrier", () => {
    // A worker killed between persisting "prepared" and persisting "applying"
    // leaves a non-terminal run that nothing else clears; without this the whole
    // session refuses to organize again.
    const run = { status: "prepared", journal: { completedThrough: -1 } } as unknown as OrganizationRun;
    expect(interruptActiveTransaction(run)).toMatchObject({ status: "interrupted" });
  });

  it("leaves terminal transactions unchanged", () => {
    const run = { status: "completed" } as OrganizationRun;
    expect(interruptActiveTransaction(run)).toBe(run);
  });

  it.each(["prepared", "applying", "verifying", "rolling_back"] as const)(
    "fails a %s transaction that threw past its rollback, keeping the reason",
    (status) => {
      const run = {
        status,
        journal: { completedThrough: 1, inFlightOperation: 2 },
      } as unknown as OrganizationRun;
      const failed = failStrandedTransaction(run, new Error("No tab with id: 42."));
      expect(failed).toMatchObject({
        status: "failed",
        journal: { completedThrough: 1, inFlightOperation: 2 },
      });
      expect(failed.error).toMatch(/^No tab with id: 42\. /);
    },
  );

  it("does not overwrite a transaction that already reached a terminal state", () => {
    const run = { status: "rolled_back", error: "original" } as OrganizationRun;
    expect(failStrandedTransaction(run, new Error("late"))).toBe(run);
  });
});

describe("message dispatch audit", () => {
  it("rejects external senders before any dispatch case runs", async () => {
    const root = resolve(import.meta.dirname, "..");
    const source = await readFile(resolve(root, "src/background/service-worker.ts"), "utf8");
    const dispatchStart = source.indexOf("async function dispatchMessage(");
    expect(dispatchStart).toBeGreaterThan(-1);
    const body = source.slice(dispatchStart);
    const guard = body.indexOf("if (sender.id !== chrome.runtime.id) {");
    const switchStart = body.indexOf("MESSAGE_HANDLERS[message.type]");
    const validation = body.indexOf("assertWindowCaptureMessage(message);");
    expect(guard).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(guard);
    expect(switchStart).toBeGreaterThan(validation);
    // Nothing between the signature and the guard may return, await, or dispatch.
    const preamble = body.slice(body.indexOf("{", body.indexOf(")")) + 1, guard);
    expect(preamble).not.toMatch(/\b(?:return|await|MESSAGE_HANDLERS)\b/);
    expect(body.slice(guard, switchStart)).toMatch(/throw new Error/);
  });
});

describe("manifest, CSP, and logging audit", () => {
  it("ships only the reviewed MV3 permissions and no executable page injection", async () => {
    const root = resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(await readFile(resolve(root, "public/manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual([
      "tabs",
      "tabGroups",
      "storage",
      "unlimitedStorage",
      "contextMenus",
      "alarms",
      "notifications",
      // The finder's result icons, read from the browser's own favicon cache
      // so no request goes to the sites themselves. No install warning.
      "favicon",
    ]);
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("web_accessible_resources");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest.content_security_policy).toEqual({ extension_pages: "script-src 'self'; object-src 'none'" });
  });
  // Source debug-logging and `debugger` statements are covered by ESLint
  // (no-console and no-debugger over all of src/) — see eslint.config.mjs.
});
