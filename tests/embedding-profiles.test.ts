import { describe, expect, it } from "vitest";
import { OpenAICompatibleEmbeddingClient } from "../src/search/embedding-client";
import {
  migrateEmbeddingExtraBody,
  normalizeEmbeddingConfig,
} from "../src/search/embedding-config";
import {
  detectedEmbeddingProfileId,
  embeddingModelProfile,
  EMBEDDING_PROFILE_IDS,
} from "../src/search/model-profiles";
import { computeSemanticCompatibilityKey } from "../src/search/semantic-document";
import type { EmbeddingConfig } from "../src/shared/search-types";
import { DEFAULT_EMBEDDING_CONFIG } from "../src/storage/search";
import { DEFAULT_PRIVACY_SETTINGS } from "../src/storage/organizer-state";
import { createFakeEmbeddingProvider } from "./helpers/fake-embedding-provider";

function config(model: string, rest: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    origin: "https://embeddings.example",
    model,
    ...rest,
  };
}

describe("embedding model profiles", () => {
  it("auto-detects a profile per model family", () => {
    expect(detectedEmbeddingProfileId("qwen3-embedding-8b")).toBe("qwen3");
    expect(detectedEmbeddingProfileId("multilingual-e5-large")).toBe("e5");
    expect(detectedEmbeddingProfileId("embed-english-v3.0")).toBe("cohere");
    expect(detectedEmbeddingProfileId("voyage-3-lite")).toBe("voyage");
    expect(detectedEmbeddingProfileId("gemini-embedding-001")).toBe("gemini");
    expect(detectedEmbeddingProfileId("text-embedding-3-large")).toBe("none");
    expect(detectedEmbeddingProfileId("acme-internal-embed")).toBe("none");
  });

  it("lets an explicit choice override detection in both directions", () => {
    // The reason the override exists: a fine-tune whose name matches nothing would
    // otherwise get the wrong instruction, the wrong task fields, and the wrong
    // tail distance at once.
    expect(embeddingModelProfile("acme-internal-embed", "qwen3").formatQuery("x")).toContain("Instruct:");
    expect(embeddingModelProfile("qwen3-embedding-8b", "none").formatQuery("x")).toBe("x");
    expect(embeddingModelProfile("qwen3-embedding-8b", "e5").formatDocument("x")).toBe("passage: x");
    expect(EMBEDDING_PROFILE_IDS.every((id) => embeddingModelProfile("anything", id).id === (id === "auto" ? "none" : id)))
      .toBe(true);
  });

  it("sends the task field the provider requires, and the opposite one per call", async () => {
    const cases = [
      { model: "embed-english-v3.0", profile: "auto" as const, document: { input_type: "search_document" }, query: { input_type: "search_query" } },
      { model: "voyage-3-lite", profile: "auto" as const, document: { input_type: "document" }, query: { input_type: "query" } },
      { model: "gemini-embedding-001", profile: "auto" as const, document: { taskType: "RETRIEVAL_DOCUMENT" }, query: { taskType: "RETRIEVAL_QUERY" } },
    ];
    for (const testCase of cases) {
      const provider = createFakeEmbeddingProvider({ dimensions: 4 });
      const client = new OpenAICompatibleEmbeddingClient(provider.fetchImpl);
      const active = config(testCase.model, { modelProfile: testCase.profile });
      await client.embedDocuments(["Title: One"], active, "key");
      await client.embedQuery("anything", active, "key");
      expect(provider.requests[0]?.body).toMatchObject(testCase.document);
      expect(provider.requests[1]?.body).toMatchObject(testCase.query);
      // The whole point: one global value could not have produced both.
      expect(Object.values(testCase.document)).not.toEqual(Object.values(testCase.query));
    }
  });

  it("keeps the text-prefix profiles free of task fields", async () => {
    const provider = createFakeEmbeddingProvider({ dimensions: 4 });
    const client = new OpenAICompatibleEmbeddingClient(provider.fetchImpl);
    await client.embedDocuments(["Title: One"], config("qwen3-embedding-8b"), "key");
    await client.embedQuery("anything", config("qwen3-embedding-8b"), "key");
    expect(provider.requests[0]?.body).not.toHaveProperty("input_type");
    expect(provider.requests[1]?.body).not.toHaveProperty("taskType");
    expect(provider.requests[1]?.inputs[0]).toContain("Instruct:");
    expect(provider.requests[0]?.inputs[0]).toBe("Title: One");
  });

  it("rejects a task field in extra body only when the resolved profile owns it", () => {
    expect(() => normalizeEmbeddingConfig(config("embed-english-v3.0", { extraBody: { input_type: "search_query" } })))
      .toThrow(/profile sends a different value/i);
    expect(() => normalizeEmbeddingConfig(config("gemini-embedding-001", { extraBody: { taskType: "RETRIEVAL_QUERY" } })))
      .toThrow(/profile sends a different value/i);
    // A model with no task typing keeps accepting the field it always accepted.
    expect(normalizeEmbeddingConfig(config("text-embedding-3-large", { extraBody: { input_type: "query" } })).extraBody)
      .toEqual({ input_type: "query" });
    // Explicitly choosing a profile moves the ownership with it.
    expect(() => normalizeEmbeddingConfig(config("acme-embed", { modelProfile: "voyage", extraBody: { input_type: "query" } })))
      .toThrow(/profile sends a different value/i);
  });

  it("migrates a legacy task field out of extra body instead of rejecting the config", () => {
    const legacy = { input_type: "search_query", truncate: "END" };
    expect(migrateEmbeddingExtraBody(legacy, "embed-english-v3.0", "auto")).toEqual({ truncate: "END" });
    expect(migrateEmbeddingExtraBody(legacy, "text-embedding-3-large", "auto")).toEqual(legacy);
    // After migration the config validates, so an upgrade does not reset a working provider.
    const migrated = migrateEmbeddingExtraBody(legacy, "embed-english-v3.0", "auto");
    expect(normalizeEmbeddingConfig(config("embed-english-v3.0", { extraBody: migrated })).extraBody)
      .toEqual({ truncate: "END" });
  });

  it("changes the compatibility key only for an explicit profile", async () => {
    const baseline = await computeSemanticCompatibilityKey(config("qwen3-embedding-8b"), DEFAULT_PRIVACY_SETTINGS);
    expect(await computeSemanticCompatibilityKey(config("qwen3-embedding-8b"), DEFAULT_PRIVACY_SETTINGS))
      .toBe(baseline);
    // Auto is covered by modelProfileVersion, so an added override is the only
    // thing that may invalidate a user's index.
    expect(await computeSemanticCompatibilityKey(
      config("qwen3-embedding-8b", { modelProfile: "none" }),
      DEFAULT_PRIVACY_SETTINGS,
    )).not.toBe(baseline);
    expect(await computeSemanticCompatibilityKey(
      config("text-embedding-3-large"),
      DEFAULT_PRIVACY_SETTINGS,
    )).not.toBe(baseline);
  });

  it("normalizes an unknown profile id back to auto", () => {
    expect(normalizeEmbeddingConfig(config("m", { modelProfile: "nonsense" as never })).modelProfile).toBe("auto");
  });

  it("tests the provider with both call shapes", async () => {
    const provider = createFakeEmbeddingProvider({ dimensions: 6 });
    const client = new OpenAICompatibleEmbeddingClient(provider.fetchImpl);
    const result = await client.test(config("embed-multilingual-v3.0"), "key");
    expect(result.dimensions).toBe(6);
    expect(provider.requests.map((request) => request.body.input_type))
      .toEqual(["search_document", "search_query"]);
    expect(provider.remainingFailures()).toBe(0);
  });
});
