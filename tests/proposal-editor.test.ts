import { describe, expect, it } from "vitest";
import {
  addProposedGroup,
  confirmProposalReview,
  createProposalReviewState,
  deleteEmptyProposedGroup,
  moveProposedTab,
  maxPossibleProposalGroups,
  recolorProposedGroup,
  renameProposedGroup,
} from "../src/organizer/proposal-editor";
import type { ImmutableRequestBundle, ValidatedProposal } from "../src/shared/organizer-types";
import type { ProposalInputSnapshot } from "../src/shared/proposal-review-types";
import type { SemanticTab, SemanticWindowState } from "../src/shared/types";

function tab(id: number, index: number): SemanticTab {
  return {
    id,
    windowId: 7,
    index,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
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

function browserState(): SemanticWindowState {
  const tabs = [tab(41, 0), tab(42, 1), tab(43, 2), tab(44, 3)];
  return {
    windowId: 7,
    capturedAt: 1,
    tabs,
    groups: [],
    eligibleTabIds: tabs.map((item) => item.id),
    protectedTabIds: [],
    featureSupport: {
      sharedGroupProperty: true,
      splitViewIdProperty: true,
      storageSession: true,
    },
  };
}

function request(): ImmutableRequestBundle {
  const approvedRequest = {
    schemaVersion: 1 as const,
    privacyLevel: 2 as const,
    existingGroupMetadataIncluded: false,
    inactivityPolicy: { generalSuggestionAfterHours: 24, lowValueSuggestionAfterHours: 6, closingRequiresManualReview: true as const },
    tabs: [],
  };
  return {
    approvedRequest,
    requestJson: JSON.stringify(approvedRequest),
    submittedTabIds: [1, 2, 3, 4],
    ephemeralToBrowserTabId: { 1: 41, 2: 42, 3: 43, 4: 44 },
    excludedTabs: [],
    byteLength: 1,
  };
}

function proposal(): ValidatedProposal {
  return {
    schemaVersion: 1,
    groups: [
      { temporaryId: "g1", title: "First", tabIds: [1, 2] },
      { temporaryId: "g2", title: "Second", tabIds: [3, 4] },
    ],
    untouchedTabIds: [],
  };
}

function inputSnapshot(): ProposalInputSnapshot {
  return { browserState: browserState(), requestHash: "f".repeat(64), capturedAt: 1 };
}

describe("editable proposal state", () => {
  it("renames with sanitization and invalidates confirmation", () => {
    const state = createProposalReviewState(proposal(), request(), inputSnapshot());
    const confirmed = confirmProposalReview(state, 100);
    expect(confirmed.confirmationSource).toBe("user");
    const renamed = renameProposedGroup(confirmed, "g1", " Work\u202e\u0000  ");
    // Control and bidi characters are handled and the title is trimmed, matching
    // the sanitizer the applied title and the group-name memory both use.
    expect(renamed.proposal.groups[0]?.title).toBe("Work");
    expect(renamed.confirmedAt).toBeNull();
    expect(renamed.status).toBe("review_required");
    expect(renamed.validationIssues).toEqual([]);
  });

  it("preserves an edited Chrome color through later proposal edits", () => {
    const state = createProposalReviewState(proposal(), request(), inputSnapshot());
    const recolored = recolorProposedGroup(state, "g1", "green");
    expect(recolored.proposal.groups[0]?.color).toBe("green");
    expect(recolored.confirmedAt).toBeNull();

    const renamed = renameProposedGroup(recolored, "g1", "Focused work");
    const moved = moveProposedTab(renamed, 3, "g1");
    expect(moved.proposal.groups[0]).toMatchObject({
      title: "Focused work",
      color: "green",
      tabIds: [1, 2, 3],
    });
  });

  it("rejects unsupported Chrome colors", () => {
    const state = createProposalReviewState(proposal(), request(), inputSnapshot());
    expect(() => recolorProposedGroup(state, "g1", "teal" as never)).toThrow(
      "Choose a supported Chrome group color.",
    );
  });

  it("distinguishes automatic confirmation from explicit review", () => {
    const state = createProposalReviewState(proposal(), request(), inputSnapshot());
    const confirmed = confirmProposalReview(state, 100, "automatic");
    expect(confirmed).toMatchObject({
      status: "confirmed",
      confirmedAt: 100,
      confirmationSource: "automatic",
    });
    expect(renameProposedGroup(confirmed, "g1", "Renamed").confirmationSource).toBeNull();
  });

  it("moves tabs deterministically between groups and Untouched", () => {
    let state = createProposalReviewState(proposal(), request(), inputSnapshot());
    state = moveProposedTab(state, 2, "g2");
    expect(state.proposal.groups[0]?.tabIds).toEqual([1]);
    // A moved tab joins the end of its destination; the proposal's order is kept.
    expect(state.proposal.groups[1]?.tabIds).toEqual([3, 4, 2]);
    expect(state.validationIssues).toContain("Group “First” needs at least two tabs.");
    state = moveProposedTab(state, 1, "untouched");
    expect(state.proposal.untouchedTabIds).toEqual([1]);
    expect(state.validationIssues).toContain("Group “First” is empty; add tabs or delete it.");
  });

  it("keeps the proposal's arrangement order and drops ungroup flags for grouped tabs", () => {
    const arranged = proposal();
    arranged.groups[1]!.tabIds = [4, 3];
    arranged.groups[0]!.tabIds = [1];
    arranged.untouchedTabIds = [2];
    arranged.ungroupTabIds = [2];
    let state = createProposalReviewState(arranged, request(), inputSnapshot());
    expect(state.proposal.groups[1]?.tabIds).toEqual([4, 3]);
    expect(state.proposal.ungroupTabIds).toEqual([2]);
    state = moveProposedTab(state, 2, "g1");
    expect(state.proposal.ungroupTabIds).toEqual([]);
  });

  it("adds an empty group and deletes only empty groups", () => {
    const oneGroup = proposal();
    oneGroup.groups = oneGroup.groups.slice(0, 1);
    oneGroup.untouchedTabIds = [3, 4];
    const state = createProposalReviewState(oneGroup, request(), inputSnapshot());
    const added = addProposedGroup(state);
    expect(added.proposal.groups.at(-1)).toMatchObject({
      temporaryId: "user-group-1",
      tabIds: [],
    });
    expect(() => deleteEmptyProposedGroup(added, "g1")).toThrow("Only an empty group");
    const removed = deleteEmptyProposedGroup(added, "user-group-1");
    expect(removed.proposal.groups).toHaveLength(1);
    expect(removed.validationIssues).toEqual([]);
  });

  it("derives the manual group bound from submitted tabs instead of a product cap", () => {
    expect(maxPossibleProposalGroups(88)).toBe(44);
    expect(maxPossibleProposalGroups(5)).toBe(2);

    const submittedTabIds = Array.from({ length: 88 }, (_, index) => index + 1);
    const largeRequest = request();
    largeRequest.submittedTabIds = submittedTabIds;
    largeRequest.ephemeralToBrowserTabId = Object.fromEntries(
      submittedTabIds.map((id) => [id, id + 100]),
    );
    const groups = Array.from({ length: 44 }, (_, index) => ({
      temporaryId: `g-${index + 1}`,
      title: `Topic ${index + 1}`,
      tabIds: [index * 2 + 1, index * 2 + 2],
    }));
    const state = createProposalReviewState(
      { schemaVersion: 1, groups, untouchedTabIds: [] },
      largeRequest,
      inputSnapshot(),
    );
    expect(state.validationIssues).toEqual([]);
    expect(() => addProposedGroup(state)).toThrow(
      "88 submitted tabs can support at most 44 groups with two tabs each.",
    );
  });

  it("blocks duplicate titles after trimming and case-insensitive comparison", () => {
    const state = createProposalReviewState(proposal(), request(), inputSnapshot());
    const renamed = renameProposedGroup(state, "g2", " first ");
    expect(renamed.validationIssues).toContain(
      "Group title “first” is duplicated after trimming and case-insensitive comparison.",
    );
    expect(() => confirmProposalReview(renamed)).toThrow("duplicated");
  });

  it("refuses confirmation while local validation fails", () => {
    const oneGroup = proposal();
    oneGroup.groups = oneGroup.groups.slice(0, 1);
    oneGroup.untouchedTabIds = [3, 4];
    const state = addProposedGroup(
      createProposalReviewState(oneGroup, request(), inputSnapshot()),
    );
    expect(() => confirmProposalReview(state)).toThrow("is empty");
  });
});
