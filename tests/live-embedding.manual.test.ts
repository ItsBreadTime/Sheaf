import { describe, expect, it } from "vitest";
import { OpenAICompatibleEmbeddingClient } from "../src/search/embedding-client";
import { DEFAULT_EMBEDDING_CONFIG } from "../src/storage/search";

const apiKey = process.env.AI_GATEWAY_API_KEY;

describe.skipIf(!apiKey)("live Vercel AI Gateway embeddings", () => {
  it("supports batched documents and an instruction-formatted Qwen3 query", async () => {
    const client = new OpenAICompatibleEmbeddingClient();
    const result = await client.test({
      ...DEFAULT_EMBEDDING_CONFIG,
      origin: "https://ai-gateway.vercel.sh",
      endpointPath: "/v1/embeddings",
      model: "alibaba/qwen3-embedding-8b",
      timeoutMs: 120_000,
    }, apiKey!);
    expect(result.dimensions).toBeGreaterThan(0);
    expect(result.batchInputSupported).toBe(true);
    expect(result.queryDocumentCompatible).toBe(true);
  }, 180_000);
});
