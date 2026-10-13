import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SemanticDimensionDriftError,
  querySemanticTabs,
  type SemanticQueryCandidate,
} from "../src/search/semantic-query";
import {
  commitSemanticBatch,
  getEmbeddingRecords,
  quarantineSemanticMappings,
  readSemanticIndexMeta,
  readSemanticTabRecords,
  replaceSemanticWork,
  writeSemanticIndexMeta,
  clearSemanticIndex,
} from "../src/storage/semantic-index";
import { EMPTY_SEMANTIC_INDEX_META } from "../src/shared/semantic-index-types";
import type { EmbeddingRecord, SemanticIndexMeta, SemanticTabRecord } from "../src/shared/semantic-index-types";

const DIMENSIONS = 3;

function mapping(mappingKey: string, id: string): SemanticTabRecord {
  return {
    mappingKey,
    target: { kind: "open", tabId: Number(id), windowId: 1 },
    documentHash: id,
    embeddingKey: `embed:${id}`,
    status: "ready",
    updatedAt: 1,
  };
}

function vector(values: number[]): EmbeddingRecord {
  return {
    key: "placeholder",
    modelKey: "model-a",
    dimensions: values.length,
    vector: Float32Array.from(values),
    createdAt: 1,
    lastReferencedAt: 1,
  };
}

function embeddingFor(id: string, values: number[]): EmbeddingRecord {
  return { ...vector(values), key: `embed:${id}` };
}

function candidatesFor(keys: readonly string[]): SemanticQueryCandidate[] {
  return keys.map((mappingKey) => ({
    mappingKey,
    target: { kind: "open", tabId: Number(mappingKey.split(":")[1]), windowId: 1 },
    documentHash: mappingKey.split(":")[1]!,
  }));
}

const meta: SemanticIndexMeta = {
  ...EMPTY_SEMANTIC_INDEX_META,
  modelKey: "model-a",
  status: "complete",
  total: 3,
  ready: 3,
  updatedAt: 5,
};

beforeEach(async () => {
  await clearSemanticIndex();
  await writeSemanticIndexMeta(meta);
});

describe("quarantine and continue", () => {
  it("keeps the query working when one stored vector is unusable", async () => {
    const mappings = [mapping("k:1", "1"), mapping("k:2", "2"), mapping("k:3", "3")];
    await replaceSemanticWork(mappings, [], meta);
    await commitSemanticBatch(
      [
        embeddingFor("1", [1, 0, 0]),
        embeddingFor("2", [0, 0, 0]),
        embeddingFor("3", [1, 0, 0]),
      ],
      [],
      [],
      meta,
    );

    const response = await querySemanticTabs({
      query: "anything",
      candidates: candidatesFor(mappings.map((entry) => entry.mappingKey)),
      meta,
      config: {} as never,
      apiKey: "",
      expectedDimensions: DIMENSIONS,
      dependencies: { embedQuery: async () => Float32Array.from([1, 0, 0]) },
    });

    // The two usable tabs still rank; the corrupt one is skipped, not fatal.
    expect(response.quarantined).toBe(1);
    expect(response.results.map((result) => result.mappingKey)).toEqual(["k:1", "k:3"]);
    const after = await readSemanticTabRecords(mappings.map((entry) => entry.mappingKey));
    expect(after.find((entry) => entry.mappingKey === "k:2")).toMatchObject({
      status: "failed",
      errorCode: "invalid_record",
    });
    // The vector is deleted so the next reconcile re-embeds the document instead of
    // planning the same bad vector back to ready.
    expect((await getEmbeddingRecords(["embed:2"])).size).toBe(0);
    expect(await readSemanticIndexMeta()).toMatchObject({ failed: 1, ready: 2, lastErrorCode: "invalid_record" });
  });

  it("quarantines a vector that is not unit length or not finite", async () => {
    const mappings = [mapping("k:1", "1"), mapping("k:2", "2")];
    await replaceSemanticWork(mappings, [], meta);
    await commitSemanticBatch(
      [embeddingFor("1", [1, 0, 0]), embeddingFor("2", [5, 0, 0])],
      [],
      [],
      meta,
    );
    const quarantined = vi.fn(async () => 1);
    const response = await querySemanticTabs({
      query: "anything",
      candidates: candidatesFor(["k:1", "k:2"]),
      meta,
      config: {} as never,
      apiKey: "",
      expectedDimensions: DIMENSIONS,
      dependencies: {
        embedQuery: async () => Float32Array.from([1, 0, 0]),
        quarantineMappings: quarantined,
      },
    });
    expect(quarantined).toHaveBeenCalledWith(["k:2"], "invalid_record");
    expect(response.results.map((result) => result.mappingKey)).toEqual(["k:1"]);
  });

  it("still fails hard when the index belongs to another model", async () => {
    const mappings = [mapping("k:1", "1")];
    await replaceSemanticWork(mappings, [], meta);
    await commitSemanticBatch(
      [{ ...embeddingFor("1", [1, 0, 0]), modelKey: "model-b" }],
      [],
      [],
      meta,
    );
    // No subset of another model's vectors is valid in this space, so this is not a
    // per-record problem and must not be quarantined away.
    await expect(querySemanticTabs({
      query: "anything",
      candidates: candidatesFor(["k:1"]),
      meta,
      config: {} as never,
      apiKey: "",
      expectedDimensions: DIMENSIONS,
      dependencies: { embedQuery: async () => Float32Array.from([1, 0, 0]) },
    })).rejects.toThrow(/incompatible with the current provider/i);
  });

  it("names dimension drift as a configuration problem", async () => {
    const mappings = [mapping("k:1", "1")];
    await replaceSemanticWork(mappings, [], meta);
    await commitSemanticBatch([embeddingFor("1", [1, 0, 0])], [], [], meta);
    const error = await querySemanticTabs({
      query: "anything",
      candidates: candidatesFor(["k:1"]),
      meta,
      config: {} as never,
      apiKey: "",
      expectedDimensions: DIMENSIONS,
      dependencies: { embedQuery: async () => Float32Array.from([1, 0, 0, 0, 0]) },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SemanticDimensionDriftError);
    expect(error).toMatchObject({ expected: 3, received: 5 });
    expect((error as Error).message).toContain("rebuild");
    void quarantineSemanticMappings;
  });
});
