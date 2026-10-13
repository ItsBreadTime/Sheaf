import { normalizeSearchQuery } from "./direct-search";

/**
 * Which result the user chose for a query, learned locally.
 *
 * This is the omnibox's "shortcuts" idea: a tab picked for "gh" yesterday is very
 * likely the tab wanted for "gh" (or "g", or "gh pul") today. Nothing here leaves
 * the browser, and the store lives in session storage so it ends with the browser
 * session, as open-tab identities do.
 */
export interface SearchPick {
  /** Normalized query text, as direct search compares it. */
  query: string;
  /** `open:<tabId>` or `stash:<stashId>:<stashTabId>`. */
  key: string;
  count: number;
  lastAt: number;
}

export const SEARCH_PICKS_LIMIT = 200;
/** A remembered query must be at least this long before a longer one inherits it. */
const EXTENSION_MIN_CHARS = 3;

export function openSearchPickKey(tabId: number): string {
  return `open:${tabId}`;
}

export function stashSearchPickKey(stashId: string, stashTabId: string): string {
  return `stash:${stashId}:${stashTabId}`;
}

export function recordSearchPick(
  picks: readonly SearchPick[],
  rawQuery: string,
  key: string,
  now = Date.now(),
): SearchPick[] {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return [...picks];
  const existing = picks.find((pick) => pick.query === query && pick.key === key);
  const updated: SearchPick = existing
    ? { ...existing, count: existing.count + 1, lastAt: now }
    : { query, key, count: 1, lastAt: now };
  return [updated, ...picks.filter((pick) => pick !== existing)]
    .sort((left, right) => right.lastAt - left.lastAt)
    .slice(0, SEARCH_PICKS_LIMIT);
}

/**
 * Boost per result key for the current query. An exact earlier query counts double;
 * an earlier query the user is still typing towards, or one they have typed past,
 * counts once.
 */
export function searchPickBoosts(picks: readonly SearchPick[], rawQuery: string): Map<string, number> {
  const query = normalizeSearchQuery(rawQuery);
  const boosts = new Map<string, number>();
  if (!query) return boosts;
  for (const pick of picks) {
    const weight = pick.query === query
      ? 2
      : pick.query.startsWith(query) ||
          (pick.query.length >= EXTENSION_MIN_CHARS && query.startsWith(pick.query))
        ? 1
        : 0;
    if (weight > 0) boosts.set(pick.key, (boosts.get(pick.key) ?? 0) + weight * pick.count);
  }
  return boosts;
}

/** Keeps only well-formed records, since session storage is shared with older builds. */
export function normalizeSearchPicks(value: unknown): SearchPick[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SearchPick[] => {
    if (!item || typeof item !== "object") return [];
    const { query, key, count, lastAt } = item as Record<string, unknown>;
    return typeof query === "string" && query &&
      typeof key === "string" && key &&
      typeof count === "number" && Number.isFinite(count) && count > 0 &&
      typeof lastAt === "number" && Number.isFinite(lastAt)
      ? [{ query, key, count, lastAt }]
      : [];
  }).slice(0, SEARCH_PICKS_LIMIT);
}
