import type {
  OrganizerRule,
  SanitizedOrganizerRule,
  SanitizedTabRecord,
  ValidatedProposal,
} from "../shared/organizer-types";
import { sanitizeGroupTitle } from "../privacy/sanitize-text";
import { isRecord } from "../shared/guards";

const MAX_RULES = 100;
const MAX_PATTERN_LENGTH = 200;

function normalizePattern(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLocaleLowerCase().slice(0, MAX_PATTERN_LENGTH);
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? sanitizeGroupTitle(value).trim() : "";
}

export function normalizeOrganizerRules(value: unknown): OrganizerRule[] {
  if (!Array.isArray(value)) return [];
  const normalized: OrganizerRule[] = [];
  const seenIds = new Set<string>();
  for (const item of value.slice(0, MAX_RULES)) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const id = item.id.slice(0, 100);
    // Dedupe on the truncated id, which is the value actually stored: checking
    // the pre-truncation id let two distinct >100-char ids collapse to one.
    if (seenIds.has(id)) continue;
    let rule: OrganizerRule | null = null;
    if (item.kind === "assign_location") {
      const locationPattern = normalizePattern(item.locationPattern);
      const groupName = normalizeName(item.groupName);
      if (locationPattern && groupName) {
        rule = { id, kind: "assign_location", locationPattern, groupName };
      }
    } else if (item.kind === "keep_location") {
      const locationPattern = normalizePattern(item.locationPattern);
      if (locationPattern) rule = { id, kind: "keep_location", locationPattern };
    } else if (item.kind === "rename_group") {
      const fromName = normalizeName(item.fromName);
      const toName = normalizeName(item.toName);
      if (fromName && toName) rule = { id, kind: "rename_group", fromName, toName };
    } else if (item.kind === "never_clutter_location") {
      const locationPattern = normalizePattern(item.locationPattern);
      if (locationPattern) {
        rule = { id, kind: "never_clutter_location", locationPattern };
      }
    } else if (item.kind === "never_file_location") {
      const locationPattern = normalizePattern(item.locationPattern);
      const groupName = normalizeName(item.groupName);
      if (locationPattern) {
        rule = groupName
          ? { id, kind: "never_file_location", locationPattern, groupName }
          : { id, kind: "never_file_location", locationPattern };
      }
    }
    if (!rule) continue;
    seenIds.add(id);
    normalized.push(rule);
  }
  return normalized;
}

/** Rules sent to the organizer. Filing-only rules stay local. */
export function sanitizeOrganizerRules(rules: readonly OrganizerRule[]): SanitizedOrganizerRule[] {
  return normalizeOrganizerRules(rules)
    .filter((rule) => rule.kind !== "never_file_location")
    .map(({ id: _id, ...rule }) => rule);
}

export function sanitizedTabLocation(
  tab: Pick<SanitizedTabRecord, "domain" | "hostname" | "path">,
): string {
  return `${tab.hostname ?? tab.domain}${tab.path ?? "/*"}`.toLocaleLowerCase();
}

// Linear glob match: "*" matches any run, every other character is literal. The
// previous implementation expanded each "*" to ".*" inside an anchored regex,
// where a pattern like "a*a*a*…*b" against a long host+path backtracks
// exponentially and can freeze the extension on an imported rule.
function globMatches(value: string, pattern: string): boolean {
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starValueIndex = 0;
  while (valueIndex < value.length) {
    const patternChar = pattern[patternIndex];
    if (patternIndex < pattern.length && patternChar === value[valueIndex]) {
      valueIndex += 1;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && patternChar === "*") {
      starIndex = patternIndex;
      starValueIndex = valueIndex;
      patternIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

export function locationMatchesPattern(location: string, pattern: string): boolean {
  return globMatches(location.toLocaleLowerCase(), pattern.toLocaleLowerCase());
}

export function ruleMatchesTab(
  rule: { locationPattern: string },
  tab: Pick<SanitizedTabRecord, "domain" | "hostname" | "path">,
): boolean {
  return (
    locationMatchesPattern(sanitizedTabLocation(tab), rule.locationPattern) ||
    (tab.hostname !== undefined && locationMatchesPattern(
      `${tab.domain}${tab.path ?? "/*"}`,
      rule.locationPattern,
    ))
  );
}

/** The request's own clutter precondition: idle past the threshold, not active or audible. */
function isClutterEligible(tab: SanitizedTabRecord): boolean {
  return tab.meetsLowValueInactivityThreshold === true && !tab.isActive && !tab.isAudible;
}

const AUTH_HOST_LABELS = new Set(["accounts", "account", "login", "signin", "auth", "sso", "id"]);
const AUTH_PATH_SEGMENTS = new Set([
  "login", "log-in", "logon", "signin", "sign-in", "sign_in", "authorize", "oauth", "oauth2", "sso", "auth",
]);
const EDITOR_PATH_SEGMENTS = new Set(["edit", "compose", "draft", "drafts"]);

/**
 * Pages a model flag can never mark as clutter, however stale: sign-in/auth pages
 * and documents or messages being edited, where closing loses work or state. Keyed
 * on URL structure rather than title wording so it holds across models and
 * phrasings, including stale sign-in, compose, and "Untitled" pages.
 */
export function isProtectedFromClutter(tab: SanitizedTabRecord): boolean {
  if (/^untitled\b/iu.test(tab.title.trim())) return true;
  const firstLabel = tab.hostname?.toLocaleLowerCase().split(".")[0];
  if (firstLabel !== undefined && AUTH_HOST_LABELS.has(firstLabel)) return true;
  const segments = (tab.path ?? "").toLocaleLowerCase().split("/");
  return segments.some((segment) => AUTH_PATH_SEGMENTS.has(segment) || EDITOR_PATH_SEGMENTS.has(segment));
}

/**
 * Enforces clutter flags locally rather than trusting the model with them: flags
 * on ineligible tabs are dropped (models flag fresh or active tabs), model flags
 * on protected pages (sign-in, editors, drafts) are dropped, eligible exact
 * duplicates are flagged (models miss most of them, and the kept copy preserves
 * any state), and never_clutter_location rules win over all of these.
 */
export function applyClutterRules(
  proposal: ValidatedProposal,
  tabs: readonly SanitizedTabRecord[],
  rules: readonly SanitizedOrganizerRule[],
): ValidatedProposal {
  const neverClutter = rules.filter(
    (rule): rule is Extract<SanitizedOrganizerRule, { kind: "never_clutter_location" }> =>
      rule.kind === "never_clutter_location",
  );
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const duplicates = tabs
    .filter((tab) => tab.duplicateOfTabId !== undefined && isClutterEligible(tab))
    .map((tab) => tab.id);
  const modelFlags = (proposal.lowValueTabIds ?? []).filter((tabId) => {
    const tab = tabsById.get(tabId);
    return tab !== undefined && !isProtectedFromClutter(tab);
  });
  const flagged = [...new Set([...modelFlags, ...duplicates])];
  const lowValueTabIds = flagged.filter((tabId) => {
    const tab = tabsById.get(tabId);
    return tab !== undefined && isClutterEligible(tab) &&
      !neverClutter.some((rule) => ruleMatchesTab(rule, tab));
  });
  return { ...structuredClone(proposal), lowValueTabIds };
}

export function describeOrganizerRule(rule: OrganizerRule): string {
  switch (rule.kind) {
    case "assign_location":
      return `${rule.locationPattern} → ${rule.groupName}`;
    case "keep_location":
      return `Never move ${rule.locationPattern}`;
    case "rename_group":
      return `Prefer “${rule.toName}” over “${rule.fromName}”`;
    case "never_clutter_location":
      return `Never flag ${rule.locationPattern} as clutter`;
    case "never_file_location":
      return rule.groupName
        ? `Never auto-file ${rule.locationPattern} into ${rule.groupName}`
        : `Never auto-file ${rule.locationPattern}`;
  }
}
