import { ORGANIZATION_TRANSACTION, ORGANIZATION_RUN, PROPOSAL_REVIEW, WINDOW_CAPTURE } from "../shared/constants";
import type {
  EditorSessionState,
  OrganizationRun,
  WindowCaptureViewState,
} from "../shared/types";
import type { EditorLease } from "../shared/proposal-review-types";
import type { UndoPoint } from "../shared/transaction-types";
import { ensureSessionStorageCapacity } from "./session-budget";

const KEYS = WINDOW_CAPTURE.SESSION_KEYS;
const ORGANIZATION_RUN_KEYS = ORGANIZATION_RUN.SESSION_KEYS;

export async function readWindowCaptureViewState(): Promise<WindowCaptureViewState> {
  const values = await chrome.storage.session.get([
    KEYS.editor,
    ORGANIZATION_RUN_KEYS.activeRun,
    PROPOSAL_REVIEW.SESSION_KEYS.editorLease,
    ORGANIZATION_TRANSACTION.SESSION_KEYS.undoPoint,
  ]);

  return {
    editor: (values[KEYS.editor] as EditorSessionState | undefined) ?? null,
    editorLease:
      (values[PROPOSAL_REVIEW.SESSION_KEYS.editorLease] as EditorLease | undefined) ??
      null,
    transactionRun:
      (values[ORGANIZATION_RUN_KEYS.activeRun] as OrganizationRun | undefined) ?? null,
    undoPoint:
      (values[ORGANIZATION_TRANSACTION.SESSION_KEYS.undoPoint] as UndoPoint | undefined) ?? null,
  };
}

/**
 * Folds a `chrome.storage.onChanged` session event into a view state, so a page
 * can follow the worker's writes instead of polling for the whole state.
 * Returns null when the event touches none of the view-state keys.
 */
export function applyViewStateStorageChanges(
  state: WindowCaptureViewState,
  changes: Record<string, chrome.storage.StorageChange>,
): WindowCaptureViewState | null {
  const fields = [
    ["editor", KEYS.editor],
    ["editorLease", PROPOSAL_REVIEW.SESSION_KEYS.editorLease],
    ["transactionRun", ORGANIZATION_RUN_KEYS.activeRun],
    ["undoPoint", ORGANIZATION_TRANSACTION.SESSION_KEYS.undoPoint],
  ] as const;
  let next: WindowCaptureViewState | null = null;
  for (const [field, key] of fields) {
    const change = changes[key];
    if (!change) continue;
    next = { ...(next ?? state), [field]: change.newValue ?? null };
  }
  return next;
}

export async function writeEditorLease(lease: EditorLease | null): Promise<void> {
  if (lease) {
    await chrome.storage.session.set({
      [PROPOSAL_REVIEW.SESSION_KEYS.editorLease]: lease,
    });
  } else {
    await chrome.storage.session.remove(PROPOSAL_REVIEW.SESSION_KEYS.editorLease);
  }
}

export async function writeOrganizationRun(run: OrganizationRun): Promise<void> {
  // The journal travels inside the run. It used to be written a second time
  // under its own key, which nothing read and which doubled the run's budget.
  const values = { [ORGANIZATION_RUN_KEYS.activeRun]: run };
  await ensureSessionStorageCapacity(values);
  await chrome.storage.session.set(values);
}

export async function writeEditorState(state: EditorSessionState): Promise<void> {
  await chrome.storage.session.set({ [KEYS.editor]: state });
}
