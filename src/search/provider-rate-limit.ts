/**
 * One provider-wide "do not call before" stamp, shared by the popup and the
 * background worker.
 *
 * The index build and interactive searches use the same API key but run in
 * different JavaScript contexts, so a 429 seen by one was invisible to the other:
 * a background build could keep hammering a provider that had just asked for a
 * pause, and its own backoff could not slow a foreground search either. The stamp
 * lives in session storage, which both contexts share and neither needs a message
 * round trip for.
 *
 * The interactive channel is deliberately not held back by it. A single query
 * carries one request and the user is waiting for it; the background build is the
 * one that can afford to wait, and its batches are what make a rate limit worse.
 */
import { withCrossContextMutationLock } from "../storage/mutation-lock";

const RESERVATION_KEY = "embeddingProviderNotBefore";
const MAX_WAIT_MS = 120_000;

export interface ProviderReservationStore {
  read: () => Promise<number>;
  write: (notBefore: number) => Promise<void>;
}

/** A reservation in session storage; other providers pass their own key. */
function sessionReservationStore(key = RESERVATION_KEY): ProviderReservationStore {
  return {
    read: async () => {
      const values = await chrome.storage.session.get(key);
      const value = values[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    },
    write: async (notBefore) => {
      await chrome.storage.session.set({ [key]: notBefore });
    },
  };
}

const sessionStore = (): ProviderReservationStore => sessionReservationStore();

export interface ProviderSlotOptions {
  priority: "background" | "interactive";
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  store?: ProviderReservationStore;
  /** Longest a caller will wait for the reservation to expire. */
  maxWaitMs?: number;
}

/** Waits out a provider-wide reservation. Returns how long it waited, in ms. */
export async function waitForProviderSlot(options: ProviderSlotOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const store = options.store ?? sessionStore();
  if (options.priority === "interactive") return 0;
  const notBefore = await store.read();
  const remaining = notBefore - now();
  if (remaining <= 0) return 0;
  const waitMs = Math.min(remaining, options.maxWaitMs ?? MAX_WAIT_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await sleep(waitMs);
  return waitMs;
}

/**
 * Records how long the provider asked to be left alone, keeping the longest
 * outstanding reservation so a short one cannot overwrite a longer one.
 */
export async function noteProviderRetryAfter(
  delayMs: number,
  options: { now?: () => number; store?: ProviderReservationStore } = {},
): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const now = options.now ?? Date.now;
  const store = options.store ?? sessionStore();
  const notBefore = now() + Math.min(delayMs, MAX_WAIT_MS);
  // The popup and the worker both note 429s: without the lock, two overlapping
  // notes could both read the old stamp and the shorter one could land last.
  await withCrossContextMutationLock(RESERVATION_KEY, async () => {
    if ((await store.read()) >= notBefore) return;
    await store.write(notBefore);
  });
}
