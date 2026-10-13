import { describe, expect, it } from "vitest";
import {
  normalizeGroupNamePreferences,
  preferredGroupNameVocabulary,
  recordApprovedGroupNames,
  shouldRecordGroupNameApprovals,
} from "../src/organizer/group-name-memory";

describe("approved group-name memory", () => {
  it("only treats user-confirmed Apply as approval", () => {
    expect(shouldRecordGroupNameApprovals("user")).toBe(true);
    expect(shouldRecordGroupNameApprovals("automatic")).toBe(false);
    expect(shouldRecordGroupNameApprovals(null)).toBe(false);
  });

  it("counts each approved name once per run and promotes it after two approvals", () => {
    const first = recordApprovedGroupNames([], ["Physics class", "Physics class"], 100);
    expect(first).toEqual([
      { name: "Physics class", approvalCount: 1, lastApprovedAt: 100 },
    ]);
    expect(preferredGroupNameVocabulary(first)).toEqual([]);

    const second = recordApprovedGroupNames(first, ["physics class", "Toy catalog"], 200);
    expect(second).toEqual([
      { name: "Physics class", approvalCount: 2, lastApprovedAt: 200 },
      { name: "Toy catalog", approvalCount: 1, lastApprovedAt: 200 },
    ]);
    expect(preferredGroupNameVocabulary(second)).toEqual(["Physics class"]);
  });

  it("normalizes, deduplicates, and orders editable stored preferences", () => {
    expect(normalizeGroupNamePreferences([
      { name: " Work ", approvalCount: 2, lastApprovedAt: 10 },
      { name: "work", approvalCount: 9, lastApprovedAt: 20 },
      { name: "Reading", approvalCount: 3, lastApprovedAt: 5 },
      { name: "", approvalCount: 4, lastApprovedAt: 5 },
    ])).toEqual([
      { name: "Reading", approvalCount: 3, lastApprovedAt: 5 },
      { name: "Work", approvalCount: 2, lastApprovedAt: 10 },
    ]);
  });
});
