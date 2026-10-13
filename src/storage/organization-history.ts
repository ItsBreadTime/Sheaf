import { ORGANIZATION_TRANSACTION } from "../shared/constants";
import type { OrganizationHistoryReport, UndoPoint } from "../shared/transaction-types";

function isWindowStateShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.windowId === "number" && Array.isArray(state.tabs) && Array.isArray(state.groups);
}

function isUndoPointShape(value: unknown): value is UndoPoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return typeof point.transactionId === "string" &&
    typeof point.targetWindowId === "number" &&
    typeof point.createdAt === "number" &&
    typeof point.status === "string" &&
    Array.isArray(point.touchedTabIds) &&
    Array.isArray(point.conflicts) &&
    isWindowStateShape(point.before) &&
    isWindowStateShape(point.expectedAfter);
}

function isHistoryReportShape(value: unknown): value is OrganizationHistoryReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return typeof report.timestamp === "number" && typeof report.resultStatus === "string";
}

export async function readUndoPoint(): Promise<UndoPoint | null> {
  const values = await chrome.storage.session.get(ORGANIZATION_TRANSACTION.SESSION_KEYS.undoPoint);
  const stored = values[ORGANIZATION_TRANSACTION.SESSION_KEYS.undoPoint];
  // Fail closed on a corrupt or legacy record rather than handing it to undo.
  return isUndoPointShape(stored) ? stored : null;
}

export async function writeUndoPoint(point: UndoPoint | null): Promise<void> {
  if (point) {
    await chrome.storage.session.set({ [ORGANIZATION_TRANSACTION.SESSION_KEYS.undoPoint]: point });
  } else {
    await chrome.storage.session.remove(ORGANIZATION_TRANSACTION.SESSION_KEYS.undoPoint);
  }
}

export async function appendCountsOnlyHistory(report: OrganizationHistoryReport): Promise<void> {
  const values = await chrome.storage.local.get(ORGANIZATION_TRANSACTION.LOCAL_KEYS.history);
  const existing = (values[ORGANIZATION_TRANSACTION.LOCAL_KEYS.history] as OrganizationHistoryReport[] | undefined) ?? [];
  const expired = existing.map((item) =>
    item.undoStatus === "available"
      ? { ...item, undoStatus: "unavailable" as const }
      : item,
  );
  const history = [...expired, report].slice(-ORGANIZATION_TRANSACTION.MAX_HISTORY_REPORTS);
  await chrome.storage.local.set({ [ORGANIZATION_TRANSACTION.LOCAL_KEYS.history]: history });
}

export async function readCountsOnlyHistory(): Promise<OrganizationHistoryReport[]> {
  const values = await chrome.storage.local.get(ORGANIZATION_TRANSACTION.LOCAL_KEYS.history);
  const stored = values[ORGANIZATION_TRANSACTION.LOCAL_KEYS.history];
  // Drop entries that are not recognizable reports so a corrupt or legacy record
  // cannot reach the popup render.
  return Array.isArray(stored) ? stored.filter(isHistoryReportShape) : [];
}

export async function updateLatestHistoryUndoStatus(
  undoStatus: OrganizationHistoryReport["undoStatus"],
  undoConflictCount = 0,
): Promise<void> {
  const history = await readCountsOnlyHistory();
  const latest = history.at(-1);
  if (!latest) return;
  history[history.length - 1] = { ...latest, undoStatus, undoConflictCount };
  await chrome.storage.local.set({ [ORGANIZATION_TRANSACTION.LOCAL_KEYS.history]: history });
}
