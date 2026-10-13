import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEditorLease,
  createEditorLeaseRuntime,
  isEditorLeaseValid,
  renewEditorLease,
} from "../src/background/editor-lease";
import type { EditorLease } from "../src/shared/proposal-review-types";

describe("editor ownership lease", () => {
  it("uses the pinned two-second heartbeat and eight-second lease window", () => {
    const lease = createEditorLease(10, "owner-a", 1_000);
    expect(lease).toEqual({
      editorWindowId: 10,
      ownerContextId: "owner-a",
      lastHeartbeatAt: 1_000,
      leaseExpiresAt: 9_000,
    });
    expect(isEditorLeaseValid(lease, 10, "owner-a", 8_999)).toBe(true);
    expect(isEditorLeaseValid(lease, 10, "owner-a", 9_000)).toBe(false);
  });

  it("rejects a different owner or window and renews only a valid lease", () => {
    const lease = createEditorLease(10, "owner-a", 1_000);
    expect(isEditorLeaseValid(lease, 11, "owner-a", 2_000)).toBe(false);
    expect(isEditorLeaseValid(lease, 10, "owner-b", 2_000)).toBe(false);
    expect(() => renewEditorLease(lease, 10, "owner-b", 2_000)).toThrow(
      "lost its connection",
    );
    expect(renewEditorLease(lease, 10, "owner-a", 3_000)).toMatchObject({
      lastHeartbeatAt: 3_000,
      leaseExpiresAt: 11_000,
    });
  });
});

describe("editor lease runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(editorWindowId: number | null = 10) {
    const state = { editorWindowId, lease: null as EditorLease | null };
    const cancelled: string[] = [];
    const runtime = createEditorLeaseRuntime({
      readState: async () => ({ ...state }),
      writeLease: async (lease) => { state.lease = lease; },
      cancelRequestingJob: async (owner) => { cancelled.push(owner); },
    });
    return { state, cancelled, runtime };
  }

  it("expires a registered lease and cancels its job when heartbeats stop", async () => {
    const { state, cancelled, runtime } = harness();
    await runtime.register(10, "owner-a");
    expect(state.lease).toMatchObject({ ownerContextId: "owner-a", leaseExpiresAt: 9_000 });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(state.lease).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.lease).toBeNull();
    expect(cancelled).toEqual(["owner-a"]);
  });

  it("keeps a lease alive across heartbeats and re-arms the expiry each time", async () => {
    const { state, cancelled, runtime } = harness();
    await runtime.register(10, "owner-a");
    for (let beat = 0; beat < 5; beat += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      await runtime.heartbeat(10, "owner-a");
    }
    // 10 s have passed, past the first lease's 8 s window, and it is still held.
    expect(state.lease).toMatchObject({ lastHeartbeatAt: 11_000, leaseExpiresAt: 19_000 });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(state.lease).toBeNull();
    expect(cancelled).toEqual(["owner-a"]);
  });

  it("refuses to register for a window the worker is not attached to", async () => {
    const { state, runtime } = harness(null);
    await expect(runtime.register(10, "owner-a")).rejects.toThrow("no longer attached");
    expect(state.lease).toBeNull();
  });

  it("cancels the previous owner's job when another popup takes the window", async () => {
    const { state, cancelled, runtime } = harness();
    await runtime.register(10, "owner-a");
    await runtime.register(10, "owner-b");
    expect(cancelled).toEqual(["owner-a"]);
    expect(state.lease?.ownerContextId).toBe("owner-b");
    // The old owner's heartbeat is rejected and must not disturb the new lease.
    await expect(runtime.heartbeat(10, "owner-a")).rejects.toThrow("lost its connection");
    expect(state.lease?.ownerContextId).toBe("owner-b");
  });

  it("expires a lapsed lease on the next heartbeat when the timer was lost", async () => {
    const { state, cancelled, runtime } = harness();
    // A lease left behind by a worker that restarted (no timer in this one).
    state.lease = createEditorLease(10, "owner-a", 1_000);
    vi.setSystemTime(9_500);
    await expect(runtime.heartbeat(10, "owner-a")).rejects.toThrow("lost its connection");
    expect(state.lease).toBeNull();
    expect(cancelled).toEqual(["owner-a"]);
  });

  it("does not let an old owner's timer expire a newer owner's lease", async () => {
    const { state, cancelled, runtime } = harness();
    await runtime.register(10, "owner-a");
    await vi.advanceTimersByTimeAsync(4_000);
    await runtime.register(10, "owner-b");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(state.lease?.ownerContextId).toBe("owner-b");
    expect(cancelled).toEqual(["owner-a"]);
  });

  it("release drops the lease without cancelling and disarms the expiry", async () => {
    const { state, cancelled, runtime } = harness();
    await runtime.register(10, "owner-a");
    await runtime.release();
    expect(state.lease).toBeNull();
    // A later lease written by someone else must not be expired by the old timer.
    state.lease = createEditorLease(10, "owner-a", 1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.lease).not.toBeNull();
    expect(cancelled).toEqual([]);
  });
});
