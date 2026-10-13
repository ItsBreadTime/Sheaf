import type { OrganizationHistoryReport } from "../shared/transaction-types";

export function historyCoverageFacts(report: OrganizationHistoryReport): string[] {
  if (
    report.resultStatus !== "completed" ||
    report.eligibleUngroupedSubmitted === undefined ||
    report.newlyGrouped === undefined ||
    report.remainingUngrouped === undefined
  ) return [];
  return [
    `${report.newlyGrouped} of ${report.eligibleUngroupedSubmitted} eligible ungrouped tabs assigned`,
    `${report.remainingUngrouped} eligible submitted tab${report.remainingUngrouped === 1 ? "" : "s"} remained ungrouped`,
  ];
}
