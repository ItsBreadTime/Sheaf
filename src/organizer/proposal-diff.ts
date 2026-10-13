import { UNGROUPED_GROUP_ID } from "../shared/constants";
import { effectiveProposedGroupColor } from "./group-colors";
import type { ChromeGroupColor } from "../shared/group-colors";
import type {
  ImmutableRequestBundle,
  ValidatedProposal,
} from "../shared/organizer-types";
import type { SemanticWindowState } from "../shared/types";

export type ProposalGroupChangeKind =
  | "new"
  | "renamed"
  | "merged"
  | "split"
  | "unchanged";

export interface ProposalGroupChange {
  temporaryId: string;
  kinds: ProposalGroupChangeKind[];
  title: string;
  beforeTitles: string[];
  renamedFrom: string | null;
  color: ChromeGroupColor;
  colorSource: "existing" | "ai" | "deterministic";
}

export interface ProposalTabChange {
  tabId: number;
  kind: "moved" | "unchanged";
  from: string;
  to: string;
}

export interface ProposalDiff {
  groups: ProposalGroupChange[];
  tabs: ProposalTabChange[];
  counts: Record<ProposalGroupChangeKind | "moved", number>;
  coverage: {
    eligibleUngroupedSubmitted: number;
    newlyGrouped: number;
    remainUngrouped: number;
    alreadyGroupedUntouched: number;
  };
}

function proposalGroupHasChanges(group: ProposalGroupChange): boolean {
  return group.kinds.some((kind) => kind !== "unchanged");
}

export function changedProposalGroups(diff: ProposalDiff): ProposalGroupChange[] {
  return diff.groups.filter(proposalGroupHasChanges);
}

export function proposalDiffHasChanges(diff: ProposalDiff): boolean {
  return changedProposalGroups(diff).length > 0 || diff.counts.moved > 0;
}

export function describeUngroupedCoverage(
  coverage: ProposalDiff["coverage"],
): string {
  if (coverage.eligibleUngroupedSubmitted === 0) return "No ungrouped tabs in scope";
  return `${coverage.newlyGrouped} of ${coverage.eligibleUngroupedSubmitted} previously ungrouped tabs assigned`;
}

function readableGroupTitle(title: string): string {
  return title.trim() || "Untitled group";
}

export function buildProposalDiff(
  snapshot: SemanticWindowState,
  request: ImmutableRequestBundle,
  proposal: ValidatedProposal,
): ProposalDiff {
  const tabsByBrowserId = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  const groupsById = new Map(snapshot.groups.map((group) => [group.runtimeId, group]));
  const proposedBrowserIds = new Map(
    proposal.groups.map((group) => [
      group.temporaryId,
      group.tabIds.flatMap((tabId) => {
        const browserId = request.ephemeralToBrowserTabId[tabId];
        return browserId === undefined ? [] : [browserId];
      }),
    ]),
  );
  const destinationByBrowserId = new Map<number, string>();
  for (const [temporaryId, browserIds] of proposedBrowserIds) {
    browserIds.forEach((browserId) => destinationByBrowserId.set(browserId, temporaryId));
  }

  const splitSourceGroupIds = new Set<number>();
  for (const source of snapshot.groups) {
    const destinations = new Set(
      source.memberTabIds.map((browserId) => {
        const proposedDestination = destinationByBrowserId.get(browserId);
        return proposedDestination === undefined
          ? `existing:${source.runtimeId}`
          : `proposed:${proposedDestination}`;
      }),
    );
    if (destinations.size > 1) splitSourceGroupIds.add(source.runtimeId);
  }

  const groups: ProposalGroupChange[] = proposal.groups.map((proposed) => {
    const memberBrowserIds = proposedBrowserIds.get(proposed.temporaryId) ?? [];
    const memberSet = new Set(memberBrowserIds);
    const exact = snapshot.groups.find(
      (group) =>
        group.memberTabIds.length === memberSet.size &&
        group.memberTabIds.every((tabId) => memberSet.has(tabId)),
    );
    if (exact) {
      const oldTitle = readableGroupTitle(exact.title);
      const renamed = oldTitle !== readableGroupTitle(proposed.title);
      return {
        temporaryId: proposed.temporaryId,
        kinds: [renamed ? "renamed" : "unchanged"],
        title: readableGroupTitle(proposed.title),
        beforeTitles: [oldTitle],
        renamedFrom: renamed ? oldTitle : null,
        color: exact.color,
        colorSource: "existing",
      };
    }

    const sourceGroupIds = new Set<number>();
    let includesUngrouped = false;
    for (const browserId of memberBrowserIds) {
      const sourceGroupId = tabsByBrowserId.get(browserId)?.groupId;
      if (sourceGroupId === undefined || sourceGroupId === UNGROUPED_GROUP_ID) {
        includesUngrouped = true;
      } else {
        sourceGroupIds.add(sourceGroupId);
      }
    }
    const sourceCount = sourceGroupIds.size + (includesUngrouped ? 1 : 0);
    const kinds: ProposalGroupChangeKind[] = [];
    if (sourceCount > 1) kinds.push("merged");
    if ([...sourceGroupIds].some((groupId) => splitSourceGroupIds.has(groupId))) {
      kinds.push("split");
    }
    if (kinds.length === 0) kinds.push("new");
    const beforeTitles = [...sourceGroupIds].map((groupId) =>
      readableGroupTitle(groupsById.get(groupId)?.title ?? ""),
    );
    if (includesUngrouped) beforeTitles.push("Ungrouped");
    const effectiveColor = effectiveProposedGroupColor(
      proposed.title,
      proposed.color,
      request.approvedRequest.groupColorMode,
    );
    return {
      temporaryId: proposed.temporaryId,
      kinds,
      title: readableGroupTitle(proposed.title),
      beforeTitles,
      renamedFrom: null,
      color: effectiveColor.color,
      colorSource: effectiveColor.source,
    };
  });

  const exactSourceByDestination = new Map<string, number>();
  groups.forEach((change) => {
    if (!change.kinds.some((kind) => kind === "renamed" || kind === "unchanged")) return;
    const browserIds = proposedBrowserIds.get(change.temporaryId) ?? [];
    const firstGroupId = tabsByBrowserId.get(browserIds[0] ?? -1)?.groupId;
    if (firstGroupId !== undefined && firstGroupId !== UNGROUPED_GROUP_ID) {
      exactSourceByDestination.set(change.temporaryId, firstGroupId);
    }
  });

  const tabs: ProposalTabChange[] = [];
  for (const proposed of proposal.groups) {
    for (const ephemeralId of proposed.tabIds) {
      const browserId = request.ephemeralToBrowserTabId[ephemeralId];
      const original = browserId === undefined ? undefined : tabsByBrowserId.get(browserId);
      const sourceGroup = original && original.groupId !== UNGROUPED_GROUP_ID
        ? groupsById.get(original.groupId)
        : undefined;
      const from = sourceGroup ? readableGroupTitle(sourceGroup.title) : "Ungrouped";
      const exactSource = exactSourceByDestination.get(proposed.temporaryId);
      // A tab with no snapshot entry and no exact source is unknown, not
      // unchanged: `undefined === undefined` would otherwise report it unchanged.
      const unchanged = original !== undefined && exactSource !== undefined &&
        original.groupId === exactSource;
      tabs.push({
        tabId: ephemeralId,
        kind: unchanged ? "unchanged" : "moved",
        from,
        to: readableGroupTitle(proposed.title),
      });
    }
  }
  const leavingGroup = new Set(proposal.ungroupTabIds ?? []);
  for (const ephemeralId of proposal.untouchedTabIds) {
    const browserId = request.ephemeralToBrowserTabId[ephemeralId];
    const original = browserId === undefined ? undefined : tabsByBrowserId.get(browserId);
    const sourceGroup = original && original.groupId !== UNGROUPED_GROUP_ID
      ? groupsById.get(original.groupId)
      : undefined;
    const title = sourceGroup ? readableGroupTitle(sourceGroup.title) : "Ungrouped";
    if (sourceGroup && leavingGroup.has(ephemeralId)) {
      tabs.push({ tabId: ephemeralId, kind: "moved", from: title, to: "Ungrouped" });
    } else {
      tabs.push({ tabId: ephemeralId, kind: "unchanged", from: title, to: title });
    }
  }
  tabs.sort((left, right) => {
    const leftBrowserId = request.ephemeralToBrowserTabId[left.tabId] ?? Number.MAX_SAFE_INTEGER;
    const rightBrowserId = request.ephemeralToBrowserTabId[right.tabId] ?? Number.MAX_SAFE_INTEGER;
    const leftIndex = tabsByBrowserId.get(leftBrowserId)?.index ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = tabsByBrowserId.get(rightBrowserId)?.index ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });

  const counts: ProposalDiff["counts"] = {
    new: 0,
    renamed: 0,
    merged: 0,
    split: 0,
    unchanged: 0,
    moved: tabs.filter((tab) => tab.kind === "moved").length,
  };
  groups.forEach((group) => group.kinds.forEach((kind) => { counts[kind] += 1; }));
  const ungroupedSubmittedIds = new Set<number>();
  for (const ephemeralId of request.submittedTabIds) {
    const browserId = request.ephemeralToBrowserTabId[ephemeralId];
    if (browserId !== undefined && tabsByBrowserId.get(browserId)?.groupId === UNGROUPED_GROUP_ID) {
      ungroupedSubmittedIds.add(ephemeralId);
    }
  }
  const groupedProposalIds = new Set(proposal.groups.flatMap((group) => group.tabIds));
  const untouchedIds = new Set(proposal.untouchedTabIds);
  const coverage: ProposalDiff["coverage"] = {
    eligibleUngroupedSubmitted: ungroupedSubmittedIds.size,
    newlyGrouped: [...ungroupedSubmittedIds].filter((id) => groupedProposalIds.has(id)).length,
    remainUngrouped: [...ungroupedSubmittedIds].filter((id) => untouchedIds.has(id)).length,
    alreadyGroupedUntouched: proposal.untouchedTabIds.filter(
      (id) => !ungroupedSubmittedIds.has(id),
    ).length,
  };
  return { groups, tabs, counts, coverage };
}
