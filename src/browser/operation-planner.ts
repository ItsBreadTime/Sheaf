import { ORGANIZATION_RUN, UNGROUPED_GROUP_ID } from "../shared/constants";
import type {
  BrowserOperation,
  OrganizationProposal,
  SemanticGroup,
  SemanticWindowState,
  TransactionJournal,
} from "../shared/types";

function cloneState(state: SemanticWindowState): SemanticWindowState {
  return structuredClone(state);
}

export function buildPlannedOperationProposal(
  state: SemanticWindowState,
): { proposal: OrganizationProposal; selectedTabIds: [number, number] } {
  const eligible = new Set(state.eligibleTabIds);
  for (let index = 0; index < state.tabs.length - 1; index += 1) {
    const first = state.tabs[index];
    const second = state.tabs[index + 1];
    if (
      first &&
      second &&
      eligible.has(first.id) &&
      eligible.has(second.id) &&
      first.groupId === UNGROUPED_GROUP_ID &&
      second.groupId === UNGROUPED_GROUP_ID &&
      second.index === first.index + 1
    ) {
      const selectedTabIds: [number, number] = [first.id, second.id];
      return {
        selectedTabIds,
        proposal: {
          groups: [
            {
              temporaryId: "planned-group-1",
              title: ORGANIZATION_RUN.PLANNED_GROUP_TITLE,
              color: ORGANIZATION_RUN.PLANNED_GROUP_COLOR,
              collapsed: false,
              tabIds: selectedTabIds,
            },
          ],
          untouchedTabIds: state.tabs
            .map((tab) => tab.id)
            .filter((tabId) => !selectedTabIds.includes(tabId)),
        },
      };
    }
  }
  throw new Error(
    "This operation needs two adjacent, eligible, ungrouped HTTP(S) tabs.",
  );
}

function validateProposal(
  state: SemanticWindowState,
  proposal: OrganizationProposal,
): void {
  const knownTabIds = new Set(state.tabs.map((tab) => tab.id));
  const eligibleTabIds = new Set(state.eligibleTabIds);
  const assigned = new Set<number>();
  for (const group of proposal.groups) {
    if (group.tabIds.length < 2) {
      throw new Error(`Group ${group.temporaryId} must contain at least two tabs.`);
    }
    for (const tabId of group.tabIds) {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!knownTabIds.has(tabId) || !eligibleTabIds.has(tabId) || !tab) {
        throw new Error(`Tab ${tabId} is not eligible for the transaction.`);
      }
      if (tab.groupId !== UNGROUPED_GROUP_ID) {
        throw new Error(
          `Planned operations only cover newly grouped, previously ungrouped tabs; tab ${tabId} is already grouped.`,
        );
      }
      if (assigned.has(tabId)) {
        throw new Error(`Tab ${tabId} appears more than once in the proposal.`);
      }
      assigned.add(tabId);
    }
  }
  for (const tabId of proposal.untouchedTabIds) {
    if (!knownTabIds.has(tabId) || assigned.has(tabId)) {
      throw new Error(`Untouched tab ${tabId} is unknown or duplicated.`);
    }
    assigned.add(tabId);
  }
  if (assigned.size !== knownTabIds.size) {
    throw new Error("Every captured tab must appear exactly once in the hard-coded plan.");
  }
}

function projectExpectedState(
  initial: SemanticWindowState,
  proposal: OrganizationProposal,
): SemanticWindowState {
  const expected = cloneState(initial);
  proposal.groups.forEach((proposedGroup, index) => {
    const runtimeId = ORGANIZATION_RUN.SYNTHETIC_GROUP_ID_START - index;
    const memberSet = new Set(proposedGroup.tabIds);
    for (const tab of expected.tabs) {
      if (memberSet.has(tab.id)) tab.groupId = runtimeId;
    }
    const firstTabIndex = Math.min(
      ...expected.tabs
        .filter((tab) => memberSet.has(tab.id))
        .map((tab) => tab.index),
    );
    const group: SemanticGroup = {
      runtimeId,
      windowId: expected.windowId,
      title: proposedGroup.title,
      color: proposedGroup.color,
      collapsed: proposedGroup.collapsed,
      shared: { known: true, value: false },
      memberTabIds: [...proposedGroup.tabIds],
      firstTabIndex,
      protectionReasons: [],
    };
    expected.groups.push(group);
  });
  expected.groups.sort((left, right) => left.firstTabIndex - right.firstTabIndex);
  return expected;
}

export function planTransaction(
  initial: SemanticWindowState,
  proposal: OrganizationProposal,
  transactionId: string,
): TransactionJournal {
  validateProposal(initial, proposal);
  const operationPlan: BrowserOperation[] = proposal.groups.flatMap((group) => [
    {
      operationId: `${group.temporaryId}:create`,
      kind: "create_group" as const,
      groupRef: group.temporaryId,
      tabIds: [...group.tabIds],
    },
    {
      operationId: `${group.temporaryId}:update`,
      kind: "update_group" as const,
      groupRef: group.temporaryId,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
    },
  ]);
  return {
    transactionId,
    targetWindowId: initial.windowId,
    rollbackSnapshot: cloneState(initial),
    expectedFinalState: projectExpectedState(initial, proposal),
    operationPlan,
    touchedTabIds: proposal.groups.flatMap((group) => group.tabIds),
    runtimeGroupIds: {},
    inFlightOperation: null,
    completedThrough: -1,
    status: "prepared",
  };
}
