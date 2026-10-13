import type { DecisionProbeResult } from "../shared/auto-filing-types";
import { requestDecisions, type DecisionConnection, type DecisionRequestOptions } from "./decision-client";
import type { DecisionRequest } from "./types";

/**
 * "Save and verify": one choice question with an obvious answer. It checks
 * that the protocol works, whether probabilities come back (native or from
 * logprobs), and the latency. Nothing from the user's tabs is sent.
 */
const PROBE_REQUEST: DecisionRequest = {
  state: "Existing tab groups:\nGroup g1 \"Recipes\" — sites: example.com\n  - Lemon tart recipe\n" +
    "Group g2 \"Taxes\" — sites: example.org\n  - Filing deadline checklist\n\n" +
    "Tabs to place:\nTab t1: \"Shortcrust pastry recipe\" on example.com",
  questions: {
    file_t1: {
      type: "choice",
      instructions: "Which existing tab group is tab t1 part of, if any?",
      criteria: {
        g1: "the \"Recipes\" group",
        g2: "the \"Taxes\" group",
        none: "doesn't clearly belong to any existing group",
      },
    },
  },
};

export async function probeDecisionModel(
  connection: DecisionConnection,
  options: DecisionRequestOptions = {},
): Promise<DecisionProbeResult> {
  const now = options.now ?? Date.now;
  const result = await requestDecisions(connection, PROBE_REQUEST, { ...options, usageTask: null });
  if (result.answers.file_t1?.type !== "choice") throw new Error("The decision model did not answer the probe question.");
  return {
    testedAt: now(),
    protocol: connection.protocol,
    model: connection.model,
    latencyMs: Math.round(result.latencyMs),
    probabilities: result.source,
  };
}
