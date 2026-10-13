import type {
  DiagnosticEvent,
  DiagnosticEventKind,
  DiagnosticPricing,
  DiagnosticsState,
  DiagnosticSource,
} from "../shared/diagnostics-types";
import type { ProviderUsage } from "../shared/organizer-types";
import { isRecord } from "../shared/guards";
import { withCrossContextMutationLock } from "./mutation-lock";

const LOCAL_KEY = "diagnosticsState";
export const MAX_DIAGNOSTIC_EVENTS = 100;

export const DEFAULT_DIAGNOSTIC_PRICING: DiagnosticPricing = {
  inputPerMillionUsd: 0,
  outputPerMillionUsd: 0,
};

const EVENT_KINDS = new Set<DiagnosticEventKind>([
  "provider_validated",
  "provider_repaired",
  "provider_invalid",
  "provider_failed",
  "proposal_stale",
  "rollback_complete",
  "rollback_partial",
  "undo_completed",
  "undo_partial",
  "auto_filing",
  "auto_filing_failed",
]);

const EVENT_SOURCES = new Set<DiagnosticSource>([
  "manual",
  "suggest",
  "automatic",
  "regression",
  "comparison",
  "editor",
  "transaction",
  "undo",
  "auto_filing",
]);

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function parsePricing(value: unknown): DiagnosticPricing {
  if (!isRecord(value)) return DEFAULT_DIAGNOSTIC_PRICING;
  return {
    inputPerMillionUsd:
      finiteNonnegative(value.inputPerMillionUsd) ??
      DEFAULT_DIAGNOSTIC_PRICING.inputPerMillionUsd,
    outputPerMillionUsd:
      finiteNonnegative(value.outputPerMillionUsd) ??
      DEFAULT_DIAGNOSTIC_PRICING.outputPerMillionUsd,
  };
}

function parseUsage(value: unknown): ProviderUsage | null {
  if (!isRecord(value)) return null;
  const token = (item: unknown): number | null => {
    const parsed = finiteNonnegative(item);
    return parsed === null ? null : Math.round(parsed);
  };
  return {
    promptTokens: token(value.promptTokens),
    completionTokens: token(value.completionTokens),
    totalTokens: token(value.totalTokens),
    cachedTokens: token(value.cachedTokens),
  };
}

function parseEvent(value: unknown): DiagnosticEvent | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    !EVENT_KINDS.has(value.kind as DiagnosticEventKind) ||
    !EVENT_SOURCES.has(value.source as DiagnosticSource)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    id: value.id,
    timestamp: value.timestamp,
    kind: value.kind as DiagnosticEventKind,
    source: value.source as DiagnosticSource,
    detail: typeof value.detail === "string" ? value.detail.slice(0, 1_000) : null,
    providerOrigin:
      typeof value.providerOrigin === "string" ? value.providerOrigin.slice(0, 500) : null,
    model: typeof value.model === "string" ? value.model.slice(0, 200) : null,
    durationMs: finiteNonnegative(value.durationMs),
    usage: parseUsage(value.usage),
    estimatedCostUsd: finiteNonnegative(value.estimatedCostUsd),
    transactionId: typeof value.transactionId === "string" ? value.transactionId : null,
    conflictCount:
      finiteNonnegative(value.conflictCount) === null
        ? null
        : Math.round(finiteNonnegative(value.conflictCount)!),
  };
}

export async function readDiagnosticsState(): Promise<DiagnosticsState> {
  const values = await chrome.storage.local.get(LOCAL_KEY);
  const stored = values[LOCAL_KEY];
  if (!isRecord(stored)) {
    return { pricing: DEFAULT_DIAGNOSTIC_PRICING, events: [] };
  }
  return {
    pricing: parsePricing(stored.pricing),
    events: Array.isArray(stored.events)
      ? stored.events.map(parseEvent).filter((event): event is DiagnosticEvent => event !== null)
      : [],
  };
}

// The worker and the popup both append events, and the popup also rewrites
// pricing and clears the log, so every write re-reads under one lock shared
// across contexts.
function withDiagnosticsLock<T>(task: () => Promise<T>): Promise<T> {
  return withCrossContextMutationLock(LOCAL_KEY, task);
}

export async function writeDiagnosticPricing(
  pricing: DiagnosticPricing,
): Promise<DiagnosticsState> {
  return withDiagnosticsLock(async () => {
    const current = await readDiagnosticsState();
    const normalized = parsePricing(pricing);
    const next = { ...current, pricing: normalized };
    await chrome.storage.local.set({ [LOCAL_KEY]: next });
    return next;
  });
}

export async function appendDiagnosticEvent(event: DiagnosticEvent): Promise<void> {
  const parsed = parseEvent(event);
  if (!parsed) throw new Error("Diagnostic event is invalid.");
  await withDiagnosticsLock(async () => {
    const current = await readDiagnosticsState();
    const events = [...current.events, parsed].slice(-MAX_DIAGNOSTIC_EVENTS);
    await chrome.storage.local.set({
      [LOCAL_KEY]: { pricing: current.pricing, events },
    });
  });
}

export async function clearDiagnosticEvents(): Promise<void> {
  await withDiagnosticsLock(async () => {
    const current = await readDiagnosticsState();
    await chrome.storage.local.set({
      [LOCAL_KEY]: { pricing: current.pricing, events: [] },
    });
  });
}
