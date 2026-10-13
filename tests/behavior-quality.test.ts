import { describe, expect, it } from "vitest";
import {
  scoreBehaviorResponse,
  type BehaviorCaseSpec,
} from "../scripts/lib/behavior-quality";

const spec: BehaviorCaseSpec = {
  groups: [
    {
      tabIds: [1, 2, 3],
      title: {
        preferred: ["Kyoto Trip"],
        requiredAll: ["Kyoto"],
        requiredAny: ["Trip", "Travel"],
        forbidden: ["Google"],
      },
    },
  ],
  untouchedTabIds: [4],
  lowValueTabIds: [],
  colorMode: "deterministic",
};

function response(
  groups: Array<{ temporaryId: string; title: string; color: string | null; tabIds: number[] }>,
  untouchedTabIds: number[],
  lowValueTabIds: number[] = [],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    groups,
    untouchedTabIds,
    lowValueTabIds,
  });
}

describe("behavior quality scoring", () => {
  it("awards a perfect score for exact coherent grouping and preferred naming", () => {
    const score = scoreBehaviorResponse(response([
      { temporaryId: "group-1", title: "Kyoto Trip", color: null, tabIds: [1, 2, 3] },
    ], [4]), [1, 2, 3, 4], spec);

    expect(score).toMatchObject({
      totalScore: 100,
      contractValid: true,
      pairPrecision: 1,
      pairRecall: 1,
      namingScore: 100,
      overmergedGroups: 0,
    });
  });

  it("does not reward grouping nothing when pairs were expected", () => {
    const score = scoreBehaviorResponse(response([], [1, 2, 3, 4]), [1, 2, 3, 4], spec);

    expect(score.pairPrecision).toBe(0);
    expect(score.pairRecall).toBe(0);
    expect(score.groupingScore).toBe(0);
  });

  it("penalizes over-merging and a forbidden site-bucket name", () => {
    const score = scoreBehaviorResponse(response([
      { temporaryId: "group-1", title: "Google", color: null, tabIds: [1, 2, 3, 4] },
    ], []), [1, 2, 3, 4], spec);

    expect(score.pairPrecision).toBe(0.5);
    expect(score.namingScore).toBe(0);
    expect(score.overmergedGroups).toBe(1);
    expect(score.totalScore).toBeLessThan(50);
    expect(score.reasons).toContain("unrelated tabs were grouped");
  });

  it("keeps semantic scores but fails the strict contract for fenced JSON", () => {
    const output = `\`\`\`json\n${response([
      { temporaryId: "group-1", title: "Kyoto Trip", color: null, tabIds: [1, 2, 3] },
    ], [4])}\n\`\`\``;
    const score = scoreBehaviorResponse(output, [1, 2, 3, 4], spec);

    expect(score.contractValid).toBe(false);
    expect(score.groupingScore).toBe(100);
    expect(score.namingScore).toBe(100);
    expect(score.totalScore).toBe(49);
  });

  it("scores semantic AI colors and penalizes an allowed-but-wrong color", () => {
    const aiSpec: BehaviorCaseSpec = {
      groups: [{
        tabIds: [1, 2],
        title: { preferred: ["Atlas Engineering"], requiredAll: ["Atlas"] },
        color: { preferred: ["purple"], allowed: ["purple", "blue"] },
      }],
      untouchedTabIds: [3],
      lowValueTabIds: [],
      colorMode: "ai",
    };
    const correct = scoreBehaviorResponse(response([
      { temporaryId: "group-1", title: "Atlas Engineering", color: "purple", tabIds: [1, 2] },
    ], [3]), [1, 2, 3], aiSpec);
    const merelyAllowed = scoreBehaviorResponse(response([
      { temporaryId: "group-1", title: "Atlas Engineering", color: "blue", tabIds: [1, 2] },
    ], [3]), [1, 2, 3], aiSpec);

    expect(correct.colorScore).toBe(100);
    expect(correct.totalScore).toBe(100);
    expect(merelyAllowed.colorScore).toBe(75);
    expect(merelyAllowed.totalScore).toBeLessThan(100);
    expect(merelyAllowed.reasons).toContain("colors were invalid or semantically mismatched");
  });

  it("scores clutter annotations independently from organization", () => {
    const clutterSpec: BehaviorCaseSpec = {
      groups: [],
      untouchedTabIds: [1, 2, 3],
      lowValueTabIds: [3],
      colorMode: "deterministic",
    };
    const score = scoreBehaviorResponse(response([], [1, 2, 3], [3]), [1, 2, 3], clutterSpec);
    expect(score.clutterScore).toBe(100);
    expect(score.totalScore).toBe(100);
  });
});
