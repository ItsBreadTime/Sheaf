import type { SavedTabStash, StashedGroup, StashedTab } from "../shared/stash-types";
import { stashRevisionId, stashTabId } from "./direct-search";

export interface StashTabReference {
  stashId: string;
  stashRevisionId: string;
  stashTabId: string;
}

export interface ResolvedStashTabReference extends StashTabReference {
  changedSinceSearch: boolean;
  stash: SavedTabStash;
  tab: StashedTab;
  group: StashedGroup | null;
}

export interface StaleStashTabReference extends StashTabReference {
  reason: "stash_removed" | "tab_removed";
}

export function canonicalExactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.toLocaleLowerCase();
    url.hostname = url.hostname.toLocaleLowerCase();
    if (url.pathname === "/" && !url.search && !url.hash) url.pathname = "";
    return url.href;
  } catch {
    return raw;
  }
}

export function possibleDuplicateUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.hostname.toLocaleLowerCase() === b.hostname.toLocaleLowerCase() &&
      a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "") &&
      canonicalExactUrl(left) !== canonicalExactUrl(right);
  } catch {
    return false;
  }
}

export function referenceForStashedTab(
  stash: Pick<SavedTabStash, "id" | "updatedAt">,
  tab: StashedTab,
): StashTabReference {
  return { stashId: stash.id, stashRevisionId: stashRevisionId(stash), stashTabId: stashTabId(tab) };
}

export function resolveStashTabReferences(
  stashes: readonly SavedTabStash[],
  references: readonly StashTabReference[],
): { available: ResolvedStashTabReference[]; stale: StaleStashTabReference[] } {
  const byId = new Map(stashes.map((stash) => [stash.id, stash]));
  const available: ResolvedStashTabReference[] = [];
  const stale: StaleStashTabReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const identity = `${reference.stashId}\u0000${reference.stashTabId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const stash = byId.get(reference.stashId);
    if (!stash) {
      stale.push({ ...reference, reason: "stash_removed" });
      continue;
    }
    const tab = stash.tabs.find((candidate) => stashTabId(candidate) === reference.stashTabId);
    if (!tab) {
      stale.push({ ...reference, reason: "tab_removed" });
      continue;
    }
    available.push({
      ...reference,
      changedSinceSearch: reference.stashRevisionId !== stashRevisionId(stash),
      stash,
      tab,
      group: tab.groupKey === null ? null : stash.groups.find((group) => group.key === tab.groupKey) ?? null,
    });
  }
  return { available, stale };
}

export function orderResolvedStashTabs(
  stashes: readonly Pick<SavedTabStash, "id">[],
  available: readonly ResolvedStashTabReference[],
): ResolvedStashTabReference[] {
  const order = new Map(stashes.map((stash, index) => [stash.id, index]));
  return [...available].sort((left, right) =>
    (order.get(left.stashId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.stashId) ?? Number.MAX_SAFE_INTEGER) ||
    left.tab.sourceIndex - right.tab.sourceIndex,
  );
}

export function stashSelectionResolutionToken(
  available: readonly ResolvedStashTabReference[],
  stale: readonly StaleStashTabReference[],
): string {
  return JSON.stringify({
    available: available.map((item) => [item.stashId, stashRevisionId(item.stash), item.stashTabId]).sort(),
    stale: stale.map((item) => [item.stashId, item.stashRevisionId, item.stashTabId, item.reason]).sort(),
  });
}

export function createStashFromResolvedSelection(
  available: readonly ResolvedStashTabReference[],
  name: string,
  options: { preserveGroups: boolean; sourceQueries: readonly string[]; now?: number },
): SavedTabStash {
  if (available.length === 0) throw new Error("Choose at least one available saved tab.");
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("Enter a workspace name.");
  const now = options.now ?? Date.now();
  const sourceStashOrder = new Map<string, number>();
  available.forEach((item) => {
    if (!sourceStashOrder.has(item.stashId)) sourceStashOrder.set(item.stashId, sourceStashOrder.size);
  });
  const ordered = [...available].sort((left, right) =>
    sourceStashOrder.get(left.stashId)! - sourceStashOrder.get(right.stashId)! ||
    left.tab.sourceIndex - right.tab.sourceIndex,
  );
  const groupKeys = new Map<string, string>();
  const groups: StashedGroup[] = [];
  if (options.preserveGroups) {
    for (const item of ordered) {
      if (!item.group) continue;
      const sourceKey = `${item.stashId}\u0000${item.group.key}`;
      if (groupKeys.has(sourceKey)) continue;
      const key = `group-${groups.length + 1}`;
      groupKeys.set(sourceKey, key);
      groups.push({ ...item.group, key, sourceGroupId: -(groups.length + 1), sourceIndex: groups.length });
    }
  }
  const tabs: StashedTab[] = ordered.map((item, index) => ({
    ...item.tab,
    sourceTabId: -(index + 1),
    sourceIndex: index,
    stableKey: crypto.randomUUID(),
    groupKey: options.preserveGroups && item.group
      ? groupKeys.get(`${item.stashId}\u0000${item.group.key}`) ?? null
      : null,
  }));
  return {
    id: crypto.randomUUID(),
    name: trimmedName.slice(0, 120),
    createdAt: now,
    updatedAt: now,
    note: "",
    revisions: [],
    lastOpenedAt: null,
    activeWorkspaceId: null,
    status: "saved",
    scope: { mode: "selection", tabIds: [] },
    tabs,
    groups,
    excludedTabs: [],
    closeConflicts: [],
    restoreResult: null,
    provenance: {
      kind: "search_selection",
      createdAt: now,
      sources: ordered.map((item) => ({ stashId: item.stashId, stashTabId: item.stashTabId })),
      sourceQueries: [...new Set(options.sourceQueries.map((query) => query.trim()).filter(Boolean))],
    },
  };
}
