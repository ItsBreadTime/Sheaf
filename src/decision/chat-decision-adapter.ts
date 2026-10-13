import type { ChoiceAnswer, ChoiceQuestion, DecisionQuestion, NoulAnswer } from "./types";

/**
 * Wire adapter B: any OpenAI-compatible chat model. Each question becomes one
 * chat request whose options carry single-character labels. With logprobs the
 * distribution is a softmax over the label tokens; without them the model
 * answers `{ choice, confidence }` and a per-model table turns the bucket into
 * a probability.
 */

const CHAT_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const MAX_CHAT_OPTIONS = CHAT_LABELS.length;
const TOP_LOGPROBS = 20;

export type ConfidenceBucket = "high" | "medium" | "low";
export type ConfidenceTable = Record<ConfidenceBucket, number>;

/** Conservative until the filing benchmark measures a model. */
const DEFAULT_CONFIDENCE_TABLE: ConfidenceTable = { high: 0.9, medium: 0.6, low: 0.3 };

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatChoicePrompt {
  messages: ChatMessage[];
  /** Label → option key, in the order shown. */
  labels: Record<string, string>;
  /** Body fields beyond model and messages. */
  body: Record<string, unknown>;
}

/** A `noul` question is sent as a two-option choice. */
function noulAsChoice(question: DecisionQuestion): ChoiceQuestion {
  if (question.type === "choice") return question;
  return {
    type: "choice",
    instructions: question.instructions,
    criteria: {
      yes: question.criteria?.true ?? "yes",
      no: question.criteria?.false ?? "no",
    },
  };
}

function optionLines(question: ChoiceQuestion): { lines: string[]; labels: Record<string, string> } {
  const options = Object.keys(question.criteria);
  if (options.length > MAX_CHAT_OPTIONS) {
    throw new Error(`Chat decisions support at most ${MAX_CHAT_OPTIONS} options; got ${options.length}.`);
  }
  const labels: Record<string, string> = {};
  const lines = options.map((option, index) => {
    const label = CHAT_LABELS[index] as string;
    labels[label] = option;
    const description = question.criteria[option];
    return `${label}: ${option}${description ? ` — ${description}` : ""}`;
  });
  return { lines, labels };
}

function userContent(state: unknown, question: ChoiceQuestion, lines: string[], answer: string): string {
  const stateText = typeof state === "string" ? state : JSON.stringify(state);
  return `State:\n${stateText}\n\nQuestion: ${question.instructions}\n\nOptions:\n${lines.join("\n")}\n\n${answer}`;
}

export function buildChatLogprobPrompt(state: unknown, question: DecisionQuestion): ChatChoicePrompt {
  const choice = noulAsChoice(question);
  const { lines, labels } = optionLines(choice);
  return {
    labels,
    messages: [
      { role: "system", content: "You are a careful classifier. Reply with exactly one option label and nothing else." },
      { role: "user", content: userContent(state, choice, lines, "Answer with the option label only.") },
    ],
    body: { max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: TOP_LOGPROBS },
  };
}

export function buildChatConfidencePrompt(state: unknown, question: DecisionQuestion): ChatChoicePrompt {
  const choice = noulAsChoice(question);
  const { lines, labels } = optionLines(choice);
  return {
    labels,
    messages: [
      {
        role: "system",
        content: "You are a careful classifier. Reply with a JSON object only: " +
          '{"choice": "<option label>", "confidence": "high" | "medium" | "low"}.',
      },
      { role: "user", content: userContent(state, choice, lines, "Reply with the JSON object only.") },
    ],
    body: { temperature: 0, response_format: { type: "json_object" } },
  };
}

interface TopLogprob {
  token?: unknown;
  logprob?: unknown;
}

function firstTokenTopLogprobs(response: unknown): TopLogprob[] | null {
  const choice = (response as { choices?: Array<{ logprobs?: { content?: Array<{ top_logprobs?: unknown }> } }> })
    ?.choices?.[0];
  const top = choice?.logprobs?.content?.[0]?.top_logprobs;
  return Array.isArray(top) && top.length > 0 ? top as TopLogprob[] : null;
}

/**
 * Softmax over the label tokens, limited to valid labels and renormalized.
 * Tokens that differ only by surrounding whitespace count for the same label;
 * a label missing from the top list gets the smallest probability observed.
 * Returns null when the response has no logprobs.
 */
export function distributionFromLogprobs(
  response: unknown,
  labels: Record<string, string>,
): Record<string, number> | null {
  const top = firstTokenTopLogprobs(response);
  if (!top) return null;
  const mass: Record<string, number> = {};
  let smallest = Infinity;
  for (const entry of top) {
    if (typeof entry.token !== "string" || typeof entry.logprob !== "number" || !Number.isFinite(entry.logprob)) continue;
    const probability = Math.exp(entry.logprob);
    smallest = Math.min(smallest, probability);
    const label = entry.token.trim();
    if (label in labels) mass[label] = (mass[label] ?? 0) + probability;
  }
  if (Object.keys(mass).length === 0) return null;
  const floor = Number.isFinite(smallest) ? smallest : 0;
  const probabilities: Record<string, number> = {};
  for (const [label, option] of Object.entries(labels)) probabilities[option] = mass[label] ?? floor;
  return normalized(probabilities);
}

function normalized(probabilities: Record<string, number>): Record<string, number> {
  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return probabilities;
  return Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [key, value / total]));
}

function assistantText(response: unknown): string {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/**
 * Parses a `{ choice, confidence }` answer. The chosen option gets the table's
 * probability and the remainder is spread evenly, so the margin over the second
 * option is meaningful to the policy. Returns null for an unusable answer.
 */
export function distributionFromConfidence(
  response: unknown,
  labels: Record<string, string>,
  table: ConfidenceTable = DEFAULT_CONFIDENCE_TABLE,
): Record<string, number> | null {
  const text = assistantText(response).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const label = typeof record.choice === "string" ? record.choice.trim() : "";
  const bucket = typeof record.confidence === "string" ? record.confidence.trim().toLowerCase() : "";
  const option = labels[label];
  if (!option || !(bucket in table)) return null;
  const top = table[bucket as ConfidenceBucket];
  const options = Object.values(labels);
  const rest = options.length > 1 ? (1 - top) / (options.length - 1) : 0;
  return Object.fromEntries(options.map((key) => [key, key === option ? top : rest]));
}

export function choiceAnswer(
  probabilities: Record<string, number>,
  source: ChoiceAnswer["source"],
): ChoiceAnswer {
  const entries = Object.entries(probabilities);
  const choice = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best), entries[0] ?? ["", 0])[0];
  return { type: "choice", choice, probabilities, source };
}

export function noulAnswer(answer: ChoiceAnswer): NoulAnswer {
  return { type: "noul", noul: answer.probabilities.yes ?? 0, source: answer.source };
}
