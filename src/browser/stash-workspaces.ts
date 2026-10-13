import { canonicalExactUrl } from "../search/stash-selection";
import type {
  LinkedStashWorkspace,
  LinkedStashWorkspaceDraft,
  SavedTabStash,
  StashedGroup,
  StashedTab,
  StashWorkspaceDiff,
} from "../shared/stash-types";

export interface CapturedStashWorkspace {
  tabs: StashedTab[];
  groups: StashedGroup[];
  /** Tabs left out because their location must never be stored. */
  skippedPrivateTabs?: number;
}

export type PrivateLocationTest = (url: string) => boolean;

function workspaceTabIds(
  tabs: readonly chrome.tabs.Tab[],
  workspace: LinkedStashWorkspace,
): Set<number> {
  if (workspace.mode === "whole_window") {
    return new Set(tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]));
  }
  const included = new Set(workspace.trackedTabIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const tab of tabs) {
      if (tab.id === undefined || tab.openerTabId === undefined || included.has(tab.id)) continue;
      if (included.has(tab.openerTabId)) {
        included.add(tab.id);
        changed = true;
      }
    }
  }
  return included;
}

export async function captureLinkedWorkspace(
  workspace: LinkedStashWorkspace,
  isPrivate: PrivateLocationTest = () => false,
): Promise<CapturedStashWorkspace> {
  const [allTabs, allGroups] = await Promise.all([
    chrome.tabs.query({ windowId: workspace.windowId }),
    chrome.tabGroups.query({ windowId: workspace.windowId }),
  ]);
  const included = workspaceTabIds(allTabs, workspace);
  const stableKeys = new Map(workspace.trackedTabs?.map((item) => [item.tabId, item.stableKey]) ?? []);
  // The organizer's own pages are its interface, not content worth replaying.
  const ownOrigin = globalThis.chrome?.runtime?.getURL?.("") ?? null;
  const present = allTabs
    .filter((tab) => tab.id !== undefined && included.has(tab.id) && Boolean(tab.url ?? tab.pendingUrl))
    .filter((tab) => ownOrigin === null || !(tab.url ?? tab.pendingUrl)!.startsWith(ownOrigin));
  // Private locations (local files, local network, browser pages) are never
  // written to a workspace, whichever way it is saved.
  const tabs = present
    .filter((tab) => !isPrivate(tab.url ?? tab.pendingUrl!))
    .sort((left, right) => left.index - right.index);
  const usedGroupIds = new Set(tabs.flatMap((tab) =>
    tab.groupId === undefined || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? [] : [tab.groupId],
  ));
  const sortedGroups = allGroups
    .filter((group) => group.id !== undefined && usedGroupIds.has(group.id))
    .sort((left, right) => {
      const leftIndex = tabs.find((tab) => tab.groupId === left.id)?.index ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = tabs.find((tab) => tab.groupId === right.id)?.index ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
  const groupKeys = new Map(sortedGroups.map((group, index) => [group.id, `group-${index + 1}`]));
  const capturedTabs: StashedTab[] = tabs.map((tab) => ({
    sourceTabId: tab.id!,
    sourceIndex: tab.index,
    title: tab.title ?? tab.url ?? "Untitled tab",
    url: tab.url ?? tab.pendingUrl!,
    groupKey: tab.groupId === undefined || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
      ? null
      : groupKeys.get(tab.groupId) ?? null,
    stableKey: stableKeys.get(tab.id!) ?? `workspace:${workspace.id}:${tab.id}`,
  }));
  const capturedGroups: StashedGroup[] = sortedGroups.map((group) => ({
    key: groupKeys.get(group.id)!,
    sourceGroupId: group.id,
    sourceIndex: tabs.find((tab) => tab.groupId === group.id)?.index ?? 0,
    title: group.title ?? "",
    color: group.color,
    collapsed: group.collapsed,
  }));
  return { tabs: capturedTabs, groups: capturedGroups, skippedPrivateTabs: present.length - tabs.length };
}

export async function stashWorkspaceCaptureToken(capture: CapturedStashWorkspace): Promise<string> {
  const serialized = JSON.stringify({ tabs: capture.tabs, groups: capture.groups });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function groupSignatures(tabs: readonly StashedTab[], groups: readonly StashedGroup[]): Map<string, string> {
  const keys = tabs.map((tab) => tab.stableKey ?? `stash:${tab.sourceIndex}`);
  return new Map(groups.map((group): [string, string] => {
    const members = tabs.flatMap((tab, index) => tab.groupKey === group.key ? [keys[index]!] : []);
    return [members.sort().join("\u0001"), group.title];
  }).filter(([signature]) => signature.length > 0));
}

export async function buildStashWorkspaceDiff(
  stash: Pick<SavedTabStash, "tabs" | "groups">,
  current: CapturedStashWorkspace,
): Promise<StashWorkspaceDiff> {
  const before = stash.tabs.map((tab) => tab.stableKey ?? `stash:${tab.sourceIndex}`);
  const after = current.tabs.map((tab) => tab.stableKey ?? `stash:${tab.sourceIndex}`);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const common = before.filter((key) => afterSet.has(key));
  const beforeOrder = new Map(common.map((key, index) => [key, index]));
  const afterCommon = after.filter((key) => beforeSet.has(key));
  const reorderedTabs = afterCommon.filter((key, index) => beforeOrder.get(key) !== index).length;
  const beforeTabs = new Map(stash.tabs.map((tab, index) => [before[index]!, tab]));
  const afterTabs = new Map(current.tabs.map((tab, index) => [after[index]!, tab]));
  const changedTabs = common.filter((key) => {
    const previous = beforeTabs.get(key)!;
    const next = afterTabs.get(key)!;
    return previous.url !== next.url || previous.title !== next.title;
  }).length;
  const beforeGroups = groupSignatures(stash.tabs, stash.groups);
  const afterGroups = groupSignatures(current.tabs, current.groups);
  const renamedGroups = [...afterGroups].filter(([signature, title]) =>
    beforeGroups.has(signature) && beforeGroups.get(signature) !== title,
  ).length;
  const groupStructureChanges =
    [...beforeGroups.keys()].filter((signature) => !afterGroups.has(signature)).length +
    [...afterGroups.keys()].filter((signature) => !beforeGroups.has(signature)).length;
  const titles = (tabs: readonly StashedTab[], keys: readonly string[], exclude: Set<string>): string[] =>
    tabs.flatMap((tab, index) => exclude.has(keys[index]!) ? [] : [tab.title || tab.url]).slice(0, 5);
  return {
    addedTitles: titles(current.tabs, after, beforeSet),
    removedTitles: titles(stash.tabs, before, afterSet),
    addedTabs: after.filter((key) => !beforeSet.has(key)).length,
    removedTabs: before.filter((key) => !afterSet.has(key)).length,
    changedTabs,
    renamedGroups,
    groupStructureChanges,
    reorderedTabs,
    currentTabCount: current.tabs.length,
    privateTabs: current.skippedPrivateTabs ?? 0,
    captureToken: await stashWorkspaceCaptureToken(current),
  };
}

const tabKey = (tab: StashedTab): string => tab.stableKey ?? `stash:${tab.sourceIndex}`;

function groupFor(groups: readonly StashedGroup[], key: string | null): StashedGroup | null {
  return key === null ? null : groups.find((group) => group.key === key) ?? null;
}

// Two captures hold the same structure when they list the same tabs at the
// same addresses, in the same order, with the same grouping. Titles settle as
// pages load, so a title-only difference is not a structural change.
export function sameWorkspaceStructure(
  left: Pick<SavedTabStash, "tabs" | "groups">,
  right: Pick<SavedTabStash, "tabs" | "groups">,
): boolean {
  if (left.tabs.length !== right.tabs.length || left.groups.length !== right.groups.length) return false;
  return left.tabs.every((tab, index) => {
    const other = right.tabs[index]!;
    const group = groupFor(left.groups, tab.groupKey);
    const otherGroup = groupFor(right.groups, other.groupKey);
    return tabKey(tab) === tabKey(other) &&
      canonicalExactUrl(tab.url) === canonicalExactUrl(other.url) &&
      (group === null) === (otherGroup === null) &&
      (group === null || (
        group.title === otherGroup!.title && group.color === otherGroup!.color && group.collapsed === otherGroup!.collapsed
      ));
  });
}

export type WorkspaceDraftCommit =
  | { kind: "unchanged" }
  | { kind: "empty" }
  | { kind: "updated"; stash: SavedTabStash; revised: boolean };

// Applies a linked window's last capture to its stash. A structural change
// keeps the previous contents as a revision; an empty capture never replaces
// saved tabs, since closing every tab is far likelier to be an accident than
// an intent to empty the stash.
export function commitWorkspaceDraft(
  stash: SavedTabStash,
  draft: LinkedStashWorkspaceDraft | null | undefined,
  now: number,
  createId: () => string = () => crypto.randomUUID(),
): WorkspaceDraftCommit {
  if (!draft) return { kind: "unchanged" };
  if (draft.tabs.length === 0) return { kind: "empty" };
  const structural = !sameWorkspaceStructure(stash, draft);
  const titlesChanged = !structural && draft.tabs.some((tab, index) => tab.title !== stash.tabs[index]!.title);
  if (!structural && !titlesChanged) return { kind: "unchanged" };
  return {
    kind: "updated",
    revised: structural,
    stash: {
      ...stash,
      tabs: structuredClone(draft.tabs),
      groups: structuredClone(draft.groups),
      updatedAt: now,
      status: "saved",
      restoreResult: structural ? null : stash.restoreResult,
      revisions: structural
        ? [{ id: createId(), savedAt: stash.updatedAt, tabs: stash.tabs, groups: stash.groups }, ...stash.revisions].slice(0, 20)
        : stash.revisions,
    },
  };
}

export interface WorkspaceWindowCandidate {
  windowId: number;
  urls: readonly string[];
}

// After a browser restart every window and tab id changes. A restored window
// is recognised by its addresses: it must hold most of the workspace's tabs,
// be mostly made of them, and clearly beat every other window.
export function matchWorkspaceWindow(
  expectedUrls: readonly string[],
  candidates: readonly WorkspaceWindowCandidate[],
): number | null {
  const expected = new Set(expectedUrls.map(canonicalExactUrl));
  if (expected.size === 0) return null;
  const scored = candidates.map((candidate) => {
    const urls = new Set(candidate.urls.map(canonicalExactUrl));
    const shared = [...expected].filter((url) => urls.has(url)).length;
    return {
      windowId: candidate.windowId,
      score: shared / expected.size,
      purity: urls.size === 0 ? 0 : shared / urls.size,
    };
  }).filter((item) => item.score >= 0.8 && item.purity >= 0.6)
    .sort((left, right) => right.score - left.score);
  const [best, second] = scored;
  if (!best) return null;
  if (second && best.score - second.score < 0.1) return null;
  return best.windowId;
}

function redirectHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

// Maps a restored window's tabs back to the stable keys of the tabs they
// replay, in order and by address, so later captures keep their identities.
// A tab that redirected since it was saved (a sign-in bounce, an http to https
// upgrade, a shortened link) no longer matches exactly; it falls back to the
// first leftover saved tab on the same host, so it keeps its identity too.
export function trackedTabsForRestoredWindow(
  saved: readonly StashedTab[],
  liveTabs: ReadonlyArray<{ id: number; url: string }>,
): Array<{ tabId: number; stableKey: string }> {
  const remaining = saved.map((tab) => ({ url: canonicalExactUrl(tab.url), host: redirectHost(tab.url), stableKey: tabKey(tab) }));
  const matched = new Map<number, string>();
  for (const tab of liveTabs) {
    const index = remaining.findIndex((candidate) => candidate.url === canonicalExactUrl(tab.url));
    if (index === -1) continue;
    const [match] = remaining.splice(index, 1);
    matched.set(tab.id, match!.stableKey);
  }
  for (const tab of liveTabs) {
    if (matched.has(tab.id)) continue;
    const host = redirectHost(tab.url);
    const index = host === null ? -1 : remaining.findIndex((candidate) => candidate.host === host);
    if (index === -1) continue;
    const [match] = remaining.splice(index, 1);
    matched.set(tab.id, match!.stableKey);
  }
  return liveTabs.flatMap((tab) => {
    const stableKey = matched.get(tab.id);
    return stableKey === undefined ? [] : [{ tabId: tab.id, stableKey }];
  });
}
