import { ORGANIZATION_RUN, UNGROUPED_GROUP_ID } from "../shared/constants";
import { effectiveProposedGroupColor } from "../organizer/group-colors";
import type { ImmutableRequestBundle, ValidatedProposal } from "../shared/organizer-types";
import type { IntegratedProposal } from "../shared/transaction-types";
import type {
  BrowserOperation,
  OrganizationProposal,
  SemanticGroup,
  SemanticWindowState,
  TransactionJournal,
} from "../shared/types";

function sameMembers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameMemberSet(left: readonly number[], right: readonly number[]): boolean {
  const members = new Set(left);
  return members.size === new Set(right).size && right.every((id) => members.has(id));
}

export interface ArrangementOptions {
  /**
   * Move every loose submitted tab to the end of the window in the proposal's
   * untouched order, so related loose tabs sit together. When false, only tabs
   * leaving a group are placed there and other loose tabs keep their position.
   */
  arrangeLooseTabs: boolean;
}

function sortTabIdsBySnapshot(
  initial: SemanticWindowState,
  tabIds: readonly number[],
): number[] {
  const selected = new Set(tabIds);
  return initial.tabs.flatMap((tab) => selected.has(tab.id) ? [tab.id] : []);
}

function reindexProjectedState(state: SemanticWindowState): void {
  const indexById = new Map<number, number>();
  state.tabs.forEach((tab, index) => {
    tab.index = index;
    indexById.set(tab.id, index);
  });
  state.groups.forEach((group) => {
    group.memberTabIds.sort(
      (left, right) =>
        (indexById.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (indexById.get(right) ?? Number.MAX_SAFE_INTEGER),
    );
    group.firstTabIndex = Math.min(
      ...group.memberTabIds.map((tabId) => indexById.get(tabId) ?? Number.MAX_SAFE_INTEGER),
    );
  });
  state.groups.sort((left, right) => left.firstTabIndex - right.firstTabIndex);
  const eligible = new Set(state.eligibleTabIds);
  const protectedIds = new Set(state.protectedTabIds);
  state.eligibleTabIds = state.tabs.flatMap((tab) => eligible.has(tab.id) ? [tab.id] : []);
  state.protectedTabIds = state.tabs.flatMap((tab) => protectedIds.has(tab.id) ? [tab.id] : []);
}

function moveTabsIntoContiguousBlock(
  state: SemanticWindowState,
  tabIds: readonly number[],
): number[] {
  const selected = new Set(tabIds);
  const memberIndexes = state.tabs.flatMap((tab, index) =>
    selected.has(tab.id) ? [index] : [],
  );
  if (memberIndexes.length !== selected.size || memberIndexes.length === 0) {
    throw new Error("A proposed group contains an unavailable tab.");
  }
  const insertionIndex = Math.min(...memberIndexes);
  const members = state.tabs.filter((tab) => selected.has(tab.id));
  const remaining = state.tabs.filter((tab) => !selected.has(tab.id));
  remaining.splice(insertionIndex, 0, ...members);
  state.tabs = remaining;
  reindexProjectedState(state);
  return members.map((tab) => tab.id);
}

function moveGroupToIndex(
  state: SemanticWindowState,
  memberTabIds: readonly number[],
  index: number,
): void {
  const selected = new Set(memberTabIds);
  const members = state.tabs.filter((tab) => selected.has(tab.id));
  if (members.length !== selected.size || members.length === 0) {
    throw new Error("A proposed group contains an unavailable tab.");
  }
  const remaining = state.tabs.filter((tab) => !selected.has(tab.id));
  remaining.splice(Math.min(Math.max(index, 0), remaining.length), 0, ...members);
  state.tabs = remaining;
  reindexProjectedState(state);
}

export function mapReviewToBrowserProposal(
  proposal: ValidatedProposal,
  request: ImmutableRequestBundle,
): IntegratedProposal {
  const mapId = (ephemeralId: number): number => {
    const browserId = request.ephemeralToBrowserTabId[ephemeralId];
    if (browserId === undefined) throw new Error(`Submitted tab ${ephemeralId} has no browser mapping.`);
    return browserId;
  };
  const mapped: OrganizationProposal = {
    groups: proposal.groups.map((group) => ({
      temporaryId: group.temporaryId,
      title: group.title,
      color: effectiveProposedGroupColor(
        group.title,
        group.color,
        request.approvedRequest?.groupColorMode,
      ).color,
      collapsed: false,
      tabIds: group.tabIds.map(mapId),
    })),
    untouchedTabIds: proposal.untouchedTabIds.map(mapId),
    ungroupTabIds: (proposal.ungroupTabIds ?? []).map(mapId),
    lowValueTabIds: (proposal.lowValueTabIds ?? []).map(mapId),
  };
  return {
    proposal: mapped,
    browserTabIds: [...request.submittedTabIds].map(mapId),
  };
}

function validateIntegratedProposal(
  initial: SemanticWindowState,
  proposal: OrganizationProposal,
  submittedBrowserTabIds: readonly number[],
): void {
  const liveIds = new Set(initial.tabs.map((tab) => tab.id));
  const eligible = new Set(initial.eligibleTabIds);
  const submitted = new Set(submittedBrowserTabIds);
  const seen = new Set<number>();
  const record = (tabId: number, touched: boolean): void => {
    if (!liveIds.has(tabId) || !submitted.has(tabId)) throw new Error(`Tab ${tabId} is not part of the confirmed request.`);
    if (touched && !eligible.has(tabId)) throw new Error(`Tab ${tabId} is no longer eligible for mutation.`);
    if (seen.has(tabId)) throw new Error(`Tab ${tabId} appears more than once in the proposal.`);
    seen.add(tabId);
  };
  proposal.groups.forEach((group) => {
    if (group.tabIds.length < 2) throw new Error(`Group ${group.temporaryId} must contain at least two tabs.`);
    group.tabIds.forEach((tabId) => record(tabId, true));
  });
  const ungroup = new Set(proposal.ungroupTabIds ?? []);
  proposal.untouchedTabIds.forEach((tabId) => record(tabId, ungroup.has(tabId)));
  if ([...ungroup].some((tabId) => !seen.has(tabId) || proposal.groups.some((group) => group.tabIds.includes(tabId)))) {
    throw new Error("Only untouched tabs can leave their group.");
  }
  if (seen.size !== submitted.size) throw new Error("Every submitted tab must appear exactly once.");
}

function expectedState(
  initial: SemanticWindowState,
  orderedGroups: OrganizationProposal["groups"],
  ungroupTabIds: readonly number[],
  looseTabIds: readonly number[],
): { state: SemanticWindowState; reused: Record<string, number> } {
  const state = structuredClone(initial);
  const touched = new Set(orderedGroups.flatMap((group) => group.tabIds));
  const reused: Record<string, number> = {};
  const originals = structuredClone(initial.groups);
  let nextGroupIndex = initial.tabs.filter((tab) => tab.pinned).length;

  for (const tab of state.tabs) {
    if (touched.has(tab.id)) tab.groupId = UNGROUPED_GROUP_ID;
  }
  state.groups = state.groups.flatMap((group) => {
    const remaining = group.memberTabIds.filter((id) => !touched.has(id));
    if (remaining.length === 0) return [];
    return [{
      ...group,
      memberTabIds: remaining,
      firstTabIndex: Math.min(...state.tabs.filter((tab) => remaining.includes(tab.id)).map((tab) => tab.index)),
    }];
  });

  orderedGroups.forEach((proposed, index) => {
    const exact = originals.find(
      (group) => group.protectionReasons.length === 0 && sameMembers(group.memberTabIds, proposed.tabIds),
    );
    const runtimeId = exact?.runtimeId ?? ORGANIZATION_RUN.SYNTHETIC_GROUP_ID_START - index;
    if (exact) {
      reused[proposed.temporaryId] = exact.runtimeId;
    }
    const memberTabIds = exact
      ? [...exact.memberTabIds]
      : moveTabsIntoContiguousBlock(state, proposed.tabIds);
    for (const tab of state.tabs) {
      if (memberTabIds.includes(tab.id)) tab.groupId = runtimeId;
    }
    const next: SemanticGroup = {
      runtimeId,
      windowId: initial.windowId,
      title: proposed.title,
      color: exact?.color ?? proposed.color,
      collapsed: proposed.collapsed,
      shared: { known: true, value: false },
      memberTabIds,
      firstTabIndex: Math.min(...state.tabs.filter((tab) => memberTabIds.includes(tab.id)).map((tab) => tab.index)),
      protectionReasons: [],
    };
    const existingIndex = state.groups.findIndex((group) => group.runtimeId === runtimeId);
    if (existingIndex >= 0) state.groups[existingIndex] = next;
    else state.groups.push(next);
    moveGroupToIndex(state, memberTabIds, nextGroupIndex);
    if (!exact) orderGroupMembers(state, runtimeId, proposed.tabIds);
    nextGroupIndex += memberTabIds.length;
  });

  const leaving = new Set(ungroupTabIds);
  for (const tab of state.tabs) {
    if (leaving.has(tab.id)) tab.groupId = UNGROUPED_GROUP_ID;
  }
  state.groups = state.groups.flatMap((group) => {
    const memberTabIds = group.memberTabIds.filter((id) => !leaving.has(id));
    return memberTabIds.length === 0 ? [] : [{ ...group, memberTabIds }];
  });
  const loose = new Set(looseTabIds);
  const looseTabs = looseTabIds.flatMap((id) => state.tabs.find((tab) => tab.id === id) ?? []);
  state.tabs = [...state.tabs.filter((tab) => !loose.has(tab.id)), ...looseTabs];
  reindexProjectedState(state);
  return { state, reused };
}

function orderGroupMembers(
  state: SemanticWindowState,
  runtimeId: number,
  orderedTabIds: readonly number[],
): void {
  const start = state.tabs.findIndex((tab) => tab.groupId === runtimeId);
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const ordered = orderedTabIds.flatMap((id) => byId.get(id) ?? []);
  state.tabs.splice(start, ordered.length, ...ordered);
  const group = state.groups.find((candidate) => candidate.runtimeId === runtimeId);
  if (group) group.memberTabIds = ordered.map((tab) => tab.id);
  reindexProjectedState(state);
}

export function planIntegratedTransaction(
  initial: SemanticWindowState,
  proposal: OrganizationProposal,
  submittedBrowserTabIds: readonly number[],
  transactionId: string,
  options: ArrangementOptions = { arrangeLooseTabs: false },
): TransactionJournal {
  validateIntegratedProposal(initial, proposal, submittedBrowserTabIds);
  const activeTabId = initial.tabs.find((tab) => tab.active)?.id;
  const normalizedGroups = proposal.groups.map((group) => {
    const exact = initial.groups.find((candidate) =>
      candidate.protectionReasons.length === 0 && sameMemberSet(candidate.memberTabIds, group.tabIds),
    );
    return {
      ...group,
      color: exact?.color ?? group.color,
      collapsed: activeTabId === undefined || !group.tabIds.includes(activeTabId),
      // An existing group with the same members keeps its own order: reordering
      // it would be churn without a membership change.
      tabIds: exact ? [...exact.memberTabIds] : [...group.tabIds],
    };
  });
  const orderedGroups = [...normalizedGroups].sort((left, right) => {
    const earliest = (ids: number[]) => Math.min(...initial.tabs.filter((tab) => ids.includes(tab.id)).map((tab) => tab.index));
    return earliest(left.tabIds) - earliest(right.tabIds);
  });

  const tabsById = new Map(initial.tabs.map((tab) => [tab.id, tab]));
  const eligible = new Set(initial.eligibleTabIds);
  const ungroupTabIds = [...new Set(proposal.ungroupTabIds ?? [])].filter(
    (tabId) => tabsById.get(tabId)?.groupId !== UNGROUPED_GROUP_ID,
  );
  const leaving = new Set(ungroupTabIds);
  const looseCandidates = proposal.untouchedTabIds.filter((tabId) => {
    const tab = tabsById.get(tabId);
    if (!tab || tab.pinned || !eligible.has(tabId)) return false;
    return leaving.has(tabId) || (options.arrangeLooseTabs && tab.groupId === UNGROUPED_GROUP_ID);
  });
  // Skip the move when the loose tabs already end the window in this order. Tabs
  // leaving a group always move: Chrome shifts an ungrouped tab to its old
  // group's edge, so only the final move gives them a known position.
  const beforeArrangement = expectedState(initial, orderedGroups, [], []).state;
  const tail = beforeArrangement.tabs.slice(-looseCandidates.length).map((tab) => tab.id);
  const looseTabIds = ungroupTabIds.length > 0 ||
      (looseCandidates.length > 0 && !sameMembers(tail, looseCandidates))
    ? looseCandidates
    : [];
  const projected = expectedState(initial, orderedGroups, ungroupTabIds, looseTabIds);

  const operationPlan: BrowserOperation[] = [];
  let nextGroupIndex = initial.tabs.filter((tab) => tab.pinned).length;
  orderedGroups.forEach((group) => {
    const reused = projected.reused[group.temporaryId] !== undefined;
    const creationOrder = sortTabIdsBySnapshot(initial, group.tabIds);
    if (!reused) {
      operationPlan.push({
        operationId: `${group.temporaryId}:create`,
        kind: "create_group",
        groupRef: group.temporaryId,
        tabIds: creationOrder,
      });
    }
    operationPlan.push({
      operationId: `${group.temporaryId}:update`,
      kind: "update_group",
      groupRef: group.temporaryId,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
    });
    operationPlan.push({
      operationId: `${group.temporaryId}:move`,
      kind: "move_group",
      groupRef: group.temporaryId,
      index: nextGroupIndex,
    });
    if (!reused && !sameMembers(creationOrder, group.tabIds)) {
      operationPlan.push({
        operationId: `${group.temporaryId}:order`,
        kind: "order_group",
        groupRef: group.temporaryId,
        tabIds: [...group.tabIds],
        index: nextGroupIndex,
      });
    }
    nextGroupIndex += group.tabIds.length;
  });
  if (ungroupTabIds.length > 0) {
    operationPlan.push({ operationId: "loose:ungroup", kind: "ungroup_tabs", tabIds: ungroupTabIds });
  }
  if (looseTabIds.length > 0) {
    operationPlan.push({ operationId: "loose:arrange", kind: "arrange_loose_tabs", tabIds: looseTabIds });
  }
  return {
    transactionId,
    targetWindowId: initial.windowId,
    rollbackSnapshot: structuredClone(initial),
    expectedFinalState: projected.state,
    operationPlan,
    touchedTabIds: [...normalizedGroups.flatMap((group) => group.tabIds), ...ungroupTabIds],
    arrangedTabIds: looseTabIds.filter((tabId) => !leaving.has(tabId)),
    runtimeGroupIds: projected.reused,
    inFlightOperation: null,
    completedThrough: -1,
    status: "prepared",
  };
}
