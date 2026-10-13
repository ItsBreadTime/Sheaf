import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendCountsOnlyHistory,
  readCountsOnlyHistory,
  updateLatestHistoryUndoStatus,
} from "../src/storage/organization-history";
import type { OrganizationHistoryReport } from "../src/shared/transaction-types";

function report(timestamp: number, undoStatus: OrganizationHistoryReport["undoStatus"]): OrganizationHistoryReport {
  return {
    timestamp,
    providerType: "openai_compatible",
    providerOrigin: "https://api.example.com",
    model: "model-a",
    tabsSubmitted: 10,
    tabsChanged: 8,
    tabsMoved: 6,
    groupsCreated: 2,
    groupsRenamed: 1,
    groupsMerged: 0,
    groupsSplit: 1,
    groupCount: 3,
    durationMs: 1_500,
    scopeMode: "window",
    resultStatus: "completed",
    rollbackStatus: "not_needed",
    undoStatus,
    undoConflictCount: 0,
  };
}

beforeEach(() => {
  const local: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(key: string) {
          return key in local ? { [key]: structuredClone(local[key]) } : {};
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, structuredClone(values));
        },
      },
    },
  });
});

describe("multi-level counts-only history", () => {
  it("keeps multiple reports and expires the previous full undo", async () => {
    await appendCountsOnlyHistory(report(1, "available"));
    await appendCountsOnlyHistory(report(2, "available"));

    expect(await readCountsOnlyHistory()).toMatchObject([
      { timestamp: 1, undoStatus: "unavailable" },
      { timestamp: 2, undoStatus: "available" },
    ]);
  });

  it("records partial-restore conflicts on the latest run", async () => {
    await appendCountsOnlyHistory(report(1, "available"));
    await updateLatestHistoryUndoStatus("partial", 3);

    expect((await readCountsOnlyHistory()).at(-1)).toMatchObject({
      undoStatus: "partial",
      undoConflictCount: 3,
    });
  });
});
