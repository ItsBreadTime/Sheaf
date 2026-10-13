import { locationMatchesPattern } from "../organizer/rules";
import type {
  SessionUserProtections,
  UserProtectionRule,
} from "../shared/protection-types";
import type { SemanticWindowState } from "../shared/types";

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function protectionLocation(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") return `file://${url.pathname}`.toLocaleLowerCase();
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.hostname}${url.pathname || "/"}`.toLocaleLowerCase();
    }
    return `${url.protocol}//${url.hostname}${url.pathname || "/"}`.toLocaleLowerCase();
  } catch {
    return rawUrl.trim().toLocaleLowerCase();
  }
}

export function protectionPatternForUrl(rawUrl: string): string {
  return protectionLocation(rawUrl);
}

export function applyUserProtections(
  source: SemanticWindowState,
  session: SessionUserProtections,
  permanentRules: readonly UserProtectionRule[],
): SemanticWindowState {
  const state = structuredClone(source);
  const sessionTabIds = new Set(session.tabIds);
  const sessionGroupIds = new Set(session.groupIds);
  const locationRules = permanentRules.filter(
    (rule): rule is Extract<UserProtectionRule, { kind: "location" }> =>
      rule.kind === "location",
  );
  const groupRules = permanentRules.filter(
    (rule): rule is Extract<UserProtectionRule, { kind: "group_title" }> =>
      rule.kind === "group_title",
  );

  state.groups.forEach((group) => {
    if (sessionGroupIds.has(group.runtimeId)) {
      addReason(group.protectionReasons, "User locked until browser restart");
    }
    if (groupRules.some((rule) => locationMatchesPattern(group.title, rule.pattern))) {
      addReason(group.protectionReasons, "Permanent group-name rule");
    }
  });
  const groupsById = new Map(state.groups.map((group) => [group.runtimeId, group]));
  state.tabs.forEach((tab) => {
    if (sessionTabIds.has(tab.id)) {
      addReason(tab.protectionReasons, "User protected until browser restart");
    }
    const location = protectionLocation(tab.url);
    if (locationRules.some((rule) => locationMatchesPattern(location, rule.pattern))) {
      addReason(tab.protectionReasons, "Permanent location rule");
    }
    const group = groupsById.get(tab.groupId);
    group?.protectionReasons.forEach((reason) => addReason(tab.protectionReasons, reason));
  });
  state.eligibleTabIds = state.tabs
    .filter((tab) => tab.protectionReasons.length === 0)
    .map((tab) => tab.id);
  state.protectedTabIds = state.tabs
    .filter((tab) => tab.protectionReasons.length > 0)
    .map((tab) => tab.id);
  return state;
}
