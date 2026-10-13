import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_MUTATION_LOCK_WATCHDOG_MS,
  storageMutationLockHeld,
  withStorageMutationLock,
} from "../src/storage/mutation-lock";
import { recordStorageLockWatchdogDiagnostic } from "../src/diagnostics/events";

vi.mock("../src/diagnostics/events", () => ({
  recordStorageLockWatchdogDiagnostic: vi.fn().mockResolvedValue(undefined),
}));

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe("storage mutation lock", () => {
  it("runs tasks on the same key one at a time, in the order they were queued", async () => {
    const order: string[] = [];
    const first = withStorageMutationLock("settings", async () => {
      order.push("first:start");
      await tick();
      order.push("first:end");
      return "first";
    });
    const second = withStorageMutationLock("settings", async () => {
      order.push("second:start");
      return "second";
    });
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not block a task on a different key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withStorageMutationLock("settings", async () => {
      await gate;
      return "settings";
    });
    // The lock is per key, so another key's task finishes while "settings" is held.
    await expect(withStorageMutationLock("workspaces", async () => "workspaces")).resolves.toBe("workspaces");
    release();
    await expect(held).resolves.toBe("settings");
  });

  it("releases the key when a task rejects, so a later task still runs", async () => {
    const failing = withStorageMutationLock("settings", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(withStorageMutationLock("settings", async () => "next")).resolves.toBe("next");
  });

  it("does not wedge a queued task when the task ahead of it rejects", async () => {
    const failing = withStorageMutationLock("settings", async () => {
      throw new Error("boom");
    });
    const queued = withStorageMutationLock("settings", async () => "queued");
    await expect(failing).rejects.toThrow("boom");
    await expect(queued).resolves.toBe("queued");
  });

  it("reports whether the key is held in this context", async () => {
    expect(storageMutationLockHeld("settings")).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withStorageMutationLock("settings", async () => {
      expect(storageMutationLockHeld("settings")).toBe(true);
      await gate;
    });
    expect(storageMutationLockHeld("settings")).toBe(true);
    release();
    await held;
    expect(storageMutationLockHeld("settings")).toBe(false);
  });
});

describe("storage mutation lock watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(recordStorageLockWatchdogDiagnostic).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-releases a wedged holder so a queued task runs, and records a diagnostic", async () => {
    const wedged = withStorageMutationLock("settings", () => new Promise<void>(() => undefined));
    const queued = withStorageMutationLock("settings", async () => "queued");
    await vi.advanceTimersByTimeAsync(STORAGE_MUTATION_LOCK_WATCHDOG_MS);
    await expect(queued).resolves.toBe("queued");
    expect(recordStorageLockWatchdogDiagnostic).toHaveBeenCalledWith("settings");
    expect(storageMutationLockHeld("settings")).toBe(false);
    void wedged;
  });

  it("does not fire for a task that finishes in time", async () => {
    const task = withStorageMutationLock("settings", async () => {
      await vi.advanceTimersByTimeAsync(STORAGE_MUTATION_LOCK_WATCHDOG_MS / 2);
      return "done";
    });
    await expect(task).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(STORAGE_MUTATION_LOCK_WATCHDOG_MS * 2);
    expect(recordStorageLockWatchdogDiagnostic).not.toHaveBeenCalled();
  });

  it("unwinds same-key re-entrancy instead of deadlocking forever", async () => {
    const order: string[] = [];
    const run = withStorageMutationLock("workspace", async () => {
      order.push("outer:start");
      const inner = await withStorageMutationLock("workspace", async () => {
        order.push("inner");
        return "inner-result";
      });
      order.push("outer:end");
      return inner;
    });
    await vi.advanceTimersByTimeAsync(STORAGE_MUTATION_LOCK_WATCHDOG_MS);
    await expect(run).resolves.toBe("inner-result");
    expect(order).toEqual(["outer:start", "inner", "outer:end"]);
    expect(storageMutationLockHeld("workspace")).toBe(false);
  });

  it("a holder finishing after its force-release does not clobber the next holder", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withStorageMutationLock("settings", async () => {
      await firstGate;
      return "first";
    });
    let secondStarted = false;
    const second = withStorageMutationLock("settings", async () => {
      secondStarted = true;
      return "second";
    });
    await vi.advanceTimersByTimeAsync(STORAGE_MUTATION_LOCK_WATCHDOG_MS);
    expect(secondStarted).toBe(true);
    await expect(second).resolves.toBe("second");
    releaseFirst();
    await expect(first).resolves.toBe("first");
    expect(storageMutationLockHeld("settings")).toBe(false);
    expect(recordStorageLockWatchdogDiagnostic).toHaveBeenCalledTimes(1);
  });
});
