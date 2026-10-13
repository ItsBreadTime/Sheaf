import type {
  DiagnosticEvent,
  DiagnosticEventKind,
  DiagnosticSource,
} from "../shared/diagnostics-types";
import type {
  OpenAICompatibleConfig,
  ProviderJobResult,
  ProviderUsage,
} from "../shared/organizer-types";
import { appendDiagnosticEvent, readDiagnosticsState } from "../storage/diagnostics";

export function estimateUsageCost(
  usage: ProviderUsage | null | undefined,
  inputPerMillionUsd: number,
  outputPerMillionUsd: number,
): number | null {
  if (!usage || usage.promptTokens === null || usage.completionTokens === null) return null;
  return (
    usage.promptTokens * inputPerMillionUsd +
    usage.completionTokens * outputPerMillionUsd
  ) / 1_000_000;
}

function eventBase(
  kind: DiagnosticEventKind,
  source: DiagnosticSource,
  now: number,
): DiagnosticEvent {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    timestamp: now,
    kind,
    source,
    detail: null,
    providerOrigin: null,
    model: null,
    durationMs: null,
    usage: null,
    estimatedCostUsd: null,
    transactionId: null,
    conflictCount: null,
  };
}

function safeDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail
    .replace(/(authorization|api[-_ ]?key|token|secret)(["' :=]+)[^\s,"'}]+/gi, "$1$2[redacted]")
    .replace(/([?&][^=\s]+)=([^&\s]+)/g, "$1=[redacted]")
    .slice(0, 1_000);
}

export async function recordProviderDiagnostic(
  config: OpenAICompatibleConfig,
  result: ProviderJobResult,
  source: DiagnosticSource,
): Promise<void> {
  const now = result.finishedAt ?? Date.now();
  const kind: DiagnosticEventKind = result.status === "validated"
    ? result.repairAttempted ? "provider_repaired" : "provider_validated"
    : result.repairAttempted ? "provider_invalid" : "provider_failed";
  const { pricing } = await readDiagnosticsState();
  const event = eventBase(kind, source, now);
  event.detail = safeDetail(result.error);
  event.providerOrigin = config.origin;
  event.model = config.model;
  event.durationMs = result.startedAt === null || result.finishedAt === null
    ? null
    : Math.max(0, result.finishedAt - result.startedAt);
  event.usage = result.usage ?? null;
  event.estimatedCostUsd = estimateUsageCost(
    result.usage,
    pricing.inputPerMillionUsd,
    pricing.outputPerMillionUsd,
  );
  await appendDiagnosticEvent(event);
}

export async function recordProviderFailureDiagnostic(
  config: OpenAICompatibleConfig,
  source: DiagnosticSource,
  startedAt: number,
  error: unknown,
): Promise<void> {
  const event = eventBase("provider_failed", source, Date.now());
  event.providerOrigin = config.origin;
  event.model = config.model;
  event.durationMs = Math.max(0, event.timestamp - startedAt);
  const message = error instanceof Error ? error.message : "Provider request failed.";
  event.detail = error instanceof Error && error.name === "ProviderHttpError"
    ? `${message.match(/HTTP \d+/)?.[0] ?? "Provider HTTP error"}. Response body is not stored.`
    : safeDetail(message);
  await appendDiagnosticEvent(event);
}

export async function recordOperationalDiagnostic(options: {
  kind: Extract<DiagnosticEventKind,
    "proposal_stale" | "rollback_complete" | "rollback_partial" | "undo_completed" | "undo_partial">;
  source: Extract<DiagnosticSource, "manual" | "automatic" | "transaction" | "undo">;
  detail?: string | null;
  transactionId?: string | null;
  conflictCount?: number | null;
}): Promise<void> {
  const event = eventBase(options.kind, options.source, Date.now());
  event.detail = safeDetail(options.detail);
  event.transactionId = options.transactionId ?? null;
  event.conflictCount = options.conflictCount ?? null;
  await appendDiagnosticEvent(event);
}

/**
 * The storage mutation lock's watchdog force-released a wedged key. The detail
 * is the storage key name only — never data stored under it.
 */
export async function recordStorageLockWatchdogDiagnostic(storageKey: string): Promise<void> {
  const event = eventBase("storage_lock_released", "automatic", Date.now());
  event.detail = safeDetail(storageKey);
  await appendDiagnosticEvent(event);
}

/**
 * Counts, latency, tier, and confidence buckets only: never titles, URLs, or
 * group names.
 */
export async function recordAutoFilingDiagnostic(options: {
  failed: boolean;
  detail: string;
  durationMs: number | null;
  model: string | null;
}): Promise<void> {
  const event = eventBase(options.failed ? "auto_filing_failed" : "auto_filing", "auto_filing", Date.now());
  event.detail = safeDetail(options.detail);
  event.durationMs = options.durationMs === null ? null : Math.round(options.durationMs);
  event.model = options.model;
  await appendDiagnosticEvent(event);
}

export async function bestEffortDiagnostic(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // Diagnostics are deliberately nonessential and never block organization.
  }
}
