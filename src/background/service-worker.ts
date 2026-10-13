import { readSemanticWindow } from "../browser/read-window";
import { isBlankNewTabUrl } from "../browser/domain-policy";
import { checkProposalDrift } from "../browser/drift-check";
import { findCleanupSuggestions } from "../browser/cleanup-suggestions";
import {
  buildTabStashPreview,
  savedStashFromPreview,
} from "../browser/tab-stashes";
import {
  buildGroupManagerState,
  groupManagerFingerprint,
  previewGroupEdit,
  previewGroupRemoval,
} from "../browser/group-manager";
import {
  buildStashWorkspaceDiff,
  stashWorkspaceCaptureToken,
} from "../browser/stash-workspaces";
import {
  applyUserProtections,
  protectionPatternForUrl,
} from "../browser/user-protection";
import {
  mapReviewToBrowserProposal,
  planIntegratedTransaction,
} from "../browser/integrated-operation-planner";
import { executeConflictAwareUndo } from "../browser/undo";
import {
  bestEffortDiagnostic,
  recordOperationalDiagnostic,
} from "../diagnostics/events";
import { applyDriftCheckResult, confirmProposalReview } from "../organizer/proposal-editor";
import { createProposalReviewState } from "../organizer/proposal-editor";
import { historyGenerationStats, summarizeWindowChanges, totalTabsMoved } from "../organizer/history-changes";
import { normalizeOrganizationScope, WHOLE_WINDOW_SCOPE } from "../organizer/scope";
import { shouldRecordGroupNameApprovals } from "../organizer/group-name-memory";
import {
  buildProposalDiff,
} from "../organizer/proposal-diff";
import { buildSanitizedRequest } from "../privacy/request-builder";
import { generateProposalWithDiagnostics } from "../provider/generate-with-diagnostics";
import { failStrandedTransaction, interruptActiveTransaction } from "./recovery-boundary";
import type { HistoryGenerationStats, OrganizationHistoryReport, UndoPoint } from "../shared/transaction-types";
import {
  executeTransaction,
  journalRestoreTabIds,
  restoreSnapshotMembership,
  type TransactionRuntime,
} from "./transaction-runner";
import { createEditorLeaseRuntime } from "./editor-lease";
import { UNGROUPED_GROUP_ID } from "../shared/constants";
import type {
  ImmutableRequestBundle,
  OrganizationScope,
  OrganizerStoredState,
  ProviderJobResult,
  ValidatedProposal,
} from "../shared/organizer-types";
import type {
  EditorSessionState,
  OrganizationRun,
  WindowCaptureMessage,
  WindowCaptureViewState,
  SemanticTab,
  SemanticWindowState,
} from "../shared/types";
import { replyIncludesViewState, type WindowCaptureResponseFor } from "../shared/message-state";
import { assertWindowCaptureMessage } from "../shared/message-validation";
import { forEachWithConcurrency } from "../shared/concurrency";
import { createRunSlot } from "./run-slot";
import type {
  LinkedStashWorkspace,
  SavedTabStash,
  StashCopyOpenResult,
  StashRestoreResult,
  SearchWorkspaceCreationResult,
  StashRestoreOptions,
  StashSearchEditApplyResult,
  StashSearchEditPreview,
  StashSearchEditUndoResult,
  StashWorkspaceDiff,
  TabStashPreview,
  TabStashScope,
} from "../shared/stash-types";
import type {
  GeneratedGroupAutoCleanupDays,
  GeneratedGroupCleanupResult,
  GeneratedGroupCleanupSummary,
  GroupManagerApplyResult,
  GroupManagerEditDraft,
  GroupManagerEditPreview,
  GroupManagerRemovalMode,
  GroupManagerRemovalPreview,
  GroupManagerState,
  GroupManagerUndoPoint,
  GroupManagerUndoResult,
  GroupStashLink,
} from "../shared/group-manager-types";
import {
  captureLinkedWindow,
  commitClosedWorkspaceWindow,
  draftFromCapture,
  focusLinkedWorkspace,
  noteWindowClosing,
  parkLinkedWorkspace,
  scheduleStartupWorkspaceReconciliation,
  scheduleWorkspaceDraft,
  settleWorkspaceWithoutWindow,
  settleWorkspaceWithoutWindowUnlocked,
  withWorkspaceLock,
} from "./stash-workspace-runtime";
import { canonicalExactUrl, createStashFromResolvedSelection, orderResolvedStashTabs, resolveStashTabReferences, stashSelectionResolutionToken, type StashTabReference } from "../search/stash-selection";
import {
  readWindowCaptureViewState,
  writeEditorState,
  writeEditorLease,
  writeOrganizationRun,
} from "../storage/session";
import {
  cancelRequestingProviderJob,
  readOrganizerState,
  recordGroupNameApprovals,
  writeImmutableRequest,
  writeProviderJob,
} from "../storage/organizer-state";
import { BACKGROUND_JOB_OWNER, reportBackgroundError } from "../storage/background-error";
import {
  readUserProtectionState,
  writePermanentProtectionRules,
  writeSessionProtections,
} from "../storage/protection";
import {
  createProposalInputSnapshot,
  readProposalReview,
  writeProposalReview,
} from "../storage/proposal-review";
import {
  appendCountsOnlyHistory,
  readUndoPoint,
  updateLatestHistoryUndoStatus,
  writeUndoPoint,
} from "../storage/organization-history";
import {
  readLinkedStashWorkspaces,
  readTabStashes,
  STASH_SEMANTIC_MUTATION_KEY,
  STASHES_KEY,
  migrateLegacyWorkspaceStorage,
  trashEntries,
  writeLinkedStashWorkspaces,
  updateTabStashes,
  updateTabStashesAndTrash,
} from "../storage/stashes";
import {
  readGroupManagerSession,
  recordGroupManagerPreview,
  reconcileGroupManagerSession,
  recordGroupOwnership,
  recordGroupStashLinks,
  setManualGroupManagement,
  writeGroupManagerUndo,
} from "../storage/group-manager";
import {
  GENERATED_GROUP_CLEANUP_SETTINGS_KEY,
  forgetGeneratedGroups,
  readGeneratedGroupCleanupLastRun,
  readGeneratedGroupCleanupSettings,
  reconcileGeneratedGroups,
  recordGeneratedGroups,
  writeGeneratedGroupCleanupLastRun,
  writeGeneratedGroupCleanupSettings,
} from "../storage/generated-group-cleanup";
import { readSearchState } from "../storage/search";
import {
  applyStoredStashSearchEdit,
  previewStoredStashSearchEdit,
  undoStoredStashSearchEdit,
} from "../storage/stash-search-edits";
import {
  SEMANTIC_INDEX_RESUME_ALARM,
  SEMANTIC_INDEX_MAINTENANCE_ALARM,
  cancelSemanticIndex,
  clearCurrentSemanticIndex,
  prepareSemanticIndex,
  reconcileSemanticStashChangesLocally,
  resumeSemanticIndex,
  runSemanticIndexMaintenance,
  scheduleSemanticIndexReconciliation,
  withLocalOnlySemanticStashMutation,
} from "./semantic-index-runtime";
import type { SemanticIndexMeta } from "../shared/semantic-index-types";
import {
  acceptAutoFilingSuggestion,
  AUTO_FILING_NOTIFICATION_PREFIX,
  autoFilingTabActivated,
  autoFilingTabCreated,
  autoFilingTabRemoved,
  autoFilingTabUpdated,
  autoFilingWindowRemoved,
  dismissAutoFilingSuggestion,
  installAutoFiling,
  neverFileFromEntry,
  noteAutoFilingSettingsChanged,
  undoAutoFiling,
} from "./auto-filing-runtime";
import { workspaceLockHeld } from "./stash-workspace-runtime";
import { AUTO_FILING_LOCAL_KEY, readAutoFilingView } from "../storage/auto-filing";
import type { AutoFilingViewState } from "../shared/auto-filing-types";
import { installUsageRecorder } from "../storage/usage-stats";

installUsageRecorder();

// Organize runs here rather than in the popup so closing the popup, or the
// browser hiding it, does not abandon a request that is already in flight.
const backgroundOrganize = createRunSlot<{ controller: AbortController }>();
const workerRecoveryPromise = markWorkerWakeInterruption();
void workerRecoveryPromise.then(() => resumeSemanticIndex()).catch(() => {
  // A later popup open or maintenance alarm will retry the persistent queue.
});
const CONTEXT_MENU_ORGANIZE_SELECTED = "organize-selected-tabs";
const CONTEXT_MENU_PROTECT_SELECTED = "protect-selected-tabs";
const CONTEXT_MENU_LOCK_GROUP = "lock-current-group";
const CONTEXT_MENU_STASH_GROUP = "stash-current-group";
const CONTEXT_MENU_STASH_SELECTED = "stash-selected-tabs";
const STASH_SHORTCUT_NOTIFICATION = "stash-shortcut";
const GENERATED_GROUP_CLEANUP_ALARM = "generated-group-cleanup";
const linkedWorkspaceRestores = new Set<string>();

interface DispatchResult {
  cleanupCloseResult?: { requested: number; closed: number; skipped: number };
  semanticIndexMeta?: SemanticIndexMeta;
  stashWorkspaceDiff?: StashWorkspaceDiff;
  stashWorkspaceParkResult?: { windowClosed: boolean };
  stashCopyOpenResult?: StashCopyOpenResult;
  stashRestoreResult?: StashRestoreResult;
  searchWorkspaceCreationResult?: SearchWorkspaceCreationResult;
  stashSearchEditPreview?: StashSearchEditPreview;
  stashSearchEditApplyResult?: StashSearchEditApplyResult;
  stashSearchEditUndoResult?: StashSearchEditUndoResult;
  groupManagerState?: GroupManagerState;
  groupManagerEditPreview?: GroupManagerEditPreview;
  groupManagerRemovalPreview?: GroupManagerRemovalPreview;
  groupManagerApplyResult?: GroupManagerApplyResult;
  groupManagerUndoResult?: GroupManagerUndoResult;
  generatedGroupCleanupSummary?: GeneratedGroupCleanupSummary;
  generatedGroupCleanupResult?: GeneratedGroupCleanupResult;
  autoFilingView?: AutoFilingViewState;
  autoFilingMessage?: string;
}

async function readConfiguredWindow(windowId: number): Promise<SemanticWindowState> {
  const [organizerData, protections] = await Promise.all([
    readOrganizerState(),
    readUserProtectionState(),
  ]);
  const state = await readSemanticWindow(windowId, organizerData.local.privacy);
  return applyUserProtections(
    state,
    protections.session,
    protections.permanentRules,
  );
}

function validateProtectionTarget(
  state: SemanticWindowState,
  targetWindowId: number,
): void {
  if (state.windowId !== targetWindowId) {
    throw new Error("Protection controls target a different browser window.");
  }
}

async function protectTabs(
  targetWindowId: number,
  tabIds: readonly number[],
  permanence: "session" | "permanent",
): Promise<void> {
  const [state, protections] = await Promise.all([
    readConfiguredWindow(targetWindowId),
    readUserProtectionState(),
  ]);
  validateProtectionTarget(state, targetWindowId);
  const requested = new Set(tabIds);
  const tabs = state.tabs.filter((tab) => requested.has(tab.id));
  if (tabs.length === 0 || tabs.length !== requested.size) {
    throw new Error("One or more selected tabs are no longer available.");
  }
  if (permanence === "session") {
    await writeSessionProtections({
      ...protections.session,
      tabIds: [...protections.session.tabIds, ...tabs.map((tab) => tab.id)],
    });
  } else {
    const existing = new Set(
      protections.permanentRules
        .filter((rule) => rule.kind === "location")
        .map((rule) => rule.pattern),
    );
    const additions = tabs.flatMap((tab) => {
      const pattern = protectionPatternForUrl(tab.url);
      if (!pattern || existing.has(pattern)) return [];
      existing.add(pattern);
      return [{
        id: crypto.randomUUID(),
        kind: "location" as const,
        pattern,
        createdAt: Date.now(),
      }];
    });
    await writePermanentProtectionRules([
      ...protections.permanentRules,
      ...additions,
    ]);
  }
  await refreshStoredCapture();
}

// Lifts restart-only locks from specific tabs or groups. Permanent rules are
// edited through protection:update-rules and are never touched here.
async function releaseSessionProtections(
  targetWindowId: number,
  tabIds: readonly number[],
  groupIds: readonly number[],
): Promise<void> {
  const [state, protections] = await Promise.all([
    readConfiguredWindow(targetWindowId),
    readUserProtectionState(),
  ]);
  validateProtectionTarget(state, targetWindowId);
  const tabs = new Set(tabIds);
  const groups = new Set(groupIds);
  await writeSessionProtections({
    tabIds: protections.session.tabIds.filter((id) => !tabs.has(id)),
    groupIds: protections.session.groupIds.filter((id) => !groups.has(id)),
  });
  await refreshStoredCapture();
}

async function lockGroups(
  targetWindowId: number,
  groupIds: readonly number[],
  permanence: "session" | "permanent",
): Promise<void> {
  const [state, protections] = await Promise.all([
    readConfiguredWindow(targetWindowId),
    readUserProtectionState(),
  ]);
  validateProtectionTarget(state, targetWindowId);
  const requested = new Set(groupIds);
  const groups = state.groups.filter((group) => requested.has(group.runtimeId));
  if (groups.length === 0 || groups.length !== requested.size) {
    throw new Error("One or more selected groups are no longer available.");
  }
  if (permanence === "session") {
    await writeSessionProtections({
      ...protections.session,
      groupIds: [...protections.session.groupIds, ...groups.map((group) => group.runtimeId)],
    });
  } else {
    if (groups.some((group) => !group.title.trim())) {
      throw new Error("An untitled group cannot be protected permanently by name.");
    }
    const existing = new Set(
      protections.permanentRules
        .filter((rule) => rule.kind === "group_title")
        .map((rule) => rule.pattern),
    );
    const additions = groups.flatMap((group) => {
      const pattern = group.title.trim().toLocaleLowerCase();
      if (existing.has(pattern)) return [];
      existing.add(pattern);
      return [{
        id: crypto.randomUUID(),
        kind: "group_title" as const,
        pattern,
        createdAt: Date.now(),
      }];
    });
    await writePermanentProtectionRules([
      ...protections.permanentRules,
      ...additions,
    ]);
  }
  await refreshStoredCapture();
}

async function selectedTabIds(windowId: number, fallbackTabId?: number): Promise<number[]> {
  const highlighted = await chrome.tabs.query({ windowId, highlighted: true });
  const ids = highlighted.flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
  if (ids.length > 0) return ids;
  return fallbackTabId === undefined ? [] : [fallbackTabId];
}

async function notifyStashShortcut(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create(STASH_SHORTCUT_NOTIFICATION, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message,
    });
  } catch {
    // Notifications can be blocked at the OS level; the stash itself is saved.
  }
}

// The menu click is the review: the same eligibility rules as the drawer
// apply, protected tabs stay open, and the result is reported right away.
async function stashFromShortcut(windowId: number, scope: TabStashScope): Promise<void> {
  try {
    const preview = buildTabStashPreview(await readConfiguredWindow(windowId), scope);
    await stashReviewedTabs(windowId, scope, preview.tabs.map((tab) => tab.sourceTabId), preview.name);
    const kept = preview.excludedTabs.length;
    await notifyStashShortcut(
      `Saved workspace “${preview.name}”`,
      `${preview.tabs.length} tab${preview.tabs.length === 1 ? "" : "s"} saved and closed.${kept > 0 ? ` ${kept} protected tab${kept === 1 ? " stays" : "s stay"} open.` : ""} Reopen it from Workspaces.`,
    );
  } catch (error) {
    await notifyStashShortcut("Nothing was saved", error instanceof Error ? error.message : "The tabs could not be saved as a workspace.");
  }
}

async function saveAndCloseLinkedWindow(windowId: number): Promise<void> {
  const [workspaces, stashes] = await Promise.all([readLinkedStashWorkspaces(), readTabStashes()]);
  const workspace = workspaces.find((candidate) => candidate.windowId === windowId);
  const stash = stashes.find((candidate) => candidate.id === workspace?.stashId);
  if (!workspace || !stash) {
    await notifyStashShortcut(
      "This window is not a linked workspace",
      "Open Workspaces to save it. Only windows opened from a workspace, or saved with “keep open”, close with this shortcut.",
    );
    return;
  }
  // A shortcut never closes tabs it cannot save; the drawer asks first instead.
  const { skippedPrivateTabs = 0 } = await captureLinkedWindow(workspace);
  if (skippedPrivateTabs > 0) {
    await notifyStashShortcut(
      "Window left open",
      `${skippedPrivateTabs} private tab${skippedPrivateTabs === 1 ? " is" : "s are"} open here and can't be saved. Close ${skippedPrivateTabs === 1 ? "it" : "them"} first, or use Save & close in Workspaces.`,
    );
    return;
  }
  await parkLinkedWorkspace(stash.id, { discardChanges: false });
}

async function openOrganizerForSelected(windowId: number): Promise<void> {
  await chrome.storage.session.set({
    pendingOrganizationScope: { windowId, createdAt: Date.now() },
  });
  await chrome.action.openPopup();
}

// The finder is a small window centered high over the browser window, like
// Spotlight, so it opens the same way on every page. Search gets a bare search
// field that grows with its results; organize gets the popup UI, which follows
// the run and then shows its review or result.
// Only one exists at a time, and it closes when focus leaves it.
const FINDER_WINDOW_KEY = "finderWindowId";
const FINDER_VIEW_KEY = "finderWindowView";

async function openFinderWindow(windowId: number, view: "search" | "organize"): Promise<void> {
  const FINDER_WIDTH = view === "search" ? 640 : 560;
  // The search page resizes itself to its content once it has loaded.
  const FINDER_HEIGHT = view === "search" ? 96 : 640;
  const stored = await chrome.storage.session.get(FINDER_WINDOW_KEY);
  const previous = stored[FINDER_WINDOW_KEY] as number | undefined;
  if (typeof previous === "number") await chrome.windows.remove(previous).catch(() => undefined);
  const parent = await chrome.windows.get(windowId);
  const width = Math.min(FINDER_WIDTH, parent.width ?? FINDER_WIDTH);
  const height = Math.min(FINDER_HEIGHT, parent.height ?? FINDER_HEIGHT);
  const left = (parent.left ?? 0) + Math.round(((parent.width ?? width) - width) / 2);
  const top = (parent.top ?? 0) + Math.max(48, Math.round((parent.height ?? 640) / 5));
  const url = view === "search"
    ? `finder.html?${new URLSearchParams({ window: String(windowId) }).toString()}`
    : `action.html?${new URLSearchParams({ floating: "1", window: String(windowId) }).toString()}`;
  const finder = await chrome.windows.create({
    url: chrome.runtime.getURL(url),
    type: "popup",
    focused: true,
    width,
    height,
    left,
    top,
  });
  if (finder?.id !== undefined) {
    await chrome.storage.session.set({ [FINDER_WINDOW_KEY]: finder.id, [FINDER_VIEW_KEY]: view });
  }
}

// While the organize window is up it shows the run itself, so notifications
// would only repeat it. They report the outcome once the window is dismissed.
async function organizeWindowOpen(): Promise<boolean> {
  const stored = await chrome.storage.session.get([FINDER_WINDOW_KEY, FINDER_VIEW_KEY]);
  const id = stored[FINDER_WINDOW_KEY] as number | undefined;
  if (typeof id !== "number" || stored[FINDER_VIEW_KEY] !== "organize") return false;
  return chrome.windows.get(id).then(() => true, () => false);
}

// One notification reports a shortcut-started organize; its buttons act on the
// outcome it names, which is kept in session storage across worker restarts.
const ORGANIZE_SHORTCUT_NOTIFICATION = "organize-shortcut";
const ORGANIZE_SHORTCUT_OUTCOME_KEY = "organizeShortcutOutcome";

type OrganizeShortcutOutcome =
  | { kind: "completed"; windowId: number; transactionId: string }
  | { kind: "review"; windowId: number }
  | { kind: "failed"; windowId: number };

async function notifyOrganizeShortcut(
  outcome: OrganizeShortcutOutcome,
  title: string,
  message: string,
): Promise<void> {
  const button = outcome.kind === "completed" ? "Undo" : outcome.kind === "review" ? "Review plan" : "Open organizer";
  try {
    await chrome.storage.session.set({ [ORGANIZE_SHORTCUT_OUTCOME_KEY]: outcome });
    await chrome.notifications.clear(ORGANIZE_SHORTCUT_NOTIFICATION);
    await chrome.notifications.create(ORGANIZE_SHORTCUT_NOTIFICATION, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message,
      buttons: [{ title: button }],
    });
  } catch {
    // Notifications can be blocked at the OS level; the popup still shows the result.
  }
}

function organizationRunFailure(run: OrganizationRun): string {
  return run.error ?? `Organizing ended as ${run.status.replaceAll("_", " ")}.`;
}

async function notifyOrganizationOutcome(run: OrganizationRun, windowId: number): Promise<void> {
  if (run.status !== "completed") {
    await notifyOrganizeShortcut({ kind: "failed", windowId }, "Organizing did not finish", organizationRunFailure(run));
    return;
  }
  const groups = run.proposal.groups.length;
  await notifyOrganizeShortcut(
    { kind: "completed", windowId, transactionId: run.transactionId },
    "Window organized",
    `${groups} group${groups === 1 ? "" : "s"}, verified.`,
  );
}

async function actOnOrganizeShortcutNotification(): Promise<void> {
  const stored = await chrome.storage.session.get(ORGANIZE_SHORTCUT_OUTCOME_KEY);
  const outcome = stored[ORGANIZE_SHORTCUT_OUTCOME_KEY] as OrganizeShortcutOutcome | undefined;
  await chrome.notifications.clear(ORGANIZE_SHORTCUT_NOTIFICATION);
  if (!outcome) return;
  if (outcome.kind === "completed") {
    // Undo only the run this notification reported, and only while it is still the Undo point.
    const point = await readUndoPoint();
    if (point?.status === "available" && point.transactionId === outcome.transactionId) {
      await runOrganizationUndo(point.transactionId);
    }
    return;
  }
  await openFinderWindow(outcome.windowId, "organize");
}

// The toolbar badge marks a shortcut run for as long as it lasts, including
// after its window is dismissed.
const ORGANIZING_BADGE = "…";

async function showOrganizingProgress(): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#4a5160" });
    await chrome.action.setBadgeText({ text: ORGANIZING_BADGE });
    await chrome.action.setTitle({ title: "Organizing this window…" });
  } catch {
    // Badge APIs can fail during shutdown.
  }
}

async function clearOrganizingProgress(): Promise<void> {
  try {
    // An error badge set by the failure path stays; only the running badge goes.
    if ((await chrome.action.getBadgeText({})) === ORGANIZING_BADGE) await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Organize current window" });
  } catch {
    // Badge APIs can fail during shutdown.
  }
}

// The shortcut starts the run, then pops the organize window over it, which
// follows the run to its review or result. A plan already waiting for review,
// or a run already in flight, is shown instead of being replaced. With
// "Organize without review" on, the run stays in the background: the toolbar
// badge tracks it and a notification reports the outcome.
async function organizeFromShortcut(windowId: number): Promise<void> {
  const review = await readProposalReview();
  const reviewWaiting =
    review && review.status !== "confirmed" && review.inputSnapshot.browserState.windowId === windowId;
  if (!reviewWaiting && !backgroundOrganize.current()) {
    const { workflow } = (await readOrganizerState()).local;
    try {
      await startBackgroundOrganize(windowId, WHOLE_WINDOW_SCOPE, "shortcut");
      if (workflow.organizeWithoutReview) return;
    } catch (error) {
      await clearOrganizingProgress();
      // The window opens on this message, the way the popup shows a background failure.
      await reportBackgroundError(withNothingMoved(errorText(error, "Organizing could not start.")));
    }
  }
  await openFinderWindow(windowId, "organize");
}

function installContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ORGANIZE_SELECTED,
      title: "Organize selected tabs",
      contexts: ["tab"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_PROTECT_SELECTED,
      title: "Protect selected tabs until restart",
      contexts: ["tab"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_LOCK_GROUP,
      title: "Lock this group until restart",
      contexts: ["tab"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_STASH_GROUP,
      title: "Save this group as a workspace",
      contexts: ["tab"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_STASH_SELECTED,
      title: "Save selected tabs as a workspace",
      contexts: ["tab"],
    });
  });
}

async function syncGeneratedGroupCleanupAlarm(): Promise<void> {
  const settings = await readGeneratedGroupCleanupSettings();
  if (settings.autoUngroupAfterDays === null) {
    await chrome.alarms.clear(GENERATED_GROUP_CLEANUP_ALARM);
    return;
  }
  await chrome.alarms.create(GENERATED_GROUP_CLEANUP_ALARM, {
    delayInMinutes: 5,
    periodInMinutes: 24 * 60,
    persistAcrossSessions: true,
  } as chrome.alarms.AlarmCreateInfo & { persistAcrossSessions: boolean });
}

const editorLeaseRuntime = createEditorLeaseRuntime({
  async readState() {
    const view = await readWindowCaptureViewState();
    return { editorWindowId: view.editor?.editorWindowId ?? null, lease: view.editorLease };
  },
  writeLease: writeEditorLease,
  async cancelRequestingJob(ownerContextId) {
    await cancelRequestingProviderJob("owner_lease_expired", ownerContextId);
  },
});

const transactionRuntime: TransactionRuntime = {
  readWindow: readConfiguredWindow,
  async groupTabs(windowId, tabIds, existingGroupId) {
    const [firstTabId, ...remainingTabIds] = tabIds;
    if (firstTabId === undefined) throw new Error("Cannot create an empty group.");
    return await chrome.tabs.group(
      existingGroupId === undefined
        ? { tabIds: [firstTabId, ...remainingTabIds], createProperties: { windowId } }
        : { tabIds: [firstTabId, ...remainingTabIds], groupId: existingGroupId },
    );
  },
  async updateGroup(groupId, update) {
    await chrome.tabGroups.update(groupId, update);
  },
  async moveGroup(groupId, index) {
    await chrome.tabGroups.move(groupId, { index });
  },
  async moveTabs(tabIds, index) {
    const [firstTabId, ...remainingTabIds] = tabIds;
    if (firstTabId === undefined) return;
    await chrome.tabs.move([firstTabId, ...remainingTabIds], { index });
  },
  async ungroupTabs(tabIds) {
    const [firstTabId, ...remainingTabIds] = tabIds;
    if (firstTabId === undefined) return;
    await chrome.tabs.ungroup([firstTabId, ...remainingTabIds]);
  },
  persist: writeOrganizationRun,
};

async function initializePopupTarget(
  targetWindowId: number,
  ownerContextId: string,
): Promise<void> {
  const target = await chrome.windows.get(targetWindowId);
  if (target.type !== "normal" || target.incognito) {
    throw new Error("Select a normal, non-incognito browser window.");
  }
  const currentView = await readWindowCaptureViewState();
  const editorState: EditorSessionState = {
    targetWindowId,
    editorWindowId: targetWindowId,
    capturedState: await readConfiguredWindow(targetWindowId),
    openedAt: Date.now(),
    lastEditorClosedAt: currentView.editor?.lastEditorClosedAt ?? null,
    lastEditorClosedWindowId: currentView.editor?.lastEditorClosedWindowId ?? null,
    error: null,
  };
  await writeEditorState(editorState);
  await editorLeaseRuntime.register(targetWindowId, ownerContextId);
}

async function refreshCapture(): Promise<void> {
  const { editor } = await readWindowCaptureViewState();
  if (!editor) {
    throw new Error("No target window is selected.");
  }
  const capturedState = await readConfiguredWindow(editor.targetWindowId);
  await writeEditorState({ ...editor, capturedState, error: null });
}

async function refreshStoredCapture(): Promise<void> {
  const { editor } = await readWindowCaptureViewState();
  if (!editor) return;
  try {
    await writeEditorState({
      ...editor,
      capturedState: await readConfiguredWindow(editor.targetWindowId),
      error: null,
    });
  } catch (error) {
    await writeEditorState({
      ...editor,
      error: error instanceof Error ? error.message : "Unable to refresh target state.",
    });
  }
}

function terminalTransactionStatus(status: OrganizationRun["status"]): boolean {
  return ["completed", "rolled_back", "rollback_partial", "interrupted", "failed"].includes(status);
}

/**
 * Serializes every path that drives chrome.tabs mutations — organization apply,
 * group-manager edits, and undo — so two flows cannot interleave and produce a
 * state neither verification nor rollback accounts for. The worker is
 * single-threaded, so a module-scope flag is enough within one lifetime; a worker
 * restart drops the flag and the in-flight work together, and the persisted run
 * plus the recovery boundary cover the tab state.
 */
let browserMutationActive = false;

function browserMutationBusyError(): Error {
  return new Error("Another browser change is active. Wait for it to finish before continuing.");
}

async function ensureOrganizerTransactionAvailable(): Promise<void> {
  const view = await readWindowCaptureViewState();
  if (
    view.transactionRun && !terminalTransactionStatus(view.transactionRun.status)
  ) {
    throw new Error("Another browser transaction is active. Finish or restore it before managing groups.");
  }
}

async function ensureGroupManagerTransactionAvailable(): Promise<void> {
  if (browserMutationActive) throw browserMutationBusyError();
  await ensureOrganizerTransactionAvailable();
}

async function runGroupManagerMutation<T>(mutation: () => Promise<T>): Promise<T> {
  if (browserMutationActive) throw browserMutationBusyError();
  browserMutationActive = true;
  try {
    await ensureOrganizerTransactionAvailable();
    return await mutation();
  } finally {
    browserMutationActive = false;
  }
}

installAutoFiling({
  readWindow: readConfiguredWindow,
  async isBusy() {
    if (backgroundOrganize.current() || browserMutationActive || workspaceLockHeld() || linkedWorkspaceRestores.size > 0) return true;
    const view = await readWindowCaptureViewState();
    return Boolean(view.transactionRun && !terminalTransactionStatus(view.transactionRun.status)) ||
      view.undoPoint?.status === "running";
  },
  async runMutation(task) {
    if (browserMutationActive) throw browserMutationBusyError();
    browserMutationActive = true;
    try {
      return await task();
    } finally {
      browserMutationActive = false;
    }
  },
  async linkedWorkspaceWindowIds() {
    return new Set((await readLinkedStashWorkspaces()).map((workspace) => workspace.windowId));
  },
  async reviewOpen() {
    return (await readProposalReview()) !== null;
  },
  startOrganize: (windowId, scope) => startBackgroundOrganize(windowId, scope, "shortcut"),
  reportError: (message) => reportBackgroundError(message),
});

async function readGroupManagerWindows(): Promise<SemanticWindowState[]> {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return Promise.all(windows.flatMap((window) =>
    window.id === undefined || window.incognito ? [] : [readConfiguredWindow(window.id)],
  ));
}

function groupWindow(
  states: readonly SemanticWindowState[],
  groupId: number,
): SemanticWindowState | null {
  return states.find((state) => state.groups.some((group) => group.runtimeId === groupId)) ?? null;
}

async function seedCreatedGroupOwnership(
  states: readonly SemanticWindowState[],
): Promise<void> {
  const view = await readWindowCaptureViewState();
  const run = view.transactionRun;
  if (!run || run.status !== "completed") return;
  const liveIds = new Set(states.flatMap((state) => state.groups.map((group) => group.runtimeId)));
  const created = run.journal.operationPlan.flatMap((operation) => {
    if (operation.kind !== "create_group") return [];
    const groupId = run.journal.runtimeGroupIds[operation.groupRef];
    return groupId !== undefined && liveIds.has(groupId)
      ? [{ groupId, windowId: run.targetWindowId }]
      : [];
  });
  if (created.length > 0) {
    await recordGroupOwnership(created, "created", run.transactionId);
    await recordGeneratedGroups(states, created.map((group) => ({
      ...group,
      transactionId: run.transactionId,
    })));
  }
}

async function transactionCreatedOwnership(groupId: number): Promise<{ origin: "created"; managed: true; transactionId: string } | null> {
  const run = (await readWindowCaptureViewState()).transactionRun;
  if (!run || run.status !== "completed") return null;
  const created = run.journal.operationPlan.some((operation) =>
    operation.kind === "create_group" && run.journal.runtimeGroupIds[operation.groupRef] === groupId);
  return created ? { origin: "created", managed: true, transactionId: run.transactionId } : null;
}

async function readGroupManagerView(
  currentWindowId: number | null,
): Promise<GroupManagerState> {
  const states = await readGroupManagerWindows();
  await seedCreatedGroupOwnership(states);
  const liveGroups = states.flatMap((state) => state.groups.map((group) => ({
    id: group.runtimeId,
    windowId: group.windowId,
  })));
  const session = await reconcileGroupManagerSession(liveGroups);
  await reconcileGeneratedGroups(states, session.ownership);
  const [stashes, workspaces] = await Promise.all([
    readTabStashes(),
    readLinkedStashWorkspaces(),
  ]);
  return buildGroupManagerState({
    states,
    ownership: session.ownership,
    stashLinks: session.stashLinks,
    stashes,
    workspaces,
    canUndo: session.undoPoint !== null,
    currentWindowId,
  });
}

async function readGeneratedGroupCleanupSummary(): Promise<GeneratedGroupCleanupSummary> {
  const [states, settings, lastRun, session] = await Promise.all([
    readGroupManagerWindows(),
    readGeneratedGroupCleanupSettings(),
    readGeneratedGroupCleanupLastRun(),
    readGroupManagerSession(),
  ]);
  const tracking = await reconcileGeneratedGroups(states, session.ownership);
  const blockedGeneratedGroups = tracking.matches.filter(({ group }) =>
    group.protectionReasons.length > 0).length;
  const eligibleGeneratedGroups = settings.autoUngroupAfterDays === null
    ? 0
    : tracking.matches.filter(({ record, group }) =>
        group.protectionReasons.length === 0 &&
        record.createdAt <= Date.now() - settings.autoUngroupAfterDays! * 24 * 60 * 60_000,
      ).length;
  const nextCleanupAt = settings.autoUngroupAfterDays === null
    ? null
    : tracking.matches
        .filter(({ group }) => group.protectionReasons.length === 0)
        .reduce<number | null>((earliest, { record }) => {
          const expiresAt = record.createdAt + settings.autoUngroupAfterDays! * 24 * 60 * 60_000;
          return earliest === null || expiresAt < earliest ? expiresAt : earliest;
        }, null);
  return {
    settings,
    trackedGroups: tracking.records.length,
    liveGeneratedGroups: tracking.matches.length,
    eligibleGeneratedGroups,
    blockedGeneratedGroups,
    nextCleanupAt,
    lastRun,
  };
}

async function setGeneratedGroupCleanup(
  autoUngroupAfterDays: GeneratedGroupAutoCleanupDays,
): Promise<GeneratedGroupCleanupSummary> {
  await writeGeneratedGroupCleanupSettings({ autoUngroupAfterDays });
  await syncGeneratedGroupCleanupAlarm();
  return readGeneratedGroupCleanupSummary();
}

async function runGeneratedGroupCleanup(
  mode: "automatic" | "manual",
): Promise<GeneratedGroupCleanupResult> {
  return runGroupManagerMutation(async () => {
    const [states, settings, session] = await Promise.all([
      readGroupManagerWindows(),
      readGeneratedGroupCleanupSettings(),
      readGroupManagerSession(),
    ]);
    const tracking = await reconcileGeneratedGroups(states, session.ownership);
    const cutoff = settings.autoUngroupAfterDays === null
      ? null
      : Date.now() - settings.autoUngroupAfterDays * 24 * 60 * 60_000;
    const targets = tracking.matches.filter(({ record }) =>
      mode === "manual" || (cutoff !== null && record.createdAt <= cutoff));
    if (targets.length === 0) {
      const empty: GeneratedGroupCleanupResult = {
        mode,
        ranAt: Date.now(),
        groupsUngrouped: 0,
        tabsKeptOpen: 0,
        groupsSkipped: 0,
        conflicts: [],
      };
      await writeGeneratedGroupCleanupLastRun(empty);
      return empty;
    }
    const targetIds = targets.map(({ group }) => group.runtimeId);
    const relevant = states.filter((state) =>
      state.groups.some((group) => targetIds.includes(group.runtimeId)));
    const preview = previewGroupRemoval(
      states,
      targetIds,
      "ungroup",
      true,
      await groupManagerFingerprint(relevant),
    );
    preview.provenance = targets.map(({ group, record }) => ({
      groupId: group.runtimeId,
      origin: "created",
      managed: true,
      ...(record.transactionId ? { transactionId: record.transactionId } : {}),
    }));
    if (preview.eligibleGroupIds.length === 0) {
      const blocked: GeneratedGroupCleanupResult = {
        mode,
        ranAt: Date.now(),
        groupsUngrouped: 0,
        tabsKeptOpen: 0,
        groupsSkipped: preview.blockedGroups.length,
        conflicts: preview.blockedGroups.map((item) => item.reason),
      };
      await writeGeneratedGroupCleanupLastRun(blocked);
      return blocked;
    }
    const applied = await applyManagedGroupRemovalUnlocked(preview);
    const result: GeneratedGroupCleanupResult = {
      mode,
      ranAt: Date.now(),
      groupsUngrouped: applied.groupsChanged,
      tabsKeptOpen: applied.tabsChanged,
      groupsSkipped: applied.skippedGroups,
      conflicts: applied.conflicts,
    };
    await writeGeneratedGroupCleanupLastRun(result);
    return result;
  });
}

async function setManagedGroups(groupIds: readonly number[], managed: boolean): Promise<void> {
  await ensureGroupManagerTransactionAvailable();
  const states = await readGroupManagerWindows();
  const requested = new Set(groupIds);
  const groups = states.flatMap((state) => state.groups
    .filter((group) => requested.has(group.runtimeId))
    .map((group) => ({ groupId: group.runtimeId, windowId: state.windowId })));
  if (groups.length !== requested.size) throw new Error("One or more selected groups are no longer available.");
  await setManualGroupManagement(groups, managed);
}

async function previewManagedGroupEdit(
  draft: GroupManagerEditDraft,
): Promise<GroupManagerEditPreview> {
  await ensureGroupManagerTransactionAvailable();
  const states = await readGroupManagerWindows();
  const state = groupWindow(states, draft.groupId);
  if (!state) throw new Error("The selected group no longer exists.");
  const preview = previewGroupEdit(state, draft, await groupManagerFingerprint([state]));
  const session = await readGroupManagerSession();
  const owned = session.ownership.find((item) =>
    item.windowId === state.windowId && item.groupId === draft.groupId) ??
    await transactionCreatedOwnership(draft.groupId);
  const stashLink = session.stashLinks.find((item) =>
    item.windowId === state.windowId && item.groupId === draft.groupId);
  const result: GroupManagerEditPreview = {
    ...preview,
    ...(owned ? {
      provenance: {
        origin: owned.origin,
        managed: owned.managed ?? true,
        ...(owned.transactionId ? { transactionId: owned.transactionId } : {}),
        ...(stashLink ? { stashLink } : {}),
      },
    } : {}),
  };
  await recordGroupManagerPreview(preview.previewToken, result.provenance ? [{
    groupId: draft.groupId,
    ...result.provenance,
  }] : []);
  return result;
}

async function restoreManagerSnapshots(
  points: readonly {
    before: SemanticWindowState;
    touchedTabIds: number[];
    provenance?: GroupManagerUndoPoint["points"][number]["provenance"];
  }[],
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const point of points) {
    try {
      await restoreSnapshotMembership(point.before, point.touchedTabIds, transactionRuntime);
      if (!point.provenance?.length) continue;
      const live = await readConfiguredWindow(point.before.windowId);
      for (const recorded of point.provenance) {
        const original = point.before.groups.find((group) => group.runtimeId === recorded.groupId);
        if (!original) continue;
        const restored = live.groups.find((candidate) =>
          candidate.title === original.title && candidate.color === original.color &&
          candidate.collapsed === original.collapsed &&
          JSON.stringify([...candidate.memberTabIds].sort((left, right) => left - right)) ===
            JSON.stringify([...original.memberTabIds].sort((left, right) => left - right)));
        if (!restored) {
          conflicts.push(`Ownership for ${original.title || "an untitled group"} could not be restored.`);
          continue;
        }
        await recordGroupOwnership(
          [{ groupId: restored.runtimeId, windowId: restored.windowId }],
          recorded.origin,
          recorded.transactionId,
        );
        if (recorded.managed === false) {
          await setManualGroupManagement([{ groupId: restored.runtimeId, windowId: restored.windowId }], false);
        }
        if (recorded.stashLink) {
          await recordGroupStashLinks([{ ...recorded.stashLink, groupId: restored.runtimeId }]);
        }
      }
    } catch (error) {
      conflicts.push(error instanceof Error ? error.message : "A group snapshot could not be restored.");
    }
  }
  return conflicts;
}

async function applyManagedGroupEdit(
  submitted: GroupManagerEditPreview,
): Promise<GroupManagerApplyResult> {
  return runGroupManagerMutation(() => applyManagedGroupEditUnlocked(submitted));
}

async function applyManagedGroupEditUnlocked(
  submitted: GroupManagerEditPreview,
): Promise<GroupManagerApplyResult> {
  const states = await readGroupManagerWindows();
  const before = groupWindow(states, submitted.draft.groupId);
  if (!before) throw new Error("The selected group no longer exists.");
  const token = await groupManagerFingerprint([before]);
  if (token !== submitted.previewToken) throw new Error("The group changed after review. Review the edit again.");
  const preview = previewGroupEdit(before, submitted.draft, token);
  const originalGroup = before.groups.find((group) => group.runtimeId === preview.draft.groupId)!;
  const managerSessionBefore = await readGroupManagerSession();
  const pendingProvenance = managerSessionBefore.pendingPreviews.find((item) =>
    item.previewToken === submitted.previewToken)?.provenance ?? [];
  const tabsById = new Map(before.tabs.map((tab) => [tab.id, tab]));
  const sourceMembers = preview.draft.tabIds.flatMap((id) => {
    const source = tabsById.get(id)?.groupId;
    return source !== undefined && source !== -1
      ? before.groups.find((group) => group.runtimeId === source)?.memberTabIds ?? []
      : [];
  });
  const touchedTabIds = [...new Set([
    ...originalGroup.memberTabIds,
    ...preview.draft.tabIds,
    ...sourceMembers,
  ])];
  const provenanceBefore = (await Promise.all(before.groups.map(async (group) => {
    if (!group.memberTabIds.some((id) => touchedTabIds.includes(id))) return [];
    const submittedProvenance = group.runtimeId === preview.draft.groupId
      ? submitted.provenance ?? pendingProvenance.find((item) => item.groupId === group.runtimeId)
      : undefined;
    const owned = managerSessionBefore.ownership.find((item) =>
      item.windowId === before.windowId && item.groupId === group.runtimeId) ??
      (submittedProvenance
        ? {
            ...submittedProvenance,
            groupId: group.runtimeId,
            windowId: before.windowId,
            recordedAt: Date.now(),
          }
        : await transactionCreatedOwnership(group.runtimeId) ?? undefined);
    if (!owned) return [];
    const stashLink = managerSessionBefore.stashLinks.find((item) =>
      item.windowId === before.windowId && item.groupId === group.runtimeId) ??
      submittedProvenance?.stashLink;
    return [{
      groupId: group.runtimeId,
      origin: owned.origin,
      managed: owned.managed ?? true,
      ...(owned.transactionId ? { transactionId: owned.transactionId } : {}),
      ...(stashLink ? { stashLink } : {}),
    }];
  }))).flat();
  try {
    if (preview.removedTabIds.length > 0) await transactionRuntime.ungroupTabs(preview.removedTabIds);
    if (preview.addedTabIds.length > 0) {
      await transactionRuntime.groupTabs(before.windowId, preview.addedTabIds, originalGroup.runtimeId);
    }
    if (preview.reordered || preview.addedTabIds.length > 0 || preview.removedTabIds.length > 0) {
      for (let index = 0; index < preview.draft.tabIds.length; index += 1) {
        await transactionRuntime.moveTabs([preview.draft.tabIds[index]!], originalGroup.firstTabIndex + index);
      }
    }
    const intermediate = await readConfiguredWindow(before.windowId);
    const currentTarget = intermediate.groups.find((group) =>
      JSON.stringify(group.memberTabIds) === JSON.stringify(preview.draft.tabIds));
    if (!currentTarget) throw new Error("The browser did not preserve the reviewed group membership.");
    await transactionRuntime.updateGroup(currentTarget.runtimeId, {
      title: preview.draft.title,
      color: preview.draft.color,
      collapsed: preview.draft.collapsed,
    });
    const after = await readConfiguredWindow(before.windowId);
    const observed = after.groups.find((group) =>
      JSON.stringify(group.memberTabIds) === JSON.stringify(preview.draft.tabIds));
    if (!observed || observed.title !== preview.draft.title || observed.color !== preview.draft.color ||
      observed.collapsed !== preview.draft.collapsed ||
      JSON.stringify(observed.memberTabIds) !== JSON.stringify(preview.draft.tabIds)) {
      throw new Error("The browser did not preserve the reviewed group edit.");
    }
    if (observed.runtimeId !== originalGroup.runtimeId) {
      const owned = managerSessionBefore.ownership.find((item) =>
        item.windowId === before.windowId && item.groupId === originalGroup.runtimeId) ??
        (submitted.provenance
          ? { ...submitted.provenance, groupId: originalGroup.runtimeId, windowId: before.windowId, recordedAt: Date.now() }
          : undefined);
      if (owned) await recordGroupOwnership(
        [{ groupId: observed.runtimeId, windowId: before.windowId }],
        owned.origin,
        owned.transactionId,
      );
      if (owned?.managed === false) {
        await setManualGroupManagement([{ groupId: observed.runtimeId, windowId: before.windowId }], false);
      }
      const link = managerSessionBefore.stashLinks.find((item) =>
        item.windowId === before.windowId && item.groupId === originalGroup.runtimeId) ??
        submitted.provenance?.stashLink;
      if (link) await recordGroupStashLinks([{ ...link, groupId: observed.runtimeId }]);
    }
    const transactionId = crypto.randomUUID();
    await writeGroupManagerUndo({
      transactionId,
      createdAt: Date.now(),
      points: [{
        targetWindowId: before.windowId,
        before,
        expectedAfter: after,
        touchedTabIds,
        provenance: provenanceBefore,
      }],
    });
    try {
      const session = await readGroupManagerSession();
      await reconcileGeneratedGroups(await readGroupManagerWindows(), session.ownership);
    } catch {
      // Persistent generated-group tracking is best-effort; the verified edit remains valid.
    }
    await refreshStoredCapture();
    return {
      transactionId,
      groupsChanged: 1 + preview.emptiedSourceGroupIds.length,
      tabsChanged: new Set([...preview.addedTabIds, ...preview.removedTabIds]).size + (preview.reordered ? preview.draft.tabIds.length : 0),
      skippedGroups: 0,
      recoveryStashId: null,
      conflicts: [],
    };
  } catch (error) {
    const conflicts = await restoreManagerSnapshots([{ before, touchedTabIds, provenance: provenanceBefore }]);
    const reason = error instanceof Error ? error.message : "The group edit failed.";
    throw new Error([reason, ...conflicts].join(" "));
  }
}

async function previewManagedGroupRemoval(
  groupIds: readonly number[],
  mode: GroupManagerRemovalMode,
  includeActive: boolean,
): Promise<GroupManagerRemovalPreview> {
  await ensureGroupManagerTransactionAvailable();
  const states = await readGroupManagerWindows();
  const preview = previewGroupRemoval(
    states,
    groupIds,
    mode,
    includeActive,
    await groupManagerFingerprint(states.filter((state) =>
      state.groups.some((group) => groupIds.includes(group.runtimeId)))),
  );
  const session = await readGroupManagerSession();
  const provenance = (await Promise.all(preview.eligibleGroupIds.map(async (groupId) => {
    const state = groupWindow(states, groupId);
    const owned = state && (session.ownership.find((item) =>
      item.windowId === state.windowId && item.groupId === groupId) ??
      await transactionCreatedOwnership(groupId));
    if (!owned) return [];
    const stashLink = session.stashLinks.find((item) =>
      item.windowId === state!.windowId && item.groupId === groupId);
    return [{
      groupId,
      origin: owned.origin,
      managed: owned.managed ?? true,
      ...(owned.transactionId ? { transactionId: owned.transactionId } : {}),
      ...(stashLink ? { stashLink } : {}),
    }];
  }))).flat();
  const result: GroupManagerRemovalPreview = {
    ...preview,
    provenance,
  };
  await recordGroupManagerPreview(preview.previewToken, provenance);
  return result;
}

function recoveryPreviewForGroups(
  states: readonly SemanticWindowState[],
  groupIds: readonly number[],
): TabStashPreview {
  const selected = new Set(groupIds);
  const tabs: TabStashPreview["tabs"] = [];
  const groups: TabStashPreview["groups"] = [];
  const selectedTabIds: number[] = [];
  states.forEach((state) => {
    state.groups.filter((group) => selected.has(group.runtimeId)).forEach((group) => {
      const key = `window-${state.windowId}-group-${group.runtimeId}`;
      groups.push({
        key,
        sourceGroupId: group.runtimeId,
        sourceIndex: group.firstTabIndex,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
      });
      group.memberTabIds.forEach((tabId) => {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) return;
        selectedTabIds.push(tab.id);
        tabs.push({
          sourceTabId: tab.id,
          sourceIndex: tab.index,
          title: tab.title,
          url: tab.url,
          groupKey: key,
          stableKey: crypto.randomUUID(),
        });
      });
    });
  });
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(Date.now());
  return {
    name: `Group cleanup · ${formatted}`,
    scope: { mode: "selection", tabIds: selectedTabIds },
    tabs,
    groups,
    excludedTabs: [],
  };
}

// Saves that close tabs write a pending stash first and settle it after the
// close. Both steps re-read the list under its lock, so a workspace saved
// while the tabs were closing is kept.
async function dropPendingStash(stashId: string): Promise<void> {
  await updateTabStashes((current) => current.filter((stash) => stash.id !== stashId));
}

async function replacePendingStash(saved: SavedTabStash): Promise<void> {
  await updateTabStashes((current) => [saved, ...current.filter((stash) => stash.id !== saved.id)]);
}

async function closeGroupsWithRecovery(
  states: readonly SemanticWindowState[],
  preview: GroupManagerRemovalPreview,
): Promise<{ stashId: string; closed: number; conflicts: string[] }> {
  const recovery = recoveryPreviewForGroups(states, preview.eligibleGroupIds);
  if (recovery.tabs.length === 0) throw new Error("No reviewed tabs are available to close.");
  const pending: SavedTabStash = {
    ...savedStashFromPreview(recovery),
    status: "closing_interrupted",
  };
  await updateTabStashes((current) => [pending, ...current]);
  const verifiedPending = (await readTabStashes()).find((stash) => stash.id === pending.id);
  const tabStructure = (stash: SavedTabStash) => stash.tabs.map((tab) => [
    tab.sourceTabId,
    tab.sourceIndex,
    tab.title,
    tab.url,
    tab.groupKey,
    tab.stableKey ?? null,
  ]);
  const groupStructure = (stash: SavedTabStash) => stash.groups.map((group) => [
    group.key,
    group.sourceGroupId,
    group.sourceIndex,
    group.title,
    group.color,
    group.collapsed,
  ]);
  const structureVerified = verifiedPending?.status === "closing_interrupted" &&
    JSON.stringify(tabStructure(verifiedPending)) === JSON.stringify(tabStructure(pending)) &&
    JSON.stringify(groupStructure(verifiedPending)) === JSON.stringify(groupStructure(pending));
  if (!structureVerified) {
    await dropPendingStash(pending.id);
    throw new Error("The recovery workspace could not be verified, so no tabs were closed.");
  }
  let removalFailed = false;
  try {
    await chrome.tabs.remove(preview.eligibleTabIds);
  } catch {
    removalFailed = true;
  }
  const closedIds = new Set<number>();
  await Promise.all(preview.eligibleTabIds.map(async (tabId) => {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      closedIds.add(tabId);
    }
  }));
  if (closedIds.size === 0) {
    await dropPendingStash(pending.id);
    throw new Error("The reviewed tabs stayed open, so no recovery workspace was kept.");
  }
  const closedTabs = pending.tabs.filter((tab) => closedIds.has(tab.sourceTabId));
  const usedGroupKeys = new Set(closedTabs.flatMap((tab) => tab.groupKey ? [tab.groupKey] : []));
  const conflicts = [
    ...(removalFailed ? ["One or more tabs could not be closed after the recovery workspace was saved."] : []),
    ...(closedIds.size < preview.eligibleTabIds.length
      ? [`${preview.eligibleTabIds.length - closedIds.size} reviewed tab(s) stayed open.`]
      : []),
  ];
  const saved: SavedTabStash = {
    ...pending,
    tabs: closedTabs,
    groups: pending.groups.filter((group) => usedGroupKeys.has(group.key)),
    status: "saved",
    closeConflicts: conflicts,
  };
  await replacePendingStash(saved);
  return { stashId: saved.id, closed: closedIds.size, conflicts };
}

async function applyManagedGroupRemoval(
  submitted: GroupManagerRemovalPreview,
): Promise<GroupManagerApplyResult> {
  return runGroupManagerMutation(() => applyManagedGroupRemovalUnlocked(submitted));
}

async function applyManagedGroupRemovalUnlocked(
  submitted: GroupManagerRemovalPreview,
): Promise<GroupManagerApplyResult> {
  const states = await readGroupManagerWindows();
  const relevant = states.filter((state) =>
    state.groups.some((group) => submitted.requestedGroupIds.includes(group.runtimeId)));
  const token = await groupManagerFingerprint(relevant);
  if (token !== submitted.previewToken) throw new Error("The selected groups changed after review. Review the action again.");
  const preview = previewGroupRemoval(
    states,
    submitted.requestedGroupIds,
    submitted.mode,
    submitted.includeActive,
    token,
  );
  preview.provenance = submitted.provenance;
  if (preview.eligibleGroupIds.length === 0) throw new Error("None of the selected groups can be changed.");
  if (preview.mode === "close") {
    const result = await closeGroupsWithRecovery(states, preview);
    await refreshStoredCapture();
    return {
      transactionId: null,
      groupsChanged: preview.eligibleGroupIds.length,
      tabsChanged: result.closed,
      skippedGroups: preview.blockedGroups.length,
      recoveryStashId: result.stashId,
      conflicts: result.conflicts,
    };
  }
  const before = relevant.map((state) => structuredClone(state));
  const managerSessionBefore = await readGroupManagerSession();
  const pendingProvenance = managerSessionBefore.pendingPreviews.find((item) =>
    item.previewToken === submitted.previewToken)?.provenance ?? [];
  const touchedByWindow = before.map((state) => ({
    before: state,
    touchedTabIds: state.groups
      .filter((group) => preview.eligibleGroupIds.includes(group.runtimeId))
      .flatMap((group) => group.memberTabIds),
  })).filter((point) => point.touchedTabIds.length > 0);
  const provenanceByWindow = new Map<number, GroupManagerUndoPoint["points"][number]["provenance"]>();
  await Promise.all(touchedByWindow.map(async (point) => {
    const provenance = (await Promise.all(point.before.groups.map(async (group) => {
      if (!group.memberTabIds.some((id) => point.touchedTabIds.includes(id))) return [];
      const submittedProvenance = preview.provenance?.find((item) => item.groupId === group.runtimeId) ??
        pendingProvenance.find((item) => item.groupId === group.runtimeId);
      const owned = managerSessionBefore.ownership.find((item) =>
        item.windowId === point.before.windowId && item.groupId === group.runtimeId) ??
        (submittedProvenance
          ? { ...submittedProvenance, windowId: point.before.windowId, recordedAt: Date.now() }
          : await transactionCreatedOwnership(group.runtimeId) ?? undefined);
      if (!owned) return [];
      const stashLink = managerSessionBefore.stashLinks.find((item) =>
        item.windowId === point.before.windowId && item.groupId === group.runtimeId) ??
        submittedProvenance?.stashLink;
      return [{
        groupId: group.runtimeId,
        origin: owned.origin,
        managed: owned.managed ?? true,
        ...(owned.transactionId ? { transactionId: owned.transactionId } : {}),
        ...(stashLink ? { stashLink } : {}),
      }];
    }))).flat();
    provenanceByWindow.set(point.before.windowId, provenance);
  }));
  try {
    for (const point of touchedByWindow) await transactionRuntime.ungroupTabs(point.touchedTabIds);
    const after = await Promise.all(before.map((state) => readConfiguredWindow(state.windowId)));
    const remaining = new Set(after.flatMap((state) => state.groups.map((group) => group.runtimeId)));
    if (preview.eligibleGroupIds.some((groupId) => remaining.has(groupId))) {
      throw new Error("One or more reviewed groups remained after ungrouping.");
    }
    const transactionId = crypto.randomUUID();
    await writeGroupManagerUndo({
      transactionId,
      createdAt: Date.now(),
      points: touchedByWindow.map((point) => ({
        targetWindowId: point.before.windowId,
        before: point.before,
        expectedAfter: after.find((state) => state.windowId === point.before.windowId)!,
        touchedTabIds: point.touchedTabIds,
        provenance: provenanceByWindow.get(point.before.windowId) ?? [],
      })),
    });
    try {
      await forgetGeneratedGroups(before.flatMap((state) => state.groups
        .filter((group) => preview.eligibleGroupIds.includes(group.runtimeId))
        .map((group) => ({ groupId: group.runtimeId, windowId: state.windowId }))));
    } catch {
      // Tracking cleanup is nonessential after the browser verified the ungroup operation.
    }
    await refreshStoredCapture();
    return {
      transactionId,
      groupsChanged: preview.eligibleGroupIds.length,
      tabsChanged: preview.eligibleTabIds.length,
      skippedGroups: preview.blockedGroups.length,
      recoveryStashId: null,
      conflicts: [],
    };
  } catch (error) {
    const conflicts = await restoreManagerSnapshots(touchedByWindow.map((point) => ({
      ...point,
      provenance: provenanceByWindow.get(point.before.windowId),
    })));
    throw new Error([
      error instanceof Error ? error.message : "The group action failed.",
      ...conflicts,
    ].join(" "));
  }
}

async function undoManagedGroupChange(): Promise<GroupManagerUndoResult> {
  return runGroupManagerMutation(undoManagedGroupChangeUnlocked);
}

async function undoManagedGroupChangeUnlocked(): Promise<GroupManagerUndoResult> {
  const session = await readGroupManagerSession();
  const undo = session.undoPoint;
  if (!undo) throw new Error("There is no group-manager change to undo.");
  const conflicts: string[] = [];
  const restoredOwnership: Array<{ groupId: number; windowId: number; origin: "created" | "managed"; managed?: boolean; transactionId?: string }> = [];
  const restoredLinks: GroupStashLink[] = [];
  for (const point of undo.points) {
    const result = await executeConflictAwareUndo({
      transactionId: undo.transactionId,
      targetWindowId: point.targetWindowId,
      before: point.before,
      expectedAfter: point.expectedAfter,
      touchedTabIds: point.touchedTabIds,
      createdAt: undo.createdAt,
      status: "available",
      conflicts: [],
    }, transactionRuntime);
    conflicts.push(...result.conflicts);
    const live = await readConfiguredWindow(point.targetWindowId);
    for (const original of point.before.groups) {
      if (!original.memberTabIds.some((id) => point.touchedTabIds.includes(id))) continue;
      const originalMembers = [...original.memberTabIds].sort((left, right) => left - right);
      const restored = live.groups.find((candidate) =>
        candidate.title === original.title && candidate.color === original.color &&
        candidate.collapsed === original.collapsed &&
        JSON.stringify([...candidate.memberTabIds].sort((left, right) => left - right)) === JSON.stringify(originalMembers));
      if (!restored) continue;
      const expectedGroup = point.expectedAfter.groups.find((candidate) =>
        JSON.stringify([...candidate.memberTabIds].sort((left, right) => left - right)) === JSON.stringify(originalMembers));
      const recorded = point.provenance?.find((item) => item.groupId === original.runtimeId);
      const owned = recorded ?? session.ownership.find((item) =>
        item.windowId === point.targetWindowId &&
        (item.groupId === original.runtimeId || item.groupId === expectedGroup?.runtimeId));
      if (owned) restoredOwnership.push({
        groupId: restored.runtimeId,
        windowId: restored.windowId,
        origin: owned.origin,
        managed: owned.managed ?? true,
        ...(owned.transactionId ? { transactionId: owned.transactionId } : {}),
      });
      const link = recorded?.stashLink ?? session.stashLinks.find((item) =>
        item.windowId === point.targetWindowId &&
        (item.groupId === original.runtimeId || item.groupId === expectedGroup?.runtimeId));
      if (link) restoredLinks.push({ ...link, groupId: restored.runtimeId });
    }
  }
  for (const item of restoredOwnership) {
    await recordGroupOwnership([item], item.origin, item.transactionId);
    if (item.managed === false) await setManualGroupManagement([item], false);
  }
  if (restoredLinks.length > 0) await recordGroupStashLinks(restoredLinks);
  const restoredCreated = restoredOwnership.filter((item) => item.origin === "created");
  if (restoredCreated.length > 0) {
    try {
      await recordGeneratedGroups(
        await readGroupManagerWindows(),
        restoredCreated.map((item) => ({
          groupId: item.groupId,
          windowId: item.windowId,
          transactionId: item.transactionId,
        })),
      );
    } catch {
      // Restored ownership remains available for this session even if local tracking fails.
    }
  }
  await writeGroupManagerUndo(null);
  await refreshStoredCapture();
  return { undone: conflicts.length === 0, conflicts };
}

interface PreparedOrganizationTransaction {
  run: OrganizationRun;
  request: ImmutableRequestBundle;
  proposal: ValidatedProposal;
  runStartedAt: number;
  closeCandidates: number[];
  proposalDiff: ReturnType<typeof buildProposalDiff>;
  providerOrigin: string;
  model: string;
  recordNameApprovals: boolean;
  generation: HistoryGenerationStats | undefined;
}

async function prepareOrganizationTransaction(options: {
  live: SemanticWindowState;
  request: ImmutableRequestBundle;
  proposal: ValidatedProposal;
  inputSnapshot: SemanticWindowState;
  runStartedAt: number;
  allowBlankTabCleanup: boolean;
  recordNameApprovals: boolean;
  /** Reorder loose tabs too; off for Automatic mode so background runs do not reshuffle them. */
  arrangeLooseTabs: boolean;
  generation: HistoryGenerationStats | undefined;
}): Promise<PreparedOrganizationTransaction> {
  const integrated = mapReviewToBrowserProposal(options.proposal, options.request);
  const transactionId = crypto.randomUUID();
  const journal = planIntegratedTransaction(
    options.live,
    integrated.proposal,
    integrated.browserTabIds,
    transactionId,
    {
      // A hand-picked selection is organized in place; pulling its loose tabs to
      // the end of the window would move tabs the user did not ask about.
      arrangeLooseTabs:
        options.arrangeLooseTabs && options.request.scope?.mode !== "selected_tabs",
    },
  );
  const run: OrganizationRun = {
    transactionId,
    targetWindowId: options.live.windowId,
    selectedTabIds: [...journal.touchedTabIds],
    proposal: integrated.proposal,
    inputSnapshot: structuredClone(options.live),
    journal,
    status: "prepared",
    faultInjection: "none",
    verification: null,
    rollbackVerification: null,
    error: null,
  };
  const organizerDataBeforeApply = await readOrganizerState();
  const closeCandidates = options.allowBlankTabCleanup && organizerDataBeforeApply.local.privacy.closeInactiveBlankTabs
    ? options.live.tabs.filter(isClosableBlankSemanticTab).map((tab) => tab.id)
    : [];
  const prepared: PreparedOrganizationTransaction = {
    run,
    request: options.request,
    proposal: options.proposal,
    runStartedAt: options.runStartedAt,
    closeCandidates,
    proposalDiff: buildProposalDiff(
      options.inputSnapshot,
      options.request,
      options.proposal,
    ),
    providerOrigin: organizerDataBeforeApply.local.provider.origin,
    model: organizerDataBeforeApply.local.provider.model,
    recordNameApprovals: options.recordNameApprovals,
    generation: options.generation,
  };
  await writeOrganizationRun(run);
  return prepared;
}

async function finishOrganizationTransaction(
  prepared: PreparedOrganizationTransaction,
): Promise<OrganizationRun> {
  let result: OrganizationRun;
  try {
    result = await executeTransaction(
      prepared.run,
      transactionRuntime,
      "none",
    );
  } catch (error) {
    // The stored run carries the journal progress made before the throw.
    const { transactionRun } = await readWindowCaptureViewState();
    const latest = transactionRun?.transactionId === prepared.run.transactionId
      ? transactionRun
      : prepared.run;
    result = failStrandedTransaction(latest, error);
    await writeOrganizationRun(result);
  }
  if (result.status === "completed" && prepared.closeCandidates.length > 0) {
    // Close blank tabs only once completion is durable. Inside the transaction a
    // close was neither journaled nor restorable, so a rollback would have left
    // them gone; deferring means a failed transaction never closes a tab.
    result.blankTabCloseResult = await closeInactiveBlankTabs(prepared.closeCandidates);
    await writeOrganizationRun(result);
  }
  if (result.status === "rolled_back" || result.status === "rollback_partial") {
    await bestEffortDiagnostic(() => recordOperationalDiagnostic({
      kind: result.status === "rolled_back" ? "rollback_complete" : "rollback_partial",
      source: "transaction",
      detail: result.rollbackVerification?.issues.join(" ") || result.error,
      transactionId: result.transactionId,
      conflictCount: result.rollbackVerification?.issues.length ?? 0,
    }));
  }
  const timestamp = Date.now();
  // Measured from the journal's own before and planned-after windows, which a
  // completed run has verified against the browser; anything else is the plan.
  const changes = summarizeWindowChanges(
    result.journal.rollbackSnapshot,
    result.journal.expectedFinalState,
    result.blankTabCloseResult?.closed ?? 0,
  );
  const historyReport: OrganizationHistoryReport = {
    timestamp,
    providerType: "openai_compatible",
    providerOrigin: prepared.providerOrigin,
    model: prepared.model,
    tabsSubmitted: prepared.request.submittedTabIds.length,
    tabsChanged:
      result.journal.touchedTabIds.length +
      (result.blankTabCloseResult?.closed ?? 0),
    tabsMoved: totalTabsMoved(changes.tabs),
    ...(result.status === "completed"
      ? {
          eligibleUngroupedSubmitted: prepared.proposalDiff.coverage.eligibleUngroupedSubmitted,
          newlyGrouped: prepared.proposalDiff.coverage.newlyGrouped,
          remainingUngrouped: prepared.proposalDiff.coverage.remainUngrouped,
        }
      : {}),
    groupsCreated: changes.groups.created,
    groupsRenamed: changes.groups.renamed,
    groupsMerged: prepared.proposalDiff.counts.merged,
    groupsSplit: prepared.proposalDiff.counts.split,
    groupCount: prepared.proposal.groups.length,
    durationMs: Math.max(0, timestamp - prepared.runStartedAt),
    scopeMode: prepared.request.scope?.mode ?? "window",
    resultStatus: result.status,
    rollbackStatus: result.status === "rolled_back"
      ? "complete"
      : result.status === "rollback_partial"
        ? "partial"
        : "not_needed",
    undoStatus: result.status === "completed" ? "available" : "unavailable",
    undoConflictCount: 0,
    tabChanges: changes.tabs,
    groupChanges: changes.groups,
    ...(prepared.generation ? { generation: prepared.generation } : {}),
  };
  if (result.status === "completed") {
    const createdGroups = result.journal.operationPlan.flatMap((operation) => {
      if (operation.kind !== "create_group") return [];
      const groupId = result.journal.runtimeGroupIds[operation.groupRef];
      return groupId === undefined ? [] : [{ groupId, windowId: result.targetWindowId }];
    });
    if (createdGroups.length > 0) {
      try {
        await recordGroupOwnership(createdGroups, "created", result.transactionId);
        const live = await readConfiguredWindow(result.targetWindowId);
        await recordGeneratedGroups([live], createdGroups.map((group) => ({
          ...group,
          transactionId: result.transactionId,
        })));
      } catch {
        // Provenance is best-effort and never invalidates a verified organization.
      }
    }
    if (prepared.recordNameApprovals) {
      try {
        await recordGroupNameApprovals(
          prepared.proposal.groups.map((group) => group.title),
        );
      } catch {
        // Preference memory is nonessential and must not invalidate a verified mutation.
      }
    }
    try {
      await appendCountsOnlyHistory(historyReport);
    } catch {
      // History is nonessential and must not invalidate a verified mutation.
    }
    await writeUndoPoint({
      transactionId: result.transactionId,
      targetWindowId: result.targetWindowId,
      before: result.journal.rollbackSnapshot,
      expectedAfter: result.journal.expectedFinalState,
      touchedTabIds: journalRestoreTabIds(result.journal),
      createdAt: Date.now(),
      status: "available",
      conflicts: [],
    });
  } else {
    try {
      await appendCountsOnlyHistory(historyReport);
    } catch {
      // Failure history is best-effort and contains no recovery-critical state.
    }
  }
  await refreshStoredCapture();
  return result;
}

async function startOrganizationApply(
  reviewId: string,
  ownerContextId: string,
  reportOutcome = false,
): Promise<void> {
  const [view, review] = await Promise.all([
    readWindowCaptureViewState(),
    readProposalReview(),
  ]);
  if (!view.editor) throw new Error("No target window is selected.");
  if (!review || review.reviewId !== reviewId) throw new Error("The reviewed proposal is unavailable or stale.");
  if (review.status !== "confirmed" || review.confirmedAt === null) throw new Error("Confirm the current proposal before Apply.");
  if (!view.editorLease || view.editorLease.ownerContextId !== ownerContextId || view.editorLease.leaseExpiresAt <= Date.now()) {
    throw new Error("This popup lost its connection to the window, or another Sheaf popup is controlling it. Reopen the popup and try again.");
  }
  if (browserMutationActive) throw browserMutationBusyError();
  if (view.transactionRun && !terminalTransactionStatus(view.transactionRun.status)) {
    throw new Error("Another browser transaction is already active.");
  }

  // Hold the mutation lock from the first read to the last write: the drift
  // check and the journal are only valid if nothing else mutates the window in
  // between, and a group-manager edit or undo must not interleave with apply.
  browserMutationActive = true;
  let prepared: PreparedOrganizationTransaction;
  try {
    const live = await readConfiguredWindow(view.editor.targetWindowId);
    const drift = checkProposalDrift(review.inputSnapshot, live, review.request, review.proposal);
    const sameAcknowledgedWarnings =
      !review.signalAcknowledgementRequired &&
      JSON.stringify(drift.warnings) === JSON.stringify(review.driftWarnings);
    if (
      drift.targetInvalid ||
      drift.closedTabIds.length > 0 ||
      drift.regenerationReasons.length > 0 ||
      (drift.signalAcknowledgementRequired && !sameAcknowledgedWarnings)
    ) {
      const adjusted = applyDriftCheckResult(review, drift);
      await writeProposalReview(adjusted);
      await bestEffortDiagnostic(() => recordOperationalDiagnostic({
        kind: "proposal_stale",
        source: "manual",
        detail: "The browser state changed during the final Apply check. Nothing moved.",
      }));
      throw new Error("Current browser state changed. Review the updated proposal before Apply.");
    }

    // Ownership transfers only after the final drift check and prepared journal
    // have both succeeded. From this point editor closure cannot cancel Apply.
    const organizerDataBeforeApply = await readOrganizerState();
    prepared = await prepareOrganizationTransaction({
      live,
      request: review.request,
      proposal: review.proposal,
      inputSnapshot: review.inputSnapshot.browserState,
      runStartedAt: organizerDataBeforeApply.session.providerJob?.startedAt ?? Date.now(),
      allowBlankTabCleanup: true,
      recordNameApprovals: shouldRecordGroupNameApprovals(review.confirmationSource),
      arrangeLooseTabs: true,
      generation: review.generation,
    });
    await editorLeaseRuntime.release();
  } catch (error) {
    browserMutationActive = false;
    throw error;
  }

  const targetWindowId = view.editor.targetWindowId;
  void finishOrganizationTransaction(prepared)
    .then(async (finished) => {
      if (!reportOutcome) return;
      // Nobody is watching this run, so a failure also flags the toolbar icon.
      if (finished.status !== "completed") await reportBackgroundError(organizationRunFailure(finished));
      await notifyOrganizationOutcome(finished, targetWindowId);
    })
    .catch((error: unknown) =>
      // Reached only when even the stranded-run record could not be written.
      reportBackgroundError(errorText(error, "Organizing stopped and its result could not be saved.")))
    .finally(() => {
      browserMutationActive = false;
    });
}

/** Extension service workers stop after 30 idle seconds; a trivial API call resets that. */
async function keepWorkerAlive<T>(work: Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
  }, 25_000);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function startBackgroundOrganize(
  targetWindowId: number,
  scope: OrganizationScope,
  origin: "popup" | "shortcut" = "popup",
): Promise<boolean> {
  // A second trigger while a run is in flight joins it: the caller follows the
  // stored job instead of showing an error and losing track of the live run.
  if (backgroundOrganize.current()) return false;
  if (browserMutationActive) throw browserMutationBusyError();
  // Claim the slot before the first await: two near-simultaneous triggers (a
  // popup click and a shortcut, or a fast double press) would otherwise both
  // pass the guard above and start two provider runs.
  const controller = new AbortController();
  const claimed = { controller };
  backgroundOrganize.claim(claimed);
  try {
    const view = await readWindowCaptureViewState();
    if (view.transactionRun && !terminalTransactionStatus(view.transactionRun.status)) {
      throw new Error("The previous organization is still being applied.");
    }
    const organizerData = await readOrganizerState();
    const connectionTest = organizerData.local.connectionTest;
    if (!connectionTest || !organizerData.local.provider.model) {
      throw new Error("Set up and test the provider before organizing.");
    }
    const state = await readConfiguredWindow(targetWindowId);
    const request = buildSanitizedRequest(
      state,
      organizerData.local.privacy,
      Date.now(),
      organizerData.local.workflow,
      normalizeOrganizationScope(state, scope),
      organizerData.local.organizerRules,
      organizerData.local.groupNamePreferences,
    );
    await writeImmutableRequest(request);
    const inputSnapshot = await createProposalInputSnapshot(state, request.requestJson);
    const job: ProviderJobResult = {
      status: "requesting",
      startedAt: Date.now(),
      finishedAt: null,
      proposal: null,
      repairAttempted: false,
      error: null,
      ownerContextId: BACKGROUND_JOB_OWNER,
      cancellationReason: null,
      transactionId: null,
    };
    if (origin === "shortcut") await showOrganizingProgress();
    await writeProposalReview(null);
    await writeProviderJob(job);
    void keepWorkerAlive(runBackgroundOrganize({
      targetWindowId,
      organizerData,
      request,
      inputSnapshot,
      job,
      signal: controller.signal,
      origin,
    }))
      .catch((error: unknown) => failBackgroundOrganize(job, error, controller.signal.aborted, origin, targetWindowId))
      .finally(() => {
        // Clear the handle only if this run still owns it, so a run that
        // finishes late cannot drop a newer run's claim.
        backgroundOrganize.release(claimed);
        // Unconditional: a shortcut press can show progress for a run the popup started.
        void clearOrganizingProgress();
      });
    return true;
  } catch (error) {
    backgroundOrganize.release(claimed);
    throw error;
  }
}

// Generation never touches tabs, so every failure here leaves the window as it was.
// Saying so is the single most reassuring fact the user can get.
function withNothingMoved(message: string): string {
  return /nothing moved|before any tab moved/i.test(message) ? message : `${message} Nothing moved.`;
}

async function failBackgroundOrganize(
  job: ProviderJobResult,
  error: unknown,
  cancelled: boolean,
  origin: "popup" | "shortcut",
  targetWindowId: number,
): Promise<void> {
  const message = cancelled
    ? "Organizing was cancelled."
    : withNothingMoved(errorText(error, "Organizing failed before any tab moved."));
  await writeProviderJob({
    ...job,
    status: cancelled ? "cancelled" : "failed",
    finishedAt: Date.now(),
    error: message,
    cancellationReason: cancelled ? "user_cancelled" : null,
    transactionId: null,
  });
  if (!cancelled) await reportBackgroundError(message);
  if (!cancelled && origin === "shortcut" && !(await organizeWindowOpen())) {
    await notifyOrganizeShortcut({ kind: "failed", windowId: targetWindowId }, "Nothing moved", message);
  }
}

async function runBackgroundOrganize(context: {
  targetWindowId: number;
  organizerData: OrganizerStoredState;
  request: ImmutableRequestBundle;
  inputSnapshot: Awaited<ReturnType<typeof createProposalInputSnapshot>>;
  job: ProviderJobResult;
  signal: AbortSignal;
  origin: "popup" | "shortcut";
}): Promise<void> {
  const { organizerData, request, inputSnapshot, signal, origin } = context;
  const result = await generateProposalWithDiagnostics({
    config: {
      ...organizerData.local.provider,
      customHeaders: organizerData.session.customHeaders,
    },
    apiKey: organizerData.session.apiKey,
    connectionTest: organizerData.local.connectionTest!,
    request,
    organizerPrompt: organizerData.local.customOrganizerPrompt ?? undefined,
    signal,
    stream: true,
  }, "manual");
  if (signal.aborted) throw new Error("Organizing was cancelled.");
  const job: ProviderJobResult = {
    ...result,
    ownerContextId: BACKGROUND_JOB_OWNER,
    cancellationReason: null,
    transactionId: null,
  };
  if (result.status !== "validated" || !result.proposal) {
    throw new Error(result.error ?? "The model did not return a usable plan.");
  }
  const review = createProposalReviewState(result.proposal, request, inputSnapshot, historyGenerationStats(result));
  // Read the toggle now, not at start: the user may switch review on while waiting.
  const { workflow } = (await readOrganizerState()).local;
  if (!workflow.organizeWithoutReview) {
    await writeProposalReview(review);
    await writeProviderJob(job);
    if (origin === "shortcut" && !(await organizeWindowOpen())) {
      // The window was dismissed mid-run; the plan comes forward by itself.
      await openFinderWindow(context.targetWindowId, "organize").catch(async () => {
        const groups = review.proposal.groups.length;
        await notifyOrganizeShortcut(
          { kind: "review", windowId: context.targetWindowId },
          "Plan ready to review",
          `${groups} group${groups === 1 ? "" : "s"} proposed. Nothing has moved yet.`,
        );
      });
    }
    return;
  }

  if (browserMutationActive) throw browserMutationBusyError();
  browserMutationActive = true;
  let prepared: PreparedOrganizationTransaction;
  try {
    const live = await readConfiguredWindow(context.targetWindowId);
    const checked = applyDriftCheckResult(
      review,
      checkProposalDrift(review.inputSnapshot, live, review.request, review.proposal),
    );
    if (
      checked.validationIssues.length > 0 ||
      checked.regenerationReasons.length > 0 ||
      checked.signalAcknowledgementRequired ||
      checked.status === "target_invalid"
    ) {
      await bestEffortDiagnostic(() => recordOperationalDiagnostic({
        kind: "proposal_stale",
        source: "manual",
        detail: "The tabs changed while the plan was being made. Nothing moved.",
      }));
      throw new Error("The tabs changed while the plan was being made, so nothing moved. Organize again.");
    }
    const confirmed = confirmProposalReview(checked, Date.now(), "automatic");
    prepared = await prepareOrganizationTransaction({
      live,
      request: confirmed.request,
      proposal: confirmed.proposal,
      inputSnapshot: confirmed.inputSnapshot.browserState,
      runStartedAt: job.startedAt ?? Date.now(),
      allowBlankTabCleanup: true,
      recordNameApprovals: false,
      arrangeLooseTabs: true,
      generation: review.generation,
    });
  } catch (error) {
    browserMutationActive = false;
    throw error;
  }
  try {
    await writeProviderJob({ ...job, transactionId: prepared.run.transactionId });
    const finished = await finishOrganizationTransaction(prepared);
    if (finished.status !== "completed") await reportBackgroundError(organizationRunFailure(finished));
    if (origin === "shortcut" && !(await organizeWindowOpen())) {
      await notifyOrganizationOutcome(finished, context.targetWindowId);
    }
  } finally {
    browserMutationActive = false;
  }
}

function cancelBackgroundOrganize(): void {
  backgroundOrganize.current()?.controller.abort();
}

function isClosableBlankSemanticTab(tab: SemanticTab): boolean {
  return (
    !tab.active &&
    !tab.pinned &&
    !tab.audible &&
    tab.groupId === UNGROUPED_GROUP_ID &&
    tab.splitView.known &&
    tab.splitView.value === -1 &&
    isBlankNewTabUrl(tab.url)
  );
}

// Closing tabs is order-independent, so cleanup closes several at once. Opening
// tabs stays serial: chrome.tabs.create appends, so its order is the tab order.
const BULK_TAB_CONCURRENCY = 8;

async function closeInactiveBlankTabs(
  candidateIds: readonly number[],
): Promise<{ requested: number; closed: number; skipped: number }> {
  let closed = 0;
  await forEachWithConcurrency(candidateIds, BULK_TAB_CONCURRENCY, async (tabId) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (
        tab.active ||
        tab.pinned ||
        tab.audible ||
        tab.groupId !== UNGROUPED_GROUP_ID ||
        !tab.url ||
        !isBlankNewTabUrl(tab.url)
      ) {
        return;
      }
      await chrome.tabs.remove(tabId);
      closed += 1;
    } catch {
      // A tab may close or navigate between review and finalization. Skipping
      // is safer than treating cleanup as a reason to roll back valid groups.
    }
  });
  return {
    requested: candidateIds.length,
    closed,
    skipped: candidateIds.length - closed,
  };
}

async function runOrganizationUndo(transactionId: string): Promise<void> {
  if (browserMutationActive) throw browserMutationBusyError();
  browserMutationActive = true;
  try {
    await performOrganizationUndo(transactionId);
  } finally {
    browserMutationActive = false;
  }
}

async function performOrganizationUndo(transactionId: string): Promise<void> {
  const point = await readUndoPoint();
  if (!point || point.transactionId !== transactionId || point.status !== "available") {
    throw new Error("The single-level undo point is unavailable.");
  }
  await ensureOrganizerTransactionAvailable();
  await writeUndoPoint({ ...point, status: "running", conflicts: [] });
  let result: UndoPoint;
  try {
    result = await executeConflictAwareUndo(point, transactionRuntime);
  } catch (error) {
    // A throw mid-restore must not leave the single undo point stuck at
    // "running": nothing clears that, so the undo point would be permanently
    // unusable with a half-restored window. Record a terminal partial result.
    const reason = error instanceof Error && error.message ? error.message : "Undo failed.";
    result = {
      ...point,
      status: "partial",
      conflicts: [`Undo stopped before finishing: ${reason}`],
    };
  }
  await writeUndoPoint(result);
  await updateLatestHistoryUndoStatus(result.status, result.conflicts.length);
  await bestEffortDiagnostic(() => recordOperationalDiagnostic({
    kind: result.status === "partial" ? "undo_partial" : "undo_completed",
    source: "undo",
    detail: result.conflicts.join(" ") || "Original grouping restored.",
    transactionId,
    conflictCount: result.conflicts.length,
  }));
  await refreshStoredCapture();
}

async function closeReviewedCleanupSuggestions(
  targetWindowId: number,
  requestedTabIds: readonly number[],
): Promise<{ requested: number; closed: number; skipped: number }> {
  if (requestedTabIds.length > 200) {
    throw new Error("Too many cleanup selections were submitted.");
  }
  const uniqueTabIds = [...new Set(requestedTabIds)];
  if (
    uniqueTabIds.some((tabId) => !Number.isSafeInteger(tabId) || tabId < 0)
  ) {
    throw new Error("The cleanup selection contains an invalid tab ID.");
  }
  const [organizerData, view] = await Promise.all([
    readOrganizerState(),
    readWindowCaptureViewState(),
  ]);
  const workflow = organizerData.local.workflow;
  const suggestionOptions = {
    inactiveAfterMs: workflow.inactiveSuggestionHours * 60 * 60_000,
    lowValueAfterMs: workflow.lowValueSuggestionHours * 60 * 60_000,
    lowValueTabIds:
      view.transactionRun?.targetWindowId === targetWindowId
        ? view.transactionRun.proposal.lowValueTabIds ?? []
        : [],
  };

  const live = await readConfiguredWindow(targetWindowId);
  const stillSuggestedIds = new Set(
    findCleanupSuggestions(live, Date.now(), suggestionOptions).map(
      (suggestion) => suggestion.tabId,
    ),
  );
  let closed = 0;
  await forEachWithConcurrency(uniqueTabIds.filter((tabId) => stillSuggestedIds.has(tabId)), BULK_TAB_CONCURRENCY, async (tabId) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (
        tab.windowId !== targetWindowId ||
        tab.active ||
        tab.pinned ||
        tab.audible
      ) {
        return;
      }
      await chrome.tabs.remove(tabId);
      closed += 1;
    } catch {
      // Tabs can close or change between the final snapshot and removal.
      // Keep them rather than turning a safe cleanup into a hard failure.
    }
  });
  await refreshStoredCapture();
  return {
    requested: uniqueTabIds.length,
    closed,
    skipped: uniqueTabIds.length - closed,
  };
}

function sameTabIds(left: readonly number[], right: readonly number[]): boolean {
  const a = [...new Set(left)].sort((x, y) => x - y);
  const b = [...new Set(right)].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function stashReviewedTabs(
  targetWindowId: number,
  scope: TabStashScope,
  expectedTabIds: readonly number[],
  requestedName: string,
  keepOpen = false,
): Promise<void> {
  if (keepOpen) {
    await linkWindowAsStash(targetWindowId, scope, expectedTabIds, requestedName);
    return;
  }
  const live = await readConfiguredWindow(targetWindowId);
  const preview = buildTabStashPreview(live, scope);
  const eligibleIds = preview.tabs.map((tab) => tab.sourceTabId);
  if (eligibleIds.length === 0) throw new Error("None of these tabs can be saved.");
  if (!sameTabIds(eligibleIds, expectedTabIds)) {
    throw new Error("The window changed before the workspace could be saved. Try again.");
  }
  const name = requestedName.trim();
  if (!name || name.length > 120) throw new Error("A workspace name must be 1–120 characters.");
  preview.name = name;
  const pending: SavedTabStash = {
    ...savedStashFromPreview(preview),
    status: "closing_interrupted",
  };
  await updateTabStashes((current) => [pending, ...current]);

  let removalError: string | null = null;
  try {
    await chrome.tabs.remove(eligibleIds);
  } catch {
    removalError = "One or more tabs could not be closed after the workspace was saved.";
  }
  const closedIds = new Set<number>();
  await Promise.all(eligibleIds.map(async (tabId) => {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      closedIds.add(tabId);
    }
  }));
  if (closedIds.size === 0) {
    await dropPendingStash(pending.id);
    throw new Error(removalError ?? "The eligible tabs stayed open, so no workspace was kept.");
  }
  const conflicts = [
    ...(removalError ? [removalError] : []),
    ...(closedIds.size === eligibleIds.length
      ? []
      : [`${eligibleIds.length - closedIds.size} eligible tab(s) stayed open and were not added to the workspace.`]),
  ];
  const closedTabs = pending.tabs.filter((tab) => closedIds.has(tab.sourceTabId));
  const usedGroups = new Set(closedTabs.flatMap((tab) => tab.groupKey ? [tab.groupKey] : []));
  const saved: SavedTabStash = {
    ...pending,
    tabs: closedTabs,
    groups: pending.groups.filter((group) => usedGroups.has(group.key)),
    status: "saved",
    closeConflicts: conflicts,
  };
  await replacePendingStash(saved);
  try {
    await refreshStoredCapture();
  } catch {
    // Stashing an entire window can intentionally close the source window.
  }
}

// Large restores open their background tabs unloaded, the way a restarted
// browser does, so reopening a big stash does not load every page at once.
// A tab is discarded only after its address commits; discarding earlier would
// leave it blank.
const LAZY_RESTORE_THRESHOLD = 15;

async function discardRestoredBackgroundTabs(tabIds: ReadonlySet<number>): Promise<void> {
  if (tabIds.size <= LAZY_RESTORE_THRESHOLD) return;
  await Promise.all([...tabIds].map(async (tabId) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        // The tab closed while we polled for its address; there is nothing left
        // to discard.
        return;
      }
      if (tab.active || tab.discarded) return;
      if (tab.url && !tab.pendingUrl) {
        await chrome.tabs.discard(tabId).catch(() => undefined);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }));
}

// Saves a whole window as a stash without closing anything and links the
// window to it, so it keeps saving itself from then on.
async function linkWindowAsStash(
  targetWindowId: number,
  scope: TabStashScope,
  expectedTabIds: readonly number[],
  requestedName: string,
): Promise<void> {
  if (scope.mode !== "window") throw new Error("Only a whole window can stay open as a linked workspace.");
  const live = await readConfiguredWindow(targetWindowId);
  const preview = buildTabStashPreview(live, scope);
  const eligibleIds = preview.tabs.map((tab) => tab.sourceTabId);
  if (eligibleIds.length === 0) throw new Error("No tabs in this window can be saved.");
  if (!sameTabIds(eligibleIds, expectedTabIds)) {
    throw new Error("The window changed before the workspace could be saved. Try again.");
  }
  const name = requestedName.trim();
  if (!name || name.length > 120) throw new Error("A workspace name must be 1–120 characters.");
  preview.name = name;
  await withWorkspaceLock(async () => {
    const workspaces = await readLinkedStashWorkspaces();
    if (workspaces.some((workspace) => workspace.windowId === targetWindowId)) {
      throw new Error("This window is already linked to a workspace.");
    }
    const now = Date.now();
    const saved = savedStashFromPreview(preview, now);
    const linked: LinkedStashWorkspace = {
      id: crypto.randomUUID(),
      stashId: saved.id,
      windowId: targetWindowId,
      mode: "whole_window",
      trackedTabIds: eligibleIds,
      trackedTabs: saved.tabs.flatMap((tab) => tab.stableKey ? [{ tabId: tab.sourceTabId, stableKey: tab.stableKey }] : []),
      startedAt: now,
      updatedAt: now,
      draft: null,
    };
    // A linked window saves all of itself, so the stash starts from the same
    // whole-window capture its later saves will use; otherwise the first save
    // would report the window's protected tabs as changes.
    const capture = await captureLinkedWindow(linked);
    if (capture.tabs.length === 0) throw new Error("This window has no tabs that can be saved.");
    const workspace: LinkedStashWorkspace = { ...linked, draft: await draftFromCapture(capture, now) };
    // The link is written first: a stash read in between would otherwise see
    // an unknown workspace id and clear it.
    await writeLinkedStashWorkspaces([workspace, ...workspaces]);
    await updateTabStashes((current) => [{
      ...saved,
      tabs: capture.tabs,
      groups: capture.groups,
      excludedTabs: [],
      lastOpenedAt: now,
      activeWorkspaceId: workspace.id,
    }, ...current]);
  });
  scheduleWorkspaceDraft(targetWindowId);
}

async function restoreSavedStash(
  stashId: string,
  targetWindowId: number,
  requestedSourceIndexes?: readonly number[],
  requestedOptions?: StashRestoreOptions,
  revisionId?: string,
): Promise<NonNullable<SavedTabStash["restoreResult"]>> {
  const wantsLinkedWorkspace = requestedOptions?.afterRestore === "linked_workspace";
  if (wantsLinkedWorkspace && linkedWorkspaceRestores.has(stashId)) {
    throw new Error("This workspace is already opening in a linked window.");
  }
  if (wantsLinkedWorkspace) linkedWorkspaceRestores.add(stashId);
  try {
  const stashes = await readTabStashes();
  const stash = stashes.find((candidate) => candidate.id === stashId);
  if (!stash) throw new Error("The selected workspace no longer exists.");
  if (wantsLinkedWorkspace && stash.activeWorkspaceId) {
    throw new Error("This workspace is already open in a linked window.");
  }
  // An earlier version opens as plain copies; the stash itself is untouched.
  const revision = revisionId === undefined ? null : stash.revisions.find((candidate) => candidate.id === revisionId);
  if (revision === undefined) throw new Error("That earlier version of the workspace no longer exists.");
  if (revision && wantsLinkedWorkspace) throw new Error("An earlier version can only be opened as copies.");
  const source = revision ?? stash;
  if (!revision && stash.status === "closing_interrupted") {
    throw new Error("This workspace was interrupted while closing tabs. Recover it before opening it.");
  }
  if (source.tabs.length === 0) throw new Error("This workspace does not contain restorable tabs.");
  const requestedList = requestedSourceIndexes === undefined ? null : [...requestedSourceIndexes];
  const requestedIndexes = requestedList === null
    ? null
    : new Set(requestedList);
  if (requestedIndexes && (
    requestedIndexes.size === 0 ||
    requestedIndexes.size !== requestedList!.length ||
    [...requestedIndexes].some((index) => !Number.isSafeInteger(index) || index < 0)
  )) {
    throw new Error("Choose at least one valid saved tab to open.");
  }
  const selectedTabs = requestedIndexes === null
    ? source.tabs
    : source.tabs.filter((tab) => requestedIndexes.has(tab.sourceIndex));
  if (selectedTabs.length === 0 || (requestedIndexes && selectedTabs.length !== requestedIndexes.size)) {
    throw new Error("One or more selected saved tabs are no longer available.");
  }
  const options: StashRestoreOptions = requestedOptions ?? {
    destination: stash.scope.mode === "window" ? "new_window" : "current_window",
    duplicateHandling: "duplicate",
    afterRestore: "keep",
  };
  if (options.afterRestore === "linked_workspace" && options.destination !== "new_window") {
    throw new Error("A linked window has to be a new window.");
  }
  if (options.afterRestore === "linked_workspace" && options.duplicateHandling !== "duplicate") {
    throw new Error("A linked window opens its own copy of every tab.");
  }
  if (options.destination === "current_window") {
    const target = await chrome.windows.get(targetWindowId);
    if (target.type !== "normal" || target.incognito) {
      throw new Error("Choose a normal non-incognito window for this workspace.");
    }
  }

  const conflicts: string[] = [];
  const restoredIds = new Map<number, number>();
  const createdTabIds = new Set<number>();
  const openTabs = options.duplicateHandling === "duplicate"
    ? []
    : await chrome.tabs.query(options.destination === "current_window" ? { windowId: targetWindowId } : {});
  const alreadyOpenByUrl = new Map<string, chrome.tabs.Tab>();
  openTabs.forEach((tab) => {
    const url = tab.url ?? tab.pendingUrl;
    if (url && !alreadyOpenByUrl.has(canonicalExactUrl(url))) alreadyOpenByUrl.set(canonicalExactUrl(url), tab);
  });
  const tabsToOpen = selectedTabs.filter((tab) => {
    const existing = alreadyOpenByUrl.get(canonicalExactUrl(tab.url));
    if (!existing) return true;
    if (options.duplicateHandling === "reuse" && existing.id !== undefined) {
      restoredIds.set(tab.sourceTabId, existing.id);
    }
    return false;
  });
  const reusedCount = options.duplicateHandling === "reuse" ? restoredIds.size : 0;
  const skippedCount = options.duplicateHandling === "skip"
    ? selectedTabs.length - tabsToOpen.length
    : 0;
  let restoreWindowId = targetWindowId;
  if (options.destination === "new_window" && tabsToOpen.length > 0) {
    const first = tabsToOpen[0]!;
    const createdWindow = await chrome.windows.create({ url: first.url, focused: true });
    if (!createdWindow) throw new Error("The browser did not create the restore window.");
    const createdTab = createdWindow.tabs?.[0];
    if (createdWindow.id === undefined || createdTab?.id === undefined) {
      throw new Error("The browser did not return the new restore window.");
    }
    restoreWindowId = createdWindow.id;
    restoredIds.set(first.sourceTabId, createdTab.id);
    createdTabIds.add(createdTab.id);
  } else if (options.destination === "new_window") {
    const reusable = [...restoredIds.values()][0];
    if (reusable !== undefined) {
      const existing = await chrome.tabs.get(reusable);
      if (existing.windowId !== undefined) {
        restoreWindowId = existing.windowId;
        await chrome.windows.update(existing.windowId, { focused: true });
      }
    }
  }

  const remainingTabs = options.destination === "new_window" && tabsToOpen.length > 0
    ? tabsToOpen.slice(1)
    : tabsToOpen;
  for (const tab of remainingTabs) {
    try {
      const created = await chrome.tabs.create({
        windowId: restoreWindowId,
        url: tab.url,
        active: false,
      });
      if (created.id === undefined) throw new Error("Tab identity unavailable");
      restoredIds.set(tab.sourceTabId, created.id);
      createdTabIds.add(created.id);
    } catch {
      conflicts.push(`Could not reopen “${tab.title}”.`);
    }
  }

  let restoredGroups = 0;
  const restoredStashLinks: GroupStashLink[] = [];
  for (const group of [...source.groups].sort((a, b) => a.sourceIndex - b.sourceIndex)) {
    const tabIds = selectedTabs.flatMap((tab) =>
      tab.groupKey === group.key && restoredIds.has(tab.sourceTabId) &&
      createdTabIds.has(restoredIds.get(tab.sourceTabId)!)
        ? [restoredIds.get(tab.sourceTabId)!]
        : [],
    );
    if (tabIds.length === 0) continue;
    try {
      const groupId = await chrome.tabs.group({
        tabIds: tabIds as [number, ...number[]],
        createProperties: { windowId: restoreWindowId },
      }) as number;
      await chrome.tabGroups.update(groupId, {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
      });
      restoredStashLinks.push({
        groupId,
        windowId: restoreWindowId,
        stashId,
        memberTabIds: [...tabIds],
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        recordedAt: Date.now(),
      });
      restoredGroups += 1;
    } catch {
      conflicts.push(`Tabs for “${group.title || "Untitled group"}” reopened but its group could not be restored.`);
    }
  }
  await discardRestoredBackgroundTabs(createdTabIds);
  const restoreResult: NonNullable<SavedTabStash["restoreResult"]> = {
    restoredAt: Date.now(),
    openedTabs: restoredIds.size - reusedCount,
    reusedTabs: reusedCount,
    skippedTabs: skippedCount,
    restoredGroups,
    conflicts,
  };
  if (revision) return restoreResult;
  const restored: SavedTabStash = {
    ...stash,
    lastOpenedAt: Date.now(),
    status: conflicts.length > 0 ? "restore_partial" : "restored",
    restoreResult,
  };
  if (options.afterRestore === "linked_workspace") {
    if (tabsToOpen.length === 0) throw new Error("A linked window needs at least one tab.");
    const now = Date.now();
    const workspace: LinkedStashWorkspace = {
      id: crypto.randomUUID(),
      stashId,
      windowId: restoreWindowId,
      mode: "whole_window",
      trackedTabIds: [...restoredIds.values()],
      trackedTabs: selectedTabs.flatMap((tab) => {
        const tabId = restoredIds.get(tab.sourceTabId);
        return tabId === undefined ? [] : [{ tabId, stableKey: tab.stableKey ?? `stash:${tab.sourceIndex}` }];
      }),
      startedAt: now,
      updatedAt: now,
      draft: null,
    };
    await withWorkspaceLock(async () => {
      const workspaces = await readLinkedStashWorkspaces();
      await writeLinkedStashWorkspaces([workspace, ...workspaces.filter((item) => item.stashId !== stashId)]);
    });
    restored.activeWorkspaceId = workspace.id;
  }
  await updateTabStashes((current) => current.map((candidate) => candidate.id === stashId ? restored : candidate));
  if (restoredStashLinks.length > 0) await recordGroupStashLinks(restoredStashLinks);
  return restored.restoreResult!;
  } finally {
    if (wantsLinkedWorkspace) linkedWorkspaceRestores.delete(stashId);
  }
}

async function openSavedStashTab(
  stashId: string,
  sourceIndex: number,
  targetWindowId: number,
  active: boolean,
): Promise<void> {
  const stash = (await readTabStashes()).find((candidate) => candidate.id === stashId);
  const tab = stash?.tabs.find((candidate) => candidate.sourceIndex === sourceIndex);
  if (!tab) throw new Error("The selected saved tab no longer exists.");
  const target = await chrome.windows.get(targetWindowId);
  if (target.type !== "normal" || target.incognito) throw new Error("Choose a normal non-incognito window for this tab.");
  await chrome.tabs.create({ windowId: targetWindowId, url: tab.url, active });
}

async function openSavedStashCopies(
  references: readonly StashTabReference[],
  targetWindowId: number,
  destination: "current_window" | "new_window",
  duplicateHandling: "reuse" | "skip" | "duplicate",
): Promise<StashCopyOpenResult> {
  const stashes = await readTabStashes();
  const resolved = resolveStashTabReferences(stashes, references);
  const available = orderResolvedStashTabs(stashes, resolved.available);
  const stale = resolved.stale;
  const empty: StashCopyOpenResult = { requested: references.length, opened: 0, reused: 0, skipped: 0, failed: 0, stale: stale.length, restoredGroups: 0, conflicts: [], retryItems: stale };
  if (available.length === 0) return empty;
  if (destination === "current_window") {
    const target = await chrome.windows.get(targetWindowId);
    if (target.type !== "normal" || target.incognito) throw new Error("Choose a normal non-incognito window for these tabs.");
  }
  const exactOpen = new Map<string, chrome.tabs.Tab>();
  if (duplicateHandling !== "duplicate") {
    (await chrome.tabs.query({})).forEach((tab) => {
      const raw = tab.url ?? tab.pendingUrl;
      if (raw && tab.id !== undefined && !exactOpen.has(canonicalExactUrl(raw))) exactOpen.set(canonicalExactUrl(raw), tab);
    });
  }
  const openedByIdentity = new Map<string, number>();
  const createdIds = new Set<number>();
  const conflicts: string[] = [];
  let reused = 0;
  let skipped = 0;
  let failed = 0;
  const retryItems: StashTabReference[] = [...stale];
  let windowId = targetWindowId;
  const identity = (item: (typeof available)[number]): string => `${item.stashId}\u0000${item.stashTabId}`;
  const pending = available.filter((item) => {
    const existing = exactOpen.get(canonicalExactUrl(item.tab.url));
    if (!existing) return true;
    if (duplicateHandling === "reuse") {
      openedByIdentity.set(identity(item), existing.id!);
      reused += 1;
    } else skipped += 1;
    return false;
  });
  if (destination === "new_window" && pending.length > 0) {
    const first = pending.shift()!;
    try {
      const created = await chrome.windows.create({ url: first.tab.url, focused: true });
      if (!created) throw new Error("New window unavailable");
      const tab = created.tabs?.[0];
      if (created.id === undefined || tab?.id === undefined) throw new Error("New window identity unavailable");
      windowId = created.id;
      openedByIdentity.set(identity(first), tab.id);
      createdIds.add(tab.id);
    } catch {
      const failedItems = [first, ...pending];
      failed += failedItems.length;
      retryItems.push(...failedItems);
      conflicts.push("The new window could not be created. No selected tabs were opened in the current window.");
      return { requested: references.length, opened: 0, reused, skipped, failed, stale: stale.length, restoredGroups: 0, conflicts, retryItems };
    }
  }
  for (const item of pending) {
    try {
      const created = await chrome.tabs.create({ windowId, url: item.tab.url, active: false });
      if (!created || created.id === undefined) throw new Error("Tab identity unavailable");
      openedByIdentity.set(identity(item), created.id);
      createdIds.add(created.id);
    } catch {
      failed += 1;
      retryItems.push(item);
      conflicts.push(`Could not open “${item.tab.title}”.`);
    }
  }
  let restoredGroups = 0;
  const grouped = new Map<string, typeof available>();
  for (const item of available) {
    if (!item.group) continue;
    const key = `${item.stashId}\u0000${item.group.key}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  for (const items of grouped.values()) {
    const tabIds = items.flatMap((item) => {
      const id = openedByIdentity.get(identity(item));
      return id !== undefined && createdIds.has(id) ? [id] : [];
    });
    if (tabIds.length === 0) continue;
    try {
      const group = items[0]!.group!;
      const groupId = await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], createProperties: { windowId } }) as number;
      await chrome.tabGroups.update(groupId, { title: group.title, color: group.color, collapsed: group.collapsed });
      restoredGroups += 1;
    } catch {
      conflicts.push(`Opened tabs from “${items[0]!.group!.title || "Untitled group"}” without restoring their group.`);
    }
  }
  return { requested: references.length, opened: createdIds.size, reused, skipped, failed, stale: stale.length, restoredGroups, conflicts, retryItems };
}

function stashedTabsMatch(left: readonly SavedTabStash["tabs"][number][], right: readonly SavedTabStash["tabs"][number][]): boolean {
  return left.length === right.length && left.every((tab, index) => {
    const expected = right[index];
    return expected !== undefined && tab.sourceTabId === expected.sourceTabId && tab.sourceIndex === expected.sourceIndex &&
      tab.title === expected.title && tab.url === expected.url && tab.groupKey === expected.groupKey && tab.stableKey === expected.stableKey;
  });
}

function stashedGroupsMatch(left: readonly SavedTabStash["groups"][number][], right: readonly SavedTabStash["groups"][number][]): boolean {
  return left.length === right.length && left.every((group, index) => {
    const expected = right[index];
    return expected !== undefined && group.key === expected.key && group.sourceGroupId === expected.sourceGroupId &&
      group.sourceIndex === expected.sourceIndex && group.title === expected.title && group.color === expected.color && group.collapsed === expected.collapsed;
  });
}

function stableStoredValue(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    return Object.fromEntries(Object.keys(candidate).sort().flatMap((key) =>
      candidate[key] === undefined ? [] : [[key, candidate[key]]],
    ));
  });
}

async function createWorkspaceFromSearchSelection(
  references: readonly StashTabReference[],
  targetWindowId: number,
  name: string,
  preserveGroups: boolean,
  sourceQueries: readonly string[],
  reviewedSelectionToken: string,
): Promise<SearchWorkspaceCreationResult> {
  const sourceStashes = await readTabStashes();
  const { available, stale } = resolveStashTabReferences(sourceStashes, references);
  if (stashSelectionResolutionToken(available, stale) !== reviewedSelectionToken) {
    return { stashId: null, available: available.length, stale: stale.length, opened: 0, failed: 0, conflicts: [], requiresReview: true };
  }
  if (available.length === 0) return { stashId: null, available: 0, stale: stale.length, opened: 0, failed: 0, conflicts: [] };
  const created = createStashFromResolvedSelection(available, name, { preserveGroups, sourceQueries });
  await updateTabStashes((current) => [created, ...current]);
  const persisted = await readTabStashes();
  const verified = persisted.find((stash) => stash.id === created.id);
  const sourcesMatch = sourceStashes.every((source) => {
    const stored = persisted.find((stash) => stash.id === source.id);
    return stored !== undefined && stableStoredValue(stored) === stableStoredValue(source);
  });
  if (!verified || stableStoredValue(verified) !== stableStoredValue(created) || !sourcesMatch) {
    throw new Error("The new workspace could not be verified, so no tabs were opened.");
  }
  const restore = await restoreSavedStash(created.id, targetWindowId, undefined, {
    destination: "new_window",
    duplicateHandling: "duplicate",
    afterRestore: "linked_workspace",
  });
  return {
    stashId: created.id,
    available: available.length,
    stale: stale.length,
    opened: restore.openedTabs,
    failed: restore.conflicts.filter((conflict) => conflict.startsWith("Could not reopen")).length,
    conflicts: restore.conflicts,
  };
}

async function linkedWorkspaceForStash(stashId: string, workspaceLockHeld = false): Promise<{
  stash: SavedTabStash;
  workspace: LinkedStashWorkspace;
  stashes: SavedTabStash[];
  workspaces: LinkedStashWorkspace[];
}> {
  const [stashes, workspaces] = await Promise.all([
    readTabStashes(),
    readLinkedStashWorkspaces(),
  ]);
  const stash = stashes.find((candidate) => candidate.id === stashId);
  if (!stash) throw new Error("The selected workspace no longer exists.");
  const workspace = workspaces.find((candidate) => candidate.id === stash.activeWorkspaceId);
  if (!workspace) throw new Error("This workspace is not open in a linked window.");
  try {
    await chrome.windows.get(workspace.windowId);
  } catch {
    // The workspace lock is not re-entrant: when the caller already holds it,
    // settle through the unlocked path or this call deadlocks the worker.
    if (workspaceLockHeld) await settleWorkspaceWithoutWindowUnlocked(workspace.id);
    else await settleWorkspaceWithoutWindow(workspace.id);
    throw new Error("The linked window is no longer open. Its last captured state was saved to the workspace.");
  }
  return { stash, workspace, stashes, workspaces };
}

async function diffLinkedWorkspace(stashId: string): Promise<StashWorkspaceDiff> {
  const { stash, workspace } = await linkedWorkspaceForStash(stashId);
  return buildStashWorkspaceDiff(stash, await captureLinkedWindow(workspace));
}

async function updateLinkedWorkspace(
  stashId: string,
  putAway: boolean,
  expectedCaptureToken: string,
): Promise<void> {
  const { stash, workspace } = await linkedWorkspaceForStash(stashId);
  const capture = await captureLinkedWindow(workspace);
  if (await stashWorkspaceCaptureToken(capture) !== expectedCaptureToken) {
    throw new Error("The linked window changed after review. Review the latest changes before saving.");
  }
  if (capture.tabs.length === 0) throw new Error("The linked window has no restorable tabs, so the workspace was not changed.");
  const now = Date.now();
  const updated: SavedTabStash = {
    ...stash,
    tabs: capture.tabs,
    groups: capture.groups,
    updatedAt: now,
    revisions: [{
      id: crypto.randomUUID(),
      savedAt: stash.updatedAt,
      tabs: stash.tabs,
      groups: stash.groups,
    }, ...stash.revisions].slice(0, 20),
    activeWorkspaceId: stash.activeWorkspaceId,
    status: "saved",
    restoreResult: null,
  };
  await updateTabStashes((current) => current.map((candidate) => candidate.id === stashId ? updated : candidate));
  const verified = (await readTabStashes()).find((candidate) => candidate.id === stashId);
  if (
    !verified || verified.updatedAt !== now ||
    !stashedTabsMatch(verified.tabs, capture.tabs) ||
    !stashedGroupsMatch(verified.groups, capture.groups) ||
    verified.revisions[0]?.savedAt !== stash.updatedAt ||
    !stashedTabsMatch(verified.revisions[0]?.tabs ?? [], stash.tabs) ||
    !stashedGroupsMatch(verified.revisions[0]?.groups ?? [], stash.groups) ||
    verified.activeWorkspaceId !== stash.activeWorkspaceId
  ) {
    throw new Error("The updated workspace could not be verified. Its window remains open.");
  }
  if (putAway) {
    await parkLinkedWorkspace(stashId, { discardChanges: false });
    return;
  }
  // The saved capture becomes the draft, so a later close does not replay an
  // older draft over what was just saved.
  await withWorkspaceLock(async () => {
    const latest = await readLinkedStashWorkspaces();
    await writeLinkedStashWorkspaces(latest.map((candidate) => candidate.id === workspace.id
      ? { ...candidate, updatedAt: now, draft: { tabs: capture.tabs, groups: capture.groups, capturedAt: now, captureToken: expectedCaptureToken } }
      : candidate));
  });
}

async function detachLinkedWorkspace(stashId: string): Promise<void> {
  await withWorkspaceLock(async () => {
    const { workspace, workspaces } = await linkedWorkspaceForStash(stashId, true);
    await updateTabStashes((current) => current.map((candidate) => candidate.id === stashId
      ? { ...candidate, activeWorkspaceId: null }
      : candidate));
    await writeLinkedStashWorkspaces(workspaces.filter((candidate) => candidate.id !== workspace.id));
  });
}

async function updateSavedStashMetadata(stashId: string, requestedName: string, note: string): Promise<void> {
  const name = requestedName.trim();
  if (!name || name.length > 120) throw new Error("A workspace name must be 1–120 characters.");
  if (note.length > 2_000) throw new Error("A workspace note must be at most 2,000 characters.");
  await updateTabStashes((current) => {
    if (!current.some((stash) => stash.id === stashId)) throw new Error("The selected workspace no longer exists.");
    return current.map((stash) => stash.id === stashId ? { ...stash, name, note } : stash);
  });
}

// A stash left in closing_interrupted still holds every tab it captured; the
// close itself is what may not have finished. Recovery keeps the captured set
// as an ordinary stash and reports which of its tabs are still open, without
// closing or opening anything.
async function recoverInterruptedStash(stashId: string): Promise<void> {
  const stashes = await readTabStashes();
  const stash = stashes.find((candidate) => candidate.id === stashId);
  if (!stash) throw new Error("The selected workspace no longer exists.");
  if (stash.status !== "closing_interrupted") throw new Error("This workspace does not need recovery.");
  const stillOpen = (await Promise.all(stash.tabs.map(async (tab) => {
    try {
      const live = await chrome.tabs.get(tab.sourceTabId);
      const liveUrl = live.url ?? live.pendingUrl;
      return liveUrl !== undefined && canonicalExactUrl(liveUrl) === canonicalExactUrl(tab.url);
    } catch {
      return false;
    }
  }))).filter(Boolean).length;
  const recovered: SavedTabStash = {
    ...stash,
    status: "saved",
    closeConflicts: [
      stillOpen === 0
        ? "Recovered after an interrupted close."
        : `Recovered after an interrupted close. ${stillOpen} of its tab${stillOpen === 1 ? " is" : "s are"} still open in the browser.`,
    ],
  };
  await updateTabStashes((current) => current.map((candidate) => candidate.id === stashId ? recovered : candidate));
  const verified = (await readTabStashes()).find((candidate) => candidate.id === stashId);
  if (verified?.status !== "saved" || !stashedTabsMatch(verified.tabs, stash.tabs)) {
    throw new Error("The recovered workspace could not be verified.");
  }
}

// Making an earlier version current keeps the present contents as a version
// too, so the swap can be reversed the same way.
async function restoreStashRevision(stashId: string, revisionId: string): Promise<void> {
  const stashes = await readTabStashes();
  const stash = stashes.find((candidate) => candidate.id === stashId);
  if (!stash) throw new Error("The selected workspace no longer exists.");
  if (stash.activeWorkspaceId) throw new Error("Save and close the linked window before restoring an earlier version.");
  const revision = stash.revisions.find((candidate) => candidate.id === revisionId);
  if (!revision) throw new Error("That earlier version of the workspace no longer exists.");
  const now = Date.now();
  const restored: SavedTabStash = {
    ...stash,
    tabs: structuredClone(revision.tabs),
    groups: structuredClone(revision.groups),
    updatedAt: now,
    status: "saved",
    restoreResult: null,
    revisions: [
      { id: crypto.randomUUID(), savedAt: stash.updatedAt, tabs: stash.tabs, groups: stash.groups },
      ...stash.revisions.filter((candidate) => candidate.id !== revisionId),
    ].slice(0, 20),
  };
  await updateTabStashes((current) => current.map((candidate) => candidate.id === stashId ? restored : candidate));
  const verified = (await readTabStashes()).find((candidate) => candidate.id === stashId);
  if (!verified || !stashedTabsMatch(verified.tabs, restored.tabs)) {
    throw new Error("The restored version could not be verified.");
  }
}

// Deleting moves a stash to the trash, where it stays recoverable for
// TRASH_RETENTION_DAYS; only the trash's own delete is permanent.
async function deleteSavedStash(stashId: string): Promise<void> {
  await updateTabStashesAndTrash((stashes, trash) => {
    const deleting = stashes.find((stash) => stash.id === stashId);
    if (!deleting) throw new Error("The selected workspace no longer exists.");
    if (deleting.activeWorkspaceId) throw new Error("Save and close the linked window before deleting this workspace.");
    return {
      stashes: stashes.filter((stash) => stash.id !== stashId),
      trash: [...trashEntries([deleting], "deleted", Date.now()), ...trash.filter((entry) => entry.stash.id !== stashId)],
    };
  });
}

async function restoreTrashedStash(stashId: string): Promise<void> {
  await updateTabStashesAndTrash((stashes, trash) => {
    const entry = trash.find((candidate) => candidate.stash.id === stashId);
    if (!entry) throw new Error("This workspace is no longer in the trash.");
    // Restoring counts as use, so an expired stash does not expire again at once.
    const restored: SavedTabStash = { ...entry.stash, activeWorkspaceId: null, lastOpenedAt: Date.now() };
    return {
      stashes: [restored, ...stashes.filter((stash) => stash.id !== stashId)],
      trash: trash.filter((candidate) => candidate.stash.id !== stashId),
    };
  });
}

async function purgeTrashedStash(stashId: string): Promise<void> {
  await updateTabStashesAndTrash((stashes, trash) => {
    if (!trash.some((entry) => entry.stash.id === stashId)) throw new Error("This workspace is no longer in the trash.");
    return { stashes, trash: trash.filter((entry) => entry.stash.id !== stashId) };
  });
}

type MessageHandlers = {
  [Type in WindowCaptureMessage["type"]]: (
    message: Extract<WindowCaptureMessage, { type: Type }>,
  ) => Promise<DispatchResult | void> | DispatchResult | undefined;
};

// One handler per message type. The mapped type makes a type without a handler a
// compile error, where the switch this replaced only failed at runtime.
const MESSAGE_HANDLERS: MessageHandlers = {
  "window-capture:get-state": () => undefined,
  "popup:initialize": async (message) => {
    await initializePopupTarget(message.targetWindowId, message.ownerContextId);
  },
  "popup:heartbeat": async (message) => {
    await editorLeaseRuntime.heartbeat(
      message.targetWindowId,
      message.ownerContextId,
    );
  },
  "window-capture:refresh": async () => {
    await refreshCapture();
  },
  "organization:generate": async (message) => {
    await startBackgroundOrganize(message.targetWindowId, message.scope);
  },
  "organization:cancel-generate": async () => {
    cancelBackgroundOrganize();
  },
  "organization:apply": async (message) => {
    await startOrganizationApply(message.reviewId, message.ownerContextId, message.reportOutcome === true);
  },
  "organization:undo": async (message) => {
    await runOrganizationUndo(message.transactionId);
  },
  "group-manager:get-state": async (message) => ({ groupManagerState: await readGroupManagerView(message.currentWindowId) }),
  "group-manager:set-managed": async (message) => {
    await setManagedGroups(message.groupIds, message.managed);
  },
  "group-manager:preview-edit": async (message) => ({ groupManagerEditPreview: await previewManagedGroupEdit(message.draft) }),
  "group-manager:apply-edit": async (message) => ({ groupManagerApplyResult: await applyManagedGroupEdit(message.preview) }),
  "group-manager:preview-remove": async (message) => ({ groupManagerRemovalPreview: await previewManagedGroupRemoval(message.groupIds, message.mode, message.includeActive) }),
  "group-manager:apply-remove": async (message) => ({ groupManagerApplyResult: await applyManagedGroupRemoval(message.preview) }),
  "group-manager:undo": async () => ({ groupManagerUndoResult: await undoManagedGroupChange() }),
  "auto-filing:get-state": async () => ({ autoFilingView: await readAutoFilingView() }),
  "auto-filing:undo": async (message) => {
    const result = await undoAutoFiling(message.entryId);
    return { autoFilingMessage: result.message, autoFilingView: await readAutoFilingView() };
  },
  "auto-filing:never-file": async (message) => ({ autoFilingMessage: await neverFileFromEntry(message.entryId), autoFilingView: await readAutoFilingView() }),
  "auto-filing:accept-suggestion": async () => {
    await acceptAutoFilingSuggestion();
    return { autoFilingView: await readAutoFilingView() };
  },
  "auto-filing:dismiss-suggestion": async () => {
    await dismissAutoFilingSuggestion();
    return { autoFilingView: await readAutoFilingView() };
  },
  "generated-groups:get-cleanup": async () => ({ generatedGroupCleanupSummary: await readGeneratedGroupCleanupSummary() }),
  "generated-groups:set-cleanup": async (message) => ({ generatedGroupCleanupSummary: await setGeneratedGroupCleanup(message.autoUngroupAfterDays) }),
  "generated-groups:clear": async () => ({
    generatedGroupCleanupResult: await runGeneratedGroupCleanup("manual"),
    generatedGroupCleanupSummary: await readGeneratedGroupCleanupSummary(),
  }),
  "cleanup:close-suggested-tabs": async (message) => ({ cleanupCloseResult: await closeReviewedCleanupSuggestions(message.targetWindowId, message.tabIds) }),
  "protection:protect-tabs": async (message) => {
    await protectTabs(message.targetWindowId, message.tabIds, message.permanence);
  },
  "protection:lock-groups": async (message) => {
    await lockGroups(message.targetWindowId, message.groupIds, message.permanence);
  },
  "protection:update-rules": async (message) => {
    await writePermanentProtectionRules(message.rules);
    await refreshStoredCapture();
  },
  "protection:release-session": async (message) => {
    await releaseSessionProtections(message.targetWindowId, message.tabIds, message.groupIds);
  },
  "workspace:create": async (message) => {
    await stashReviewedTabs(message.targetWindowId, message.scope, message.expectedTabIds, message.name, message.keepOpen);
  },
  "workspace:restore": async (message) => ({
    stashRestoreResult: await restoreSavedStash(
      message.stashId,
      message.targetWindowId,
      message.sourceIndexes,
      message.options,
      message.revisionId,
    ),
  }),
  "workspace:revision-restore": async (message) => {
    await restoreStashRevision(message.stashId, message.revisionId);
  },
  "workspace:open-tab": async (message) => {
    await openSavedStashTab(message.stashId, message.sourceIndex, message.targetWindowId, message.active);
  },
  "workspace:open-copies": async (message) => ({ stashCopyOpenResult: await openSavedStashCopies(message.items, message.targetWindowId, message.destination, message.duplicateHandling) }),
  "workspace:create-from-selection": async (message) => ({ searchWorkspaceCreationResult: await createWorkspaceFromSearchSelection(message.items, message.targetWindowId, message.name, message.preserveGroups, message.sourceQueries, message.reviewedSelectionToken) }),
  "workspace:preview-search-edit": async (message) => ({ stashSearchEditPreview: await previewStoredStashSearchEdit(message.items, message.operation, message.targetStashId) }),
  "workspace:apply-search-edit": async (message) => ({ stashSearchEditApplyResult: await withLocalOnlySemanticStashMutation(() => applyStoredStashSearchEdit(message.items, message.operation, message.targetStashId, message.reviewedSelectionToken)) }),
  "workspace:undo-search-edit": async (message) => ({ stashSearchEditUndoResult: await withLocalOnlySemanticStashMutation(() => undoStoredStashSearchEdit(message.transactionId)) }),
  "workspace:window-diff": async (message) => ({ stashWorkspaceDiff: await diffLinkedWorkspace(message.stashId) }),
  "workspace:window-save": async (message) => {
    await updateLinkedWorkspace(message.stashId, message.putAway, message.expectedCaptureToken);
  },
  "workspace:window-unlink": async (message) => {
    await detachLinkedWorkspace(message.stashId);
  },
  "workspace:update-metadata": async (message) => {
    await updateSavedStashMetadata(message.stashId, message.name, message.note);
  },
  "workspace:delete": async (message) => {
    await deleteSavedStash(message.stashId);
  },
  "workspace:recover-interrupted": async (message) => {
    await recoverInterruptedStash(message.stashId);
  },
  "workspace:window-close": async (message) => ({ stashWorkspaceParkResult: await parkLinkedWorkspace(message.stashId, { discardChanges: message.discardChanges }) }),
  "workspace:window-focus": async (message) => {
    await focusLinkedWorkspace(message.stashId);
  },
  "workspace:trash-restore": async (message) => {
    await restoreTrashedStash(message.stashId);
  },
  "workspace:trash-purge": async (message) => {
    await purgeTrashedStash(message.stashId);
  },
  "semantic-index:get-state": async () => ({ semanticIndexMeta: await runSemanticIndexMaintenance() }),
  "semantic-index:build": async (message) => ({ semanticIndexMeta: await prepareSemanticIndex(message.targetWindowId) }),
  "semantic-index:resume": async () => ({ semanticIndexMeta: await resumeSemanticIndex() }),
  "semantic-index:cancel": async () => ({ semanticIndexMeta: await cancelSemanticIndex() }),
  "semantic-index:clear": async () => ({ semanticIndexMeta: await clearCurrentSemanticIndex() }),
};

async function dispatchMessage(
  message: WindowCaptureMessage,
  sender: chrome.runtime.MessageSender,
): Promise<DispatchResult | undefined> {
  // Every entry point is extension-internal: reject anything not sent by this
  // extension's own pages before touching state (defense in depth — the
  // manifest declares no externally_connectable or content scripts).
  if (sender.id !== chrome.runtime.id) {
    throw new Error("Messages are accepted only from this extension's own pages.");
  }
  // A matching sender id is not enough on its own: require the sender URL to be
  // one of this extension's own pages. Every sender this extension has (popup,
  // finder, settings) is a page with a URL, so a missing URL is rejected too.
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}/`;
  if (sender.url === undefined || !sender.url.startsWith(extensionOrigin)) {
    throw new Error("Messages are accepted only from this extension's own pages.");
  }
  assertWindowCaptureMessage(message);
  await workerRecoveryPromise;
  // Indexing by the message's own type picks the handler for exactly that
  // message; TypeScript cannot correlate the two, hence the one widening cast.
  const handler = MESSAGE_HANDLERS[message.type] as (message: WindowCaptureMessage) => ReturnType<MessageHandlers[WindowCaptureMessage["type"]]>;
  return (await handler(message)) ?? undefined;
}

// The manifest declares default_popup, so chrome.action.onClicked never fires;
// the popup and the keyboard command are the entry points.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.windowId === undefined) return;
  void (async () => {
    if (info.menuItemId === CONTEXT_MENU_ORGANIZE_SELECTED) {
      await openOrganizerForSelected(tab.windowId);
      return;
    }
    if (info.menuItemId === CONTEXT_MENU_PROTECT_SELECTED) {
      const ids = await selectedTabIds(tab.windowId, tab.id);
      if (ids.length > 0) await protectTabs(tab.windowId, ids, "session");
      return;
    }
    if (
      info.menuItemId === CONTEXT_MENU_LOCK_GROUP &&
      tab.groupId !== undefined &&
      tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
    ) {
      await lockGroups(tab.windowId, [tab.groupId], "session");
      return;
    }
    if (info.menuItemId === CONTEXT_MENU_STASH_GROUP) {
      if (tab.groupId === undefined || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await notifyStashShortcut("Nothing was saved", "This tab is not in a group.");
        return;
      }
      await stashFromShortcut(tab.windowId, { mode: "group", groupId: tab.groupId });
      return;
    }
    if (info.menuItemId === CONTEXT_MENU_STASH_SELECTED) {
      const ids = await selectedTabIds(tab.windowId, tab.id);
      if (ids.length > 0) await stashFromShortcut(tab.windowId, { mode: "selection", tabIds: ids });
    }
  })().catch((error: unknown) => reportBackgroundError(errorText(error, "The menu action failed.")));
});

// Like Spotlight, the finder goes away as soon as focus moves anywhere else:
// another browser window, a tab it brought forward, or another app.
chrome.windows.onFocusChanged.addListener((focusedWindowId) => {
  void chrome.storage.session.get(FINDER_WINDOW_KEY).then(async (stored) => {
    const finderId = stored[FINDER_WINDOW_KEY] as number | undefined;
    if (typeof finderId !== "number" || focusedWindowId === finderId) return;
    await chrome.storage.session.remove([FINDER_WINDOW_KEY, FINDER_VIEW_KEY]);
    await chrome.windows.remove(finderId).catch(() => undefined);
  }).catch(() => undefined);
});

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  if (notificationId.startsWith(AUTO_FILING_NOTIFICATION_PREFIX)) {
    void undoAutoFiling(notificationId.slice(AUTO_FILING_NOTIFICATION_PREFIX.length))
      .then(() => chrome.notifications.clear(notificationId))
      .catch((error: unknown) => reportBackgroundError(errorText(error, "The filing could not be undone.")));
    return;
  }
  if (notificationId !== ORGANIZE_SHORTCUT_NOTIFICATION) return;
  void actOnOrganizeShortcutNotification()
    .catch((error: unknown) => reportBackgroundError(errorText(error, "The notification action failed.")));
});

chrome.commands.onCommand.addListener((command, tab) => {
  void (async () => {
    const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
    if (windowId === undefined) return;
    if (command === "organize-selected-tabs") {
      await openOrganizerForSelected(windowId);
      return;
    }
    if (command === "organize-window") {
      await organizeFromShortcut(windowId);
      return;
    }
    if (command === "search-tabs") {
      await openFinderWindow(windowId, "search");
      return;
    }
    if (command === "protect-selected-tabs") {
      const ids = await selectedTabIds(windowId, tab?.id);
      if (ids.length > 0) await protectTabs(windowId, ids, "session");
      return;
    }
    if (command === "undo-last-organization") {
      const point = await readUndoPoint();
      if (point?.status === "available") await runOrganizationUndo(point.transactionId);
      return;
    }
    if (command === "undo-last-auto-filing") {
      await undoAutoFiling();
      return;
    }
    if (command === "save-and-close-linked-window") {
      await saveAndCloseLinkedWindow(windowId);
    }
  })().catch((error: unknown) => reportBackgroundError(errorText(error, "The keyboard shortcut failed.")));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GENERATED_GROUP_CLEANUP_ALARM) {
    void runGeneratedGroupCleanup("automatic").catch(() => undefined);
    return;
  }
  if (alarm.name === SEMANTIC_INDEX_RESUME_ALARM) {
    void resumeSemanticIndex().catch(() => undefined);
    return;
  }
  if (alarm.name === SEMANTIC_INDEX_MAINTENANCE_ALARM) {
    void runSemanticIndexMaintenance(true).catch(() => undefined);
    return;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[GENERATED_GROUP_CLEANUP_SETTINGS_KEY]) {
    void syncGeneratedGroupCleanupAlarm().catch(() => undefined);
  }
  if (areaName === "local" && changes[AUTO_FILING_LOCAL_KEY]) {
    noteAutoFilingSettingsChanged();
  }
  if (areaName === "local" && changes.organizerLocalState) {
    void runSemanticIndexMaintenance().catch(() => undefined);
  }
  if (areaName === "local" && changes.searchLocalState) {
    void readSearchState().then((state) => {
      if (!state.local.settings.semanticEnabled) return cancelSemanticIndex();
      return runSemanticIndexMaintenance();
    }).catch(() => undefined);
  }
  if (areaName === "local" && changes[STASHES_KEY]) {
    const semanticMutation = changes[STASH_SEMANTIC_MUTATION_KEY]?.newValue as { mode?: unknown } | undefined;
    if (semanticMutation?.mode === "local_only") {
      void reconcileSemanticStashChangesLocally().catch(() => undefined);
    } else {
      scheduleSemanticIndexReconciliation();
    }
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  scheduleSemanticIndexReconciliation();
  scheduleWorkspaceDraft(tab.windowId);
  autoFilingTabCreated(tab);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  autoFilingTabUpdated(tabId, changeInfo, tab);
  if (changeInfo.title !== undefined || changeInfo.url !== undefined || changeInfo.groupId !== undefined) {
    scheduleSemanticIndexReconciliation();
    scheduleWorkspaceDraft(tab.windowId);
  } else if (changeInfo.pinned !== undefined) {
    scheduleWorkspaceDraft(tab.windowId);
  }
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  scheduleSemanticIndexReconciliation();
  autoFilingTabRemoved(tabId, removeInfo.windowId);
  if (removeInfo.isWindowClosing) noteWindowClosing(removeInfo.windowId);
  else scheduleWorkspaceDraft(removeInfo.windowId);
});
chrome.tabs.onMoved.addListener((_tabId, moveInfo) => {
  scheduleSemanticIndexReconciliation();
  scheduleWorkspaceDraft(moveInfo.windowId);
});
chrome.tabs.onAttached.addListener((_tabId, attachInfo) => {
  scheduleSemanticIndexReconciliation();
  scheduleWorkspaceDraft(attachInfo.newWindowId);
});
chrome.tabs.onDetached.addListener((_tabId, detachInfo) => {
  scheduleSemanticIndexReconciliation();
  scheduleWorkspaceDraft(detachInfo.oldWindowId);
});
chrome.tabs.onReplaced.addListener(() => scheduleSemanticIndexReconciliation());
chrome.tabs.onActivated.addListener((info) => autoFilingTabActivated(info));
chrome.tabGroups.onCreated.addListener((group) => {
  scheduleWorkspaceDraft(group.windowId);
});
chrome.tabGroups.onUpdated.addListener((group) => {
  scheduleSemanticIndexReconciliation();
  scheduleWorkspaceDraft(group.windowId);
});
chrome.tabGroups.onMoved.addListener((group) => scheduleWorkspaceDraft(group.windowId));
chrome.tabGroups.onRemoved.addListener((group) => {
  scheduleSemanticIndexReconciliation();
  scheduleWorkspaceDraft(group.windowId);
});

// Lightweight replies skip the view-state read and its serialization; see
// VIEW_STATE_FREE_MESSAGE_TYPES.
async function viewStateFor(message: WindowCaptureMessage): Promise<{ state?: WindowCaptureViewState }> {
  return replyIncludesViewState(message) ? { state: await readWindowCaptureViewState() } : {};
}

chrome.runtime.onMessage.addListener(
  (
    message: WindowCaptureMessage,
    sender,
    // Broad message type: the reply may or may not carry view state.
    sendResponse: (response: WindowCaptureResponseFor<WindowCaptureMessage>) => void,
  ) => {
    void (async () => {
      try {
        const result = await dispatchMessage(message, sender);
        sendResponse({
          ok: true,
          ...await viewStateFor(message),
          ...result,
        });
      } catch (error) {
        // The error must reach the caller even when the view-state read fails
        // too; an unanswered message leaves the UI waiting with no feedback.
        let viewState: Awaited<ReturnType<typeof viewStateFor>> = {};
        try {
          viewState = await viewStateFor(message);
        } catch {
          // Reply with the original error and no state.
        }
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Something went wrong in the extension. Try again.",
          ...viewState,
        });
      }
    })();
    return true;
  },
);

chrome.windows.onRemoved.addListener((windowId) => {
  scheduleSemanticIndexReconciliation(0);
  autoFilingWindowRemoved(windowId);
  void (async () => {
    await commitClosedWorkspaceWindow(windowId).catch(() => undefined);
    const { editor, editorLease } = await readWindowCaptureViewState();
    if (!editor || editor.editorWindowId !== windowId) {
      return;
    }
    if (editorLease?.editorWindowId === windowId) {
      await cancelRequestingProviderJob(
        "editor_closed",
        editorLease.ownerContextId,
      );
      await writeEditorLease(null);
    }
    await writeEditorState({
      ...editor,
      editorWindowId: null,
      lastEditorClosedAt: Date.now(),
      lastEditorClosedWindowId: windowId,
    });
  })().catch(() => undefined);
});

async function markInterruptedRun(): Promise<void> {
  const { transactionRun, editorLease } = await readWindowCaptureViewState();
  if (editorLease) {
    await cancelRequestingProviderJob(
      "owner_lease_expired",
      editorLease.ownerContextId,
    );
    await writeEditorLease(null);
  }
  // Undo is intentionally session-only and does not survive browser startup,
  // extension reload, update, disable, or reinstall boundaries.
  await writeUndoPoint(null);
  const interrupted = interruptActiveTransaction(transactionRun);
  if (interrupted && interrupted !== transactionRun) await writeOrganizationRun(interrupted);
}

async function markWorkerWakeInterruption(): Promise<void> {
  // A fresh worker has no request in flight, so a background job still marked
  // as requesting belonged to a worker the browser stopped.
  const { session } = await readOrganizerState();
  if (session.providerJob?.status === "requesting" && session.providerJob.ownerContextId === BACKGROUND_JOB_OWNER) {
    await writeProviderJob({
      ...session.providerJob,
      status: "failed",
      finishedAt: Date.now(),
      error: "The browser stopped the extension before the plan finished. Nothing moved. Organize again.",
    });
  }
  const { transactionRun } = await readWindowCaptureViewState();
  const interrupted = interruptActiveTransaction(transactionRun);
  if (interrupted && interrupted !== transactionRun) await writeOrganizationRun(interrupted);
}

// Background modes and regression cases were removed, and the run journal is no
// longer stored twice. Drop the retired keys, including the auto-file API key the
// background modes may have saved.
async function removeRetiredStorage(): Promise<void> {
  await Promise.allSettled([
    chrome.storage.local.remove(["autoFileSettings", "autoFileDecisionsPersistentKey", "sanitizedRegressionCases"]),
    chrome.storage.session.remove([
      "autoFileDecisionsApiKey",
      "autoFileRuntime",
      "autoFileSuggestions",
      "autoFileMemory",
      "autoFileUndo",
      "autoFilePendingWindows",
      "suggestModeRuntime",
      "automaticModeRuntime",
      "windowAutomationOverrides",
      // A second copy of the organize run's journal, which nothing read.
      "organizationTransactionJournal",
    ]),
  ]);
}

chrome.runtime.onStartup.addListener(() => {
  void markInterruptedRun().catch(() => undefined);
  scheduleStartupWorkspaceReconciliation();
  installContextMenus();
  void syncGeneratedGroupCleanupAlarm().catch(() => undefined);
  void chrome.alarms.create(SEMANTIC_INDEX_MAINTENANCE_ALARM, { periodInMinutes: 24 * 60 }).catch(() => undefined);
  void runSemanticIndexMaintenance(true).catch(() => undefined);
});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  // A fresh install starts with guided setup; updates and reloads don't.
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    void chrome.tabs.create({ url: chrome.runtime.getURL("action.html?view=setup") }).catch(() => undefined);
  }
  void migrateLegacyWorkspaceStorage().catch(() => undefined);
  void removeRetiredStorage().catch(() => undefined);
  void markInterruptedRun().catch(() => undefined);
  scheduleStartupWorkspaceReconciliation();
  installContextMenus();
  void syncGeneratedGroupCleanupAlarm().catch(() => undefined);
  void chrome.alarms.create(SEMANTIC_INDEX_MAINTENANCE_ALARM, { periodInMinutes: 24 * 60 }).catch(() => undefined);
  void runSemanticIndexMaintenance(true).catch(() => undefined);
});

// A fresh service-worker global while an operation is active means the prior
// worker stopped. Never replay the stored cursor automatically.
