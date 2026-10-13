import { describe, expect, it } from "vitest";
import { fitProposedGroupTitle, MAX_GROUP_TITLE_CHARS, sanitizeGroupTitle } from "../src/organizer/normalize";
import { parseOrganizerResponse, ResponseSchemaError } from "../src/organizer/response-schema";
import {
  ORGANIZER_LIMITS,
  OrganizerValidationError,
  parseNormalizeAndValidateOrganizerResponse,
} from "../src/organizer/validate";

function validResponse(): unknown {
  return {
    schemaVersion: 1,
    groups: [
      {
        temporaryId: "group-1",
        title: "Project",
        tabIds: [1, 2],
      },
    ],
    untouchedTabIds: [3],
    lowValueTabIds: [],
  };
}

describe("organizer response schema", () => {
  it("accepts the exact schemaVersion 1 structure", () => {
    expect(parseOrganizerResponse(validResponse())).toEqual({
      ...validResponse() as object,
      ungroupTabIds: [],
    });
    expect(parseOrganizerResponse({
      ...validResponse() as object,
      ungroupTabIds: [3],
    })).toMatchObject({ ungroupTabIds: [3] });
  });

  it.each([
    ["unsupported schema version", { ...validResponse() as object, schemaVersion: 2 }],
    ["confidence", { ...validResponse() as object, confidence: 0.9 }],
    ["notes", { ...validResponse() as object, notes: "because" }],
    [
      "extra group property",
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: "A", tabIds: [1, 2], explanation: "because" }],
        untouchedTabIds: [],
      },
    ],
    [
      "unsupported group color",
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: "A", color: "teal", tabIds: [1, 2] }],
        untouchedTabIds: [],
      },
    ],
    [
      "non-integer tab ID",
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: "A", tabIds: [1.5, 2] }],
        untouchedTabIds: [],
      },
    ],
  ])("rejects %s", (_label, response) => {
    expect(() => parseOrganizerResponse(response)).toThrow(ResponseSchemaError);
  });

  it("accepts only native AI colors and treats null as deterministic fallback", () => {
    expect(parseOrganizerResponse({
      schemaVersion: 1,
      groups: [
        { temporaryId: "colored", title: "Gardening", color: "green", tabIds: [1, 2] },
        { temporaryId: "fallback", title: "Notes", color: null, tabIds: [3, 4] },
      ],
      untouchedTabIds: [],
    }).groups).toEqual([
      { temporaryId: "colored", title: "Gardening", color: "green", tabIds: [1, 2] },
      { temporaryId: "fallback", title: "Notes", tabIds: [3, 4] },
    ]);
  });
});

describe("organizer response normalization and validation", () => {
  it.each([
    ["empty", [], [1, 2, 3]],
    ["singleton", [3], [1, 2, 3]],
  ])("demotes %s provider groups to untouched without a repair call", (_label, tabIds, untouched) => {
    const result = parseNormalizeAndValidateOrganizerResponse(
      {
        schemaVersion: 1,
        groups: [
          { temporaryId: "invalid", title: "Invalid", tabIds },
        ],
        untouchedTabIds: tabIds.length === 0 ? [1, 2, 3] : [1, 2],
      },
      [1, 2, 3],
    );
    expect(result.groups).toEqual([]);
    expect(result.untouchedTabIds).toEqual(untouched);
  });

  it("accepts low-value annotations that overlap the grouping assignment", () => {
    const result = parseNormalizeAndValidateOrganizerResponse(
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "work", title: "Work", tabIds: [1, 2] }],
        untouchedTabIds: [3],
        lowValueTabIds: [2, 3],
      },
      [1, 2, 3],
    );
    expect(result.lowValueTabIds).toEqual([2, 3]);
  });

  it.each([
    ["unknown", [99, 2], [2]],
    ["duplicate", [2, 2], [2]],
  ])("drops %s low-value IDs", (_label, lowValueTabIds, expected) => {
    expect(parseNormalizeAndValidateOrganizerResponse(
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "work", title: "Work", tabIds: [1, 2] }],
        untouchedTabIds: [3],
        lowValueTabIds,
      },
      [1, 2, 3],
    ).lowValueTabIds).toEqual(expected);
  });

  it("removes control and bidi characters and caps titles by Unicode characters", () => {
    const dirtyTitle = `A\u0000B\u001fC\u007fD\u0085E\u061cF\u200eG\u202eH\u2067I${"🙂".repeat(80)}`;
    const sanitized = sanitizeGroupTitle(dirtyTitle);

    expect(sanitized).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(Array.from(sanitized)).toHaveLength(MAX_GROUP_TITLE_CHARS);

    const result = parseNormalizeAndValidateOrganizerResponse(
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: dirtyTitle, tabIds: [1, 2] }],
        untouchedTabIds: [],
      },
      [1, 2],
    );
    // The normalization path drops whole trailing words rather than cutting
    // mid-word, so it is bounded by the cap and free of the dirty characters.
    expect(result.groups[0]?.title).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(Array.from(result.groups[0]!.title).length).toBeLessThanOrEqual(MAX_GROUP_TITLE_CHARS);
    expect(result.groups[0]?.title.startsWith("A B C D")).toBe(true);
  });

  it("fits over-long proposed titles at a word boundary", () => {
    expect(fitProposedGroupTitle("Checkout Latency Incident")).toBe("Checkout Latency");
    expect(fitProposedGroupTitle("Smart Thermostat Purchase")).toBe("Smart Thermostat");
    expect(fitProposedGroupTitle("Sony A7 IV vs Canon R6 II")).toBe("Sony A7 IV vs Canon R6");
    expect(fitProposedGroupTitle("Mortgage & Pre-approval Docs")).toBe("Mortgage & Pre-approval");
    expect(fitProposedGroupTitle("  Kyoto Trip  ")).toBe("Kyoto Trip");
    expect(fitProposedGroupTitle("Supercalifragilisticexpialidocious")).toBe("Supercalifragilisticexpi");
  });

  it("renames duplicate or blank temporary IDs instead of rejecting them", () => {
    const result = parseNormalizeAndValidateOrganizerResponse(
      {
        schemaVersion: 1,
        groups: [
          { temporaryId: "same", title: "First", tabIds: [1, 2] },
          { temporaryId: "same", title: "Second", tabIds: [3, 4] },
          { temporaryId: " ", title: "Third", tabIds: [5, 6] },
        ],
        untouchedTabIds: [],
      },
      [1, 2, 3, 4, 5, 6],
    );
    expect(result.groups.map((group) => group.temporaryId)).toEqual(["same", "group-2", "group-3"]);
  });

  it.each([
    [
      "titles duplicated after trimming and case folding",
      [
        { temporaryId: "group-1", title: " Project ", tabIds: [1, 2] },
        { temporaryId: "group-2", title: "project", tabIds: [3, 4] },
      ],
      /duplicate group title "project" after trimming and case-insensitive comparison/,
    ],
  ])("rejects %s", (_label, groups, expectedError) => {
    expect(() => parseNormalizeAndValidateOrganizerResponse(
      { schemaVersion: 1, groups, untouchedTabIds: [] },
      [1, 2, 3, 4],
    )).toThrow(expectedError);
  });

  it.each([
    [
      "unknown IDs are dropped",
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: "A", tabIds: [1, 99, 2] }],
        untouchedTabIds: [3, 98],
      },
      [1, 2, 3],
      [[1, 2]],
      [3],
    ],
    [
      "a tab in a group and untouched stays untouched",
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: "A", tabIds: [1, 2, 3] }],
        untouchedTabIds: [3, 4],
      },
      [1, 2, 3, 4],
      [[1, 2]],
      [3, 4],
    ],
    [
      "a tab claimed by two groups stays untouched, and the emptied group dissolves",
      {
        schemaVersion: 1,
        groups: [
          { temporaryId: "group-1", title: "A", tabIds: [1, 2, 3] },
          { temporaryId: "group-2", title: "B", tabIds: [3, 4] },
        ],
        untouchedTabIds: [],
      },
      [1, 2, 3, 4],
      [[1, 2]],
      [4, 3],
    ],
    [
      "missing submitted IDs become untouched in submitted order",
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: "A", tabIds: [1, 2] }],
        untouchedTabIds: [5],
      },
      [1, 2, 3, 4, 5],
      [[1, 2]],
      [5, 3, 4],
    ],
    [
      "duplicates inside one group collapse",
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: "A", tabIds: [1, 1, 2] }],
        untouchedTabIds: [3, 3],
      },
      [1, 2, 3],
      [[1, 2]],
      [3],
    ],
  ])("auto-fixes coverage only by doing less: %s", (_label, response, submittedIds, groups, untouched) => {
    const result = parseNormalizeAndValidateOrganizerResponse(response, submittedIds as number[]);
    expect(result.groups.map((group) => group.tabIds)).toEqual(groups);
    expect(result.untouchedTabIds).toEqual(untouched);
  });

  it("keeps ungroupTabIds only for untouched tabs", () => {
    const result = parseNormalizeAndValidateOrganizerResponse(
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: "A", tabIds: [1, 2] }],
        untouchedTabIds: [3, 4],
        ungroupTabIds: [2, 4, 4, 99],
      },
      [1, 2, 3, 4],
    );
    expect(result.ungroupTabIds).toEqual([4]);
  });

  it("preserves the model's tab order inside groups and untouched", () => {
    const result = parseNormalizeAndValidateOrganizerResponse(
      {
        schemaVersion: 1,
        groups: [{ temporaryId: "group-1", title: "A", tabIds: [3, 1] }],
        untouchedTabIds: [4, 2],
      },
      [1, 2, 3, 4],
    );
    expect(result.groups[0]?.tabIds).toEqual([3, 1]);
    expect(result.untouchedTabIds).toEqual([4, 2]);
  });

  it("accepts as many coherent groups as the submitted tabs support", () => {
    const groups = Array.from(
      { length: 44 },
      (_, index) => ({
        temporaryId: `group-${index + 1}`,
        title: `Topic ${index + 1}`,
        tabIds: [index * 2 + 1, index * 2 + 2],
      }),
    );
    const submittedIds = Array.from({ length: 88 }, (_, index) => index + 1);
    const result = parseNormalizeAndValidateOrganizerResponse(
      {
        schemaVersion: 1,
        groups,
        untouchedTabIds: [],
      },
      submittedIds,
    );
    expect(result.groups).toHaveLength(44);
  });

  it("rejects more than 100 tabs in a group", () => {
    const tabIds = Array.from(
      { length: ORGANIZER_LIMITS.MAX_TABS_PER_GROUP + 1 },
      (_, index) => index + 1,
    );
    expect(() =>
      parseNormalizeAndValidateOrganizerResponse(
        {
          schemaVersion: 1,
          groups: [{ temporaryId: "group-1", title: "A", tabIds }],
          untouchedTabIds: [],
        },
        tabIds,
      ),
    ).toThrow(/more than 100 tabs/);
  });

  it("surfaces strict-schema issues as repair-safe validation errors", () => {
    try {
      parseNormalizeAndValidateOrganizerResponse(
        { ...validResponse() as object, notes: "untrusted explanation" },
        [1, 2, 3],
      );
      throw new Error("Expected response rejection");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OrganizerValidationError);
      expect((error as OrganizerValidationError).issues).toEqual([
        'response contains unsupported property "notes"',
      ]);
    }
  });
});
