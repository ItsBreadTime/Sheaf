import { describe, expect, it, vi } from "vitest";
import { testProviderConnection } from "../src/provider/connection-test";
import { requestChatCompletion } from "../src/provider/openai-chat-completions";
import { describeProviderHttpError, providerErrorDetail } from "../src/provider/provider-errors";
import type { OpenAICompatibleConfig } from "../src/shared/organizer-types";

function config(): OpenAICompatibleConfig {
  return {
    origin: "https://api.example.com",
    endpointPath: "/v1/chat/completions",
    model: "example-model",
    customHeaders: {},
    extraBody: {},
    temperature: 0.2,
    reasoningEffort: "low",
    manualStreamingEnabled: false,
  };
}

function request(fetchImpl: typeof fetch): Promise<string> {
  return requestChatCompletion({
    config: config(),
    apiKey: "sk-test",
    mode: "json_schema",
    requestJson: "{}",
    deadlineAt: Date.now() + 5_000,
  }, fetchImpl);
}

describe("provider error copy", () => {
  it("keeps only the provider's own message and masks keys", () => {
    expect(providerErrorDetail(JSON.stringify({
      error: { message: "Incorrect API key provided: sk-abc*****wxyz.", type: "invalid_request_error" },
    }))).toBe("Incorrect API key provided: [key].");
    expect(providerErrorDetail("<html><head><title>502 Bad Gateway</title></head></html>")).toBeNull();
    expect(providerErrorDetail("x".repeat(500))).toBeNull();
    expect(providerErrorDetail(JSON.stringify({ message: "m".repeat(400) }))?.length).toBe(200);
  });

  it("never shows a raw HTML body and names the fix", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }));
    await expect(request(fetchImpl as typeof fetch)).rejects.toThrow(
      "api.example.com had a server error (HTTP 502). Try again in a minute.",
    );
  });

  it("explains authentication failures without echoing the body", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "Incorrect API key provided: sk-abc*****wxyz" } }),
      { status: 401 },
    ));
    const error = await request(fetchImpl as typeof fetch).then(() => null, (caught: unknown) => caught as Error);
    expect(error?.message).toMatch(/^The provider rejected the API key \(HTTP 401\)\. Check the key in Settings/);
    expect(error?.message).not.toContain("sk-");
  });

  it("passes Retry-After through to rate-limit copy", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "12" } }));
    await expect(request(fetchImpl as typeof fetch)).rejects.toThrow("Try again in 12 seconds.");
  });

  it("names the model on a 404 and quotes the provider's reason", () => {
    expect(describeProviderHttpError({
      status: 404,
      endpointUrl: "https://api.example.com/v1/chat/completions",
      model: "gpt-x",
      detail: "The model `gpt-x` does not exist",
      retryAfter: null,
    })).toBe(
      "The provider couldn't find model “gpt-x” or the endpoint path (HTTP 404). Check both in Settings → Providers → Organizer provider. The provider said: “The model `gpt-x` does not exist”",
    );
  });

  it("replaces a browser network failure with a reachable host and remedy", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(request(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "Couldn't reach api.example.com. Check your connection or VPN",
    );
  });
});

describe("connection test", () => {
  it("stops after one request when the failure is not about output format", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(testProviderConnection({
      config: config(),
      apiKey: "bad",
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow(/^The provider rejected the API key \(HTTP 401\)/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("stops before any request when the origin is not a URL", async () => {
    const fetchImpl = vi.fn();
    await expect(testProviderConnection({
      config: { ...config(), origin: "api.example.com" },
      apiKey: "key",
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow("Provider origin must be a full URL, like https://api.openai.com.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still falls back across output modes on a format rejection", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "response_format is not supported" } }),
      { status: 400 },
    ));
    await expect(testProviderConnection({
      config: config(),
      apiKey: "key",
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow(/^The provider answered, but none of its replies could be used as a tab plan/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
