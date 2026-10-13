import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SEMANTIC_INDEX_META } from "../src/shared/semantic-index-types";
import type { EmbeddingRecord, SemanticQueueRecord, SemanticTabRecord } from "../src/shared/semantic-index-types";
import {
  clearSemanticIndex, commitSemanticBatch, garbageCollectSemanticEmbeddings,
  getEmbeddingRecord, invalidateSemanticMappings, readAllSemanticQueue,
  readEmbeddingKeysByModel, readPendingSemanticQueue, readSemanticIndexMeta,
  readSemanticTabRecords, replaceSemanticWork,
} from "../src/storage/semantic-index";

const meta = { ...EMPTY_SEMANTIC_INDEX_META, modelKey: "model-a", status: "building" as const, total: 1, pending: 1 };
const mapping: SemanticTabRecord = {
  mappingKey: "window:1:tab:1", target: { kind: "open", windowId: 1, tabId: 1 },
  documentHash: "document", embeddingKey: "vector-a", status: "pending", updatedAt: 1,
};
const queued: SemanticQueueRecord = {
  key: "vector-a", modelKey: "model-a", document: "Title: Example", mappingKeys: [mapping.mappingKey],
  retryCount: 2, nextEligibleRetryAt: 50_000, createdAt: 1,
};
const vector: EmbeddingRecord = {
  key: "vector-a", modelKey: "model-a", dimensions: 2, vector: new Float32Array([0.6, 0.8]),
  createdAt: 1, lastReferencedAt: 1,
};

afterEach(async () => { vi.restoreAllMocks(); await clearSemanticIndex(); });

describe("durable semantic index", () => {
  it("recovers queued work and retry state through fresh database connections", async () => {
    await replaceSemanticWork([mapping], [queued], meta);
    // Every storage operation closes its connection; these reads reopen the database.
    expect(await readAllSemanticQueue()).toEqual([queued]);
    expect(await readSemanticTabRecords()).toEqual([mapping]);
    expect(await readSemanticIndexMeta()).toEqual(meta);
  });

  it("replaces work by writing only the records that changed", async () => {
    const second = { ...mapping, mappingKey: "window:1:tab:2", target: { kind: "open" as const, windowId: 1, tabId: 2 } };
    const third = { ...mapping, mappingKey: "window:1:tab:3", target: { kind: "open" as const, windowId: 1, tabId: 3 } };
    await replaceSemanticWork([mapping, second], [queued], meta);
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    const remove = vi.spyOn(IDBObjectStore.prototype, "delete");
    const changed = { ...second, documentHash: "edited" };
    await replaceSemanticWork([mapping, changed, third], [], meta);
    // One changed mapping, one new mapping, and the meta record.
    expect(put).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledWith(queued.key);
    expect((await readSemanticTabRecords()).sort((a, b) => a.mappingKey.localeCompare(b.mappingKey)))
      .toEqual([mapping, changed, third]);
    expect(await readAllSemanticQueue()).toEqual([]);
  });

  it("counts referenced vectors without expiring any under the default retention", async () => {
    const other = { ...vector, key: "unused" };
    await commitSemanticBatch([vector, other], [], [{ ...mapping, status: "ready" }], meta);
    expect(await garbageCollectSemanticEmbeddings(null, 10 ** 12)).toEqual({ deleted: 0, referenced: 1 });
  });

  it("reads the eligible queue head in retry order, up to the batch limit", async () => {
    const later = { ...queued, key: "vector-b", nextEligibleRetryAt: 90_000 };
    const sooner = { ...queued, key: "vector-c", nextEligibleRetryAt: 10_000 };
    const ready = { ...queued, key: "vector-d", nextEligibleRetryAt: 1_000 };
    await replaceSemanticWork([], [queued, later, sooner, ready], meta);
    expect((await readPendingSemanticQueue(20_000)).map((record) => record.key)).toEqual(["vector-d", "vector-c"]);
    expect((await readPendingSemanticQueue(20_000, 1)).map((record) => record.key)).toEqual(["vector-d"]);
    expect(await readPendingSemanticQueue(500)).toEqual([]);
    expect((await readPendingSemanticQueue(100_000)).map((record) => record.key))
      .toEqual(["vector-d", "vector-c", "vector-a", "vector-b"]);
  });

  it("commits vectors, mappings and queue completion together using strict durability", async () => {
    await replaceSemanticWork([mapping], [queued], meta);
    const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
    const ready = { ...mapping, status: "ready" as const };
    const complete = { ...meta, status: "complete" as const, ready: 1, pending: 0 };
    await commitSemanticBatch([vector], [queued.key], [ready], complete);
    expect(transaction).toHaveBeenCalledWith(
      ["embeddings", "tabs", "queue", "meta"], "readwrite", { durability: "strict" },
    );
    expect(await getEmbeddingRecord(vector.key)).toEqual(vector);
    expect(await readAllSemanticQueue()).toEqual([]);
    expect(await readSemanticTabRecords()).toEqual([ready]);
    expect(await readSemanticIndexMeta()).toEqual(complete);
  });

  it("retains old unreferenced vectors through model changes and stale configuration maintenance", async () => {
    const other = { ...vector, key: "vector-b", modelKey: "model-b" };
    await commitSemanticBatch([vector, other], [], [], meta);
    await invalidateSemanticMappings({ ...meta, status: "stale", lastErrorCode: "configuration_changed" });
    const yearsLater = 10 * 365 * 24 * 60 * 60_000;
    expect((await garbageCollectSemanticEmbeddings(null, yearsLater)).deleted).toBe(0);
    expect((await garbageCollectSemanticEmbeddings("model-b", yearsLater)).deleted).toBe(0);
    expect(await readEmbeddingKeysByModel("model-a")).toEqual([vector.key]);
    expect(await readEmbeddingKeysByModel("model-b")).toEqual([other.key]);
    expect(await getEmbeddingRecord(vector.key)).toEqual(vector);
  });

  it("protects referenced vectors even when finite retention is explicitly requested", async () => {
    const other = { ...vector, key: "unused" };
    await commitSemanticBatch([vector, other], [], [{ ...mapping, status: "ready" }], meta);
    expect(await garbageCollectSemanticEmbeddings(null, 1000, 100)).toEqual({ deleted: 1, referenced: 1 });
    expect(await getEmbeddingRecord(vector.key)).toEqual(vector);
    expect(await getEmbeddingRecord(other.key)).toBeNull();
  });

  it("explicit clearing removes vectors, pending work, mappings and metadata", async () => {
    await replaceSemanticWork([mapping], [queued], meta);
    await commitSemanticBatch([vector], [], [], meta);
    await clearSemanticIndex();
    expect(await getEmbeddingRecord(vector.key)).toBeNull();
    expect(await readAllSemanticQueue()).toEqual([]);
    expect(await readSemanticTabRecords()).toEqual([]);
    expect(await readSemanticIndexMeta()).toEqual(EMPTY_SEMANTIC_INDEX_META);
  });
});
