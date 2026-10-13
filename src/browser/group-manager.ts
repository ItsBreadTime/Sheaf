import type {
  GroupManagerEditDraft,
  GroupManagerEditPreview,
  GroupManagerGroup,
  GroupManagerRemovalMode,
  GroupManagerRemovalPreview,
  GroupManagerState,
  GroupManagerTab,
  GroupOwnershipRecord,
  GroupSemanticScore,
  GroupStashLink,
} from "../shared/group-manager-types";
import type { LinkedStashWorkspace, SavedTabStash } from "../shared/stash-types";
import type { SemanticWindowState } from "../shared/types";

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function stableIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

export function groupManagerFingerprint(states: readonly SemanticWindowState[]): Promise<string> {
  const serialized = JSON.stringify(states
    .slice()
    .sort((a, b) => a.windowId - b.windowId)
    .map((state) => ({
      windowId: state.windowId,
      tabs: state.tabs.map((tab) => ({
        id: tab.id,
        index: tab.index,
        title: tab.title,
        url: tab.url,
        groupId: tab.groupId,
        active: tab.active,
        audible: tab.audible,
        protectionReasons: tab.protectionReasons,
      })),
      groups: state.groups.map((group) => ({
        id: group.runtimeId,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        members: group.memberTabIds,
        protectionReasons: group.protectionReasons,
      })),
    })));
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function linkedWorkspaceForGroup(
  group: SemanticWindowState["groups"][number],
  workspaces: readonly LinkedStashWorkspace[],
): LinkedStashWorkspace | null {
  return workspaces.find((workspace) => {
    if (workspace.windowId !== group.windowId) return false;
    const tracked = new Set(workspace.trackedTabIds);
    return group.memberTabIds.length > 0 && group.memberTabIds.every((id) => tracked.has(id));
  }) ?? null;
}

function linkedStashMatches(
  state: SemanticWindowState,
  group: SemanticWindowState["groups"][number],
  workspace: LinkedStashWorkspace,
  stashes: readonly SavedTabStash[],
): boolean {
  const stash = stashes.find((candidate) => candidate.id === workspace.stashId);
  if (!stash) return false;
  const stableByTab = new Map(workspace.trackedTabs?.map((item) => [item.tabId, item.stableKey]) ?? []);
  const current = stableIds(group.memberTabIds.flatMap((tabId) => {
    const key = stableByTab.get(tabId);
    return key ? [stash.tabs.findIndex((tab) => tab.stableKey === key)] : [];
  }).filter((index) => index >= 0));
  return stash.groups.some((stashedGroup) => {
    const members = stableIds(stash.tabs.flatMap((tab, index) => tab.groupKey === stashedGroup.key ? [index] : []));
    return JSON.stringify(current) === JSON.stringify(members) &&
      stashedGroup.title === group.title && stashedGroup.color === group.color &&
      stashedGroup.collapsed === group.collapsed;
  }) && group.memberTabIds.every((id) => state.tabs.some((tab) => tab.id === id));
}

export function buildGroupManagerState(options: {
  states: readonly SemanticWindowState[];
  ownership: readonly GroupOwnershipRecord[];
  stashLinks: readonly GroupStashLink[];
  stashes: readonly SavedTabStash[];
  workspaces: readonly LinkedStashWorkspace[];
  canUndo: boolean;
  currentWindowId: number | null;
}): GroupManagerState {
  const ownership = new Map(options.ownership.map((item) => [`${item.windowId}:${item.groupId}`, item]));
  const stashLinks = new Map(options.stashLinks.map((item) => [`${item.windowId}:${item.groupId}`, item]));
  const orderedWindows = [
    ...options.states.filter((state) => state.windowId === options.currentWindowId),
    ...options.states.filter((state) => state.windowId !== options.currentWindowId),
  ];
  const windowLabels = new Map(orderedWindows.map((state, index) => [
    state.windowId,
    state.windowId === options.currentWindowId ? "Current window" : `Window ${index + 1}`,
  ]));
  const tabs: GroupManagerTab[] = options.states.flatMap((state) => state.tabs.map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title,
    url: tab.url,
    hostname: hostname(tab.url),
    groupId: tab.groupId,
    active: tab.active,
    audible: tab.audible,
    protected: tab.protectionReasons.length > 0,
    protectionReasons: [...tab.protectionReasons],
  })));
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const groups: GroupManagerGroup[] = options.states.flatMap((state) => state.groups.map((group) => {
    const members = group.memberTabIds.flatMap((id) => tabById.get(id) ? [tabById.get(id)!] : []);
    const owned = ownership.get(`${group.windowId}:${group.runtimeId}`) ?? null;
    const linked = linkedWorkspaceForGroup(group, options.workspaces);
    const sessionStash = stashLinks.get(`${group.windowId}:${group.runtimeId}`);
    const sessionStashExact = sessionStash &&
      JSON.stringify(stableIds(sessionStash.memberTabIds)) === JSON.stringify(stableIds(group.memberTabIds)) &&
      sessionStash.title === group.title && sessionStash.color === group.color &&
      sessionStash.collapsed === group.collapsed;
    const linkedExact = linked ? linkedStashMatches(state, group, linked, options.stashes) : false;
    const protectedTabCount = members.filter((tab) => tab.protected).length;
    const active = members.some((tab) => tab.active);
    const badges: GroupManagerGroup["badges"] = [];
    if (owned?.origin === "created") badges.push("created");
    else if (owned?.origin === "managed" && owned.managed) badges.push("managed");
    if (sessionStashExact || linkedExact) badges.push("stashed");
    else if (sessionStash || linked) badges.push("stash_changed");
    if (linked) badges.push("linked");
    if (group.protectionReasons.length > 0 || protectedTabCount === members.length) badges.push("protected");
    else if (protectedTabCount > 0) badges.push("partly_protected");
    if (active) badges.push("active");
    return {
      id: group.runtimeId,
      windowId: group.windowId,
      windowLabel: windowLabels.get(group.windowId) ?? "Other window",
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
      tabIds: [...group.memberTabIds],
      tabCount: group.memberTabIds.length,
      firstTabIndex: group.firstTabIndex,
      active,
      managed: owned?.managed ?? false,
      ownership: owned?.origin ?? null,
      badges,
      protectedTabCount,
      audibleTabCount: members.filter((tab) => tab.audible).length,
    };
  }));
  return {
    groups: groups.sort((a, b) =>
      (a.windowId === options.currentWindowId ? -1 : 0) - (b.windowId === options.currentWindowId ? -1 : 0) ||
      a.windowLabel.localeCompare(b.windowLabel) || a.firstTabIndex - b.firstTabIndex,
    ),
    tabs,
    ownership: [...options.ownership],
    capturedAt: Date.now(),
    canUndo: options.canUndo,
  };
}

function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length > 24) throw new Error("Group titles must be 24 characters or fewer.");
  if (/\p{Cc}|\p{Cf}/u.test(trimmed)) throw new Error("Group titles cannot contain control characters.");
  return trimmed;
}

export function previewGroupEdit(
  state: SemanticWindowState,
  draft: GroupManagerEditDraft,
  previewToken: string,
): GroupManagerEditPreview {
  const group = state.groups.find((candidate) => candidate.runtimeId === draft.groupId);
  if (!group) throw new Error("The selected group no longer exists.");
  if (group.protectionReasons.length > 0) throw new Error("Remove this group's protection before editing it.");
  const desired = [...new Set(draft.tabIds)];
  if (desired.length === 0) throw new Error("Keep at least one tab in the group or use Ungroup.");
  const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]));
  if (desired.some((id) => !tabsById.has(id))) throw new Error("One or more selected tabs are unavailable.");
  if ([...new Set([...group.memberTabIds, ...desired])].some((id) =>
    tabsById.get(id)?.protectionReasons.length,
  )) {
    throw new Error("Protected tabs cannot be moved into or out of a group.");
  }
  const original = group.memberTabIds;
  const originalSet = new Set(original);
  const desiredSet = new Set(desired);
  const sourceGroupIds = new Set(desired.flatMap((id) => {
    const source = tabsById.get(id)?.groupId;
    return source !== undefined && source !== -1 && source !== group.runtimeId ? [source] : [];
  }));
  const emptiedSourceGroupIds = state.groups.flatMap((candidate) =>
    sourceGroupIds.has(candidate.runtimeId) && candidate.memberTabIds.every((id) => desiredSet.has(id))
      ? [candidate.runtimeId]
      : [],
  );
  return {
    kind: "edit",
    previewToken,
    draft: { ...draft, title: validateTitle(draft.title), tabIds: desired },
    windowId: state.windowId,
    beforeTabCount: original.length,
    afterTabCount: desired.length,
    addedTabIds: desired.filter((id) => !originalSet.has(id)),
    removedTabIds: original.filter((id) => !desiredSet.has(id)),
    reordered: JSON.stringify(original.filter((id) => desiredSet.has(id))) !==
      JSON.stringify(desired.filter((id) => originalSet.has(id))),
    emptiedSourceGroupIds,
  };
}

export function previewGroupRemoval(
  states: readonly SemanticWindowState[],
  groupIds: readonly number[],
  mode: GroupManagerRemovalMode,
  includeActive: boolean,
  previewToken: string,
): GroupManagerRemovalPreview {
  const requested = new Set(groupIds);
  const groups = states.flatMap((state) => state.groups.filter((group) => requested.has(group.runtimeId)).map((group) => ({ state, group })));
  if (groups.length === 0) throw new Error("Select at least one available group.");
  const blockedGroups: GroupManagerRemovalPreview["blockedGroups"] = [];
  const eligibleGroupIds: number[] = [];
  const eligibleTabIds: number[] = [];
  const activeGroupIds: number[] = [];
  for (const { state, group } of groups) {
    const members = group.memberTabIds.flatMap((id) => state.tabs.find((tab) => tab.id === id) ?? []);
    const active = members.some((tab) => tab.active);
    if (active) activeGroupIds.push(group.runtimeId);
    const reason = group.protectionReasons.length > 0 || members.some((tab) => tab.protectionReasons.length > 0)
      ? "Protected groups must be unlocked first."
      : mode === "close" && members.some((tab) => tab.audible)
        ? "Groups with audible tabs must be reviewed after audio stops."
        : mode === "close" && active && !includeActive
          ? "The active group is excluded until Include active group is confirmed."
          : null;
    if (reason) {
      blockedGroups.push({ groupId: group.runtimeId, reason });
      continue;
    }
    eligibleGroupIds.push(group.runtimeId);
    eligibleTabIds.push(...group.memberTabIds);
  }
  return {
    kind: "removal",
    previewToken,
    mode,
    requestedGroupIds: [...requested],
    eligibleGroupIds,
    eligibleTabIds: [...new Set(eligibleTabIds)],
    blockedGroups,
    activeGroupIds,
    includeActive,
  };
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function rankGroupSearch(
  state: GroupManagerState,
  query: string,
  semantic: readonly GroupSemanticScore[] = [],
): number[] {
  const needle = normalized(query);
  const tabsByGroup = new Map<number, GroupManagerTab[]>();
  state.tabs.forEach((tab) => {
    if (tab.groupId === -1) return;
    tabsByGroup.set(tab.groupId, [...(tabsByGroup.get(tab.groupId) ?? []), tab]);
  });
  const semanticByGroup = new Map(semantic.map((item) => [item.groupId, item]));
  return state.groups.flatMap((group) => {
    const members = tabsByGroup.get(group.id) ?? [];
    const title = normalized(group.title);
    const exact = needle && title === needle ? 4 : 0;
    const prefix = needle && title.startsWith(needle) ? 3 : 0;
    const direct = needle && (title.includes(needle) || members.some((tab) =>
      normalized(tab.title).includes(needle) || normalized(tab.hostname).includes(needle))) ? 2 : 0;
    const semanticResult = semanticByGroup.get(group.id);
    if (!needle || exact || prefix || direct || semanticResult) {
      return [{ id: group.id, direct: Math.max(exact, prefix, direct), semantic: semanticResult?.score ?? 0, matches: semanticResult?.matchingMembers ?? 0, order: group.firstTabIndex }];
    }
    return [];
  }).sort((a, b) => b.direct - a.direct || b.semantic - a.semantic || b.matches - a.matches || a.order - b.order)
    .map((item) => item.id);
}

export function aggregateGroupSemanticScores(
  results: readonly { tabId: number; score: number }[],
  tabs: readonly GroupManagerTab[],
): GroupSemanticScore[] {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const grouped = new Map<number, number[]>();
  results.forEach((result) => {
    const groupId = tabById.get(result.tabId)?.groupId;
    if (groupId === undefined || groupId === -1) return;
    grouped.set(groupId, [...(grouped.get(groupId) ?? []), result.score]);
  });
  return [...grouped].map(([groupId, scores]) => ({
    groupId,
    score: Math.max(...scores),
    matchingMembers: scores.length,
  }));
}
