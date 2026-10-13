import type { SavedTabStash } from "../shared/stash-types";

export type TabSearchScope = "current_window" | "all_windows";

export type DirectMatchReason = "Title" | "URL" | "Group";

export interface SearchableTab {
  id: number;
  windowId: number;
  windowLabel: string;
  title: string;
  url: string;
  hostname: string;
  path: string;
  groupName: string | null;
  /** Chrome's `lastAccessed`; breaks ties between equally strong matches. */
  lastAccessed?: number | null;
}

export interface DirectTabSearchResult {
  tab: SearchableTab;
  tier: number;
  reasons: DirectMatchReason[];
}

export interface SearchableStashedTab {
  key: string;
  stashId: string;
  stashRevisionId: string;
  stashTabId: string;
  stashName: string;
  stashOrder: number;
  sourceIndex: number;
  title: string;
  url: string;
  hostname: string;
  path: string;
  groupName: string | null;
  groupKey: string | null;
}

export function stashRevisionId(stash: Pick<SavedTabStash, "updatedAt">): string {
  return `current:${stash.updatedAt}`;
}

export function stashTabId(tab: SavedTabStash["tabs"][number]): string {
  return tab.stableKey ?? `source:${tab.sourceIndex}`;
}

export interface DirectStashedTabSearchResult {
  tab: SearchableStashedTab;
  tier: number;
  reasons: DirectMatchReason[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function normalized(value: string): string {
  // Locale-independent, matching the semantic document tokenizer.
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export { normalized as normalizeSearchQuery };

function tokens(value: string): string[] {
  return normalized(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

function fuzzyTokenMatch(queryTokens: readonly string[], documentTokens: readonly string[]): boolean {
  if (queryTokens.length === 0) return false;
  return queryTokens.every((queryToken) =>
    documentTokens.some((documentToken) =>
      queryToken.length >= 3 && documentToken.length >= 3 &&
      editDistanceAtMostOne(queryToken, documentToken),
    ),
  );
}

/**
 * Scripts written without spaces between words. A substring of a Thai or Japanese
 * title is usually a whole word, so word-boundary rules would demote every match.
 */
const UNSPACED_SCRIPT = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function includesAtWordStart(value: string, needle: string): boolean {
  if (!needle) return false;
  if (UNSPACED_SCRIPT.test(String.fromCodePoint(needle.codePointAt(0)!))) return value.includes(needle);
  for (let index = value.indexOf(needle); index >= 0; index = value.indexOf(needle, index + 1)) {
    if (index === 0 || !WORD_CHARACTER.test(value[index - 1]!)) return true;
  }
  return false;
}

interface SearchField {
  weight: number;
  value: string;
  tokens: readonly string[];
}

/**
 * Orders results inside a tier. Every query token scores its best field: a whole
 * word beats a word prefix beats a mid-word substring beats a one-edit typo, and
 * the title outweighs the group, which outweighs the host and path. Without this,
 * "go" in "Go docs" and in "algorithm" tied and fell back to alphabetical order.
 */
function matchStrength(queryTokens: readonly string[], fields: readonly SearchField[]): number {
  return queryTokens.reduce((total, token) => total + Math.max(0, ...fields.map((field) => {
    if (field.tokens.includes(token)) return field.weight * 2;
    if (includesAtWordStart(field.value, token)) return field.weight * 1.5;
    if (field.value.includes(token)) return field.weight * 0.5;
    if (token.length >= 3 && field.tokens.some((item) => item.length >= 3 && editDistanceAtMostOne(token, item))) {
      return field.weight * 0.25;
    }
    return 0;
  })), 0);
}

type SearchDocument = Pick<SearchableTab, "title" | "hostname" | "path" | "url" | "groupName">;

/** A document's normalized fields and their tokens, which do not depend on the query. */
interface PreparedDocument {
  raw: SearchDocument;
  title: string;
  hostname: string;
  path: string;
  url: string;
  group: string;
  location: string;
  titleTokens: readonly string[];
  groupTokens: readonly string[];
  locationTokens: readonly string[];
}

/**
 * Snapshots live across keystrokes, so each document is normalized and tokenized
 * once rather than once per keystroke. Keyed by the document object and checked
 * against its raw fields, so a document edited in place is prepared again.
 */
const preparedDocuments = new WeakMap<SearchDocument, PreparedDocument>();

function prepareDocument(document: SearchDocument): PreparedDocument {
  const cached = preparedDocuments.get(document);
  if (
    cached &&
    cached.raw.title === document.title &&
    cached.raw.hostname === document.hostname &&
    cached.raw.path === document.path &&
    cached.raw.url === document.url &&
    cached.raw.groupName === document.groupName
  ) {
    return cached;
  }
  const hostname = normalized(document.hostname);
  const path = normalized(document.path);
  const location = `${hostname} ${path}`;
  const title = normalized(document.title);
  const group = normalized(document.groupName ?? "");
  const prepared: PreparedDocument = {
    raw: {
      title: document.title,
      hostname: document.hostname,
      path: document.path,
      url: document.url,
      groupName: document.groupName,
    },
    title,
    hostname,
    path,
    url: normalized(document.url),
    group,
    location,
    titleTokens: tokens(title),
    groupTokens: tokens(group),
    locationTokens: tokens(location),
  };
  preparedDocuments.set(document, prepared);
  return prepared;
}

function matchDocument(
  document: SearchDocument,
  normalizedQuery: string,
  queryTokens: readonly string[],
  includeGroupNames: boolean,
): { tier: number; reasons: DirectMatchReason[]; strength: number } | null {
  const prepared = prepareDocument(document);
  const { title, hostname, path, url, location } = prepared;
  const group = includeGroupNames ? prepared.group : "";
  const groupTokens = includeGroupNames ? prepared.groupTokens : [];
  const titleMatch = title.includes(normalizedQuery);
  const hostMatch = hostname.includes(normalizedQuery);
  const pathMatch = path.includes(normalizedQuery) || url.includes(normalizedQuery);
  const groupMatch = group.includes(normalizedQuery);
  const reasons: DirectMatchReason[] = [];
  if (titleMatch) reasons.push("Title");
  if (hostMatch || pathMatch) reasons.push("URL");
  if (groupMatch) reasons.push("Group");

  let tier: number | null = null;
  if (title === normalizedQuery) tier = 0;
  else if (hostname === normalizedQuery || group === normalizedQuery) tier = 1;
  else if (title.startsWith(normalizedQuery)) tier = 2;
  // A mid-word title hit ("cat" in "education") is no stronger than a URL match,
  // and counting it as strong would also suppress the semantic search.
  else if (titleMatch && includesAtWordStart(title, normalizedQuery)) tier = 3;
  else if (titleMatch || hostMatch || pathMatch || groupMatch) tier = 4;
  else {
    // Query tokens hold no separators, so a token cannot match across the joins.
    const searchable = [title, hostname, path, group].filter(Boolean).join(" ");
    const searchableTokens = [...prepared.titleTokens, ...prepared.locationTokens, ...groupTokens];
    if (queryTokens.every((token) => searchable.includes(token))) tier = 5;
    else if (fuzzyTokenMatch(queryTokens, searchableTokens)) tier = 6;
    if (tier !== null && reasons.length === 0) {
      const contributes = (value: string, valueTokens: readonly string[]): boolean => queryTokens.some((token) =>
        value.includes(token) || valueTokens.some((item) => editDistanceAtMostOne(token, item)),
      );
      if (contributes(title, prepared.titleTokens)) reasons.push("Title");
      if (contributes(location, prepared.locationTokens)) reasons.push("URL");
      if (includeGroupNames && contributes(group, groupTokens)) reasons.push("Group");
    }
  }
  if (tier === null) return null;
  const strength = matchStrength(queryTokens, [
    { weight: 3, value: title, tokens: prepared.titleTokens },
    { weight: 2, value: group, tokens: groupTokens },
    { weight: 1, value: location, tokens: prepared.locationTokens },
  ]);
  return { tier, reasons, strength };
}

export function searchableLocation(rawUrl: string): { hostname: string; path: string } {
  try {
    const parsed = new URL(rawUrl);
    let path = parsed.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // A malformed escape sequence should not make the tab unsearchable.
    }
    return { hostname: parsed.hostname, path };
  } catch {
    return { hostname: "", path: rawUrl };
  }
}

export function directTabSearch(
  snapshot: readonly SearchableTab[],
  query: string,
  options: { includeGroupNames?: boolean; limit?: number } = {},
): DirectTabSearchResult[] {
  const normalizedQuery = normalized(query);
  if (!normalizedQuery) return [];
  const queryTokens = tokens(normalizedQuery);
  const includeGroupNames = options.includeGroupNames !== false;
  const limit = Math.max(1, options.limit ?? 100);
  const results: (DirectTabSearchResult & { strength: number })[] = [];

  for (const tab of snapshot) {
    const match = matchDocument(tab, normalizedQuery, queryTokens, includeGroupNames);
    if (match) results.push({ tab, ...match });
  }

  return results
    .sort((left, right) =>
      left.tier - right.tier ||
      right.strength - left.strength ||
      Number(right.tab.windowLabel === "Current window") - Number(left.tab.windowLabel === "Current window") ||
      // Equally strong matches are usually several tabs of one site; the one used
      // most recently is far more likely to be the one being looked for.
      (right.tab.lastAccessed ?? 0) - (left.tab.lastAccessed ?? 0) ||
      collator.compare(left.tab.title, right.tab.title) ||
      left.tab.id - right.tab.id,
    )
    .slice(0, limit)
    .map(({ tab, tier, reasons }) => ({ tab, tier, reasons }));
}

export function buildStashedSearchSnapshot(stashes: readonly SavedTabStash[]): SearchableStashedTab[] {
  return stashes.flatMap((stash, stashOrder) => {
    if (stash.status === "closing_interrupted") return [];
    const groupNames = new Map(stash.groups.map((group) => [group.key, group.title.trim() || null]));
    return stash.tabs.map((tab) => {
      const location = searchableLocation(tab.url);
      return {
        key: `stash:${stash.id}:${stashTabId(tab)}`,
        stashId: stash.id,
        stashRevisionId: stashRevisionId(stash),
        stashTabId: stashTabId(tab),
        stashName: stash.name,
        stashOrder,
        sourceIndex: tab.sourceIndex,
        title: tab.title,
        url: tab.url,
        hostname: location.hostname,
        path: location.path,
        groupName: tab.groupKey ? groupNames.get(tab.groupKey) ?? null : null,
        groupKey: tab.groupKey,
      };
    });
  });
}

export function directStashedTabSearch(
  snapshot: readonly SearchableStashedTab[],
  query: string,
  options: { includeGroupNames?: boolean; limit?: number } = {},
): DirectStashedTabSearchResult[] {
  const normalizedQuery = normalized(query);
  if (!normalizedQuery) return [];
  const queryTokens = tokens(normalizedQuery);
  const includeGroupNames = options.includeGroupNames !== false;
  const limit = Math.max(1, options.limit ?? 100);
  return snapshot
    .flatMap((tab) => {
      const match = matchDocument(tab, normalizedQuery, queryTokens, includeGroupNames);
      return match ? [{ tab, ...match }] : [];
    })
    .sort((left, right) =>
      left.tier - right.tier ||
      right.strength - left.strength ||
      left.tab.stashOrder - right.tab.stashOrder ||
      left.tab.sourceIndex - right.tab.sourceIndex ||
      collator.compare(left.tab.title, right.tab.title),
    )
    .slice(0, limit)
    .map(({ tab, tier, reasons }) => ({ tab, tier, reasons }));
}

export function directResultsAreStrong(results: readonly { tier: number }[]): boolean {
  return results.some((result) => result.tier <= 3) || results.filter((result) => result.tier <= 4).length >= 3;
}
