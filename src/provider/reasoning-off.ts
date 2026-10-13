import { isOpenRouterOrigin } from "./request-policy";
import type { OpenAICompatibleConfig, ReasoningOffMethod } from "../shared/organizer-types";

/**
 * Turning reasoning off has no common switch across OpenAI-compatible servers:
 * each family reads a different body field, and most ignore the others. "Auto"
 * picks the switches the host is known to read; an unrecognized host (usually
 * self-hosted vLLM, SGLang, llama.cpp, or LM Studio) gets every switch that a
 * lenient server tolerates.
 */
export const REASONING_OFF_METHODS: readonly ReasoningOffMethod[] = [
  "auto",
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "chat_template_kwargs",
  "think",
  "no_think_prompt",
];

type Switch = Exclude<ReasoningOffMethod, "auto">;

const EFFORT_HOSTS = ["api.openai.com", "generativelanguage.googleapis.com", "api.groq.com"];
// DeepSeek, Z.ai/Zhipu GLM, Moonshot Kimi, Anthropic's compatibility layer, Volcengine Doubao.
const THINKING_HOSTS = ["api.deepseek.com", "api.z.ai", "open.bigmodel.cn", "api.moonshot.ai", "api.moonshot.cn", "api.anthropic.com", "volces.com"];
// Alibaba Cloud Model Studio (DashScope) and SiliconFlow.
const ENABLE_THINKING_HOSTS = ["aliyuncs.com", "siliconflow.cn", "siliconflow.com"];

function hostMatches(hostname: string, hosts: readonly string[]): boolean {
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** The switches Auto sends for this host and model. */
export function detectReasoningOffSwitches(origin: string, model: string): Switch[] {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return ["chat_template_kwargs", "thinking", "enable_thinking"];
  }
  const hostname = url.hostname.toLowerCase();
  if (isOpenRouterOrigin(origin) || hostMatches(hostname, EFFORT_HOSTS)) return ["reasoning_effort"];
  if (url.port === "11434" || hostname.includes("ollama")) return ["reasoning_effort", "think"];
  if (hostMatches(hostname, THINKING_HOSTS)) return ["thinking"];
  if (hostMatches(hostname, ENABLE_THINKING_HOSTS)) return ["enable_thinking"];
  // reasoning_effort is left out on purpose: DeepSeek-style templates ignore
  // `thinking` whenever reasoning_effort is present.
  const switches: Switch[] = ["chat_template_kwargs", "thinking", "enable_thinking"];
  // Qwen3's soft switch also gets past gateways that drop unknown body fields.
  if (/qwen3/i.test(model)) switches.push("no_think_prompt");
  return switches;
}

export interface ReasoningControls {
  body: Record<string, unknown>;
  /** Append Qwen3's "/no_think" soft switch to the system prompt. */
  noThinkPrompt: boolean;
}

const NO_CONTROLS: ReasoningControls = { body: {}, noThinkPrompt: false };

function switchesFor(config: OpenAICompatibleConfig): Switch[] {
  const method = config.reasoningOffMethod ?? "auto";
  return method === "auto" ? detectReasoningOffSwitches(config.origin, config.model) : [method];
}

/**
 * The body fields and prompt change for the configured reasoning effort. An
 * explicit extra-body field always wins over the switch that would set it.
 * `bodySwitches: false` keeps only the prompt switch, for the retry after a
 * server rejected the body fields.
 */
export function reasoningControls(config: OpenAICompatibleConfig, bodySwitches = true): ReasoningControls {
  if (config.reasoningEffort === undefined) return NO_CONTROLS;
  if (config.reasoningEffort !== "none") return { body: { reasoning_effort: config.reasoningEffort }, noThinkPrompt: false };
  const extra = config.extraBody;
  const body: Record<string, unknown> = {};
  let noThinkPrompt = false;
  for (const choice of switchesFor(config)) {
    if (choice === "no_think_prompt") {
      noThinkPrompt = true;
      continue;
    }
    if (!bodySwitches) continue;
    if (choice === "chat_template_kwargs") {
      const own = extra.chat_template_kwargs;
      // `enable_thinking` is Qwen3, GLM, and Hunyuan; `thinking` is DeepSeek V3.1 and Granite.
      // Templates ignore the kwargs they do not use.
      body.chat_template_kwargs = {
        enable_thinking: false,
        thinking: false,
        ...(own && typeof own === "object" && !Array.isArray(own) ? own : {}),
      };
      continue;
    }
    if (choice in extra) continue;
    if (choice === "reasoning_effort") body.reasoning_effort = "none";
    else if (choice === "thinking") body.thinking = { type: "disabled" };
    else if (choice === "enable_thinking") body.enable_thinking = false;
    else body.think = false;
  }
  return { body, noThinkPrompt };
}

/** Adds Qwen3's "/no_think" soft switch to the system message, creating one if needed. */
export function withNoThinkPrompt<T extends { role: string; content: string }>(messages: readonly T[]): T[] {
  const [first, ...rest] = messages;
  if (first?.role === "system") return [{ ...first, content: `${first.content}\n\n/no_think` }, ...rest];
  return [{ role: "system", content: "/no_think" } as T, ...messages];
}

const REJECTED_FIELD = /thinking|chat_template_kwargs|\bthink\b|reasoning_effort|extra (inputs|fields)|unrecognized|unknown (field|param|argument)|not permitted|additional properties/i;

/**
 * Auto may send fields a strict server refuses. Such a refusal arrives as a 4xx
 * before any generation, so one retry without them is cheap. A switch the user
 * chose by hand is never dropped silently.
 */
export function shouldRetryWithoutReasoningSwitches(
  config: OpenAICompatibleConfig,
  status: number,
  detail: string | null,
): boolean {
  if (status !== 400 && status !== 422) return false;
  if (config.reasoningEffort !== "none" || (config.reasoningOffMethod ?? "auto") !== "auto") return false;
  if (Object.keys(reasoningControls(config).body).length === 0) return false;
  return REJECTED_FIELD.test(detail ?? "");
}

const SWITCH_LABELS: Record<Switch, string> = {
  reasoning_effort: "reasoning_effort: \"none\"",
  thinking: "thinking: disabled",
  enable_thinking: "enable_thinking: false",
  chat_template_kwargs: "chat_template_kwargs",
  think: "think: false",
  no_think_prompt: "/no_think in the prompt",
};

/** What Auto sends for this host, for the Settings hint. */
export function describeAutoReasoningOff(origin: string, model: string): string {
  return detectReasoningOffSwitches(origin, model).map((choice) => SWITCH_LABELS[choice]).join(" + ");
}
