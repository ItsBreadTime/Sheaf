import type { ProviderUsage } from "../shared/organizer-types";
import type { UsageKind, UsageSample, UsageTask } from "../shared/usage-types";

/**
 * Counts every request the extension sends to a model provider, by kind, for
 * the Usage settings. The request clients report here; whoever installs a sink
 * (the service worker and the extension pages) persists the samples. With no
 * sink, as in tests and the benchmark CLI, reporting does nothing.
 */

type UsageSink = (sample: UsageSample) => void;
let sink: UsageSink | null = null;

export function setUsageSink(next: UsageSink | null): void {
  sink = next;
}

function finiteTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/** Token counts from an OpenAI-style response (or stream chunk) with a `usage` object. */
function extractUsage(value: unknown): ProviderUsage {
  const usage = value && typeof value === "object"
    ? (value as { usage?: unknown }).usage
    : null;
  const record = usage && typeof usage === "object"
    ? usage as Record<string, unknown>
    : {};
  const details = record.prompt_tokens_details && typeof record.prompt_tokens_details === "object"
    ? record.prompt_tokens_details as Record<string, unknown>
    : {};
  const completionDetails = record.completion_tokens_details && typeof record.completion_tokens_details === "object"
    ? record.completion_tokens_details as Record<string, unknown>
    : {};
  return {
    promptTokens: finiteTokenCount(record.prompt_tokens),
    completionTokens: finiteTokenCount(record.completion_tokens),
    totalTokens: finiteTokenCount(record.total_tokens),
    cachedTokens: finiteTokenCount(details.cached_tokens ?? record.cached_tokens),
    reasoningTokens: finiteTokenCount(completionDetails.reasoning_tokens ?? record.reasoning_tokens),
  };
}

/** USD the provider charged, when it says (OpenRouter puts it in `usage.cost`). */
function extractReportedCost(value: unknown): number | null {
  const usage = value && typeof value === "object" ? (value as { usage?: unknown }).usage : null;
  const cost = usage && typeof usage === "object" ? (usage as { cost?: unknown }).cost : null;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

export interface UsageMeter {
  /** Reads usage from a response body or stream chunk; the last one with usage wins. */
  observe(value: unknown): ProviderUsage;
  /**
   * Reports the request once; later calls are ignored. `cancelled` marks a
   * request the caller abandoned (not a timeout), which is not a failure.
   */
  finish(ok: boolean, cancelled?: boolean): void;
}

/** Started just before a request goes on the wire, so rejected-before-sending requests don't count. */
export interface UsageMeterOptions {
  /** The feature this request serves; omitted for connection tests. */
  task?: UsageTask | null;
  /** The first request of an organize run. */
  startsRun?: boolean;
}

export function startUsageMeter(kind: UsageKind, options: UsageMeterOptions = {}): UsageMeter {
  let usage: ProviderUsage | null = null;
  let costUsd: number | null = null;
  let finished = false;
  return {
    observe(value) {
      const next = extractUsage(value);
      const reported = Object.values(next).some((count) => count !== null && count !== undefined);
      if (reported) usage = next;
      costUsd = extractReportedCost(value) ?? costUsd;
      return next;
    },
    finish(ok, cancelled = false) {
      if (finished) return;
      finished = true;
      if (!sink) return;
      try {
        sink({
          kind,
          ok,
          ...(cancelled && !ok ? { cancelled: true } : {}),
          at: Date.now(),
          usage,
          costUsd,
          task: options.task ?? null,
          startsRun: options.startsRun ?? false,
        });
      } catch {
        // Usage stats never get in the way of a request.
      }
    },
  };
}
