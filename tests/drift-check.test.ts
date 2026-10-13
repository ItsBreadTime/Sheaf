import { describe, expect, it } from "vitest";
import { checkProposalDrift } from "../src/browser/drift-check";
import type { ImmutableRequestBundle, ValidatedProposal } from "../src/shared/organizer-types";
import type { ProposalInputSnapshot } from "../src/shared/proposal-review-types";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";

function tab(id: number, index: number): SemanticTab {
  return {
    id,
    windowId: 7,
    index,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    groupId: -1,
    active: id === 41,
    pinned: false,
    audible: false,
    openerTabId: null,
    lastAccessed: null,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
  };
}

function state(tabs = [tab(41, 0), tab(42, 1), tab(43, 2)]): SemanticWindowState {
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
    requestJson: "{}",
    submittedTabIds: [1, 2, 3],
    ephemeralToBrowserTabId: { 1: 41, 2: 42, 3: 43 },
    excludedTabs: [],
    byteLength: 2,
  };
}

function proposal(): ValidatedProposal {
  return {
    schemaVersion: 1,
    groups: [{ temporaryId: "g", title: "Group", tabIds: [1, 2] }],
    untouchedTabIds: [3],
  };
}

function snapshot(): ProposalInputSnapshot {
  return { browserState: state(), requestHash: "a".repeat(64), capturedAt: 1 };
}

describe("proposal drift policy", () => {
  it("removes closed tabs, normalizes singleton groups, and requires review", () => {
    const live = state([tab(41, 0), tab(43, 1)]);
    const result = checkProposalDrift(snapshot(), live, request(), proposal());
    expect(result.closedTabIds).toEqual([2]);
    expect(result.proposal.groups).toEqual([]);
    expect(result.proposal.untouchedTabIds).toEqual([3, 1]);
    expect(result.availableSubmittedTabIds).toEqual([1, 3]);
    expect(result.warnings[0]).toMatch(/closed and removed/);
    expect(result.regenerationReasons).toEqual([]);
  });

  it("requires regeneration for navigation, grouping, pinned, or safety drift", () => {
    const changed = [tab(41, 0), tab(42, 1), tab(43, 2)];
    changed[0]!.url = "https://example.com/new";
    changed[1]!.groupId = 10;
    changed[2]!.pinned = true;
    changed[2]!.protectionReasons = ["Pinned tab"];
    const result = checkProposalDrift(snapshot(), state(changed), request(), proposal());
    expect(result.regenerationReasons).toEqual(
      expect.arrayContaining([
        "“Tab 41” navigated to another page.",
        "“Tab 42” was moved to a different group.",
        "“Tab 43” was pinned or unpinned.",
        "“Tab 43” became protected or unprotected.",
      ]),
    );
  });

  it("requires explicit acknowledgement for active or audible changes", () => {
    const changed = [tab(41, 0), tab(42, 1), tab(43, 2)];
    changed[0]!.active = false;
    changed[1]!.active = true;
    changed[2]!.audible = true;
    const result = checkProposalDrift(snapshot(), state(changed), request(), proposal());
    expect(result.signalAcknowledgementRequired).toBe(true);
    expect(result.warnings).toHaveLength(3);
    expect(result.regenerationReasons).toEqual([]);
  });

  it("invalidates a closed target window", () => {
    const result = checkProposalDrift(snapshot(), null, request(), proposal());
    expect(result.targetInvalid).toBe(true);
    expect(result.regenerationReasons[0]).toMatch(/target window/);
  });

  it("requires regeneration when split-view support or value changes", () => {
    const changed = state();
    changed.tabs[0]!.splitView = { known: true, value: 99 };
    changed.featureSupport.splitViewIdProperty = false;
    const result = checkProposalDrift(snapshot(), changed, request(), proposal());
    expect(result.regenerationReasons).toEqual(expect.arrayContaining([
      "“Tab 41” joined or left a split view.",
      "The browser stopped reporting a tab property the plan relies on.",
    ]));
  });

  it("requires regeneration when a native group becomes shared", () => {
    const original = snapshot();
    original.browserState.tabs[0]!.groupId = 10;
    original.browserState.groups = [group(false)];
    const live = structuredClone(original.browserState);
    live.groups[0]!.shared = { known: true, value: true };
    const result = checkProposalDrift(original, live, request(), proposal());
    expect(result.regenerationReasons).toContain("A tab group was shared or unshared.");
  });

  it("requires regeneration when a touched group is renamed, recolored, collapsed, or regrown", () => {
    const original = snapshot();
    original.browserState.tabs[0]!.groupId = 10;
    original.browserState.tabs[1]!.groupId = 10;
    original.browserState.groups = [{ ...group(false), memberTabIds: [41, 42] }];
    const renamed = structuredClone(original.browserState);
    renamed.groups[0]!.title = "User renamed";
    expect(
      checkProposalDrift(original, renamed, request(), proposal()).regenerationReasons,
    ).toContainEqual(expect.stringMatching(/was renamed, recolored, collapsed, or expanded/));

    const recolored = structuredClone(original.browserState);
    recolored.groups[0]!.color = "red";
    expect(
      checkProposalDrift(original, recolored, request(), proposal()).regenerationReasons,
    ).toContainEqual(expect.stringMatching(/was renamed, recolored, collapsed, or expanded/));

    const collapsed = structuredClone(original.browserState);
    collapsed.groups[0]!.collapsed = true;
    expect(
      checkProposalDrift(original, collapsed, request(), proposal()).regenerationReasons,
    ).toContainEqual(expect.stringMatching(/was renamed, recolored, collapsed, or expanded/));

    const regrown = structuredClone(original.browserState);
    regrown.groups[0]!.memberTabIds = [41, 42, 99];
    regrown.tabs.push(tab(99, 3));
    expect(
      checkProposalDrift(original, regrown, request(), proposal()).regenerationReasons,
    ).toContainEqual(expect.stringMatching(/Tabs were added to or removed from the group/));
  });

  it("ignores changes to groups the proposal does not touch", () => {
    const original = snapshot();
    original.browserState.groups = [{ ...group(false), runtimeId: 77, memberTabIds: [43] }];
    const live = structuredClone(original.browserState);
    live.groups[0]!.title = "Renamed elsewhere";
    expect(checkProposalDrift(original, live, request(), proposal()).regenerationReasons).toEqual([]);
  });
});

function group(shared: boolean): SemanticGroup {
  return {
    runtimeId: 10,
    windowId: 7,
    title: "Mutable",
    color: "blue",
    collapsed: false,
    shared: { known: true, value: shared },
    memberTabIds: [41],
    firstTabIndex: 0,
    protectionReasons: [],
  };
}
