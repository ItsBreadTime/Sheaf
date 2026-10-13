import { OpenAICompatibleEmbeddingClient, EmbeddingRequestError } from "../search/embedding-client";
import {
  isRetryableEmbeddingErrorCode,
  retryAfterMs,
  safeEmbeddingErrorCode,
} from "../search/embedding-errors";
import { noteProviderRetryAfter, waitForProviderSlot } from "../search/provider-rate-limit";
import {
  createSemanticIndexPlan,
  normalizeEmbeddingVector,
  semanticMappingKey,
  semanticSourceFingerprint,
  semanticStashMappingKey,
} from "../search/semantic-indexer";
import { computeSemanticCompatibilityKey, semanticDocumentPrivacy } from "../search/semantic-document";
import type { SemanticDocumentSource } from "../search/semantic-document";
import type { PrivacySettings } from "../shared/organizer-types";
import type {
  EmbeddingRecord,
  SemanticIndexMeta,
  SemanticQueueRecord,
  SemanticTabRecord,
} from "../shared/semantic-index-types";
import { readOrganizerState } from "../storage/organizer-state";
import { readSearchState } from "../storage/search";
import { readTabStashes } from "../storage/stashes";
import type { SavedTabStash } from "../shared/stash-types";
import {
  clearSemanticIndex,
  commitSemanticBatch,
  discardPendingSemanticWork,
  garbageCollectSemanticEmbeddings,
  invalidateSemanticMappings,
  readAllSemanticQueue,
  readEmbeddingKeysByModel,
  readPendingSemanticQueue,
  readSemanticIndexMeta,
  readSemanticTabRecords,
  recordSemanticBatchFailure,
  replaceSemanticWork,
  touchSemanticEmbeddingReferences,
  writeSemanticIndexMeta,
} from "../storage/semantic-index";

export const SEMANTIC_INDEX_RESUME_ALARM = "semantic-index-resume";
export const SEMANTIC_INDEX_MAINTENANCE_ALARM = "semantic-index-maintenance";
const BATCH_SIZE = 32;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [5_000, 30_000, 5 * 60_000] as const;
// Vectors no mapping references are kept for a while so a configuration change
// that re-maps the same documents does not re-embed them, then expired so the
// store cannot grow without bound (each 4096-dim vector is ~16 KB).
const UNUSED_EMBEDDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

let activeController: AbortController | null = null;
let activeRun: Promise<void> | null = null;
let lifecycleTimer: ReturnType<typeof setTimeout> | null = null;
let maintenanceRun: Promise<SemanticIndexMeta> | null = null;
let maintenanceRequested = false;
let garbageCollectionRequested = false;
let explicitMutationPending = 0;
let explicitMutationTail: Promise<void> = Promise.resolve();

function combinedEmbeddingConfig(state: Awaited<ReturnType<typeof readSearchState>>) {
  return { ...state.local.embeddingConfig, customHeaders: state.session.customHeaders };
}

/**
 * Every document build and compatibility-key computation in this module reads the
 * privacy settings through here, so the index follows the search consent for group
 * titles rather than the organizer's flag. One helper instead of five call sites
 * each remembering to convert.
 */
function indexPrivacy(
  search: Awaited<ReturnType<typeof readSearchState>>,
  organizerData: Awaited<ReturnType<typeof readOrganizerState>>,
): PrivacySettings {
  return semanticDocumentPrivacy(
    organizerData.local.privacy,
    search.local.settings.semanticIncludeGroupNames,
  );
}

function ensureIndexingEnabled(state: Awaited<ReturnType<typeof readSearchState>>): void {
  if (!state.local.settings.semanticEnabled || state.local.settings.semanticConsentAt === null) {
    throw new Error("Enable semantic search and confirm the privacy disclosure before building the index.");
  }
  if (!state.local.embeddingConfig.model.trim()) throw new Error("Configure an embedding model before building the index.");
  if (!state.local.providerTest) throw new Error("Test the embedding provider before building the index.");
}

async function readSemanticSources(scope: "current_window" | "all_windows", targetWindowId: number): Promise<SemanticDocumentSource[]> {
  const query: chrome.tabs.QueryInfo = scope === "current_window" ? { windowId: targetWindowId } : {};
  const tabs = await chrome.tabs.query(query);
  const groupQuery: chrome.tabGroups.QueryInfo = scope === "current_window" ? { windowId: targetWindowId } : {};
  const [groups, stashes] = await Promise.all([
    chrome.tabGroups.query(groupQuery),
    readTabStashes(),
  ]);
  return [...semanticSourcesFromChromeTabs(tabs, groups), ...semanticSourcesFromStashes(stashes)];
}

export function semanticSourcesFromChromeTabs(
  tabs: readonly chrome.tabs.Tab[],
  groups: readonly chrome.tabGroups.TabGroup[],
): SemanticDocumentSource[] {
  const groupNames = new Map(groups.map((group) => [group.id, group.title?.trim() || null]));
  return tabs.flatMap((tab) => tab.incognito || tab.id === undefined || tab.windowId === undefined ||
    !tab.title?.trim() || !tab.url?.trim()
    ? []
    : [{
        mappingKey: semanticMappingKey({ id: tab.id, windowId: tab.windowId }),
        target: { kind: "open" as const, tabId: tab.id, windowId: tab.windowId },
        title: tab.title ?? "",
        url: tab.url ?? "",
        groupName: tab.groupId === -1 ? null : groupNames.get(tab.groupId) ?? null,
      }]);
}

export function semanticSourcesFromStashes(stashes: readonly SavedTabStash[]): SemanticDocumentSource[] {
  return stashes.flatMap((stash) => {
    if (stash.status === "closing_interrupted") return [];
    const groupNames = new Map(stash.groups.map((group) => [group.key, group.title.trim() || null]));
    return stash.tabs.map((tab) => ({
      mappingKey: semanticStashMappingKey(stash.id, tab.sourceIndex),
      target: { kind: "stash" as const, stashId: stash.id, sourceIndex: tab.sourceIndex },
      title: tab.title,
      url: tab.url,
      groupName: tab.groupKey ? groupNames.get(tab.groupKey) ?? null : null,
    }));
  });
}

async function withExplicitSemanticMutation<T>(
  operation: () => Promise<T>,
  options: { consumeDeferredMaintenance?: boolean } = {},
): Promise<T> {
  const previous = explicitMutationTail;
  let release!: () => void;
  explicitMutationTail = new Promise<void>((resolve) => { release = resolve; });
  explicitMutationPending += 1;
  await previous;
  try {
    if (lifecycleTimer) {
      clearTimeout(lifecycleTimer);
      lifecycleTimer = null;
    }
    if (maintenanceRun) await maintenanceRun;
    return await operation();
  } finally {
    const deferredMaintenance = maintenanceRequested;
    if (options.consumeDeferredMaintenance) maintenanceRequested = false;
    explicitMutationPending -= 1;
    release();
    if (deferredMaintenance && !options.consumeDeferredMaintenance && explicitMutationPending === 0) {
      scheduleSemanticIndexReconciliation(0);
    }
  }
}

export function prepareSemanticIndex(targetWindowId: number): Promise<SemanticIndexMeta> {
  return withExplicitSemanticMutation(async () => {
    await cancelSemanticIndexInternal(false);
    if (activeRun) await activeRun;
    const [search, organizerData] = await Promise.all([readSearchState(), readOrganizerState()]);
    ensureIndexingEnabled(search);
    const config = combinedEmbeddingConfig(search);
    const resolvedDimensions = search.local.providerTest!.dimensions;
    const modelKey = await computeSemanticCompatibilityKey(config, indexPrivacy(search, organizerData), resolvedDimensions);
    const [sources, cached, existingMappings] = await Promise.all([
      readSemanticSources(search.local.settings.semanticIndexScope, targetWindowId),
      readEmbeddingKeysByModel(modelKey),
      readSemanticTabRecords(),
    ]);
    const plan = await createSemanticIndexPlan(
      sources,
      indexPrivacy(search, organizerData),
      config,
      new Set(cached),
      Date.now(),
      resolvedDimensions,
      {
        indexScope: search.local.settings.semanticIndexScope,
        targetWindowId: search.local.settings.semanticIndexScope === "current_window" ? targetWindowId : null,
      },
    );
    await touchSemanticEmbeddingReferences([
      ...existingMappings.flatMap((mapping) =>
        mapping.status === "ready" && mapping.embeddingKey ? [mapping.embeddingKey] : []),
      ...plan.mappings.flatMap((mapping) =>
        mapping.status === "ready" && mapping.embeddingKey ? [mapping.embeddingKey] : []),
    ]);
    await replaceSemanticWork(plan.mappings, plan.queue, plan.meta);
    await garbageCollectSemanticEmbeddings(plan.meta.modelKey);
    if (plan.meta.status === "building") startSemanticIndexProcessing();
    return plan.meta;
  });
}

function staleMissingWindowMeta(meta: SemanticIndexMeta, now: number): SemanticIndexMeta {
  return {
    ...meta,
    status: "stale",
    total: 0,
    ready: 0,
    pending: 0,
    excluded: 0,
    failed: 0,
    lastErrorCode: "target_window_closed",
    nextRetryAt: null,
    updatedAt: now,
  };
}

export function semanticMappingsChanged(
  existingMappings: readonly SemanticTabRecord[],
  nextMappings: readonly SemanticTabRecord[],
): boolean {
  if (existingMappings.length !== nextMappings.length) return true;
  const fingerprints = new Map(existingMappings.map((mapping) => [mapping.mappingKey, [
    mapping.documentHash,
    mapping.embeddingKey,
    mapping.errorCode ?? null,
  ].join("\n")]));
  return nextMappings.some((mapping) => fingerprints.get(mapping.mappingKey) !== [
    mapping.documentHash,
    mapping.embeddingKey,
    mapping.errorCode ?? null,
  ].join("\n"));
}

async function semanticTargetWindowExists(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the plan could not differ from the one already stored: the build is
 * finished, nothing is queued, and the source tuples hash the same. Document
 * building and key derivation are the expensive part of reconciliation, and a noisy
 * page would otherwise pay for them on every debounce tick.
 */
export async function semanticPlanIsCurrent(
  meta: SemanticIndexMeta,
  queueEmpty: boolean,
  fingerprint: string,
): Promise<boolean> {
  return meta.status === "complete" &&
    meta.failed === 0 &&
    queueEmpty &&
    Boolean(meta.sourceFingerprint) &&
    meta.sourceFingerprint === fingerprint;
}

async function reconcileSemanticIndex(startProviderProcessing = true, force = false): Promise<SemanticIndexMeta> {
  let meta = await refreshSemanticIndexCompatibility();
  if ((meta.status !== "complete" && meta.status !== "building") || !meta.modelKey) {
    return meta;
  }
  const scope = meta.indexScope ?? "current_window";
  const targetWindowId = meta.targetWindowId;
  if (scope === "current_window" &&
      (targetWindowId === null || targetWindowId === undefined || !(await semanticTargetWindowExists(targetWindowId)))) {
    activeController?.abort();
    if (activeRun) await activeRun;
    meta = await readSemanticIndexMeta();
    const removedMappings = await readSemanticTabRecords();
    await touchSemanticEmbeddingReferences(removedMappings.flatMap((mapping) =>
      mapping.status === "ready" && mapping.embeddingKey ? [mapping.embeddingKey] : []));
    meta = staleMissingWindowMeta(meta, Date.now());
    await invalidateSemanticMappings(meta);
    return meta;
  }
  const [search, organizerData] = await Promise.all([readSearchState(), readOrganizerState()]);
  ensureIndexingEnabled(search);
  const config = combinedEmbeddingConfig(search);
  const resolvedDimensions = search.local.providerTest!.dimensions;
  const modelKey = await computeSemanticCompatibilityKey(config, indexPrivacy(search, organizerData), resolvedDimensions);
  if (modelKey !== meta.modelKey) return refreshSemanticIndexCompatibility();
  const [sources, initialCached, existingMappings, initialQueue] = await Promise.all([
    readSemanticSources(scope, targetWindowId ?? -1),
    readEmbeddingKeysByModel(modelKey),
    readSemanticTabRecords(),
    readAllSemanticQueue(),
  ]);
  if (!force && await semanticPlanIsCurrent(meta, initialQueue.length === 0, await semanticSourceFingerprint(sources))) {
    return meta;
  }
  let cached = initialCached;
  let existingQueue = initialQueue;
  let plan = await createSemanticIndexPlan(
    sources,
    indexPrivacy(search, organizerData),
    config,
    new Set(cached),
    Date.now(),
    resolvedDimensions,
    { indexScope: scope, targetWindowId: scope === "current_window" ? targetWindowId : null },
  );
  if (semanticMappingsChanged(existingMappings, plan.mappings)) {
    if (activeRun) {
      activeController?.abort();
      await activeRun;
      [meta, cached, existingQueue] = await Promise.all([
        readSemanticIndexMeta(),
        readEmbeddingKeysByModel(modelKey),
        readAllSemanticQueue(),
      ]);
      plan = await createSemanticIndexPlan(
        sources,
        indexPrivacy(search, organizerData),
        config,
        new Set(cached),
        Date.now(),
        resolvedDimensions,
        { indexScope: scope, targetWindowId: scope === "current_window" ? targetWindowId : null },
      );
    }
    const previousQueue = new Map(existingQueue.map((record) => [record.key, record]));
    plan.queue = plan.queue.map((record) => {
      const previous = previousQueue.get(record.key);
      return previous ? {
        ...record,
        retryCount: previous.retryCount,
        nextEligibleRetryAt: previous.nextEligibleRetryAt,
        createdAt: previous.createdAt,
        ...(previous.lastErrorCode ? { lastErrorCode: previous.lastErrorCode } : {}),
      } : record;
    });
    plan.meta.lastCompletedBatchAt = meta.lastCompletedBatchAt;
    plan.meta.lastErrorCode = meta.lastErrorCode;
    plan.meta.nextRetryAt = meta.nextRetryAt ?? null;
    const oldReferences = new Set(existingMappings.flatMap((mapping) =>
      mapping.status === "ready" && mapping.embeddingKey ? [mapping.embeddingKey] : []));
    const nextReferences = new Set(plan.mappings.flatMap((mapping) =>
      mapping.status === "ready" && mapping.embeddingKey ? [mapping.embeddingKey] : []));
    await touchSemanticEmbeddingReferences([
      ...[...oldReferences].filter((key) => !nextReferences.has(key)),
      ...[...nextReferences].filter((key) => !oldReferences.has(key)),
    ]);
    await replaceSemanticWork(plan.mappings, plan.queue, plan.meta);
    meta = plan.meta;
  }
  if (startProviderProcessing && meta.status === "building") startSemanticIndexProcessing();
  return meta;
}

export function withLocalOnlySemanticStashMutation<T>(operation: () => Promise<T>): Promise<T> {
  return withExplicitSemanticMutation(async () => {
    activeController?.abort();
    if (activeRun) await activeRun;
    clearResumeAlarm();
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }
    try {
      await reconcileSemanticIndex(false);
    } catch {
      // The stash transaction is authoritative once committed. A marked storage
      // event or later maintenance pass can retry this local-only reconciliation.
    }
    if (operationError !== undefined) throw operationError;
    return result as T;
  }, { consumeDeferredMaintenance: true });
}

export function reconcileSemanticStashChangesLocally(): Promise<void> {
  return withLocalOnlySemanticStashMutation(async () => undefined);
}

export function runSemanticIndexMaintenance(garbageCollect = false): Promise<SemanticIndexMeta> {
  maintenanceRequested = true;
  if (garbageCollect) garbageCollectionRequested = true;
  if (explicitMutationPending > 0) {
    return explicitMutationTail.then(() => maintenanceRequested
      ? runSemanticIndexMaintenance(garbageCollect)
      : readSemanticIndexMeta());
  }
  if (maintenanceRun) return maintenanceRun;
  maintenanceRun = (async () => {
    let meta = await readSemanticIndexMeta();
    do {
      maintenanceRequested = false;
      const collectThisPass = garbageCollectionRequested;
      garbageCollectionRequested = false;
      meta = await reconcileSemanticIndex();
      if (collectThisPass) await garbageCollectSemanticEmbeddings(
        meta.status === "stale" && meta.lastErrorCode === "configuration_changed" ? null : meta.modelKey,
        Date.now(),
        UNUSED_EMBEDDING_RETENTION_MS,
      );
    } while (maintenanceRequested && explicitMutationPending === 0);
    return meta;
  })().finally(() => { maintenanceRun = null; });
  return maintenanceRun;
}

export function scheduleSemanticIndexReconciliation(delayMs = 1_500): void {
  maintenanceRequested = true;
  if (explicitMutationPending > 0) return;
  if (lifecycleTimer) clearTimeout(lifecycleTimer);
  lifecycleTimer = setTimeout(() => {
    lifecycleTimer = null;
    void runSemanticIndexMaintenance().catch(() => undefined);
  }, delayMs);
}

const safeErrorCode = safeEmbeddingErrorCode;

/** Kept as the name the index path and its tests already use. */
export function isRetryableSemanticErrorCode(code: string): boolean {
  return isRetryableEmbeddingErrorCode(code as Parameters<typeof isRetryableEmbeddingErrorCode>[0]);
}

function readyMappingUpdates(records: readonly SemanticQueueRecord[], mappings: readonly SemanticTabRecord[], now: number): SemanticTabRecord[] {
  const embeddingKeys = new Set(records.map((record) => record.key));
  return mappings.flatMap((mapping) => mapping.embeddingKey && embeddingKeys.has(mapping.embeddingKey)
    ? [{ ...mapping, status: "ready" as const, errorCode: undefined, updatedAt: now }]
    : []);
}

async function scheduleResume(when: number): Promise<void> {
  await chrome.alarms.create(SEMANTIC_INDEX_RESUME_ALARM, { when: Math.max(Date.now() + 500, when) });
}

function clearResumeAlarm(): void {
  void chrome.alarms.clear(SEMANTIC_INDEX_RESUME_ALARM);
}

async function failRemainingSemanticWork(meta: SemanticIndexMeta, errorCode: string, now: number): Promise<void> {
  const queue = await readAllSemanticQueue();
  const mappings = await readSemanticTabRecords(queue.flatMap((record) => record.mappingKeys));
  const failedMappings = mappings.flatMap((mapping) => mapping.status === "pending"
    ? [{ ...mapping, status: "failed" as const, errorCode, updatedAt: now }]
    : []);
  await recordSemanticBatchFailure([], queue.map((record) => record.key), failedMappings, {
    ...meta,
    status: "failed",
    pending: Math.max(0, meta.pending - failedMappings.length),
    failed: meta.failed + failedMappings.length,
    lastErrorCode: errorCode,
    nextRetryAt: null,
    updatedAt: now,
  });
  clearResumeAlarm();
}

export async function refreshSemanticIndexCompatibility(): Promise<SemanticIndexMeta> {
  let meta = await readSemanticIndexMeta();
  if (!meta.modelKey || meta.status === "idle" || meta.status === "stale") return meta;
  const [search, organizerData] = await Promise.all([readSearchState(), readOrganizerState()]);
  const config = combinedEmbeddingConfig(search);
  const currentModelKey = config.model && search.local.providerTest
    ? await computeSemanticCompatibilityKey(config, indexPrivacy(search, organizerData), search.local.providerTest.dimensions)
    : null;
  if (currentModelKey === meta.modelKey) return meta;
  activeController?.abort();
  if (activeRun) await activeRun;
  meta = await readSemanticIndexMeta();
  const stale: SemanticIndexMeta = {
    ...meta,
    status: "stale",
    total: 0,
    ready: 0,
    pending: 0,
    excluded: 0,
    failed: 0,
    lastErrorCode: "configuration_changed",
    nextRetryAt: null,
    updatedAt: Date.now(),
  };
  await invalidateSemanticMappings(stale);
  await garbageCollectSemanticEmbeddings(null);
  clearResumeAlarm();
  return stale;
}

async function processSemanticIndex(): Promise<void> {
  const controller = new AbortController();
  activeController = controller;
  try {
    while (!controller.signal.aborted) {
      const [meta, search, organizerData] = await Promise.all([readSemanticIndexMeta(), readSearchState(), readOrganizerState()]);
      if (meta.status !== "building") return;
      if (!search.local.settings.semanticEnabled || search.local.settings.semanticConsentAt === null) {
        await discardPendingSemanticWork({ ...meta, status: "cancelled", updatedAt: Date.now() });
        clearResumeAlarm();
        return;
      }
      const config = combinedEmbeddingConfig(search);
      const currentModelKey = await computeSemanticCompatibilityKey(
        config,
        indexPrivacy(search, organizerData),
        search.local.providerTest?.dimensions ?? config.dimensions,
      );
      if (currentModelKey !== meta.modelKey) {
        await discardPendingSemanticWork({ ...meta, status: "cancelled", lastErrorCode: "configuration_changed", updatedAt: Date.now() });
        clearResumeAlarm();
        return;
      }
      const batch = await readPendingSemanticQueue(Date.now(), BATCH_SIZE);
      if (batch.length === 0) {
        const remaining = await readAllSemanticQueue();
        if (remaining.length === 0) {
          await writeSemanticIndexMeta({
            ...meta,
            status: meta.failed > 0 ? "failed" : "complete",
            nextRetryAt: null,
            updatedAt: Date.now(),
          });
          clearResumeAlarm();
          if (meta.failed === 0) scheduleSemanticIndexReconciliation(0);
        } else {
          await scheduleResume(Math.min(...remaining.map((record) => record.nextEligibleRetryAt)));
        }
        return;
      }
      if (batch.some((record) => record.modelKey !== meta.modelKey)) {
        await failRemainingSemanticWork(meta, "incompatible_queue", Date.now());
        return;
      }
      const mappingKeys = batch.flatMap((record) => record.mappingKeys);
      const mappings = await readSemanticTabRecords(mappingKeys);
      try {
        await scheduleResume(Date.now() + Math.max(60_000, config.timeoutMs + 5_000));
        // A pause the provider asked for applies to the build, not to the user's
        // search: batches here are what turn a 429 into a ban.
        await waitForProviderSlot({ priority: "background", maxWaitMs: config.timeoutMs });
        const vectors = await new OpenAICompatibleEmbeddingClient().embedDocuments(
          batch.map((record) => record.document),
          config,
          search.session.apiKey,
          controller.signal,
        );
        if (search.local.providerTest && vectors.some((vector) => vector.length !== search.local.providerTest!.dimensions)) {
          throw new Error("Embedding dimension differs from the tested provider.");
        }
        const now = Date.now();
        const embeddings: EmbeddingRecord[] = vectors.map((vector, index) => ({
          key: batch[index]!.key,
          modelKey: batch[index]!.modelKey,
          dimensions: vector.length,
          vector: normalizeEmbeddingVector(vector),
          createdAt: now,
          lastReferencedAt: now,
        }));
        if (controller.signal.aborted) return;
        const updates = readyMappingUpdates(batch, mappings, now);
        await commitSemanticBatch(embeddings, batch.map((record) => record.key), updates, {
          ...meta,
          ready: meta.ready + updates.length,
          pending: Math.max(0, meta.pending - updates.length),
          lastCompletedBatchAt: now,
          lastErrorCode: null,
          nextRetryAt: null,
          updatedAt: now,
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof EmbeddingRequestError && error.code === "cancelled")) return;
        const now = Date.now();
        const errorCode = safeErrorCode(error);
        if (!isRetryableSemanticErrorCode(errorCode) || batch.some((record) => record.retryCount + 1 >= MAX_RETRIES)) {
          await failRemainingSemanticWork(meta, errorCode, now);
          return;
        }
        // A provider that names its own delay knows better than the fixed schedule,
        // and ignoring it is how a build earns a longer ban than it was given.
        const providerDelayMs = retryAfterMs(error, now) ?? 0;
        if (errorCode === "rate_limited") await noteProviderRetryAfter(providerDelayMs);
        const retryUpdates = batch.map((record) => ({
          ...record,
          retryCount: record.retryCount + 1,
          nextEligibleRetryAt: now + Math.max(
            RETRY_DELAYS_MS[Math.min(record.retryCount, RETRY_DELAYS_MS.length - 1)]!,
            providerDelayMs,
          ),
          lastErrorCode: errorCode,
        }));
        const nextRetryAt = Math.min(...retryUpdates.map((record) => record.nextEligibleRetryAt));
        await recordSemanticBatchFailure(
          retryUpdates,
          [],
          [],
          {
            ...meta,
            lastErrorCode: errorCode,
            nextRetryAt,
            updatedAt: now,
          },
        );
        await scheduleResume(nextRetryAt);
        return;
      }
    }
  } finally {
    if (activeController === controller) activeController = null;
  }
}

function startSemanticIndexProcessing(): void {
  if (activeRun) return;
  activeRun = processSemanticIndex().catch(async () => {
    try {
      const meta = await readSemanticIndexMeta();
      if (meta.status === "building") {
        await failRemainingSemanticWork(meta, "index_runtime", Date.now());
      }
    } catch {
      // IndexedDB may itself be unavailable. A later user action can retry safely.
    }
  }).finally(() => { activeRun = null; });
}

export async function resumeSemanticIndex(): Promise<SemanticIndexMeta> {
  if (explicitMutationPending > 0) return runSemanticIndexMaintenance();
  const meta = await readSemanticIndexMeta();
  if (meta.status === "building") startSemanticIndexProcessing();
  // Self-healing path: a query may have quarantined records, which drops their
  // vectors and leaves failed mappings behind. Reconcile is what turns those back
  // into queued work, so a quarantine is repaired without a manual rebuild.
  else if (meta.failed > 0) return runSemanticIndexMaintenance();
  return meta;
}

async function cancelSemanticIndexInternal(markCancelled = true): Promise<SemanticIndexMeta> {
  activeController?.abort();
  if (markCancelled && activeRun) await activeRun;
  const meta = await readSemanticIndexMeta();
  const next = markCancelled && meta.status === "building"
    ? { ...meta, status: "cancelled" as const, lastErrorCode: null, nextRetryAt: null, updatedAt: Date.now() }
    : meta;
  if (next !== meta) {
    await discardPendingSemanticWork(next);
    clearResumeAlarm();
  }
  return next;
}

export function cancelSemanticIndex(markCancelled = true): Promise<SemanticIndexMeta> {
  return withExplicitSemanticMutation(() => cancelSemanticIndexInternal(markCancelled));
}

export function clearCurrentSemanticIndex(): Promise<SemanticIndexMeta> {
  return withExplicitSemanticMutation(async () => {
    activeController?.abort();
    if (activeRun) await activeRun;
    clearResumeAlarm();
    await clearSemanticIndex();
    return readSemanticIndexMeta();
  });
}
