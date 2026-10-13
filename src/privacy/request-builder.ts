import type { SemanticWindowState } from "../shared/types";
import { LIMITS } from "../shared/limits";
import type {
  ImmutableRequestBundle,
  GroupNamePreference,
  OrganizerRule,
  OrganizationScope,
  PrivacySettings,
  RecencyBucket,
  SanitizedOrganizationRequest,
  SanitizedTabRecord,
  WorkflowSettings,
} from "../shared/organizer-types";
import { preferredGroupNameVocabulary } from "../organizer/group-name-memory";
import {
  normalizeOrganizerRules,
  ruleMatchesTab,
  sanitizeOrganizerRules,
} from "../organizer/rules";
import {
  tabIsInOrganizationScope,
  validateOrganizationScope,
  WHOLE_WINDOW_SCOPE,
} from "../organizer/scope";
import { getPrivacyExclusionReason } from "./domain-policy";
import { sanitizeGroupTitleForProvider, sanitizeTabTitleForProvider } from "./sanitize-text";
import { sanitizePublicLocation } from "./sanitize-url";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((child) => deepFreeze(child));
  }
  return value;
}

// Pretty-printed envelope with one compact JSON object per tab: the privacy
// preview stays readable while the tab list stays far more compact than
// fully indented JSON.
export function serializeOrganizationRequest(
  request: SanitizedOrganizationRequest,
): string {
  const { tabs, ...envelope } = request;
  const head = JSON.stringify({ ...envelope, tabs: [] }, null, 2);
  if (tabs.length === 0) return head;
  const rows = tabs.map((tab) => `    ${JSON.stringify(tab)}`).join(",\n");
  return `${head.slice(0, head.lastIndexOf("[]"))}[\n${rows}\n  ]\n}`;
}

function recencyBucket(lastAccessed: number | null, now: number): RecencyBucket {
  if (lastAccessed === null || !Number.isFinite(lastAccessed)) return "unknown";
  const elapsed = Math.max(0, now - lastAccessed);
  if (elapsed < 20 * 60_000) return "under_20_minutes";
  if (elapsed < 60 * 60_000) return "20_to_59_minutes";
  if (elapsed < 6 * 60 * 60_000) return "1_to_6_hours";
  if (elapsed < 24 * 60 * 60_000) return "6_to_24_hours";
  return "over_24_hours";
}

export type ProviderTabEligibility =
  | { location: ReturnType<typeof sanitizePublicLocation> }
  | { reason: string };

/**
 * Whether a tab may be sent to a provider at all, and its sanitized location if
 * so: protections, the privacy policy (allowlist, denylist, local files, private
 * networks), and `keep_location` rules. Organize and auto-filing share it, so a
 * tab the organizer would never send is never sent for filing either.
 */
export function providerTabEligibility(
  tab: SemanticWindowState["tabs"][number],
  settings: PrivacySettings,
  keepRules: readonly { locationPattern: string }[],
): ProviderTabEligibility {
  if (tab.protectionReasons.length > 0) return { reason: tab.protectionReasons.join("; ") };
  try {
    const location = sanitizePublicLocation(tab.url, settings.level, settings);
    const policyReason = getPrivacyExclusionReason(location.hostname, location.domain, settings);
    if (policyReason) return { reason: policyReason };
    if (keepRules.some((rule) => ruleMatchesTab(rule, location))) {
      return { reason: "User rule: never move this location" };
    }
    return { location };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : "Tab metadata is unavailable" };
  }
}

/** The title a provider may see, at the user's privacy level. */
export function providerTabTitle(
  title: string,
  location: ReturnType<typeof sanitizePublicLocation>,
  level: PrivacySettings["level"],
): string {
  const safeTitleLocation = level === 1 ? location.domain : `${location.hostname}${location.path ?? ""}`;
  return sanitizeTabTitleForProvider(title, safeTitleLocation);
}

export function buildSanitizedRequest(
  state: SemanticWindowState,
  settings: PrivacySettings,
  now = Date.now(),
  workflow: Pick<
    WorkflowSettings,
    "inactiveSuggestionHours" | "lowValueSuggestionHours" | "includeInactivityDuration"
  > & Partial<Pick<WorkflowSettings, "aiGroupColors">> = {
    inactiveSuggestionHours: 24,
    lowValueSuggestionHours: 6,
    includeInactivityDuration: true,
    aiGroupColors: false,
  },
  scope: OrganizationScope = WHOLE_WINDOW_SCOPE,
  organizerRules: readonly OrganizerRule[] = [],
  groupNamePreferences: readonly GroupNamePreference[] = [],
): ImmutableRequestBundle {
  validateOrganizationScope(state, scope);
  const normalizedRules = normalizeOrganizerRules(organizerRules);
  const keepRules = normalizedRules.filter(
    (rule): rule is Extract<OrganizerRule, { kind: "keep_location" }> =>
      rule.kind === "keep_location",
  );
  const excludedTabs: ImmutableRequestBundle["excludedTabs"] = [];
  const scopedTabs = state.tabs.filter((tab) => tabIsInOrganizationScope(tab, scope));
  const candidates = scopedTabs.flatMap((tab) => {
    const eligibility = providerTabEligibility(tab, settings, keepRules);
    if ("reason" in eligibility) {
      excludedTabs.push({ browserTabId: tab.id, title: tab.title, reason: eligibility.reason });
      return [];
    }
    return [{ tab, location: eligibility.location }];
  });

  if (candidates.length === 0) {
    throw new Error("No tabs are eligible under the current privacy policy.");
  }
  if (candidates.length > LIMITS.MAX_TABS_PER_REQUEST) {
    throw new Error(
      `This scope has ${candidates.length} tabs; Organize can send at most ${LIMITS.MAX_TABS_PER_REQUEST} at once. Choose a smaller scope.`,
    );
  }

  const browserToEphemeral = new Map<number, number>();
  const ephemeralToBrowserTabId: Record<number, number> = {};
  candidates.forEach(({ tab }, index) => {
    const ephemeralId = index + 1;
    browserToEphemeral.set(tab.id, ephemeralId);
    ephemeralToBrowserTabId[ephemeralId] = tab.id;
  });
  // Exact duplicates are found on the raw URL (fragment ignored) before it is
  // sanitized, so two different documents behind the same redacted path never
  // match. The active or most recently used copy is the one kept.
  const keptCopyByUrl = new Map<string, (typeof candidates)[number]["tab"]>();
  const duplicateKey = (url: string): string => url.split("#", 1)[0]!;
  const recency = (tab: (typeof candidates)[number]["tab"]): number =>
    tab.active ? Infinity : tab.lastAccessed ?? -Infinity;
  candidates.forEach(({ tab }) => {
    const key = duplicateKey(tab.url);
    const kept = keptCopyByUrl.get(key);
    if (!kept || recency(tab) > recency(kept)) keptCopyByUrl.set(key, tab);
  });
  const groupsById = new Map(state.groups.map((group) => [group.runtimeId, group]));
  const lowValueInactivityThresholdMinutes = workflow.lowValueSuggestionHours * 60;
  const tabs: SanitizedTabRecord[] = candidates.map(({ tab, location }, index) => {
    const id = index + 1;
    const record: SanitizedTabRecord = {
      id,
      title: providerTabTitle(tab.title, location, settings.level),
      domain: location.domain,
      isCurrentlyGrouped: tab.groupId !== -1,
      recencyBucket: recencyBucket(tab.lastAccessed, now),
      isActive: tab.active,
      isAudible: tab.audible,
    };
    if (settings.level >= 2) record.hostname = location.hostname;
    if (
      workflow.includeInactivityDuration &&
      tab.lastAccessed !== null &&
      Number.isFinite(tab.lastAccessed)
    ) {
      const inactiveForMinutes = Math.floor(
        Math.max(0, now - tab.lastAccessed) / 60_000,
      );
      record.inactiveForMinutes = inactiveForMinutes;
      record.meetsLowValueInactivityThreshold =
        inactiveForMinutes >= lowValueInactivityThresholdMinutes;
    }
    if (location.path !== undefined) record.path = location.path;
    const openerTabId =
      tab.openerTabId === null ? undefined : browserToEphemeral.get(tab.openerTabId);
    if (openerTabId !== undefined) record.openerTabId = openerTabId;
    const keptCopy = keptCopyByUrl.get(duplicateKey(tab.url));
    if (keptCopy && keptCopy !== tab) {
      record.duplicateOfTabId = browserToEphemeral.get(keptCopy.id);
    }
    if (settings.includeExistingGroups && tab.groupId !== -1) {
      const groupTitle = sanitizeGroupTitleForProvider(groupsById.get(tab.groupId)?.title ?? "");
      if (groupTitle) record.existingGroup = groupTitle;
    }
    return record;
  });

  const approvedRequest: SanitizedOrganizationRequest = deepFreeze({
    schemaVersion: 1,
    privacyLevel: settings.level,
    groupColorMode: workflow.aiGroupColors === true ? "ai" : "deterministic",
    existingGroupMetadataIncluded: settings.includeExistingGroups,
    inactivityPolicy: {
      generalSuggestionAfterHours: workflow.inactiveSuggestionHours,
      lowValueSuggestionAfterHours: workflow.lowValueSuggestionHours,
      closingRequiresManualReview: true,
    },
    organizerRules: sanitizeOrganizerRules(normalizedRules),
    preferredGroupNames: preferredGroupNameVocabulary(groupNamePreferences),
    tabs,
  });
  const requestJson = serializeOrganizationRequest(approvedRequest);
  const byteLength = new TextEncoder().encode(requestJson).byteLength;
  if (byteLength > LIMITS.MAX_REQUEST_BYTES) {
    throw new Error(
      `The sanitized request is ${byteLength} bytes; the limit is ${LIMITS.MAX_REQUEST_BYTES}.`,
    );
  }
  return deepFreeze({
    approvedRequest,
    requestJson,
    submittedTabIds: tabs.map((tab) => tab.id),
    ephemeralToBrowserTabId,
    excludedTabs,
    scope: structuredClone(scope),
    outOfScopeTabCount: state.tabs.length - scopedTabs.length,
    byteLength,
  });
}
