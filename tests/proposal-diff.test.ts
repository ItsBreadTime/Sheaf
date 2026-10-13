import { describe, expect, it } from "vitest";
import {
  buildProposalDiff,
  changedProposalGroups,
  describeUngroupedCoverage,
  proposalDiffHasChanges,
} from "../src/organizer/proposal-diff";
import type {
  ImmutableRequestBundle,
  ValidatedProposal,
} from "../src/shared/organizer-types";
import type {
  SemanticGroup,
  SemanticTab,
  SemanticWindowState,
} from "../src/shared/types";

function tab(id: number, index: number, groupId = -1): SemanticTab {
  return {
    id,
    windowId: 7,
    index,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    groupId,
    active: false,
    pinned: false,
    audible: false,
    openerTabId: null,
    lastAccessed: null,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
  };
}

function group(id: number, title: string, members: number[]): SemanticGroup {
  return {
    runtimeId: id,
    windowId: 7,
    title,
    color: "blue",
    collapsed: false,
    shared: { known: true, value: false },
    memberTabIds: members,
    firstTabIndex: members[0] ?? 0,
    protectionReasons: [],
  };
}

function snapshot(): SemanticWindowState {
  const tabs = [
    tab(1, 0, 10),
    tab(2, 1, 10),
    tab(3, 2, 20),
    tab(4, 3, 20),
    tab(5, 4),
    tab(6, 5),
  ];
  return {
    windowId: 7,
    capturedAt: 1,
    tabs,
    groups: [group(10, "Alpha", [1, 2]), group(20, "Beta", [3, 4])],
    eligibleTabIds: tabs.map((item) => item.id),
    protectedTabIds: [],
    featureSupport: {
      sharedGroupProperty: true,
      splitViewIdProperty: true,
      storageSession: true,
    },
  };
}

function request(
  browserIds = [1, 2, 3, 4, 5, 6],
  groupColorMode: "ai" | "deterministic" = "deterministic",
): ImmutableRequestBundle {
  const ephemeralToBrowserTabId = Object.fromEntries(
    browserIds.map((browserId, index) => [index + 1, browserId]),
  );
  return {
    approvedRequest: {
      schemaVersion: 1,
      privacyLevel: 2,
      existingGroupMetadataIncluded: false,
      groupColorMode,
      inactivityPolicy: {
        generalSuggestionAfterHours: 24,
        lowValueSuggestionAfterHours: 6,
        closingRequiresManualReview: true,
      },
      tabs: [],
    },
    requestJson: "{}",
    submittedTabIds: browserIds.map((_, index) => index + 1),
    ephemeralToBrowserTabId,
    excludedTabs: [],
    byteLength: 2,
  };
}

describe("proposal before/after diff", () => {
  it("describes ungrouped coverage without ambiguous fractions", () => {
    expect(describeUngroupedCoverage({
      eligibleUngroupedSubmitted: 0,
      newlyGrouped: 0,
      remainUngrouped: 0,
      alreadyGroupedUntouched: 2,
    })).toBe("No ungrouped tabs in scope");
    expect(describeUngroupedCoverage({
      eligibleUngroupedSubmitted: 5,
      newlyGrouped: 4,
      remainUngrouped: 1,
      alreadyGroupedUntouched: 1,
    })).toBe("4 of 5 previously ungrouped tabs assigned");
  });

  it("distinguishes unchanged membership from a rename", () => {
    const proposal: ValidatedProposal = {
      schemaVersion: 1,
      groups: [
        { temporaryId: "alpha", title: "Alpha", tabIds: [1, 2] },
        { temporaryId: "beta", title: "Beta research", tabIds: [3, 4] },
      ],
      untouchedTabIds: [5, 6],
    };
    const diff = buildProposalDiff(snapshot(), request(), proposal);

    expect(diff.groups).toMatchObject([
      { temporaryId: "alpha", kinds: ["unchanged"], renamedFrom: null, color: "blue", colorSource: "existing" },
      { temporaryId: "beta", kinds: ["renamed"], renamedFrom: "Beta", title: "Beta research", color: "blue", colorSource: "existing" },
    ]);
    expect(diff.counts).toMatchObject({ unchanged: 1, renamed: 1, moved: 0 });
    expect(changedProposalGroups(diff)).toMatchObject([
      { temporaryId: "beta", kinds: ["renamed"] },
    ]);
    expect(proposalDiffHasChanges(diff)).toBe(true);
    expect(diff.coverage).toEqual({
      eligibleUngroupedSubmitted: 2,
      newlyGrouped: 0,
      remainUngrouped: 2,
      alreadyGroupedUntouched: 0,
    });
  });

  it("treats a fully unchanged proposal as having no reviewable changes", () => {
    const diff = buildProposalDiff(snapshot(), request(), {
      schemaVersion: 1,
      groups: [
        { temporaryId: "alpha", title: "Alpha", tabIds: [1, 2] },
        { temporaryId: "beta", title: "Beta", tabIds: [3, 4] },
      ],
      untouchedTabIds: [5, 6],
    });
    expect(changedProposalGroups(diff)).toEqual([]);
    expect(proposalDiffHasChanges(diff)).toBe(false);
  });

  it("shows AI colors for rebuilt groups and deterministic fallback otherwise", () => {
    const proposal: ValidatedProposal = {
      schemaVersion: 1,
      groups: [{ temporaryId: "new", title: "Reading", color: "orange", tabIds: [5, 6] }],
      untouchedTabIds: [1, 2, 3, 4],
    };

    expect(buildProposalDiff(snapshot(), request(undefined, "ai"), proposal).groups[0]).toMatchObject({
      color: "orange",
      colorSource: "ai",
    });
    expect(buildProposalDiff(snapshot(), request(), proposal).groups[0]).toMatchObject({
      colorSource: "deterministic",
    });
  });

  it("marks ungrouped assignments as a new group and moved tabs", () => {
    const proposal: ValidatedProposal = {
      schemaVersion: 1,
      groups: [{ temporaryId: "new", title: "Reading", tabIds: [5, 6] }],
      untouchedTabIds: [1, 2, 3, 4],
    };
    const diff = buildProposalDiff(snapshot(), request(), proposal);

    expect(diff.groups[0]).toMatchObject({ kinds: ["new"], beforeTitles: ["Ungrouped"] });
    expect(diff.tabs.filter((item) => item.kind === "moved")).toMatchObject([
      { tabId: 5, from: "Ungrouped", to: "Reading" },
      { tabId: 6, from: "Ungrouped", to: "Reading" },
    ]);
    expect(diff.coverage).toEqual({
      eligibleUngroupedSubmitted: 2,
      newlyGrouped: 2,
      remainUngrouped: 0,
      alreadyGroupedUntouched: 4,
    });
  });

  it("marks a destination assembled from multiple native groups as merged", () => {
    const proposal: ValidatedProposal = {
      schemaVersion: 1,
      groups: [{ temporaryId: "merged", title: "Combined", tabIds: [1, 2, 3, 4] }],
      untouchedTabIds: [5, 6],
    };
    const diff = buildProposalDiff(snapshot(), request(), proposal);

    expect(diff.groups[0]).toMatchObject({ kinds: ["merged"], beforeTitles: ["Alpha", "Beta"] });
    expect(diff.counts.moved).toBe(4);
  });

  it("detects a split even when the remaining source member is outside the request scope", () => {
    const scopedRequest = request([1, 5]);
    const proposal: ValidatedProposal = {
      schemaVersion: 1,
      groups: [{ temporaryId: "split", title: "Focused", tabIds: [1, 2] }],
      untouchedTabIds: [],
    };
    const diff = buildProposalDiff(snapshot(), scopedRequest, proposal);

    expect(diff.groups[0]?.kinds).toEqual(["merged", "split"]);
    expect(diff.groups[0]?.beforeTitles).toEqual(["Alpha", "Ungrouped"]);
    expect(diff.tabs).toMatchObject([
      { tabId: 1, kind: "moved", from: "Alpha", to: "Focused" },
      { tabId: 2, kind: "moved", from: "Ungrouped", to: "Focused" },
    ]);
  });
});
