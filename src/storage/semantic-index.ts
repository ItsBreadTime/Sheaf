import type {
  EmbeddingRecord,
  SemanticIndexMeta,
  SemanticQueueRecord,
  SemanticTabRecord,
} from "../shared/semantic-index-types";
import { EMPTY_SEMANTIC_INDEX_META } from "../shared/semantic-index-types";

const DATABASE_NAME = "sheaf-semantic-index";
const DATABASE_VERSION = 1;
const EMBEDDINGS = "embeddings";
const TABS = "tabs";
const QUEUE = "queue";
const META = "meta";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}

async function database(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Guard each store: createObjectStore throws if the store already exists,
      // which happens when a version bump runs against a partially created schema.
      if (!db.objectStoreNames.contains(EMBEDDINGS)) {
        const embeddings = db.createObjectStore(EMBEDDINGS, { keyPath: "key" });
        embeddings.createIndex("modelKey", "modelKey");
      }
      if (!db.objectStoreNames.contains(TABS)) {
        const tabs = db.createObjectStore(TABS, { keyPath: "mappingKey" });
        tabs.createIndex("status", "status");
        tabs.createIndex("embeddingKey", "embeddingKey");
      }
      if (!db.objectStoreNames.contains(QUEUE)) {
        const queue = db.createObjectStore(QUEUE, { keyPath: "key" });
        queue.createIndex("nextEligibleRetryAt", "nextEligibleRetryAt");
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
    // Without this the open request never settles while another context holds an
    // older connection, leaving every semantic-index call pending forever.
    request.onblocked = () => reject(
      new Error("The semantic index database is blocked by another open connection. Close other extension pages and try again."),
    );
  });
}

export async function getEmbeddingRecords(keys: readonly string[]): Promise<Map<string, EmbeddingRecord>> {
  if (keys.length === 0) return new Map();
  const db = await database();
  try {
    const tx = db.transaction(EMBEDDINGS, "readonly");
    const store = tx.objectStore(EMBEDDINGS);
    const records = await Promise.all(keys.map((key) => requestResult(store.get(key))));
    return new Map(records.filter((record): record is EmbeddingRecord => record !== undefined).map((record) => [record.key, record]));
  } finally { db.close(); }
}

export async function readEmbeddingKeysByModel(modelKey: string): Promise<string[]> {
  const db = await database();
  try {
    const tx = db.transaction(EMBEDDINGS, "readonly");
    const keys = await requestResult(tx.objectStore(EMBEDDINGS).index("modelKey").getAllKeys(modelKey));
    return keys.filter((key): key is string => typeof key === "string");
  } finally { db.close(); }
}

export async function readSemanticIndexMeta(): Promise<SemanticIndexMeta> {
  const db = await database();
  try {
    const tx = db.transaction(META, "readonly");
    return await requestResult(tx.objectStore(META).get("current")) ?? { ...EMPTY_SEMANTIC_INDEX_META };
  } finally { db.close(); }
}

export async function writeSemanticIndexMeta(meta: SemanticIndexMeta): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction(META, "readwrite", { durability: "strict" });
    tx.objectStore(META).put(structuredClone(meta));
    await transactionDone(tx);
  } finally { db.close(); }
}

export async function getEmbeddingRecord(key: string): Promise<EmbeddingRecord | null> {
  const db = await database();
  try {
    const tx = db.transaction(EMBEDDINGS, "readonly");
    return await requestResult(tx.objectStore(EMBEDDINGS).get(key)) ?? null;
  } finally { db.close(); }
}

function writeDifference<T>(
  store: IDBObjectStore,
  current: readonly T[],
  next: readonly T[],
  keyOf: (record: T) => string,
): void {
  const currentByKey = new Map(current.map((record) => [keyOf(record), JSON.stringify(record)]));
  const nextKeys = new Set<string>();
  for (const record of next) {
    const key = keyOf(record);
    nextKeys.add(key);
    if (currentByKey.get(key) !== JSON.stringify(record)) store.put(structuredClone(record));
  }
  for (const key of currentByKey.keys()) {
    if (!nextKeys.has(key)) store.delete(key);
  }
}

export async function replaceSemanticWork(
  mappings: readonly SemanticTabRecord[],
  queue: readonly SemanticQueueRecord[],
  meta: SemanticIndexMeta,
): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction([TABS, QUEUE, META], "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    // Observed below; this only stops an early read failure leaving it unhandled.
    done.catch(() => undefined);
    const tabs = tx.objectStore(TABS);
    const pending = tx.objectStore(QUEUE);
    // A reconcile usually changes a handful of records, so write the difference
    // instead of clearing and rewriting both stores on every tab event.
    const [currentMappings, currentQueue] = await Promise.all([
      requestResult<SemanticTabRecord[]>(tabs.getAll()),
      requestResult<SemanticQueueRecord[]>(pending.getAll()),
    ]);
    writeDifference(tabs, currentMappings, mappings, (record) => record.mappingKey);
    writeDifference(pending, currentQueue, queue, (record) => record.key);
    tx.objectStore(META).put(structuredClone(meta));
    await done;
  } finally { db.close(); }
}

export async function readPendingSemanticQueue(now = Date.now(), limit = 32): Promise<SemanticQueueRecord[]> {
  const db = await database();
  try {
    const tx = db.transaction(QUEUE, "readonly");
    // The nextEligibleRetryAt index turns this into the first `limit` eligible
    // records instead of a full-store scan plus filter. A build reads one batch per
    // pass, so rescanning the whole queue each time made draining it quadratic.
    const eligible = IDBKeyRange.upperBound(now);
    return await requestResult<SemanticQueueRecord[]>(
      tx.objectStore(QUEUE).index("nextEligibleRetryAt").getAll(eligible, limit),
    );
  } finally { db.close(); }
}

export async function readAllSemanticQueue(): Promise<SemanticQueueRecord[]> {
  const db = await database();
  try {
    const tx = db.transaction(QUEUE, "readonly");
    return await requestResult(tx.objectStore(QUEUE).getAll());
  } finally { db.close(); }
}

export function shouldReadAllSemanticMappings(requestedCount: number, totalMappings?: number): boolean {
  return totalMappings !== undefined && totalMappings > 0 && requestedCount <= totalMappings &&
    requestedCount * 3 >= totalMappings;
}

export async function readSemanticTabRecords(
  mappingKeys?: readonly string[],
  totalMappings?: number,
): Promise<SemanticTabRecord[]> {
  const db = await database();
  try {
    const tx = db.transaction(TABS, "readonly");
    const store = tx.objectStore(TABS);
    if (!mappingKeys) return await requestResult(store.getAll());
    const uniqueKeys = [...new Set(mappingKeys)];
    if (shouldReadAllSemanticMappings(uniqueKeys.length, totalMappings)) {
      const requested = new Set(uniqueKeys);
      return (await requestResult(store.getAll())).filter((record) => requested.has(record.mappingKey));
    }
    const records = await Promise.all(uniqueKeys.map((key) => requestResult(store.get(key))));
    return records.filter((record): record is SemanticTabRecord => record !== undefined);
  } finally { db.close(); }
}

export interface SemanticEmbeddingMaintenanceResult {
  deleted: number;
  referenced: number;
}

export async function touchSemanticEmbeddingReferences(
  keys: readonly string[],
  now = Date.now(),
): Promise<number> {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return 0;
  const db = await database();
  try {
    const tx = db.transaction(EMBEDDINGS, "readwrite", { durability: "strict" });
    const store = tx.objectStore(EMBEDDINGS);
    const records = await Promise.all(uniqueKeys.map((key) => requestResult(store.get(key))));
    let touched = 0;
    for (const record of records) {
      if (!record) continue;
      store.put(structuredClone({ ...record, lastReferencedAt: now }));
      touched += 1;
    }
    await transactionDone(tx);
    return touched;
  } finally { db.close(); }
}

export async function garbageCollectSemanticEmbeddings(
  // Retained for existing callers; changing models no longer expires vectors.
  _activeModelKey: string | null,
  now = Date.now(),
  unusedRetentionMs = Number.POSITIVE_INFINITY,
): Promise<SemanticEmbeddingMaintenanceResult> {
  const db = await database();
  try {
    const tx = db.transaction([EMBEDDINGS, TABS], "readwrite", { durability: "strict" });
    const done = transactionDone(tx);
    // Observed below; this only stops an early read failure leaving it unhandled.
    done.catch(() => undefined);
    const embeddingStore = tx.objectStore(EMBEDDINGS);
    // Mappings carry no vectors, so reading them whole is cheap.
    const mappings = await requestResult<SemanticTabRecord[]>(tx.objectStore(TABS).getAll());
    const referencedKeys = new Set(mappings.flatMap((mapping) =>
      mapping.embeddingKey && mapping.status === "ready" ? [mapping.embeddingKey] : []));
    let deleted = 0;
    let referenced = 0;
    if (!Number.isFinite(unusedRetentionMs)) {
      // Nothing can expire, so only the count is needed: keys, not vectors.
      const keys = await requestResult(embeddingStore.getAllKeys());
      referenced = keys.filter((key) => typeof key === "string" && referencedKeys.has(key)).length;
    } else {
      // Configuration changes invalidate mappings, not the durable vector cache.
      // Only an explicitly supplied finite retention period expires unused data.
      // A cursor holds one vector at a time instead of the whole store.
      await new Promise<void>((resolve, reject) => {
        const request = embeddingStore.openCursor();
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const embedding = cursor.value as EmbeddingRecord;
          if (referencedKeys.has(embedding.key)) {
            referenced += 1;
          } else if (now - embedding.lastReferencedAt >= unusedRetentionMs) {
            cursor.delete();
            deleted += 1;
          }
          cursor.continue();
        };
      });
    }
    await done;
    return { deleted, referenced };
  } finally { db.close(); }
}

export async function commitSemanticBatch(
  embeddings: readonly EmbeddingRecord[],
  completedKeys: readonly string[],
  mappingUpdates: readonly SemanticTabRecord[],
  meta: SemanticIndexMeta,
): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction([EMBEDDINGS, TABS, QUEUE, META], "readwrite", { durability: "strict" });
    embeddings.forEach((record) => tx.objectStore(EMBEDDINGS).put(structuredClone(record)));
    mappingUpdates.forEach((record) => tx.objectStore(TABS).put(structuredClone(record)));
    completedKeys.forEach((key) => tx.objectStore(QUEUE).delete(key));
    tx.objectStore(META).put(structuredClone(meta));
    await transactionDone(tx);
  } finally { db.close(); }
}

export async function recordSemanticBatchFailure(
  queueUpdates: readonly SemanticQueueRecord[],
  completedKeys: readonly string[],
  mappingUpdates: readonly SemanticTabRecord[],
  meta: SemanticIndexMeta,
): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction([TABS, QUEUE, META], "readwrite", { durability: "strict" });
    queueUpdates.forEach((record) => tx.objectStore(QUEUE).put(structuredClone(record)));
    completedKeys.forEach((key) => tx.objectStore(QUEUE).delete(key));
    mappingUpdates.forEach((record) => tx.objectStore(TABS).put(structuredClone(record)));
    tx.objectStore(META).put(structuredClone(meta));
    await transactionDone(tx);
  } finally { db.close(); }
}

export async function discardPendingSemanticWork(meta: SemanticIndexMeta): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction([QUEUE, META], "readwrite", { durability: "strict" });
    tx.objectStore(QUEUE).clear();
    tx.objectStore(META).put(structuredClone(meta));
    await transactionDone(tx);
  } finally { db.close(); }
}

/**
 * Quarantines unusable records in one write, leaving the rest of the index usable.
 *
 * One corrupt vector used to break semantic search permanently behind a generic
 * error with no way back, because the query threw on the first bad record. The
 * affected vectors are *deleted*, not merely flagged: a flagged mapping whose vector
 * still exists would be planned straight back to `ready` on the next reconcile and
 * quarantined again on the next query. Deleting it makes the next reconcile
 * re-queue the document, so the index heals itself instead of flapping.
 */
export async function quarantineSemanticMappings(
  mappingKeys: readonly string[],
  errorCode: string,
  now = Date.now(),
): Promise<number> {
  const uniqueKeys = [...new Set(mappingKeys)];
  if (uniqueKeys.length === 0) return 0;
  const db = await database();
  try {
    const readTx = db.transaction(TABS, "readonly");
    const records = (await Promise.all(uniqueKeys.map((key) =>
      requestResult(readTx.objectStore(TABS).get(key))))).filter(
      (record): record is SemanticTabRecord => record !== undefined,
    );
    if (records.length === 0) return 0;
    const meta = await readSemanticIndexMeta();
    const tx = db.transaction([EMBEDDINGS, TABS, META], "readwrite", { durability: "strict" });
    records.forEach((record) => {
      if (record.embeddingKey) tx.objectStore(EMBEDDINGS).delete(record.embeddingKey);
      tx.objectStore(TABS).put(structuredClone({
        ...record,
        status: "failed" as const,
        errorCode,
        updatedAt: now,
      }));
    });
    const newlyFailed = records.filter((record) => record.status !== "failed").length;
    tx.objectStore(META).put(structuredClone({
      ...meta,
      ready: Math.max(0, meta.ready - records.filter((record) => record.status === "ready").length),
      pending: Math.max(0, meta.pending - records.filter((record) => record.status === "pending").length),
      failed: meta.failed + newlyFailed,
      lastErrorCode: errorCode,
      updatedAt: now,
    } satisfies SemanticIndexMeta));
    await transactionDone(tx);
    return newlyFailed;
  } finally { db.close(); }
}

export async function invalidateSemanticMappings(meta: SemanticIndexMeta): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction([TABS, QUEUE, META], "readwrite", { durability: "strict" });
    tx.objectStore(TABS).clear();
    tx.objectStore(QUEUE).clear();
    tx.objectStore(META).put(structuredClone(meta));
    await transactionDone(tx);
  } finally { db.close(); }
}

export async function clearSemanticIndex(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Semantic index could not be cleared."));
    request.onblocked = () => reject(new Error("Semantic index clear was blocked by another extension page."));
  });
}
