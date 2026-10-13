import { planStashSearchEdit, previewStashSearchEdit } from "../search/stash-editing";
import type { StashTabReference } from "../search/stash-selection";
import type {
  SavedTabStash,
  StashSearchEditApplyResult,
  StashSearchEditOperation,
  StashSearchEditPreview,
  StashSearchEditUndoPoint,
  StashSearchEditUndoResult,
} from "../shared/stash-types";
import { normalizeTabStashes, readTabStashes, writeTabStashes } from "./stashes";
import { withStorageMutationLock } from "./mutation-lock";

const UNDO_KEY = "workspaceSearchEditUndoPoint";

function withSearchEditMutationLock<T>(task: () => Promise<T>): Promise<T> {
  return withStorageMutationLock(UNDO_KEY, task);
}

function stableStoredValue(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    return Object.fromEntries(Object.keys(candidate).sort().flatMap((key) =>
      candidate[key] === undefined ? [] : [[key, candidate[key]]],
    ));
  });
}

function stashesMatch(left: readonly SavedTabStash[], right: readonly SavedTabStash[]): boolean {
  return stableStoredValue(left) === stableStoredValue(right);
}

function writeSearchEditStashes(stashes: readonly SavedTabStash[]): Promise<SavedTabStash[]> {
  return writeTabStashes(stashes, { semanticMutation: "local_only" });
}

function normalizeUndoPoint(value: unknown): StashSearchEditUndoPoint | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") return null;
  const point = value as Partial<StashSearchEditUndoPoint>;
  if (
    typeof point.transactionId !== "string" || point.transactionId.length === 0 ||
    typeof point.createdAt !== "number" || !Number.isFinite(point.createdAt) ||
    (point.operation !== "remove" && point.operation !== "move" && point.operation !== "merge") ||
    !Array.isArray(point.before) || !Array.isArray(point.after) ||
    point.before.length < 1 || point.before.length > 50 || point.after.length !== point.before.length
  ) return null;
  try {
    const before = normalizeTabStashes(point.before);
    const after = normalizeTabStashes(point.after);
    const ids = new Set(before.map((stash) => stash.id));
    if (ids.size !== before.length || before.some((stash, index) => stash.id !== after[index]?.id)) return null;
    return { transactionId: point.transactionId, createdAt: point.createdAt, operation: point.operation, before, after };
  } catch {
    return null;
  }
}

export async function readStashSearchEditUndoPoint(): Promise<StashSearchEditUndoPoint | null> {
  const values = await chrome.storage.session.get(UNDO_KEY);
  return normalizeUndoPoint(values[UNDO_KEY]);
}

async function writeUndoPoint(point: StashSearchEditUndoPoint | null): Promise<void> {
  await chrome.storage.session.set({ [UNDO_KEY]: point === null ? null : structuredClone(point) });
}

function undoPointsMatch(left: StashSearchEditUndoPoint | null, right: StashSearchEditUndoPoint | null): boolean {
  return stableStoredValue(left) === stableStoredValue(right);
}

async function writeAndVerifyUndoPoint(point: StashSearchEditUndoPoint | null): Promise<void> {
  await writeUndoPoint(point);
  if (!undoPointsMatch(await readStashSearchEditUndoPoint(), point)) {
    throw new Error(point ? "The undo point could not be verified." : "The undo point could not be cleared.");
  }
}

async function restoreAfterFailure(
  before: readonly SavedTabStash[],
  undoBefore: StashSearchEditUndoPoint | null,
): Promise<void> {
  await writeSearchEditStashes(before);
  const restored = await readTabStashes();
  if (!stashesMatch(restored, before)) throw new Error("The workspace edit failed and its rollback could not be verified.");
  await writeAndVerifyUndoPoint(undoBefore);
}

export async function previewStoredStashSearchEdit(
  references: readonly StashTabReference[],
  operation: StashSearchEditOperation,
  targetStashId?: string | null,
): Promise<StashSearchEditPreview> {
  return previewStashSearchEdit(await readTabStashes(), references, operation, { targetStashId });
}

export async function applyStoredStashSearchEdit(
  references: readonly StashTabReference[],
  operation: StashSearchEditOperation,
  targetStashId: string | null | undefined,
  reviewedSelectionToken: string,
): Promise<StashSearchEditApplyResult> {
  return withSearchEditMutationLock(async () => {
    const [before, undoBefore] = await Promise.all([readTabStashes(), readStashSearchEditUndoPoint()]);
    const plan = planStashSearchEdit(before, references, operation, {
      targetStashId,
      reviewedSelectionToken,
    });
    if (plan.requiresReview || !plan.undoPoint) {
      return { preview: plan.preview, applied: false, requiresReview: true, transactionId: null };
    }
    try {
      await writeSearchEditStashes(plan.stashes);
      const persisted = await readTabStashes();
      if (!stashesMatch(persisted, plan.stashes)) throw new Error("The edited workspaces could not be verified.");
      await writeAndVerifyUndoPoint(plan.undoPoint);
      return {
        preview: plan.preview,
        applied: true,
        requiresReview: false,
        transactionId: plan.undoPoint.transactionId,
      };
    } catch (error) {
      try {
        await restoreAfterFailure(before, undoBefore);
      } catch (rollbackError) {
        throw rollbackError;
      }
      throw error;
    }
  });
}

export async function undoStoredStashSearchEdit(transactionId: string): Promise<StashSearchEditUndoResult> {
  return withSearchEditMutationLock(async () => {
    const point = await readStashSearchEditUndoPoint();
    if (!point || point.transactionId !== transactionId) {
      return { undone: false, unavailableReason: "This workspace edit is no longer available to undo." };
    }
    const current = await readTabStashes();
    const currentById = new Map(current.map((stash) => [stash.id, stash]));
    if (point.after.some((after) => {
      const stored = currentById.get(after.id);
      return !stored || stableStoredValue(stored) !== stableStoredValue(after);
    })) {
      return { undone: false, unavailableReason: "An affected workspace changed after this edit, so undo was not applied." };
    }
    const beforeById = new Map(point.before.map((stash) => [stash.id, stash]));
    const restored = current.map((stash) => beforeById.get(stash.id) ?? stash);
    try {
      await writeSearchEditStashes(restored);
      const persisted = await readTabStashes();
      if (!stashesMatch(persisted, restored)) throw new Error("The restored workspaces could not be verified.");
      await writeAndVerifyUndoPoint(null);
      return { undone: true, unavailableReason: null };
    } catch (error) {
      try {
        await restoreAfterFailure(current, point);
      } catch (rollbackError) {
        throw rollbackError;
      }
      throw error;
    }
  });
}
