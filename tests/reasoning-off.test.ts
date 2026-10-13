import { describe, expect, it, vi } from "vitest";
import { requestChatCompletion, requestGenericChatCompletion } from "../src/provider/openai-chat-completions";
import { detectReasoningOffSwitches, reasoningControls } from "../src/provider/reasoning-off";
import type { OpenAICompatibleConfig } from "../src/shared/organizer-types";

function config(overrides: Partial<OpenAICompatibleConfig> = {}): OpenAICompatibleConfig {
  return {
    origin: "http://localhost:8000",
    endpointPath: "/v1/chat/completions",
    model: "Qwen/Qwen3-8B",
    customHeaders: {},
    extraBody: {},
    reasoningEffort: "none",
    manualStreamingEnabled: false,
    ...overrides,
  };
}

const PLAN = '{"schemaVersion":1,"groups":[],"untouchedTabIds":[1,2]}';

function reply(content: string, status = 200, error?: string): Response {
  const body = error ? { error: { message: error } } : { choices: [{ index: 0, message: { role: "assistant", content } }] };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("reasoning off", () => {
  it("auto-detects the switch each host family reads", () => {
    expect(detectReasoningOffSwitches("https://api.openai.com", "gpt-5.1")).toEqual(["reasoning_effort"]);
    expect(detectReasoningOffSwitches("https://openrouter.ai", "qwen/qwen3-32b")).toEqual(["reasoning_effort"]);
    expect(detectReasoningOffSwitches("http://localhost:11434", "qwen3")).toEqual(["reasoning_effort", "think"]);
    expect(detectReasoningOffSwitches("https://api.deepseek.com", "deepseek-chat")).toEqual(["thinking"]);
    expect(detectReasoningOffSwitches("https://open.bigmodel.cn", "glm-4.6")).toEqual(["thinking"]);
    expect(detectReasoningOffSwitches("https://dashscope-intl.aliyuncs.com", "qwen-plus")).toEqual(["enable_thinking"]);
    expect(detectReasoningOffSwitches("http://localhost:8000", "Qwen/Qwen3-8B"))
      .toEqual(["chat_template_kwargs", "thinking", "enable_thinking", "no_think_prompt"]);
    expect(detectReasoningOffSwitches("http://gpu-box:8000", "deepseek-v3.1"))
      .toEqual(["chat_template_kwargs", "thinking", "enable_thinking"]);
  });

  it("sends only the hand-picked switch, and lets extra body win", () => {
    expect(reasoningControls(config({ reasoningOffMethod: "enable_thinking" })).body).toEqual({ enable_thinking: false });
    expect(reasoningControls(config({ reasoningOffMethod: "think" })).body).toEqual({ think: false });
    expect(reasoningControls(config({ reasoningOffMethod: "reasoning_effort" })).body).toEqual({ reasoning_effort: "none" });
    expect(reasoningControls(config({ reasoningOffMethod: "no_think_prompt" }))).toEqual({ body: {}, noThinkPrompt: true });
    expect(reasoningControls(config({
      reasoningOffMethod: "chat_template_kwargs",
      extraBody: { chat_template_kwargs: { enable_thinking: true, custom: 1 } },
    })).body).toEqual({ chat_template_kwargs: { enable_thinking: true, thinking: false, custom: 1 } });
    expect(reasoningControls(config({ reasoningOffMethod: "thinking", extraBody: { thinking: { type: "enabled" } } })).body).toEqual({});
    expect(reasoningControls(config({ reasoningEffort: "high" })).body).toEqual({ reasoning_effort: "high" });
    expect(reasoningControls(config({ reasoningEffort: undefined })).body).toEqual({});
  });

  it("adds /no_think to the system prompt for Qwen3 on an unknown host", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return reply(PLAN);
    });
    await requestChatCompletion(
      { config: config(), apiKey: "", mode: "prompt", requestJson: "{}", deadlineAt: Date.now() + 10_000 },
      fetchImpl as typeof fetch,
    );
    await requestGenericChatCompletion(
      { config: config(), apiKey: "", messages: [{ role: "user", content: "hi" }], deadlineAt: Date.now() + 10_000 },
      fetchImpl as typeof fetch,
    );
    expect(bodies[0]?.messages[0]).toMatchObject({ role: "system" });
    expect(bodies[0]?.messages[0]?.content.endsWith("/no_think")).toBe(true);
    expect(bodies[1]?.messages).toEqual([{ role: "system", content: "/no_think" }, { role: "user", content: "hi" }]);
  });

  it("retries once without Auto's body switches when a strict server rejects them", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return "thinking" in body ? reply("", 400, "Unrecognized request argument supplied: thinking") : reply(PLAN);
    });
    const content = await requestChatCompletion(
      { config: config(), apiKey: "", mode: "prompt", requestJson: "{}", deadlineAt: Date.now() + 10_000 },
      fetchImpl as typeof fetch,
    );
    expect(JSON.parse(content)).toMatchObject({ schemaVersion: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("thinking");
    expect(bodies[1]).not.toHaveProperty("chat_template_kwargs");
    expect(bodies[1]).not.toHaveProperty("enable_thinking");
  });

  it("does not drop a hand-picked switch the server rejects", async () => {
    const fetchImpl = vi.fn(async () => reply("", 400, "Unrecognized request argument supplied: enable_thinking"));
    await expect(requestChatCompletion(
      {
        config: config({ reasoningOffMethod: "enable_thinking" }),
        apiKey: "",
        mode: "prompt",
        requestJson: "{}",
        deadlineAt: Date.now() + 10_000,
      },
      fetchImpl as typeof fetch,
    )).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
