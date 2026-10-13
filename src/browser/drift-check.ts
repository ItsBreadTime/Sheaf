import { normalizeOrganizerResponse } from "../organizer/normalize";
import { validateOrganizerResponse } from "../organizer/validate";
import type { ImmutableRequestBundle, ValidatedProposal } from "../shared/organizer-types";
import type {
  DriftCheckResult,
  ProposalInputSnapshot,
} from "../shared/proposal-review-types";
import type { FeatureValue, SemanticWindowState } from "../shared/types";

function sameFeatureValue<T>(
  left: FeatureValue<T>,
  right: FeatureValue<T>,
): boolean {
  return left.known === right.known && left.value === right.value;
}

function sameMemberSet(left: readonly number[], right: readonly number[]): boolean {
  const members = new Set(left);
  return members.size === new Set(right).size && right.every((id) => members.has(id));
}

// Reason order is not meaningful; compare as a set so a reorder does not force
// an unnecessary regeneration.
function sortedReasons(reasons: readonly string[]): string[] {
  return [...reasons].sort();
}

function filterClosedTabs(
  proposal: ValidatedProposal,
  closedIds: Set<number>,
  availableIds: number[],
): ValidatedProposal {
  const filtered: ValidatedProposal = {
    schemaVersion: 1,
    groups: proposal.groups.map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((tabId) => !closedIds.has(tabId)),
    })),
    untouchedTabIds: proposal.untouchedTabIds.filter(
      (tabId) => !closedIds.has(tabId),
    ),
    ungroupTabIds: (proposal.ungroupTabIds ?? []).filter(
      (tabId) => !closedIds.has(tabId),
    ),
    lowValueTabIds: (proposal.lowValueTabIds ?? []).filter(
      (tabId) => !closedIds.has(tabId),
    ),
  };
  const normalized = normalizeOrganizerResponse(filtered);
  validateOrganizerResponse(normalized, availableIds);
  return normalized;
}

export function checkProposalDrift(
  inputSnapshot: ProposalInputSnapshot,
  liveState: SemanticWindowState | null,
  request: ImmutableRequestBundle,
  proposal: ValidatedProposal,
): DriftCheckResult {
  if (!liveState || liveState.windowId !== inputSnapshot.browserState.windowId) {
    return {
      proposal,
      availableSubmittedTabIds: [],
      closedTabIds: [],
      warnings: [],
      regenerationReasons: ["The selected target window is no longer available."],
      signalAcknowledgementRequired: false,
      targetInvalid: true,
    };
  }
  const originalTabs = new Map(
    inputSnapshot.browserState.tabs.map((tab) => [tab.id, tab]),
  );
  const liveTabs = new Map(liveState.tabs.map((tab) => [tab.id, tab]));
  const closedEphemeralIds: number[] = [];
  const warnings: string[] = [];
  const regenerationReasons: string[] = [];
  let signalAcknowledgementRequired = false;

  for (const ephemeralId of request.submittedTabIds) {
    const browserTabId = request.ephemeralToBrowserTabId[ephemeralId];
    if (browserTabId === undefined) {
      regenerationReasons.push(`Submitted tab ${ephemeralId} has no browser mapping.`);
      continue;
    }
    const original = originalTabs.get(browserTabId);
    const live = liveTabs.get(browserTabId);
    if (!original || !live) {
      closedEphemeralIds.push(ephemeralId);
      continue;
    }
    const tab = quotedTabTitle(original.title);
    if (live.url !== original.url || live.title !== original.title) {
      regenerationReasons.push(`${tab} navigated to another page.`);
    }
    if (live.groupId !== original.groupId) {
      regenerationReasons.push(`${tab} was moved to a different group.`);
    }
    if (live.pinned !== original.pinned) {
      regenerationReasons.push(`${tab} was pinned or unpinned.`);
    }
    if (!sameFeatureValue(live.splitView, original.splitView)) {
      regenerationReasons.push(`${tab} joined or left a split view.`);
    }
    if (sortedReasons(live.protectionReasons).join("\n") !== sortedReasons(original.protectionReasons).join("\n")) {
      regenerationReasons.push(`${tab} became protected or unprotected.`);
    }
    if (live.active !== original.active || live.audible !== original.audible) {
      warnings.push(`${tab} became active or started or stopped playing sound.`);
      signalAcknowledgementRequired = true;
    }
  }

  if (
    (inputSnapshot.browserState.featureSupport.sharedGroupProperty &&
      !liveState.featureSupport.sharedGroupProperty) ||
    (inputSnapshot.browserState.featureSupport.splitViewIdProperty &&
      !liveState.featureSupport.splitViewIdProperty)
  ) {
    regenerationReasons.push("The browser stopped reporting a tab property the plan relies on.");
  }

  const originalGroups = new Map(
    inputSnapshot.browserState.groups.map((group) => [group.runtimeId, group]),
  );
  // Groups whose members the proposal will move, rename, recolor, or collapse.
  // A reused group keeps its runtime id but still gets the proposal's title and
  // color written, so a user rename in the meantime would be silently overwritten
  // unless it is compared here.
  const touchedBrowserTabIds = new Set<number>();
  const recordTouched = (ephemeralId: number): void => {
    const browserTabId = request.ephemeralToBrowserTabId[ephemeralId];
    if (browserTabId !== undefined) touchedBrowserTabIds.add(browserTabId);
  };
  for (const group of proposal.groups) {
    group.tabIds.forEach(recordTouched);
  }
  (proposal.ungroupTabIds ?? []).forEach(recordTouched);
  for (const liveGroup of liveState.groups) {
    const original = originalGroups.get(liveGroup.runtimeId);
    if (!original) continue;
    if (!sameFeatureValue(liveGroup.shared, original.shared)) {
      regenerationReasons.push("A tab group was shared or unshared.");
    }
    if (!liveGroup.memberTabIds.some((tabId) => touchedBrowserTabIds.has(tabId))) {
      continue;
    }
    if (
      liveGroup.title !== original.title ||
      liveGroup.color !== original.color ||
      liveGroup.collapsed !== original.collapsed
    ) {
      regenerationReasons.push(
        `The group ${quotedGroupTitle(original.title)} was renamed, recolored, collapsed, or expanded.`,
      );
    }
    if (!sameMemberSet(liveGroup.memberTabIds, original.memberTabIds)) {
      regenerationReasons.push(
        `Tabs were added to or removed from the group ${quotedGroupTitle(original.title)}.`,
      );
    }
  }

  const closedSet = new Set(closedEphemeralIds);
  const availableSubmittedTabIds = request.submittedTabIds.filter(
    (tabId) => !closedSet.has(tabId),
  );
  const adjustedProposal =
    closedSet.size > 0
      ? filterClosedTabs(proposal, closedSet, availableSubmittedTabIds)
      : structuredClone(proposal);
  if (closedSet.size > 0) {
    warnings.push(
      `${closedSet.size} submitted tab${closedSet.size === 1 ? " was" : "s were"} closed and removed from the proposal.`,
    );
  }
  return {
    proposal: adjustedProposal,
    availableSubmittedTabIds,
    closedTabIds: closedEphemeralIds,
    warnings: [...new Set(warnings)],
    regenerationReasons: [...new Set(regenerationReasons)],
    signalAcknowledgementRequired,
    targetInvalid: false,
  };
}

function quotedGroupTitle(title: string | undefined): string {
  const clean = (title ?? "").trim();
  return clean ? `“${clean}”` : "(untitled)";
}

/** A tab as the user knows it: its title, shortened, in quotes. */
export function quotedTabTitle(title: string | undefined): string {
  const clean = (title ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "An untitled tab";
  return `“${clean.length > 48 ? `${clean.slice(0, 47)}…` : clean}”`;
}
