import { sanitizeGroupTitle } from "./normalize";
import { LIMITS } from "../shared/limits";
import { UNTOUCHED_PROPOSAL_DESTINATION } from "../shared/constants";
import type { ValidatedProposal } from "../shared/organizer-types";
import { isChromeGroupColor, type ChromeGroupColor } from "../shared/group-colors";
import type {
  DriftCheckResult,
  ProposalInputSnapshot,
  ProposalReviewState,
} from "../shared/proposal-review-types";

function cloneProposal(proposal: ValidatedProposal): ValidatedProposal {
  return structuredClone(proposal);
}

export function maxPossibleProposalGroups(submittedTabCount: number): number {
  return Math.floor(Math.max(0, submittedTabCount) / LIMITS.MIN_GROUP_SIZE);
}

// Order is meaningful: it is the proposal's arrangement of tabs inside each group
// and among loose tabs, so edits keep it and only append moved tabs.
function normalizeOrder(proposal: ValidatedProposal): ValidatedProposal {
  const untouched = new Set(proposal.untouchedTabIds);
  return {
    schemaVersion: 1,
    groups: proposal.groups.map((group) => ({
      temporaryId: group.temporaryId,
      title: sanitizeGroupTitle(group.title),
      ...(group.color ? { color: group.color } : {}),
      tabIds: [...group.tabIds],
    })),
    untouchedTabIds: [...proposal.untouchedTabIds],
    ungroupTabIds: (proposal.ungroupTabIds ?? []).filter((tabId) => untouched.has(tabId)),
    lowValueTabIds: [...(proposal.lowValueTabIds ?? [])],
  };
}

function validateEditableProposal(
  proposal: ValidatedProposal,
  submittedTabIds: readonly number[],
): string[] {
  const issues: string[] = [];
  const maximumGroups = maxPossibleProposalGroups(submittedTabIds.length);
  if (proposal.groups.length > maximumGroups) {
    issues.push(
      `Proposal contains ${proposal.groups.length} groups, but ${submittedTabIds.length} submitted tabs can support at most ${maximumGroups}.`,
    );
  }
  const known = new Set(submittedTabIds);
  const occurrences = new Map<number, number>();
  const groupIds = new Set<string>();
  const groupTitles = new Set<string>();
  const record = (tabId: number): void => {
    occurrences.set(tabId, (occurrences.get(tabId) ?? 0) + 1);
    if (!known.has(tabId)) issues.push(`Proposal contains unknown tab ID ${tabId}.`);
  };

  proposal.groups.forEach((group, index) => {
    if (!group.temporaryId.trim()) issues.push(`Group ${index + 1} has no temporary ID.`);
    else if (groupIds.has(group.temporaryId)) {
      issues.push(`Group temporary ID ${group.temporaryId} is duplicated.`);
    }
    groupIds.add(group.temporaryId);
    const trimmedTitle = group.title.trim();
    const normalizedTitle = trimmedTitle.toLowerCase();
    if (!trimmedTitle) issues.push(`Group ${index + 1} needs a title.`);
    else if (groupTitles.has(normalizedTitle)) {
      issues.push(`Group title “${trimmedTitle}” is duplicated after trimming and case-insensitive comparison.`);
    }
    groupTitles.add(normalizedTitle);
    if (group.tabIds.length === 0) {
      issues.push(`Group “${group.title || index + 1}” is empty; add tabs or delete it.`);
    } else if (group.tabIds.length < LIMITS.MIN_GROUP_SIZE) {
      issues.push(`Group “${group.title || index + 1}” needs at least two tabs.`);
    }
    if (group.tabIds.length > LIMITS.MAX_TABS_PER_GROUP) {
      issues.push(
        `Group “${group.title || index + 1}” exceeds ${LIMITS.MAX_TABS_PER_GROUP} tabs.`,
      );
    }
    group.tabIds.forEach(record);
  });
  proposal.untouchedTabIds.forEach(record);
  for (const [tabId, count] of occurrences) {
    if (count > 1) issues.push(`Tab ID ${tabId} appears ${count} times.`);
  }
  for (const tabId of known) {
    if (!occurrences.has(tabId)) issues.push(`Submitted tab ID ${tabId} is missing.`);
  }
  return [...new Set(issues)];
}

function withEditedProposal(
  state: ProposalReviewState,
  proposal: ValidatedProposal,
): ProposalReviewState {
  const normalized = normalizeOrder(proposal);
  return {
    ...state,
    proposal: normalized,
    revision: state.revision + 1,
    validationIssues: validateEditableProposal(
      normalized,
      state.availableSubmittedTabIds,
    ),
    confirmedAt: null,
    confirmationSource: null,
    status:
      state.regenerationReasons.length > 0
        ? "regeneration_required"
        : "review_required",
  };
}

export function createProposalReviewState(
  proposal: ValidatedProposal,
  request: ProposalReviewState["request"],
  inputSnapshot: ProposalInputSnapshot,
  generation?: ProposalReviewState["generation"],
): ProposalReviewState {
  const normalized = normalizeOrder(proposal);
  return {
    reviewId: crypto.randomUUID(),
    request,
    inputSnapshot,
    proposal: normalized,
    availableSubmittedTabIds: [...request.submittedTabIds],
    revision: 0,
    validationIssues: validateEditableProposal(normalized, request.submittedTabIds),
    driftWarnings: [],
    regenerationReasons: [],
    signalAcknowledgementRequired: false,
    confirmedAt: null,
    confirmationSource: null,
    status: "review_required",
    ...(generation ? { generation } : {}),
  };
}

export function renameProposedGroup(
  state: ProposalReviewState,
  temporaryId: string,
  title: string,
): ProposalReviewState {
  const proposal = cloneProposal(state.proposal);
  const group = proposal.groups.find((candidate) => candidate.temporaryId === temporaryId);
  if (!group) throw new Error(`Group ${temporaryId} is unavailable.`);
  group.title = sanitizeGroupTitle(title);
  return withEditedProposal(state, proposal);
}

export function recolorProposedGroup(
  state: ProposalReviewState,
  temporaryId: string,
  color: ChromeGroupColor,
): ProposalReviewState {
  if (!isChromeGroupColor(color)) throw new Error("Choose a supported Chrome group color.");
  const proposal = cloneProposal(state.proposal);
  const group = proposal.groups.find((candidate) => candidate.temporaryId === temporaryId);
  if (!group) throw new Error(`Group ${temporaryId} is unavailable.`);
  group.color = color;
  return withEditedProposal(state, proposal);
}

export function moveProposedTab(
  state: ProposalReviewState,
  tabId: number,
  destination: string | typeof UNTOUCHED_PROPOSAL_DESTINATION,
): ProposalReviewState {
  if (!state.availableSubmittedTabIds.includes(tabId)) {
    throw new Error(`Submitted tab ${tabId} is unavailable.`);
  }
  const proposal = cloneProposal(state.proposal);
  proposal.groups.forEach((group) => {
    group.tabIds = group.tabIds.filter((candidate) => candidate !== tabId);
  });
  proposal.untouchedTabIds = proposal.untouchedTabIds.filter(
    (candidate) => candidate !== tabId,
  );
  if (destination === UNTOUCHED_PROPOSAL_DESTINATION) proposal.untouchedTabIds.push(tabId);
  else {
    const group = proposal.groups.find(
      (candidate) => candidate.temporaryId === destination,
    );
    if (!group) throw new Error(`Destination group ${destination} is unavailable.`);
    group.tabIds.push(tabId);
  }
  return withEditedProposal(state, proposal);
}

export function addProposedGroup(state: ProposalReviewState): ProposalReviewState {
  const maximumGroups = maxPossibleProposalGroups(state.availableSubmittedTabIds.length);
  if (state.proposal.groups.length >= maximumGroups) {
    throw new Error(
      `${state.availableSubmittedTabIds.length} submitted tabs can support at most ${maximumGroups} groups with two tabs each.`,
    );
  }
  const proposal = cloneProposal(state.proposal);
  let index = 1;
  while (proposal.groups.some((group) => group.temporaryId === `user-group-${index}`)) {
    index += 1;
  }
  proposal.groups.push({
    temporaryId: `user-group-${index}`,
    title: "New group",
    tabIds: [],
  });
  return withEditedProposal(state, proposal);
}

export function deleteEmptyProposedGroup(
  state: ProposalReviewState,
  temporaryId: string,
): ProposalReviewState {
  const group = state.proposal.groups.find(
    (candidate) => candidate.temporaryId === temporaryId,
  );
  if (!group) throw new Error(`Group ${temporaryId} is unavailable.`);
  if (group.tabIds.length > 0) throw new Error("Only an empty group can be deleted.");
  const proposal = cloneProposal(state.proposal);
  proposal.groups = proposal.groups.filter(
    (candidate) => candidate.temporaryId !== temporaryId,
  );
  return withEditedProposal(state, proposal);
}

export function acknowledgeSignalDrift(
  state: ProposalReviewState,
): ProposalReviewState {
  return {
    ...state,
    signalAcknowledgementRequired: false,
    confirmedAt: null,
    confirmationSource: null,
    status:
      state.regenerationReasons.length > 0
        ? "regeneration_required"
        : "review_required",
  };
}

export function applyDriftCheckResult(
  state: ProposalReviewState,
  result: DriftCheckResult,
): ProposalReviewState {
  const validationIssues = result.targetInvalid
    ? ["The target window is unavailable."]
    : validateEditableProposal(
        result.proposal,
        result.availableSubmittedTabIds,
      );
  return {
    ...state,
    proposal: normalizeOrder(result.proposal),
    availableSubmittedTabIds: [...result.availableSubmittedTabIds],
    revision: state.revision + 1,
    validationIssues,
    driftWarnings: [...result.warnings],
    regenerationReasons: [...result.regenerationReasons],
    signalAcknowledgementRequired: result.signalAcknowledgementRequired,
    confirmedAt: null,
    confirmationSource: null,
    status: result.targetInvalid
      ? "target_invalid"
      : result.regenerationReasons.length > 0
        ? "regeneration_required"
        : "review_required",
  };
}

export function confirmProposalReview(
  state: ProposalReviewState,
  now = Date.now(),
  source: ProposalReviewState["confirmationSource"] = "user",
): ProposalReviewState {
  const issues = validateEditableProposal(
    state.proposal,
    state.availableSubmittedTabIds,
  );
  if (issues.length > 0) throw new Error(issues.join(" "));
  if (state.regenerationReasons.length > 0) {
    throw new Error("Regenerate the proposal before confirming it.");
  }
  if (state.signalAcknowledgementRequired) {
    throw new Error("Acknowledge the active or audible tab changes first.");
  }
  return {
    ...state,
    validationIssues: [],
    confirmedAt: now,
    confirmationSource: source,
    status: "confirmed",
  };
}
