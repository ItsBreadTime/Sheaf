import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleEmbeddingClient } from "../src/search/embedding-client";
import {
  EmbeddingRedirectError,
  retryAfterMs,
  safeEmbeddingErrorCode,
  withEmbeddingRetry,
} from "../src/search/embedding-errors";
import { ProviderHttpError } from "../src/provider/openai-chat-completions";
import { DEFAULT_EMBEDDING_CONFIG } from "../src/storage/search";
import { createFakeEmbeddingProvider } from "./helpers/fake-embedding-provider";

const config = {
  ...DEFAULT_EMBEDDING_CONFIG,
  origin: "https://embeddings.example",
  model: "test-embedding-model",
  timeoutMs: 5_000,
};

describe("embedding failure vocabulary", () => {
  it("classifies each provider answer once, for both call paths", () => {
    expect(safeEmbeddingErrorCode(new ProviderHttpError(401, "x"))).toBe("authentication");
    expect(safeEmbeddingErrorCode(new ProviderHttpError(402, "x"))).toBe("insufficient_balance");
    expect(safeEmbeddingErrorCode(new ProviderHttpError(429, "x"))).toBe("rate_limited");
    expect(safeEmbeddingErrorCode(new ProviderHttpError(503, "x"))).toBe("provider_unavailable");
    expect(safeEmbeddingErrorCode(new ProviderHttpError(400, "x"))).toBe("provider_rejected");
    expect(safeEmbeddingErrorCode(new EmbeddingRedirectError(301, null))).toBe("redirected");
    expect(safeEmbeddingErrorCode(new TypeError("fetch failed"))).toBe("network");
    expect(safeEmbeddingErrorCode(new Error("weird"))).toBe("invalid_response");
  });

  it("reads Retry-After in both of its forms and ignores nonsense", () => {
    expect(retryAfterMs(new ProviderHttpError(429, "x", "2"))).toBe(2_000);
    expect(retryAfterMs(new ProviderHttpError(429, "x", "0"))).toBe(0);
    expect(retryAfterMs(new ProviderHttpError(429, "x", null))).toBeNull();
    expect(retryAfterMs(new ProviderHttpError(429, "x", "soon"))).toBeNull();
    const at = Date.parse("2026-09-23T00:00:10Z");
    expect(retryAfterMs(new ProviderHttpError(429, "x", "Wed, 23 Sep 2026 00:00:10 GMT"), at - 4_000)).toBe(4_000);
    // A provider cannot ask for an unbounded pause.
    expect(retryAfterMs(new ProviderHttpError(429, "x", "99999"))).toBe(120_000);
  });
});

describe("interactive query retry", () => {
  it("retries a rate limit the provider asked for and then succeeds", async () => {
    const provider = createFakeEmbeddingProvider({
      dimensions: 4,
      failures: [{ kind: "http_status", status: 429, retryAfter: "1", times: 1 }],
    });
    const client = new OpenAICompatibleEmbeddingClient(provider.fetchImpl);
    const waits: number[] = [];
    const vector = await withEmbeddingRetry(
      () => client.embedQuery("remembered thing", config, "key"),
      { attempts: 3, maxAddedWaitMs: 5_000, sleep: async (ms) => { waits.push(ms); } },
    );
    expect(vector).toHaveLength(4);
    expect(provider.requests).toHaveLength(2);
    // The provider's own `Retry-After` is honoured exactly, not jittered below.
    expect(waits).toEqual([1_000]);
  });

  it("does not retry a failure that a retry cannot fix", async () => {
    const provider = createFakeEmbeddingProvider({
      dimensions: 4,
      failures: [{ kind: "http_status", status: 401, times: "always" }],
    });
    const client = new OpenAICompatibleEmbeddingClient(provider.fetchImpl);
    const attempts: number[] = [];
    await expect(withEmbeddingRetry(
      (attempt) => {
        attempts.push(attempt);
        return client.embedQuery("anything", config, "key");
      },
      { attempts: 3, maxAddedWaitMs: 5_000, sleep: async () => undefined },
    )).rejects.toMatchObject({ status: 401 });
    expect(attempts).toEqual([1]);
  });

  it("gives up rather than stalling the popup past its wait budget", async () => {
    const provider = createFakeEmbeddingProvider({
      dimensions: 4,
      failures: [{ kind: "http_status", status: 503, retryAfter: "30", times: "always" }],
    });
    const client = new OpenAICompatibleEmbeddingClient(provider.fetchImpl);
    const waits: number[] = [];
    await expect(withEmbeddingRetry(
      () => client.embedQuery("anything", config, "key"),
      { attempts: 3, maxAddedWaitMs: 1_500, sleep: async (ms) => { waits.push(ms); } },
    )).rejects.toMatchObject({ status: 503 });
    // One request, no wait: 30 s exceeds the interactive budget entirely.
    expect(provider.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("backs off with jitter when the provider named no delay", async () => {
    const provider = createFakeEmbeddingProvider({
      dimensions: 4,
      failures: [{ kind: "network_error", times: 2 }],
    });
    const client = new OpenAICompatibleEmbeddingClient(provider.fetchImpl);
    const waits: number[] = [];
    await withEmbeddingRetry(
      () => client.embedQuery("anything", config, "key"),
      {
        attempts: 3,
        maxAddedWaitMs: 5_000,
        random: () => 1,
        sleep: async (ms) => { waits.push(ms); },
      },
    );
    expect(provider.requests).toHaveLength(3);
    expect(waits).toEqual([1_000, 2_000]);
  });
});

describe("provider compatibility hardening", () => {
  it("names a redirect instead of reporting a network failure", async () => {
    const provider = createFakeEmbeddingProvider({
      dimensions: 4,
      failures: [{ kind: "redirect", times: 1 }],
    });
    const client = new OpenAICompatibleEmbeddingClient(provider.fetchImpl);
    const error = await client.embedQuery("anything", config, "key").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EmbeddingRedirectError);
    expect(error).toMatchObject({ status: 302, location: "https://canonical.example/v1/embeddings" });
    expect(safeEmbeddingErrorCode(error)).toBe("redirected");
  });

  it("reports whether the provider honoured the requested dimensions", async () => {
    const provider = createFakeEmbeddingProvider({ dimensions: 8 });
    const client = new OpenAICompatibleEmbeddingClient(provider.fetchImpl);
    const honored = await client.test({ ...config, dimensions: 8 }, "key");
    expect(honored).toMatchObject({ dimensions: 8, dimensionsHonored: true, normalized: false });
    // A provider that ignores `dimensions` is what the flag exists to catch.
    const ignored = await client.test({ ...config, dimensions: 1_536 }, "key");
    expect(ignored).toMatchObject({ dimensions: 8, dimensionsHonored: false });
    void vi;
  });
});
