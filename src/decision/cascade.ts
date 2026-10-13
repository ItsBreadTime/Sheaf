import { normalizeOrganizerRules, ruleMatchesTab } from "../organizer/rules";
import { providerTabEligibility, providerTabTitle } from "../privacy/request-builder";
import { sanitizeGroupTitleForProvider } from "../privacy/sanitize-text";
import type { OrganizerRule, PrivacySettings } from "../shared/organizer-types";
import type { SemanticGroup, SemanticTab, SemanticWindowState } from "../shared/types";
import { UNGROUPED_GROUP_ID } from "../shared/constants";
import {
  crossWindowAllowed,
  decideFiling,
  type FilingThresholds,
} from "./filing-policy";
import {
  buildFilingDecisionRequest,
  filingDistribution,
  fitsQuestionId,
  MAX_SAMPLE_TITLES,
  REORGANIZE_QUESTION,
  type FilingGroupInput,
  type FilingRequestInput,
  type FilingRequestStyle,
  type FilingTabInput,
} from "./filing-state";
import type { DecisionAnswers, DecisionRequest } from "./types";

/**
 * The filing cascade (docs/auto-filing-plan.md, Architecture): candidate
 * filter, then rules, then the decision model, then the policy. Every function
 * here is pure; the runtime supplies the window snapshots and the model call.
 * No tier moves a tab: each reports a distribution and `decideBatch` decides.
 */

export interface FilingTarget {
  groupId: number;
  windowId: number;
  title: string;
}

export interface FilingCandidate {
  key: string;
  tabId: number;
  windowId: number;
  /** Null when the tab is ungrouped. */
  groupId: number | null;
  index: number;
  url: string;
  title: string;
  site: string;
  /** The opaque key of the tab's current group, when re-filing a grouped tab. */
  currentGroupKey: string | null;
  /** Group titles a `never_file_location` rule blocks for this tab, lower-cased. */
  blockedGroupTitles: string[];
}

export type FilingAction =
  | {
      kind: "file" | "move";
      tabId: number;
      fromGroupId: number | null;
      target: FilingTarget;
      crossWindow: boolean;
      source: "rule" | "decision_model";
      confidence: number;
    }
  | {
      kind: "ungroup";
      tabId: number;
      fromGroupId: number;
      source: "decision_model";
      confidence: number;
    };

export interface FilingSkip {
  tabId: number;
  reason: string;
}

export interface PreparedFiling {
  windowId: number;
  /** Tabs left for the decision model, keyed by their opaque key. */
  candidates: FilingCandidate[];
  groups: Map<string, FilingTarget>;
  /** The decision request input; `null` when no tab needs the model. */
  input: FilingRequestInput | null;
  ruleActions: FilingAction[];
  skipped: FilingSkip[];
}

export interface FilingBatchInput {
  source: SemanticWindowState;
  /** Other eligible windows, only when cross-window filing is on. Linked workspace windows are left out by the caller. */
  otherWindows: readonly SemanticWindowState[];
  /** Tabs to decide, in the order they were queued. */
  tabIds: readonly number[];
  /** Tabs that are grouped and changed site (or joined their opener's group natively). */
  regroupTabIds: ReadonlySet<number>;
  privacy: PrivacySettings;
  rules: readonly OrganizerRule[];
  optedOutGroupTitles: readonly string[];
  refileGroupedTabs: boolean;
  askReorganize: boolean;
  /** Most options one question may carry: 255 for the decision API, 52 for chat labels. */
  maxOptions: number;
  style: FilingRequestStyle;
}

const sameTitle = (left: string, right: string): boolean =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

function groupOptedOut(title: string, optedOut: readonly string[]): boolean {
  return title.trim() !== "" && optedOut.some((item) => sameTitle(item, title));
}

/** A group may receive and give up tabs only when it is unprotected, unshared, and not opted out. */
function groupEligible(group: SemanticGroup, optedOut: readonly string[]): boolean {
  return group.protectionReasons.length === 0 && !groupOptedOut(group.title, optedOut);
}

interface Described {
  group: SemanticGroup;
  input: FilingGroupInput;
  otherWindow: boolean;
}

function describeGroup(
  group: SemanticGroup,
  state: SemanticWindowState,
  privacy: PrivacySettings,
  keepRules: readonly { locationPattern: string }[],
  excludeTabIds: ReadonlySet<number>,
  key: string,
  otherWindow: boolean,
): Described | null {
  const members = state.tabs.filter((tab) => tab.groupId === group.runtimeId && !excludeTabIds.has(tab.id));
  const sites: string[] = [];
  const sampleTitles: string[] = [];
  for (const tab of members) {
    const eligibility = providerTabEligibility(tab, privacy, keepRules);
    if ("reason" in eligibility) continue;
    if (!sites.includes(eligibility.location.domain)) sites.push(eligibility.location.domain);
    if (sampleTitles.length < MAX_SAMPLE_TITLES) {
      sampleTitles.push(providerTabTitle(tab.title, eligibility.location, privacy.level));
    }
  }
  const name = privacy.includeExistingGroups ? sanitizeGroupTitleForProvider(group.title) || null : null;
  // Nothing to describe the group by: the model can't choose it meaningfully.
  if (!name && sites.length === 0) return null;
  return { group, otherWindow, input: { key, name, sites, sampleTitles, ...(otherWindow ? { otherWindow: true } : {}) } };
}

function siteOverlap(described: Described, sites: ReadonlySet<string>): number {
  return described.input.sites.filter((site) => sites.has(site)).length;
}

export function prepareFilingBatch(batch: FilingBatchInput): PreparedFiling {
  const rules = normalizeOrganizerRules(batch.rules);
  const keepRules = rules.filter((rule) => rule.kind === "keep_location");
  const assignRules = rules.filter((rule): rule is Extract<OrganizerRule, { kind: "assign_location" }> =>
    rule.kind === "assign_location");
  const neverFile = rules.filter((rule): rule is Extract<OrganizerRule, { kind: "never_file_location" }> =>
    rule.kind === "never_file_location");
  const tabsById = new Map(batch.source.tabs.map((tab) => [tab.id, tab]));
  const groupsById = new Map(batch.source.groups.map((group) => [group.runtimeId, group]));
  const skipped: FilingSkip[] = [];

  interface Pending {
    tab: SemanticTab;
    site: string;
    title: string;
    location: Parameters<typeof ruleMatchesTab>[1];
    group: SemanticGroup | null;
  }
  const pending: Pending[] = [];
  for (const tabId of new Set(batch.tabIds)) {
    const tab = tabsById.get(tabId);
    if (!tab) {
      skipped.push({ tabId, reason: "closed_or_moved" });
      continue;
    }
    const grouped = tab.groupId !== UNGROUPED_GROUP_ID;
    if (grouped && (!batch.refileGroupedTabs || !batch.regroupTabIds.has(tabId))) {
      skipped.push({ tabId, reason: "grouped" });
      continue;
    }
    const group = grouped ? groupsById.get(tab.groupId) ?? null : null;
    if (grouped && (!group || !groupEligible(group, batch.optedOutGroupTitles))) {
      skipped.push({ tabId, reason: "group_ineligible" });
      continue;
    }
    const eligibility = providerTabEligibility(tab, batch.privacy, keepRules);
    if ("reason" in eligibility) {
      skipped.push({ tabId, reason: "excluded" });
      continue;
    }
    if (neverFile.some((rule) => !rule.groupName && ruleMatchesTab(rule, eligibility.location))) {
      skipped.push({ tabId, reason: "rule" });
      continue;
    }
    pending.push({
      tab,
      group,
      location: eligibility.location,
      site: eligibility.location.domain,
      title: providerTabTitle(tab.title, eligibility.location, batch.privacy.level),
    });
  }

  // Groups: the source window first (its group order), then other windows.
  const candidateIds = new Set(pending.map((item) => item.tab.id));
  const described: Described[] = [];
  let groupCounter = 0;
  const addWindow = (state: SemanticWindowState, otherWindow: boolean): void => {
    for (const group of state.groups) {
      if (!groupEligible(group, batch.optedOutGroupTitles)) continue;
      const item = describeGroup(group, state, batch.privacy, keepRules, candidateIds, `g${groupCounter + 1}`, otherWindow);
      if (!item) continue;
      groupCounter += 1;
      described.push(item);
    }
  };
  addWindow(batch.source, false);
  for (const state of batch.otherWindows) {
    if (state.windowId !== batch.source.windowId) addWindow(state, true);
  }

  const targetFor = (item: Described): FilingTarget => ({
    groupId: item.group.runtimeId,
    windowId: item.group.windowId,
    title: item.group.title,
  });
  const ruleActions: FilingAction[] = [];
  const forModel: Pending[] = [];
  for (const item of pending) {
    const assigned = assignRules.find((rule) => ruleMatchesTab(rule, item.location));
    const target = assigned
      ? described.find((entry) => !entry.otherWindow && sameTitle(entry.group.title, assigned.groupName))
      : undefined;
    if (assigned && target) {
      const blocked = neverFile.some((rule) => rule.groupName && sameTitle(rule.groupName, target.group.title) &&
        ruleMatchesTab(rule, item.location));
      if (target.group.runtimeId === item.group?.runtimeId || blocked) {
        skipped.push({ tabId: item.tab.id, reason: "rule" });
      } else {
        ruleActions.push({
          kind: item.group ? "move" : "file",
          tabId: item.tab.id,
          fromGroupId: item.group?.runtimeId ?? null,
          target: targetFor(target),
          crossWindow: false,
          source: "rule",
          confidence: 1,
        });
      }
      continue;
    }
    forModel.push(item);
  }

  // Cap the option list: same-window groups first, then the best site overlap.
  const candidateSites = new Set(forModel.map((item) => item.site));
  const currentGroupIds = new Set(forModel.flatMap((item) => (item.group ? [item.group.runtimeId] : [])));
  const limit = Math.max(1, batch.maxOptions - 2);
  const kept = described.length <= limit
    ? described
    : [...described]
        .map((item, order) => ({ item, order }))
        .sort((left, right) =>
          Number(currentGroupIds.has(right.item.group.runtimeId)) - Number(currentGroupIds.has(left.item.group.runtimeId)) ||
          Number(left.item.otherWindow) - Number(right.item.otherWindow) ||
          siteOverlap(right.item, candidateSites) - siteOverlap(left.item, candidateSites) ||
          left.order - right.order)
        .slice(0, limit)
        .sort((left, right) => left.order - right.order)
        .map(({ item }) => item);

  const groups = new Map(kept.map((item) => [item.input.key, targetFor(item)]));
  const keyByGroupId = new Map(kept.map((item) => [item.group.runtimeId, item.input.key]));
  const candidates: FilingCandidate[] = [];
  const tabInputs: FilingTabInput[] = [];
  forModel.forEach((item, index) => {
    const currentGroupKey = item.group ? keyByGroupId.get(item.group.runtimeId) ?? null : null;
    if (item.group && !currentGroupKey) {
      skipped.push({ tabId: item.tab.id, reason: "group_ineligible" });
      return;
    }
    const key = `t${index + 1}`;
    candidates.push({
      key,
      tabId: item.tab.id,
      windowId: item.tab.windowId,
      groupId: item.group?.runtimeId ?? null,
      index: item.tab.index,
      url: item.tab.url,
      title: item.tab.title,
      site: item.site,
      currentGroupKey,
      blockedGroupTitles: neverFile
        .filter((rule) => rule.groupName && ruleMatchesTab(rule, item.location))
        .map((rule) => (rule.groupName ?? "").trim().toLocaleLowerCase()),
    });
    tabInputs.push({ key, title: item.title, site: item.site, currentGroupKey });
  });
  // An ungrouped tab with no group to go to has nothing to decide.
  const otherGroupsFor = (candidate: FilingCandidate): number =>
    kept.filter((item) => item.input.key !== candidate.currentGroupKey).length;
  const decidable = candidates.filter((candidate) => candidate.currentGroupKey !== null || otherGroupsFor(candidate) > 0);
  for (const candidate of candidates) {
    if (!decidable.includes(candidate)) skipped.push({ tabId: candidate.tabId, reason: "no_groups" });
  }
  const decidableKeys = new Set(decidable.map((candidate) => candidate.key));
  const input: FilingRequestInput | null = decidable.length === 0
    ? null
    : {
        groups: kept.map((item) => item.input),
        tabs: tabInputs.filter((tab) => decidableKeys.has(tab.key)),
        askFits: decidable.some((candidate) => candidate.currentGroupKey === null),
        askReorganize: batch.askReorganize,
        style: batch.style,
      };
  return {
    windowId: batch.source.windowId,
    candidates: decidable,
    groups,
    input,
    ruleActions,
    skipped,
  };
}

/**
 * Builds the decision request. The `fits` gate is only asked for ungrouped
 * tabs, and the `reorganize` question only when escalation is on.
 */
export function filingRequest(prepared: PreparedFiling): DecisionRequest | null {
  if (!prepared.input) return null;
  const request = buildFilingDecisionRequest(prepared.input);
  for (const tab of prepared.input.tabs) {
    if (tab.currentGroupKey) delete request.questions[fitsQuestionId(tab.key)];
  }
  return request;
}

export interface FilingOutcome {
  actions: FilingAction[];
  /** Ungrouped tabs the policy left alone; they feed the escalation backlog. */
  abstainedUngrouped: number[];
  /** Grouped tabs the policy left alone. */
  abstainedGrouped: number[];
  reorganize: number | null;
  /** Policy reasons, for counts-only diagnostics. */
  reasons: string[];
}

export function decideBatch(
  prepared: PreparedFiling,
  answers: DecisionAnswers | null,
  thresholds: FilingThresholds,
): FilingOutcome {
  const outcome: FilingOutcome = {
    actions: [...prepared.ruleActions],
    abstainedUngrouped: [],
    abstainedGrouped: [],
    reorganize: null,
    reasons: [],
  };
  const abstain = (candidate: FilingCandidate, reason: string): void => {
    outcome.reasons.push(reason);
    (candidate.groupId === null ? outcome.abstainedUngrouped : outcome.abstainedGrouped).push(candidate.tabId);
  };
  if (!prepared.input || !answers) {
    for (const candidate of prepared.candidates) abstain(candidate, "no_model");
    return outcome;
  }
  const reorganize = answers[REORGANIZE_QUESTION];
  outcome.reorganize = reorganize?.type === "noul" ? reorganize.noul : null;
  const sameWindowKeys = new Set([...prepared.groups.entries()]
    .filter(([, target]) => target.windowId === prepared.windowId)
    .map(([key]) => key));
  for (const candidate of prepared.candidates) {
    const tabInput = prepared.input.tabs.find((tab) => tab.key === candidate.key);
    const probabilities = tabInput ? filingDistribution(answers, prepared.input, tabInput) : null;
    if (!probabilities) {
      abstain(candidate, "no_answer");
      continue;
    }
    const fits = answers[fitsQuestionId(candidate.key)];
    const grouped = candidate.groupId !== null;
    const verdict = decideFiling({
      probabilities,
      grouped,
      fits: fits?.type === "noul" ? fits.noul : null,
    }, thresholds);
    if (verdict.action === "abstain") {
      abstain(candidate, verdict.reason);
      continue;
    }
    if (verdict.action === "ungroup") {
      if (candidate.groupId === null) {
        abstain(candidate, "none");
        continue;
      }
      outcome.actions.push({
        kind: "ungroup",
        tabId: candidate.tabId,
        fromGroupId: candidate.groupId,
        source: "decision_model",
        confidence: verdict.confidence,
      });
      continue;
    }
    const target = prepared.groups.get(verdict.target);
    if (!target || target.groupId === candidate.groupId) {
      abstain(candidate, "stay");
      continue;
    }
    if (candidate.blockedGroupTitles.includes(target.title.trim().toLocaleLowerCase())) {
      abstain(candidate, "rule");
      continue;
    }
    const crossWindow = target.windowId !== candidate.windowId;
    if (crossWindow && !crossWindowAllowed(probabilities, verdict.target, sameWindowKeys, thresholds, grouped)) {
      abstain(candidate, "cross_window_margin");
      continue;
    }
    outcome.actions.push({
      kind: grouped ? "move" : "file",
      tabId: candidate.tabId,
      fromGroupId: candidate.groupId,
      target,
      crossWindow,
      source: "decision_model",
      confidence: verdict.confidence,
    });
  }
  return outcome;
}
