import {
  OrganizerValidationError,
  parseNormalizeAndValidateOrganizerResponse,
  validateOrganizerResponse,
} from "../organizer/validate";
import { requestChatCompletion, type ChatCompletionTiming } from "./openai-chat-completions";
import { computeProviderFingerprint } from "./fingerprint";
import { normalizeProviderConfig } from "./request-policy";
import { LIMITS } from "../shared/limits";
import { applyClutterRules } from "../organizer/rules";
import { demoteSiteBucketGroups } from "../organizer/site-buckets";
import type {
  ConnectionTestRecord,
  GenerationMetrics,
  ImmutableRequestBundle,
  OpenAICompatibleConfig,
  ProviderJobResult,
  ProviderUsage,
  ValidatedProposal,
} from "../shared/organizer-types";

export interface GenerateProposalOptions {
  config: OpenAICompatibleConfig;
  apiKey: string;
  connectionTest: ConnectionTestRecord;
  request: ImmutableRequestBundle;
  organizerPrompt?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Stream the response so time to first token is measurable. */
  stream?: boolean;
}

function addUsage(
  left: ProviderUsage | undefined,
  right: ProviderUsage,
): ProviderUsage {
  const add = (a: number | null | undefined, b: number | null): number | null =>
    a === null || a === undefined || b === null ? b ?? a ?? null : a + b;
  return {
    promptTokens: add(left?.promptTokens, right.promptTokens),
    completionTokens: add(left?.completionTokens, right.completionTokens),
    totalTokens: add(left?.totalTokens, right.totalTokens),
    cachedTokens: add(left?.cachedTokens, right.cachedTokens),
    reasoningTokens: add(left?.reasoningTokens, right.reasoningTokens ?? null),
  };
}

function summarizeGenerationMetrics(
  timings: readonly ChatCompletionTiming[],
  usage: ProviderUsage | undefined,
  reasoningEffort: GenerationMetrics["reasoningEffort"],
): GenerationMetrics | undefined {
  const first = timings[0];
  if (!first) return undefined;
  const providerMs = timings.reduce((sum, timing) => sum + Math.max(0, timing.finishedAt - timing.startedAt), 0);
  const streamed = timings.every((timing) => timing.streamed && timing.firstTokenAt !== null);
  // Throughput counts only the time tokens were arriving, so a long queue or
  // prompt-processing wait does not read as a slow model.
  const decodeMs = streamed
    ? timings.reduce((sum, timing) => sum + Math.max(0, timing.finishedAt - (timing.firstTokenAt ?? timing.finishedAt)), 0)
    : 0;
  const outputTokens = usage?.completionTokens ?? null;
  return {
    reasoningEffort,
    timeToFirstTokenMs: first.streamed && first.firstTokenAt !== null
      ? Math.max(0, first.firstTokenAt - first.startedAt)
      : null,
    providerMs,
    outputTokensPerSecond: streamed && outputTokens !== null && decodeMs >= 50
      ? Math.round((outputTokens / (decodeMs / 1_000)) * 10) / 10
      : null,
    streamed,
  };
}

function finalizeProposal(content: string, request: ImmutableRequestBundle): ValidatedProposal {
  const { tabs, organizerRules = [], preferredGroupNames = [] } = request.approvedRequest;
  const proposal = applyClutterRules(
    parseContent(content, request.submittedTabIds),
    tabs,
    organizerRules,
  );
  const demoted = demoteSiteBucketGroups(proposal, tabs, organizerRules, preferredGroupNames).proposal;
  // The local transforms run after the model response is validated, so re-check
  // the invariant they must preserve: every submitted id appears exactly once.
  validateOrganizerResponse(demoted, request.submittedTabIds);
  return demoted;
}

// Some models wrap JSON in a Markdown fence despite the prompt; unwrapping it here
// avoids spending a whole repair round-trip on formatting.
function unwrapCodeFence(content: string): string {
  return content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? content;
}

function parseContent(content: string, submittedIds: number[]): ValidatedProposal {
  let value: unknown;
  try {
    value = JSON.parse(unwrapCodeFence(content)) as unknown;
  } catch {
    throw new OrganizerValidationError(["assistant content must be valid JSON"]);
  }
  return parseNormalizeAndValidateOrganizerResponse(value, submittedIds);
}

export async function generateValidatedProposal(
  options: GenerateProposalOptions,
): Promise<ProviderJobResult> {
  const startedAt = Date.now();
  const config = normalizeProviderConfig(options.config);
  const expectedFingerprint = await computeProviderFingerprint(
    config,
    options.connectionTest.capabilities,
  );
  if (expectedFingerprint !== options.connectionTest.fingerprint) {
    throw new Error("Provider settings changed after the last successful connection test.");
  }
  const deadlineAt = startedAt + LIMITS.MANUAL_TOTAL_DEADLINE_MS;
  let content = "";
  let usage: ProviderUsage | undefined;
  const timings: ChatCompletionTiming[] = [];
  const metrics = (): GenerationMetrics | undefined =>
    summarizeGenerationMetrics(timings, usage, config.reasoningEffort ?? null);
  try {
    content = await requestChatCompletion(
      {
        config,
        apiKey: options.apiKey,
        mode: options.connectionTest.capabilities.structuredOutput,
        requestJson: options.request.requestJson,
        organizerPrompt: options.organizerPrompt,
        deadlineAt,
        signal: options.signal,
        usageTask: "organize",
        onUsage: (next) => { usage = addUsage(usage, next); },
        onTiming: (timing) => { timings.push(timing); },
        stream: options.stream,
      },
      options.fetchImpl,
    );
    const proposal = finalizeProposal(content, options.request);
    return {
      status: "validated",
      startedAt,
      finishedAt: Date.now(),
      proposal,
      repairAttempted: false,
      error: null,
      usage,
      metrics: metrics(),
    };
  } catch (error) {
    if (!(error instanceof OrganizerValidationError)) throw error;
    const repairedContent = await requestChatCompletion(
      {
        config,
        apiKey: options.apiKey,
        mode: options.connectionTest.capabilities.structuredOutput,
        requestJson: options.request.requestJson,
        deadlineAt,
        signal: options.signal,
        usageTask: "organize",
        repair: {
          invalidOutput: content,
          validationErrors: error.issues,
          submittedTabIds: options.request.submittedTabIds,
        },
        onUsage: (next) => { usage = addUsage(usage, next); },
        onTiming: (timing) => { timings.push(timing); },
        stream: options.stream,
      },
      options.fetchImpl,
    );
    try {
      const proposal = finalizeProposal(repairedContent, options.request);
      return {
        status: "validated",
        startedAt,
        finishedAt: Date.now(),
        proposal,
        repairAttempted: true,
        error: null,
        usage,
        metrics: metrics(),
      };
    } catch (repairError) {
      return {
        status: "failed",
        startedAt,
        finishedAt: Date.now(),
        proposal: null,
        repairAttempted: true,
        error: `The model returned an unusable plan twice. Try again, or choose a model with reliable JSON output.${
          repairError instanceof Error ? ` Details: ${repairError.message.slice(0, 240)}` : ""
        }`,
        usage,
        metrics: metrics(),
      };
    }
  }
}
