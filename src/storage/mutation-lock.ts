// Serializes read-modify-write sequences against the same chrome.storage key
// within one context. chrome.storage has no transactions, so a shared writer
// keeps two in-page mutations from clobbering each other (for example, two
// popup handlers rewriting the same settings object).
//
// This lock is per-context by construction: it cannot see a writer in another
// page; shared keys add a Web Lock on top (see withCrossContextMutationLock
// below).
//
// Re-entrancy cannot be told apart from legitimate concurrent queuing without
// async-context tracking, which extension pages do not have, so the fail-safe
// is the watchdog: a task that holds a key past the watchdog is assumed wedged
// (the historical failure was an inner call queued behind its own outer task)
// and the gate is force-released so the key recovers. Code that knows it may
// run inside a held key must instead check storageMutationLockHeld and call a
// lock-free inner function, as the workspace settle path does.
import { recordStorageLockWatchdogDiagnostic } from "../diagnostics/events";

/** A task holding a key longer than this is treated as wedged and force-released. */
export const STORAGE_MUTATION_LOCK_WATCHDOG_MS = 60_000;

const tails = new Map<string, Promise<void>>();

export async function withStorageMutationLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, next);
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    release();
    if (tails.get(key) === next) tails.delete(key);
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await previous;
    watchdog = setTimeout(() => {
      // Release first so a queued task — including the diagnostic's own write
      // when it shares this key — can proceed before the event is recorded.
      releaseOnce();
      void recordStorageLockWatchdogDiagnostic(key).catch(() => undefined);
    }, STORAGE_MUTATION_LOCK_WATCHDOG_MS);
    return await task();
  } finally {
    clearTimeout(watchdog);
    releaseOnce();
  }
}

/** Whether a task holds (or waits for) the lock on `key` in this context. */
export function storageMutationLockHeld(key: string): boolean {
  return tails.has(key);
}

/**
 * Serializes mutations of a key shared between extension contexts (worker,
 * popup, finder): a Web Lock excludes writers in other pages, and the inner
 * per-context lock orders this page's tasks, keeps storageMutationLockHeld
 * accurate, and arms the watchdog while the task runs. Where Web Locks are
 * unavailable (unit tests) the per-context lock alone is used.
 *
 * Web Locks are not re-entrant and a queued wait is unbounded (a stuck remote
 * holder only releases when its context is destroyed), so never enter the same
 * key from inside a task that holds it — use an unlocked inner function, as
 * the workspace settle path does. When two different keys nest, they must nest
 * in one consistent order everywhere (the workspace lock outside, the stash
 * list lock inside).
 */
export async function withCrossContextMutationLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks?.request) return await withStorageMutationLock(key, task);
  return await locks.request(key, () => withStorageMutationLock(key, task)) as T;
}
