import type { EmbeddingErrorCode } from "./embedding-errors";
import { isPermanentEmbeddingErrorCode } from "./embedding-errors";

/**
 * Provider failures, plus the index-level verdict that a rebuild is required. Both
 * reach this gate; only the provider ones can be retried.
 */
export type SemanticSearchFailureCode = EmbeddingErrorCode | "configuration_changed";

export interface SemanticSearchFailureGateDependencies {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
}

/**
 * Scoped, self-healing failure state for interactive semantic search.
 *
 * The previous behaviour was one 20-second lockout with no error class and no query
 * scoping: any hiccup disabled every later search, including ones that would have
 * succeeded, and the user was told only "unavailable". This gate separates:
 *
 * - failures no retry can fix (authentication, balance, a redirect that needs a
 *   corrected endpoint) — blocking until settings change, with the specific remedy
 *   surfaced by the caller;
 * - transient failures — a cooldown that doubles while the same query keeps
 *   failing, capped, and applied only to that query. Another query is unaffected,
 *   because a previous query's rate limit says nothing about a different one;
 * - expiry, which re-enables the control and lets the next attempt be the probe.
 */
export class SemanticSearchFailureGate {
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private key: string | null = null;
  private code: SemanticSearchFailureCode | null = null;
  private permanent = false;
  private retryAt = 0;
  private repeats = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(
    private readonly onExpire: () => void,
    dependencies: SemanticSearchFailureGateDependencies = {},
  ) {
    const now = dependencies.now ?? Date.now;
    const setTimer = dependencies.setTimer ?? globalThis.setTimeout;
    const clearTimer = dependencies.clearTimer ?? globalThis.clearTimeout;
    // Browser timer functions are Web API methods and may reject a class instance
    // as their receiver. Keep every injected or native dependency as a bare call.
    this.now = () => now();
    this.setTimer = (callback, delayMs) => setTimer(callback, delayMs) as ReturnType<typeof setTimeout>;
    this.clearTimer = (timer) => clearTimer(timer);
    this.baseCooldownMs = dependencies.baseCooldownMs ?? 5_000;
    this.maxCooldownMs = dependencies.maxCooldownMs ?? 60_000;
  }

  blocks(key: string): boolean {
    if (this.permanent) return true;
    return this.key === key && this.now() < this.retryAt;
  }

  note(key: string, code: SemanticSearchFailureCode): void {
    this.generation += 1;
    const generation = this.generation;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const previousKey = this.key;
    this.code = code;
    this.key = key;
    this.permanent = isPermanentEmbeddingErrorCode(code);
    this.repeats = previousKey === key && this.repeats > 0 ? this.repeats + 1 : 1;
    const delayMs = this.permanent
      ? this.maxCooldownMs
      : Math.min(this.baseCooldownMs * 2 ** (this.repeats - 1), this.maxCooldownMs);
    this.retryAt = this.now() + delayMs;
    if (this.permanent) return;
    this.timer = this.setTimer(() => {
      if (this.generation !== generation) return;
      this.timer = null;
      this.retryAt = 0;
      this.onExpire();
    }, delayMs);
  }

  clear(): void {
    this.generation += 1;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.key = null;
    this.code = null;
    this.permanent = false;
    this.retryAt = 0;
    this.repeats = 0;
  }

  errorCode(): SemanticSearchFailureCode | null {
    return this.code;
  }

  /** Whole seconds until this query may run again, or null when not cooling down. */
  retryInSeconds(key: string): number | null {
    if (this.permanent || this.key !== key) return null;
    const remaining = this.retryAt - this.now();
    return remaining > 0 ? Math.ceil(remaining / 1_000) : null;
  }

  /** True while a failure needs the user to change something, not to wait. */
  requiresSettingsChange(): boolean {
    return this.permanent;
  }
}
