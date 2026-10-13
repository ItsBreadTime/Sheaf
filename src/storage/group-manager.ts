import type {
  GroupManagerUndoPoint,
  GroupManagerPendingPreview,
  GroupManagerProvenance,
  GroupOwnershipOrigin,
  GroupOwnershipRecord,
  GroupStashLink,
} from "../shared/group-manager-types";
import { withStorageMutationLock } from "./mutation-lock";

const KEY = "groupManagerSession";

export interface GroupManagerSessionState {
  ownership: GroupOwnershipRecord[];
  stashLinks: GroupStashLink[];
  pendingPreviews: GroupManagerPendingPreview[];
  undoPoint: GroupManagerUndoPoint | null;
}

async function mutateGroupManagerSession(
  mutation: (state: GroupManagerSessionState) => GroupManagerSessionState,
): Promise<GroupManagerSessionState> {
  return withStorageMutationLock(KEY, async () =>
    writeGroupManagerSession(mutation(await readGroupManagerSession())));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validOwnership(value: unknown): value is GroupOwnershipRecord {
  const item = record(value);
  return validId(item.groupId) && validId(item.windowId) &&
    (item.origin === "created" || item.origin === "managed") &&
    typeof item.recordedAt === "number" && Number.isFinite(item.recordedAt) &&
    (item.transactionId === undefined || typeof item.transactionId === "string");
}

function normalizeOwnership(value: unknown): GroupOwnershipRecord | null {
  if (!validOwnership(value)) return null;
  return { ...value, managed: record(value).managed !== false };
}

function validStashLink(value: unknown): value is GroupStashLink {
  const item = record(value);
  return validId(item.groupId) && validId(item.windowId) &&
    typeof item.stashId === "string" &&
    Array.isArray(item.memberTabIds) && item.memberTabIds.every(validId) &&
    typeof item.title === "string" && typeof item.color === "string" &&
    typeof item.collapsed === "boolean" &&
    typeof item.recordedAt === "number" && Number.isFinite(item.recordedAt);
}

function validUndo(value: unknown): value is GroupManagerUndoPoint {
  const item = record(value);
  return typeof item.transactionId === "string" &&
    typeof item.createdAt === "number" && Number.isFinite(item.createdAt) &&
    Array.isArray(item.points);
}

function validProvenance(value: unknown): value is GroupManagerProvenance {
  const item = record(value);
  return validId(item.groupId) &&
    (item.origin === "created" || item.origin === "managed") &&
    (item.managed === undefined || typeof item.managed === "boolean") &&
    (item.transactionId === undefined || typeof item.transactionId === "string") &&
    (item.stashLink === undefined || validStashLink(item.stashLink));
}

function validPendingPreview(value: unknown): value is GroupManagerPendingPreview {
  const item = record(value);
  return typeof item.previewToken === "string" && item.previewToken.length > 0 &&
    typeof item.recordedAt === "number" && Number.isFinite(item.recordedAt) &&
    Array.isArray(item.provenance) && item.provenance.every(validProvenance);
}

export function normalizeGroupManagerSession(value: unknown): GroupManagerSessionState {
  const root = record(value);
  return {
    ownership: Array.isArray(root.ownership)
      ? root.ownership.flatMap((item) => normalizeOwnership(item) ?? [])
      : [],
    stashLinks: Array.isArray(root.stashLinks)
      ? root.stashLinks.filter(validStashLink)
      : [],
    pendingPreviews: Array.isArray(root.pendingPreviews)
      ? root.pendingPreviews.filter(validPendingPreview)
      : [],
    undoPoint: validUndo(root.undoPoint) ? root.undoPoint : null,
  };
}

export async function readGroupManagerSession(): Promise<GroupManagerSessionState> {
  const values = await chrome.storage.session.get(KEY);
  return normalizeGroupManagerSession(values[KEY]);
}

async function writeGroupManagerSession(
  state: GroupManagerSessionState,
): Promise<GroupManagerSessionState> {
  const saved = structuredClone(state);
  await chrome.storage.session.set({ [KEY]: saved });
  return saved;
}

export async function reconcileGroupManagerSession(
  liveGroups: readonly { id: number; windowId: number }[],
): Promise<GroupManagerSessionState> {
  const live = new Set(liveGroups.map((group) => `${group.windowId}:${group.id}`));
  return mutateGroupManagerSession((state) => ({
    ...state,
    ownership: state.ownership.filter((item) => live.has(`${item.windowId}:${item.groupId}`)),
    stashLinks: state.stashLinks.filter((item) => live.has(`${item.windowId}:${item.groupId}`)),
  }));
}

export async function recordGroupOwnership(
  groups: readonly { groupId: number; windowId: number }[],
  origin: GroupOwnershipOrigin,
  transactionId?: string,
): Promise<GroupManagerSessionState> {
  return mutateGroupManagerSession((state) => {
    const byKey = new Map(state.ownership.map((item) => [`${item.windowId}:${item.groupId}`, item]));
    const now = Date.now();
    groups.forEach((group) => {
      const key = `${group.windowId}:${group.groupId}`;
      const previous = byKey.get(key);
      byKey.set(key, {
        groupId: group.groupId,
        windowId: group.windowId,
        origin: previous?.origin === "created" ? "created" : origin,
        managed: previous?.managed ?? true,
        recordedAt: previous?.recordedAt ?? now,
        ...(previous?.transactionId || transactionId
          ? { transactionId: previous?.transactionId ?? transactionId }
          : {}),
      });
    });
    return { ...state, ownership: [...byKey.values()] };
  });
}

export async function forgetGroupOwnership(
  groupId: number,
  windowId?: number,
): Promise<void> {
  await mutateGroupManagerSession((state) => ({
    ...state,
    ownership: state.ownership.filter((item) =>
      item.groupId !== groupId || (windowId !== undefined && item.windowId !== windowId)),
    stashLinks: state.stashLinks.filter((item) =>
      item.groupId !== groupId || (windowId !== undefined && item.windowId !== windowId)),
  }));
}

export async function setManualGroupManagement(
  groups: readonly { groupId: number; windowId: number }[],
  managed: boolean,
): Promise<GroupManagerSessionState> {
  return mutateGroupManagerSession((state) => {
    const byKey = new Map(state.ownership.map((item) => [`${item.windowId}:${item.groupId}`, item]));
    const now = Date.now();
    groups.forEach((group) => {
      const key = `${group.windowId}:${group.groupId}`;
      const previous = byKey.get(key);
      if (!previous && !managed) return;
      byKey.set(key, previous
        ? { ...previous, managed }
        : {
            groupId: group.groupId,
            windowId: group.windowId,
            origin: "managed",
            managed: true,
            recordedAt: now,
          });
    });
    return { ...state, ownership: [...byKey.values()] };
  });
}

export async function recordGroupStashLinks(
  links: readonly GroupStashLink[],
): Promise<GroupManagerSessionState> {
  return mutateGroupManagerSession((state) => {
    const byKey = new Map(state.stashLinks.map((item) => [`${item.windowId}:${item.groupId}`, item]));
    links.forEach((link) => byKey.set(`${link.windowId}:${link.groupId}`, structuredClone(link)));
    return { ...state, stashLinks: [...byKey.values()] };
  });
}

export async function writeGroupManagerUndo(
  undoPoint: GroupManagerUndoPoint | null,
): Promise<void> {
  await mutateGroupManagerSession((state) => ({ ...state, undoPoint }));
}

export async function recordGroupManagerPreview(
  previewToken: string,
  provenance: readonly GroupManagerProvenance[],
): Promise<void> {
  await mutateGroupManagerSession((state) => ({
    ...state,
    pendingPreviews: [
      { previewToken, recordedAt: Date.now(), provenance: structuredClone([...provenance]) },
      ...state.pendingPreviews.filter((item) => item.previewToken !== previewToken),
    ].slice(0, 8),
  }));
}
