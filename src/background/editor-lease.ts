import { PROPOSAL_REVIEW } from "../shared/constants";
import type { EditorLease } from "../shared/proposal-review-types";

export function createEditorLease(
  editorWindowId: number,
  ownerContextId: string,
  now = Date.now(),
): EditorLease {
  if (!Number.isSafeInteger(editorWindowId)) {
    throw new Error("Editor window ID must be a safe integer.");
  }
  if (!ownerContextId.trim()) throw new Error("Editor owner context ID is required.");
  return {
    editorWindowId,
    ownerContextId,
    lastHeartbeatAt: now,
    leaseExpiresAt: now + PROPOSAL_REVIEW.EDITOR_LEASE_MS,
  };
}

export function isEditorLeaseValid(
  lease: EditorLease,
  editorWindowId: number,
  ownerContextId: string,
  now = Date.now(),
): boolean {
  return (
    lease.editorWindowId === editorWindowId &&
    lease.ownerContextId === ownerContextId &&
    lease.leaseExpiresAt > now
  );
}

export function renewEditorLease(
  lease: EditorLease,
  editorWindowId: number,
  ownerContextId: string,
  now = Date.now(),
): EditorLease {
  if (!isEditorLeaseValid(lease, editorWindowId, ownerContextId, now)) {
    throw new Error("This popup lost its connection to the window, or another Sheaf popup is controlling it. Reopen the popup and try again.");
  }
  return {
    ...lease,
    lastHeartbeatAt: now,
    leaseExpiresAt: now + PROPOSAL_REVIEW.EDITOR_LEASE_MS,
  };
}

export interface EditorLeaseHost {
  /** The editor window this worker is attached to, and the stored lease. */
  readState(): Promise<{ editorWindowId: number | null; lease: EditorLease | null }>;
  writeLease(lease: EditorLease | null): Promise<void>;
  /** Cancels a still-requesting provider job owned by `ownerContextId`. */
  cancelRequestingJob(ownerContextId: string): Promise<void>;
}

/**
 * The worker's side of the lease: register on popup initialize, renew on each
 * heartbeat, and expire on a timer when the heartbeats stop. The timer is
 * in-memory, so a worker restart drops it; the next heartbeat or register then
 * sees the lapsed lease and expires it there instead.
 */
export function createEditorLeaseRuntime(host: EditorLeaseHost) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  async function expire(ownerContextId: string): Promise<void> {
    const { lease } = await host.readState();
    if (!lease || lease.ownerContextId !== ownerContextId || lease.leaseExpiresAt > Date.now()) return;
    await host.cancelRequestingJob(ownerContextId);
    await host.writeLease(null);
  }

  function scheduleExpiry(ownerContextId: string, leaseExpiresAt: number): void {
    clearTimer();
    timer = setTimeout(() => {
      void expire(ownerContextId).catch(() => undefined);
    }, Math.max(0, leaseExpiresAt - Date.now()));
  }

  return {
    async register(editorWindowId: number, ownerContextId: string): Promise<void> {
      const { editorWindowId: attached, lease: current } = await host.readState();
      if (attached !== editorWindowId) {
        throw new Error("This popup is no longer attached to that window. Reopen the popup and try again.");
      }
      if (current && current.ownerContextId !== ownerContextId) {
        await host.cancelRequestingJob(current.ownerContextId);
      }
      const lease = createEditorLease(editorWindowId, ownerContextId);
      await host.writeLease(lease);
      scheduleExpiry(ownerContextId, lease.leaseExpiresAt);
    },

    async heartbeat(editorWindowId: number, ownerContextId: string): Promise<void> {
      const { lease } = await host.readState();
      if (!lease || !isEditorLeaseValid(lease, editorWindowId, ownerContextId)) {
        if (lease && lease.leaseExpiresAt <= Date.now()) await expire(lease.ownerContextId);
        throw new Error("This popup lost its connection to the window, or another Sheaf popup is controlling it. Reopen the popup and try again.");
      }
      const renewed = renewEditorLease(lease, editorWindowId, ownerContextId);
      await host.writeLease(renewed);
      scheduleExpiry(ownerContextId, renewed.leaseExpiresAt);
    },

    /** Drops the lease without cancelling anything (Apply has taken ownership). */
    async release(): Promise<void> {
      await host.writeLease(null);
      clearTimer();
    },
  };
}
