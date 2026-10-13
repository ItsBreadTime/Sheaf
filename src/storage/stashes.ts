import type {
  LinkedStashWorkspace,
  LinkedStashWorkspaceDraft,
  SavedTabStash,
  TabStashAutoDeleteDays,
  TabStashSettings,
  TrashedTabStash,
} from "../shared/stash-types";
import { withCrossContextMutationLock } from "./mutation-lock";

export const STASHES_KEY = "workspaces";
const SETTINGS_KEY = "workspaceSettings";
const WORKSPACES_KEY = "linkedWorkspaceWindows";
const QUARANTINE_KEY = "workspaceQuarantine";
const TRASH_KEY = "workspaceTrash";
export const STASH_SEMANTIC_MUTATION_KEY = "workspaceSemanticMutation";

// Keys from before stashes were renamed workspaces, moved once to their new
// names. The move copies only into empty keys and then drops the old ones,
// so repeating it after an interruption cannot overwrite newer data.
const LEGACY_STORAGE_KEYS: Readonly<Record<string, string>> = {
  tabStashes: STASHES_KEY,
  tabStashSettings: SETTINGS_KEY,
  linkedStashWorkspaces: WORKSPACES_KEY,
  tabStashQuarantine: QUARANTINE_KEY,
  tabStashTrash: TRASH_KEY,
};
let legacyStorageMigration: Promise<void> | null = null;

export function migrateLegacyWorkspaceStorage(): Promise<void> {
  legacyStorageMigration ??= (async () => {
    const legacy = await chrome.storage.local.get(Object.keys(LEGACY_STORAGE_KEYS));
    const present = Object.keys(legacy);
    if (present.length === 0) return;
    const current = await chrome.storage.local.get(present.map((key) => LEGACY_STORAGE_KEYS[key]!));
    const moved = Object.fromEntries(present
      .filter((key) => current[LEGACY_STORAGE_KEYS[key]!] === undefined)
      .map((key) => [LEGACY_STORAGE_KEYS[key]!, legacy[key]]));
    if (Object.keys(moved).length > 0) await chrome.storage.local.set(moved);
    await chrome.storage.local.remove(present);
  })().catch((error: unknown) => {
    legacyStorageMigration = null;
    throw error;
  });
  return legacyStorageMigration;
}
const MAX_STASHES = 50;
const MAX_STASHED_TABS = 1_000;
const AUTO_DELETE_DAY_OPTIONS = new Set<TabStashAutoDeleteDays>([null, 1, 7, 30, 90]);
const GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);

export const DEFAULT_TAB_STASH_SETTINGS: TabStashSettings = {
  autoDeleteAfterDays: null,
};

function isStashedTab(value: unknown): value is SavedTabStash["tabs"][number] {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<SavedTabStash["tabs"][number]>;
  return typeof tab.sourceTabId === "number" && typeof tab.sourceIndex === "number" &&
    typeof tab.title === "string" && typeof tab.url === "string" &&
    (tab.groupKey === null || typeof tab.groupKey === "string") &&
    (tab.stableKey === undefined || typeof tab.stableKey === "string");
}

function isStashedGroup(value: unknown): value is SavedTabStash["groups"][number] {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<SavedTabStash["groups"][number]>;
  return typeof group.key === "string" && typeof group.sourceGroupId === "number" &&
    typeof group.sourceIndex === "number" && typeof group.title === "string" &&
    typeof group.color === "string" && GROUP_COLORS.has(group.color) &&
    typeof group.collapsed === "boolean";
}

function isSavedStash(value: unknown): value is SavedTabStash {
  if (!value || typeof value !== "object") return false;
  const stash = value as Partial<SavedTabStash>;
  return (
    typeof stash.id === "string" &&
    typeof stash.name === "string" &&
    typeof stash.createdAt === "number" &&
    Array.isArray(stash.tabs) &&
    stash.tabs.length <= MAX_STASHED_TABS &&
    stash.tabs.every(isStashedTab) &&
    Array.isArray(stash.groups) && stash.groups.every(isStashedGroup) &&
    Array.isArray(stash.excludedTabs) &&
    Array.isArray(stash.closeConflicts) && stash.closeConflicts.every((conflict) => typeof conflict === "string") &&
    (stash.restoreResult === null || (
      stash.restoreResult !== undefined && typeof stash.restoreResult === "object" &&
      typeof stash.restoreResult.restoredAt === "number" &&
      typeof stash.restoreResult.openedTabs === "number" &&
      (stash.restoreResult.reusedTabs === undefined || typeof stash.restoreResult.reusedTabs === "number") &&
      (stash.restoreResult.skippedTabs === undefined || typeof stash.restoreResult.skippedTabs === "number") &&
      typeof stash.restoreResult.restoredGroups === "number" &&
      Array.isArray(stash.restoreResult.conflicts) &&
      stash.restoreResult.conflicts.every((conflict) => typeof conflict === "string")
    )) &&
    (stash.status === "saved" || stash.status === "restored" ||
      stash.status === "restore_partial" || stash.status === "closing_interrupted") &&
    (stash.updatedAt === undefined || typeof stash.updatedAt === "number") &&
    (stash.lastOpenedAt === undefined || stash.lastOpenedAt === null || typeof stash.lastOpenedAt === "number") &&
    (stash.note === undefined || typeof stash.note === "string") &&
    (stash.activeWorkspaceId === undefined || stash.activeWorkspaceId === null || typeof stash.activeWorkspaceId === "string") &&
    (stash.revisions === undefined || (
      Array.isArray(stash.revisions) && stash.revisions.length <= 20 && stash.revisions.every((revision) =>
        revision && typeof revision === "object" && typeof revision.id === "string" &&
        typeof revision.savedAt === "number" && Array.isArray(revision.tabs) &&
        revision.tabs.length <= MAX_STASHED_TABS && revision.tabs.every(isStashedTab) &&
        Array.isArray(revision.groups) && revision.groups.every(isStashedGroup)
      )
    ))
  );
}

function upgradeSavedStash(stash: SavedTabStash): SavedTabStash {
  return {
    ...stash,
    updatedAt: typeof stash.updatedAt === "number" ? stash.updatedAt : stash.createdAt,
    lastOpenedAt: typeof stash.lastOpenedAt === "number" ? stash.lastOpenedAt : stash.restoreResult?.restoredAt ?? null,
    note: typeof stash.note === "string" ? stash.note : "",
    revisions: Array.isArray(stash.revisions) ? stash.revisions : [],
    activeWorkspaceId: typeof stash.activeWorkspaceId === "string" ? stash.activeWorkspaceId : null,
  };
}

export function normalizeTabStashes(stored: unknown): SavedTabStash[] {
  if (stored === undefined) return [];
  if (!Array.isArray(stored)) throw new Error("Stored workspaces are corrupt and were not used.");
  const stashes = stored.filter(isSavedStash);
  if (stashes.length !== stored.length) {
    throw new Error("Stored workspaces are corrupt and were not used.");
  }
  return stashes.slice(0, MAX_STASHES).map(upgradeSavedStash);
}

export interface QuarantinedTabStash {
  quarantinedAt: number;
  value: unknown;
}

// Splits stored stashes into usable records and the raw entries that failed
// validation, so one damaged record cannot take every other stash down with it.
function partitionStoredTabStashes(stored: unknown): { stashes: SavedTabStash[]; rejected: unknown[] } {
  if (stored === undefined) return { stashes: [], rejected: [] };
  if (!Array.isArray(stored)) return { stashes: [], rejected: [stored] };
  const stashes: SavedTabStash[] = [];
  const rejected: unknown[] = [];
  stored.forEach((value) => {
    if (isSavedStash(value)) stashes.push(value);
    else rejected.push(value);
  });
  // Records past the cap are kept aside too, since the cleaned list is written back.
  rejected.push(...stashes.slice(MAX_STASHES));
  return { stashes: stashes.slice(0, MAX_STASHES).map(upgradeSavedStash), rejected };
}

function isQuarantinedTabStash(value: unknown): value is QuarantinedTabStash {
  return Boolean(value) && typeof value === "object" &&
    typeof (value as Partial<QuarantinedTabStash>).quarantinedAt === "number" &&
    "value" in (value as object);
}

function normalizeQuarantine(stored: unknown, now: number): QuarantinedTabStash[] {
  if (stored === undefined || stored === null) return [];
  if (Array.isArray(stored) && stored.every(isQuarantinedTabStash)) return stored;
  // Keep an unreadable quarantine as one opaque entry rather than dropping it.
  return [{ quarantinedAt: now, value: stored }];
}

function appendQuarantine(stored: unknown, rejected: readonly unknown[], now: number): QuarantinedTabStash[] {
  return [...normalizeQuarantine(stored, now), ...rejected.map((value) => ({ quarantinedAt: now, value }))];
}

function normalizeTabStashSettings(stored: unknown): TabStashSettings {
  if (!stored || typeof stored !== "object") return DEFAULT_TAB_STASH_SETTINGS;
  const value = (stored as Partial<TabStashSettings>).autoDeleteAfterDays;
  return {
    autoDeleteAfterDays: AUTO_DELETE_DAY_OPTIONS.has(value as TabStashAutoDeleteDays)
      ? value as TabStashAutoDeleteDays
      : DEFAULT_TAB_STASH_SETTINGS.autoDeleteAfterDays,
  };
}

const DAY_MS = 24 * 60 * 60_000;
export const TRASH_RETENTION_DAYS = 7;

// Retention counts from the last time a stash was opened or changed, so a
// stash in regular use never ages out from under its user.
export function tabStashLastUsedAt(stash: Pick<SavedTabStash, "createdAt" | "updatedAt" | "lastOpenedAt">): number {
  return Math.max(stash.createdAt, stash.updatedAt, stash.lastOpenedAt ?? 0);
}

export function tabStashExpiresAt(
  stash: Pick<SavedTabStash, "createdAt" | "updatedAt" | "lastOpenedAt" | "activeWorkspaceId">,
  settings: TabStashSettings,
): number | null {
  if (settings.autoDeleteAfterDays === null || stash.activeWorkspaceId !== null) return null;
  return tabStashLastUsedAt(stash) + settings.autoDeleteAfterDays * DAY_MS;
}

function partitionExpiredTabStashes(
  stashes: readonly SavedTabStash[],
  settings: TabStashSettings,
  now = Date.now(),
): { kept: SavedTabStash[]; expired: SavedTabStash[] } {
  const kept: SavedTabStash[] = [];
  const expired: SavedTabStash[] = [];
  stashes.forEach((stash) => {
    const expiresAt = tabStashExpiresAt(stash, settings);
    if (expiresAt !== null && expiresAt <= now) expired.push(stash);
    else kept.push(stash);
  });
  return { kept, expired };
}

export function pruneExpiredTabStashes(
  stashes: readonly SavedTabStash[],
  settings: TabStashSettings,
  now = Date.now(),
): SavedTabStash[] {
  return partitionExpiredTabStashes(stashes, settings, now).kept;
}

function isTrashedTabStash(value: unknown): value is TrashedTabStash {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<TrashedTabStash>;
  return typeof entry.trashedAt === "number" &&
    (entry.reason === "deleted" || entry.reason === "expired") &&
    isSavedStash(entry.stash);
}

// Splits stored trash into entries still inside the recovery window and the
// raw values that are unreadable; entries past the window are dropped.
function partitionStoredTrash(
  stored: unknown,
  now: number,
): { trash: TrashedTabStash[]; rejected: unknown[]; purged: boolean } {
  if (stored === undefined || stored === null) return { trash: [], rejected: [], purged: false };
  if (!Array.isArray(stored)) return { trash: [], rejected: [stored], purged: false };
  const trash: TrashedTabStash[] = [];
  const rejected: unknown[] = [];
  let purged = false;
  stored.forEach((value) => {
    if (!isTrashedTabStash(value)) {
      rejected.push(value);
    } else if (value.trashedAt + TRASH_RETENTION_DAYS * DAY_MS <= now) {
      purged = true;
    } else {
      trash.push({ ...value, stash: upgradeSavedStash(value.stash) });
    }
  });
  return { trash, rejected, purged };
}

export function trashEntries(
  stashes: readonly SavedTabStash[],
  reason: TrashedTabStash["reason"],
  now: number,
): TrashedTabStash[] {
  return stashes.map((stash) => ({ stash: { ...stash, activeWorkspaceId: null }, trashedAt: now, reason }));
}

// The saved list, its trash, and its quarantine are rewritten by the worker
// (save, restore, rename, trash moves) and by extension pages (backup restore,
// the cleanup a read applies), so every write holds one lock across contexts.
// Tasks under it must not call the locking functions below — Web Locks are not
// re-entrant — which is why update callbacks receive the list instead.
function withStashListLock<T>(task: () => Promise<T>): Promise<T> {
  return withCrossContextMutationLock(STASHES_KEY, task);
}

interface LoadedTabStashes {
  current: SavedTabStash[];
  cleanup: Record<string, unknown> | null;
}

async function loadTabStashes(): Promise<LoadedTabStashes> {
  const [values, workspaces] = await Promise.all([
    chrome.storage.local.get([STASHES_KEY, SETTINGS_KEY, QUARANTINE_KEY, TRASH_KEY]),
    readStoredLinkedWorkspacesLenient(),
  ]);
  const now = Date.now();
  const { stashes: stored, rejected } = partitionStoredTabStashes(values[STASHES_KEY]);
  const settings = normalizeTabStashSettings(values[SETTINGS_KEY]);
  const activeWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const reconciled = stored.map((stash) =>
    stash.activeWorkspaceId && !activeWorkspaceIds.has(stash.activeWorkspaceId)
      ? { ...stash, activeWorkspaceId: null }
      : stash,
  );
  const { kept: current, expired } = partitionExpiredTabStashes(reconciled, settings, now);
  const trash = partitionStoredTrash(values[TRASH_KEY], now);
  const quarantined = [...rejected, ...trash.rejected];
  const stashesChanged = current.length !== stored.length || current.some((stash, index) => stash !== stored[index]);
  const trashChanged = expired.length > 0 || trash.purged || trash.rejected.length > 0;
  if (quarantined.length === 0 && !stashesChanged && !trashChanged) return { current, cleanup: null };
  // Quarantine, trash, and the cleaned list land in one write, so a record
  // is never removed from the list without being kept somewhere else.
  return {
    current,
    cleanup: {
      [STASHES_KEY]: current,
      ...(trashChanged ? { [TRASH_KEY]: [...trashEntries(expired, "expired", now), ...trash.trash] } : {}),
      ...(quarantined.length > 0 ? { [QUARANTINE_KEY]: appendQuarantine(values[QUARANTINE_KEY], quarantined, now) } : {}),
    },
  };
}

// Reads the list and applies any pending cleanup; the caller holds the lock.
async function readTabStashesLocked(): Promise<SavedTabStash[]> {
  const { current, cleanup } = await loadTabStashes();
  if (cleanup) await chrome.storage.local.set(cleanup);
  return current;
}

export async function readTabStashes(): Promise<SavedTabStash[]> {
  await migrateLegacyWorkspaceStorage();
  const loaded = await loadTabStashes();
  if (!loaded.cleanup) return loaded.current;
  // The cleanup rewrites the whole list, so it is recomputed under the lock
  // rather than written from this snapshot over a concurrent save.
  return withStashListLock(readTabStashesLocked);
}

export async function readTabStashTrash(): Promise<TrashedTabStash[]> {
  await migrateLegacyWorkspaceStorage();
  await readTabStashes();
  const values = await chrome.storage.local.get(TRASH_KEY);
  return partitionStoredTrash(values[TRASH_KEY], Date.now()).trash;
}

// Writes the saved list and the trash together, for moves between the two.
// The update sees the current list and trash under the lock, so a concurrent
// save is never written over.
export async function updateTabStashesAndTrash(
  update: (stashes: SavedTabStash[], trash: TrashedTabStash[]) => {
    stashes: readonly SavedTabStash[];
    trash: readonly TrashedTabStash[];
  },
): Promise<void> {
  await migrateLegacyWorkspaceStorage();
  await withStashListLock(async () => {
    const current = await readTabStashesLocked();
    const values = await chrome.storage.local.get(TRASH_KEY);
    const next = update(current, partitionStoredTrash(values[TRASH_KEY], Date.now()).trash);
    assertTabStashLimits(next.stashes);
    await chrome.storage.local.set({
      [STASHES_KEY]: structuredClone([...next.stashes]),
      [TRASH_KEY]: structuredClone([...next.trash]),
    });
  });
}

export async function readTabStashQuarantine(): Promise<QuarantinedTabStash[]> {
  await migrateLegacyWorkspaceStorage();
  const values = await chrome.storage.local.get(QUARANTINE_KEY);
  return normalizeQuarantine(values[QUARANTINE_KEY], Date.now());
}

export async function clearTabStashQuarantine(): Promise<void> {
  await migrateLegacyWorkspaceStorage();
  await withStashListLock(() => chrome.storage.local.set({ [QUARANTINE_KEY]: [] }));
}

export async function readTabStashSettings(): Promise<TabStashSettings> {
  await migrateLegacyWorkspaceStorage();
  const values = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeTabStashSettings(values[SETTINGS_KEY]);
}

export async function writeTabStashSettings(
  settings: TabStashSettings,
): Promise<{ settings: TabStashSettings; stashes: SavedTabStash[] }> {
  await migrateLegacyWorkspaceStorage();
  const normalized = normalizeTabStashSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  // The read applies the new limit, moving anything now expired to the trash.
  return { settings: normalized, stashes: await readTabStashes() };
}

function assertTabStashLimits(stashes: readonly SavedTabStash[]): void {
  if (stashes.length > MAX_STASHES) {
    throw new Error(`You already have ${MAX_STASHES} saved workspaces. Delete one before saving another.`);
  }
  if (stashes.some((stash) => stash.tabs.length > MAX_STASHED_TABS)) {
    throw new Error(`A workspace can contain at most ${MAX_STASHED_TABS} tabs.`);
  }
}

interface TabStashWriteOptions {
  semanticMutation?: "local_only";
}

async function writeTabStashesLocked(
  stashes: readonly SavedTabStash[],
  options: TabStashWriteOptions,
): Promise<SavedTabStash[]> {
  assertTabStashLimits(stashes);
  const saved: SavedTabStash[] = structuredClone([...stashes]);
  await chrome.storage.local.set({
    [STASHES_KEY]: saved,
    ...(options.semanticMutation === "local_only" ? {
      [STASH_SEMANTIC_MUTATION_KEY]: { mode: "local_only", nonce: crypto.randomUUID() },
    } : {}),
  });
  return saved;
}

// Replaces the whole list (a backup restore, a reviewed search edit). Changes
// to one workspace go through updateTabStashes so a concurrent save survives.
export async function writeTabStashes(
  stashes: readonly SavedTabStash[],
  options: TabStashWriteOptions = {},
): Promise<SavedTabStash[]> {
  await migrateLegacyWorkspaceStorage();
  return withStashListLock(() => writeTabStashesLocked(stashes, options));
}

// Re-reads the list under the lock and writes what `update` returns, so work
// done between a caller's first read and its write (closing tabs, restoring a
// window) cannot drop a workspace saved in the meantime.
export async function updateTabStashes(
  update: (current: SavedTabStash[]) => readonly SavedTabStash[],
  options: TabStashWriteOptions = {},
): Promise<SavedTabStash[]> {
  await migrateLegacyWorkspaceStorage();
  return withStashListLock(async () => writeTabStashesLocked(update(await readTabStashesLocked()), options));
}

function isWorkspaceDraft(value: unknown): value is LinkedStashWorkspaceDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<LinkedStashWorkspaceDraft>;
  return Array.isArray(draft.tabs) && draft.tabs.length <= MAX_STASHED_TABS && draft.tabs.every(isStashedTab) &&
    Array.isArray(draft.groups) && draft.groups.every(isStashedGroup) &&
    typeof draft.capturedAt === "number" && typeof draft.captureToken === "string";
}

function isLinkedWorkspace(value: unknown): value is LinkedStashWorkspace {
  if (!value || typeof value !== "object") return false;
  const workspace = value as Partial<LinkedStashWorkspace>;
  return typeof workspace.id === "string" && typeof workspace.stashId === "string" &&
    typeof workspace.windowId === "number" &&
    (workspace.mode === "whole_window" || workspace.mode === "tracked_tabs") &&
    Array.isArray(workspace.trackedTabIds) && workspace.trackedTabIds.every(Number.isSafeInteger) &&
    (workspace.trackedTabs === undefined || (
      Array.isArray(workspace.trackedTabs) && workspace.trackedTabs.every((item) =>
        item && typeof item === "object" && Number.isSafeInteger(item.tabId) && typeof item.stableKey === "string"
      )
    )) &&
    (workspace.draft === undefined || workspace.draft === null || isWorkspaceDraft(workspace.draft)) &&
    typeof workspace.startedAt === "number" && typeof workspace.updatedAt === "number";
}

// Links persist locally so a browser restart can reconnect them. (They used
// to live in session storage, which an extension update clears, so there is
// nothing there to carry over.)
async function readStoredLinkedWorkspaceValue(): Promise<unknown> {
  const local = await chrome.storage.local.get(WORKSPACES_KEY);
  return local[WORKSPACES_KEY];
}

async function readStoredLinkedWorkspacesLenient(): Promise<LinkedStashWorkspace[]> {
  const stored = await readStoredLinkedWorkspaceValue();
  return Array.isArray(stored) ? stored.filter(isLinkedWorkspace) : [];
}

export async function readLinkedStashWorkspaces(): Promise<LinkedStashWorkspace[]> {
  await migrateLegacyWorkspaceStorage();
  const stored = await readStoredLinkedWorkspaceValue();
  if (stored === undefined) return [];
  if (!Array.isArray(stored) || !stored.every(isLinkedWorkspace)) {
    throw new Error("Stored linked windows are corrupt and were not used.");
  }
  return structuredClone(stored);
}

export async function writeLinkedStashWorkspaces(
  workspaces: readonly LinkedStashWorkspace[],
): Promise<LinkedStashWorkspace[]> {
  await migrateLegacyWorkspaceStorage();
  const saved = structuredClone([...workspaces]);
  await chrome.storage.local.set({ [WORKSPACES_KEY]: saved });
  return saved;
}
