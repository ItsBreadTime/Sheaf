import { describe, expect, it, vi } from "vitest";
import { testProviderConnection } from "../src/provider/connection-test";
import { generateValidatedProposal } from "../src/provider/generate-proposal";
import { deadlineExceededMessage, requestChatCompletion } from "../src/provider/openai-chat-completions";
import { computeProviderFingerprint } from "../src/provider/fingerprint";
import type {
  ImmutableRequestBundle,
  OpenAICompatibleConfig,
  ProviderCapabilities,
} from "../src/shared/organizer-types";

function config(): OpenAICompatibleConfig {
  return {
    origin: "https://api.example.com",
    endpointPath: "/v1/chat/completions",
    model: "example-model",
    customHeaders: { "x-provider": "secret-header" },
    extraBody: { seed: 7 },
    temperature: 0.2,
    reasoningEffort: "low",
    manualStreamingEnabled: false,
  };
}

function completion(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content } }] }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function requestBundle(): ImmutableRequestBundle {
  const approvedRequest = {
    schemaVersion: 1 as const,
    privacyLevel: 2 as const,
    existingGroupMetadataIncluded: false,
    inactivityPolicy: { generalSuggestionAfterHours: 24, lowValueSuggestionAfterHours: 6, closingRequiresManualReview: true as const },
    tabs: [
      {
        id: 1,
        title: "One",
        domain: "example.com",
        path: "/one",
        recencyBucket: "unknown" as const,
        isActive: true,
        isAudible: false,
      },
      {
        id: 2,
        title: "Two",
        domain: "example.org",
        path: "/two",
        recencyBucket: "unknown" as const,
        isActive: false,
        isAudible: false,
      },
    ],
  };
  const requestJson = JSON.stringify(approvedRequest, null, 2);
  return {
    approvedRequest,
    requestJson,
    submittedTabIds: [1, 2],
    ephemeralToBrowserTabId: { 1: 41, 2: 42 },
    excludedTabs: [],
    byteLength: new TextEncoder().encode(requestJson).byteLength,
  };
}

describe("Chat Completions adapter", () => {
  it("uses a provider-compatible schema and leaves duplicate enforcement to runtime validation", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format: { json_schema: { schema: unknown } };
      };
      expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain("uniqueItems");
      return completion('{"schemaVersion":1,"groups":[{"temporaryId":"g","title":"G","tabIds":[1,2]}],"untouchedTabIds":[],"lowValueTabIds":[]}');
    });

    await requestChatCompletion(
      {
        config: config(),
        apiKey: "",
        mode: "json_schema",
        requestJson: requestBundle().requestJson,
        deadlineAt: Date.now() + 10_000,
      },
      fetchImpl as typeof fetch,
    );
  });

  it("transmits the exact preview string as the user message and owns core fields", async () => {
    const bundle = requestBundle();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format: { type: string };
        stream: boolean;
        seed: number;
        reasoning_effort: string;
      };
      expect(body.messages[1]?.content).toBe(bundle.requestJson);
      expect(body.model).toBe("example-model");
      expect(body.stream).toBe(false);
      expect(body.response_format.type).toBe("json_schema");
      expect(body.seed).toBe(7);
      expect(body.reasoning_effort).toBe("low");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer api-secret");
      expect(headers.get("x-provider")).toBe("secret-header");
      return completion('{"schemaVersion":1,"groups":[{"temporaryId":"g","title":"G","tabIds":[1,2]}],"untouchedTabIds":[]}');
    });

    const content = await requestChatCompletion(
      {
        config: config(),
        apiKey: "api-secret",
        mode: "json_schema",
        requestJson: bundle.requestJson,
        deadlineAt: Date.now() + 10_000,
      },
      fetchImpl as typeof fetch,
    );
    expect(JSON.parse(content)).toMatchObject({ schemaVersion: 1 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends reasoning effort none as thinking disabled except to hosts that honor none", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completion('{"schemaVersion":1,"groups":[],"untouchedTabIds":[1,2]}');
    });
    const send = (overrides: Partial<OpenAICompatibleConfig>) => requestChatCompletion(
      {
        config: { ...config(), ...overrides },
        apiKey: "",
        mode: "json_schema",
        requestJson: requestBundle().requestJson,
        deadlineAt: Date.now() + 10_000,
      },
      fetchImpl as typeof fetch,
    );

    await send({ reasoningEffort: "none" });
    await send({ reasoningEffort: "low" });
    await send({ reasoningEffort: "none", origin: "https://api.openai.com" });
    await send({ reasoningEffort: "none", origin: "https://openrouter.ai" });
    await send({ reasoningEffort: "none", origin: "https://generativelanguage.googleapis.com" });
    await send({ reasoningEffort: "none", extraBody: { thinking: { type: "enabled" } } });

    expect(bodies.map((body) => [body.reasoning_effort, body.thinking])).toEqual([
      [undefined, { type: "disabled" }],
      ["low", undefined],
      ["none", undefined],
      ["none", undefined],
      ["none", undefined],
      [undefined, { type: "enabled" }],
    ]);
  });

  it("sends typed OpenRouter provider preferences only to OpenRouter", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completion('{"schemaVersion":1,"groups":[],"untouchedTabIds":[1,2]}');
    });
    const openRouter = {
      zdr: true,
      order: ["openai", "anthropic"],
      sort: "throughput" as const,
      allowFallbacks: false,
      dataCollection: "deny" as const,
      requireParameters: true,
    };
    for (const origin of ["https://openrouter.ai", "https://api.example.com"]) {
      await requestChatCompletion({
        config: { ...config(), origin, openRouter },
        apiKey: "",
        mode: "json_schema",
        requestJson: requestBundle().requestJson,
        deadlineAt: Date.now() + 10_000,
      }, fetchImpl as typeof fetch);
    }
    expect(bodies[0]?.provider).toEqual({
      zdr: true,
      order: ["openai", "anthropic"],
      sort: "throughput",
      allow_fallbacks: false,
      data_collection: "deny",
      require_parameters: true,
    });
    expect(bodies[1]).not.toHaveProperty("provider");
  });

  it("uses replacement organizer instructions inside the immutable safety envelope", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages[0]?.content).toContain("Prefer workstream groups over website groups.");
      expect(body.messages[0]?.content).toContain("IMMUTABLE CONSTRAINTS");
      expect(body.messages[0]?.content).toContain("Use only submitted tab IDs");
      return completion('{"schemaVersion":1,"groups":[],"untouchedTabIds":[1,2]}');
    });

    await requestChatCompletion(
      {
        config: config(),
        apiKey: "",
        mode: "json_schema",
        requestJson: requestBundle().requestJson,
        organizerPrompt: "Prefer workstream groups over website groups.",
        deadlineAt: Date.now() + 10_000,
      },
      fetchImpl as typeof fetch,
    );
  });

  it("reports provider token and cache usage without requiring it", async () => {
    const onUsage = vi.fn();
    await requestChatCompletion(
      {
        config: config(),
        apiKey: "",
        mode: "json_schema",
        requestJson: requestBundle().requestJson,
        deadlineAt: Date.now() + 10_000,
        onUsage,
      },
      (async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"schemaVersion":1}' } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }))) as typeof fetch,
    );
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedTokens: 40,
      reasoningTokens: null,
    });
  });

  it("rejects oversized provider responses", async () => {
    const huge = "x".repeat(256_001);
    await expect(
      requestChatCompletion(
        {
          config: config(),
          apiKey: "",
          mode: "prompt",
          requestJson: requestBundle().requestJson,
          deadlineAt: Date.now() + 10_000,
        },
        (async () => new Response(huge)) as typeof fetch,
      ),
    ).rejects.toThrow(/256000-byte limit/);
  });

  it("cancels an editor-owned request through AbortSignal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const request = requestChatCompletion(
      {
        config: config(),
        apiKey: "",
        mode: "prompt",
        requestJson: requestBundle().requestJson,
        deadlineAt: Date.now() + 10_000,
        signal: controller.signal,
      },
      fetchImpl as typeof fetch,
    );
    controller.abort();
    await expect(request).rejects.toThrow("cancelled");
  });

  it("enforces the absolute deadline while receiving", async () => {
    const abortingFetch = () =>
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(new DOMException("Deadline", "AbortError"));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Deadline", "AbortError")),
              { once: true },
            );
          }),
      );
    // The message names the caller's budget: the reranker shares this adapter with a
    // two-second deadline and must not be told it waited two minutes.
    await expect(
      requestChatCompletion(
        {
          config: config(),
          apiKey: "",
          mode: "prompt",
          requestJson: requestBundle().requestJson,
          deadlineAt: Date.now() + 5,
        },
        abortingFetch() as typeof fetch,
      ),
    ).rejects.toThrow("1-second deadline");
  });

  it("names whichever budget the caller set", () => {
    expect(deadlineExceededMessage(120_000)).toBe(
      "Provider request reached the 120-second deadline. Try again, or choose a faster model.",
    );
    // The reranker's real budget: whole seconds stay whole, fractions stay honest.
    expect(deadlineExceededMessage(2_500)).toBe(
      "Provider request reached the 2.5-second deadline. Try again, or choose a faster model.",
    );
    expect(deadlineExceededMessage(8_000)).toBe(
      "Provider request reached the 8-second deadline. Try again, or choose a faster model.",
    );
    // A deadline already in the past reports the floor rather than zero or negative.
    expect(deadlineExceededMessage(-5_000)).toBe(
      "Provider request reached the 1-second deadline. Try again, or choose a faster model.",
    );
  });

  it("reports blocked redirects with the configured URL", async () => {
    await expect(
      requestChatCompletion(
        {
          config: config(),
          apiKey: "",
          mode: "prompt",
          requestJson: requestBundle().requestJson,
          deadlineAt: Date.now() + 10_000,
        },
        (async () => {
          throw new TypeError("redirect mode is set to error");
        }) as typeof fetch,
      ),
    ).rejects.toThrow(
      "Request to https://api.example.com/v1/chat/completions was blocked because the endpoint attempted a redirect.",
    );
  });

  it("rejects oversized wire requests before fetch", async () => {
    const fetchImpl = vi.fn(async () => completion("{}"));
    const oversizedConfig = config();
    oversizedConfig.extraBody = { padding: "x".repeat(512_000) };
    await expect(
      requestChatCompletion(
        {
          config: oversizedConfig,
          apiKey: "",
          mode: "prompt",
          requestJson: requestBundle().requestJson,
          deadlineAt: Date.now() + 10_000,
        },
        fetchImpl as typeof fetch,
      ),
    ).rejects.toThrow(/Provider request is .* limit is 512000/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("connection capability fallback and repair", () => {
  it("falls back from JSON Schema to JSON-object mode using fake records only", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) return new Response("unsupported", { status: 400 });
      return completion(
        '{"schemaVersion":1,"groups":[{"temporaryId":"g","title":"Examples","tabIds":[1,2]}],"untouchedTabIds":[]}',
      );
    });
    const record = await testProviderConnection({
      config: config(),
      apiKey: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(record.capabilities.structuredOutput).toBe("json_object");
    expect((bodies[1]?.response_format as { type: string }).type).toBe("json_object");
    expect(JSON.stringify(bodies)).toContain("Example documentation");
    const userContent = bodies.flatMap((body) =>
      (body.messages as Array<{ role: string; content: string }> ?? [])
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).join("\n");
    expect(userContent).not.toContain("/one");
  });

  it("unwraps a Markdown-fenced proposal without a repair request", async () => {
    const capabilities: ProviderCapabilities = { structuredOutput: "prompt", streaming: false };
    const connectionTest = {
      fingerprint: await computeProviderFingerprint(config(), capabilities),
      testedAt: Date.now(),
      providerOrigin: config().origin,
      capabilities,
    };
    const fetchImpl = vi.fn(async () => completion(
      "```json\n{\"schemaVersion\":1,\"groups\":[{\"temporaryId\":\"group-1\",\"title\":\"G\",\"color\":null,\"tabIds\":[1,2]}],\"untouchedTabIds\":[],\"ungroupTabIds\":[],\"lowValueTabIds\":[]}\n```",
    ));
    const result = await generateValidatedProposal({
      config: config(),
      apiKey: "secret",
      connectionTest,
      request: requestBundle(),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.status).toBe("validated");
    expect(result.repairAttempted).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses one metadata-free repair request and validates the repaired proposal", async () => {
    const bundle = requestBundle();
    const capabilities: ProviderCapabilities = {
      structuredOutput: "json_object",
      streaming: false,
    };
    const connectionTest = {
      fingerprint: await computeProviderFingerprint(config(), capabilities),
      testedAt: Date.now(),
      providerOrigin: config().origin,
      capabilities,
    };
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> });
      if (bodies.length === 1) {
        return completion(
          '{"schemaVersion":1,"groups":[{"temporaryId":"g","title":"G","tabIds":[1,2]}],"untouchedTabIds":[],"notes":"x"}',
        );
      }
      return completion(
        '{"schemaVersion":1,"groups":[{"temporaryId":"g","title":"G","tabIds":[1,2]}],"untouchedTabIds":[]}',
      );
    });
    const result = await generateValidatedProposal({
      config: config(),
      apiKey: "secret",
      connectionTest,
      request: bundle,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.status).toBe("validated");
    expect(result.repairAttempted).toBe(true);
    expect(result.proposal?.groups[0]?.tabIds).toEqual([1, 2]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages[1]?.content).toContain("validationErrors");
    expect(bodies[1]?.messages[1]?.content).not.toContain("privacyLevel");
    expect(bodies[1]?.messages[1]?.content).not.toContain("example.com");
    expect(JSON.parse(bodies[1]!.messages[1]!.content)).toMatchObject({
      submittedTabIds: bundle.submittedTabIds,
    });
  });

  it("fixes a singleton group locally without a repair request", async () => {
    const bundle = requestBundle();
    const capabilities: ProviderCapabilities = {
      structuredOutput: "json_object",
      streaming: false,
    };
    const connectionTest = {
      fingerprint: await computeProviderFingerprint(config(), capabilities),
      testedAt: Date.now(),
      providerOrigin: config().origin,
      capabilities,
    };
    const fetchImpl = vi.fn(async () => completion(
      '{"schemaVersion":1,"groups":[{"temporaryId":"g","title":"G","tabIds":[1]}],"untouchedTabIds":[2]}',
    ));
    const result = await generateValidatedProposal({
      config: config(),
      apiKey: "secret",
      connectionTest,
      request: bundle,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("validated");
    expect(result.repairAttempted).toBe(false);
    expect(result.proposal?.groups).toEqual([]);
    expect(result.proposal?.untouchedTabIds).toEqual([2, 1]);
  });
});

function sse(events: unknown[], options: { delayFirstMs?: number } = {}): Response {
  const encoder = new TextEncoder();
  const lines = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [index, line] of lines.entries()) {
        if (index === 0 && options.delayFirstMs) await new Promise((resolve) => setTimeout(resolve, options.delayFirstMs));
        // Split mid-line so the parser must buffer across chunks.
        const middle = Math.floor(line.length / 2);
        controller.enqueue(encoder.encode(line.slice(0, middle)));
        controller.enqueue(encoder.encode(line.slice(middle)));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("streamed organizer completions", () => {
  const proposalJson = '{"schemaVersion":1,"groups":[{"temporaryId":"g","title":"G","tabIds":[1,2]}],"untouchedTabIds":[]}';

  it("assembles streamed content and reports usage and time to first token", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse([
        { choices: [{ delta: { role: "assistant" } }] },
        { choices: [{ delta: { reasoning_content: "thinking" } }] },
        { choices: [{ delta: { content: proposalJson.slice(0, 20) } }] },
        { choices: [{ delta: { content: proposalJson.slice(20) } }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80, completion_tokens_details: { reasoning_tokens: 10 } } },
        "[DONE]",
      ], { delayFirstMs: 5 });
    });
    const usage: unknown[] = [];
    const timings: Array<{ firstTokenAt: number | null; streamed: boolean; startedAt: number }> = [];
    const content = await requestChatCompletion(
      {
        config: config(),
        apiKey: "",
        mode: "json_schema",
        requestJson: requestBundle().requestJson,
        deadlineAt: Date.now() + 10_000,
        stream: true,
        onUsage: (value) => usage.push(value),
        onTiming: (value) => timings.push(value),
      },
      fetchImpl as typeof fetch,
    );
    expect(content).toBe(proposalJson);
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    expect(usage).toEqual([{ promptTokens: 50, completionTokens: 30, totalTokens: 80, cachedTokens: null, reasoningTokens: 10 }]);
    expect(timings).toHaveLength(1);
    expect(timings[0]?.streamed).toBe(true);
    expect(timings[0]?.firstTokenAt).not.toBeNull();
    expect(timings[0]!.firstTokenAt! - timings[0]!.startedAt).toBeGreaterThanOrEqual(0);
  });

  it("accepts a plain JSON answer from a provider that ignores streaming", async () => {
    const timings: Array<{ streamed: boolean; firstTokenAt: number | null }> = [];
    const content = await requestChatCompletion(
      {
        config: config(),
        apiKey: "",
        mode: "json_schema",
        requestJson: requestBundle().requestJson,
        deadlineAt: Date.now() + 10_000,
        stream: true,
        onTiming: (value) => timings.push(value),
      },
      (async () => completion(proposalJson)) as typeof fetch,
    );
    expect(content).toBe(proposalJson);
    expect(timings).toEqual([expect.objectContaining({ streamed: false, firstTokenAt: null })]);
  });

  it("retries once without streaming when the provider rejects it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) return new Response("stream_options is not supported", { status: 400 });
      return completion(proposalJson);
    });
    const content = await requestChatCompletion(
      {
        config: config(),
        apiKey: "",
        mode: "json_schema",
        requestJson: requestBundle().requestJson,
        deadlineAt: Date.now() + 10_000,
        stream: true,
      },
      fetchImpl as typeof fetch,
    );
    expect(content).toBe(proposalJson);
    expect(bodies.map((body) => body.stream)).toEqual([true, false]);
  });

  it("surfaces a provider error sent mid-stream", async () => {
    await expect(requestChatCompletion(
      {
        config: config(),
        apiKey: "",
        mode: "json_schema",
        requestJson: requestBundle().requestJson,
        deadlineAt: Date.now() + 10_000,
        stream: true,
      },
      (async () => sse([{ error: { message: "upstream overloaded" } }])) as typeof fetch,
    )).rejects.toThrow("Provider stream failed: upstream overloaded");
  });
});
