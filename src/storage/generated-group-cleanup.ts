import type {
  GeneratedGroupAutoCleanupDays,
  GeneratedGroupCleanupRun,
  GeneratedGroupCleanupSettings,
  GeneratedGroupTrackingRecord,
  GroupOwnershipRecord,
} from "../shared/group-manager-types";
import type { SemanticGroup, SemanticWindowState } from "../shared/types";
import { withStorageMutationLock } from "./mutation-lock";

export const GENERATED_GROUP_CLEANUP_SETTINGS_KEY = "generatedGroupCleanupSettings";
const TRACKING_KEY = "generatedGroupTracking";
const LAST_RUN_KEY = "generatedGroupCleanupLastRun";
const BROWSER_SESSION_KEY = "generatedGroupCleanupBrowserSession";
const MAX_TRACKED_GROUPS = 500;
const MAX_UNMATCHED_AGE_MS = 366 * 24 * 60 * 60_000;
const AUTO_CLEANUP_OPTIONS = new Set<GeneratedGroupAutoCleanupDays>([null, 1, 3, 7, 14, 30, 90]);

export interface LiveGeneratedGroupMatch {
  record: GeneratedGroupTrackingRecord;
  state: SemanticWindowState;
  group: SemanticGroup;
}

export interface GeneratedGroupReconciliation {
  records: GeneratedGroupTrackingRecord[];
  matches: LiveGeneratedGroupMatch[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeTrackingRecord(value: unknown): GeneratedGroupTrackingRecord | null {
  const item = object(value);
  if (
    typeof item.id !== "string" || item.id.length === 0 ||
    !validId(item.groupId) || !validId(item.windowId) ||
    typeof item.browserSessionId !== "string" || item.browserSessionId.length === 0 ||
    !validTimestamp(item.createdAt) || !validTimestamp(item.lastSeenAt) ||
    !(item.fingerprint === null || typeof item.fingerprint === "string") ||
    !(item.transactionId === undefined || typeof item.transactionId === "string")
  ) return null;
  return {
    id: item.id,
    groupId: item.groupId,
    windowId: item.windowId,
    browserSessionId: item.browserSessionId,
    createdAt: item.createdAt,
    lastSeenAt: item.lastSeenAt,
    fingerprint: item.fingerprint,
    ...(typeof item.transactionId === "string" ? { transactionId: item.transactionId } : {}),
  };
}

export function normalizeGeneratedGroupCleanupSettings(value: unknown): GeneratedGroupCleanupSettings {
  const days = object(value).autoUngroupAfterDays;
  return {
    autoUngroupAfterDays: AUTO_CLEANUP_OPTIONS.has(days as GeneratedGroupAutoCleanupDays)
      ? days as GeneratedGroupAutoCleanupDays
      : null,
  };
}

export function normalizeGeneratedGroupTracking(value: unknown): GeneratedGroupTrackingRecord[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, GeneratedGroupTrackingRecord>();
  value.forEach((item) => {
    const normalized = normalizeTrackingRecord(item);
    if (normalized) byId.set(normalized.id, normalized);
  });
  return [...byId.values()]
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, MAX_TRACKED_GROUPS);
}

export function normalizeGeneratedGroupCleanupRun(value: unknown): GeneratedGroupCleanupRun | null {
  const item = object(value);
  if (
    !(item.mode === "automatic" || item.mode === "manual") ||
    !validTimestamp(item.ranAt) ||
    !validId(item.groupsUngrouped) ||
    !validId(item.tabsKeptOpen) ||
    !validId(item.groupsSkipped)
  ) return null;
  return {
    mode: item.mode,
    ranAt: item.ranAt,
    groupsUngrouped: item.groupsUngrouped,
    tabsKeptOpen: item.tabsKeptOpen,
    groupsSkipped: item.groupsSkipped,
  };
}

async function browserSessionId(): Promise<string> {
  const values = await chrome.storage.session.get(BROWSER_SESSION_KEY);
  if (typeof values[BROWSER_SESSION_KEY] === "string" && values[BROWSER_SESSION_KEY].length > 0) {
    return values[BROWSER_SESSION_KEY] as string;
  }
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [BROWSER_SESSION_KEY]: id });
  return id;
}

async function groupFingerprint(state: SemanticWindowState, group: SemanticGroup): Promise<string> {
  const urls = group.memberTabIds.flatMap((tabId) => {
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    return tab ? [tab.url.normalize("NFKC")] : [];
  }).sort();
  const identity = JSON.stringify({
    title: group.title.normalize("NFKC").trim(),
    color: group.color,
    urls,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function liveGroups(states: readonly SemanticWindowState[]): Promise<Array<{
  state: SemanticWindowState;
  group: SemanticGroup;
  fingerprint: string;
}>> {
  return Promise.all(states.flatMap((state) => state.groups.map(async (group) => ({
    state,
    group,
    fingerprint: await groupFingerprint(state, group),
  }))));
}

export async function readGeneratedGroupCleanupSettings(): Promise<GeneratedGroupCleanupSettings> {
  const values = await chrome.storage.local.get(GENERATED_GROUP_CLEANUP_SETTINGS_KEY);
  return normalizeGeneratedGroupCleanupSettings(values[GENERATED_GROUP_CLEANUP_SETTINGS_KEY]);
}

export async function writeGeneratedGroupCleanupSettings(
  settings: GeneratedGroupCleanupSettings,
): Promise<GeneratedGroupCleanupSettings> {
  const normalized = normalizeGeneratedGroupCleanupSettings(settings);
  await chrome.storage.local.set({ [GENERATED_GROUP_CLEANUP_SETTINGS_KEY]: normalized });
  return normalized;
}

export async function readGeneratedGroupCleanupLastRun(): Promise<GeneratedGroupCleanupRun | null> {
  const values = await chrome.storage.local.get(LAST_RUN_KEY);
  return normalizeGeneratedGroupCleanupRun(values[LAST_RUN_KEY]);
}

export async function writeGeneratedGroupCleanupLastRun(run: GeneratedGroupCleanupRun): Promise<void> {
  const normalized = normalizeGeneratedGroupCleanupRun(run);
  if (!normalized) throw new Error("Generated-group cleanup result is invalid.");
  await chrome.storage.local.set({ [LAST_RUN_KEY]: normalized });
}

type GeneratedGroupRequest = { groupId: number; windowId: number; createdAt?: number; transactionId?: string };

// Organize runs, the cleanup alarm, and manual cleanup all rewrite the tracking
// list, so each read-modify-write holds this lock to keep their records.
function withTrackingLock<T>(task: () => Promise<T>): Promise<T> {
  return withStorageMutationLock(TRACKING_KEY, task);
}

export async function recordGeneratedGroups(
  states: readonly SemanticWindowState[],
  groups: readonly GeneratedGroupRequest[],
  now = Date.now(),
): Promise<GeneratedGroupTrackingRecord[]> {
  return withTrackingLock(() => recordGeneratedGroupsUnlocked(states, groups, now));
}

async function recordGeneratedGroupsUnlocked(
  states: readonly SemanticWindowState[],
  groups: readonly GeneratedGroupRequest[],
  now: number,
): Promise<GeneratedGroupTrackingRecord[]> {
  if (groups.length === 0) return normalizeGeneratedGroupTracking((await chrome.storage.local.get(TRACKING_KEY))[TRACKING_KEY]);
  const [sessionId, values, live] = await Promise.all([
    browserSessionId(),
    chrome.storage.local.get(TRACKING_KEY),
    liveGroups(states),
  ]);
  const records = normalizeGeneratedGroupTracking(values[TRACKING_KEY]);
  const byRuntime = new Map(records
    .filter((item) => item.browserSessionId === sessionId)
    .map((item) => [`${item.windowId}:${item.groupId}`, item]));
  for (const requested of groups) {
    const current = live.find(({ group }) =>
      group.runtimeId === requested.groupId && group.windowId === requested.windowId);
    if (!current) continue;
    const key = `${requested.windowId}:${requested.groupId}`;
    const previous = byRuntime.get(key);
    if (previous) {
      previous.lastSeenAt = now;
      previous.fingerprint = current.fingerprint;
      if (!previous.transactionId && requested.transactionId) previous.transactionId = requested.transactionId;
      continue;
    }
    const record: GeneratedGroupTrackingRecord = {
      id: crypto.randomUUID(),
      groupId: requested.groupId,
      windowId: requested.windowId,
      browserSessionId: sessionId,
      createdAt: requested.createdAt ?? now,
      lastSeenAt: now,
      fingerprint: current.fingerprint,
      ...(requested.transactionId ? { transactionId: requested.transactionId } : {}),
    };
    records.push(record);
    byRuntime.set(key, record);
  }
  const normalized = normalizeGeneratedGroupTracking(records);
  await chrome.storage.local.set({ [TRACKING_KEY]: normalized });
  return normalized;
}

export async function reconcileGeneratedGroups(
  states: readonly SemanticWindowState[],
  ownership: readonly GroupOwnershipRecord[] = [],
  now = Date.now(),
): Promise<GeneratedGroupReconciliation> {
  return withTrackingLock(() => reconcileGeneratedGroupsUnlocked(states, ownership, now));
}

async function reconcileGeneratedGroupsUnlocked(
  states: readonly SemanticWindowState[],
  ownership: readonly GroupOwnershipRecord[],
  now: number,
): Promise<GeneratedGroupReconciliation> {
  const createdOwnership = ownership.filter((item) => item.origin === "created");
  await recordGeneratedGroupsUnlocked(states, createdOwnership.map((item) => ({
    groupId: item.groupId,
    windowId: item.windowId,
    createdAt: item.recordedAt,
    transactionId: item.transactionId,
  })), now);
  const [sessionId, values, live] = await Promise.all([
    browserSessionId(),
    chrome.storage.local.get(TRACKING_KEY),
    liveGroups(states),
  ]);
  const records = normalizeGeneratedGroupTracking(values[TRACKING_KEY]);
  const unmatchedLive = new Set(live.map((_, index) => index));
  const next: GeneratedGroupTrackingRecord[] = [];
  const matches: LiveGeneratedGroupMatch[] = [];
  const match = (record: GeneratedGroupTrackingRecord, liveIndex: number): void => {
    const current = live[liveIndex]!;
    unmatchedLive.delete(liveIndex);
    const updated: GeneratedGroupTrackingRecord = {
      ...record,
      groupId: current.group.runtimeId,
      windowId: current.group.windowId,
      browserSessionId: sessionId,
      lastSeenAt: now,
      fingerprint: current.fingerprint,
    };
    next.push(updated);
    matches.push({ record: updated, state: current.state, group: current.group });
  };

  for (const record of records.filter((item) => item.browserSessionId === sessionId)) {
    const liveIndex = live.findIndex(({ group }) =>
      group.runtimeId === record.groupId && group.windowId === record.windowId);
    if (liveIndex >= 0 && unmatchedLive.has(liveIndex)) match(record, liveIndex);
  }

  const oldRecords = records.filter((item) => item.browserSessionId !== sessionId);
  const recordsByFingerprint = new Map<string, GeneratedGroupTrackingRecord[]>();
  oldRecords.forEach((record) => {
    if (!record.fingerprint) return;
    const items = recordsByFingerprint.get(record.fingerprint) ?? [];
    items.push(record);
    recordsByFingerprint.set(record.fingerprint, items);
  });
  for (const [fingerprint, candidates] of recordsByFingerprint) {
    const liveIndexes = [...unmatchedLive].filter((index) => live[index]!.fingerprint === fingerprint);
    if (liveIndexes.length !== candidates.length) continue;
    candidates
      .sort((left, right) => left.createdAt - right.createdAt)
      .forEach((record, index) => match(record, liveIndexes[index]!));
  }

  const matchedIds = new Set(next.map((item) => item.id));
  oldRecords.forEach((record) => {
    if (!matchedIds.has(record.id) && now - record.lastSeenAt <= MAX_UNMATCHED_AGE_MS) next.push(record);
  });
  const normalized = normalizeGeneratedGroupTracking(next);
  await chrome.storage.local.set({ [TRACKING_KEY]: normalized });
  return { records: normalized, matches };
}

export async function forgetGeneratedGroups(
  groups: readonly { groupId: number; windowId: number }[],
): Promise<void> {
  if (groups.length === 0) return;
  await withTrackingLock(async () => {
    const values = await chrome.storage.local.get(TRACKING_KEY);
    const removed = new Set(groups.map((item) => `${item.windowId}:${item.groupId}`));
    const records = normalizeGeneratedGroupTracking(values[TRACKING_KEY]).filter((item) =>
      !removed.has(`${item.windowId}:${item.groupId}`));
    await chrome.storage.local.set({ [TRACKING_KEY]: records });
  });
}
