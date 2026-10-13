import type { ProviderUsage } from "./organizer-types";

/** `llm` is the organizer model (organize, repair, rerank, its connection test). */
export type UsageKind = "llm" | "decision" | "embedding";

export const USAGE_KINDS: readonly UsageKind[] = ["llm", "decision", "embedding"];

/**
 * The feature a request served, across kinds: organize runs and their repairs,
 * semantic search (index builds, query embeddings, reranking), and auto-filing
 * questions. Connection tests serve none.
 */
export type UsageTask = "organize" | "search" | "autoFile";

export const USAGE_TASKS: readonly UsageTask[] = ["organize", "search", "autoFile"];

export interface UsageSample {
  kind: UsageKind;
  ok: boolean;
  /** Abandoned by the extension before an answer (superseded or closed), not a provider failure. */
  cancelled?: boolean;
  at: number;
  usage: ProviderUsage | null;
  /** USD the provider reported for this request, when it reports one. */
  costUsd: number | null;
  task?: UsageTask | null;
  /** The first request of an organize run; a successful one counts the run. */
  startsRun?: boolean;
}

export interface UsageCounters {
  requests: number;
  failures: number;
  /** Requests the extension abandoned itself; neither failures nor answered. */
  cancellations: number;
  /** Requests whose response carried token counts. */
  reportedRequests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** Sum of provider-reported costs. */
  reportedCostUsd: number;
  /** Tokens from requests with no reported cost; priced with the user's rates when shown. */
  unpricedPromptTokens: number;
  unpricedCompletionTokens: number;
}

export interface UsagePricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface UsageStatsState {
  schemaVersion: 1;
  /** When counting started, or was last reset. */
  since: number;
  totals: Record<UsageKind, UsageCounters>;
  /** Local-date (YYYY-MM-DD) buckets, newest kept. */
  days: Record<string, Partial<Record<UsageKind, UsageCounters>>>;
  lastAt: Partial<Record<UsageKind, number>>;
  pricing: Record<UsageKind, UsagePricing>;
  /** The same counts split by task; only requests recorded since tasks were tracked. */
  tasks: Record<UsageTask, UsageTaskCounters>;
  taskDays: Record<string, Partial<Record<UsageTask, UsageTaskCounters>>>;
  /** Successful organize runs; a run's repair request doesn't count again. */
  organizeRuns: number;
  /** When task tracking started, for yearly projections over a short history. */
  tasksSince: number;
}

export type UsageTaskCounters = Partial<Record<UsageKind, UsageCounters>>;
