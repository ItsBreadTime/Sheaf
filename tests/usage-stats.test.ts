import { afterEach, describe, expect, it } from "vitest";
import { requestRawChatCompletion } from "../src/provider/openai-chat-completions";
import { setUsageSink, startUsageMeter } from "../src/provider/usage-meter";
import type { UsageSample } from "../src/shared/usage-types";
import {
  emptyUsageStats,
  organizeCostPerThousand,
  parseUsageStats,
  projectedYearlyCostUsd,
  recordUsageInState,
  usageCostUsd,
  usageDayKey,
  USAGE_DAYS_KEPT,
} from "../src/storage/usage-stats";

afterEach(() => setUsageSink(null));

function sample(overrides: Partial<UsageSample> = {}): UsageSample {
  return {
    kind: "llm",
    ok: true,
    at: new Date(2026, 9, 12, 10).getTime(),
    usage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200, cachedTokens: 100, reasoningTokens: 50 },
    costUsd: null,
    ...overrides,
  };
}

describe("usage meter", () => {
  it("reports one sample with the last usage and the provider's cost", () => {
    const samples: UsageSample[] = [];
    setUsageSink((item) => samples.push(item));
    const meter = startUsageMeter("decision");
    meter.observe({ choices: [] });
    meter.observe({ usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, cost: 0.0004 } });
    meter.finish(true);
    meter.finish(false);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ kind: "decision", ok: true, costUsd: 0.0004 });
    expect(samples[0]!.usage).toMatchObject({ promptTokens: 12, completionTokens: 1 });
  });

  it("counts a chat request under the kind the caller names, failures included", async () => {
    const samples: UsageSample[] = [];
    setUsageSink((item) => samples.push(item));
    const config = { origin: "https://api.example.com", endpointPath: "/v1/chat/completions", model: "m", customHeaders: {}, extraBody: {}, manualStreamingEnabled: false };
    const ok = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "A" } }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    await requestRawChatCompletion({ config, apiKey: "", messages: [], deadlineAt: Date.now() + 5_000, usageKind: "decision" }, ok);
    const failing = async () => new Response("nope", { status: 500 });
    await expect(requestRawChatCompletion({ config, apiKey: "", messages: [], deadlineAt: Date.now() + 5_000 }, failing)).rejects.toThrow();
    expect(samples.map((item) => [item.kind, item.ok])).toEqual([["decision", true], ["llm", false]]);
    expect(samples.map((item) => item.task)).toEqual([null, null]);
    expect(samples[0]!.usage?.promptTokens).toBe(5);
  });

  it("reports a request the caller aborts as cancelled, but a timeout as failed", async () => {
    const samples: UsageSample[] = [];
    setUsageSink((item) => samples.push(item));
    const config = { origin: "https://api.example.com", endpointPath: "/v1/chat/completions", model: "m", customHeaders: {}, extraBody: {}, manualStreamingEnabled: false };
    const hang = (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
    const controller = new AbortController();
    const cancelled = requestRawChatCompletion({ config, apiKey: "", messages: [], deadlineAt: Date.now() + 5_000, signal: controller.signal }, hang);
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    await expect(requestRawChatCompletion({ config, apiKey: "", messages: [], deadlineAt: Date.now() + 20 }, hang)).rejects.toThrow();
    expect(samples.map((item) => [item.ok, item.cancelled ?? false])).toEqual([[false, true], [false, false]]);
  });
});

describe("usage stats", () => {
  it("adds samples to the totals and the day, and splits reported from estimated cost", () => {
    let state = emptyUsageStats(0);
    state = recordUsageInState(state, sample());
    state = recordUsageInState(state, sample({ costUsd: 0.01 }));
    state = recordUsageInState(state, sample({ ok: false, usage: null }));
    const totals = state.totals.llm;
    expect(totals).toMatchObject({ requests: 3, failures: 1, reportedRequests: 2, promptTokens: 2_000, completionTokens: 400 });
    expect(totals.unpricedPromptTokens).toBe(1_000);
    expect(state.days[usageDayKey(sample().at)]?.llm?.requests).toBe(3);

    expect(usageCostUsd(totals, { inputPerMillionUsd: 0, outputPerMillionUsd: 0 })).toEqual({ usd: 0.01, estimated: false });
    const priced = usageCostUsd(totals, { inputPerMillionUsd: 1, outputPerMillionUsd: 10 });
    expect(priced.estimated).toBe(true);
    expect(priced.usd).toBeCloseTo(0.01 + 0.001 + 0.002);
  });

  it("counts a cancelled request apart from failures", () => {
    let state = emptyUsageStats(0);
    state = recordUsageInState(state, sample({ ok: false, usage: null, cancelled: true }));
    state = recordUsageInState(state, sample({ ok: false, usage: null }));
    expect(state.totals.llm).toMatchObject({ requests: 2, failures: 1, cancellations: 1, reportedRequests: 0 });
  });

  it("derives embedding output from total tokens when only those are reported", () => {
    const state = recordUsageInState(emptyUsageStats(0), sample({
      kind: "embedding",
      usage: { promptTokens: 40, completionTokens: null, totalTokens: 40, cachedTokens: null },
    }));
    expect(state.totals.embedding).toMatchObject({ promptTokens: 40, completionTokens: 0 });
  });

  it("keeps only the newest days and survives a round trip through storage", () => {
    let state = emptyUsageStats(0);
    for (let day = 0; day < USAGE_DAYS_KEPT + 5; day += 1) {
      state = recordUsageInState(state, sample({ at: new Date(2026, 0, 1 + day, 12).getTime() }));
    }
    expect(Object.keys(state.days)).toHaveLength(USAGE_DAYS_KEPT);
    expect(state.totals.llm.requests).toBe(USAGE_DAYS_KEPT + 5);
    expect(parseUsageStats(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(parseUsageStats({ schemaVersion: 2 }, 7).since).toBe(7);
  });
});

describe("usage by task", () => {
  const pricing = {
    llm: { inputPerMillionUsd: 1, outputPerMillionUsd: 10 },
    decision: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
    embedding: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0 },
  };

  it("tags samples with the task the meter was started for", () => {
    const samples: UsageSample[] = [];
    setUsageSink((item) => samples.push(item));
    startUsageMeter("llm", { task: "organize", startsRun: true }).finish(true);
    startUsageMeter("embedding", { task: "search" }).finish(true);
    startUsageMeter("llm").finish(true);
    expect(samples.map((item) => [item.task, item.startsRun])).toEqual([["organize", true], ["search", false], [null, false]]);
  });

  it("counts successful run starts once and prices a run with its repair", () => {
    let state = { ...emptyUsageStats(0), pricing };
    // Two runs, one needing a repair; a failed start (stream fallback) is not a run.
    state = recordUsageInState(state, sample({ task: "organize", startsRun: true, ok: false, usage: null }));
    state = recordUsageInState(state, sample({ task: "organize", startsRun: true }));
    state = recordUsageInState(state, sample({ task: "organize", startsRun: true }));
    state = recordUsageInState(state, sample({ task: "organize" }));
    // Untagged (a connection test) and other tasks stay out of organize.
    state = recordUsageInState(state, sample());
    state = recordUsageInState(state, sample({ task: "search" }));
    expect(state.organizeRuns).toBe(2);
    expect(state.tasks.organize.llm?.requests).toBe(4);
    const perThousand = organizeCostPerThousand(state)!;
    // Three priced requests at $0.003 each over two runs.
    expect(perThousand.usd).toBeCloseTo(4.5);
    expect(perThousand).toMatchObject({ estimated: true, runs: 2 });
    expect(organizeCostPerThousand(emptyUsageStats(0))).toBeNull();
  });

  it("projects a task's recent spend to a year", () => {
    const now = new Date(2026, 9, 12, 12).getTime();
    let state = { ...emptyUsageStats(now - 10 * 86_400_000), pricing };
    state = recordUsageInState(state, sample({ task: "autoFile", kind: "decision", costUsd: 0.05, at: now - 86_400_000 }));
    state = recordUsageInState(state, sample({ task: "autoFile", kind: "decision", costUsd: 0.05, at: now }));
    const yearly = projectedYearlyCostUsd(state, "autoFile", now);
    expect(yearly.days).toBeCloseTo(10);
    expect(yearly.usd).toBeCloseTo((0.1 / 10) * 365);
    expect(yearly.estimated).toBe(false);
    expect(projectedYearlyCostUsd(state, "search", now).usd).toBe(0);
  });

  it("starts task history now for stats saved before tasks were tracked", () => {
    const legacy = JSON.parse(JSON.stringify(emptyUsageStats(5))) as Record<string, unknown>;
    delete legacy.tasks;
    delete legacy.taskDays;
    delete legacy.organizeRuns;
    delete legacy.tasksSince;
    const parsed = parseUsageStats(legacy, 99);
    expect(parsed).toMatchObject({ since: 5, tasksSince: 99, organizeRuns: 0, taskDays: {} });
    expect(parsed.tasks.organize).toEqual({});
  });
});
