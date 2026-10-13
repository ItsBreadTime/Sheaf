import { describe, expect, it } from "vitest";
import { historyCoverageFacts } from "../src/organizer/history-coverage";
import type { OrganizationHistoryReport } from "../src/shared/transaction-types";

function report(overrides: Partial<OrganizationHistoryReport> = {}): OrganizationHistoryReport {
  return {
    timestamp: 1,
    providerType: "openai_compatible",
    providerOrigin: "https://api.example.com",
    model: "model",
    tabsSubmitted: 88,
    tabsChanged: 16,
    groupsCreated: 3,
    resultStatus: "completed",
    rollbackStatus: "not_needed",
    undoStatus: "available",
    ...overrides,
  };
}

describe("organization history coverage facts", () => {
  it("bounds completed coverage to eligible submitted tabs", () => {
    expect(historyCoverageFacts(report({
      eligibleUngroupedSubmitted: 67,
      newlyGrouped: 16,
      remainingUngrouped: 51,
    }))).toEqual([
      "16 of 67 eligible ungrouped tabs assigned",
      "51 eligible submitted tabs remained ungrouped",
    ]);
  });

  it.each(["rolled_back", "rollback_partial", "failed"] as const)(
    "does not present planned coverage as accomplished for %s runs",
    (resultStatus) => {
      expect(historyCoverageFacts(report({
        resultStatus,
        eligibleUngroupedSubmitted: 67,
        newlyGrouped: 16,
        remainingUngrouped: 51,
      }))).toEqual([]);
    },
  );

  it("keeps legacy history records without coverage fields compatible", () => {
    expect(historyCoverageFacts(report())).toEqual([]);
  });
});
