import { describe, expect, it, vi } from "vitest";
import {
  normalizeGroupManagerSession,
  forgetGroupOwnership,
  readGroupManagerSession,
  recordGroupManagerPreview,
  reconcileGroupManagerSession,
  recordGroupOwnership,
  setManualGroupManagement,
} from "../src/storage/group-manager";

function installStorage(initial: Record<string, unknown> = {}): Record<string, unknown> {
  const values = { ...initial };
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (next: Record<string, unknown>) => Object.assign(values, structuredClone(next))),
      },
    },
  });
  return values;
}

describe("group manager session storage", () => {
  it("normalizes invalid records without trusting malformed IDs", () => {
    expect(normalizeGroupManagerSession({
      ownership: [
        { groupId: 10, windowId: 7, origin: "created", recordedAt: 1 },
        { groupId: "bad", windowId: 7, origin: "managed", recordedAt: 1 },
      ],
      stashLinks: "bad",
      undoPoint: null,
    }).ownership).toEqual([{ groupId: 10, windowId: 7, origin: "created", managed: true, recordedAt: 1 }]);
  });

  it("preserves created provenance when a group is manually adopted", async () => {
    installStorage();
    await recordGroupOwnership([{ groupId: 10, windowId: 7 }], "created", "tx");
    await setManualGroupManagement([{ groupId: 10, windowId: 7 }], true);
    expect((await readGroupManagerSession()).ownership[0]).toMatchObject({ origin: "created", managed: true, transactionId: "tx" });
    await setManualGroupManagement([{ groupId: 10, windowId: 7 }], false);
    expect((await readGroupManagerSession()).ownership[0]).toMatchObject({ origin: "created", managed: false });
    await setManualGroupManagement([{ groupId: 10, windowId: 7 }], true);
    expect((await readGroupManagerSession()).ownership[0]).toMatchObject({ origin: "created", managed: true });
  });

  it("can stop and resume managing a manually adopted group", async () => {
    installStorage();
    await setManualGroupManagement([{ groupId: 20, windowId: 7 }], true);
    expect((await readGroupManagerSession()).ownership[0]).toMatchObject({ origin: "managed", managed: true });
    await setManualGroupManagement([{ groupId: 20, windowId: 7 }], false);
    expect((await readGroupManagerSession()).ownership[0]).toMatchObject({ origin: "managed", managed: false });
  });

  it("drops stale ownership and stash links when native groups disappear", async () => {
    installStorage({
      groupManagerSession: {
        ownership: [
          { groupId: 10, windowId: 7, origin: "created", recordedAt: 1 },
          { groupId: 20, windowId: 7, origin: "managed", recordedAt: 1 },
        ],
        stashLinks: [{ groupId: 20, windowId: 7, stashId: "s", memberTabIds: [2], title: "Old", color: "blue", collapsed: false, recordedAt: 1 }],
        undoPoint: null,
      },
    });
    const next = await reconcileGroupManagerSession([{ id: 10, windowId: 7 }]);
    expect(next.ownership.map((item) => item.groupId)).toEqual([10]);
    expect(next.stashLinks).toEqual([]);
  });

  it("serializes native removal cleanup with recreated-group ownership", async () => {
    installStorage({
      groupManagerSession: {
        ownership: [{ groupId: 10, windowId: 7, origin: "created", recordedAt: 1 }],
        stashLinks: [],
        undoPoint: null,
      },
    });
    await Promise.all([
      forgetGroupOwnership(10, 7),
      recordGroupOwnership([{ groupId: 11, windowId: 7 }], "created", "tx"),
    ]);
    expect((await readGroupManagerSession()).ownership).toEqual([
      expect.objectContaining({ groupId: 11, origin: "created", transactionId: "tx" }),
    ]);
  });

  it("keeps reviewed provenance session-only by preview token", async () => {
    installStorage();
    await recordGroupManagerPreview("preview-1", [{
      groupId: 10,
      origin: "created",
      transactionId: "tx",
    }]);
    expect((await readGroupManagerSession()).pendingPreviews).toEqual([{
      previewToken: "preview-1",
      recordedAt: expect.any(Number),
      provenance: [{ groupId: 10, origin: "created", transactionId: "tx" }],
    }]);
  });
});
