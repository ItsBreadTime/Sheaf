import type { ProviderUsage } from "./organizer-types";

export type DiagnosticEventKind =
  | "provider_validated"
  | "provider_repaired"
  | "provider_invalid"
  | "provider_failed"
  | "proposal_stale"
  | "rollback_complete"
  | "rollback_partial"
  | "undo_completed"
  | "undo_partial"
  | "auto_filing"
  | "auto_filing_failed"
  | "storage_lock_released";

export type DiagnosticSource =
  | "manual"
  | "suggest"
  | "automatic"
  | "regression"
  | "comparison"
  | "editor"
  | "transaction"
  | "undo"
  | "auto_filing";

export interface DiagnosticPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface DiagnosticEvent {
  schemaVersion: 1;
  id: string;
  timestamp: number;
  kind: DiagnosticEventKind;
  source: DiagnosticSource;
  detail: string | null;
  providerOrigin: string | null;
  model: string | null;
  durationMs: number | null;
  usage: ProviderUsage | null;
  estimatedCostUsd: number | null;
  transactionId: string | null;
  conflictCount: number | null;
}

export interface DiagnosticsState {
  pricing: DiagnosticPricing;
  events: DiagnosticEvent[];
}
