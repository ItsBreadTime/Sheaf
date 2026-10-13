import { getProtectedLocationReason } from "../browser/domain-policy";
import {
  captureLinkedWorkspace,
  commitWorkspaceDraft,
  type CapturedStashWorkspace,
  matchWorkspaceWindow,
  stashWorkspaceCaptureToken,
  trackedTabsForRestoredWindow,
} from "../browser/stash-workspaces";
import type { LinkedStashWorkspace, LinkedStashWorkspaceDraft, SavedTabStash } from "../shared/stash-types";
import { storageMutationLockHeld, withStorageMutationLock } from "../storage/mutation-lock";
import { readOrganizerState } from "../storage/organizer-state";
import {
  readLinkedStashWorkspaces,
  readTabStashes,
  updateTabStashes,
  writeLinkedStashWorkspaces,
} from "../storage/stashes";

// Linked windows save themselves. Every tab or group change in a linked window
// refreshes a draft capture; when the window closes the draft becomes the
// stash. The draft has to exist beforehand because a closed window's tabs can
// no longer be read.

const WORKSPACE_LOCK = "linkedWorkspaceWindows";
const DRAFT_DELAY_MS = 750;
const EMPTY_WINDOW_NOTE = "The linked window closed with no tabs, so the workspace kept its previous tabs.";

const draftTimers = new Map<number, ReturnType<typeof setTimeout>>();
// Windows that reported their tabs closing with them. A capture taken now
// would see a half-closed window, so the last complete draft stands.
const closingWindows = new Set<number>();

// Captures a linked window under the same location rules that keep private
// tabs out of every other workspace save.
export async function captureLinkedWindow(workspace: LinkedStashWorkspace): Promise<CapturedStashWorkspace> {
  const { local } = await readOrganizerState();
  return captureLinkedWorkspace(workspace, (url) => getProtectedLocationReason(url, local.privacy) !== null);
}

export async function draftFromCapture(capture: CapturedStashWorkspace, now: number): Promise<LinkedStashWorkspaceDraft> {
  return {
    tabs: capture.tabs,
    groups: capture.groups,
    capturedAt: now,
    captureToken: await stashWorkspaceCaptureToken(capture),
  };
}

export function withWorkspaceLock<T>(task: () => Promise<T>): Promise<T> {
  return withStorageMutationLock(WORKSPACE_LOCK, task);
}

async function windowExists(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

function cancelDraft(windowId: number): void {
  clearTimeout(draftTimers.get(windowId));
  draftTimers.delete(windowId);
}

export function scheduleWorkspaceDraft(windowId: number | undefined): void {
  if (windowId === undefined || windowId < 0 || closingWindows.has(windowId)) return;
  cancelDraft(windowId);
  draftTimers.set(windowId, setTimeout(() => {
    draftTimers.delete(windowId);
    void captureWorkspaceDraft(windowId).catch(() => undefined);
  }, DRAFT_DELAY_MS));
}

export function noteWindowClosing(windowId: number): void {
  closingWindows.add(windowId);
  cancelDraft(windowId);
}

async function captureWorkspaceDraft(windowId: number): Promise<void> {
  await withWorkspaceLock(async () => {
    if (closingWindows.has(windowId)) return;
    const workspaces = await readLinkedStashWorkspaces();
    const workspace = workspaces.find((candidate) => candidate.windowId === windowId);
    if (!workspace || !(await windowExists(windowId))) return;
    const now = Date.now();
    const draft = await draftFromCapture(await captureLinkedWindow(workspace), now);
    if (workspace.draft?.captureToken === draft.captureToken) return;
    await writeLinkedStashWorkspaces(workspaces.map((candidate) => candidate.id === workspace.id
      ? { ...candidate, updatedAt: now, draft }
      : candidate));
  });
}

// Ends the given links: each stash takes its window's last draft (unless the
// changes are discarded), records the session as an open, and is unlinked.
// The stash is written before the link is dropped, so an interruption leaves a
// link that the next reconciliation settles again with the same result.
async function settleWorkspaces(
  settling: readonly LinkedStashWorkspace[],
  all: readonly LinkedStashWorkspace[],
  options: { discardChanges?: boolean } = {},
): Promise<void> {
  if (settling.length === 0) return;
  const now = Date.now();
  const settlingIds = new Set(settling.map((workspace) => workspace.id));
  const next = await updateTabStashes((stashes) => stashes.map((stash): SavedTabStash => {
    const workspace = settling.find((candidate) => candidate.stashId === stash.id);
    if (!workspace) return stash;
    const commit = options.discardChanges
      ? { kind: "unchanged" as const }
      : commitWorkspaceDraft(stash, workspace.draft, now);
    const base = commit.kind === "updated" ? commit.stash : stash;
    return {
      ...base,
      activeWorkspaceId: stash.activeWorkspaceId !== null && settlingIds.has(stash.activeWorkspaceId)
        ? null
        : stash.activeWorkspaceId,
      lastOpenedAt: now,
      closeConflicts: commit.kind === "empty" ? [EMPTY_WINDOW_NOTE] : [],
    };
  }));
  const verified = await readTabStashes();
  const unsettled = settling.find((workspace) => {
    const stored = verified.find((stash) => stash.id === workspace.stashId);
    const expected = next.find((stash) => stash.id === workspace.stashId);
    return stored !== undefined && expected !== undefined && (
      stored.activeWorkspaceId !== expected.activeWorkspaceId || stored.tabs.length !== expected.tabs.length
    );
  });
  if (unsettled) throw new Error("The linked window's workspace could not be verified after saving.");
  await writeLinkedStashWorkspaces(all.filter((workspace) => !settlingIds.has(workspace.id)));
}

export async function commitClosedWorkspaceWindow(windowId: number): Promise<void> {
  cancelDraft(windowId);
  try {
    await withWorkspaceLock(async () => {
      const workspaces = await readLinkedStashWorkspaces();
      await settleWorkspaces(workspaces.filter((workspace) => workspace.windowId === windowId), workspaces);
    });
  } finally {
    closingWindows.delete(windowId);
  }
}

export async function settleWorkspaceWithoutWindow(workspaceId: string): Promise<void> {
  await withWorkspaceLock(() => settleWorkspaceWithoutWindowUnlocked(workspaceId));
}

// The body of `settleWorkspaceWithoutWindow` without taking the workspace lock.
// `withStorageMutationLock` is not re-entrant, so a caller that already holds
// the lock (detachLinkedWorkspace) must use this path or deadlock.
export async function settleWorkspaceWithoutWindowUnlocked(workspaceId: string): Promise<void> {
  const workspaces = await readLinkedStashWorkspaces();
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || await windowExists(workspace.windowId)) return;
  await settleWorkspaces([workspace], workspaces);
}

// Saves a linked window into its stash (or drops its changes), unlinks it,
// then closes it. The link is gone before the window closes, so the close
// event finds nothing left to save.
export async function parkLinkedWorkspace(
  stashId: string,
  options: { discardChanges: boolean },
): Promise<{ windowClosed: boolean }> {
  const windowId = await withWorkspaceLock(async () => {
    const [workspaces, stashes] = await Promise.all([readLinkedStashWorkspaces(), readTabStashes()]);
    const stash = stashes.find((candidate) => candidate.id === stashId);
    if (!stash) throw new Error("The selected workspace no longer exists.");
    const workspace = workspaces.find((candidate) => candidate.id === stash.activeWorkspaceId);
    if (!workspace) throw new Error("This workspace is not open in a linked window.");
    let settling = workspace;
    if (!options.discardChanges && await windowExists(workspace.windowId)) {
      settling = { ...workspace, draft: await draftFromCapture(await captureLinkedWindow(workspace), Date.now()) };
    }
    cancelDraft(workspace.windowId);
    await settleWorkspaces([settling], workspaces, options);
    return workspace.windowId;
  });
  if (!await windowExists(windowId)) return { windowClosed: true };
  try {
    await chrome.windows.remove(windowId);
    return { windowClosed: true };
  } catch {
    return { windowClosed: false };
  }
}

export async function focusLinkedWorkspace(stashId: string): Promise<void> {
  const [workspaces, stashes] = await Promise.all([readLinkedStashWorkspaces(), readTabStashes()]);
  const stash = stashes.find((candidate) => candidate.id === stashId);
  const workspace = workspaces.find((candidate) => candidate.id === stash?.activeWorkspaceId);
  if (!workspace) throw new Error("This workspace is not open in a linked window.");
  if (!await windowExists(workspace.windowId)) {
    await settleWorkspaceWithoutWindow(workspace.id);
    throw new Error("The linked window was already closed. Its last state was saved.");
  }
  await chrome.windows.update(workspace.windowId, { focused: true });
}

// Window ids do not survive a browser restart. Links whose window is gone are
// matched to a restored window by address; when `settleUnmatched` is set, the
// rest are saved from their drafts and unlinked.
export async function reconcileOrphanedWorkspaces(options: { settleUnmatched: boolean }): Promise<void> {
  await withWorkspaceLock(async () => {
    const workspaces = await readLinkedStashWorkspaces();
    const live = await Promise.all(workspaces.map(async (workspace) => ({
      workspace,
      exists: await windowExists(workspace.windowId),
    })));
    const orphans = live.filter((item) => !item.exists).map((item) => item.workspace);
    if (orphans.length === 0) return;
    const stashes = await readTabStashes();
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    const claimed = new Set(live.filter((item) => item.exists).map((item) => item.workspace.windowId));
    const relinked = new Map<string, LinkedStashWorkspace>();
    for (const orphan of orphans) {
      const saved = orphan.draft?.tabs ?? stashes.find((stash) => stash.id === orphan.stashId)?.tabs ?? [];
      const candidates = windows.flatMap((window) => window.id === undefined || claimed.has(window.id) ? [] : [{
        windowId: window.id,
        urls: (window.tabs ?? []).flatMap((tab) => tab.url ?? tab.pendingUrl ?? []),
      }]);
      const windowId = matchWorkspaceWindow(saved.map((tab) => tab.url), candidates);
      if (windowId === null) continue;
      claimed.add(windowId);
      const liveTabs = (windows.find((window) => window.id === windowId)?.tabs ?? [])
        .flatMap((tab) => tab.id === undefined ? [] : [{ id: tab.id, url: tab.url ?? tab.pendingUrl ?? "" }]);
      const trackedTabs = trackedTabsForRestoredWindow(saved, liveTabs);
      relinked.set(orphan.id, {
        ...orphan,
        windowId,
        trackedTabIds: trackedTabs.map((item) => item.tabId),
        trackedTabs,
        updatedAt: Date.now(),
      });
    }
    const next = workspaces.map((workspace) => relinked.get(workspace.id) ?? workspace);
    if (relinked.size > 0) await writeLinkedStashWorkspaces(next);
    if (!options.settleUnmatched) return;
    const unmatched = next.filter((workspace) =>
      orphans.some((orphan) => orphan.id === workspace.id) && !relinked.has(workspace.id),
    );
    await settleWorkspaces(unmatched, next);
  });
  // Recapture relinked windows so their drafts carry the new tab identities.
  for (const workspace of await readLinkedStashWorkspaces()) scheduleWorkspaceDraft(workspace.windowId);
}

// Session restore recreates windows shortly after startup, so matching waits a
// moment and tries once more before saving anything that never reappeared.
export function scheduleStartupWorkspaceReconciliation(): void {
  setTimeout(() => void reconcileOrphanedWorkspaces({ settleUnmatched: false }).catch(() => undefined), 3_000);
  setTimeout(() => void reconcileOrphanedWorkspaces({ settleUnmatched: true }).catch(() => undefined), 12_000);
}

/** A linked workspace save, park, or restore is running in this worker. */
export function workspaceLockHeld(): boolean {
  return storageMutationLockHeld(WORKSPACE_LOCK);
}
