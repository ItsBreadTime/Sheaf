import { describe, expect, it } from "vitest";
import {
  buildChatConfidencePrompt,
  buildChatLogprobPrompt,
  distributionFromConfidence,
  distributionFromLogprobs,
} from "../src/decision/chat-decision-adapter";
import {
  decisionApiBody,
  decisionValidationField,
  parseDecisionApiAnswers,
} from "../src/decision/decision-api-adapter";
import {
  clearFromBacklog,
  emptyEscalationState,
  ESCALATION_COOLDOWN_MS,
  markEscalated,
  recordAbstention,
  shouldEscalate,
} from "../src/decision/escalation";
import { appendFilingLog, FILING_LOG_LIMIT, planFilingUndo } from "../src/decision/filing-log";
import { DEFAULT_FILING_THRESHOLDS, decideFiling } from "../src/decision/filing-policy";
import {
  buildFilingDecisionRequest,
  fileQuestionId,
  filingDistribution,
  fitsQuestionId,
  memberQuestionId,
  NONE_OPTION,
  STAY_OPTION,
} from "../src/decision/filing-state";

const groups = [
  { key: "g1", name: "Lisbon Trip", sites: ["booking.com"], sampleTitles: ["Lisbon hotels"] },
  { key: "g2", name: "Reviews", sites: ["github.com"], sampleTitles: ["PR #12"] },
];

describe("filing decision request", () => {
  it("asks a choice with none last and a fits gate for an ungrouped tab", () => {
    const request = buildFilingDecisionRequest({
      groups,
      tabs: [{ key: "t1", title: "Belém opening hours", site: "pasteisdebelem.pt", currentGroupKey: null }],
      askFits: true,
    });
    const file = request.questions[fileQuestionId("t1")];
    expect(file?.type).toBe("choice");
    expect(Object.keys(file?.type === "choice" ? file.criteria : {})).toEqual(["g1", "g2", NONE_OPTION]);
    expect(request.questions[fitsQuestionId("t1")]?.type).toBe("noul");
  });

  it("puts stay first and leaves out the current group for a drifted tab", () => {
    const request = buildFilingDecisionRequest({
      groups,
      tabs: [{ key: "t1", title: "YouTube", site: "youtube.com", currentGroupKey: "g2" }],
      style: "json",
    });
    const file = request.questions[fileQuestionId("t1")];
    expect(Object.keys(file?.type === "choice" ? file.criteria : {})).toEqual([STAY_OPTION, "g1", NONE_OPTION]);
    expect(request.state).toMatchObject({ tabs: [{ currentGroup: "g2" }] });
  });

  it("omits group names when they may not be sent", () => {
    const request = buildFilingDecisionRequest({
      groups: [{ ...groups[0]!, name: null }],
      tabs: [{ key: "t1", title: "x", site: "x.com", currentGroupKey: null }],
    });
    expect(JSON.stringify(request)).not.toContain("Lisbon Trip");
  });
});

describe("decision API adapter", () => {
  const request = buildFilingDecisionRequest({
    groups,
    tabs: [{ key: "t1", title: "x", site: "x.com", currentGroupKey: null }],
    askFits: true,
  });

  it("sends instructions and criteria under the model", () => {
    const body = decisionApiBody("jev", request);
    expect(body.model).toBe("jev");
    expect(body.questions).toBe(request.questions);
  });

  it("renormalizes rounded probabilities and fills missing options", () => {
    const answers = parseDecisionApiAnswers({
      answers: {
        file_t1: { type: "choice", choice: "g1", probabilities: { g1: 0.5, none: 0.49 } },
        fits_t1: { type: "noul", noul: 0.4 },
      },
    }, request);
    const file = answers.file_t1;
    expect(file?.type === "choice" && file.probabilities.g2).toBe(0);
    expect(file?.type === "choice" && file.probabilities.g1).toBeCloseTo(0.5 / 0.99);
    expect(answers.fits_t1).toEqual({ type: "noul", noul: 0.4, source: "native" });
  });

  it("rejects a response missing an answer", () => {
    expect(() => parseDecisionApiAnswers({ answers: {} }, request)).toThrow(/missing file_t1/);
  });

  it("names the field a validation error points at", () => {
    const message = JSON.stringify([{ path: ["questions", "file_t1", "criteria"], message: "bad" }]);
    expect(decisionValidationField({ error: { message } })).toBe("questions.file_t1.criteria");
  });
});

describe("chat decision adapter", () => {
  const request = buildFilingDecisionRequest({
    groups,
    tabs: [{ key: "t1", title: "x", site: "x.com", currentGroupKey: null }],
  });
  const question = request.questions[fileQuestionId("t1")]!;

  it("labels options and turns label logprobs into a distribution", () => {
    const prompt = buildChatLogprobPrompt(request.state, question);
    expect(prompt.labels).toEqual({ A: "g1", B: "g2", C: NONE_OPTION });
    expect(prompt.body).toMatchObject({ max_tokens: 1, logprobs: true });
    const response = {
      choices: [{
        logprobs: {
          content: [{
            top_logprobs: [
              { token: "A", logprob: Math.log(0.6) },
              { token: " A", logprob: Math.log(0.1) },
              { token: "C", logprob: Math.log(0.2) },
              { token: "Sorry", logprob: Math.log(0.05) },
            ],
          }],
        },
      }],
    };
    const distribution = distributionFromLogprobs(response, prompt.labels)!;
    // B is missing, so it gets the smallest observed probability (0.05).
    expect(distribution.g1).toBeCloseTo(0.7 / 0.95);
    expect(distribution.g2).toBeCloseTo(0.05 / 0.95);
    expect(distribution.none).toBeCloseTo(0.2 / 0.95);
  });

  it("returns null without logprobs", () => {
    expect(distributionFromLogprobs({ choices: [{ message: { content: "A" } }] }, { A: "g1" })).toBeNull();
  });

  it("maps a confidence bucket through the table", () => {
    const prompt = buildChatConfidencePrompt(request.state, question);
    const response = { choices: [{ message: { content: '{"choice":"B","confidence":"high"}' } }] };
    const distribution = distributionFromConfidence(response, prompt.labels)!;
    expect(distribution.g2).toBe(0.9);
    expect(distribution.g1).toBeCloseTo(0.05);
    expect(distribution.none).toBeCloseTo(0.05);
    expect(distributionFromConfidence({ choices: [{ message: { content: "B" } }] }, prompt.labels)).toBeNull();
  });
});

describe("filing policy", () => {
  const balanced = DEFAULT_FILING_THRESHOLDS.balanced;

  it("files only a confident, clear, fitting top group", () => {
    expect(decideFiling({ probabilities: { g1: 0.9, g2: 0.05, none: 0.05 }, grouped: false, fits: 0.8 }, balanced))
      .toEqual({ action: "file", target: "g1", confidence: 0.9 });
    expect(decideFiling({ probabilities: { g1: 0.9, none: 0.1 }, grouped: false, fits: 0.2 }, balanced))
      .toEqual({ action: "abstain", reason: "low_fit" });
    expect(decideFiling({ probabilities: { g1: 0.6, none: 0.4 }, grouped: false }, balanced))
      .toEqual({ action: "abstain", reason: "low_confidence" });
    expect(decideFiling({ probabilities: { none: 0.95, g1: 0.05 }, grouped: false }, balanced))
      .toEqual({ action: "abstain", reason: "none" });
  });

  it("keeps a grouped tab unless stay is unlikely and the alternative is clear", () => {
    expect(decideFiling({ probabilities: { stay: 0.2, g1: 0.8 }, grouped: true }, balanced))
      .toEqual({ action: "abstain", reason: "stay" });
    expect(decideFiling({ probabilities: { stay: 0.02, g1: 0.95, none: 0.03 }, grouped: true }, balanced))
      .toEqual({ action: "move", target: "g1", confidence: 0.95 });
    expect(decideFiling({ probabilities: { stay: 0.02, none: 0.96, g1: 0.02 }, grouped: true }, balanced))
      .toEqual({ action: "ungroup", confidence: 0.96 });
  });
});

describe("filing log", () => {
  const entry = {
    tabId: 7, windowId: 1, fromGroupId: 10, toGroupId: 20, previousIndex: 3,
    source: "decision_model" as const, confidence: 0.95, at: 1,
    id: "f1", tabTitle: "Tab", site: "example.com", fromGroupTitle: "A", toGroupTitle: "B",
  };

  it("keeps one entry per tab, newest first, capped", () => {
    let log = appendFilingLog([], entry);
    log = appendFilingLog(log, { ...entry, at: 2 });
    expect(log).toHaveLength(1);
    expect(log[0]?.at).toBe(2);
    for (let tabId = 100; tabId < 130; tabId += 1) log = appendFilingLog(log, { ...entry, tabId });
    expect(log).toHaveLength(FILING_LOG_LIMIT);
  });

  it("restores only a tab still where filing put it", () => {
    expect(planFilingUndo(entry, { windowId: 1, groupId: 20 }, new Set([10, 20])))
      .toEqual({ action: "restore", tabId: 7, windowId: 1, groupId: 10, index: 3 });
    expect(planFilingUndo(entry, { windowId: 1, groupId: 30 }, new Set([10])))
      .toEqual({ action: "skip", reason: "moved_since" });
    expect(planFilingUndo(entry, null, new Set())).toEqual({ action: "skip", reason: "tab_closed" });
    expect(planFilingUndo(entry, { windowId: 1, groupId: 20 }, new Set([20])))
      .toEqual({ action: "ungroup", tabId: 7, windowId: 1, index: 3 });
  });
});

describe("escalation", () => {
  it("escalates on backlog or a new topic, outside cooldown and review", () => {
    let state = emptyEscalationState();
    for (const tabId of [1, 2, 3, 4]) state = recordAbstention(state, tabId);
    expect(shouldEscalate(state, { now: 0, reorganize: null, reviewOpen: false })).toBe(false);
    expect(shouldEscalate(state, { now: 0, reorganize: 0.8, reviewOpen: false })).toBe(true);
    state = recordAbstention(state, 5);
    expect(shouldEscalate(state, { now: 0, reorganize: null, reviewOpen: true })).toBe(false);
    expect(shouldEscalate(state, { now: 0, reorganize: null, reviewOpen: false })).toBe(true);
    state = markEscalated(0);
    for (const tabId of [6, 7, 8, 9, 10]) state = recordAbstention(state, tabId);
    expect(shouldEscalate(state, { now: ESCALATION_COOLDOWN_MS - 1, reorganize: null, reviewOpen: false })).toBe(false);
    expect(clearFromBacklog(state, 6).backlog).toEqual([7, 8, 9, 10]);
  });
});

describe("per-group filing questions", () => {
  const tab = { key: "t1", title: "x", site: "x.com", currentGroupKey: "g2" };
  const input = { groups, tabs: [tab], style: "per_group" as const };

  it("asks one yes/no per group over a readable state", () => {
    const request = buildFilingDecisionRequest(input);
    expect(Object.keys(request.questions)).toEqual([memberQuestionId("t1", "g1"), memberQuestionId("t1", "g2")]);
    expect(typeof request.state).toBe("string");
  });

  it("combines independent yes probabilities, mapping the current group to stay", () => {
    const answers = {
      [memberQuestionId("t1", "g1")]: { type: "noul" as const, noul: 0.9, source: "native" as const },
      [memberQuestionId("t1", "g2")]: { type: "noul" as const, noul: 0.1, source: "native" as const },
    };
    const distribution = filingDistribution(answers, input, tab)!;
    // g1 only: 0.9·0.9 = 0.81, g2 only: 0.1·0.1 = 0.01, neither: 0.1·0.9 = 0.09.
    expect(distribution.g1).toBeCloseTo(0.81 / 0.91);
    expect(distribution.stay).toBeCloseTo(0.01 / 0.91);
    expect(distribution.none).toBeCloseTo(0.09 / 0.91);
  });
});
