import type { DecisionAnswers, DecisionRequest } from "./types";

/**
 * Wire adapter A: the decision API. The internal request is already in its
 * shape (`{ model, state, questions }` with `instructions` and `criteria` on
 * every question), so the adapter only adds the model and validates answers.
 */

export function decisionApiBody(
  model: string,
  request: DecisionRequest,
  extraBody: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...extraBody, model, state: request.state, questions: request.questions };
}

export class DecisionResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionResponseError";
  }
}

function finiteProbability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * Normalizes a decision-API response against the questions that were asked.
 * Options missing from `probabilities` count as 0, and the rest are
 * renormalized, because hosted servers round to two decimals.
 */
export function parseDecisionApiAnswers(value: unknown, request: DecisionRequest): DecisionAnswers {
  const answers = value && typeof value === "object"
    ? (value as { answers?: unknown }).answers
    : undefined;
  if (!answers || typeof answers !== "object") throw new DecisionResponseError("Decision response has no answers.");
  const result: DecisionAnswers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = (answers as Record<string, unknown>)[id];
    if (!answer || typeof answer !== "object") throw new DecisionResponseError(`Decision response is missing ${id}.`);
    const record = answer as Record<string, unknown>;
    if (question.type === "noul") {
      const noul = finiteProbability(record.noul);
      if (noul === null) throw new DecisionResponseError(`Decision answer ${id} has no noul probability.`);
      result[id] = { type: "noul", noul, source: "native" };
      continue;
    }
    const raw = record.probabilities && typeof record.probabilities === "object"
      ? record.probabilities as Record<string, unknown>
      : {};
    const options = Object.keys(question.criteria);
    const probabilities = Object.fromEntries(options.map((option) => [option, finiteProbability(raw[option]) ?? 0]));
    const total = Object.values(probabilities).reduce((sum, probability) => sum + probability, 0);
    if (total <= 0) throw new DecisionResponseError(`Decision answer ${id} has no probabilities.`);
    for (const option of options) probabilities[option] = (probabilities[option] ?? 0) / total;
    const choice = options.reduce((best, option) =>
      (probabilities[option] ?? 0) > (probabilities[best] ?? 0) ? option : best, options[0] ?? "");
    result[id] = { type: "choice", choice, probabilities, source: "native" };
  }
  return result;
}

/** The field a 422 names, for diagnostics and the connection test. */
export function decisionValidationField(value: unknown): string | null {
  const message = value && typeof value === "object"
    ? (value as { error?: { message?: unknown } }).error?.message
    : undefined;
  if (typeof message !== "string") return null;
  try {
    const issues = JSON.parse(message) as Array<{ path?: unknown[] }>;
    const path = issues.find((issue) => Array.isArray(issue.path))?.path;
    return path ? path.join(".") : null;
  } catch {
    return null;
  }
}
