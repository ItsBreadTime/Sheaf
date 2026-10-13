import type { TabRef } from "./tab-ref";

export type SemanticTabIndexStatus = "ready" | "pending" | "excluded" | "failed";

export type SemanticIndexTarget =
  | ({ kind: "open" } & TabRef)
  | { kind: "stash"; stashId: string; sourceIndex: number };

export interface EmbeddingRecord {
  key: string;
  modelKey: string;
  dimensions: number;
  vector: Float32Array;
  createdAt: number;
  lastReferencedAt: number;
}

export interface SemanticTabRecord {
  mappingKey: string;
  target: SemanticIndexTarget;
  documentHash: string;
  embeddingKey: string | null;
  status: SemanticTabIndexStatus;
  errorCode?: string;
  updatedAt: number;
}

export interface SemanticQueueRecord {
  key: string;
  modelKey: string;
  document: string;
  mappingKeys: string[];
  retryCount: number;
  nextEligibleRetryAt: number;
  createdAt: number;
  lastErrorCode?: string;
}

export interface SemanticIndexMeta {
  id: "current";
  modelKey: string | null;
  indexScope?: "current_window" | "all_windows";
  targetWindowId?: number | null;
  status: "idle" | "building" | "cancelled" | "complete" | "failed" | "stale";
  total: number;
  ready: number;
  pending: number;
  excluded: number;
  failed: number;
  lastCompletedBatchAt: number | null;
  lastErrorCode: string | null;
  nextRetryAt?: number | null;
  cacheHits: number;
  cacheMisses: number;
  /**
   * Fingerprint of the source tuples the last plan was built from. Reconciliation
   * compares it before planning, so a page whose title changes on every playback
   * tick cannot keep the debounced planner warm.
   */
  sourceFingerprint?: string | null;
  updatedAt: number;
}

export const EMPTY_SEMANTIC_INDEX_META: SemanticIndexMeta = {
  id: "current",
  modelKey: null,
  status: "idle",
  total: 0,
  ready: 0,
  pending: 0,
  excluded: 0,
  failed: 0,
  lastCompletedBatchAt: null,
  lastErrorCode: null,
  nextRetryAt: null,
  cacheHits: 0,
  cacheMisses: 0,
  updatedAt: 0,
};
