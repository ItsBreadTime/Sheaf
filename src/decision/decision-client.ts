import {
  ProviderHttpError,
  ProviderTransportError,
  readBodyWithLimit,
  requestRawChatCompletion,
} from "../provider/openai-chat-completions";
import {
  describeNetworkFailure,
  describeProviderHttpError,
  providerErrorDetail,
  retryAfterSeconds,
} from "../provider/provider-errors";
import { normalizeCustomHeaders, normalizeProviderEndpoint, validateExtraBody, validateJsonBody } from "../provider/request-policy";
import { startUsageMeter } from "../provider/usage-meter";
import { LIMITS } from "../shared/limits";
import type { OpenRouterProviderPreferences } from "../shared/organizer-types";
import {
  buildChatConfidencePrompt,
  buildChatLogprobPrompt,
  choiceAnswer,
  distributionFromConfidence,
  distributionFromLogprobs,
  noulAnswer,
  type ConfidenceTable,
} from "./chat-decision-adapter";
import {
  decisionApiBody,
  DecisionResponseError,
  decisionValidationField,
  parseDecisionApiAnswers,
} from "./decision-api-adapter";
import { NONE_OPTION, STAY_OPTION } from "./filing-state";
import type { DecisionAnswers, DecisionProtocol, DecisionRequest, ProbabilitySource } from "./types";

/**
 * Sends a decision request over either wire protocol. The runtime and the
 * connection probe share this; the benchmark drives the same adapters directly.
 */

const DECISION_SETTINGS = "Settings → Providers → Decision model";
const CHAT_CONCURRENCY = 4;

export interface DecisionConnection {
  protocol: DecisionProtocol;
  origin: string;
  endpointPath: string;
  model: string;
  apiKey: string;
  customHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  timeoutMs: number;
  /** Chat only. */
  disableReasoning: boolean;
  /** Chat only, inherited when reusing the organizer connection. */
  openRouter?: OpenRouterProviderPreferences;
}

export interface DecisionResult {
  answers: DecisionAnswers;
  latencyMs: number;
  /** The weakest source among the answers: `confidence` if any answer had no probabilities. */
  source: ProbabilitySource;
}

/** The provider asked for a pause (429/529); the caller should retry after `delayMs`. */
export class DecisionBackoffError extends Error {
  readonly delayMs: number;
  constructor(message: string, delayMs: number) {
    super(message);
    this.name = "DecisionBackoffError";
    this.delayMs = delayMs;
  }
}

export interface DecisionRequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  confidenceTable?: ConfidenceTable;
  now?: () => number;
  /** Auto-filing by default; the connection probe passes null so it isn't billed to the feature. */
  usageTask?: "autoFile" | null;
}

function backoffDelayMs(retryAfter: string | null): number {
  const seconds = retryAfterSeconds(retryAfter);
  return Math.min(120_000, Math.max(5_000, (seconds ?? 30) * 1_000));
}

function rethrowBackoff(error: unknown): never {
  if (error instanceof ProviderHttpError && (error.status === 429 || error.status === 529)) {
    throw new DecisionBackoffError(error.message, backoffDelayMs(error.retryAfter));
  }
  throw error;
}

async function postDecisionApi(
  connection: DecisionConnection,
  request: DecisionRequest,
  options: DecisionRequestOptions,
): Promise<unknown> {
  const endpoint = normalizeProviderEndpoint(connection.origin, connection.endpointPath);
  const body = JSON.stringify(decisionApiBody(connection.model, request, connection.extraBody));
  if (new TextEncoder().encode(body).byteLength > LIMITS.MAX_REQUEST_BYTES) {
    throw new Error("The decision request is too large.");
  }
  const headers = new Headers(normalizeCustomHeaders(connection.customHeaders));
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  if (connection.apiKey.trim()) headers.set("authorization", `Bearer ${connection.apiKey.trim()}`);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(connection.timeoutMs)])
    : AbortSignal.timeout(connection.timeoutMs);
  const meter = startUsageMeter("decision", { task: options.usageTask === undefined ? "autoFile" : options.usageTask });
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(endpoint.url, { method: "POST", headers, body, redirect: "error", signal });
  } catch (error) {
    meter.finish(false, options.signal?.aborted === true);
    if (signal.aborted) throw new ProviderTransportError("The decision model did not answer in time.");
    const detail = error instanceof Error ? error.message : "";
    throw new ProviderTransportError(/redirect/i.test(detail)
      ? `Request to ${endpoint.url} was blocked because the endpoint attempted a redirect.`
      : describeNetworkFailure(endpoint.url, DECISION_SETTINGS));
  }
  if (!response.ok) {
    meter.finish(false);
    const text = await readBodyWithLimit(response, LIMITS.MAX_PROVIDER_ERROR_BYTES, true).catch(() => "");
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 429 || response.status === 529) {
      throw new DecisionBackoffError(
        describeProviderHttpError({ status: 429, endpointUrl: endpoint.url, model: connection.model, detail: null, retryAfter, settingsPath: DECISION_SETTINGS }),
        backoffDelayMs(retryAfter),
      );
    }
    let field: string | null = null;
    if (response.status === 422) {
      try {
        field = decisionValidationField(JSON.parse(text));
      } catch {
        field = null;
      }
    }
    const message = describeProviderHttpError({
      status: response.status,
      endpointUrl: endpoint.url,
      model: connection.model,
      detail: providerErrorDetail(text),
      retryAfter,
      settingsPath: DECISION_SETTINGS,
    });
    throw new ProviderHttpError(
      response.status,
      field ? `${message} The rejected field: ${field}.` : message,
      retryAfter,
      field,
    );
  }
  let json: unknown;
  try {
    const text = await readBodyWithLimit(response, LIMITS.MAX_RESPONSE_BYTES, false);
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new DecisionResponseError("The decision model returned a non-JSON response.");
    }
  } catch (error) {
    meter.finish(false, options.signal?.aborted === true);
    throw error;
  }
  meter.observe(json);
  meter.finish(true);
  return json;
}

function chatConfig(connection: DecisionConnection) {
  return {
    origin: connection.origin,
    endpointPath: connection.endpointPath,
    model: connection.model,
    customHeaders: connection.customHeaders,
    extraBody: connection.extraBody,
    manualStreamingEnabled: false,
    ...(connection.disableReasoning ? { reasoningEffort: "none" as const } : {}),
    ...(connection.openRouter ? { openRouter: connection.openRouter } : {}),
  };
}

async function askChatQuestion(
  connection: DecisionConnection,
  state: unknown,
  question: DecisionRequest["questions"][string],
  options: DecisionRequestOptions,
): Promise<{ probabilities: Record<string, number>; source: ProbabilitySource }> {
  const now = options.now ?? Date.now;
  const send = (body: Record<string, unknown>, messages: ReturnType<typeof buildChatLogprobPrompt>["messages"]) =>
    requestRawChatCompletion({
      config: chatConfig(connection),
      apiKey: connection.apiKey,
      messages,
      body,
      deadlineAt: now() + connection.timeoutMs,
      signal: options.signal,
      usageKind: "decision",
      usageTask: options.usageTask === undefined ? "autoFile" : options.usageTask,
    }, options.fetchImpl).catch(rethrowBackoff);
  const logprobPrompt = buildChatLogprobPrompt(state, question);
  // A provider that rejects the logprob fields (400/422) still gets the JSON fallback.
  const logprobResponse = await send(logprobPrompt.body, logprobPrompt.messages).catch((error: unknown) => {
    if (error instanceof ProviderHttpError && (error.status === 400 || error.status === 422)) return null;
    throw error;
  });
  const fromLogprobs = logprobResponse === null ? null : distributionFromLogprobs(logprobResponse, logprobPrompt.labels);
  if (fromLogprobs) return { probabilities: fromLogprobs, source: "logprobs" };
  // No logprobs (or a thinking model spent its one token): ask for a bucketed answer.
  const confidencePrompt = buildChatConfidencePrompt(state, question);
  const confidenceResponse = await send(confidencePrompt.body, confidencePrompt.messages);
  const fromConfidence = distributionFromConfidence(confidenceResponse, confidencePrompt.labels, options.confidenceTable);
  if (fromConfidence) return { probabilities: fromConfidence, source: "confidence" };
  // An unusable answer abstains: all mass on the safe option.
  const optionsList = Object.values(confidencePrompt.labels);
  const safe = optionsList.find((option) => option === STAY_OPTION) ??
    optionsList.find((option) => option === NONE_OPTION || option === "no");
  return {
    probabilities: Object.fromEntries(optionsList.map((option) => [option, option === safe ? 1 : 0])),
    source: "confidence",
  };
}

async function inPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  }));
}

const SOURCE_RANK: Record<ProbabilitySource, number> = { native: 0, logprobs: 1, confidence: 2 };

export async function requestDecisions(
  connection: DecisionConnection,
  request: DecisionRequest,
  options: DecisionRequestOptions = {},
): Promise<DecisionResult> {
  const now = options.now ?? Date.now;
  const started = now();
  if (connection.protocol === "decision_api") {
    const json = await postDecisionApi(connection, request, options);
    return { answers: parseDecisionApiAnswers(json, request), latencyMs: now() - started, source: "native" };
  }
  const answers: DecisionAnswers = {};
  let source: ProbabilitySource = "logprobs";
  await inPool(Object.entries(request.questions), CHAT_CONCURRENCY, async ([id, question]) => {
    const result = await askChatQuestion(connection, request.state, question, options);
    const answer = choiceAnswer(result.probabilities, result.source);
    answers[id] = question.type === "noul" ? noulAnswer(answer) : answer;
    if (SOURCE_RANK[result.source] > SOURCE_RANK[source]) source = result.source;
  });
  return { answers, latencyMs: now() - started, source };
}

/** The body the decision request is sent as, for the settings preview. */
export function decisionRequestPreview(connection: Pick<DecisionConnection, "protocol" | "model" | "extraBody">, request: DecisionRequest): string {
  if (connection.protocol === "decision_api") {
    return JSON.stringify(decisionApiBody(connection.model, request, connection.extraBody), null, 2);
  }
  const prompts = Object.fromEntries(Object.entries(request.questions).map(([id, question]) =>
    [id, buildChatLogprobPrompt(request.state, question).messages]));
  return JSON.stringify({ model: connection.model, questions: prompts }, null, 2);
}

/** Validates a user-supplied extra body for the decision API, whose owned keys differ from chat's. */
export function validateDecisionExtraBody(protocol: DecisionProtocol, extraBody: Record<string, unknown>): void {
  if (protocol === "chat") {
    validateExtraBody(extraBody);
    return;
  }
  for (const key of Object.keys(extraBody)) {
    if (["model", "state", "questions"].includes(key.toLowerCase())) {
      throw new Error(`Extra body cannot override adapter-owned field ${key}.`);
    }
  }
  validateJsonBody(extraBody, "extraBody");
}
