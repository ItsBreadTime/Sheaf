import { isBlankNewTabUrl } from "./domain-policy";
import { UNGROUPED_GROUP_ID } from "../shared/constants";
import type { SemanticTab, SemanticWindowState } from "../shared/types";

export const INACTIVE_TAB_AGE_MS = 24 * 60 * 60_000;
export const LOW_VALUE_TAB_AGE_MS = 6 * 60 * 60_000;

export type CleanupSuggestionReason = "duplicate" | "possible_duplicate" | "inactive" | "low_value" | "blank";
export type DuplicateMatchKind = "exact" | "fragment" | "tracking" | "possible";
export type CleanupSuggestionFilter = "all" | "duplicate" | "clutter" | "inactive";

export interface CleanupSuggestionOptions {
  inactiveAfterMs?: number;
  lowValueAfterMs?: number;
  lowValueTabIds?: readonly number[];
}

export interface CleanupSuggestion {
  tabId: number;
  title: string;
  url: string;
  inactiveForMs: number | null;
  reasons: CleanupSuggestionReason[];
  duplicate?: {
    kind: DuplicateMatchKind;
    keeperTabId: number;
    keeperTitle: string;
    keeperReason: string;
  };
}

export function cleanupSuggestionMatchesFilter(
  suggestion: CleanupSuggestion,
  filter: CleanupSuggestionFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "duplicate") {
    return suggestion.reasons.includes("duplicate") ||
      suggestion.reasons.includes("possible_duplicate");
  }
  if (filter === "clutter") {
    return suggestion.reasons.includes("low_value") || suggestion.reasons.includes("blank");
  }
  return suggestion.reasons.includes("inactive");
}

export function cleanupSuggestionFilterCounts(
  suggestions: readonly CleanupSuggestion[],
): Record<CleanupSuggestionFilter, number> {
  return {
    all: suggestions.length,
    duplicate: suggestions.filter((suggestion) =>
      cleanupSuggestionMatchesFilter(suggestion, "duplicate"),
    ).length,
    clutter: suggestions.filter((suggestion) =>
      cleanupSuggestionMatchesFilter(suggestion, "clutter"),
    ).length,
    inactive: suggestions.filter((suggestion) =>
      cleanupSuggestionMatchesFilter(suggestion, "inactive"),
    ).length,
  };
}

function isUntouchableTab(tab: SemanticTab): boolean {
  return (
    tab.active ||
    tab.pinned ||
    tab.audible ||
    !tab.splitView.known ||
    tab.splitView.value !== -1
  );
}

function isUserProtectionReason(reason: string): boolean {
  return reason.startsWith("User ") || reason.startsWith("Permanent ");
}

/**
 * A blank new tab holds nothing to lose, so it needs no inactivity evidence.
 * Its browser-page scheme always marks it protected from moves; only a user
 * lock keeps it open here, mirroring the organizer's blank-tab close guard.
 */
function isClosableBlankTab(tab: SemanticTab): boolean {
  return (
    !isUntouchableTab(tab) &&
    tab.groupId === UNGROUPED_GROUP_ID &&
    !tab.protectionReasons.some(isUserProtectionReason) &&
    isBlankNewTabUrl(tab.url)
  );
}

function isSafeCleanupCandidate(tab: SemanticTab): boolean {
  return (
    !isUntouchableTab(tab) &&
    tab.protectionReasons.length === 0 &&
    // Unknown activity (never accessed / unavailable) is excluded from cleanup,
    // matching the inactive and low-value paths below.
    tab.lastAccessed !== null &&
    Number.isFinite(tab.lastAccessed) &&
    !isBlankNewTabUrl(tab.url)
  );
}

const TRACKING_QUERY_KEYS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid",
]);

function parsedHttpUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function withoutFragment(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function withoutTracking(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  for (const key of [...copy.searchParams.keys()]) {
    if (key.toLocaleLowerCase().startsWith("utm_") || TRACKING_QUERY_KEYS.has(key.toLocaleLowerCase())) {
      copy.searchParams.delete(key);
    }
  }
  copy.searchParams.sort();
  return copy.href;
}

function possibleEquivalentKey(url: URL): string {
  const copy = new URL(withoutTracking(url));
  copy.protocol = "https:";
  copy.hostname = copy.hostname.replace(/^www\./i, "");
  copy.pathname = copy.pathname.replace(/\/$/, "") || "/";
  return copy.href;
}

function duplicateKind(left: URL, right: URL): DuplicateMatchKind {
  if (left.href === right.href) return "exact";
  if (withoutFragment(left) === withoutFragment(right)) return "fragment";
  if (withoutTracking(left) === withoutTracking(right)) return "tracking";
  return "possible";
}

function keeperScore(tab: SemanticTab): [number, number, number, number, number, number] {
  return [
    tab.pinned ? 1 : 0,
    tab.active ? 1 : 0,
    tab.audible ? 1 : 0,
    tab.groupId !== UNGROUPED_GROUP_ID ? 1 : 0,
    tab.lastAccessed ?? -1,
    -tab.index,
  ];
}

function compareKeeper(left: SemanticTab, right: SemanticTab): number {
  const leftScore = keeperScore(left);
  const rightScore = keeperScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    const difference = (rightScore[index] ?? 0) - (leftScore[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function keeperReason(tab: SemanticTab, state: SemanticWindowState): string {
  if (tab.pinned) return "The pinned copy will stay open.";
  if (tab.active) return "The active copy will stay open.";
  if (tab.audible) return "The copy playing audio will stay open.";
  if (tab.groupId !== UNGROUPED_GROUP_ID) {
    const title = state.groups.find((group) => group.runtimeId === tab.groupId)?.title.trim();
    return title
      ? `The copy in “${title}” will stay open.`
      : "The grouped copy will stay open.";
  }
  if (tab.lastAccessed !== null) return "The more recently used copy will stay open.";
  return "Another copy will stay open.";
}

export function findCleanupSuggestions(
  state: SemanticWindowState,
  now = Date.now(),
  options: CleanupSuggestionOptions = {},
): CleanupSuggestion[] {
  const reasonsByTabId = new Map<number, Set<CleanupSuggestionReason>>();
  const duplicateDetails = new Map<number, NonNullable<CleanupSuggestion["duplicate"]>>();
  const duplicateSets = new Map<string, Array<{ tab: SemanticTab; url: URL }>>();
  const inactiveAfterMs = options.inactiveAfterMs ?? INACTIVE_TAB_AGE_MS;
  const lowValueAfterMs = options.lowValueAfterMs ?? LOW_VALUE_TAB_AGE_MS;
  const lowValueTabIds = new Set(options.lowValueTabIds ?? []);

  for (const tab of state.tabs) {
    if (isClosableBlankTab(tab)) {
      reasonsByTabId.set(tab.id, new Set(["blank"]));
      continue;
    }
    const parsed = parsedHttpUrl(tab.url);
    if (parsed) {
      const key = possibleEquivalentKey(parsed);
      const matches = duplicateSets.get(key) ?? [];
      matches.push({ tab, url: parsed });
      duplicateSets.set(key, matches);
    }
    if (
      isSafeCleanupCandidate(tab) &&
      tab.lastAccessed !== null &&
      Number.isFinite(tab.lastAccessed) &&
      now - tab.lastAccessed >= inactiveAfterMs
    ) {
      reasonsByTabId.set(tab.id, new Set(["inactive"]));
    }
    if (
      isSafeCleanupCandidate(tab) &&
      lowValueTabIds.has(tab.id) &&
      tab.lastAccessed !== null &&
      Number.isFinite(tab.lastAccessed) &&
      now - tab.lastAccessed >= lowValueAfterMs
    ) {
      const reasons = reasonsByTabId.get(tab.id) ?? new Set<CleanupSuggestionReason>();
      reasons.add("low_value");
      reasonsByTabId.set(tab.id, reasons);
    }
  }

  for (const matches of duplicateSets.values()) {
    if (matches.length < 2) continue;
    const [keeper, ...duplicates] = [...matches].sort((left, right) => compareKeeper(left.tab, right.tab));
    if (!keeper) continue;
    for (const match of duplicates) {
      const tab = match.tab;
      if (!isSafeCleanupCandidate(tab)) continue;
      const kind = duplicateKind(keeper.url, match.url);
      const reasons = reasonsByTabId.get(tab.id) ?? new Set<CleanupSuggestionReason>();
      reasons.add(kind === "possible" ? "possible_duplicate" : "duplicate");
      reasonsByTabId.set(tab.id, reasons);
      duplicateDetails.set(tab.id, {
        kind,
        keeperTabId: keeper.tab.id,
        keeperTitle: keeper.tab.title,
        keeperReason: keeperReason(keeper.tab, state),
      });
    }
  }

  return state.tabs.flatMap((tab) => {
    const reasons = reasonsByTabId.get(tab.id);
    return reasons
      ? [{
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          inactiveForMs: tab.lastAccessed !== null && Number.isFinite(tab.lastAccessed)
            ? Math.max(0, now - tab.lastAccessed)
            : null,
          reasons: [...reasons],
          ...(duplicateDetails.has(tab.id) ? { duplicate: duplicateDetails.get(tab.id) } : {}),
        }]
      : [];
  });
}
