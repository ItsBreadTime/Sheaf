/**
 * The internal decision request. A decision model reads one shared `state` and
 * answers every question with a probability distribution instead of text. Both
 * wire protocols (the decision API and chat completions) are built from this
 * shape; only the adapter differs.
 */

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option key → description. Insertion order is the order shown to the model. */
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export type DecisionQuestion = ChoiceQuestion | NoulQuestion;

export interface DecisionRequest {
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

/**
 * Where a distribution came from. `native` is a decision-API answer, `logprobs`
 * is a softmax over chat label tokens, and `confidence` is a bare chat answer
 * mapped through a per-model confidence table.
 */
export type ProbabilitySource = "native" | "logprobs" | "confidence";

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  /** Every option of the question, summing to 1. */
  probabilities: Record<string, number>;
  source: ProbabilitySource;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability of yes. */
  noul: number;
  source: ProbabilitySource;
}

export type DecisionAnswer = ChoiceAnswer | NoulAnswer;

export type DecisionAnswers = Record<string, DecisionAnswer>;

export type DecisionProtocol = "decision_api" | "chat";

export const DEFAULT_DECISION_ENDPOINT_PATH = "/v1/systemone";
