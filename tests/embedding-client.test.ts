import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleEmbeddingClient } from "../src/search/embedding-client";
import { DEFAULT_EMBEDDING_CONFIG } from "../src/storage/search";

const config = { ...DEFAULT_EMBEDDING_CONFIG, origin: "https://embed.example", model: "text-embedding-test", dimensions: 3 };

describe("OpenAI-compatible embedding client", () => {
  it("applies the Qwen3 retrieval instruction only to queries", async () => {
    const inputs: string[][] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input as string[];
      inputs.push(input);
      return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }), { status: 200 });
    });
    const client = new OpenAICompatibleEmbeddingClient(fetchImpl as typeof fetch);
    const qwen = { ...config, model: "alibaba/qwen3-embedding-8b" };
    await client.embedDocuments(["Title: Toy shelf"], qwen, "");
    await client.embedQuery("that toy image task", qwen, "");
    expect(inputs[0]).toEqual(["Title: Toy shelf"]);
    expect(inputs[1]?.[0]).toMatch(/^Instruct: Retrieve the open or stashed browser tab.*\nQuery:that toy image task$/);
  });

  it("orders indexed vectors and preserves adapter-owned request fields", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "text-embedding-test", input: ["one", "two"], dimensions: 3, encoding_format: "float" });
      return new Response(JSON.stringify({ data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ] }), { status: 200 });
    });
    const vectors = await new OpenAICompatibleEmbeddingClient(fetchImpl as typeof fetch).embedDocuments(["one", "two"], config, "secret");
    expect(vectors.map((vector) => [...vector])).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends OpenRouter provider preferences only to OpenRouter embedding endpoints", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), { status: 200 });
    });
    const openRouter = {
      zdr: true,
      order: ["openai", "azure"],
      sort: "throughput" as const,
      allowFallbacks: false,
      dataCollection: "deny" as const,
      requireParameters: true,
    };
    const client = new OpenAICompatibleEmbeddingClient(fetchImpl as typeof fetch);
    await client.embedQuery("one", { ...config, origin: "https://openrouter.ai", openRouter }, "");
    await client.embedQuery("two", { ...config, openRouter }, "");
    expect(bodies[0]?.provider).toEqual({
      zdr: true,
      order: ["openai", "azure"],
      sort: "throughput",
      allow_fallbacks: false,
      data_collection: "deny",
      require_parameters: true,
    });
    expect(bodies[1]).not.toHaveProperty("provider");
  });

  it.each([
    [{ data: [{ index: 0, embedding: [] }] }, "empty"],
    [{ data: [{ index: 0, embedding: [0, 0, 0] }] }, "entirely zero"],
    [{ data: [{ index: 0, embedding: [1, 2] }] }, "dimension mismatch"],
    [{ data: [{ index: 1, embedding: [1, 0, 0] }] }, "indices"],
    [{ data: [{ index: 0, embedding: [1e300, 1, 1] }] }, "overflows"],
    [{ data: [{ index: 0, embedding: [1e-300, 0, 0] }] }, "becomes entirely zero"],
  ])("rejects invalid response %#", async (body, message) => {
    const client = new OpenAICompatibleEmbeddingClient(async () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(client.embedQuery("query", config, "")).rejects.toThrow(message);
  });

  it("does not expose provider response bodies in HTTP errors", async () => {
    const client = new OpenAICompatibleEmbeddingClient(async () => new Response("echoed private query", { status: 401 }));
    await expect(client.embedQuery("private query", config, "bad-key")).rejects.toThrow("HTTP 401.");
    await expect(client.embedQuery("private query", config, "bad-key")).rejects.not.toThrow("echoed private query");
  });

  it("rejects oversized provider responses before parsing them", async () => {
    const client = new OpenAICompatibleEmbeddingClient(async () => new Response("x".repeat(4_000_001), { status: 200 }));
    await expect(client.embedQuery("query", config, "")).rejects.toThrow("4000000-byte limit");
  });

  it("caps batch input count before making a provider request", async () => {
    const fetchImpl = vi.fn();
    const client = new OpenAICompatibleEmbeddingClient(fetchImpl as typeof fetch);
    await expect(client.embedDocuments(Array.from({ length: 33 }, (_, index) => `doc ${index}`), config, ""))
      .rejects.toThrow("at most 32 inputs");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps individual embedding input characters and UTF-8 bytes before fetch", async () => {
    const fetchImpl = vi.fn();
    const client = new OpenAICompatibleEmbeddingClient(fetchImpl as typeof fetch);
    await expect(client.embedQuery("x".repeat(8_001), config, ""))
      .rejects.toThrow("at most 8000 characters");
    await expect(client.embedQuery("€".repeat(6_000), config, ""))
      .rejects.toThrow("at most 16000 UTF-8 bytes");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps the serialized embedding request before fetch", async () => {
    const fetchImpl = vi.fn();
    const client = new OpenAICompatibleEmbeddingClient(fetchImpl as typeof fetch);
    await expect(client.embedDocuments(Array.from({ length: 32 }, () => "x".repeat(8_000)), config, ""))
      .rejects.toThrow("256000-byte limit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps inferred vector dimensions even when no dimensions were requested", async () => {
    const body = { data: [{ index: 0, embedding: Array.from({ length: 65_537 }, () => 1) }] };
    const client = new OpenAICompatibleEmbeddingClient(async () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(client.embedQuery("query", { ...config, dimensions: null }, "")).rejects.toThrow("65536-dimension limit");
  });

  it("classifies external cancellation", async () => {
    const controller = new AbortController();
    const client = new OpenAICompatibleEmbeddingClient((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const pending = client.embedQuery("query", config, "", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("tests batch and query compatibility without retaining vectors", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const inputs = JSON.parse(String(init?.body)).input as string[];
      return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1, index + 1, 2] })) }), { status: 200 });
    });
    const result = await new OpenAICompatibleEmbeddingClient(fetchImpl as typeof fetch).test({ ...config, dimensions: null }, "");
    expect(result).toMatchObject({ model: "text-embedding-test", dimensions: 3, batchInputSupported: true, queryDocumentCompatible: true, retentionStatus: "not_verified" });
    // Two calls rather than one batched call: the test has to exercise both call
    // shapes, because a profile that types its tasks (Cohere, Voyage, Gemini) sends
    // a different body for documents and for queries.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)) as { input: string[] });
    expect(bodies[0]?.input).toHaveLength(2);
    expect(bodies[1]?.input).toHaveLength(1);
  });
});
