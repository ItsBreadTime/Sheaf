import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkedStashWorkspace, SavedTabStash, StashedTab } from "../src/shared/stash-types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

interface FakeTab { id: number; windowId: number; index: number; url: string; title: string; groupId: number }

const savedTab = (index: number, url: string): StashedTab => ({
  sourceTabId: index + 1, sourceIndex: index, title: url, url, groupKey: null, stableKey: `k${index}`,
});

function stash(tabs: StashedTab[], activeWorkspaceId: string | null = "ws"): SavedTabStash {
  return {
    id: "stash", name: "Work", createdAt: 1, updatedAt: 1, lastOpenedAt: null, note: "", revisions: [],
    activeWorkspaceId, status: "saved", scope: { mode: "window" }, tabs, groups: [], excludedTabs: [],
    closeConflicts: [], restoreResult: null,
  };
}

function workspace(windowId: number, draftTabs?: StashedTab[]): LinkedStashWorkspace {
  return {
    id: "ws", stashId: "stash", windowId, mode: "whole_window", trackedTabIds: [], trackedTabs: [],
    startedAt: 1, updatedAt: 1,
    draft: draftTabs ? { tabs: draftTabs, groups: [], capturedAt: 2, captureToken: "draft" } : null,
  };
}

function installChrome(options: { windows: Record<number, FakeTab[]> }) {
  const values: Record<string, unknown> = {};
  const windows = options.windows;
  const removed: number[] = [];
  const events: string[] = [];
  vi.stubGlobal("chrome", {
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query() { return []; },
    },
    tabs: {
      async query({ windowId }: { windowId: number }) { return structuredClone(windows[windowId] ?? []); },
    },
    windows: {
      async get(windowId: number) {
        if (!windows[windowId]) throw new Error("No window");
        return { id: windowId };
      },
      async getAll() {
        return Object.entries(windows).map(([id, tabs]) => ({ id: Number(id), tabs: structuredClone(tabs) }));
      },
      async remove(windowId: number) {
        events.push(`remove-window:${JSON.stringify(values.linkedWorkspaceWindows)}`);
        delete windows[windowId];
        removed.push(windowId);
      },
      async update() {},
    },
    storage: {
      local: {
        async get(key: string | string[]) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.flatMap((item) => item in values ? [[item, structuredClone(values[item])]] : []));
        },
        async set(items: Record<string, unknown>) { Object.assign(values, structuredClone(items)); },
      },
      session: {
        async get() { return {}; },
        async set() {},
        async remove() {},
      },
    },
  });
  return { values, removed, events };
}

async function runtime() {
  return import("../src/background/stash-workspace-runtime");
}

describe("linked workspace runtime", () => {
  it("saves the last draft into the stash when its window closes", async () => {
    const env = installChrome({ windows: {} });
    env.values.workspaces = [stash([savedTab(0, "https://a.test/1")])];
    env.values.linkedWorkspaceWindows = [workspace(7, [savedTab(0, "https://a.test/1"), savedTab(1, "https://a.test/2")])];
    await (await runtime()).commitClosedWorkspaceWindow(7);
    const [saved] = env.values.workspaces as SavedTabStash[];
    expect(saved!.tabs.map((tab) => tab.url)).toEqual(["https://a.test/1", "https://a.test/2"]);
    expect(saved!.revisions).toHaveLength(1);
    expect(saved!.activeWorkspaceId).toBeNull();
    expect(saved!.lastOpenedAt).toEqual(expect.any(Number));
    expect(env.values.linkedWorkspaceWindows).toEqual([]);
  });

  it("keeps the previous tabs when the window closed empty", async () => {
    const env = installChrome({ windows: {} });
    env.values.workspaces = [stash([savedTab(0, "https://a.test/1")])];
    env.values.linkedWorkspaceWindows = [workspace(7, [])];
    await (await runtime()).commitClosedWorkspaceWindow(7);
    const [saved] = env.values.workspaces as SavedTabStash[];
    expect(saved!.tabs).toHaveLength(1);
    expect(saved!.closeConflicts[0]).toMatch(/closed with no tabs/);
    expect(saved!.activeWorkspaceId).toBeNull();
  });

  it("ignores a closed window that is not linked", async () => {
    const env = installChrome({ windows: {} });
    const original = stash([savedTab(0, "https://a.test/1")], null);
    env.values.workspaces = [original];
    await (await runtime()).commitClosedWorkspaceWindow(99);
    expect(env.values.workspaces).toEqual([original]);
  });

  it("settles a closed window through the unlocked path while the lock is held", async () => {
    const env = installChrome({ windows: {} });
    env.values.workspaces = [stash([savedTab(0, "https://a.test/1")])];
    env.values.linkedWorkspaceWindows = [workspace(7, [savedTab(0, "https://a.test/2")])];
    const { withWorkspaceLock, settleWorkspaceWithoutWindowUnlocked } = await runtime();
    // Unlink holds the workspace lock and settles through the unlocked path; a
    // re-entrant `withWorkspaceLock` call here would deadlock the worker.
    await withWorkspaceLock(() => settleWorkspaceWithoutWindowUnlocked("ws"));
    const [saved] = env.values.workspaces as SavedTabStash[];
    expect(saved!.tabs.map((tab) => tab.url)).toEqual(["https://a.test/2"]);
    expect(saved!.activeWorkspaceId).toBeNull();
    expect(env.values.linkedWorkspaceWindows).toEqual([]);
  });

  it("settles a closed window through the locked wrapper when no lock is held", async () => {
    const env = installChrome({ windows: {} });
    env.values.workspaces = [stash([savedTab(0, "https://a.test/1")])];
    env.values.linkedWorkspaceWindows = [workspace(7, [savedTab(0, "https://a.test/2")])];
    await (await runtime()).settleWorkspaceWithoutWindow("ws");
    const [saved] = env.values.workspaces as SavedTabStash[];
    expect(saved!.tabs.map((tab) => tab.url)).toEqual(["https://a.test/2"]);
    expect(env.values.linkedWorkspaceWindows).toEqual([]);
  });

  it("parks by saving the live window, unlinking, and only then closing it", async () => {
    const env = installChrome({ windows: {
      7: [
        { id: 70, windowId: 7, index: 0, url: "https://a.test/1", title: "One", groupId: -1 },
        { id: 71, windowId: 7, index: 1, url: "https://a.test/3", title: "Three", groupId: -1 },
      ],
    } });
    env.values.workspaces = [stash([savedTab(0, "https://a.test/1")])];
    env.values.linkedWorkspaceWindows = [workspace(7)];
    expect(await (await runtime()).parkLinkedWorkspace("stash", { discardChanges: false })).toEqual({ windowClosed: true });
    const [saved] = env.values.workspaces as SavedTabStash[];
    expect(saved!.tabs.map((tab) => tab.url)).toEqual(["https://a.test/1", "https://a.test/3"]);
    expect(saved!.activeWorkspaceId).toBeNull();
    expect(env.removed).toEqual([7]);
    expect(env.events).toEqual(["remove-window:[]"]);
  });

  it("never saves private locations from a linked window when they are not allowed", async () => {
    const env = installChrome({ windows: {
      7: [
        { id: 70, windowId: 7, index: 0, url: "https://a.test/1", title: "One", groupId: -1 },
        { id: 71, windowId: 7, index: 1, url: "file:///Users/me/notes.txt", title: "Notes", groupId: -1 },
        { id: 72, windowId: 7, index: 2, url: "http://192.168.1.10/admin", title: "Router", groupId: -1 },
      ],
    } });
    env.values.organizerLocalState = {
      privacy: { level: 2, allowLocalNetworkTabs: false, allowFileTabs: false },
    };
    env.values.workspaces = [stash([savedTab(0, "https://a.test/1")])];
    env.values.linkedWorkspaceWindows = [workspace(7)];
    const { captureLinkedWindow, parkLinkedWorkspace } = await runtime();
    const capture = await captureLinkedWindow(workspace(7));
    expect(capture.tabs.map((tab) => tab.url)).toEqual(["https://a.test/1"]);
    expect(capture.skippedPrivateTabs).toBe(2);
    await parkLinkedWorkspace("stash", { discardChanges: false });
    expect(JSON.stringify(env.values.workspaces)).not.toMatch(/notes\.txt|192\.168/);
  });

  it("parks without saving when changes are discarded", async () => {
    const env = installChrome({ windows: {
      7: [{ id: 70, windowId: 7, index: 0, url: "https://a.test/changed", title: "Changed", groupId: -1 }],
    } });
    env.values.workspaces = [stash([savedTab(0, "https://a.test/1")])];
    env.values.linkedWorkspaceWindows = [workspace(7, [savedTab(0, "https://a.test/draft")])];
    await (await runtime()).parkLinkedWorkspace("stash", { discardChanges: true });
    const [saved] = env.values.workspaces as SavedTabStash[];
    expect(saved!.tabs.map((tab) => tab.url)).toEqual(["https://a.test/1"]);
    expect(saved!.activeWorkspaceId).toBeNull();
    expect(env.removed).toEqual([7]);
  });

  it("relinks a restored window after restart and saves links that never came back", async () => {
    const tabs = [0, 1, 2, 3, 4].map((index) => savedTab(index, `https://a.test/${index}`));
    const env = installChrome({ windows: {
      40: tabs.map((tab, index) => ({ id: 400 + index, windowId: 40, index, url: tab.url, title: tab.title, groupId: -1 })),
    } });
    env.values.workspaces = [stash(tabs), { ...stash([savedTab(0, "https://b.test/")], "ws-2"), id: "stash-2" }];
    env.values.linkedWorkspaceWindows = [
      workspace(7, tabs),
      { ...workspace(8, [savedTab(0, "https://b.test/"), savedTab(1, "https://b.test/2")]), id: "ws-2", stashId: "stash-2" },
    ];
    const { reconcileOrphanedWorkspaces } = await runtime();

    await reconcileOrphanedWorkspaces({ settleUnmatched: false });
    const relinked = env.values.linkedWorkspaceWindows as LinkedStashWorkspace[];
    expect(relinked.find((item) => item.id === "ws")).toMatchObject({ windowId: 40, trackedTabIds: [400, 401, 402, 403, 404] });
    expect(relinked.find((item) => item.id === "ws")!.trackedTabs![2]).toEqual({ tabId: 402, stableKey: "k2" });
    expect(relinked.find((item) => item.id === "ws-2")).toMatchObject({ windowId: 8 });

    await reconcileOrphanedWorkspaces({ settleUnmatched: true });
    expect((env.values.linkedWorkspaceWindows as LinkedStashWorkspace[]).map((item) => item.id)).toEqual(["ws"]);
    const second = (env.values.workspaces as SavedTabStash[]).find((item) => item.id === "stash-2")!;
    expect(second.activeWorkspaceId).toBeNull();
    expect(second.tabs.map((tab) => tab.url)).toEqual(["https://b.test/", "https://b.test/2"]);
  });

  it("drops a pending capture once the window reports it is closing", async () => {
    vi.useFakeTimers();
    const env = installChrome({ windows: {
      7: [{ id: 70, windowId: 7, index: 0, url: "https://a.test/partial", title: "Partial", groupId: -1 }],
    } });
    env.values.linkedWorkspaceWindows = [workspace(7, [savedTab(0, "https://a.test/full")])];
    const { noteWindowClosing, scheduleWorkspaceDraft } = await runtime();
    scheduleWorkspaceDraft(7);
    noteWindowClosing(7);
    scheduleWorkspaceDraft(7);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((env.values.linkedWorkspaceWindows as LinkedStashWorkspace[])[0]!.draft!.tabs[0]!.url).toBe("https://a.test/full");
  });

  it("captures a draft after tab changes settle", async () => {
    const env = installChrome({ windows: {
      7: [{ id: 70, windowId: 7, index: 0, url: "https://a.test/new", title: "New", groupId: -1 }],
    } });
    env.values.linkedWorkspaceWindows = [workspace(7)];
    const { scheduleWorkspaceDraft } = await runtime();
    scheduleWorkspaceDraft(7);
    scheduleWorkspaceDraft(7);
    await vi.waitFor(() => {
      const [linked] = env.values.linkedWorkspaceWindows as LinkedStashWorkspace[];
      expect(linked!.draft?.tabs.map((tab) => tab.url)).toEqual(["https://a.test/new"]);
    }, { timeout: 3_000 });
  });
});
