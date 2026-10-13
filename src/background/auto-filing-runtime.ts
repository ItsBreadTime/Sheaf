import {
  decideBatch,
  filingRequest,
  prepareFilingBatch,
  type FilingAction,
  type FilingCandidate,
  type FilingOutcome,
} from "../decision/cascade";
import { MAX_CHAT_OPTIONS } from "../decision/chat-decision-adapter";
import {
  DecisionBackoffError,
  decisionRequestPreview,
  requestDecisions,
  type DecisionConnection,
} from "../decision/decision-client";
import {
  clearFromBacklog,
  markEscalated,
  recordAbstention,
  shouldEscalate,
} from "../decision/escalation";
import { planFilingUndo } from "../decision/filing-log";
import { presetThresholds } from "../decision/filing-policy";
import {
  emptyTabSiteState,
  siteOf,
  triggerFor,
  underRateLimit,
  type TabSiteState,
} from "../decision/filing-triggers";
import { bestEffortDiagnostic, recordAutoFilingDiagnostic } from "../diagnostics/events";
import { UNGROUPED_GROUP_ID } from "../shared/constants";
import type { AutoFilingSettings, FilingLogEntry } from "../shared/auto-filing-types";
import type { OrganizationScope, OrganizerRule } from "../shared/organizer-types";
import type { SemanticWindowState } from "../shared/types";
import type { TabRef } from "../shared/tab-ref";
import {
  calibrationFor,
  forgetEscalationWindow,
  markTabsSticky,
  readAutoFilingSettings,
  readDecisionConnection,
  readFilingLog,
  readStickyTabIds,
  readSuggestion,
  recordFiling,
  removeFilingLogEntry,
  updateEscalationState,
  writeLastDecisionRequest,
  writeSuggestion,
} from "../storage/auto-filing";
import { readOrganizerState, writeOrganizerRules } from "../storage/organizer-state";

/**
 * Auto-filing in the service worker (docs/auto-filing-plan.md): listens for new
 * and navigated tabs, waits for them to settle, batches them per window, runs
 * the cascade, and applies confident decisions one tab at a time with a drift
 * check. It owns no organize state: its own filing log and undo are separate
 * from the organize undo point, and organize always wins a conflict.
 */

export interface AutoFilingHost {
  readWindow(windowId: number): Promise<SemanticWindowState>;
  /** Organize requesting or applying, an undo running, a group-manager apply, or a workspace save. */
  isBusy(): Promise<boolean>;
  /** Runs `task` holding the shared browser-mutation flag; throws when another change holds it. */
  runMutation<T>(task: () => Promise<T>): Promise<T>;
  linkedWorkspaceWindowIds(): Promise<Set<number>>;
  /** The popup's proposal review is open; escalation never interrupts it. */
  reviewOpen(): Promise<boolean>;
  /** Starts an organize run; resolves false when one was already in flight and this call joined it. */
  startOrganize(windowId: number, scope: OrganizationScope): Promise<boolean>;
  reportError(message: string): Promise<void>;
}

export const SETTLE_MS = 1_500;
const MAX_SETTLE_MS = 6_000;
const BUSY_RETRY_MS = 3_000;
const MAX_BUSY_RETRIES = 20;
/** Chrome joins a link opened from a grouped tab to that group within moments of creating it. */
const OPENER_JOIN_WINDOW_MS = 3_000;
const EXPECTED_CHANGE_MS = 5_000;
const TAB_SITES_KEY = "autoFilingTabSites";
const RECENT_FILINGS_KEY = "autoFilingRecentFilings";
/** A batch that hits the per-minute cap retries once the whole window has aged out. */
const RATE_LIMIT_RETRY_MS = 61_000;
export const AUTO_FILING_NOTIFICATION_PREFIX = "auto-filing:";

let host: AutoFilingHost | null = null;

export function installAutoFiling(next: AutoFilingHost): void {
  host = next;
}

function requireHost(): AutoFilingHost {
  if (!host) throw new Error("Auto-filing is not installed.");
  return host;
}

// --- Settings cache ----------------------------------------------------------

let settingsPromise: Promise<AutoFilingSettings> | null = null;

function settings(): Promise<AutoFilingSettings> {
  settingsPromise ??= readAutoFilingSettings().catch((error: unknown) => {
    settingsPromise = null;
    throw error;
  });
  return settingsPromise;
}

export function noteAutoFilingSettingsChanged(): void {
  settingsPromise = null;
  void settings().then((next) => {
    if (!next.enabled) cancelAllQueues();
  }).catch(() => undefined);
}

// --- Per-tab site state ------------------------------------------------------
// Kept in session storage so a worker restart doesn't forget which site a
// grouped tab was on (and so re-ask about every tab).

const tabSites = new Map<number, TabSiteState>();
let tabSitesLoaded: Promise<void> | null = null;
let tabSitesSaveTimer: ReturnType<typeof setTimeout> | null = null;

function loadTabSites(): Promise<void> {
  tabSitesLoaded ??= chrome.storage.session.get(TAB_SITES_KEY).then((values) => {
    const raw = values[TAB_SITES_KEY];
    if (!raw || typeof raw !== "object") return;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const item = value as Partial<TabSiteState> | null;
      if (!item || typeof item !== "object" || tabSites.has(Number(key))) continue;
      tabSites.set(Number(key), {
        site: typeof item.site === "string" ? item.site : null,
        decidedSite: typeof item.decidedSite === "string" ? item.decidedSite : null,
        openerSite: typeof item.openerSite === "string" ? item.openerSite : null,
      });
    }
  }).catch(() => undefined);
  return tabSitesLoaded;
}

function saveTabSitesSoon(): void {
  if (tabSitesSaveTimer) return;
  tabSitesSaveTimer = setTimeout(() => {
    tabSitesSaveTimer = null;
    void chrome.storage.session.set({ [TAB_SITES_KEY]: Object.fromEntries(tabSites) }).catch(() => undefined);
  }, 500);
}

function siteState(tabId: number): TabSiteState {
  let state = tabSites.get(tabId);
  if (!state) {
    state = emptyTabSiteState();
    tabSites.set(tabId, state);
  }
  return state;
}

// --- Filing rate window -------------------------------------------------------
// Session storage, not a plain Map: MV3 kills the worker between navigations, and
// a cap that forgets its own filings on every restart is not a cap.

let recentFilingsLoaded: Promise<void> | null = null;
let recentFilingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

function loadRecentFilings(): Promise<void> {
  recentFilingsLoaded ??= chrome.storage.session.get(RECENT_FILINGS_KEY).then((values) => {
    const raw = values[RECENT_FILINGS_KEY];
    if (!raw || typeof raw !== "object") return;
    const now = Date.now();
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const windowId = Number(key);
      if (!Number.isFinite(windowId) || recentFilings.has(windowId)) continue;
      const times = Array.isArray(value)
        ? value.filter((time): time is number => typeof time === "number" && now - time < 60_000)
        : [];
      if (times.length > 0) recentFilings.set(windowId, times);
    }
  }).catch(() => undefined);
  return recentFilingsLoaded;
}

function saveRecentFilingsSoon(): void {
  if (recentFilingsSaveTimer) return;
  recentFilingsSaveTimer = setTimeout(() => {
    recentFilingsSaveTimer = null;
    const now = Date.now();
    const payload = Object.fromEntries([...recentFilings]
      .map(([windowId, times]) => [windowId, times.filter((time) => now - time < 60_000)] as const)
      .filter(([, times]) => times.length > 0));
    void chrome.storage.session.set({ [RECENT_FILINGS_KEY]: payload }).catch(() => undefined);
  }, 500);
}

// --- Telling our own group changes from the user's ----------------------------

const expectedGroupChanges = new Map<number, { groupIds: Set<number>; until: number }>();
const createdAt = new Map<number, { at: number; openerTabId: number | null }>();

/** A cross-window move passes through "ungrouped" on the way, so one tab can expect several changes. */
function expectGroupChange(tabId: number, ...groupIds: number[]): void {
  const previous = expectedGroupChanges.get(tabId);
  const live = previous && previous.until >= Date.now() ? previous.groupIds : new Set<number>();
  groupIds.forEach((id) => live.add(id));
  expectedGroupChanges.set(tabId, { groupIds: live, until: Date.now() + EXPECTED_CHANGE_MS });
}

// --- Queues ------------------------------------------------------------------

interface WindowQueue {
  tabIds: Set<number>;
  regroup: Set<number>;
  firstQueuedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  busyRetries: number;
  /** Nothing runs before this: the per-minute filing cap is still full. */
  notBefore: number;
}

const queues = new Map<number, WindowQueue>();
const running = new Set<number>();
const recentFilings = new Map<number, number[]>();
/** Cross-window moves of the active tab wait until the user leaves it. */
const pendingCrossWindow = new Map<number, { action: Extract<FilingAction, { kind: "file" | "move" }>; candidate: FilingCandidate }>();

function cancelAllQueues(): void {
  for (const queue of queues.values()) if (queue.timer) clearTimeout(queue.timer);
  queues.clear();
  pendingCrossWindow.clear();
}

function schedule(windowId: number, delayMs: number): void {
  const queue = queues.get(windowId);
  if (!queue) return;
  if (queue.timer) clearTimeout(queue.timer);
  queue.timer = setTimeout(() => {
    queue.timer = null;
    void runWindow(windowId);
  }, delayMs);
}

function enqueue({ tabId, windowId }: TabRef, regroup: boolean): void {
  const queue = queueFor(windowId);
  queue.tabIds.add(tabId);
  if (regroup) queue.regroup.add(tabId);
  else queue.regroup.delete(tabId);
  touch(windowId);
}

function queueFor(windowId: number): WindowQueue {
  let queue = queues.get(windowId);
  if (!queue) {
    queue = { tabIds: new Set(), regroup: new Set(), firstQueuedAt: Date.now(), timer: null, busyRetries: 0, notBefore: 0 };
    queues.set(windowId, queue);
  }
  return queue;
}

/** Single-page apps retitle after load: any change restarts the settle wait, up to a cap. */
function touch(windowId: number): void {
  const queue = queues.get(windowId);
  if (!queue || running.has(windowId)) return;
  const now = Date.now();
  const elapsed = now - queue.firstQueuedAt;
  const settle = Math.max(0, Math.min(SETTLE_MS, MAX_SETTLE_MS - elapsed));
  schedule(windowId, Math.max(settle, queue.notBefore - now));
}

function dequeueTab(tabId: number): void {
  for (const queue of queues.values()) {
    queue.tabIds.delete(tabId);
    queue.regroup.delete(tabId);
  }
}

/** Holds a window's queued tabs back until its per-minute filing cap has room. */
function deferWindow(windowId: number, delayMs: number): void {
  const queue = queueFor(windowId);
  queue.notBefore = Date.now() + delayMs;
  schedule(windowId, delayMs);
}

// --- Event entry points --------------------------------------------------------

async function filingActive(tab: chrome.tabs.Tab): Promise<boolean> {
  if (tab.id === undefined || tab.incognito || tab.pinned) return false;
  const current = await settings().catch(() => null);
  return current?.enabled === true;
}

export function autoFilingTabCreated(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined) return;
  createdAt.set(tab.id, { at: Date.now(), openerTabId: tab.openerTabId ?? null });
  const tabId = tab.id;
  void (async () => {
    await loadTabSites();
    if (!(await filingActive(tab))) return;
    if (tab.groupId !== UNGROUPED_GROUP_ID) await noteOpenerJoin(tabId, tab.groupId);
    observeNavigation(tab, tab.url ?? tab.pendingUrl);
  })().catch(() => undefined);
}

/** A tab Chrome put in its opener's group: decide it as "grouped, site changed" once its site differs. */
async function noteOpenerJoin(tabId: number, groupId: number): Promise<boolean> {
  const created = createdAt.get(tabId);
  if (!created || created.openerTabId === null || Date.now() - created.at > OPENER_JOIN_WINDOW_MS) return false;
  const opener = await chrome.tabs.get(created.openerTabId).catch(() => null);
  if (!opener || opener.groupId !== groupId) return false;
  const state = siteState(tabId);
  state.openerSite = siteOf(opener.url) ?? state.openerSite;
  saveTabSitesSoon();
  return true;
}

function observeNavigation(tab: chrome.tabs.Tab, url: string | undefined): void {
  if (tab.id === undefined) return;
  const site = siteOf(url);
  if (!site) return;
  const state = siteState(tab.id);
  const trigger = triggerFor(state, tab.groupId !== UNGROUPED_GROUP_ID, site);
  state.site = site;
  saveTabSitesSoon();
  if (trigger) enqueue({ tabId: tab.id, windowId: tab.windowId }, trigger === "regroup");
}

export function autoFilingTabUpdated(tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void {
  void (async () => {
    await loadTabSites();
    if (change.groupId !== undefined) await observeGroupChange(tabId, change.groupId, tab);
    if (!(await filingActive(tab))) return;
    if (change.url !== undefined) {
      pendingCrossWindow.delete(tabId);
      observeNavigation(tab, change.url);
    } else if (change.status === "complete") {
      observeNavigation(tab, tab.url);
    }
    if (change.title !== undefined && queues.get(tab.windowId)?.tabIds.has(tabId)) touch(tab.windowId);
  })().catch(() => undefined);
}

/**
 * Any group change that wasn't made by filing, organize, undo, a workspace, or
 * Chrome's opener join is the user's own placement: that tab is never
 * auto-moved again this session.
 */
async function observeGroupChange(tabId: number, groupId: number, tab: chrome.tabs.Tab): Promise<void> {
  const expected = expectedGroupChanges.get(tabId);
  if (expected && expected.until >= Date.now() && expected.groupIds.has(groupId)) return;
  if (!(await filingActive(tab))) return;
  if (groupId !== UNGROUPED_GROUP_ID && await noteOpenerJoin(tabId, groupId)) {
    // Chrome joined it; if it already left the opener's site, decide it now.
    observeNavigation(tab, tab.url);
    return;
  }
  if (host && await host.isBusy()) return;
  siteState(tabId).openerSite = null;
  dequeueTab(tabId);
  pendingCrossWindow.delete(tabId);
  await markTabsSticky([tabId]);
}

export function autoFilingTabActivated(info: chrome.tabs.OnActivatedInfo): void {
  for (const [tabId, pending] of [...pendingCrossWindow]) {
    if (pending.candidate.windowId !== info.windowId || tabId === info.tabId) continue;
    pendingCrossWindow.delete(tabId);
    void applyAndRecord(pending.action, pending.candidate).catch(() => undefined);
  }
}

export function autoFilingTabRemoved(tabId: number, windowId: number): void {
  tabSites.delete(tabId);
  createdAt.delete(tabId);
  expectedGroupChanges.delete(tabId);
  pendingCrossWindow.delete(tabId);
  dequeueTab(tabId);
  saveTabSitesSoon();
  void updateEscalationState(windowId, (state) => clearFromBacklog(state, tabId)).catch(() => undefined);
}

export function autoFilingWindowRemoved(windowId: number): void {
  const queue = queues.get(windowId);
  if (queue?.timer) clearTimeout(queue.timer);
  queues.delete(windowId);
  // This window's filings are dropped from the persisted window as well. Loading
  // first matters on a cold worker, which is how `windows.onRemoved` usually finds
  // it: the in-memory map is empty then, and saving it as-is would erase every
  // other window's filings instead of just this one's.
  void loadRecentFilings().then(() => {
    recentFilings.delete(windowId);
    saveRecentFilingsSoon();
  });
  // A cross-window move waits for the user to leave the tab; once the window it
  // was headed for is gone, the move can never be applied.
  for (const [tabId, pending] of [...pendingCrossWindow]) {
    if (pending.candidate.windowId === windowId) pendingCrossWindow.delete(tabId);
  }
  void forgetEscalationWindow(windowId).catch(() => undefined);
  void readSuggestion().then((suggestion) => {
    if (suggestion?.windowId === windowId) return dismissAutoFilingSuggestion();
  }).catch(() => undefined);
}

// --- A batch ---------------------------------------------------------------------

async function otherWindows(sourceWindowId: number, linked: ReadonlySet<number>): Promise<SemanticWindowState[]> {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const states = await Promise.all(windows.map(async (window) => {
    if (window.id === undefined || window.incognito || window.id === sourceWindowId || linked.has(window.id)) return null;
    return requireHost().readWindow(window.id).catch(() => null);
  }));
  return states.filter((state): state is SemanticWindowState => state !== null);
}

function confidenceBucket(value: number): string {
  if (value >= 0.95) return "0.95+";
  if (value >= 0.9) return "0.90-0.95";
  if (value >= 0.8) return "0.80-0.90";
  return "<0.80";
}

async function runWindow(windowId: number): Promise<void> {
  const queue = queues.get(windowId);
  if (!queue || running.has(windowId)) return;
  const runtime = requireHost();
  const current = await settings().catch(() => null);
  if (!current?.enabled) {
    queues.delete(windowId);
    return;
  }
  if (await runtime.isBusy()) {
    // Organize always wins: wait for it rather than racing it.
    queue.busyRetries += 1;
    if (queue.busyRetries > MAX_BUSY_RETRIES) queues.delete(windowId);
    else schedule(windowId, BUSY_RETRY_MS);
    return;
  }
  queues.delete(windowId);
  running.add(windowId);
  try {
    await runBatch(windowId, queue, current);
  } catch (error) {
    await bestEffortDiagnostic(() => recordAutoFilingDiagnostic({
      failed: true,
      detail: error instanceof Error ? error.message : "Auto-filing failed.",
      durationMs: null,
      model: null,
    }));
  } finally {
    running.delete(windowId);
    // Tabs that changed while this batch ran wait their own settle time.
    if (queues.has(windowId)) touch(windowId);
  }
}

async function runBatch(windowId: number, queue: WindowQueue, current: AutoFilingSettings): Promise<void> {
  const runtime = requireHost();
  await loadRecentFilings();
  const linked = await runtime.linkedWorkspaceWindowIds();
  // A move in a linked workspace window would silently change a saved workspace.
  if (linked.has(windowId)) return;
  const source = await runtime.readWindow(windowId).catch(() => null);
  if (!source) return;
  const sticky = await readStickyTabIds();
  const tabIds = [...queue.tabIds].filter((id) => !sticky.has(id));
  if (tabIds.length === 0) return;
  const organizer = await readOrganizerState();
  const connection = await readDecisionConnection(organizer);
  const calibration = connection ? calibrationFor(current, connection) : null;
  const thresholds = presetThresholds(current.confidence, calibration?.thresholds ?? null);
  const prepared = prepareFilingBatch({
    source,
    otherWindows: current.crossWindow ? await otherWindows(windowId, linked) : [],
    tabIds,
    regroupTabIds: queue.regroup,
    privacy: organizer.local.privacy,
    rules: organizer.local.organizerRules,
    optedOutGroupTitles: current.optedOutGroupTitles,
    refileGroupedTabs: current.refileGroupedTabs,
    askReorganize: current.escalation !== "off",
    maxOptions: connection?.protocol === "chat" ? MAX_CHAT_OPTIONS : 255,
    style: calibration?.style ?? "text",
  });
  const request = connection ? filingRequest(prepared) : null;
  let answers = null;
  let latencyMs: number | null = null;
  if (request && connection) {
    const sent = {
      at: Date.now(),
      protocol: connection.protocol,
      body: decisionRequestPreview(connection, request),
      model: connection.model,
      request,
    };
    await writeLastDecisionRequest(sent);
    try {
      const result = await requestDecisions(connection, request);
      answers = result.answers;
      latencyMs = result.latencyMs;
      await writeLastDecisionRequest({ ...sent, outcome: { status: "answered", answers: result.answers, latencyMs: result.latencyMs } });
    } catch (error) {
      await writeLastDecisionRequest({
        ...sent,
        outcome: { status: "failed", error: error instanceof Error ? error.message : "The decision model failed." },
      });
      if (error instanceof DecisionBackoffError) {
        // The provider asked for a pause: these tabs are asked again afterwards, not dropped.
        for (const candidate of prepared.candidates) enqueue({ tabId: candidate.tabId, windowId }, queue.regroup.has(candidate.tabId));
        schedule(windowId, error.delayMs);
        return;
      }
      await bestEffortDiagnostic(() => recordAutoFilingDiagnostic({
        failed: true,
        detail: error instanceof Error ? error.message : "The decision model failed.",
        durationMs: null,
        model: connection.model,
      }));
    }
  }
  const outcome = decideBatch(prepared, answers, thresholds);
  // Every tab asked about is decided for its current site, filed or not: a
  // borderline tab is never asked again until it goes to another site.
  for (const candidate of prepared.candidates) siteState(candidate.tabId).decidedSite = candidate.site;
  for (const action of prepared.ruleActions) {
    const tab = source.tabs.find((item) => item.id === action.tabId);
    if (tab) siteState(action.tabId).decidedSite = siteOf(tab.url);
  }
  for (const id of tabIds) siteState(id).openerSite = null;
  saveTabSitesSoon();
  const filed = await applyOutcome(outcome, prepared.candidates, source, current);
  await escalate(windowId, source, outcome, filed, current);
  await bestEffortDiagnostic(() => recordAutoFilingDiagnostic({
    failed: false,
    detail: [
      `tier=${request && connection ? "decision_model" : "rule"}`,
      `asked=${prepared.candidates.length}`,
      `rule=${prepared.ruleActions.length}`,
      `applied=${filed.length}`,
      `abstained=${outcome.abstainedUngrouped.length + outcome.abstainedGrouped.length}`,
      `skipped=${prepared.skipped.length}`,
      ...(outcome.reasons.length ? [`reasons=${[...new Set(outcome.reasons)].join("+")}`] : []),
      ...outcome.actions.map((action) => `confidence=${confidenceBucket(action.confidence)}`),
    ].join(" "),
    durationMs: latencyMs,
    model: connection?.model ?? null,
  }));
}

function candidateFor(action: FilingAction, candidates: readonly FilingCandidate[], source: SemanticWindowState): FilingCandidate | null {
  const known = candidates.find((candidate) => candidate.tabId === action.tabId);
  if (known) return known;
  const tab = source.tabs.find((item) => item.id === action.tabId);
  if (!tab) return null;
  return {
    key: "",
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId === UNGROUPED_GROUP_ID ? null : tab.groupId,
    index: tab.index,
    url: tab.url,
    title: tab.title,
    site: siteOf(tab.url) ?? "",
    currentGroupKey: null,
    blockedGroupTitles: [],
  };
}

async function applyOutcome(
  outcome: FilingOutcome,
  candidates: readonly FilingCandidate[],
  source: SemanticWindowState,
  current: AutoFilingSettings,
): Promise<number[]> {
  const filed: number[] = [];
  for (const [index, action] of outcome.actions.entries()) {
    const candidate = candidateFor(action, candidates, source);
    if (!candidate) continue;
    const times = recentFilings.get(candidate.windowId) ?? [];
    // A backstop against loops and hostile pages. The decisions the cap blocks are
    // kept and asked again once the minute is up; dropping them silently lost work
    // the user never saw and left no trace in the log.
    if (!underRateLimit(times, Date.now(), current.maxFilingsPerWindowPerMinute)) {
      const deferred = outcome.actions.slice(index).flatMap((remaining) => {
        const blocked = candidateFor(remaining, candidates, source);
        return blocked ? [blocked] : [];
      });
      for (const item of deferred) enqueue(item, item.groupId !== null);
      deferWindow(source.windowId, RATE_LIMIT_RETRY_MS);
      await bestEffortDiagnostic(() => recordAutoFilingDiagnostic({
        failed: false,
        detail: `rate_limited=${deferred.length} retry_in=${RATE_LIMIT_RETRY_MS}ms`,
        durationMs: null,
        model: null,
      }));
      break;
    }
    if (action.kind !== "ungroup" && action.crossWindow) {
      const live = await chrome.tabs.get(action.tabId).catch(() => null);
      // Never take the page away while the user is on it; it moves once they leave.
      if (live?.active) {
        pendingCrossWindow.set(action.tabId, { action, candidate });
        continue;
      }
    }
    if (await applyAndRecord(action, candidate)) filed.push(action.tabId);
  }
  return filed;
}

async function groupTitle(groupId: number | null): Promise<string | null> {
  if (groupId === null) return null;
  return (await chrome.tabGroups.get(groupId).catch(() => null))?.title ?? null;
}

/** Applies one decision under the shared mutation flag, after a drift check, and records it. */
async function applyAndRecord(action: FilingAction, candidate: FilingCandidate): Promise<boolean> {
  const runtime = requireHost();
  let entry: FilingLogEntry | null = null;
  try {
    entry = await runtime.runMutation(() => applyFiling(action, candidate));
  } catch {
    return false;
  }
  if (!entry) return false;
  const times = (recentFilings.get(candidate.windowId) ?? []).filter((time) => Date.now() - time < 60_000);
  recentFilings.set(candidate.windowId, [...times, entry.at]);
  saveRecentFilingsSoon();
  await recordFiling(entry);
  await updateEscalationState(candidate.windowId, (state) => clearFromBacklog(state, action.tabId));
  const current = await settings().catch(() => null);
  if (current?.notifyOnFiling) await notifyFiling(entry);
  return true;
}

async function applyFiling(action: FilingAction, candidate: FilingCandidate): Promise<FilingLogEntry | null> {
  const tab = await chrome.tabs.get(action.tabId).catch(() => null);
  const liveGroup = tab && tab.groupId !== UNGROUPED_GROUP_ID ? tab.groupId : null;
  // Drift: the tab must be exactly where and what it was when the decision was made.
  if (!tab || tab.windowId !== candidate.windowId || liveGroup !== action.fromGroupId ||
    tab.url !== candidate.url || tab.title !== candidate.title || tab.pinned) return null;
  const fromGroupTitle = await groupTitle(action.fromGroupId);
  if (action.kind === "ungroup") {
    expectGroupChange(action.tabId, UNGROUPED_GROUP_ID);
    await chrome.tabs.ungroup(action.tabId);
    // Placed just after the group it left.
    const members = await chrome.tabs.query({ windowId: candidate.windowId, groupId: action.fromGroupId });
    const lastIndex = Math.max(-1, ...members.map((member) => member.index));
    const moved = await chrome.tabs.get(action.tabId);
    if (lastIndex >= 0 && moved.index < lastIndex) await chrome.tabs.move(action.tabId, { index: lastIndex });
    const verified = await chrome.tabs.get(action.tabId).catch(() => null);
    if (verified?.groupId !== UNGROUPED_GROUP_ID) return null;
    return logEntry(action, candidate, tab, null, fromGroupTitle, null, verified.windowId);
  }
  const target = await chrome.tabGroups.get(action.target.groupId).catch(() => null);
  if (!target || target.windowId !== action.target.windowId || (target.title ?? "") !== action.target.title) return null;
  // Only a cross-window move passes through "ungrouped"; otherwise the user
  // pulling the tab straight back out must still count as their own choice.
  expectGroupChange(action.tabId, ...(action.crossWindow ? [target.id, UNGROUPED_GROUP_ID] : [target.id]));
  if (action.crossWindow) {
    await chrome.tabs.move(action.tabId, { windowId: target.windowId, index: -1 });
  }
  await chrome.tabs.group({ tabIds: [action.tabId], groupId: target.id });
  const verified = await chrome.tabs.get(action.tabId).catch(() => null);
  if (verified?.groupId !== target.id) return null;
  return logEntry(action, candidate, tab, target.id, fromGroupTitle, target.title ?? "", verified.windowId);
}

function logEntry(
  action: FilingAction,
  candidate: FilingCandidate,
  tab: chrome.tabs.Tab,
  toGroupId: number | null,
  fromGroupTitle: string | null,
  toGroupTitle: string | null,
  windowId: number,
): FilingLogEntry {
  return {
    id: crypto.randomUUID(),
    tabId: action.tabId,
    windowId,
    fromGroupId: action.fromGroupId,
    toGroupId,
    previousIndex: tab.index,
    ...(windowId !== candidate.windowId ? { previousWindowId: candidate.windowId } : {}),
    source: action.source,
    confidence: action.confidence,
    at: Date.now(),
    tabTitle: tab.title ?? "",
    site: candidate.site,
    fromGroupTitle,
    toGroupTitle,
  };
}

async function notifyFiling(entry: FilingLogEntry): Promise<void> {
  try {
    await chrome.notifications.create(`${AUTO_FILING_NOTIFICATION_PREFIX}${entry.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: entry.toGroupTitle === null ? "Tab left its group" : `Filed into ${entry.toGroupTitle || "a group"}`,
      message: entry.tabTitle || entry.site,
      buttons: [{ title: "Undo" }],
      silent: true,
    });
  } catch {
    // Notifications can be blocked at the OS level; the filing log still has Undo.
  }
}

// --- Escalation -------------------------------------------------------------------

async function escalate(
  windowId: number,
  source: SemanticWindowState,
  outcome: FilingOutcome,
  filed: readonly number[],
  current: AutoFilingSettings,
): Promise<void> {
  const ungrouped = new Set(source.tabs.filter((tab) => tab.groupId === UNGROUPED_GROUP_ID).map((tab) => tab.id));
  const state = await updateEscalationState(windowId, (previous) => {
    let next = { ...previous, backlog: previous.backlog.filter((id) => ungrouped.has(id)) };
    for (const id of filed) next = clearFromBacklog(next, id);
    for (const id of outcome.abstainedUngrouped) if (!filed.includes(id)) next = recordAbstention(next, id);
    return next;
  });
  if (current.escalation === "off") return;
  const runtime = requireHost();
  const now = Date.now();
  if (!shouldEscalate(state, { now, reorganize: outcome.reorganize, reviewOpen: await runtime.reviewOpen() })) return;
  const count = state.backlog.length;
  if (current.escalation === "suggest") {
    await updateEscalationState(windowId, () => markEscalated(now));
    await writeSuggestion({ windowId, ungroupedCount: count, at: now });
    await chrome.action.setBadgeText({ text: String(count) }).catch(() => undefined);
    await chrome.action.setTitle({ title: `${count} ungrouped tabs don't fit your groups. Organize?` }).catch(() => undefined);
    return;
  }
  let started = false;
  try {
    started = await runtime.startOrganize(windowId, current.escalationWholeWindow ? { mode: "window" } : { mode: "ungrouped" });
  } catch (error) {
    await runtime.reportError(error instanceof Error ? error.message : "Automatic organize could not start.");
  }
  // Consume the escalation only when a run actually started. A start that
  // joined an in-flight run, or failed, must leave the backlog and the cooldown
  // intact so the next batch can escalate.
  if (started) await updateEscalationState(windowId, () => markEscalated(now));
}

export async function dismissAutoFilingSuggestion(): Promise<void> {
  await writeSuggestion(null);
  await chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
  await chrome.action.setTitle({ title: "Organize current window" }).catch(() => undefined);
}

/** "Organize?" from the popup or badge: the normal organize run, ungrouped tabs only. */
export async function acceptAutoFilingSuggestion(): Promise<void> {
  const suggestion = await readSuggestion();
  if (!suggestion) throw new Error("There is no organize suggestion right now.");
  await dismissAutoFilingSuggestion();
  await requireHost().startOrganize(suggestion.windowId, { mode: "ungrouped" });
}

// --- Undo -----------------------------------------------------------------------

export interface FilingUndoResult {
  restored: boolean;
  message: string;
}

/** Undoes one filing (the latest when `entryId` is omitted), only if the tab is still where filing put it. */
export async function undoAutoFiling(entryId?: string): Promise<FilingUndoResult> {
  const log = await readFilingLog();
  const entry = entryId ? log.find((item) => item.id === entryId) : log[0];
  if (!entry) return { restored: false, message: "There is no auto-filing to undo." };
  const runtime = requireHost();
  const result = await runtime.runMutation(async (): Promise<FilingUndoResult> => {
    const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
    const live = tab && tab.id !== undefined
      ? { windowId: tab.windowId, groupId: tab.groupId === UNGROUPED_GROUP_ID ? null : tab.groupId }
      : null;
    const homeWindowId = entry.previousWindowId ?? entry.windowId;
    const groups = await chrome.tabGroups.query({ windowId: homeWindowId }).catch(() => []);
    const plan = planFilingUndo(entry, live, new Set(groups.map((group) => group.id)));
    if (plan.action === "skip") {
      return {
        restored: false,
        message: plan.reason === "tab_closed" ? "That tab is closed." : "That tab has moved since it was filed, so it was left where it is.",
      };
    }
    expectGroupChange(plan.tabId, UNGROUPED_GROUP_ID);
    if (tab?.windowId !== plan.windowId) {
      await chrome.tabs.move(plan.tabId, { windowId: plan.windowId, index: plan.index });
    }
    if (plan.action === "restore") {
      expectGroupChange(plan.tabId, plan.groupId ?? UNGROUPED_GROUP_ID);
      await chrome.tabs.group({ tabIds: [plan.tabId], groupId: plan.groupId ?? undefined });
      const members = await chrome.tabs.query({ windowId: plan.windowId, groupId: plan.groupId ?? undefined });
      const indexes = members.map((member) => member.index);
      // Back to its old slot only when that slot is inside the group, so the move can't pull it out.
      if (indexes.length > 0 && plan.index >= Math.min(...indexes) && plan.index <= Math.max(...indexes)) {
        await chrome.tabs.move(plan.tabId, { index: plan.index });
      }
      return { restored: true, message: `Moved back to ${entry.fromGroupTitle || "its group"}.` };
    }
    expectGroupChange(plan.tabId, UNGROUPED_GROUP_ID);
    if (live?.groupId !== null) await chrome.tabs.ungroup(plan.tabId);
    await chrome.tabs.move(plan.tabId, { index: plan.index });
    return {
      restored: true,
      message: entry.fromGroupId !== null ? "Its original group is gone, so the tab was left ungrouped." : "Moved back out of the group.",
    };
  });
  // Undone or not, the user has spoken about this tab.
  await markTabsSticky([entry.tabId]);
  await removeFilingLogEntry(entry.id);
  return result;
}

/** "Don't file <site> into <group>": a filing-only rule; organize is unaffected. */
export async function neverFileFromEntry(entryId: string): Promise<string> {
  const log = await readFilingLog();
  const entry = log.find((item) => item.id === entryId);
  if (!entry?.site) throw new Error("That filing is no longer in the list.");
  const organizer = await readOrganizerState();
  const locationPattern = `${entry.site}/*`;
  const rule: OrganizerRule = entry.toGroupTitle
    ? { id: crypto.randomUUID(), kind: "never_file_location", locationPattern, groupName: entry.toGroupTitle }
    : { id: crypto.randomUUID(), kind: "never_file_location", locationPattern };
  const exists = organizer.local.organizerRules.some((item) =>
    item.kind === "never_file_location" && item.locationPattern === locationPattern &&
    (item.groupName ?? "").toLocaleLowerCase() === (entry.toGroupTitle ?? "").toLocaleLowerCase());
  if (!exists) await writeOrganizerRules([...organizer.local.organizerRules, rule]);
  return entry.toGroupTitle ? `${entry.site} won't be filed into ${entry.toGroupTitle} again.` : `${entry.site} won't be auto-filed again.`;
}

/** Test seam: drops in-memory state between cases. */
export function resetAutoFilingRuntimeForTests(): void {
  cancelAllQueues();
  tabSites.clear();
  tabSitesLoaded = null;
  expectedGroupChanges.clear();
  createdAt.clear();
  recentFilings.clear();
  recentFilingsLoaded = null;
  if (recentFilingsSaveTimer) {
    clearTimeout(recentFilingsSaveTimer);
    recentFilingsSaveTimer = null;
  }
  running.clear();
  settingsPromise = null;
  host = null;
}

export type { DecisionConnection };
