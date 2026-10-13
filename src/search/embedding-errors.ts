import { ProviderHttpError } from "../provider/openai-chat-completions";
import { EmbeddingRequestError } from "./embedding-client";

/**
 * One error vocabulary for the whole embedding path.
 *
 * The interactive query path and the background index path previously classified
 * failures differently — the index had `safeErrorCode`, the popup had its own
 * cooldown with no classes at all — so the same 429 could be a scheduled retry in
 * the background and a 20-second blanket lockout in the popup. Both now come here.
 */
export type EmbeddingErrorCode =
  | "cancelled"
  | "timeout"
  | "network"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_rejected"
  | "authentication"
  | "insufficient_balance"
  | "redirected"
  | "invalid_response";

/** A provider that answered with a redirect rather than an embedding. */
export class EmbeddingRedirectError extends Error {
  constructor(readonly status: number, readonly location: string | null) {
    super(`Embedding endpoint redirected with HTTP ${status}.`);
    this.name = "EmbeddingRedirectError";
  }
}

export function safeEmbeddingErrorCode(error: unknown): EmbeddingErrorCode {
  if (error instanceof EmbeddingRequestError) return error.code;
  if (error instanceof EmbeddingRedirectError) return "redirected";
  if (error instanceof ProviderHttpError) return safeEmbeddingErrorCode({ status: error.status });
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status: unknown }).status);
    if (status === 401 || status === 403) return "authentication";
    if (status === 402) return "insufficient_balance";
    if (status === 429) return "rate_limited";
    if (status >= 300 && status < 400) return "redirected";
    if (status >= 500) return "provider_unavailable";
    if (Number.isFinite(status)) return "provider_rejected";
  }
  if (error instanceof TypeError) return "network";
  return "invalid_response";
}

export function isRetryableEmbeddingErrorCode(code: EmbeddingErrorCode): boolean {
  return code === "timeout" || code === "network" || code === "rate_limited" || code === "provider_unavailable";
}

/**
 * Codes that no amount of retrying can fix: the request must change — credentials,
 * balance, dimensions, endpoint — before the same request could succeed.
 *
 * `configuration_changed` is an index-level verdict rather than a provider one, but
 * it belongs here for the same reason: retrying the query cannot help, and the user
 * has to rebuild. Takes a plain string so callers holding the wider index vocabulary
 * can ask without casting.
 */
export function isPermanentEmbeddingErrorCode(code: string): boolean {
  return code === "authentication" || code === "insufficient_balance" ||
    code === "redirected" || code === "configuration_changed";
}

/** `Retry-After` in milliseconds, from either the seconds or the HTTP-date form. */
export function retryAfterMs(error: unknown, now = Date.now()): number | null {
  if (!error || typeof error !== "object") return null;
  const headers = (error as { retryAfter?: unknown }).retryAfter;
  const raw = typeof headers === "string"
    ? headers
    : headers && typeof headers === "object" && "retry-after" in headers
      ? String((headers as Record<string, unknown>)["retry-after"])
      : null;
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 120_000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - now), 120_000);
}

export interface EmbeddingRetryOptions {
  /** Total attempts, including the first. The interactive budget is deliberately small. */
  attempts: number;
  /** Ceiling on added waiting, so the popup stays responsive. */
  maxAddedWaitMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called before a wait, for diagnostics. */
  onRetry?: (event: { attempt: number; code: EmbeddingErrorCode; delayMs: number }) => void;
}

/**
 * Retries only classes that a later attempt can plausibly fix, with jittered
 * exponential backoff and `Retry-After` honoured when the provider sent one.
 * The added wait is capped: an interactive search may not stall the popup, which
 * is why the background path keeps its own slower schedule.
 */
export async function withEmbeddingRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: EmbeddingRetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const deadline = now() + options.maxAddedWaitMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const code = safeEmbeddingErrorCode(error);
      if (attempt >= options.attempts || !isRetryableEmbeddingErrorCode(code)) throw error;
      const suggested = retryAfterMs(error, now());
      const backoff = suggested ?? Math.min(1_000 * 2 ** (attempt - 1), 4_000);
      // Jitter below the requested delay keeps a fleet of clients from synchronising,
      // and never waits longer than the provider asked for.
      const delayMs = Math.round(backoff * (suggested === null ? 0.5 + random() * 0.5 : 1));
      if (now() + delayMs > deadline) throw error;
      options.onRetry?.({ attempt, code, delayMs });
      await sleep(delayMs);
    }
  }
}
