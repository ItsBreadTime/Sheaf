import { describe, expect, it, vi } from "vitest";
import {
  createSemanticQueryCandidates,
  querySemanticTabs,
  rankSemanticMappings,
  semanticQueryMaxTailDistance,
  semanticQueryRequiresOutlier,
  topScoreStandsOut,
} from "../src/search/semantic-query";
import type {
  EmbeddingRecord,
  SemanticIndexMeta,
  SemanticTabRecord,
} from "../src/shared/semantic-index-types";
import { DEFAULT_EMBEDDING_CONFIG } from "../src/storage/search";
import { DEFAULT_PRIVACY_SETTINGS } from "../src/storage/organizer-state";

const meta: SemanticIndexMeta = {
  id: "current",
  modelKey: "model-key",
  status: "complete",
  total: 3,
  ready: 3,
  pending: 0,
  excluded: 0,
  failed: 0,
  lastCompletedBatchAt: 1,
  lastErrorCode: null,
  cacheHits: 0,
  cacheMisses: 3,
  updatedAt: 1,
};

const mapping = (tabId: number, embeddingKey: string): SemanticTabRecord => ({
  mappingKey: `window:7:tab:${tabId}`,
  target: { kind: "open", tabId, windowId: 7 },
  documentHash: `hash-${tabId}`,
  embeddingKey,
  status: "ready",
  updatedAt: 1,
});

const embedding = (key: string, vector: number[], modelKey = "model-key"): EmbeddingRecord => ({
  key,
  modelKey,
  dimensions: vector.length,
  vector: Float32Array.from(vector),
  createdAt: 1,
  lastReferencedAt: 1,
});

describe("semantic query retrieval", () => {
  it("uses the tight tail only for Qwen3 embedding models", () => {
    expect(semanticQueryMaxTailDistance("alibaba/qwen3-embedding-8b")).toBe(0.06);
    expect(semanticQueryMaxTailDistance("text-embedding-3-small")).toBe(0.14);
    expect(semanticQueryMaxTailDistance("multilingual-e5-large")).toBe(0.14);
    // An explicit profile moves the cutoff with the instruction, so a fine-tune that
    // matches no pattern can be told which convention it actually follows.
    expect(semanticQueryMaxTailDistance("acme-internal-embed", "qwen3")).toBe(0.06);
    expect(semanticQueryMaxTailDistance("qwen3-embedding-8b", "none")).toBe(0.14);
  });

  it("keeps the Qwen3 floor and gates every other profile on standing out", () => {
    expect(semanticQueryRequiresOutlier("alibaba/qwen3-embedding-8b")).toBe(false);
    expect(semanticQueryRequiresOutlier("acme-internal-embed", "qwen3")).toBe(false);
    expect(semanticQueryRequiresOutlier("multilingual-e5-large")).toBe(true);
    expect(semanticQueryRequiresOutlier("text-embedding-3-small")).toBe(true);
  });

  it("detects a top score that stands out from the query's own distribution", () => {
    // E5-like: everything is similar, nothing is relevant.
    const flat = [0.78, 0.79, 0.8, 0.8, 0.81, 0.81, 0.82, 0.82, 0.83, 0.84];
    expect(topScoreStandsOut(flat)).toBe(false);
    expect(topScoreStandsOut([...flat.slice(1), 0.95])).toBe(true);
    // A cluster of related tabs does not hide its own top result.
    expect(topScoreStandsOut([0.1, 0.11, 0.12, 0.12, 0.13, 0.13, 0.14, 0.55, 0.57, 0.6])).toBe(true);
    // Too few scores, or no spread, cannot be judged and so do not block.
    expect(topScoreStandsOut([0.8, 0.81, 0.82])).toBe(true);
    expect(topScoreStandsOut(Array(12).fill(0.5))).toBe(true);
  });

  it("drops a no-standout ranking only when the outlier gate is on", () => {
    const vectors = Array.from({ length: 10 }, (_, index) => {
      const angle = 0.6 + index * 0.005;
      return [Math.cos(angle), Math.sin(angle)];
    });
    const mappings = vectors.map((_, index) => mapping(index + 1, `key-${index}`));
    const embeddings = new Map(vectors.map((vector, index) => [`key-${index}`, embedding(`key-${index}`, vector)]));
    const candidates = mappings.map((item) => ({ mappingKey: item.mappingKey, target: item.target, documentHash: item.documentHash }));
    const query = Float32Array.from([1, 0]);
    expect(rankSemanticMappings(query, mappings, embeddings, candidates, 10, 0.14, false).length).toBeGreaterThan(0);
    expect(rankSemanticMappings(query, mappings, embeddings, candidates, 10, 0.14, true)).toEqual([]);
  });

  it("wires the model-specific tail through the production query path", async () => {
    const mappings = [mapping(1, "one"), mapping(2, "two")];
    const candidates = mappings.map((item) => ({
      mappingKey: item.mappingKey,
      target: item.target,
      documentHash: item.documentHash,
    }));
    const vectors = new Map([
      ["one", embedding("one", [1, 0])],
      ["two", embedding("two", [0.92, 0.392])],
    ]);
    const run = (model: string) => querySemanticTabs({
      query: "related",
      candidates,
      meta,
      config: { ...DEFAULT_EMBEDDING_CONFIG, model, dimensions: 2 },
      apiKey: "",
      expectedDimensions: 2,
      dependencies: {
        embedQuery: async () => Float32Array.from([1, 0]),
        readMappings: async () => mappings,
        readEmbeddings: async () => vectors,
      },
    });
    expect((await run("alibaba/qwen3-embedding-8b")).results).toHaveLength(1);
    expect((await run("text-embedding-3-small")).results).toHaveLength(2);
  });

  it("ranks only live candidate mappings and removes the weak tail", () => {
    const mappings = [mapping(1, "one"), mapping(2, "two"), mapping(3, "three"), mapping(4, "four")];
    const embeddings = new Map([
      ["one", embedding("one", [1, 0])],
      ["two", embedding("two", [0.95, 0.31])],
      ["three", embedding("three", [0, 1])],
      ["four", embedding("four", [0.93, 0.367])],
    ]);
    expect(rankSemanticMappings(
      Float32Array.from([1, 0]),
      mappings,
      embeddings,
      [
        { mappingKey: "window:7:tab:1", target: { kind: "open", tabId: 1, windowId: 7 }, documentHash: "hash-1" },
        { mappingKey: "window:7:tab:2", target: { kind: "open", tabId: 2, windowId: 7 }, documentHash: "hash-2" },
        { mappingKey: "window:7:tab:4", target: { kind: "open", tabId: 4, windowId: 7 }, documentHash: "hash-4" },
      ],
      10,
      0.06,
    ).map((result) => result.target.kind === "open" ? result.target.tabId : -1)).toEqual([1, 2]);
  });

  it("embeds one query, validates model compatibility, and reports latency", async () => {
    const embedQuery = vi.fn(async () => Float32Array.from([1, 0]));
    let clock = 10;
    const result = await querySemanticTabs({
      query: "  related idea  ",
      candidates: [{ mappingKey: "window:7:tab:1", target: { kind: "open", tabId: 1, windowId: 7 }, documentHash: "hash-1" }],
      meta,
      config: { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1", dimensions: 2 },
      apiKey: "secret",
      expectedDimensions: 2,
      dependencies: {
        embedQuery,
        readMappings: async () => [mapping(1, "one"), mapping(2, "two")],
        readEmbeddings: async () => new Map([["one", embedding("one", [1, 0])]]),
        now: () => (clock += 15),
      },
    });
    expect(embedQuery).toHaveBeenCalledWith(
      "related idea",
      expect.objectContaining({ model: "embed-v1" }),
      "secret",
      undefined,
    );
    expect(result).toMatchObject({ indexedCandidates: 1, latencyMs: 15 });
    expect(result.results[0]).toMatchObject({ target: { kind: "open", tabId: 1 }, score: 1 });
  });

  it("redacts identifiers in the query before it leaves the device", async () => {
    const embedQuery = vi.fn(async () => Float32Array.from([1, 0]));
    await querySemanticTabs({
      query: "notes for 550e8400-e29b-41d4-a716-446655440000 from boss@acme.example",
      candidates: [{ mappingKey: "window:7:tab:1", target: { kind: "open", tabId: 1, windowId: 7 }, documentHash: "hash-1" }],
      meta,
      config: { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1", dimensions: 2 },
      apiKey: "secret",
      expectedDimensions: 2,
      dependencies: {
        embedQuery,
        readMappings: async () => [mapping(1, "one")],
        readEmbeddings: async () => new Map([["one", embedding("one", [1, 0])]]),
      },
    });
    expect(embedQuery).toHaveBeenCalledWith(
      "notes for :uuid from :email",
      expect.objectContaining({ model: "embed-v1" }),
      "secret",
      undefined,
    );
  });

  it("does not buy a query embedding when ready mappings have lost their vectors", async () => {
    const embedQuery = vi.fn(async () => Float32Array.from([1, 0]));
    const readMappings = vi.fn(async () => [mapping(1, "missing")]);
    const result = await querySemanticTabs({
      query: "idea",
      candidates: [{ mappingKey: "window:7:tab:1", target: { kind: "open", tabId: 1, windowId: 7 }, documentHash: "hash-1" }],
      meta,
      config: { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1" },
      apiKey: "",
      expectedDimensions: 2,
      dependencies: {
        embedQuery,
        readMappings,
        readEmbeddings: async () => new Map(),
      },
    });
    expect(result).toMatchObject({ indexedCandidates: 0, results: [] });
    expect(readMappings).toHaveBeenCalledWith(["window:7:tab:1"], 3);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it("forwards cancellation and rejects mismatched cached model keys", async () => {
    const controller = new AbortController();
    const embedQuery = vi.fn(async () => Float32Array.from([1, 0]));
    await expect(querySemanticTabs({
      query: "idea",
      candidates: [{ mappingKey: "window:7:tab:1", target: { kind: "open", tabId: 1, windowId: 7 }, documentHash: "hash-1" }],
      meta,
      config: { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1" },
      apiKey: "",
      expectedDimensions: 2,
      signal: controller.signal,
      dependencies: {
        embedQuery,
        readMappings: async () => [mapping(1, "one")],
        readEmbeddings: async () => new Map([["one", embedding("one", [1, 0], "old-model")]]),
      },
    })).rejects.toThrow("incompatible");
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it("ignores stale document hashes without sending a query", async () => {
    const embedQuery = vi.fn(async () => Float32Array.from([1, 0]));
    const result = await querySemanticTabs({
      query: "idea",
      candidates: [{ mappingKey: "window:7:tab:1", target: { kind: "open", tabId: 1, windowId: 7 }, documentHash: "new-hash" }],
      meta,
      config: { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1" },
      apiKey: "",
      expectedDimensions: 2,
      dependencies: {
        embedQuery,
        readMappings: async () => [mapping(1, "one")],
        readEmbeddings: async () => new Map(),
      },
    });
    expect(result).toMatchObject({ indexedCandidates: 0, results: [] });
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it("rejects query dimension drift before ranking, naming the rebuild", async () => {
    // A dimension change is a configuration problem with a known remedy, so it gets
    // its own error type rather than the generic incompatibility message.
    await expect(querySemanticTabs({
      query: "idea",
      candidates: [{ mappingKey: "window:7:tab:1", target: { kind: "open", tabId: 1, windowId: 7 }, documentHash: "hash-1" }],
      meta,
      config: { ...DEFAULT_EMBEDDING_CONFIG, model: "embed-v1" },
      apiKey: "",
      expectedDimensions: 2,
      dependencies: {
        embedQuery: async () => Float32Array.from([1, 0, 0]),
        readMappings: async () => [mapping(1, "one")],
        readEmbeddings: async () => new Map([["one", embedding("one", [1, 0])]]),
      },
    })).rejects.toThrow("rebuild the semantic index");
  });
});

describe("semantic query candidates", () => {
  const source = (tabId: number, title: string) => ({
    mappingKey: `window:7:tab:${tabId}`,
    target: { kind: "open" as const, tabId, windowId: 7 },
    title,
    url: `https://example.com/${tabId}`,
    groupName: null,
  });

  it("hashes only the documents that changed since the previous query", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const first = await createSemanticQueryCandidates([source(1, "Alpha"), source(2, "Beta")], DEFAULT_PRIVACY_SETTINGS);
      expect(digest).toHaveBeenCalledTimes(2);
      const second = await createSemanticQueryCandidates([source(1, "Alpha"), source(2, "Gamma")], DEFAULT_PRIVACY_SETTINGS);
      expect(digest).toHaveBeenCalledTimes(3);
      expect(second[0]).toEqual(first[0]);
      expect(second[1]!.documentHash).not.toBe(first[1]!.documentHash);
      await createSemanticQueryCandidates([source(1, "Alpha")], { ...DEFAULT_PRIVACY_SETTINGS, level: 1 });
      expect(digest).toHaveBeenCalledTimes(4);
    } finally {
      digest.mockRestore();
    }
  });
});
