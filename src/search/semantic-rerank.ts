import type { GenericChatCompletionRequest } from "../provider/openai-chat-completions";
import { requestGenericChatCompletion } from "../provider/openai-chat-completions";
import { redactQueryText } from "../privacy/sanitize-text";
import type { SemanticQueryResult } from "./semantic-query";

/**
 * Reranks the vector shortlist with the chat model the extension already has.
 *
 * This is the only mechanism that addresses ordering errors on near-ties: a
 * second opinion on a shortlist is what can break a tie the vector ranking
 * cannot. It never sees anything the embedder did
 * not already see: the candidate listing is the sanitized document text, which is
 * why the gate and the disclosure are about *how many* tabs travel rather than
 * about new data.
 */
const SEMANTIC_RERANK_THIN_MARGIN = 0.02;
const SEMANTIC_RERANK_CANDIDATES = 8;
/**
 * The budget the *model* gets, not the budget the user waits. The rerank runs after the
 * vector order is on screen, so the deadline only bounds how late a reorder may arrive.
 *
 * A reasoning model can spend most of its time thinking about a task that needs one
 * short list, so a budget of a few seconds would reject exactly the organizer models
 * most users configure; this one admits a reasoning model that thinks briefly and
 * still cuts off one that will not stop.
 */
const SEMANTIC_RERANK_DEADLINE_MS = 8_000;

export interface RerankGateInput {
  /** Cosine gap between the top two results, or null when there is only one. */
  margin: number | null;
  /** Direct (lexical) search found nothing strong, so the semantic order is the only order. */
  directResultsWeak: boolean;
  thinMargin?: number;
}

/** A single result is not a ranking problem, and a decisive margin is not either. */
export function shouldRerankSemanticResults(input: RerankGateInput): boolean {
  if (input.margin === null) return false;
  return input.margin <= (input.thinMargin ?? SEMANTIC_RERANK_THIN_MARGIN) && input.directResultsWeak;
}

export interface RerankCandidate {
  /** The mapping key, which is what the model echoes back and what is validated against. */
  id: string;
  /** Sanitized document text: the same title/host/path the embedder received. */
  document: string;
}

/**
 * The prompt asks for ids only. Titles are data, not instructions, and a model that
 * is asked to explain itself costs latency this budget has not got.
 */
export function buildRerankMessages(
  query: string,
  candidates: readonly RerankCandidate[],
): GenericChatCompletionRequest["messages"] {
  const listing = candidates
    .map((candidate) => `- ${candidate.id}\n${candidate.document.split("\n").map((line) => `    ${line}`).join("\n")}`)
    .join("\n");
  return [
    {
      role: "system",
      content: [
        "You order browser tabs by how well they match a remembered description.",
        "The tabs are listed with an identifier and their indexed text.",
        "Answer with JSON only: {\"order\":[\"id\",\"id\"]}, listing the identifiers from best match to worst.",
        "Use every identifier exactly once. If the current order is already the best you can justify, return it unchanged.",
      ].join(" "),
    },
    {
      role: "user",
      content: `Description: ${redactQueryText(query)}\n\nTabs:\n${listing}`,
    },
  ];
}

/**
 * Reads an id order out of whatever the model returned.
 *
 * Unknown or duplicated ids are dropped, and any candidate the model omitted keeps
 * its original relative position at the end. A reranker that loses a tab is worse
 * than one that declines, so nothing is ever removed — this can only reorder.
 */
export function parseRerankOrder(raw: string, validIds: readonly string[]): string[] {
  const valid = new Set(validIds);
  const ordered: string[] = [];
  const consider = (value: unknown): void => {
    if (typeof value !== "string") return;
    const id = value.trim();
    if (valid.has(id) && !ordered.includes(id)) ordered.push(id);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: fall back to scanning the text for identifiers the model echoed.
    for (const line of raw.split(/[\s,]+/)) consider(line.replace(/^["'\[{]+|["'\]}]+$/g, ""));
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    const list = Array.isArray(parsed) ? parsed : (parsed as { order?: unknown }).order;
    if (Array.isArray(list)) list.forEach(consider);
  }
  return [...ordered, ...validIds.filter((id) => !ordered.includes(id))];
}

/** Applies an id order to results, keeping any result the order did not mention. */
export function applyRerankOrder<T extends { mappingKey: string }>(
  results: readonly T[],
  order: readonly string[],
): T[] {
  const byKey = new Map(results.map((result) => [result.mappingKey, result]));
  const reordered = order.flatMap((id) => {
    const result = byKey.get(id);
    return result ? [result] : [];
  });
  for (const result of results) {
    if (!order.includes(result.mappingKey)) reordered.push(result);
  }
  return reordered;
}

export interface RerankDependencies {
  request?: typeof requestGenericChatCompletion;
  now?: () => number;
}

/**
 * Runs the rerank, or gives up and returns the original order.
 *
 * Every failure path returns the input unchanged: a search that already has results
 * must not lose them to an optional second opinion, and the caller has no error to
 * show for something the user never asked to see.
 */
export async function rerankSemanticResults(options: {
  query: string;
  results: readonly SemanticQueryResult[];
  candidates: readonly RerankCandidate[];
  config: GenericChatCompletionRequest["config"];
  apiKey: string;
  signal?: AbortSignal;
  /** Overrides the production budget; tests inject a shorter deadline to keep runs fast. */
  deadlineMs?: number;
  dependencies?: RerankDependencies;
}): Promise<{ results: SemanticQueryResult[]; reranked: boolean; latencyMs: number; reason: string | null }> {
  const now = options.dependencies?.now ?? Date.now;
  const request = options.dependencies?.request ?? requestGenericChatCompletion;
  const startedAt = now();
  const byKey = new Map(options.results.map((result) => [result.mappingKey, result]));
  const considered = options.candidates
    .filter((candidate) => byKey.has(candidate.id))
    .slice(0, SEMANTIC_RERANK_CANDIDATES);
  if (considered.length < 2) {
    return { results: [...options.results], reranked: false, latencyMs: 0, reason: "too_few_candidates" };
  }
  try {
    const raw = await request({
      config: options.config,
      apiKey: options.apiKey,
      messages: buildRerankMessages(options.query, considered),
      json: true,
      usageTask: "search",
      deadlineAt: now() + (options.deadlineMs ?? SEMANTIC_RERANK_DEADLINE_MS),
      signal: options.signal,
    });
    const order = parseRerankOrder(raw, considered.map((candidate) => candidate.id));
    const results = applyRerankOrder(options.results, order);
    return {
      results,
      reranked: results.some((result, index) => result !== options.results[index]),
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
      reason: null,
    };
  } catch (error) {
    return {
      results: [...options.results],
      reranked: false,
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
      reason: error instanceof Error ? error.message : "rerank_failed",
    };
  }
}
