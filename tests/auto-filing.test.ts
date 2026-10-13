import { describe, expect, it } from "vitest";
import { decideBatch, filingRequest, prepareFilingBatch, type FilingBatchInput } from "../src/decision/cascade";
import { requestDecisions, validateDecisionExtraBody, type DecisionConnection } from "../src/decision/decision-client";
import { probeDecisionModel } from "../src/decision/connection-probe";
import {
  crossWindowAllowed,
  DEFAULT_FILING_THRESHOLDS,
  normalizeFilingThresholds,
  presetThresholds,
} from "../src/decision/filing-policy";
import { fileQuestionId, fitsQuestionId, NONE_OPTION, REORGANIZE_QUESTION, STAY_OPTION } from "../src/decision/filing-state";
import { emptyTabSiteState, siteOf, triggerFor, underRateLimit } from "../src/decision/filing-triggers";
import type { DecisionAnswers } from "../src/decision/types";
import { normalizeOrganizerRules, sanitizeOrganizerRules } from "../src/organizer/rules";
import { mergeCalibrations, parseAutoFilingSettings, parseCalibration, parseCalibrationImport } from "../src/storage/auto-filing";
import { createSettingsBackup, parseSettingsBackup } from "../src/storage/settings-backup";
import { DEFAULT_PRIVACY_SETTINGS, DEFAULT_PROVIDER_CONFIG, DEFAULT_WORKFLOW_SETTINGS } from "../src/storage/organizer-state";
import { DEFAULT_AUTO_FILING_SETTINGS } from "../src/shared/auto-filing-types";
// @ts-expect-error The benchmark library is plain JavaScript.
import { CALIBRATION_FORMAT, filingCalibrations } from "../scripts/lib/filing-eval.mjs";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../src/shared/types";

function tab(id: number, url: string, title: string, groupId = -1, extra: Partial<SemanticTab> = {}): SemanticTab {
  return {
    id,
    windowId: 1,
    index: id,
    title,
    url,
    groupId,
    active: false,
    pinned: false,
    audible: false,
    openerTabId: null,
    lastAccessed: null,
    splitView: { known: true, value: -1 },
    protectionReasons: [],
    ...extra,
  };
}

function group(runtimeId: number, title: string, memberTabIds: number[], extra: Partial<SemanticGroup> = {}): SemanticGroup {
  return {
    runtimeId,
    windowId: 1,
    title,
    color: "blue",
    collapsed: false,
    shared: { known: true, value: false },
    memberTabIds,
    firstTabIndex: memberTabIds[0] ?? -1,
    protectionReasons: [],
    ...extra,
  };
}

function windowState(tabs: SemanticTab[], groups: SemanticGroup[], windowId = 1): SemanticWindowState {
  return {
    windowId,
    capturedAt: 0,
    tabs: tabs.map((item) => ({ ...item, windowId })),
    groups: groups.map((item) => ({ ...item, windowId })),
    eligibleTabIds: tabs.map((item) => item.id),
    protectedTabIds: [],
    featureSupport: { sharedGroupProperty: true, splitViewIdProperty: true, storageSession: true },
  };
}

const source = windowState([
  tab(1, "https://booking.com/lisbon", "Lisbon hotels", 10),
  tab(2, "https://www.tap.pt/flights", "TAP flight to Lisbon", 10),
  tab(3, "https://github.com/acme/app/pull/12", "PR #12 · acme/app", 20),
  tab(4, "https://pasteisdebelem.pt/", "Pastéis de Belém opening hours"),
  tab(5, "https://www.youtube.com/watch?v=x", "Some video", 20),
], [group(10, "Lisbon Trip", [1, 2]), group(20, "Reviews", [3, 5])]);

function batch(overrides: Partial<FilingBatchInput> = {}): FilingBatchInput {
  return {
    source,
    otherWindows: [],
    tabIds: [4],
    regroupTabIds: new Set(),
    privacy: DEFAULT_PRIVACY_SETTINGS,
    rules: [],
    optedOutGroupTitles: [],
    refileGroupedTabs: true,
    askReorganize: false,
    maxOptions: 255,
    style: "text",
    ...overrides,
  };
}

const choice = (probabilities: Record<string, number>): DecisionAnswers[string] => ({
  type: "choice",
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0],
  probabilities,
  source: "native",
});
const noul = (value: number): DecisionAnswers[string] => ({ type: "noul", noul: value, source: "native" });

describe("filing cascade", () => {
  it("asks the model about an ungrouped tab with opaque keys and sanitized group evidence", () => {
    const prepared = prepareFilingBatch(batch());
    expect(prepared.candidates.map((candidate) => candidate.tabId)).toEqual([4]);
    expect([...prepared.groups.values()].map((target) => target.groupId)).toEqual([10, 20]);
    const request = filingRequest(prepared)!;
    expect(Object.keys(request.questions)).toEqual([fileQuestionId("t1"), fitsQuestionId("t1")]);
    expect(JSON.stringify(request)).not.toContain("\"10\"");
    // The candidate's own title is never a sample title of a group.
    expect(String(request.state)).toContain("Lisbon hotels");
  });

  it("files a confident tab and abstains on a borderline one", () => {
    const prepared = prepareFilingBatch(batch());
    const confident = decideBatch(prepared, {
      [fileQuestionId("t1")]: choice({ g1: 0.96, g2: 0.01, none: 0.03 }),
      [fitsQuestionId("t1")]: noul(0.9),
    }, DEFAULT_FILING_THRESHOLDS.balanced);
    expect(confident.actions).toEqual([expect.objectContaining({ kind: "file", tabId: 4, fromGroupId: null, crossWindow: false })]);
    expect(confident.actions[0]).toMatchObject({ target: { groupId: 10, title: "Lisbon Trip" } });
    const borderline = decideBatch(prepared, {
      [fileQuestionId("t1")]: choice({ g1: 0.7, g2: 0.1, none: 0.2 }),
      [fitsQuestionId("t1")]: noul(0.9),
    }, DEFAULT_FILING_THRESHOLDS.balanced);
    expect(borderline.actions).toEqual([]);
    expect(borderline.abstainedUngrouped).toEqual([4]);
  });

  it("abstains when the fits gate disagrees", () => {
    const prepared = prepareFilingBatch(batch());
    const outcome = decideBatch(prepared, {
      [fileQuestionId("t1")]: choice({ g1: 0.96, g2: 0.01, none: 0.03 }),
      [fitsQuestionId("t1")]: noul(0.2),
    }, DEFAULT_FILING_THRESHOLDS.balanced);
    expect(outcome.actions).toEqual([]);
    expect(outcome.reasons).toEqual(["low_fit"]);
  });

  it("never offers or moves members of opted-out, protected, or shared groups", () => {
    const shared = windowState(source.tabs, [
      group(10, "Lisbon Trip", [1, 2], { protectionReasons: ["Shared group"] }),
      group(20, "Reviews", [3, 5]),
    ]);
    const prepared = prepareFilingBatch(batch({ source: shared, optedOutGroupTitles: ["reviews"], tabIds: [4, 5], regroupTabIds: new Set([5]) }));
    expect(prepared.groups.size).toBe(0);
    expect(prepared.input).toBeNull();
    expect(prepared.skipped).toEqual(expect.arrayContaining([
      { tabId: 5, reason: "group_ineligible" },
      { tabId: 4, reason: "no_groups" },
    ]));
  });

  it("re-files a drifted grouped tab only with re-filing on, with stay first and no fits gate", () => {
    expect(prepareFilingBatch(batch({ tabIds: [5], regroupTabIds: new Set([5]), refileGroupedTabs: false })).input).toBeNull();
    const prepared = prepareFilingBatch(batch({ tabIds: [5], regroupTabIds: new Set([5]) }));
    const request = filingRequest(prepared)!;
    const question = request.questions[fileQuestionId("t1")];
    expect(Object.keys(question?.type === "choice" ? question.criteria : {})).toEqual([STAY_OPTION, "g1", NONE_OPTION]);
    expect(request.questions[fitsQuestionId("t1")]).toBeUndefined();
    const out = decideBatch(prepared, { [fileQuestionId("t1")]: choice({ stay: 0.02, g1: 0.01, none: 0.97 }) }, DEFAULT_FILING_THRESHOLDS.balanced);
    expect(out.actions).toEqual([expect.objectContaining({ kind: "ungroup", tabId: 5, fromGroupId: 20 })]);
    const stays = decideBatch(prepared, { [fileQuestionId("t1")]: choice({ stay: 0.15, g1: 0.05, none: 0.8 }) }, DEFAULT_FILING_THRESHOLDS.balanced);
    expect(stays.actions).toEqual([]);
    expect(stays.abstainedGrouped).toEqual([5]);
  });

  it("files by rule without the model, and honours keep and never-file rules", () => {
    const rules = normalizeOrganizerRules([
      { id: "a", kind: "assign_location", locationPattern: "pasteisdebelem.pt/*", groupName: "lisbon trip" },
    ]);
    const prepared = prepareFilingBatch(batch({ rules }));
    expect(prepared.input).toBeNull();
    expect(prepared.ruleActions).toEqual([expect.objectContaining({ kind: "file", source: "rule", confidence: 1 })]);
    expect(decideBatch(prepared, null, DEFAULT_FILING_THRESHOLDS.balanced).actions).toHaveLength(1);

    const keep = prepareFilingBatch(batch({ rules: [...rules, { id: "k", kind: "keep_location", locationPattern: "pasteisdebelem.pt/*" }] }));
    expect(keep.ruleActions).toEqual([]);
    expect(keep.skipped).toEqual([{ tabId: 4, reason: "excluded" }]);

    const neverAnywhere = prepareFilingBatch(batch({ rules: [{ id: "n", kind: "never_file_location", locationPattern: "pasteisdebelem.pt/*" }] }));
    expect(neverAnywhere.skipped).toEqual([{ tabId: 4, reason: "rule" }]);

    const neverHere = prepareFilingBatch(batch({ rules: [{ id: "n", kind: "never_file_location", locationPattern: "pasteisdebelem.pt/*", groupName: "Lisbon Trip" }] }));
    const outcome = decideBatch(neverHere, {
      [fileQuestionId("t1")]: choice({ g1: 0.98, g2: 0.01, none: 0.01 }),
      [fitsQuestionId("t1")]: noul(0.95),
    }, DEFAULT_FILING_THRESHOLDS.balanced);
    expect(outcome.actions).toEqual([]);
    expect(outcome.reasons).toEqual(["rule"]);
  });

  it("leaves group names out when existing groups may not be sent", () => {
    const prepared = prepareFilingBatch(batch({ privacy: { ...DEFAULT_PRIVACY_SETTINGS, includeExistingGroups: false } }));
    expect(JSON.stringify(filingRequest(prepared))).not.toContain("Lisbon Trip");
  });

  it("does not send titles of tabs the privacy policy excludes", () => {
    const prepared = prepareFilingBatch(batch({ privacy: { ...DEFAULT_PRIVACY_SETTINGS, denylist: ["booking.com"] } }));
    expect(JSON.stringify(filingRequest(prepared))).not.toContain("Lisbon hotels");
  });

  it("requires an extra margin for a group in another window", () => {
    const other = windowState([
      tab(30, "https://pasteisdebelem.pt/menu", "Menu", 40),
      tab(31, "https://pasteisdebelem.pt/history", "History", 40),
    ], [group(40, "Pastries", [30, 31])], 2);
    const prepared = prepareFilingBatch(batch({ otherWindows: [other] }));
    expect([...prepared.groups.values()].map((target) => target.windowId)).toEqual([1, 1, 2]);
    const answers = (top: number) => ({
      [fileQuestionId("t1")]: choice({ g1: (1 - top) / 2, g2: 0, g3: top, none: (1 - top) / 2 }),
      [fitsQuestionId("t1")]: noul(0.95),
    });
    expect(decideBatch(prepared, answers(0.88), DEFAULT_FILING_THRESHOLDS.balanced).actions).toEqual([]);
    expect(decideBatch(prepared, answers(0.95), DEFAULT_FILING_THRESHOLDS.balanced).actions)
      .toEqual([expect.objectContaining({ crossWindow: true, target: expect.objectContaining({ windowId: 2 }) })]);
  });

  it("caps the option list for chat labels, keeping same-window groups", () => {
    const many = Array.from({ length: 60 }, (_, index) => group(100 + index, `G${index}`, [200 + index]));
    const tabs = [tab(4, "https://example.com/", "Example"), ...many.map((item, index) => tab(200 + index, `https://site${index}.com/`, `Page ${index}`, item.runtimeId))];
    const prepared = prepareFilingBatch(batch({ source: windowState(tabs, many), maxOptions: 52 }));
    expect(prepared.groups.size).toBe(50);
  });

  it("reads the reorganize question when escalation is on", () => {
    const prepared = prepareFilingBatch(batch({ askReorganize: true }));
    expect(filingRequest(prepared)!.questions[REORGANIZE_QUESTION]?.type).toBe("noul");
    const outcome = decideBatch(prepared, {
      [fileQuestionId("t1")]: choice({ g1: 0.2, g2: 0.1, none: 0.7 }),
      [fitsQuestionId("t1")]: noul(0.1),
      [REORGANIZE_QUESTION]: noul(0.8),
    }, DEFAULT_FILING_THRESHOLDS.balanced);
    expect(outcome.reorganize).toBe(0.8);
    expect(outcome.abstainedUngrouped).toEqual([4]);
  });
});

describe("filing triggers", () => {
  it("uses the registrable domain", () => {
    expect(siteOf("https://docs.github.com/en")).toBe("github.com");
    expect(siteOf("chrome://newtab/")).toBeNull();
  });

  it("decides an ungrouped tab once per site and a grouped tab only on a site change", () => {
    const state = { ...emptyTabSiteState(), site: "github.com", decidedSite: "github.com" };
    expect(triggerFor(state, false, "github.com")).toBeNull();
    expect(triggerFor(state, false, "youtube.com")).toBe("ungrouped");
    expect(triggerFor(state, true, "github.com")).toBeNull();
    expect(triggerFor({ ...state, decidedSite: null }, true, "youtube.com")).toBe("regroup");
    expect(triggerFor({ ...emptyTabSiteState() }, true, "youtube.com")).toBeNull();
  });

  it("treats a tab Chrome grouped with its opener as drifted once it leaves the opener's site", () => {
    const joined = { ...emptyTabSiteState(), openerSite: "arxiv.org" };
    expect(triggerFor(joined, true, "arxiv.org")).toBeNull();
    expect(triggerFor(joined, true, "youtube.com")).toBe("regroup");
  });

  it("rate-limits filings per minute", () => {
    expect(underRateLimit([1_000, 2_000], 30_000, 3)).toBe(true);
    expect(underRateLimit([1_000, 2_000, 3_000], 30_000, 3)).toBe(false);
    expect(underRateLimit([1_000, 2_000, 3_000], 70_000, 3)).toBe(true);
  });
});

describe("filing thresholds", () => {
  it("uses Conservative for an uncalibrated model whatever the preset", () => {
    expect(presetThresholds("eager", null)).toEqual(DEFAULT_FILING_THRESHOLDS.conservative);
  });

  it("makes a calibration the Balanced preset and shifts the others around it", () => {
    const calibration = { apply: 0.8, margin: 0, fit: 0.3, applyGrouped: 0.9, stay: 0.1 };
    expect(presetThresholds("balanced", calibration)).toEqual(calibration);
    const conservative = presetThresholds("conservative", calibration);
    const eager = presetThresholds("eager", calibration);
    expect(conservative.apply).toBeGreaterThan(calibration.apply);
    expect(conservative.stay).toBeLessThan(calibration.stay);
    expect(eager.apply).toBeLessThan(calibration.apply);
    expect(eager.stay).toBeGreaterThan(calibration.stay);
  });

  it("rejects implausible calibrations", () => {
    expect(normalizeFilingThresholds({ apply: 0.2, margin: 0, applyGrouped: 0.9, stay: 0.1 })).toBeNull();
    expect(normalizeFilingThresholds({ apply: 0.9, margin: 0.1, applyGrouped: 0.9, stay: 0.1, fit: null }))
      .toEqual({ apply: 0.9, margin: 0.1, fit: null, applyGrouped: 0.9, stay: 0.1 });
  });

  it("allows a cross-window target only above the raised bar and the same-window margin", () => {
    const thresholds = DEFAULT_FILING_THRESHOLDS.balanced;
    expect(crossWindowAllowed({ g1: 0.05, g3: 0.92 }, "g3", new Set(["g1"]), thresholds, false)).toBe(true);
    expect(crossWindowAllowed({ g1: 0.05, g3: 0.88 }, "g3", new Set(["g1"]), thresholds, false)).toBe(false);
  });
});

describe("decision client", () => {
  const connection: DecisionConnection = {
    protocol: "decision_api",
    origin: "http://localhost:8787",
    endpointPath: "/v1/systemone",
    model: "any-model",
    apiKey: "test",
    customHeaders: {},
    extraBody: {},
    timeoutMs: 5_000,
    disableReasoning: false,
  };

  it("posts the decision API body and renormalizes answers", async () => {
    let sent: unknown = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ answers: { file_t1: { choice: "g1", probabilities: { g1: 0.49, g2: 0.01, none: 0.49 } } } }));
    }) as typeof fetch;
    const result = await probeDecisionModel(connection, { fetchImpl });
    expect(sent).toMatchObject({ model: "any-model", questions: { file_t1: { type: "choice" } } });
    expect(result.probabilities).toBe("native");
  });

  it("turns 429 into a backoff and names the field a 422 rejects", async () => {
    const limited = (async () => new Response("{}", { status: 429, headers: { "retry-after": "12" } })) as typeof fetch;
    await expect(probeDecisionModel(connection, { fetchImpl: limited })).rejects.toMatchObject({ name: "DecisionBackoffError", delayMs: 12_000 });
    const invalid = (async () => new Response(JSON.stringify({ error: { message: JSON.stringify([{ path: ["questions", "file_t1", "criteria"] }]) } }), { status: 422 })) as typeof fetch;
    await expect(probeDecisionModel(connection, { fetchImpl: invalid })).rejects.toThrow("questions.file_t1.criteria");
  });

  it("reads label logprobs over chat, and falls back to a bucketed answer without them", async () => {
    const chat = { ...connection, protocol: "chat" as const, endpointPath: "/v1/chat/completions" };
    const withLogprobs = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "A" }, logprobs: { content: [{ top_logprobs: [{ token: "A", logprob: Math.log(0.9) }, { token: "C", logprob: Math.log(0.1) }] }] } }],
    }))) as typeof fetch;
    expect((await probeDecisionModel(chat, { fetchImpl: withLogprobs })).probabilities).toBe("logprobs");
    let calls = 0;
    const without = (async (_url: string, init: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init.body)) as { logprobs?: boolean };
      return new Response(JSON.stringify({
        choices: [{ message: { content: body.logprobs ? "A" : "{\"choice\":\"A\",\"confidence\":\"high\"}" } }],
      }));
    }) as typeof fetch;
    const result = await requestDecisions(chat, {
      state: "s",
      questions: { file_t1: { type: "choice", instructions: "q", criteria: { g1: "a", none: "b" } } },
    }, { fetchImpl: without });
    expect(calls).toBe(2);
    expect(result.source).toBe("confidence");
    expect(result.answers.file_t1).toMatchObject({ type: "choice", choice: "g1" });
  });

  it("protects adapter-owned fields in the extra body", () => {
    expect(() => validateDecisionExtraBody("decision_api", { questions: {} })).toThrow("adapter-owned");
    expect(() => validateDecisionExtraBody("chat", { messages: [] })).toThrow("adapter-owned");
    expect(() => validateDecisionExtraBody("decision_api", { routing: "fast" })).not.toThrow();
  });
});

describe("auto-filing settings", () => {
  it("defaults to off, Balanced, Suggest, and no grouped re-filing", () => {
    expect(parseAutoFilingSettings(undefined)).toMatchObject({
      enabled: false,
      refileGroupedTabs: false,
      crossWindow: false,
      confidence: "balanced",
      escalation: "suggest",
      notifyOnFiling: false,
      decisionModel: null,
    });
  });

  it("keeps only valid calibrations", () => {
    expect(parseCalibration({ protocol: "chat", model: "m", thresholds: { apply: 0.9, margin: 0.2, applyGrouped: 0.95, stay: 0.05 } }))
      .toMatchObject({ protocol: "chat", model: "m", style: "text" });
    expect(parseCalibration({ protocol: "other", model: "m", thresholds: {} })).toBeNull();
  });

  it("never sends filing-only rules to the organizer", () => {
    const rules = normalizeOrganizerRules([
      { id: "n", kind: "never_file_location", locationPattern: "youtube.com/*", groupName: "Research" },
      { id: "k", kind: "keep_location", locationPattern: "mail.example.com/*" },
    ]);
    expect(rules).toHaveLength(2);
    expect(sanitizeOrganizerRules(rules)).toEqual([{ kind: "keep_location", locationPattern: "mail.example.com/*" }]);
  });

  it("imports the benchmark's calibration file, and a newer one replaces the same model", () => {
    const thresholds = { apply: 0.9, margin: 0.2, fit: null, applyGrouped: 0.95, stay: 0.05 };
    const file = JSON.stringify({
      format: "sheaf-filing-calibrations",
      calibrations: [
        { protocol: "decision_api", model: "Decider", style: "text", thresholds, meetsGate: true },
        { protocol: "decision_api", model: "broken", thresholds: { apply: 0.1 } },
      ],
    });
    const imported = parseCalibrationImport(file);
    expect(imported).toEqual([{ protocol: "decision_api", model: "Decider", style: "text", thresholds }]);
    const older = { protocol: "decision_api" as const, model: "decider", style: "json" as const, thresholds: { ...thresholds, apply: 0.8 } };
    const other = { protocol: "chat" as const, model: "decider", style: "text" as const, thresholds };
    expect(mergeCalibrations([older, other], imported)).toEqual([imported[0], other]);
    expect(() => parseCalibrationImport("[]")).toThrow(/no calibration/);
    expect(() => parseCalibrationImport("{")).toThrow(/not valid JSON/);
  });

  it("backs up filing settings without header values or extra body, and restores them switched off", () => {
    const autoFiling = {
      ...DEFAULT_AUTO_FILING_SETTINGS,
      enabled: true,
      escalation: "organize" as const,
      optedOutGroupTitles: ["Banking"],
      decisionModel: {
        protocol: "decision_api" as const,
        origin: "https://decisions.example",
        endpointPath: "/v1/systemone",
        model: "decider",
        customHeaders: { "x-token": "secret" },
        extraBody: { api_key: "secret" },
        useOrganizerConnection: false,
        apiKeyStorage: "persistent" as const,
        disableReasoning: false,
        timeoutMs: 10_000,
      },
    };
    const backup = createSettingsBackup({
      local: {
        provider: { ...DEFAULT_PROVIDER_CONFIG, model: "m" },
        privacy: DEFAULT_PRIVACY_SETTINGS,
        workflow: DEFAULT_WORKFLOW_SETTINGS,
        customOrganizerPrompt: null,
        organizerRules: [],
        groupNamePreferences: [],
        connectionTest: null,
        persistentApiKey: null,
      },
      diagnosticPricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      autoFiling,
    });
    expect(JSON.stringify(backup)).not.toContain("secret");
    const restored = parseSettingsBackup(JSON.stringify(backup)).autoFiling;
    expect(restored).toMatchObject({
      enabled: false,
      escalation: "suggest",
      optedOutGroupTitles: ["Banking"],
      decisionModel: { model: "decider", origin: "https://decisions.example", apiKeyStorage: "session", customHeaders: {}, extraBody: {} },
    });
  });

  it("exports benchmark recommendations in the format the extension imports", () => {
    const fold = {
      ungrouped: { test: { falseFileRate: 0.01, wrongGroupRate: 0.01, fileAccuracy: 0.9 } },
      grouped: { test: { falseMoveOutRate: 0.016, driftWrongRate: 0 } },
    };
    const exported = filingCalibrations({
      generatedAt: "2026-10-11T00:00:00.000Z",
      candidates: [
        {
          protocol: "decision_api", model: "decider", style: "text",
          recommended: { apply: 0.8, margin: 0.2, fit: 0.5, applyGrouped: 0.9, stay: 0.1, marginGrouped: 0.4 },
          crossValidated: [fold, fold], casesScored: 10,
        },
        { protocol: "embedding", model: "embed", recommended: { apply: 0.8 } },
        { protocol: "chat", model: "small", recommended: null },
      ],
    });
    expect(exported.format).toBe(CALIBRATION_FORMAT);
    expect(exported.calibrations).toHaveLength(1);
    expect(exported.calibrations[0]).toMatchObject({ meetsGate: true, refileMeetsGate: false, thresholds: { margin: 0.4 } });
    expect(parseCalibrationImport(JSON.stringify(exported))).toEqual([{
      protocol: "decision_api",
      model: "decider",
      style: "text",
      thresholds: { apply: 0.8, margin: 0.4, fit: 0.5, applyGrouped: 0.9, stay: 0.1 },
    }]);
  });
});
