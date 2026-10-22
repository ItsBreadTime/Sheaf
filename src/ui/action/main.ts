import "../shared/tokens.css";
import "./styles.css";
import {
  bestEffortDiagnostic,
  recordOperationalDiagnostic,
} from "../../diagnostics/events";
import { buildTabStashPreview } from "../../browser/tab-stashes";
import { protectionLocation } from "../../browser/user-protection";
import {
  cleanupSuggestionFilterCounts,
  cleanupSuggestionMatchesFilter,
  findCleanupSuggestions,
  type CleanupSuggestion,
  type CleanupSuggestionFilter,
} from "../../browser/cleanup-suggestions";
import { checkProposalDrift, quotedTabTitle } from "../../browser/drift-check";
import {
  acknowledgeSignalDrift,
  applyDriftCheckResult,
  confirmProposalReview,
  moveProposedTab,
  recolorProposedGroup,
  renameProposedGroup,
} from "../../organizer/proposal-editor";
import {
  buildProposalDiff,
  changedProposalGroups,
  describeUngroupedCoverage,
  type ProposalGroupChangeKind,
} from "../../organizer/proposal-diff";
import { historyCoverageFacts } from "../../organizer/history-coverage";
import {
  renderGroupManager,
  cancelGroupSemanticSearch,
  cancelGroupMemberSemanticSearch,
  refreshGroupManagerState,
  groupManagerSnapshot,
  stashedGroupCount,
  groupSemanticSearchPending,
  groupMemberSemanticSearchPending,
  type GroupManagerPanelContext,
} from "./group-manager-ui";
import {
  renderTabSearch,
  refreshSearchSnapshots,
  cancelSemanticSearch,
  closableBlankTabs,
  setTabSearchPanelContext,
  setSearchScope,
  setSearchAutofocusPending,
  resetSearchSelection,
  semanticSearchPending,
  redrawSearchPanel,
  clearSearchRedraw,
  clearSearchFailureGate,
  semanticSearchAvailability,
  type TabSearchPanelContext,
} from "./tab-search-ui";
import { renderSettings, setSettingsPanelContext } from "./settings-ui";
import { renderSetup } from "./setup-ui";
import { markSettingsError, markSettingsSaving, trackSettingsSave } from "./settings-save-status";
import { providerLinkRow, renderProviderConnection, resolveApiKey, type ConnectionStatus } from "./provider-connection-ui";
import { popupState } from "./popup-store";
import {
  loadStashExtras,
  renderStashes,
  restoreStash,
  stashStatusLabel,
  setStashPanelContext,
  disarmStashDelete,
  revealStash,
  type StashPanelContext,
} from "./stash-ui";
import {
  autoFilingStorageChanged,
  autoFilingView,
  loadAutoFilingView,
  renderAutoFilingSuggestion,
  renderRecentlyFiled,
  setAutoFilingEnabled,
  setAutoFilingPanelContext,
} from "./auto-filing-ui";
import { writeAutoFilingSettings, writeDecisionModel } from "../../storage/auto-filing";
import {
  handleUsageStorageChange,
  loadUsageStats,
  setUsagePanelContext,
} from "./usage-ui";
import { installUsageRecorder } from "../../storage/usage-stats";
import {
  currentProviderConfig as currentProviderConfigFromState,
  element,
  send,
  isProviderReady,
  privacyLevelCaveat,
} from "../shared/helpers";
import {
  normalizeOrganizationScope,
  organizationScopeLabel,
  WHOLE_WINDOW_SCOPE,
} from "../../organizer/scope";
import { describeOrganizerRule, locationMatchesPattern } from "../../organizer/rules";
import { buildSanitizedRequest } from "../../privacy/request-builder";
import {
  normalizeDomainRule,
  normalizeDomainRules,
} from "../../privacy/domain-policy";
import { testProviderConnection } from "../../provider/connection-test";
import { describeEmbeddingTestFailure } from "../../provider/provider-errors";
import {
  normalizeProviderConfig,
  normalizeProviderEndpoint,
} from "../../provider/request-policy";
import { ORGANIZATION_TRANSACTION, PROPOSAL_REVIEW } from "../../shared/constants";
import { LIMITS } from "../../shared/limits";
import {
  CHROME_GROUP_COLORS,
  type ChromeGroupColor,
} from "../../shared/group-colors";
import type {
  ImmutableRequestBundle,
  GroupNamePreference,
  OrganizationScope,
  OpenAICompatibleConfig,
  OrganizerRule,
  OrganizerStoredState,
  PrivacySettings,
  ProviderJobResult,
} from "../../shared/organizer-types";
import type { ProposalReviewState } from "../../shared/proposal-review-types";
import type { OrganizationHistoryReport } from "../../shared/transaction-types";
import type {
  DiagnosticEvent,
  DiagnosticsState,
} from "../../shared/diagnostics-types";
import type {
  UserProtectionState,
} from "../../shared/protection-types";
import type { SettingsImportPlan } from "../../storage/settings-backup";
import { EMPTY_SEMANTIC_INDEX_META } from "../../shared/semantic-index-types";
import type { OrganizationRun, SemanticTab, SemanticWindowState } from "../../shared/types";
import type { StatefulWindowCaptureMessage } from "../../shared/message-state";
import type {
  GeneratedGroupAutoCleanupDays,
  GeneratedGroupCleanupSummary,
  GroupManagerGroup,
} from "../../shared/group-manager-types";
import {
  clearProviderJob,
  readOrganizerState,
  writeConnectionTest,
  writeCustomOrganizerPrompt,
  writeGroupNamePreferences,
  writeImmutableRequest,
  writeOrganizerRules,
  writePrivacySettings,
  writeProviderJob,
  writeProviderSettings,
  writeWorkflowSettings,
} from "../../storage/organizer-state";
import { createSettingsBackup, parseSettingsBackup } from "../../storage/settings-backup";
import {
  readProposalReview,
  writeProposalReview,
} from "../../storage/proposal-review";
import { readCountsOnlyHistory } from "../../storage/organization-history";
import { totalTabsMoved } from "../../organizer/history-changes";
import { BACKGROUND_JOB_OWNER, takeBackgroundError } from "../../storage/background-error";
import { readUserProtectionState } from "../../storage/protection";
import {
  clearDiagnosticEvents,
  DEFAULT_DIAGNOSTIC_PRICING,
  readDiagnosticsState,
  writeDiagnosticPricing,
} from "../../storage/diagnostics";
import {
  readTabStashes,
  readTabStashSettings,
  writeTabStashes,
} from "../../storage/stashes";
import { readIgnoredCleanupTabIds } from "../../storage/cleanup";
import {
  DEFAULT_EMBEDDING_CONFIG,
  readSearchState,
  writeEmbeddingProvider,
  writeEmbeddingProviderTest,
  writeSearchSettings,
} from "../../storage/search";
import { readSemanticIndexMeta } from "../../storage/semantic-index";
import { applyViewStateStorageChanges, readWindowCaptureViewState } from "../../storage/session";
import { OpenAICompatibleEmbeddingClient } from "../../search/embedding-client";
import { normalizeEmbeddingConfig } from "../../search/embedding-config";
import type { SearchableTab } from "../../search/direct-search";
import { detectedEmbeddingProfileId } from "../../search/model-profiles";
import { normalizeEmbeddingProfileId } from "../../search/embedding-config";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Action root is missing.");
const actionRoot = root;
const pageParams = new URLSearchParams(location.search);
const fullPageView = pageParams.get("view");
const fullSettingsPage = fullPageView === "settings";
const diagnosticsPage = fullPageView === "diagnostics";
// First-run setup: a full page that opens on install and from the popup.
const setupPage = fullPageView === "setup";
const fullExtensionPage = fullSettingsPage || diagnosticsPage || setupPage;
// Absent means "the window this page is in"; Number(null) would be window 0.
const requestedTargetWindowId = pageParams.has("window") ? Number(pageParams.get("window")) : Number.NaN;
// The popup UI in its own small window, opened from the organize notification
// to review a plan for the browser window named in the URL.
const floatingPage = !fullExtensionPage && pageParams.get("floating") === "1";
document.documentElement.classList.toggle("full-settings-page", fullExtensionPage);
document.body.classList.toggle("full-settings-page", fullExtensionPage);
document.documentElement.classList.toggle("floating-window", floatingPage);
document.body.classList.toggle("floating-window", floatingPage);

const ownerContextId = crypto.randomUUID();
let fieldSequence = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatRecovery: Promise<void> | null = null;
let busyAction: string | null = "initial";
let protectionOpen = false;
const UTILITY_DRAWER_ID = "sheaf-utility-drawer";
let semanticIndexPollTimer: ReturnType<typeof setTimeout> | null = null;
let semanticIndexClearArmed = false;
let historyOpen = false;
let organizationHistory: OrganizationHistoryReport[] = [];
let generatedGroupCleanupSummary: GeneratedGroupCleanupSummary | null = null;
let generatedGroupClearArmed = false;
let requestPreviewMode: "readable" | "json" = "readable";
let settingsImportPlan: SettingsImportPlan | null = null;
let diagnosticsState: DiagnosticsState = {
  pricing: { ...DEFAULT_DIAGNOSTIC_PRICING },
  events: [],
};
let diagnosticClearArmed = false;
const groupManagerPanelContext: GroupManagerPanelContext = {
  element,
  input,
  field,
  button,
  formatCount,
  lineIcon,
  utilityNavIcon,
  groupManagerIconButton,
  stashStatusLabel,
  restoreStash,
  send,
  perform,
  redraw: redrawUtilityDrawer,
  actionRoot: () => actionRoot,
  semanticSearchAvailability: (scope) => semanticSearchAvailability(popupState.searchState, scope, popupState.semanticIndexMeta, popupState.targetWindowId),
  groupHasUserProtection,
  openProtectionManager,
  protectGroupFromManager,
};
const tabSearchPanelContext: TabSearchPanelContext = {
  element,
  input,
  field,
  button,
  formatCount,
  iconButton: groupManagerIconButton,
  send,
  perform,
  render,
  redraw: redrawUtilityDrawer,
  actionRoot: () => actionRoot,
  revealStashFromSearch: (stashId) => {
    popupState.searchOpen = false;
    popupState.stashesOpen = true;
    popupState.groupsOpen = false;
    revealStash(stashId);
  },
  openAdvancedSettings,
  semanticSearchFailureLabel,
  searchTabUserProtectionReasons,
  protectSearchTab,
  openProtectionManager,
  check,
  semanticIndexRetryDetail,
  buildSemanticIndex,
  cancelSemanticIndexBuild,
  semanticIndexBuildRequirement,
};
const stashPanelContext: StashPanelContext = {
  element,
  input,
  field,
  button,
  formatCount,
  showTooltip: showStashTabTooltip,
  hideTooltip: hideStashTabTooltip,
  send,
  perform,
  render,
  redraw: redrawUtilityDrawer,
};
setStashPanelContext(stashPanelContext);
setAutoFilingPanelContext({
  input,
  field,
  check,
  button,
  settingsSummary,
  settingsEditChip,
  advancedDisclosure,
  lineIcon,
  perform,
  render,
  organizeUngrouped: () => {
    organizationScope = { mode: "ungrouped" };
    void perform("generate", generateProposal);
  },
});
setUsagePanelContext({
  input,
  field,
  button,
  perform,
});
installUsageRecorder();
// Registered immediately: render paths outside the search drawer (review and
// result views) read tab-search state through the context, so it must be
// usable before the drawer's first render.
setTabSearchPanelContext(tabSearchPanelContext);
setSettingsPanelContext({
  fullSettingsPage,
  advancedDisclosure,
  button,
  check,
  createDomainRuleEditor,
  currentProviderConfig,
  embeddingProviderStatus,
  field,
  fullExtensionPageUrl,
  initializeTarget,
  input,
  lineIcon,
  perform,
  render,
  providerConfigured,
  rebuildRequest,
  renderBackupSettings,
  renderEmbeddingProviderSettings,
  renderGeneratedGroupCleanupSettings,
  renderGroupNameMemorySettings,
  renderOrganizerRulesSettings,
  renderRequestPreviewBody,
  renderSearchSettings,
  renderShortcutSettings,
  settingsEditChip,
  settingsSummary,
  updateProviderReadiness,
  utilityNavIcon,
});
let userProtections: UserProtectionState = {
  permanentRules: [],
  session: { tabIds: [], groupIds: [] },
};
let protectionPermanence: "session" | "permanent" = "session";
let protectionRuleRemovalArmedIndex: number | null = null;
let cleanupReviewOpen = false;
let cleanupReviewDismissed = false;
// The cleanup review opens on its own only if the user has not acted since the
// load or organize run that prompted it; otherwise it would pull the drawer away
// from whatever they opened in the meantime (Search, most visibly).
let lastUserInteractionAt = -1;
let organizeStartedAt = 0;
let cleanupSuggestionFilter: CleanupSuggestionFilter = "all";
const selectedCleanupTabIds = new Set<number>();
const ignoredCleanupTabIds = new Set<number>();
let cleanupCloseArmed = false;
let popupReflowMode = false;
let popupReflowCheckTimer: ReturnType<typeof setTimeout> | null = null;
let renderScrollAnchor: { actionName: string; viewportTop: number; restoreFocus: boolean } | null = null;
let visibleResultTransactionId: string | null = null;
// Set when a change elsewhere invalidated a reviewed plan, so the Organize view
// can say why the plan is gone instead of it silently disappearing.
let storageChangeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let expandedReviewId: string | null = null;
const expandedReviewGroupIds = new Set<string>();
// Tabs checked for a bulk re-slot; cleared whenever the review is rebuilt.
const selectedReviewTabIds = new Set<number>();
// Why the last request build failed, so the ready view can say it instead of guessing.
let requestBuildError: string | null = null;
let organizationScope: OrganizationScope = WHOLE_WINDOW_SCOPE;
let pendingOrganizerRule: OrganizerRule | null = null;
let resetUtilityScroll = false;
let activeStashTabTooltip: { owner: HTMLButtonElement; node: HTMLElement } | null = null;

function dismissStashTabTooltipForViewportChange(): void {
  if (activeStashTabTooltip?.owner === document.activeElement) {
    positionStashTabTooltip(activeStashTabTooltip.owner, activeStashTabTooltip.node);
    return;
  }
  hideStashTabTooltip();
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function stopSemanticIndexPolling(): void {
  if (semanticIndexPollTimer) clearTimeout(semanticIndexPollTimer);
  semanticIndexPollTimer = null;
}

function startSemanticIndexPolling(): void {
  stopSemanticIndexPolling();
  if (popupState.semanticIndexMeta.status !== "building" || popupState.searchState.local.settings.semanticIndexPaused) return;
  semanticIndexPollTimer = setTimeout(() => {
    void send({ type: "semantic-index:get-state" }).then((response) => {
      if (response.semanticIndexMeta) {
        const changed = JSON.stringify(response.semanticIndexMeta) !== JSON.stringify(popupState.semanticIndexMeta);
        popupState.semanticIndexMeta = response.semanticIndexMeta;
        if (changed || (popupState.semanticIndexMeta.status === "building" && popupState.semanticIndexMeta.nextRetryAt)) {
          const current = actionRoot.querySelector<HTMLElement>("[data-semantic-index-status]");
          if (current) patchSemanticIndexStatus(current);
          redrawSearchPanel();
        }
      }
      startSemanticIndexPolling();
    }).catch(() => {
      stopSemanticIndexPolling();
    });
  }, 750);
}

function refreshSemanticIndexStatus(): void {
  void send({ type: "semantic-index:get-state" }).then((response) => {
    if (!response.semanticIndexMeta) return;
    popupState.semanticIndexMeta = response.semanticIndexMeta;
    const current = actionRoot.querySelector<HTMLElement>("[data-semantic-index-status]");
    if (current) patchSemanticIndexStatus(current);
  }).catch(() => undefined);
}

export function currentProviderConfig(): OpenAICompatibleConfig | null {
  return currentProviderConfigFromState(popupState.organizerData);
}

export async function updateProviderReadiness(): Promise<void> {
  popupState.providerReady = await isProviderReady(popupState.organizerData);
}

export function providerConfigured(): boolean {
  const config = currentProviderConfig();
  if (!config) return false;
  try {
    normalizeProviderConfig(config);
    return true;
  } catch {
    return false;
  }
}

async function ensureProviderReady(): Promise<void> {
  if (popupState.providerReady) return;
  const config = currentProviderConfig();
  if (!config || !providerConfigured() || !popupState.organizerData) {
    throw new Error("Set up the provider before organizing.");
  }
  let tested: Awaited<ReturnType<typeof testProviderConnection>>;
  try {
    tested = await testProviderConnection({
      config,
      apiKey: popupState.organizerData.session.apiKey,
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "The provider check failed."} Nothing moved.`);
  }
  popupState.organizerData = await writeConnectionTest(tested);
  await updateProviderReadiness();
  if (!popupState.providerReady) throw new Error("The provider configuration could not be verified.");
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (popupState.targetWindowId === null) return;
    void send({
      type: "popup:heartbeat",
      targetWindowId: popupState.targetWindowId,
      ownerContextId,
    }).then(async (response) => {
      // The reply carries no view state; storage change events keep viewState current.
      if (!response.ok) {
        stopHeartbeat();
        const { editorLease } = await readWindowCaptureViewState();
        const heldByAnotherContext = Boolean(editorLease && editorLease.ownerContextId !== ownerContextId);
        if (!heldByAnotherContext && document.visibilityState === "visible") void recoverHeartbeat();
      }
    }).catch(() => {
      stopHeartbeat();
      if (document.visibilityState === "visible") void recoverHeartbeat();
    });
  }, PROPOSAL_REVIEW.EDITOR_HEARTBEAT_INTERVAL_MS);
}

function recoverHeartbeat(): Promise<void> {
  if (heartbeatRecovery) return heartbeatRecovery;
  heartbeatRecovery = initializeTarget()
    .then(() => {
      if (popupState.notice?.text.includes("lost its connection") || popupState.notice?.text.includes("no longer attached")) {
        popupState.notice = null;
      }
      render();
    })
    .catch((error) => {
      popupState.notice = {
        tone: "error",
        text: error instanceof Error ? error.message : "The popup lost its connection to this window. Reopen it to continue.",
      };
      render();
    })
    .finally(() => {
      heartbeatRecovery = null;
    });
  return heartbeatRecovery;
}

export async function initializeTarget(): Promise<void> {
  if ((fullExtensionPage || floatingPage) && Number.isSafeInteger(requestedTargetWindowId)) {
    popupState.targetWindowId = requestedTargetWindowId;
  } else {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.windowId === undefined) {
      throw new Error("No normal browser window is selected.");
    }
    popupState.targetWindowId = activeTab.windowId;
  }
  const response = await send({
    type: "popup:initialize",
    targetWindowId: popupState.targetWindowId,
    ownerContextId,
  });
  popupState.viewState = response.state;
  if (!response.ok) throw new Error(response.error);
  if (popupState.viewState.editor) {
    const pending = await chrome.storage.session.get("pendingOrganizationScope");
    const intent = pending.pendingOrganizationScope as {
      windowId?: unknown;
      createdAt?: unknown;
    } | undefined;
    const useSelectedScope =
      intent?.windowId === popupState.targetWindowId &&
      typeof intent.createdAt === "number" &&
      Date.now() - intent.createdAt < 30_000 &&
      popupState.viewState.editor.capturedState.tabs.some((tab) => tab.highlighted);
    organizationScope = normalizeOrganizationScope(
      popupState.viewState.editor.capturedState,
      useSelectedScope ? { mode: "selected_tabs" } : organizationScope,
    );
    if (intent) await chrome.storage.session.remove("pendingOrganizationScope");
  }
  startHeartbeat();
}

export async function rebuildRequest(): Promise<void> {
  const state = popupState.viewState.editor?.capturedState;
  if (!popupState.organizerData || !state) {
    popupState.immutableRequest = null;
    return;
  }
  try {
    popupState.immutableRequest = buildSanitizedRequest(
      state,
      popupState.organizerData.local.privacy,
      Date.now(),
      popupState.organizerData.local.workflow,
      organizationScope,
      popupState.organizerData.local.organizerRules,
      popupState.organizerData.local.groupNamePreferences,
    );
    requestBuildError = null;
  } catch (error) {
    popupState.immutableRequest = null;
    requestBuildError = error instanceof Error ? error.message : null;
    throw error;
  }
  await writeImmutableRequest(popupState.immutableRequest);
}

async function loadStoredWorkflow(): Promise<OrganizerStoredState> {
  [popupState.organizerData, organizationHistory, userProtections, diagnosticsState, popupState.savedStashes, popupState.stashSettings, popupState.searchState, popupState.semanticIndexMeta] = await Promise.all([
    readOrganizerState(),
    readCountsOnlyHistory(),
    readUserProtectionState(),
    readDiagnosticsState(),
    readTabStashes(),
    readTabStashSettings(),
    readSearchState(),
    readSemanticIndexMeta(),
  ]);
  await loadStashExtras();
  await loadUsageStats().catch(() => null);
  if (fullSettingsPage) {
    try {
      const cleanup = await send({ type: "generated-groups:get-cleanup" });
      if (cleanup.ok) generatedGroupCleanupSummary = cleanup.generatedGroupCleanupSummary ?? null;
    } catch {
      generatedGroupCleanupSummary = null;
    }
  }
  ignoredCleanupTabIds.clear();
  (await readIgnoredCleanupTabIds()).forEach((tabId) => ignoredCleanupTabIds.add(tabId));
  setSearchScope(popupState.searchState.local.settings.defaultScope);
  popupState.providerJob = popupState.organizerData.session.providerJob;
  popupState.proposalReview = await readProposalReview();
  if (popupState.providerJob?.status === "requesting" && popupState.providerJob.ownerContextId !== BACKGROUND_JOB_OWNER) {
    // Only the editor page still generates in-page; its request died with it.
    popupState.providerJob = {
      ...popupState.providerJob,
      status: "cancelled",
      finishedAt: Date.now(),
      error: "The previous request ended when its window closed.",
      cancellationReason: "owner_lease_expired",
    };
    await writeProviderJob(popupState.providerJob);
  }
  const missedFailure = await settleFinishedBackgroundJob();
  const backgroundError = await takeBackgroundError().catch(() => null);
  const shownError = missedFailure ?? backgroundError?.message ?? null;
  if (shownError && shownError !== popupState.viewState.transactionRun?.error) {
    popupState.notice = { tone: "error", text: shownError };
  }
  await updateProviderReadiness();
  if (popupState.proposalReview) {
    popupState.immutableRequest = popupState.proposalReview.request;
    organizationScope = popupState.proposalReview.request.scope ?? WHOLE_WINDOW_SCOPE;
  }
  else {
    try {
      await rebuildRequest();
    } catch {
      popupState.immutableRequest = null;
    }
  }
  return popupState.organizerData;
}

export async function perform(
  actionName: string,
  action: () => Promise<void>,
): Promise<void> {
  const focused = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>("[data-action-name]")
    : null;
  renderScrollAnchor = focused?.dataset.actionName
      ? {
          actionName: focused.dataset.actionName,
          viewportTop: focused.getBoundingClientRect().top,
          restoreFocus: focused === document.activeElement,
        }
    : null;
  busyAction = actionName;
  popupState.notice = null;
  render();
  try {
    await action();
  } catch (error) {
    popupState.notice = {
      tone: "error",
      text: error instanceof Error ? error.message : "The action could not be completed.",
    };
  } finally {
    busyAction = null;
    render();
    renderScrollAnchor = null;
  }
}

export function button(
  label: string,
  variant: "primary" | "secondary" | "quiet" | "danger",
  onClick: () => void,
  options: { disabled?: boolean; actionName?: string; busyLabel?: string; shortcut?: boolean } = {},
): HTMLButtonElement {
  const node = element("button", `button button--${variant}`, label);
  node.type = "button";
  const active = options.actionName === busyAction;
  node.disabled = Boolean(options.disabled || busyAction || active);
  if (active && options.busyLabel) node.textContent = options.busyLabel;
  if (options.actionName) node.dataset.actionName = options.actionName;
  // One primary action per view answers Mod+Enter; the keycap is visual, aria-keyshortcuts carries it.
  if (options.shortcut && !active) {
    node.dataset.primaryShortcut = "true";
    node.setAttribute("aria-keyshortcuts", `${IS_MAC ? "Meta" : "Control"}+Enter`);
    node.append(keycap(IS_MAC ? "⌘" : "Ctrl", "↵"));
  }
  node.addEventListener("click", onClick);
  return node;
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Browser-level shortcuts the user has actually bound; empty until loaded, and
// a command missing here has no key (unset, or lost to a conflict).
let browserShortcuts = new Map<string, { description: string; shortcut: string }>();

async function loadBrowserShortcuts(): Promise<void> {
  const commands = await chrome.commands.getAll();
  // The browser lists commands alphabetically and gives the popup command no
  // description, so the everyday ones lead and that one is named here.
  const order = ["_execute_action", "organize-window", "search-tabs"];
  const rank = (name = ""): number => (order.includes(name) ? order.indexOf(name) : order.length);
  browserShortcuts = new Map(
    commands
      .filter((command) => command.name)
      .sort((a, b) => rank(a.name) - rank(b.name))
      .map((command) => [
        command.name!,
        {
          description: command.name === "_execute_action" ? "Open Sheaf" : command.description ?? "",
          shortcut: command.shortcut ?? "",
        },
      ]),
  );
}

// macOS reports "⌥⇧O"; other platforms report "Alt+Shift+O".
function shortcutKeys(shortcut: string): string[] {
  return shortcut.includes("+") ? shortcut.split("+") : [...shortcut];
}

function browserShortcutHint(command: string, label: string): string {
  const shortcut = browserShortcuts.get(command)?.shortcut;
  return shortcut ? `${label} · ${shortcut} from any tab` : label;
}

function keycap(...keys: string[]): HTMLElement {
  const node = element("span", "keycap");
  node.setAttribute("aria-hidden", "true");
  keys.forEach((key) => node.append(element("kbd", undefined, key)));
  return node;
}

// A hover tooltip must not linger over keyboard focus that has moved on.
function dismissStashTabTooltipForKeyboard(): void {
  if (activeStashTabTooltip && activeStashTabTooltip.owner !== document.activeElement) hideStashTabTooltip();
}

function hideStashTabTooltip(owner?: HTMLButtonElement): void {
  if (!activeStashTabTooltip || (owner && activeStashTabTooltip.owner !== owner)) return;
  document.removeEventListener("scroll", dismissStashTabTooltipForViewportChange, true);
  document.removeEventListener("keydown", dismissStashTabTooltipForKeyboard, true);
  window.removeEventListener("resize", dismissStashTabTooltipForViewportChange);
  activeStashTabTooltip.owner.removeAttribute("aria-describedby");
  activeStashTabTooltip.node.remove();
  activeStashTabTooltip = null;
}

function positionStashTabTooltip(
  owner: HTMLButtonElement,
  tooltip: HTMLElement,
  placement: "auto" | "left" | "below" = "auto",
): void {
  const ownerBox = owner.getBoundingClientRect();
  const tooltipBox = tooltip.getBoundingClientRect();
  const gap = 5;
  const edge = 6;
  if (placement === "left") {
    const left = Math.max(edge, ownerBox.left - tooltipBox.width - gap);
    const top = Math.min(
      Math.max(edge, ownerBox.top + ownerBox.height / 2 - tooltipBox.height / 2),
      window.innerHeight - tooltipBox.height - edge,
    );
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    return;
  }
  // Below hugs the owner so a tooltip under the view strip stays clear of the
  // command row's labels.
  const top = placement === "below"
    ? ownerBox.bottom + 1
    : ownerBox.top - tooltipBox.height - gap >= edge
      ? ownerBox.top - tooltipBox.height - gap
      : ownerBox.bottom + gap;
  const left = Math.min(
    Math.max(edge, ownerBox.right - tooltipBox.width),
    window.innerWidth - tooltipBox.width - edge,
  );
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

function showStashTabTooltip(
  owner: HTMLButtonElement,
  label: string,
  placement: "auto" | "left" | "below" = "auto",
): void {
  hideStashTabTooltip();
  const tooltip = element("div", "stash-tab-tooltip", label);
  tooltip.id = "stash-tab-tooltip";
  tooltip.setAttribute("role", "tooltip");
  // Inside the main landmark so all page content sits in a region; render() drops it.
  actionRoot.append(tooltip);

  positionStashTabTooltip(owner, tooltip, placement);
  owner.setAttribute("aria-describedby", tooltip.id);
  activeStashTabTooltip = { owner, node: tooltip };
  document.addEventListener("scroll", dismissStashTabTooltipForViewportChange, true);
  document.addEventListener("keydown", dismissStashTabTooltipForKeyboard, true);
  window.addEventListener("resize", dismissStashTabTooltipForViewportChange);
}

type UtilityNavIcon = "search" | "groups" | "cleanup" | "stashes" | "history" | "protection" | "settings" | "close" | "check" | "alert" | "lock" | "unlock";
export type GroupManagerActionIcon = "search" | "undo" | "manage" | "unmanage" | "protect" | "add" | "done" | "remove" | "up" | "down" | "discard" | "back";

export function lineIcon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  paths.forEach((d) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  });
  return svg;
}

export function utilityNavIcon(icon: UtilityNavIcon): SVGSVGElement {
  const paths: Record<UtilityNavIcon, string[]> = {
    search: ["m21 21-4.35-4.35", "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"],
    groups: ["M4 6h6l2 2h8v10H4Z", "M4 10h16"],
    cleanup: ["m5 19 9-9", "m13 5 1-2 1 2 2 1-2 1-1 2-1-2-2-1Z", "m17 13 .7-1.5.8 1.5 1.5.7-1.5.8-.8 1.5-.7-1.5-1.5-.8Z"],
    stashes: ["M4 8h16v11H4Z", "M3 5h18v3H3Z", "M9 12h6"],
    history: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5", "M12 7v5l3 2"],
    protection: ["M12 3 5 6v5c0 4.5 2.8 7.8 7 10 4.2-2.2 7-5.5 7-10V6Z", "m9 12 2 2 4-5"],
    settings: ["M4 7h10", "M18 7h2", "M14 5v4", "M4 17h2", "M10 17h10", "M8 15v4", "M4 12h5", "M13 12h7", "M11 10v4"],
    close: ["m6 6 12 12", "M18 6 6 18"],
    check: ["m5 12.5 4.5 4.5L19 7.5"],
    lock: ["M6 11h12v9H6Z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
    unlock: ["M6 11h12v9H6Z", "M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2"],
    alert: ["M12 8v5", "M12 16.5v.01", "M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"],
  };
  return lineIcon(paths[icon]);
}

function groupManagerIconButton(
  label: string,
  icon: GroupManagerActionIcon,
  onClick: () => void,
  options: { disabled?: boolean; actionName?: string; busyLabel?: string } = {},
): HTMLButtonElement {
  const paths: Record<GroupManagerActionIcon, string[]> = {
    search: ["m21 21-4.35-4.35", "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"],
    undo: ["M9 14 4 9l5-5", "M4 9h10a6 6 0 1 1 0 12h-2"],
    manage: ["M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z", "M12 7v6", "M9 10h6"],
    unmanage: ["M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z", "M9 10h6"],
    protect: ["M12 3 5 6v5c0 4.5 2.8 7.8 7 10 4.2-2.2 7-5.5 7-10V6Z", "m9 12 2 2 4-5"],
    add: ["M12 5v14", "M5 12h14"],
    done: ["m6 6 12 12", "M18 6 6 18"],
    remove: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "m9 9 6 6", "m15 9-6 6"],
    up: ["m7 14 5-5 5 5"],
    down: ["m7 10 5 5 5-5"],
    discard: ["M9 14 4 9l5-5", "M4 9h10a6 6 0 1 1 0 12h-2"],
    back: ["m15 18-6-6 6-6"],
  };
  const node = button("", "quiet", onClick, options);
  node.classList.add("group-manager__icon-button");
  node.setAttribute("aria-label", label);
  node.dataset.tooltip = label;
  node.addEventListener("mouseenter", () => showStashTabTooltip(node, label));
  node.addEventListener("mouseleave", () => hideStashTabTooltip(node));
  node.addEventListener("focus", () => showStashTabTooltip(node, label));
  node.addEventListener("blur", () => hideStashTabTooltip(node));
  node.addEventListener("click", () => hideStashTabTooltip(node));
  node.append(lineIcon(paths[icon]));
  return node;
}

export function input(value: string, type: HTMLInputElement["type"] = "text"): HTMLInputElement {
  const node = element("input", "input");
  node.type = type;
  node.value = value;
  node.autocomplete = "off";
  node.spellcheck = false;
  return node;
}

// Visual affordance only: the <summary> it sits in is the control, so nesting a
// real button there would create an ambiguous nested-interactive target.
export function settingsEditChip(): HTMLElement {
  const chip = element("span", "settings-edit-chip", "Edit");
  chip.setAttribute("aria-hidden", "true");
  return chip;
}

function settingsChevron(): SVGSVGElement {
  const svg = lineIcon(["m9.5 6 6 6-6 6"]);
  svg.classList.add("settings-chevron");
  return svg;
}

// Every settings disclosure carries the same drawn marker instead of the
// platform triangle, so the page reads with one icon vocabulary.
export function settingsSummary(text: string): HTMLElement {
  const summary = element("summary", "settings-subdisclosure");
  summary.append(element("span", "settings-subdisclosure__label", text), settingsChevron());
  return summary;
}

// Settings are rebuilt on every render; an open Advanced area stays open.
const openAdvancedAreas = new Set<string>();

// Each settings section keeps its expert controls in one Advanced area, closed
// by default, whose summary names what is inside.
export function advancedDisclosure(
  key: string,
  contents: string,
  children: readonly Node[],
  badge?: HTMLElement,
): HTMLDetailsElement {
  const node = element("details", "settings-group settings-advanced");
  node.dataset.advanced = key;
  node.open = openAdvancedAreas.has(key);
  node.addEventListener("toggle", () => {
    if (node.open) openAdvancedAreas.add(key);
    else openAdvancedAreas.delete(key);
  });
  const summary = element("summary", "settings-disclosure-summary");
  const copy = element("span");
  copy.append(element("strong", undefined, "Advanced"), element("small", undefined, contents));
  const actions = element("span", "settings-summary-actions");
  if (badge) actions.append(badge);
  actions.append(settingsChevron());
  summary.append(copy, actions);
  const body = element("div", "settings-disclosure-body");
  body.append(...children);
  node.append(summary, body);
  return node;
}

export function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  fieldSequence += 1;
  const controlId = control.id || `action-field-${fieldSequence}`;
  const wrapper = element("div", "field");
  const labelNode = element("label", "field__label", label);
  labelNode.htmlFor = controlId;
  control.id = controlId;
  wrapper.append(labelNode, control);
  if (help) {
    const helpId = `${controlId}-help`;
    const helpNode = element("small", "field__help", help);
    helpNode.id = helpId;
    const describedBy = control.getAttribute("aria-describedby");
    control.setAttribute(
      "aria-describedby",
      [describedBy, helpId].filter(Boolean).join(" "),
    );
    wrapper.append(helpNode);
  }
  return wrapper;
}

export function check(
  label: string,
  copy: string,
  checked: boolean,
): { wrapper: HTMLLabelElement; control: HTMLInputElement } {
  const wrapper = element("label", "check");
  const control = element("input");
  control.type = "checkbox";
  control.checked = checked;
  const text = element("span");
  text.append(element("strong", undefined, label), element("small", undefined, copy));
  wrapper.append(control, text);
  return { wrapper, control };
}

interface DomainRuleEditor {
  node: HTMLElement;
  values: () => string[];
  onChange: (callback: () => void) => void;
}

export function createDomainRuleEditor(
  label: string,
  description: string,
  initial: readonly string[],
  suggestions: readonly string[],
): DomainRuleEditor {
  let rules = normalizeDomainRules(initial);
  let changeCallback = (): void => {};
  const node = element("section", "domain-rule-editor");
  const heading = element("div", "domain-rule-editor__heading");
  const headingCopy = element("div");
  headingCopy.append(
    element("strong", undefined, label),
    element("span", undefined, description),
  );
  const count = element("span", "domain-rule-count");
  heading.append(headingCopy, count);
  const list = element("ul", "domain-rule-list");
  const addInput = input("");
  addInput.placeholder = "example.com, *.example.com, or paste a URL";
  addInput.setAttribute("aria-label", `Domain or wildcard for ${label}`);
  const feedback = element("p", "domain-rule-feedback");
  feedback.setAttribute("aria-live", "polite");
  const suggestionList = element("div", "domain-rule-suggestions");

  const addRule = (raw: string): void => {
    const normalized = normalizeDomainRule(raw);
    if (!normalized) {
      feedback.textContent = "Enter a valid domain, wildcard, or URL.";
      feedback.className = "domain-rule-feedback domain-rule-feedback--error";
      return;
    }
    if (rules.includes(normalized)) {
      feedback.textContent = `${normalized} is already listed.`;
      feedback.className = "domain-rule-feedback";
      return;
    }
    rules = normalizeDomainRules([...rules, normalized]);
    addInput.value = "";
    feedback.textContent = `Added ${normalized}.`;
    feedback.className = "domain-rule-feedback";
    renderRows();
    changeCallback();
  };

  const renderRows = (): void => {
    count.textContent = String(rules.length);
    list.replaceChildren();
    if (rules.length === 0) {
      list.append(element("li", "domain-rule-empty", "No domains added."));
    } else {
      rules.forEach((rule) => {
        const row = element("li", "domain-rule-row");
        row.append(element("code", undefined, rule));
        const remove = element("button", "rule-remove", `Remove ${rule}`);
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${rule} from ${label}`);
        remove.addEventListener("click", () => {
          rules = rules.filter((candidate) => candidate !== rule);
          feedback.textContent = `Removed ${rule}.`;
          feedback.className = "domain-rule-feedback";
          renderRows();
          changeCallback();
        });
        row.append(remove);
        list.append(row);
      });
    }
    suggestionList.replaceChildren();
    const available = suggestions.filter((domain) => !rules.includes(domain)).slice(0, 8);
    if (available.length > 0) {
      suggestionList.append(element("span", undefined, "From this window"));
      available.forEach((domain) => {
        const suggestion = element("button", "domain-suggestion", `+ ${domain}`);
        suggestion.type = "button";
        suggestion.addEventListener("click", () => addRule(domain));
        suggestionList.append(suggestion);
      });
    }
  };

  const add = element("div", "domain-rule-add");
  const addButton = element("button", "button button--secondary", "Add");
  addButton.type = "button";
  addButton.setAttribute("aria-label", `Add to ${label}`);
  addButton.addEventListener("click", () => addRule(addInput.value));
  addInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addRule(addInput.value);
  });
  add.append(addInput, addButton);
  node.append(heading, list, add, feedback, suggestionList);
  renderRows();
  return {
    node,
    values: () => [...rules],
    onChange: (callback) => { changeCallback = callback; },
  };
}

function locationPattern(tab: { domain: string; hostname?: string; path?: string }): string {
  return `${tab.hostname ?? tab.domain}${tab.path ?? "/*"}`.toLocaleLowerCase();
}

function sameOrganizerRule(left: OrganizerRule, right: OrganizerRule): boolean {
  const leftValue = { ...left, id: "" };
  const rightValue = { ...right, id: "" };
  return JSON.stringify(leftValue) === JSON.stringify(rightValue);
}

async function persistOrganizerRules(rules: readonly OrganizerRule[]): Promise<void> {
  if (!popupState.organizerData) throw new Error("Organizer settings are unavailable.");
  popupState.organizerData = await writeOrganizerRules(rules);
  if (!popupState.proposalReview) await rebuildRequest();
}

async function persistGroupNamePreferences(
  preferences: readonly GroupNamePreference[],
): Promise<void> {
  if (!popupState.organizerData) throw new Error("Organizer settings are unavailable.");
  popupState.organizerData = await writeGroupNamePreferences(preferences);
  if (!popupState.proposalReview) await rebuildRequest();
}

function shortLocation(tab: { domain: string; hostname?: string; path?: string }): string {
  return `${tab.hostname ?? tab.domain}${tab.path ?? ""}`;
}

function cleanupLocation(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "Location unavailable";
  }
}

type FullExtensionView = "settings" | "diagnostics" | "setup";

export function fullExtensionPageUrl(view: FullExtensionView): string {
  const state = popupState.viewState.editor?.capturedState;
  const params = new URLSearchParams({ view });
  if (state) params.set("window", String(state.windowId));
  return chrome.runtime.getURL(`action.html?${params.toString()}`);
}

function openFullExtensionPage(view: FullExtensionView, section?: string): void {
  void chrome.tabs.create({
    url: `${fullExtensionPageUrl(view)}${section ? `#${section}` : ""}`,
  });
}

function openAdvancedSettings(section?: string): void {
  openFullExtensionPage("settings", section);
}

function openSetupPage(): void {
  openFullExtensionPage("setup");
}

type UtilityView = "search" | "groups" | "history" | "stashes" | "protection" | "cleanup";

// The utility drawer shows at most one view; opening one closes the rest.
function showUtilityView(view: UtilityView | null): void {
  // An error belongs to the view that raised it; carrying it into another view
  // reads as if the new view had failed.
  if (popupState.notice?.tone === "error") popupState.notice = null;
  popupState.searchOpen = view === "search";
  popupState.groupsOpen = view === "groups";
  historyOpen = view === "history";
  popupState.stashesOpen = view === "stashes";
  protectionOpen = view === "protection";
  cleanupReviewOpen = view === "cleanup";
}

function isSkippingReview(): boolean {
  return (
    busyAction === "generate" &&
    popupState.organizerData?.local.workflow.organizeWithoutReview === true
  );
}


function renderHeader(shell: HTMLElement): void {
  if (!fullExtensionPage) {
    renderCommandHeader(shell);
    return;
  }
  const header = element("header", "action-header");
  const identity = element("div", "identity");
  // The extension icon, which carries its own tile.
  const mark = element("img", "mark");
  mark.src = "/icons/icon-128.png";
  mark.alt = "";
  identity.append(mark);
  const copy = element("div");
  const pageTitle = diagnosticsPage ? "Diagnostics" : setupPage ? "Set up Sheaf" : "All settings";
  copy.append(element("h1", undefined, pageTitle));
  copy.append(
    element(
      "p",
      undefined,
      diagnosticsPage
        ? "Provider runs, stale plans, rollback, and Undo"
        : setupPage
          ? "Connect a model, choose what's sent, and start organizing"
          : "What Sheaf connects to, does, sends, and keeps",
    ),
  );
  identity.append(copy);
  const controls = element("div", "header-controls");
  {
    if (!fullSettingsPage) {
      const advanced = element("button", "icon-button", "All settings");
      advanced.type = "button";
      advanced.addEventListener("click", () => {
        location.assign(fullExtensionPageUrl("settings"));
      });
      controls.append(advanced);
    }
    if (fullSettingsPage) {
      const diagnostics = element("button", "icon-button", "Diagnostics");
      diagnostics.type = "button";
      diagnostics.addEventListener("click", () => {
        location.assign(fullExtensionPageUrl("diagnostics"));
      });
      controls.append(diagnostics);
    }
    const done = element("button", "icon-button", "Done");
    done.type = "button";
    done.addEventListener("click", () => {
      void chrome.tabs.getCurrent().then((tab) => {
        if (tab?.id !== undefined) return chrome.tabs.remove(tab.id);
      });
    });
    controls.append(done);
  }
  header.append(identity, controls);
  shell.append(header);
}

function openSearchView(): void {
  disarmStashDelete();
  void perform("search-tabs", async () => {
    await refreshSearchSnapshots(tabSearchPanelContext);
    resetSearchSelection();
    setSearchAutofocusPending(true);
    showUtilityView("search");
  });
}

// The popup header: a view strip, then a command field that opens Search in place.
// In the Search view the panel's own live field takes the command field's position.
function renderCommandHeader(shell: HTMLElement): void {
  const header = element("header", "action-header command-header");
  header.append(renderViewStrip());
  if (!popupState.searchOpen) {
    const field = element("button", "command-field");
    field.type = "button";
    field.dataset.searchTrigger = "true";
    field.dataset.focusKey = "header-search";
    field.setAttribute("aria-label", "Search");
    field.setAttribute("aria-controls", UTILITY_DRAWER_ID);
    field.setAttribute("aria-expanded", "false");
    field.setAttribute("aria-keyshortcuts", "/");
    field.title = browserShortcutHint("search-tabs", "Search tabs and workspaces");
    field.disabled = busyAction === "search-tabs";
    field.append(
      utilityNavIcon("search"),
      element("span", "command-field__placeholder", "Search tabs and workspaces"),
      keycap("/"),
    );
    field.addEventListener("click", openSearchView);
    header.append(field);
  }
  shell.append(header);
}

// The header is identical in every view, so Organize lives only on its own tab.
// From any other view the platform shortcut still reaches it: it returns to a
// waiting review, or starts a run, without a second dark button in the header.
function organizeFromAnyView(): boolean {
  const pendingReview = Boolean(popupState.proposalReview);
  if (!pendingReview && (!providerConfigured() || !popupState.immutableRequest || busyAction)) return false;
  disarmStashDelete();
  cancelGroupSemanticSearch();
  cancelGroupMemberSemanticSearch();
  showUtilityView(null);
  popupState.pendingFocusKey = "utility-organize";
  if (pendingReview) render();
  else void perform("generate", generateProposal);
  return true;
}

type StripView = "organize" | "groups" | "cleanup" | "stashes" | "history";

function renderViewStrip(): HTMLElement {
  const nav = element("nav", "view-strip");
  nav.id = "view-strip";
  nav.setAttribute("aria-label", "Views");
  // Held tabs are part of Organizing (reached from the frame's Held row), so they keep Organize lit.
  const openView = utilityDrawerOpen() ? openUtilityView() : "organize";
  const current: StripView | "search" = openView === "protection" ? "organize" : openView;
  const list = element("div", "view-strip__items");
  const add = (
    key: StripView,
    label: string,
    count: number | null,
    countLabel: string | null,
    onOpen: () => void,
  ): void => {
    const active = current === key;
    const control = element("button", `view-strip__item${active ? " view-strip__item--active" : ""}`);
    control.type = "button";
    control.dataset.focusKey = `utility-${key}`;
    if (active) control.setAttribute("aria-current", "page");
    control.setAttribute("aria-label", label);
    if (countLabel) control.setAttribute("aria-description", countLabel);
    control.append(element("span", "view-strip__label", label));
    // Only counts that ask for attention are shown; the rest are spoken. The slot
    // is always held, with a dash for zero, so counts arriving never shift the strip.
    if (count !== null) {
      const badge = element("span", `view-strip__count${count > 0 ? "" : " view-strip__count--empty"}`, count > 0 ? String(count) : "–");
      badge.setAttribute("aria-hidden", "true");
      control.append(badge);
    }
    control.addEventListener("click", () => {
      if (active && openView === key) return;
      if (key !== "stashes") disarmStashDelete();
      popupState.pendingFocusKey = `utility-${key}`;
      resetUtilityScroll = true;
      onOpen();
    });
    list.append(control);
  };
  add("organize", "Organize", null, null, () => {
    cancelGroupSemanticSearch();
    cancelGroupMemberSemanticSearch();
    showUtilityView(null);
    render();
  });
  const openGroupCount = groupManagerSnapshot()?.groups.length ?? popupState.viewState.editor?.capturedState.groups.length ?? 0;
  const stashedGroupTotal = stashedGroupCount();
  add(
    "groups",
    "Groups",
    null,
    [
      formatCount(openGroupCount, "open group"),
      stashedGroupTotal > 0 ? formatCount(stashedGroupTotal, "saved group") : null,
    ].filter(Boolean).join(" · "),
    () => openGroupManager(),
  );
  const suggestions = currentCleanupSuggestions();
  add("cleanup", "Cleanup", suggestions.length, formatCount(suggestions.length, "suggestion"), () => {
    selectCleanupUtilityView();
    render();
  });
  add("stashes", "Workspaces", null, formatCount(popupState.savedStashes.length, "saved workspace"), () => {
    showUtilityView("stashes");
    render();
  });
  add("history", "History", null, null, () => {
    void perform("history", async () => {
      organizationHistory = await readCountsOnlyHistory();
      await loadAutoFilingView().catch(() => null);
      showUtilityView("history");
      popupState.pendingFocusKey = "utility-history";
    });
  });
  const settings = element("button", "view-strip__settings");
  settings.type = "button";
  settings.dataset.focusKey = "utility-settings";
  settings.setAttribute("aria-label", "Settings");
  // There is no settings view inside the popup: the gear always opens the
  // All settings page, so say so where a label alone would not.
  settings.setAttribute("aria-description", "Opens All settings in a new tab");
  settings.dataset.tooltip = "Settings";
  // Placed below, right-aligned: to the left it covered the History tab. Hover
  // waits like a native tooltip so passing over the gear shows nothing, and any
  // key press dismisses it so it never lingers over keyboard focus elsewhere.
  let settingsTooltipTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelSettingsTooltip = (): void => {
    if (settingsTooltipTimer) clearTimeout(settingsTooltipTimer);
    settingsTooltipTimer = null;
  };
  settings.addEventListener("mouseenter", () => {
    cancelSettingsTooltip();
    settingsTooltipTimer = setTimeout(() => {
      settingsTooltipTimer = null;
      if (settings.isConnected) showStashTabTooltip(settings, "Settings", "below");
    }, 450);
  });
  settings.addEventListener("mouseleave", () => {
    cancelSettingsTooltip();
    if (document.activeElement !== settings) hideStashTabTooltip(settings);
  });
  settings.addEventListener("focus", () => {
    if (settings.matches(":focus-visible")) showStashTabTooltip(settings, "Settings", "below");
  });
  settings.addEventListener("blur", () => {
    cancelSettingsTooltip();
    hideStashTabTooltip(settings);
  });
  settings.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideStashTabTooltip(settings);
  });
  settings.append(utilityNavIcon("settings"));
  settings.addEventListener("click", () => {
    cancelSettingsTooltip();
    hideStashTabTooltip(settings);
    openAdvancedSettings();
  });
  nav.append(list, settings);
  return nav;
}

function renderNotice(shell: HTMLElement): void {
  if (!popupState.notice) return;
  // Same shape as the result bar: a toned mark and plain text on a hairline row,
  // so a saved workspace reads like an organized window.
  const node = element("div", `notice notice--${popupState.notice.tone}`);
  const mark = element("span", `result-mark result-mark--${popupState.notice.tone === "info" ? "warning" : popupState.notice.tone}`);
  mark.append(utilityNavIcon(popupState.notice.tone === "success" ? "check" : "alert"));
  mark.setAttribute("aria-hidden", "true");
  node.append(mark, element("span", "notice__text", popupState.notice.text));
  node.setAttribute("role", popupState.notice.tone === "error" ? "alert" : "status");
  shell.append(node);
}

function renderSummary(shell: HTMLElement): void {
  const state = popupState.viewState.editor?.capturedState;
  if (!state) return;
  const summary = element("div", "window-summary");
  const groupCount = state.groups.length;
  const ungroupedCount = state.tabs.filter((tab) => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE).length;
  const cleanupCount = currentCleanupSuggestions().length;
  const metrics = `${state.tabs.length} tabs · ${groupCount} group${groupCount === 1 ? "" : "s"} · ${ungroupedCount} ungrouped · ${cleanupCount} cleanup candidate${cleanupCount === 1 ? "" : "s"}`;
  const visibleMetrics = [
    `${ungroupedCount} ungrouped`,
    `${groupCount} group${groupCount === 1 ? "" : "s"}`,
    cleanupCount > 0 ? `${cleanupCount} cleanup suggestion${cleanupCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  // aria-label is prohibited on a generic div; a group role makes the name reach assistive tech.
  summary.setAttribute("role", "group");
  summary.setAttribute("aria-label", `Window summary: ${metrics}`);
  summary.append(element("strong", undefined, visibleMetrics));
  // The compact header has no Cleanup view, so reaching suggestions would otherwise take two clicks.
  // Once any drawer is open its nav already lists Cleanup.
  if (cleanupCount > 0 && !fullExtensionPage && !utilityDrawerOpen()) {
    const review = element("button", "icon-button", "Review cleanup");
    review.type = "button";
    review.dataset.focusKey = "summary-cleanup";
    review.setAttribute("aria-controls", UTILITY_DRAWER_ID);
    review.disabled = Boolean(busyAction);
    review.addEventListener("click", () => {
      selectCleanupUtilityView();
      popupState.pendingFocusKey = "utility-cleanup";
      render();
    });
    summary.append(review);
  }
  shell.append(summary);
}

/**
 * Why an interactive related search failed, in the class's own terms. The index
 * label below already had this vocabulary; the query path used to say only
 * "unavailable", which told the user nothing about what to do next.
 */
/**
 * What the provider test could not confirm. Both of these change what the index
 * will contain, and both are invisible until a search behaves oddly, so the
 * settings surface says them next to the success line.
 */
function embeddingVerificationCaveats(result: { dimensionsHonored?: boolean; normalized?: boolean }): string {
  const caveats: string[] = [];
  if (result.dimensionsHonored === false) {
    caveats.push("the provider ignored the requested dimensions, so vectors may not be comparable with a later run");
  }
  if (result.normalized === false) {
    caveats.push("returned vectors are not unit length and are normalised locally");
  }
  return caveats.length === 0 ? "" : ` · ${caveats.join("; ")}`;
}

function semanticSearchFailureLabel(code: string | null): string {
  return ({
    authentication: "Embedding provider authentication failed; test the connection in settings",
    insufficient_balance: "Embedding provider reported insufficient balance",
    redirected: "The embedding endpoint redirected; correct the origin in settings",
    rate_limited: "Rate limited by the embedding provider; try again shortly",
    provider_unavailable: "Embedding provider is temporarily unavailable; try again shortly",
    timeout: "Embedding provider timed out; try again shortly",
    network: "Embedding provider could not be reached; try again shortly",
    provider_rejected: "Embedding provider rejected the query",
    invalid_response: "Embedding provider returned an unusable response",
    configuration_changed: "Embedding dimensions changed; rebuild the semantic index",
    invalid_record: "Some indexed tabs need rebuilding; they were skipped",
    cancelled: "Related search was cancelled",
  } as Record<string, string>)[code ?? ""] ?? "Search by meaning is unavailable; direct matches still work";
}

function semanticIndexErrorLabel(code: string | null): string | null {
  if (!code) return null;
  if (popupState.semanticIndexMeta.status === "building") {
    return ({
      authentication: "Provider authentication failed; a retry is scheduled. Cancel and test the connection if credentials changed.",
      insufficient_balance: "The provider reported insufficient balance; a retry is scheduled. You can Cancel indexing.",
      rate_limited: "The provider rate-limited indexing; a retry is scheduled. You can Cancel indexing.",
      provider_unavailable: "The provider is temporarily unavailable; a retry is scheduled. You can Cancel indexing.",
      provider_rejected: "The provider rejected a batch; a retry is scheduled. You can Cancel indexing.",
      timeout: "The provider timed out; a retry is scheduled. You can Cancel indexing.",
      network: "The provider could not be reached; a retry is scheduled. You can Cancel indexing.",
      invalid_response: "The provider returned an unusable response; a retry is scheduled. You can Cancel indexing.",
    } as Record<string, string>)[code] ?? "Indexing paused after an error; a retry is scheduled. You can Cancel indexing.";
  }
  return ({
    authentication: "Provider authentication failed. Test the embedding connection, then rebuild.",
    insufficient_balance: "The embedding provider reported insufficient balance.",
    rate_limited: "The embedding provider rate-limited indexing. Rebuild when it is available.",
    provider_unavailable: "The embedding provider is temporarily unavailable.",
    provider_rejected: "The embedding provider rejected the batch.",
    timeout: "The embedding provider timed out.",
    network: "The embedding provider could not be reached.",
    invalid_response: "The embedding provider returned an unusable vector response.",
    configuration_changed: "Embedding or privacy settings changed. Rebuild the index to continue.",
    incompatible_queue: "Pending work did not match the current embedding configuration.",
    index_runtime: "Local index storage stopped unexpectedly. Clear or rebuild the index.",
  } as Record<string, string>)[code] ?? "Semantic indexing stopped. Test the provider, then rebuild.";
}

function semanticIndexRetryDetail(): string | null {
  if (popupState.semanticIndexMeta.status !== "building" || !popupState.semanticIndexMeta.lastErrorCode) return null;
  const reason = ({
    rate_limited: "The provider rate-limited the last batch.",
    provider_unavailable: "The provider was temporarily unavailable.",
    timeout: "The last batch timed out.",
    network: "The provider could not be reached for the last batch.",
  } as Record<string, string>)[popupState.semanticIndexMeta.lastErrorCode] ?? "The last batch could not be completed.";
  const remaining = `${popupState.semanticIndexMeta.pending} tab${popupState.semanticIndexMeta.pending === 1 ? "" : "s"} remaining.`;
  const retryAt = popupState.semanticIndexMeta.nextRetryAt ?? null;
  if (retryAt === null) return `${reason} ${remaining} A retry is scheduled.`;
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
  return `${reason} ${remaining} ${seconds > 0 ? `Retrying in about ${seconds} second${seconds === 1 ? "" : "s"}.` : "Retrying now…"}`;
}

function semanticIndexSummary(): string {
  return popupState.semanticIndexMeta.status === "idle"
    ? "Not built"
    : popupState.semanticIndexMeta.status === "building"
      ? `${popupState.semanticIndexMeta.ready} of ${popupState.semanticIndexMeta.total} tabs ready${popupState.searchState.local.settings.semanticIndexPaused ? " · paused" : ""}`
      : popupState.semanticIndexMeta.status === "cancelled"
        ? `Cancelled with ${popupState.semanticIndexMeta.ready} of ${popupState.semanticIndexMeta.total} tabs ready · rebuild to index the remainder`
        : popupState.semanticIndexMeta.status === "stale"
          ? "Index is out of date · rebuild with the current provider and privacy settings"
        : popupState.semanticIndexMeta.status === "complete"
          ? `${popupState.semanticIndexMeta.ready} indexed tabs ready`
          : `Stopped · ${popupState.semanticIndexMeta.ready} ready · ${popupState.semanticIndexMeta.failed} failed`;
}

function semanticIndexBuildRequirement(): string | null {
  const settings = popupState.searchState.local.settings;
  if (!settings.semanticEnabled || settings.semanticConsentAt === null) return "Enable and save semantic search before building the index.";
  if (!popupState.searchState.local.embeddingConfig.model) return "Configure an embedding model before building the index.";
  if (!popupState.searchState.local.providerTest) return "Test the embedding provider before building the index.";
  if (popupState.targetWindowId === null) return "Select a normal browser window before building the index.";
  if (popupState.semanticIndexMeta.status === "building") return "Indexing is in progress. Use Cancel before starting a new build.";
  return null;
}

async function buildSemanticIndex(): Promise<void> {
  if (popupState.targetWindowId === null) throw new Error("No browser window is selected for indexing.");
  const response = await send({ type: "semantic-index:build", targetWindowId: popupState.targetWindowId });
  if (!response.ok) throw new Error(response.error);
  if (response.semanticIndexMeta) popupState.semanticIndexMeta = response.semanticIndexMeta;
  semanticIndexClearArmed = false;
  startSemanticIndexPolling();
  popupState.notice = {
    tone: "success",
    text: popupState.semanticIndexMeta.pending > 0
      ? "Semantic indexing started. Direct search remains available."
      : "Semantic index is already ready from cached vectors.",
  };
}

async function cancelSemanticIndexBuild(): Promise<void> {
  const response = await send({ type: "semantic-index:cancel" });
  if (!response.ok) throw new Error(response.error);
  if (response.semanticIndexMeta) popupState.semanticIndexMeta = response.semanticIndexMeta;
  stopSemanticIndexPolling();
  popupState.notice = {
    tone: "info",
    text: "Indexing cancelled. Pending sanitized documents were removed; completed vectors remain cached locally.",
  };
}

async function clearSemanticIndexData(): Promise<void> {
  const response = await send({ type: "semantic-index:clear" });
  if (!response.ok) throw new Error(response.error);
  popupState.semanticIndexMeta = response.semanticIndexMeta ?? { ...EMPTY_SEMANTIC_INDEX_META };
  semanticIndexClearArmed = false;
  stopSemanticIndexPolling();
  popupState.notice = { tone: "success", text: "Semantic index cleared. Direct search is unchanged." };
}

function renderSemanticIndexStatus(): HTMLElement {
  const indexStatus = element("div", "semantic-index-status");
  indexStatus.dataset.semanticIndexStatus = "true";
  const indexStatusHeading = element("div", "semantic-index-status__heading");
  const indexStatusCopy = element("div");
  indexStatusCopy.setAttribute("role", "status");
  indexStatusCopy.setAttribute("aria-live", "polite");
  indexStatusCopy.setAttribute("aria-atomic", "true");
  const summary = element("span", undefined, semanticIndexSummary());
  summary.dataset.semanticIndexSummary = "true";
  indexStatusCopy.append(element("strong", undefined, "Semantic index"), summary);
  const stateLabel = element(
    "span",
    popupState.semanticIndexMeta.status === "complete"
      ? "settings-state settings-state--ready"
      : popupState.semanticIndexMeta.status === "failed" || popupState.semanticIndexMeta.status === "stale"
        ? "settings-state settings-state--warning"
        : "settings-state",
    popupState.semanticIndexMeta.status === "idle" ? "Not built" : popupState.semanticIndexMeta.status[0]!.toLocaleUpperCase() + popupState.semanticIndexMeta.status.slice(1),
  );
  stateLabel.dataset.semanticIndexState = "true";
  indexStatusHeading.append(indexStatusCopy, stateLabel);
  const progress = element("progress", "semantic-index-status__progress");
  progress.max = Math.max(1, popupState.semanticIndexMeta.total);
  progress.value = popupState.semanticIndexMeta.ready + popupState.semanticIndexMeta.excluded + popupState.semanticIndexMeta.failed;
  progress.setAttribute("aria-label", "Semantic index progress");
  progress.dataset.semanticIndexProgress = "true";
  progress.hidden = popupState.semanticIndexMeta.status === "idle" || popupState.semanticIndexMeta.status === "complete";
  const indexCounts = element("dl", "semantic-index-counts");
  indexCounts.hidden = popupState.semanticIndexMeta.status === "idle" || popupState.semanticIndexMeta.status === "complete";
  ([
    ["Ready", popupState.semanticIndexMeta.ready],
    [popupState.semanticIndexMeta.status === "cancelled" ? "Remaining" : "Pending", popupState.semanticIndexMeta.pending],
    ["Excluded", popupState.semanticIndexMeta.excluded],
    ["Failed", popupState.semanticIndexMeta.failed],
  ] as const).forEach(([label, value], index) => {
    const item = element("div");
    const term = element("dt", undefined, label);
    const count = element("dd", undefined, String(value));
    term.dataset.semanticIndexTerm = ["ready", "pending", "excluded", "failed"][index]!;
    count.dataset.semanticIndexCount = ["ready", "pending", "excluded", "failed"][index]!;
    item.append(term, count);
    indexCounts.append(item);
  });
  const directFallback = element("p", "semantic-index-status__fallback", "Direct search remains available while the index builds or if the provider fails.");
  directFallback.hidden = popupState.semanticIndexMeta.status === "complete";
  const errorLabel = semanticIndexErrorLabel(popupState.semanticIndexMeta.lastErrorCode);
  const retryDetail = semanticIndexRetryDetail();
  const requirement = semanticIndexBuildRequirement();
  const guidance = element(
    "p",
    errorLabel ? "semantic-index-status__guidance semantic-index-status__guidance--error" : "semantic-index-status__guidance",
    semanticIndexClearArmed
      ? "Clear removes all locally cached vectors and mappings. Press Confirm clear index to continue."
      : retryDetail ?? errorLabel ?? (popupState.semanticIndexMeta.status === "complete"
        ? "The index stays current automatically as tabs and workspaces change."
        : requirement ?? "The current provider and privacy settings are ready for indexing."),
  );
  guidance.dataset.semanticIndexGuidance = "true";
  const canBuild = requirement === null;
  const hasIndexData = popupState.semanticIndexMeta.modelKey !== null && popupState.semanticIndexMeta.status !== "idle";
  const indexActions = element("div", "settings-actions settings-actions--inline semantic-index-actions");
  const buildIndex = button(hasIndexData ? "Refresh index" : "Build index", "primary", () => {
    void perform("build-semantic-index", buildSemanticIndex);
  }, { disabled: !canBuild, actionName: "build-semantic-index", busyLabel: "Preparing…" });
  buildIndex.dataset.semanticIndexAction = "build";
  buildIndex.hidden = popupState.semanticIndexMeta.status === "complete" || popupState.semanticIndexMeta.status === "building";
  const cancelIndex = button("Cancel", "secondary", () => {
    void perform("cancel-semantic-index", cancelSemanticIndexBuild);
  }, { disabled: popupState.semanticIndexMeta.status !== "building", actionName: "cancel-semantic-index", busyLabel: "Cancelling…" });
  cancelIndex.dataset.semanticIndexAction = "cancel";
  cancelIndex.hidden = popupState.semanticIndexMeta.status !== "building";
  const retryIndex = button(`Retry ${popupState.semanticIndexMeta.pending} remaining now`, "primary", () => {
    void perform("build-semantic-index", buildSemanticIndex);
  }, { actionName: "build-semantic-index", busyLabel: "Retrying…" });
  retryIndex.dataset.semanticIndexAction = "retry";
  retryIndex.hidden = popupState.semanticIndexMeta.status !== "building" || !popupState.semanticIndexMeta.lastErrorCode;
  const clearIndex = button(semanticIndexClearArmed ? "Confirm clear index" : "Clear semantic index", semanticIndexClearArmed ? "danger" : "quiet", () => {
      if (!semanticIndexClearArmed) {
        semanticIndexClearArmed = true;
        patchSemanticIndexStatus(indexStatus);
        queueMicrotask(() => indexStatus.querySelector<HTMLButtonElement>('[data-semantic-index-action="clear"]')?.focus());
        return;
      }
      void perform("clear-semantic-index", clearSemanticIndexData);
    }, { disabled: !hasIndexData, actionName: "clear-semantic-index", busyLabel: "Clearing…" });
  clearIndex.dataset.semanticIndexAction = "clear";
  const rebuildIndex = button("Rebuild index", "secondary", () => {
    void perform("build-semantic-index", buildSemanticIndex);
  }, { disabled: !canBuild, actionName: "rebuild-semantic-index", busyLabel: "Preparing…" });
  rebuildIndex.dataset.semanticIndexAction = "rebuild";
  const manage = element("details", "semantic-index-manage");
  manage.dataset.semanticIndexManage = "true";
  manage.hidden = !hasIndexData || popupState.semanticIndexMeta.status === "building";
  manage.append(
    settingsSummary("Manage index"),
    element("div", "semantic-index-manage__actions"),
  );
  manage.querySelector<HTMLElement>(".semantic-index-manage__actions")?.append(rebuildIndex, clearIndex);
  indexActions.append(buildIndex, retryIndex, cancelIndex, manage);
  indexStatus.append(indexStatusHeading, progress, indexCounts, directFallback, guidance, indexActions);
  return indexStatus;
}

function patchSemanticIndexStatus(indexStatus: HTMLElement): void {
  const summary = indexStatus.querySelector<HTMLElement>("[data-semantic-index-summary]");
  if (summary) summary.textContent = semanticIndexSummary();
  const state = indexStatus.querySelector<HTMLElement>("[data-semantic-index-state]");
  if (state) {
    state.textContent = popupState.semanticIndexMeta.status === "idle"
      ? "Not built"
      : popupState.semanticIndexMeta.status[0]!.toLocaleUpperCase() + popupState.semanticIndexMeta.status.slice(1);
    state.className = popupState.semanticIndexMeta.status === "complete"
      ? "settings-state settings-state--ready"
      : popupState.semanticIndexMeta.status === "failed" || popupState.semanticIndexMeta.status === "stale"
        ? "settings-state settings-state--warning"
        : "settings-state";
  }
  const progress = indexStatus.querySelector<HTMLProgressElement>("[data-semantic-index-progress]");
  if (progress) {
    progress.max = Math.max(1, popupState.semanticIndexMeta.total);
    progress.value = popupState.semanticIndexMeta.ready + popupState.semanticIndexMeta.excluded + popupState.semanticIndexMeta.failed;
    progress.hidden = popupState.semanticIndexMeta.status === "idle" || popupState.semanticIndexMeta.status === "complete";
  }
  const indexCounts = indexStatus.querySelector<HTMLElement>(".semantic-index-counts");
  if (indexCounts) indexCounts.hidden = popupState.semanticIndexMeta.status === "idle" || popupState.semanticIndexMeta.status === "complete";
  const directFallback = indexStatus.querySelector<HTMLElement>(".semantic-index-status__fallback");
  if (directFallback) directFallback.hidden = popupState.semanticIndexMeta.status === "complete";
  const counts = {
    ready: popupState.semanticIndexMeta.ready,
    pending: popupState.semanticIndexMeta.pending,
    excluded: popupState.semanticIndexMeta.excluded,
    failed: popupState.semanticIndexMeta.failed,
  };
  (Object.entries(counts) as [keyof typeof counts, number][]).forEach(([key, value]) => {
    const count = indexStatus.querySelector<HTMLElement>(`[data-semantic-index-count="${key}"]`);
    if (count) count.textContent = String(value);
  });
  const pendingTerm = indexStatus.querySelector<HTMLElement>('[data-semantic-index-term="pending"]');
  if (pendingTerm) pendingTerm.textContent = popupState.semanticIndexMeta.status === "cancelled" ? "Remaining" : "Pending";
  const errorLabel = semanticIndexErrorLabel(popupState.semanticIndexMeta.lastErrorCode);
  const retryDetail = semanticIndexRetryDetail();
  const requirement = semanticIndexBuildRequirement();
  const guidance = indexStatus.querySelector<HTMLElement>("[data-semantic-index-guidance]");
  if (guidance) {
    guidance.className = errorLabel
      ? "semantic-index-status__guidance semantic-index-status__guidance--error"
      : "semantic-index-status__guidance";
    guidance.textContent = semanticIndexClearArmed
      ? "Clear removes all locally cached vectors and mappings. Press Confirm clear index to continue."
      : retryDetail ?? errorLabel ?? (popupState.semanticIndexMeta.status === "complete"
        ? "The index stays current automatically as tabs and workspaces change."
        : requirement ?? "The current provider and privacy settings are ready for indexing.");
  }
  const build = indexStatus.querySelector<HTMLButtonElement>('[data-semantic-index-action="build"]');
  if (build) {
    const hasIndexData = popupState.semanticIndexMeta.modelKey !== null && popupState.semanticIndexMeta.status !== "idle";
    build.textContent = hasIndexData ? "Refresh index" : "Build index";
    build.disabled = requirement !== null || busyAction !== null;
    build.hidden = popupState.semanticIndexMeta.status === "complete" || popupState.semanticIndexMeta.status === "building";
  }
  const cancel = indexStatus.querySelector<HTMLButtonElement>('[data-semantic-index-action="cancel"]');
  if (cancel) {
    cancel.disabled = popupState.semanticIndexMeta.status !== "building" || busyAction !== null;
    cancel.hidden = popupState.semanticIndexMeta.status !== "building";
  }
  const retry = indexStatus.querySelector<HTMLButtonElement>('[data-semantic-index-action="retry"]');
  if (retry) {
    retry.textContent = `Retry ${popupState.semanticIndexMeta.pending} remaining now`;
    retry.disabled = busyAction !== null;
    retry.hidden = popupState.semanticIndexMeta.status !== "building" || !popupState.semanticIndexMeta.lastErrorCode;
  }
  const manage = indexStatus.querySelector<HTMLElement>("[data-semantic-index-manage]");
  if (manage) {
    manage.hidden = popupState.semanticIndexMeta.modelKey === null || popupState.semanticIndexMeta.status === "idle" || popupState.semanticIndexMeta.status === "building";
  }
  const rebuild = indexStatus.querySelector<HTMLButtonElement>('[data-semantic-index-action="rebuild"]');
  if (rebuild) rebuild.disabled = requirement !== null || busyAction !== null;
  const clear = indexStatus.querySelector<HTMLButtonElement>('[data-semantic-index-action="clear"]');
  if (clear) {
    clear.textContent = semanticIndexClearArmed ? "Confirm clear index" : "Clear semantic index";
    clear.className = `button button--${semanticIndexClearArmed ? "danger" : "quiet"}`;
    clear.disabled = popupState.semanticIndexMeta.modelKey === null || popupState.semanticIndexMeta.status === "idle" || busyAction !== null;
  }
}

export function renderSearchSettings(category: HTMLElement): void {
  const settings = popupState.searchState.local.settings;
  const config = popupState.searchState.local.embeddingConfig;
  const scopeSelect = (selected: string): HTMLSelectElement => {
    const node = element("select", "input");
    ([["current_window", "Current window"], ["all_windows", "All windows"]] as const).forEach(([value, label]) => {
      const option = element("option", undefined, label);
      option.value = value;
      option.selected = selected === value;
      node.append(option);
    });
    return node;
  };
  const defaultScope = scopeSelect(settings.defaultScope);
  const includeGroups = check("Match group names", "Finds tabs by the name of their Chrome group.", settings.includeGroupNames);
  const closeAfterFocus = check(
    "Return to Sheaf after switching to a tab",
    "Only when Search is open in a full tab; the popup always closes.",
    settings.closeAfterFocus,
  );
  const direct = element("section", "settings-group");
  direct.append(
    element("h3", undefined, "Direct search"),
    element("p", "settings-group__copy", "Matches titles and addresses. Always local."),
    field("Search in", defaultScope),
    includeGroups.wrapper,
    closeAfterFocus.wrapper,
  );

  const semanticEnabled = check(
    "Use semantic search",
    "Adds related results, like “flights” finding an airline tab. Sends sanitized tab details to your embeddings model.",
    settings.semanticEnabled,
  );
  const consent = check(
    "I understand what semantic search sends",
    "Sanitized titles and addresses, never page contents. The embeddings model's own retention policy applies.",
    settings.semanticConsentAt !== null,
  );
  const semanticAlways = check(
    "Always include related results",
    "Off: only when direct results are weak.",
    settings.semanticAlways,
  );
  const semanticWhenWeak = check(
    "Add related results when direct results are weak",
    "Exact matches never call the embeddings model.",
    settings.semanticWhenDirectWeak,
  );
  const semanticGroups = check(
    // Deliberately not "Match group names…": that's the direct-search setting's label.
    "Index group names too",
    "Group names are good topic labels, so related results improve.",
    settings.semanticIncludeGroupNames,
  );
  const semanticRerank = check(
    "Break near-ties with the organizing model",
    "When two results score almost the same, asks the organizing model to order them.",
    settings.semanticRerank,
  );
  const indexScope = scopeSelect(settings.semanticIndexScope);
  // The options below only apply once semantic search is on.
  const semanticOptions = element("div", "semantic-options");
  semanticOptions.append(
    semanticAlways.wrapper,
    semanticWhenWeak.wrapper,
    field("Index tabs in", indexScope),
    semanticGroups.wrapper,
  );
  const semantic = element("section", "settings-group");
  semantic.append(
    element("h3", undefined, "Semantic search"),
    semanticEnabled.wrapper,
    consent.wrapper,
    semanticOptions,
  );
  const semanticIndexStatus = renderSemanticIndexStatus();
  semanticOptions.append(semanticIndexStatus);
  // The connection lives in Connections; this row says whether search can use it.
  const embeddingStatus = embeddingProviderStatus();
  const embeddingLink = element("div", "settings-tool-links");
  embeddingLink.append(providerLinkRow(lineIcon, {
    id: "embedding",
    title: "Embeddings model",
    status: embeddingStatus.state,
    detail: config.model ? `${config.model} · ${config.origin}` : "Semantic search needs this connection",
  }));
  semantic.append(embeddingLink);
  const advanced = advancedDisclosure("search", "Tie-breaking with the organizing model", [semanticRerank.wrapper]);
  const syncSemanticOptions = (): void => {
    const on = semanticEnabled.control.checked;
    semanticOptions.hidden = !on;
    advanced.hidden = !on;
    consent.wrapper.hidden = !on || popupState.searchState.local.settings.semanticConsentAt !== null;
  };
  semanticEnabled.control.addEventListener("change", syncSemanticOptions);
  syncSemanticOptions();

  let searchAutosaveTimer: ReturnType<typeof setTimeout> | null = null;
  const persistSearchSettings = async (): Promise<void> => {
    if (
      semanticEnabled.control.checked &&
      popupState.searchState.local.settings.semanticConsentAt === null &&
      !consent.control.checked
    ) {
      markSettingsError("Confirm what semantic search sends to turn it on.");
      return;
    }
    await trackSettingsSave(async () => {
      popupState.searchState = await writeSearchSettings({
        ...popupState.searchState.local.settings,
        defaultScope: defaultScope.value === "all_windows" ? "all_windows" : "current_window",
        includeGroupNames: includeGroups.control.checked,
        closeAfterFocus: closeAfterFocus.control.checked,
        semanticEnabled: semanticEnabled.control.checked,
        semanticConsentAt: popupState.searchState.local.settings.semanticConsentAt ?? (semanticEnabled.control.checked ? Date.now() : null),
        semanticAlways: semanticAlways.control.checked,
        semanticWhenDirectWeak: semanticWhenWeak.control.checked,
        semanticIncludeGroupNames: semanticGroups.control.checked,
        semanticRerank: semanticRerank.control.checked,
        semanticIndexScope: indexScope.value === "current_window" ? "current_window" : "all_windows",
      });
      setSearchScope(popupState.searchState.local.settings.defaultScope);
      syncSemanticOptions();
      if (!semanticEnabled.control.checked && popupState.semanticIndexMeta.status === "building") {
        const response = await send({ type: "semantic-index:cancel" });
        if (!response.ok) throw new Error(`Saved, but indexing could not be stopped: ${response.error}`);
        if (response.semanticIndexMeta) popupState.semanticIndexMeta = response.semanticIndexMeta;
        stopSemanticIndexPolling();
      }
      patchSemanticIndexStatus(semanticIndexStatus);
    }).catch(() => undefined);
  };
  const scheduleSearchAutosave = (): void => {
    markSettingsSaving();
    if (searchAutosaveTimer) clearTimeout(searchAutosaveTimer);
    searchAutosaveTimer = setTimeout(() => {
      searchAutosaveTimer = null;
      void persistSearchSettings();
    }, 350);
  };
  [defaultScope, includeGroups.control, closeAfterFocus.control, semanticEnabled.control, semanticWhenWeak.control,
    semanticAlways.control, semanticGroups.control, semanticRerank.control, indexScope, consent.control]
    .forEach((control) => control.addEventListener("change", scheduleSearchAutosave));
  category.append(direct, semantic, advanced);
}

export function embeddingProviderStatus(): ConnectionStatus {
  const config = popupState.searchState.local.embeddingConfig;
  const test = popupState.searchState.local.providerTest;
  if (test) {
    return {
      state: "ready",
      text: `Verified · ${test.model} · ${test.dimensions} dimensions · ${test.latencyMs} ms · provider retention not verified${embeddingVerificationCaveats(test)}`,
    };
  }
  return config.model
    ? { state: "unverified", text: "Saved · not verified. Semantic search stays unavailable until it is." }
    : { state: "unset", text: "Not set up. Only semantic search uses this connection." };
}

export function renderEmbeddingProviderSettings(): HTMLElement {
  const config = popupState.searchState.local.embeddingConfig;
  const settings = popupState.searchState.local.settings;
  const sessionKey = popupState.searchState.session.apiKey;
  const embeddingProfile = element("select", "input");
  ([
    ["auto", `Auto-detect${config.model ? ` (${detectedEmbeddingProfileId(config.model)})` : ""}`],
    ["none", "None (send text unchanged)"],
    ["e5", "E5 (passage / query prefixes)"],
    ["qwen3", "Qwen3 Embedding (instruction prefix)"],
    ["cohere", "Cohere (input_type per call)"],
    ["voyage", "Voyage (input_type per call)"],
    ["gemini", "Gemini (taskType per call)"],
  ] as const).forEach(([value, label]) => {
    const option = element("option", undefined, label);
    option.value = value;
    option.selected = value === config.modelProfile;
    embeddingProfile.append(option);
  });
  const dimensions = input(config.dimensions === null ? "" : String(config.dimensions), "number");
  dimensions.min = "1";
  dimensions.max = "65536";
  const form = renderProviderConnection({ input, field, check, button, settingsSummary, settingsEditChip, perform }, {
    id: "embedding",
    title: "Embeddings model",
    purpose: "An embeddings model that turns tab titles into vectors for semantic search. Separate from the organizing model, though it can be the same service.",
    summary: config.model ? `${config.model} · ${config.origin}` : "Optional · only semantic search uses it",
    status: embeddingProviderStatus(),
    open: !config.model && settings.semanticEnabled,
    origin: config.model ? config.origin : "",
    endpointPath: config.endpointPath,
    defaultPath: () => "/v1/embeddings",
    model: config.model,
    modelPlaceholder: "The embeddings model your service offers",
    modelExtras: [
      field("Model family", embeddingProfile, "How text is prefixed for this family. Auto-detect reads the model name."),
    ],
    key: {
      saved: sessionKey !== "",
      persistent: config.apiKeyStorage === "persistent",
      optional: true,
    },
    advanced: {
      customHeaders: popupState.searchState.session.customHeaders,
      extraBody: config.extraBody,
      timeoutMs: { value: config.timeoutMs, default: 30_000, max: 120_000 },
      customized: config.dimensions !== null,
      extras: [field("Dimensions", dimensions, "Optional. Leave blank to use the model's default size.")],
    },
    openRouter: { preferences: config.openRouter },
    saveCopy: "Chrome may ask for access to this site, then Sheaf embeds one test phrase.",
    forgetKey: async () => {
      popupState.searchState = await writeEmbeddingProvider({
        config: { ...config, apiKeyStorage: "session" },
        apiKey: "",
        customHeaders: popupState.searchState.session.customHeaders,
      });
      popupState.notice = { tone: "info", text: "Embeddings model API key forgotten. Save and verify a key to use semantic search again." };
    },
    save: async (values) => {
      const next = normalizeEmbeddingConfig({
        origin: values.origin,
        endpointPath: values.endpointPath,
        model: values.model,
        dimensions: dimensions.value.trim() ? Number(dimensions.value) : null,
        apiKeyStorage: values.persistKey ? "persistent" : "session",
        modelProfile: normalizeEmbeddingProfileId(embeddingProfile.value),
        customHeaders: values.customHeaders,
        extraBody: values.extraBody,
        openRouter: values.openRouter,
        timeoutMs: values.timeoutMs ?? 30_000,
      });
      const endpoint = normalizeProviderEndpoint(next.origin, next.endpointPath);
      const granted = await chrome.permissions.request({ origins: [endpoint.permissionPattern] });
      if (!granted) throw new Error("Chrome didn't grant access to the embeddings model's site.");
      popupState.searchState = await writeEmbeddingProvider({
        config: next,
        apiKey: resolveApiKey(values.typedApiKey, { origin: config.origin, apiKey: sessionKey }, next.origin),
        customHeaders: values.customHeaders,
      });
      const current = await readSearchState();
      try {
        const result = await new OpenAICompatibleEmbeddingClient().test(
          { ...current.local.embeddingConfig, customHeaders: current.session.customHeaders },
          current.session.apiKey,
        );
        popupState.searchState = await writeEmbeddingProviderTest(result);
        popupState.notice = {
          tone: result.dimensionsHonored === false ? "info" : "success",
          text: `Embeddings model saved and verified: ${result.dimensions} dimensions in ${result.latencyMs} ms.${embeddingVerificationCaveats(result)}`,
        };
      } catch (error) {
        const { origin, endpointPath, model } = current.local.embeddingConfig;
        throw new Error(`Embeddings model saved, but the check failed. ${describeEmbeddingTestFailure(error, `${origin}${endpointPath}`, model)}`);
      }
    },
  });
  [embeddingProfile, dimensions].forEach((control) => control.addEventListener("input", form.markDirty));
  return form.node;
}


const REQUEST_DETAIL_LABELS: Record<PrivacySettings["level"], string> = {
  1: "Titles + domains",
  2: "Titles + route context",
  3: "Titles + hostnames + full paths",
};

// Readable is the default; JSON stays one click away and is the exact payload.
export function renderRequestPreviewBody(
  bundle: ImmutableRequestBundle,
  level: PrivacySettings["level"],
): HTMLElement {
  const body = element("div", "privacy-request-preview__body");
  const modes = element("div", "privacy-request-preview__modes");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Preview format");
  const readable = renderReadableRequest(bundle, level);
  const json = element("div", "privacy-request-preview__json");
  json.append(
    element(
      "p",
      "privacy-request-preview__copy",
      `This is the exact sanitized JSON built from your open tabs. Temporary IDs replace browser tab IDs.${privacyLevelCaveat(level)}`,
    ),
    element("pre", undefined, bundle.requestJson),
  );
  const controls: HTMLButtonElement[] = [];
  const sync = (): void => {
    readable.hidden = requestPreviewMode !== "readable";
    json.hidden = requestPreviewMode !== "json";
    controls.forEach((control) => {
      const active = control.dataset.previewMode === requestPreviewMode;
      control.classList.toggle("privacy-request-preview__mode--active", active);
      control.setAttribute("aria-pressed", String(active));
    });
  };
  ([["readable", "Readable"], ["json", "JSON"]] as const).forEach(([mode, label]) => {
    const control = element("button", "privacy-request-preview__mode", label);
    control.type = "button";
    control.dataset.previewMode = mode;
    control.addEventListener("click", () => {
      requestPreviewMode = mode;
      sync();
    });
    controls.push(control);
    modes.append(control);
  });
  body.append(modes, readable, json);
  sync();
  return body;
}

function renderReadableRequest(
  bundle: ImmutableRequestBundle,
  level: PrivacySettings["level"],
): HTMLElement {
  const request = bundle.approvedRequest;
  const view = element("div", "privacy-request-preview__readable");
  view.append(
    element(
      "p",
      "privacy-request-preview__copy",
      `Each row is a tab as the provider will see it. Full URLs and browser tab IDs stay on this device.${privacyLevelCaveat(level)}`,
    ),
  );
  const facts = element("dl", "privacy-request-facts");
  const fact = (label: string, value: string): void => {
    const row = element("div");
    row.append(element("dt", undefined, label), element("dd", undefined, value));
    facts.append(row);
  };
  fact("Detail", REQUEST_DETAIL_LABELS[request.privacyLevel]);
  fact("Group names", request.existingGroupMetadataIncluded ? "Included" : "Not sent");
  fact("New group colors", request.groupColorMode === "ai" ? "AI picks" : "From title");
  const ruleCount = request.organizerRules?.length ?? 0;
  if (ruleCount > 0) fact("Your rules", String(ruleCount));
  const preferredCount = request.preferredGroupNames?.length ?? 0;
  if (preferredCount > 0) fact("Preferred names", String(preferredCount));
  view.append(facts);

  const sentList = element("ul", "privacy-request-list");
  request.tabs.forEach((tab) => {
    const item = element("li", "privacy-request-tab");
    const location = tab.hostname ? `${tab.hostname}${tab.path ?? ""}` : tab.domain;
    item.append(
      element("span", "privacy-request-tab__title", tab.title || "Untitled"),
      element("span", "privacy-request-tab__location", location),
    );
    const tags: string[] = [];
    if (tab.existingGroup) tags.push(`In “${tab.existingGroup}”`);
    if (tab.duplicateOfTabId !== undefined) tags.push("Duplicate");
    if (tab.isActive) tags.push("Active");
    if (tab.isAudible) tags.push("Playing audio");
    if (tags.length > 0) {
      const tagRow = element("span", "privacy-request-tab__tags");
      tags.forEach((tag) => tagRow.append(element("span", "privacy-request-tab__tag", tag)));
      item.append(tagRow);
    }
    sentList.append(item);
  });
  view.append(
    element("h4", "privacy-request-list__heading", `Sent · ${request.tabs.length}`),
    sentList,
  );

  if (bundle.excludedTabs.length > 0) {
    // Excluded titles are shown locally only; they are never part of the request.
    const excluded = element("details", "privacy-request-excluded");
    excluded.append(
      element("summary", undefined, `Kept on this device · ${bundle.excludedTabs.length}`),
    );
    const excludedList = element("ul", "privacy-request-list");
    bundle.excludedTabs.forEach((tab) => {
      const item = element("li", "privacy-request-tab");
      item.append(
        element("span", "privacy-request-tab__title", tab.title || "Untitled"),
        element("span", "privacy-request-tab__location", tab.reason),
      );
      excludedList.append(item);
    });
    excluded.append(excludedList);
    view.append(excluded);
  }
  return view;
}

async function generateProposal(): Promise<void> {
  organizeStartedAt = performance.now();
  cleanupReviewOpen = false;
  cleanupReviewDismissed = false;
  selectedCleanupTabIds.clear();
  cleanupCloseArmed = false;
  popupState.discardedPlanReason = null;
  await ensureProviderReady();
  await initializeTarget();
  await rebuildRequest();
  if (!popupState.organizerData || !popupState.immutableRequest || popupState.targetWindowId === null) {
    throw new Error(requestBuildError ?? "No tabs in this window can be organized with the current settings.");
  }
  popupState.proposalReview = null;
  const response = await send({
    type: "organization:generate",
    targetWindowId: popupState.targetWindowId,
    scope: organizationScope,
  });
  popupState.viewState = response.state;
  if (!response.ok) throw new Error(response.error);
  await followBackgroundOrganize();
}

const BACKGROUND_POLL_MS = 300;

/**
 * Waits for the service worker's organize job. The job keeps running if this
 * popup closes; reopening the popup calls this again to pick it back up.
 */
async function followBackgroundOrganize(): Promise<void> {
  try {
    await followBackgroundOrganizeUntilSettled();
  } finally {
    // This popup has just shown the outcome; a stored copy would repeat it next open.
    await takeBackgroundError().catch(() => null);
  }
}

let stopOrganizeTabWatch: (() => void) | null = null;
let organizeTabWarning: { tone: "info"; text: string } | null = null;

/**
 * Warns as soon as a submitted tab changes while the plan is being made. The
 * worker's drift check would otherwise only report it once the model answers.
 */
function watchTabsDuringOrganize(request: ImmutableRequestBundle | null): void {
  if (stopOrganizeTabWatch || !request) return;
  const watched = new Set(Object.values(request.ephemeralToBrowserTabId));
  if (watched.size === 0) return;
  const warn = (tabId: number): void => {
    if (!watched.has(tabId)) return;
    void (async () => {
      // The worker records the apply's transaction before it moves any tab, so
      // a change seen after that is its own work, not drift. The poll lags it.
      const job = (await readOrganizerState()).session.providerJob;
      if (!stopOrganizeTabWatch || job?.status !== "requesting" || job.transactionId) return;
      stop();
      organizeTabWarning = {
        tone: "info",
        text: popupState.organizerData?.local.workflow.organizeWithoutReview === true
          ? "Tabs changed while organizing. This plan was made for the old tabs, so it will likely stop without moving anything. Cancel and organize again to include the change."
          : "Tabs changed while organizing. The plan will be checked against your current tabs before you can apply it.",
      };
      popupState.notice = organizeTabWarning;
      render();
    })();
  };
  const onRemoved = (tabId: number): void => warn(tabId);
  const onDetached = (tabId: number): void => warn(tabId);
  const onUpdated = (tabId: number, change: chrome.tabs.OnUpdatedInfo): void => {
    if (change.url !== undefined || change.groupId !== undefined || change.pinned !== undefined) warn(tabId);
  };
  const stop = (): void => {
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.tabs.onDetached.removeListener(onDetached);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    stopOrganizeTabWatch = null;
  };
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onDetached.addListener(onDetached);
  chrome.tabs.onUpdated.addListener(onUpdated);
  stopOrganizeTabWatch = stop;
}

async function followBackgroundOrganizeUntilSettled(): Promise<void> {
  organizeTabWarning = null;
  try {
    await pollBackgroundOrganize();
  } finally {
    stopOrganizeTabWatch?.();
  }
}

async function pollBackgroundOrganize(): Promise<void> {
  const deadline = Date.now() + LIMITS.MANUAL_TOTAL_DEADLINE_MS + ORGANIZATION_TRANSACTION.MAX_POLL_MS;
  // A run applied after this point is this job's, if another view clears the job first.
  const priorTransactionId = popupState.viewState.transactionRun?.transactionId ?? null;
  let shownRunning = false;
  while (true) {
    popupState.organizerData = await readOrganizerState();
    const job = popupState.organizerData.session.providerJob;
    popupState.providerJob = job;
    if (job?.status === "requesting" && !job.transactionId) {
      // The worker stores its own request before marking the job requesting.
      watchTabsDuringOrganize(popupState.organizerData.session.immutableRequest);
      // Re-render once the job is visible so its Cancel control appears.
      if (!shownRunning) {
        shownRunning = true;
        render();
      }
      if (Date.now() >= deadline) {
        throw new Error("Organizing is taking longer than expected. Reopen the popup to check on it.");
      }
      await new Promise((resolve) => setTimeout(resolve, BACKGROUND_POLL_MS));
      continue;
    }
    if (!job) {
      // Another open view (the toolbar popup or the organize window) saw the
      // run end first and cleared the job after showing its outcome.
      await settleJobClearedElsewhere(priorTransactionId);
      return;
    }
    if (job.ownerContextId !== BACKGROUND_JOB_OWNER) {
      throw new Error("The organize request was replaced by another one.");
    }
    if (job.status === "cancelled") {
      popupState.providerJob = null;
      await clearProviderJob();
      popupState.notice = { tone: "info", text: "Organizing cancelled. Nothing moved." };
      return;
    }
    if (job.status !== "validated") {
      popupState.providerJob = null;
      await clearProviderJob();
      throw new Error(job.error ?? "Organizing failed. Nothing moved.");
    }
    if (job.transactionId) {
      popupState.providerJob = null;
      await clearProviderJob();
      await followOrganizationTransaction(job.transactionId);
      // The plan applied after all, so a "will likely stop" warning is moot.
      if (popupState.notice === organizeTabWarning) popupState.notice = null;
      return;
    }
    popupState.proposalReview = await readProposalReview();
    if (!popupState.proposalReview) throw new Error("The plan finished but could not be loaded. Organize again.");
    popupState.immutableRequest = popupState.proposalReview.request;
    organizationScope = popupState.proposalReview.request.scope ?? WHOLE_WINDOW_SCOPE;
    return;
  }
}

async function settleJobClearedElsewhere(priorTransactionId: string | null): Promise<void> {
  popupState.providerJob = null;
  const review = await readProposalReview();
  if (review) {
    popupState.proposalReview = review;
    popupState.immutableRequest = review.request;
    organizationScope = review.request.scope ?? WHOLE_WINDOW_SCOPE;
    return;
  }
  const state = await send({ type: "window-capture:get-state" });
  if (!state.ok) return;
  popupState.viewState = state.state;
  const run = state.state.transactionRun;
  if (run && run.transactionId !== priorTransactionId) {
    await followOrganizationTransaction(run.transactionId);
    if (popupState.notice === organizeTabWarning) popupState.notice = null;
  }
}

/**
 * Clears a background job that ended while no popup was watching and returns
 * its error, if any, so the user still sees why nothing changed.
 */
async function settleFinishedBackgroundJob(): Promise<string | null> {
  const job = popupState.providerJob;
  if (!job || job.ownerContextId !== BACKGROUND_JOB_OWNER || job.status === "requesting") return null;
  if (job.status === "validated" && !job.transactionId) return null;
  if (job.transactionId) {
    const run = popupState.viewState.transactionRun;
    if (run?.transactionId !== job.transactionId || !TERMINAL_RUN_STATUSES.includes(run.status)) return null;
    if (run.status === "completed") visibleResultTransactionId = run.transactionId;
  }
  popupState.providerJob = null;
  await clearProviderJob();
  return job.status === "failed" ? job.error : null;
}

function hasErrorNotice(): boolean {
  return popupState.notice?.tone === "error";
}

function backgroundJobInFlight(): boolean {
  return popupState.providerJob?.ownerContextId === BACKGROUND_JOB_OWNER &&
    (popupState.providerJob.status === "requesting" || Boolean(popupState.providerJob.transactionId));
}

function cancelBackgroundOrganize(): void {
  void send({ type: "organization:cancel-generate" }).catch(() => undefined);
}

async function updateReview(
  update: (state: ProposalReviewState) => ProposalReviewState,
): Promise<void> {
  if (!popupState.proposalReview) throw new Error("No proposal is available.");
  popupState.proposalReview = update(popupState.proposalReview);
  await writeProposalReview(popupState.proposalReview);
}

function renderReview(shell: HTMLElement): void {
  if (!popupState.proposalReview || !popupState.immutableRequest) return;
  const reviewRequest = popupState.immutableRequest;
  const content = element("section", "review");
  const requestTabs = new Map(
    popupState.immutableRequest.approvedRequest.tabs.map((tab) => [tab.id, tab]),
  );
  const proposalDiff = buildProposalDiff(
    popupState.proposalReview.inputSnapshot.browserState,
    popupState.immutableRequest,
    popupState.proposalReview.proposal,
  );
  const changedGroups = changedProposalGroups(proposalDiff);
  const changedGroupIds = new Set(changedGroups.map((group) => group.temporaryId));
  const visibleProposalGroups = popupState.proposalReview.proposal.groups.filter((group) =>
    changedGroupIds.has(group.temporaryId),
  );
  const groupCount = visibleProposalGroups.length;
  // A small plan opens every slot; a large one starts as a scannable frame.
  if (expandedReviewId !== popupState.proposalReview.reviewId) {
    expandedReviewId = popupState.proposalReview.reviewId;
    expandedReviewGroupIds.clear();
    selectedReviewTabIds.clear();
    if (groupCount <= 3) visibleProposalGroups.forEach((group) => expandedReviewGroupIds.add(group.temporaryId));
  }
  const blankTabs = closableBlankTabs();
  const movedTabCount = proposalDiff.counts.moved;
  const heldCount = popupState.immutableRequest.excludedTabs.length + (popupState.immutableRequest.outOfScopeTabCount ?? 0);
  const mutationSummary = [
    movedTabCount > 0 ? `${formatCount(movedTabCount, "tab")} moved` : null,
    blankTabs.length > 0 ? `${formatCount(blankTabs.length, "blank tab")} closed` : null,
    groupCount > 0 ? `${formatCount(groupCount, "group")} changed` : null,
    heldCount > 0 ? `${heldCount} held` : null,
  ].filter(Boolean).join(" · ");
  const applyLabel = groupCount > 0 || blankTabs.length > 0
    ? "Apply plan"
    : "No grouping changes";
  const applyDisabled =
    popupState.proposalReview.validationIssues.length > 0 ||
    popupState.proposalReview.regenerationReasons.length > 0 ||
    popupState.proposalReview.signalAcknowledgementRequired ||
    (groupCount === 0 && blankTabs.length === 0);

  const heading = element("div", "review-heading");
  heading.append(
    element("h2", undefined, "Review plan"),
    element("p", "count-badge", mutationSummary || "No browser changes"),
  );
  // Coverage earns a line only when it says something the slots don't: that some
  // ungrouped tabs were left where they are.
  const { newlyGrouped, eligibleUngroupedSubmitted } = proposalDiff.coverage;
  if (eligibleUngroupedSubmitted > 0 && newlyGrouped < eligibleUngroupedSubmitted) {
    heading.append(element("p", "review-heading__coverage", `${describeUngroupedCoverage(proposalDiff.coverage)}.`));
  }
  content.append(heading);

  // Anything that blocks or qualifies Apply is read before the slots, never under the foot.
  const issues = [
    ...popupState.proposalReview.validationIssues,
    ...popupState.proposalReview.regenerationReasons,
    ...popupState.proposalReview.driftWarnings,
  ];
  if (issues.length > 0) {
    const warning = element("div", "review-warning");
    warning.setAttribute("role", "alert");
    warning.append(element("strong", undefined, "Review current changes"));
    const list = element("ul");
    issues.forEach((issue) => list.append(element("li", undefined, issue)));
    warning.append(list);
    content.append(warning);
  }

  const groupChanges = new Map(
    proposalDiff.groups.map((group) => [group.temporaryId, group]),
  );
  const movedTabs = new Map(
    proposalDiff.tabs.filter((tab) => tab.kind === "moved").map((tab) => [tab.tabId, tab]),
  );
  const colorLabel = (color: ChromeGroupColor): string =>
    `${color[0]!.toLocaleUpperCase()}${color.slice(1)}`;
  const destinations = [
    ...popupState.proposalReview.proposal.groups.map((group) => ({
      value: group.temporaryId,
      label: group.title,
    })),
    { value: "untouched", label: "Keep current placement" },
  ];
  const largestSlot = Math.max(1, ...visibleProposalGroups.map((group) => group.tabIds.length));

  const renderTab = (tabId: number, destination: string): HTMLElement => {
    const tab = requestTabs.get(tabId);
    const moved = movedTabs.get(tabId);
    const row = element("li", `review-tab${moved ? " review-tab--moved" : ""}`);
    const tabCopy = element("div", "review-tab__copy");
    const location = element("span", undefined, tab ? shortLocation(tab) : "Unavailable");
    // The group already says where its tabs came from when there is one source;
    // a row repeats it only when it differs.
    const groupChange = groupChanges.get(destination);
    const groupSource = groupChange && !groupChange.renamedFrom && groupChange.beforeTitles.length <= 1
      ? groupChange.beforeTitles[0] ?? "Ungrouped"
      : null;
    if (moved && moved.from !== groupSource) location.append(" · ", element("span", "review-tab__from", `from ${moved.from}`));
    tabCopy.append(element("strong", undefined, tab?.title ?? `Tab ${tabId}`), location);
    const select = element("select", "move-select");
    select.setAttribute("aria-label", `Move ${tab?.title ?? `tab ${tabId}`}`);
    select.dataset.actionName = `review-tab-${tabId}`;
    // The destinations are already known, so the select is populated eagerly.
    destinations.forEach((item) => {
      const option = element("option", undefined, item.label || "Untitled group");
      option.value = item.value;
      option.selected = item.value === destination;
      select.append(option);
    });
    select.addEventListener("change", () => {
      void perform("edit", async () => {
        await updateReview((state) => moveProposedTab(state, tabId, select.value));
        if (tab) {
          const pattern = locationPattern(tab);
          if (select.value === "untouched") {
            pendingOrganizerRule = {
              id: crypto.randomUUID(),
              kind: "keep_location",
              locationPattern: pattern,
            };
          } else {
            const groupName = destinations.find((item) => item.value === select.value)?.label.trim();
            if (groupName) {
              pendingOrganizerRule = {
                id: crypto.randomUUID(),
                kind: "assign_location",
                locationPattern: pattern,
                groupName,
              };
            }
          }
        }
      });
    });
    const selectable = element("input", "review-tab__select");
    selectable.type = "checkbox";
    selectable.checked = selectedReviewTabIds.has(tabId);
    selectable.dataset.focusKey = `review-tab-select-${tabId}`;
    selectable.setAttribute("aria-label", `Select ${tab?.title ?? `tab ${tabId}`} for a bulk move`);
    selectable.addEventListener("change", () => {
      if (selectable.checked) selectedReviewTabIds.add(tabId);
      else selectedReviewTabIds.delete(tabId);
      render();
    });
    row.append(selectable, tabCopy, select);
    return row;
  };

  const slots = element("div", "review-slots");
  visibleProposalGroups.forEach((group) => {
    const change = groupChanges.get(group.temporaryId);
    const details = element("details", "review-group");
    details.style.setProperty("--slot", `var(--group-${change?.color ?? "grey"})`);
    details.open = expandedReviewGroupIds.has(group.temporaryId);
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      if (details.open) expandedReviewGroupIds.add(group.temporaryId);
      else expandedReviewGroupIds.delete(group.temporaryId);
    });
    const summary = element("summary", "review-group__summary slot");
    const name = element("span", "slot__name");
    name.append(element("strong", undefined, group.title || "Untitled group"));
    const meta = element("span", "review-group__meta");
    change?.kinds.filter((kind) => kind !== "unchanged").forEach((kind) =>
      meta.append(element("span", `diff-badge diff-badge--${kind}`, diffKindLabel(kind))),
    );
    const movedInGroup = group.tabIds.filter((tabId) => movedTabs.has(tabId)).length;
    if (movedInGroup > 0) meta.append(element("span", "review-group__moved", `${movedInGroup} moved in`));
    name.append(meta);
    summary.append(
      name,
      slotBar(group.tabIds.length, largestSlot),
      element("span", "slot__count", String(group.tabIds.length)),
      element("span", "visually-hidden", group.tabIds.length === 1 ? "tab" : "tabs"),
    );

    const body = element("div", "review-group__body");
    const titleRow = element("div", "review-group__header");
    const title = input(group.title);
    title.className = "group-title";
    title.setAttribute("aria-label", `Group name: ${group.title}`);
    title.dataset.actionName = `review-group-title-${group.temporaryId}`;
    title.addEventListener("change", () => {
      expandedReviewGroupIds.add(group.temporaryId);
      void perform("edit", async () => {
        const previousTitle = group.title.trim();
        await updateReview((state) =>
          renameProposedGroup(state, group.temporaryId, title.value),
        );
        const nextTitle = title.value.trim();
        if (previousTitle && nextTitle && previousTitle !== nextTitle) {
          pendingOrganizerRule = {
            id: crypto.randomUUID(),
            kind: "rename_group",
            fromName: previousTitle,
            toName: nextTitle,
          };
        }
      });
    });
    titleRow.append(title);
    if (change) {
      const colorRow = element("div", "review-group__color");
      const swatch = element("span", "group-color-swatch");
      swatch.setAttribute("aria-hidden", "true");
      colorRow.append(swatch);
      if (
        reviewRequest.approvedRequest.groupColorMode === "ai" &&
        change.colorSource !== "existing"
      ) {
        const color = element("select", "group-color-select");
        color.setAttribute("aria-label", `Color for ${group.title}`);
        color.dataset.actionName = `review-group-color-${group.temporaryId}`;
        CHROME_GROUP_COLORS.forEach((value) => {
          const option = element("option", undefined, colorLabel(value));
          option.value = value;
          option.selected = value === change.color;
          color.append(option);
        });
        color.addEventListener("change", () => {
          void perform("edit", async () => {
            await updateReview((state) => recolorProposedGroup(
              state,
              group.temporaryId,
              color.value as ChromeGroupColor,
            ));
          });
        });
        colorRow.append(color);
      } else {
        colorRow.append(element(
          "span",
          "review-group__color-label",
          change.colorSource === "existing"
            ? `${colorLabel(change.color)}, kept`
            : `${colorLabel(change.color)}, fallback`,
        ));
      }
      titleRow.append(colorRow);
    }
    body.append(titleRow);
    if (change) {
      const origin = change.renamedFrom
        ? `Renamed from ${change.renamedFrom}`
        : `From ${change.beforeTitles.join(" + ") || "Ungrouped"}`;
      body.append(element("p", "review-group__origin", origin));
    }
    const tabs = element("ul", "review-tabs");
    group.tabIds.forEach((tabId) => tabs.append(renderTab(tabId, group.temporaryId)));
    body.append(tabs);
    const selectedInGroup = group.tabIds.filter((tabId) => selectedReviewTabIds.has(tabId));
    if (selectedInGroup.length > 0) {
      const bulk = element("div", "review-bulk-move");
      bulk.append(element("span", "review-bulk-move__count", `${selectedInGroup.length} selected`));
      const bulkSelect = element("select", "move-select");
      bulkSelect.setAttribute(
        "aria-label",
        `Move ${selectedInGroup.length} selected tab${selectedInGroup.length === 1 ? "" : "s"}`,
      );
      const placeholder = element("option", undefined, "Move selected to…");
      placeholder.value = "";
      placeholder.selected = true;
      bulkSelect.append(placeholder);
      destinations.forEach((item) => {
        const option = element("option", undefined, item.label || "Untitled group");
        option.value = item.value;
        bulkSelect.append(option);
      });
      bulkSelect.addEventListener("change", () => {
        const target = bulkSelect.value;
        if (!target) return;
        const ids = [...selectedInGroup];
        void perform("edit", async () => {
          await updateReview((state) => ids.reduce((acc, id) => moveProposedTab(acc, id, target), state));
          ids.forEach((id) => selectedReviewTabIds.delete(id));
        });
      });
      bulk.append(bulkSelect);
      body.append(bulk);
    }
    details.append(summary, body);
    slots.append(details);
  });
  if (groupCount === 0) {
    slots.append(element("p", "review-slots__empty", "No group membership will change."));
  }

  // Held: everything the plan cannot touch, and the exact request that was sent.
  const held = element("details", "review-held request-details");
  held.dataset.focusKey = "review-held";
  const heldSummary = element("summary", "slot slot--held");
  const heldName = element("span", "slot__name");
  heldName.append(
    element("strong", undefined, "Held"),
    element(
      "span",
      "review-group__meta",
      [
        `${popupState.immutableRequest.submittedTabIds.length} tabs sent`,
        popupState.immutableRequest.outOfScopeTabCount
          ? `${popupState.immutableRequest.outOfScopeTabCount} outside scope`
          : null,
        `${popupState.immutableRequest.excludedTabs.length} excluded by protection or privacy rules`,
      ].filter(Boolean).join(" · "),
    ),
  );
  heldSummary.append(heldName, element("span", "slot__count", String(heldCount)));
  held.append(heldSummary);
  const heldBody = element("div", "review-held__body");
  if (popupState.immutableRequest.excludedTabs.length > 0) {
    const heldList = element("ul", "review-held__list");
    popupState.immutableRequest.excludedTabs.forEach((tab) => {
      const row = element("li");
      row.append(element("strong", undefined, tab.title || "Untitled tab"), element("span", undefined, tab.reason));
      heldList.append(row);
    });
    heldBody.append(heldList);
  } else {
    heldBody.append(element("p", "review-held__empty", "No tabs were excluded."));
  }
  heldBody.append(
    element("h3", undefined, "Exact request"),
    element("pre", undefined, popupState.immutableRequest.requestJson),
  );
  held.append(heldBody);
  slots.append(held);
  content.append(slots);

  if (pendingOrganizerRule) {
    content.append(renderRememberCorrection(pendingOrganizerRule));
  }

  if (blankTabs.length > 0) {
    const cleanup = element("div", "cleanup-note");
    cleanup.append(
      element("strong", undefined, `${blankTabs.length} inactive blank tab${blankTabs.length === 1 ? "" : "s"} will close`),
      element("span", undefined, "Active New Tab searches are always preserved."),
    );
    content.append(cleanup);
  }

  // The commit line: above it everything is still a proposal.
  const foot = element("div", "commit-foot");
  const footLine = [
    heldCount > 0 ? `${formatCount(heldCount, "held tab")} ${heldCount === 1 ? "stays" : "stay"} put.` : null,
    applyDisabled ? "Nothing has moved." : null,
  ].filter(Boolean).join(" ");
  if (footLine) foot.append(element("p", "commit-foot__line", footLine));
  if (popupState.proposalReview.signalAcknowledgementRequired) {
    foot.append(
      button("Acknowledge tab signal changes", "secondary", () => {
        void perform("acknowledge", async () => updateReview(acknowledgeSignalDrift));
      }),
    );
  }
  const actions = element("div", "commit-foot__actions");
  actions.append(
    button("Discard", "quiet", () => {
      void perform("discard", async () => {
        popupState.proposalReview = null;
        popupState.providerJob = null;
        await Promise.all([writeProposalReview(null), clearProviderJob()]);
      });
    }, { actionName: "discard" }),
    button(
      applyLabel,
      "primary",
      () => void perform("apply", applyReviewedProposal),
      {
        actionName: "apply",
        busyLabel: "Applying…",
        disabled: applyDisabled,
        shortcut: true,
      },
    ),
  );
  foot.append(actions);
  content.append(foot);
  shell.append(content);
}

function slotBar(count: number, largest: number): HTMLElement {
  const bar = element("span", "slot__bar");
  bar.setAttribute("aria-hidden", "true");
  const fill = element("span");
  fill.style.width = `${Math.max(4, Math.round((count / Math.max(1, largest)) * 100))}%`;
  bar.append(fill);
  return bar;
}

// The window as a sorting frame: one slot per group in tab-strip order, then
// Ungrouped and Held. Counts are browser facts from the last capture.
function renderSortingFrame(state: SemanticWindowState, title: string, tools: readonly HTMLElement[] = [], limit = 6): HTMLElement {
  const frame = element("section", "frame");
  const groups = [...state.groups].sort((left, right) => left.firstTabIndex - right.firstTabIndex);
  const ungroupedTabs = state.tabs.filter((tab) => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);
  const held = state.protectedTabIds.length;
  const largest = Math.max(1, ungroupedTabs.length, held, ...groups.map((group) => group.memberTabIds.length));
  const lockable = popupState.targetWindowId !== null && !fullExtensionPage;
  const sessionTabs = new Set(userProtections.session.tabIds);
  const sessionGroups = new Set(userProtections.session.groupIds);
  const userLocked = (reasons: readonly string[]): boolean => reasons.some(isUserProtectionReason);

  const head = element("div", "frame__head");
  const headingId = `frame-heading-${title.toLocaleLowerCase().replaceAll(/[^a-z]+/g, "-")}`;
  const heading = element("h2", undefined, title);
  heading.id = headingId;
  frame.setAttribute("aria-labelledby", headingId);
  const headCopy = element("div", "frame__title");
  headCopy.append(
    heading,
    element(
      "p",
      "frame__facts",
      `${formatCount(state.tabs.length, "tab")} · ${formatCount(groups.length, "group")}`,
    ),
  );
  head.append(headCopy);
  // Icon-only so the quick locks and feature switches share the title line.
  const quick = element("div", "frame__tools");
  if (lockable) {
    // One-click locks for the two most common asks: this tab, and everything here.
    const activeTab = state.tabs.find((tab) => tab.active);
    const unlockedTabIds = state.tabs.filter((tab) => !userLocked(tab.protectionReasons)).map((tab) => tab.id);
    if (activeTab) {
      const activeLocked = userLocked(activeTab.protectionReasons);
      quick.append(frameLockButton(
        "tab",
      activeLocked ? `Current tab is protected: ${activeTab.title}` : `Protect the current tab until restart: ${activeTab.title}`,
        activeLocked,
        activeLocked && sessionTabs.has(activeTab.id)
          ? { release: { tabIds: [activeTab.id], groupIds: [] }, text: `${activeTab.title} can be organized again.` }
          : activeLocked
            ? null
            : { protect: { tabIds: [activeTab.id] }, text: `${activeTab.title} will stay untouched until the browser restarts.` },
      ));
    }
    // A toggle: once every tab is held, the same button releases this window's
    // restart-only locks. Permanent rules stay; they are edited in the manager.
    const allLocked = unlockedTabIds.length === 0;
    const release = windowSessionLocks(state);
    const releasable = release.tabIds.length + release.groupIds.length > 0;
    quick.append(frameLockButton(
      "window",
      allLocked
        ? releasable
          ? "Stop protecting every tab in this window"
          : "Every tab in this window is held by a permanent rule or left alone automatically"
        : "Protect every tab in this window until restart",
      allLocked,
      !allLocked
        ? { protect: { tabIds: unlockedTabIds }, text: `${formatCount(unlockedTabIds.length, "tab")} will stay untouched until the browser restarts.` }
        : releasable
          ? { release, text: "Restart-only locks in this window were released." }
          : null,
    ));
  }
  if (tools.length > 0) {
    if (quick.childElementCount > 0) quick.append(element("span", "frame__tools-divider"));
    quick.append(...tools);
  }
  if (quick.childElementCount > 0) head.append(quick);
  frame.append(head);

  const list = element("ul", "frame__slots");
  const addSlot = (
    label: string,
    count: number,
    variant: "group" | "ungrouped" | "held",
    color: string | undefined,
    lock: HTMLElement | null,
  ): HTMLLIElement => {
    const row = element("li", `slot slot--${variant}`);
    if (color) row.style.setProperty("--slot", `var(--group-${color})`);
    row.append(
      element("span", "slot__name", label),
      slotBar(count, largest),
      element("span", "slot__count", String(count)),
      element("span", "visually-hidden", count === 1 ? "tab" : "tabs"),
    );
    row.append(lock ?? element("span", "slot__lock-space"));
    list.append(row);
    return row;
  };
  groups.slice(0, limit).forEach((group) => {
    const name = group.title.trim() || "Untitled group";
    const locked = userLocked(group.protectionReasons);
    const lock = lockable
      ? slotLockButton(name, locked, locked && sessionGroups.has(group.runtimeId)
        ? { release: { tabIds: [], groupIds: [group.runtimeId] }, text: `${name} can be organized again.` }
        : locked
          ? null
          : { protectGroups: [group.runtimeId], text: `${name} will stay untouched until the browser restarts.` })
      : null;
    addSlot(name, group.memberTabIds.length, "group", group.color, lock).classList.toggle("slot--locked", locked);
  });
  if (groups.length > limit) {
    const rest = groups.slice(limit);
    const restCount = rest.reduce((sum, group) => sum + group.memberTabIds.length, 0);
    addSlot(`${formatCount(rest.length, "more group")}`, restCount, "group", "grey", null);
  }
  const ungroupedUnlocked = ungroupedTabs.filter((tab) => !userLocked(tab.protectionReasons)).map((tab) => tab.id);
  const ungroupedSession = ungroupedTabs.filter((tab) => sessionTabs.has(tab.id)).map((tab) => tab.id);
  const ungroupedLocked = ungroupedTabs.length > 0 && ungroupedUnlocked.length === 0;
  const ungroupedLock = lockable && ungroupedTabs.length > 0
    ? slotLockButton("Ungrouped tabs", ungroupedLocked, ungroupedLocked
      ? ungroupedSession.length > 0
        ? { release: { tabIds: ungroupedSession, groupIds: [] }, text: "Ungrouped tabs can be organized again." }
        : null
      : { protect: { tabIds: ungroupedUnlocked }, text: `${formatCount(ungroupedUnlocked.length, "ungrouped tab")} will stay untouched until the browser restarts.` })
    : null;
  addSlot("Ungrouped", ungroupedTabs.length, "ungrouped", undefined, ungroupedLock).classList.toggle("slot--locked", ungroupedLocked);

  // Held is also the way into the full protection manager (permanent rules, selections).
  const heldRow = addSlot("Held back", held, "held", undefined, null);
  if (lockable) {
    const manage = element("button", "slot__manage");
    manage.type = "button";
    manage.append(lineIcon(["m9.5 6 6 6-6 6"]));
    manage.dataset.focusKey = "protection-summary";
    manage.setAttribute("aria-label", "Manage protected tabs and groups");
    manage.addEventListener("click", openProtectionManager);
    heldRow.lastElementChild?.replaceWith(manage);
  }
  frame.append(list);
  return frame;
}

type FrameLockAction =
  | { protect: { tabIds: number[] }; text: string }
  | { protectGroups: number[]; text: string }
  | { release: { tabIds: number[]; groupIds: number[] }; text: string };

// Locks skip perform(): its busy render disables every control in the popup and
// a success notice grows the page, so Chrome resizes the popup window and the
// whole thing blinks. The lock icon flipping is the visible confirmation; the
// sentence goes to a live region. Failures still use the notice.
let frameLockPending = false;
function runFrameLock(action: FrameLockAction): void {
  if (popupState.targetWindowId === null || frameLockPending || busyAction) return;
  const windowId = popupState.targetWindowId;
  frameLockPending = true;
  void (async () => {
    try {
      if ("protect" in action) {
        await applyProtectionMessage({ type: "protection:protect-tabs", targetWindowId: windowId, tabIds: action.protect.tabIds, permanence: "session" });
      } else if ("protectGroups" in action) {
        await applyProtectionMessage({ type: "protection:lock-groups", targetWindowId: windowId, groupIds: action.protectGroups, permanence: "session" });
      } else {
        await applyProtectionMessage({ type: "protection:release-session", targetWindowId: windowId, ...action.release });
      }
      // A failure from an earlier click no longer applies once a lock lands.
      if (popupState.notice?.tone === "error") popupState.notice = null;
      announceStatus(action.text);
    } catch (error) {
      popupState.notice = {
        tone: "error",
        text: error instanceof Error ? error.message : "The action could not be completed.",
      };
    } finally {
      frameLockPending = false;
      render();
    }
  })();
}

// A lock toggle for one slot. A slot held only by a permanent rule opens the
// manager instead, since those rules are edited there.
function slotLockButton(name: string, locked: boolean, action: FrameLockAction | null): HTMLButtonElement {
  const control = element("button", `slot__lock${locked ? " slot__lock--on" : ""}`);
  control.type = "button";
  control.setAttribute("aria-pressed", String(locked));
  const label = !locked
    ? `Protect ${name} until restart`
    : action
      ? `Stop protecting ${name}`
      : `${name} is protected by a permanent rule. Manage protection`;
  control.setAttribute("aria-label", label);
  withTooltip(control, label);
  control.disabled = Boolean(busyAction);
  control.append(utilityNavIcon(locked ? "lock" : "unlock"));
  control.addEventListener("click", () => {
    hideStashTabTooltip(control);
    if (action) runFrameLock(action);
    else openProtectionManager();
  });
  return control;
}

// Stays for the rest of this popup once used, so switching auto-filing off
// here doesn't take away the way to switch it back on.
let autoFilingSwitchUsed = false;

/** Quick on/off for background features that are already set up; the details stay in Settings. */
function renderFeatureSwitches(): HTMLElement[] {
  const filing = autoFilingView()?.settings;
  const search = popupState.searchState.local;
  const switches: HTMLElement[] = [];
  if (filing && (filing.enabled || filing.decisionModel || autoFilingSwitchUsed)) {
    switches.push(featureSwitch("auto-filing", "Auto-file new tabs into groups", filing.enabled ? "on" : "off", filing.enabled, async () => {
      autoFilingSwitchUsed = true;
      await setAutoFilingEnabled(!filing.enabled);
    }));
  }
  if (search.settings.semanticEnabled && search.providerTest !== null && popupState.semanticIndexMeta.modelKey !== null) {
    const on = !search.settings.semanticIndexPaused;
    switches.push(featureSwitch("semantic-index", "Search indexing", on ? "on" : "paused", on, async () => {
      popupState.searchState = await writeSearchSettings({ ...search.settings, semanticIndexPaused: on });
      startSemanticIndexPolling();
    }));
  }
  return switches;
}

const FEATURE_SWITCH_ICONS: Record<string, string[]> = {
  "auto-filing": ["M4 6h6l2 2h8v10H4Z", "M8 13h7", "m12.5 10.5 2.5 2.5-2.5 2.5"],
  "semantic-index": ["M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z", "m20 20-4.4-4.4", "m10.5 7.5.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7Z"],
};

// The state a switch was just flipped to, shown while its save is in flight so
// the icon changes on click instead of after the round trip.
const pendingFeatureSwitches = new Map<string, boolean>();

function featureSwitch(key: string, name: string, state: string, saved: boolean, toggle: () => Promise<void>): HTMLButtonElement {
  const on = pendingFeatureSwitches.get(key) ?? saved;
  const control = element("button", `frame__tool${on ? " frame__tool--on" : ""}`);
  control.type = "button";
  control.setAttribute("role", "switch");
  control.setAttribute("aria-checked", String(on));
  control.setAttribute("aria-label", name);
  control.dataset.focusKey = `switch-${key}`;
  control.dataset.actionName = `toggle-${key}`;
  // Not disabled while busy: dimming every header tool for the length of a save
  // read as a flash. Clicks are ignored instead.
  if (busyAction) control.setAttribute("aria-disabled", "true");
  // Off draws a slash through the icon, so state doesn't rest on colour alone.
  control.append(lineIcon(on ? FEATURE_SWITCH_ICONS[key]! : [...FEATURE_SWITCH_ICONS[key]!, "M4 4l16 16"]));
  withTooltip(control, `${name}: ${pendingFeatureSwitches.has(key) ? (on ? "on" : "off") : state}`);
  control.addEventListener("click", () => {
    if (busyAction) return;
    hideStashTabTooltip(control);
    pendingFeatureSwitches.set(key, !on);
    void perform(`toggle-${key}`, async () => {
      try {
        await toggle();
      } finally {
        pendingFeatureSwitches.delete(key);
      }
    });
  });
  return control;
}

function withTooltip(control: HTMLButtonElement, label: string): void {
  control.dataset.tooltip = label;
  control.addEventListener("mouseenter", () => showStashTabTooltip(control, label));
  control.addEventListener("mouseleave", () => hideStashTabTooltip(control));
  control.addEventListener("focus", () => showStashTabTooltip(control, label));
  control.addEventListener("blur", () => hideStashTabTooltip(control));
}

function frameLockButton(scope: "tab" | "window", label: string, locked: boolean, action: FrameLockAction | null): HTMLButtonElement {
  const control = element("button", `frame__tool${locked ? " frame__tool--on" : ""}`);
  control.type = "button";
  control.setAttribute("aria-label", label);
  control.setAttribute("aria-pressed", String(locked));
  control.dataset.focusKey = `frame-lock-${scope}`;
  // Only a lock held by a permanent rule is disabled; runFrameLock ignores clicks while busy.
  control.disabled = locked && !action;
  // A lock for the one tab, a shield for the whole window.
  control.append(scope === "tab" ? utilityNavIcon(locked ? "lock" : "unlock") : lineIcon(locked
    ? ["M12 3 5 6v5c0 4.5 2.8 7.8 7 10 4.2-2.2 7-5.5 7-10V6Z", "m9 12 2 2 4-5"]
    : ["M12 3 5 6v5c0 4.5 2.8 7.8 7 10 4.2-2.2 7-5.5 7-10V6Z"]));
  withTooltip(control, label);
  control.addEventListener("click", () => {
    hideStashTabTooltip(control);
    if (action) runFrameLock(action);
  });
  return control;
}

function renderRememberCorrection(rule: OrganizerRule): HTMLElement {
  const panel = element("div", "remember-correction");
  const copy = element("div");
  copy.append(
    element("strong", undefined, "Keep this correction for future runs?"),
    element("span", undefined, describeRuleForUi(rule)),
  );
  const actions = element("div", "remember-correction__actions");
  const remember = element("button", "remember-correction__button", "Remember this correction");
  remember.type = "button";
  remember.addEventListener("click", () => {
    void perform("remember-rule", async () => {
      if (!popupState.organizerData) throw new Error("Organizer settings are unavailable.");
      const existing = popupState.organizerData.local.organizerRules;
      if (!existing.some((candidate) => sameOrganizerRule(candidate, rule))) {
        popupState.organizerData = await writeOrganizerRules([...existing, rule]);
      }
      pendingOrganizerRule = null;
      popupState.notice = { tone: "success", text: "Correction saved as an editable rule." };
    });
  });
  const dismiss = element("button", "remember-correction__button remember-correction__button--quiet", "Only this time");
  dismiss.type = "button";
  dismiss.addEventListener("click", () => {
    pendingOrganizerRule = null;
    render();
  });
  actions.append(remember, dismiss);
  panel.append(copy, actions);
  return panel;
}

function describeRuleForUi(rule: OrganizerRule): string {
  switch (rule.kind) {
    case "assign_location": return `${rule.locationPattern} → ${rule.groupName}`;
    case "keep_location": return `Never move ${rule.locationPattern}`;
    case "rename_group": return `${rule.fromName} → ${rule.toName}`;
    case "never_clutter_location": return `Never flag ${rule.locationPattern} as clutter`;
    case "never_file_location": return describeOrganizerRule(rule);
  }
}

export function renderOrganizerRulesSettings(panel: HTMLElement): void {
  if (!popupState.organizerData) return;
  const group = element("div", "settings-group");
  group.append(
    element("h3", undefined, "Correction rules"),
    element(
      "p",
      "settings-group__copy",
      "Saved corrections are visible in the exact request and can be edited or removed here.",
    ),
  );
  const rules = popupState.organizerData.local.organizerRules;
  if (rules.length === 0) {
    group.append(element("p", "rules-empty", "No remembered corrections yet."));
    panel.append(group);
    return;
  }

  const updateRule = (index: number, rule: OrganizerRule): void => {
    void perform("rules", async () => {
      const next = [...rules];
      next[index] = rule;
      await persistOrganizerRules(next);
      popupState.notice = { tone: "success", text: "Correction rule updated." };
    });
  };
  rules.forEach((rule, index) => {
    const row = element("section", "rule-editor");
    const heading = element("div", "rule-editor__heading");
    const labels: Record<OrganizerRule["kind"], string> = {
      assign_location: "Preferred assignment",
      keep_location: "Never move",
      rename_group: "Preferred rename",
      never_clutter_location: "Never mark as clutter",
      never_file_location: "Never auto-file",
    };
    heading.append(element("strong", undefined, labels[rule.kind]));
    const remove = element("button", "rule-remove", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      void perform("rules", async () => {
        await persistOrganizerRules(rules.filter((_, candidate) => candidate !== index));
        popupState.notice = { tone: "success", text: "Correction rule removed." };
      });
    });
    heading.append(remove);
    row.append(heading);

    if (rule.kind === "assign_location") {
      const pattern = input(rule.locationPattern);
      const name = input(rule.groupName);
      pattern.addEventListener("change", () => updateRule(index, { ...rule, locationPattern: pattern.value }));
      name.addEventListener("change", () => updateRule(index, { ...rule, groupName: name.value }));
      row.append(field("Location pattern", pattern), field("Preferred group", name));
    } else if (rule.kind === "rename_group") {
      const fromName = input(rule.fromName);
      const toName = input(rule.toName);
      fromName.addEventListener("change", () => updateRule(index, { ...rule, fromName: fromName.value }));
      toName.addEventListener("change", () => updateRule(index, { ...rule, toName: toName.value }));
      row.append(field("When the group is", fromName), field("Prefer", toName));
    } else {
      const pattern = input(rule.locationPattern);
      pattern.addEventListener("change", () => updateRule(index, { ...rule, locationPattern: pattern.value }));
      row.append(field("Location pattern", pattern));
    }
    group.append(row);
  });
  panel.append(group);
}

export function renderBackupSettings(panel: HTMLElement): void {
  if (!popupState.organizerData) return;
  const group = element("div", "settings-group backup-settings");
  group.append(
    element("h3", undefined, "Backup and restore"),
    element(
      "p",
      "settings-group__copy",
      "Export a readable JSON backup or review one before importing. API keys, custom-header values, provider extra-body and reasoning fields, diagnostic events, history, Undo, and session state are always excluded.",
    ),
  );
  const includeStashes = check(
    "Include workspaces with full URLs",
    "Sensitive: every restorable URL and title in saved workspaces will be written to the backup file.",
    false,
  );
  group.append(includeStashes.wrapper);
  const actions = element("div", "backup-actions");
  actions.append(
    button("Export backup", "secondary", () => {
      const backup = createSettingsBackup({
        local: popupState.organizerData!.local,
        searchLocal: popupState.searchState.local,
        diagnosticPricing: diagnosticsState.pricing,
        ...(includeStashes.control.checked ? { workspaces: popupState.savedStashes } : {}),
        ...(autoFilingView() ? { autoFiling: autoFilingView()!.settings } : {}),
      });
      const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const download = element("a");
      download.href = url;
      download.download = `sheaf-backup-${new Date().toISOString().slice(0, 10)}.json`;
      download.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      popupState.notice = { tone: "success", text: "Backup exported without provider secrets." };
      render();
    }),
  );
  const file = element("input", "backup-file-input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.setAttribute("aria-label", "Backup file to import");
  const choose = button("Import backup", "secondary", () => file.click());
  file.addEventListener("change", () => {
    const selected = file.files?.[0];
    if (!selected) return;
    void selected.text().then((text) => {
      settingsImportPlan = parseSettingsBackup(text);
      popupState.notice = null;
      render();
    }).catch((error) => {
      settingsImportPlan = null;
      popupState.notice = { tone: "error", text: error instanceof Error ? error.message : "Backup could not be read." };
      render();
    });
  });
  actions.append(choose, file);
  group.append(actions);
  if (settingsImportPlan) {
    const review = element("div", "backup-review");
    const items = [
      `Provider: ${settingsImportPlan.provider.model || "no model"}`,
      `${settingsImportPlan.organizerRules.length} correction rules`,
      `${settingsImportPlan.groupNamePreferences.length} preferred names`,
      settingsImportPlan.search
        ? `Search settings · ${settingsImportPlan.search.embeddingProvider?.model ?? "direct search only"}`
        : "Search settings not included",
      settingsImportPlan.workspaces ? `${settingsImportPlan.workspaces.length} URL-containing workspaces` : "Workspaces not included",
      settingsImportPlan.autoFiling
        ? `Auto-filing settings · ${settingsImportPlan.autoFiling.decisionModel?.model ?? "no decision model"} · ${settingsImportPlan.autoFiling.calibrations.length} calibrations`
        : "Auto-filing settings not included",
    ];
    review.append(
      element("strong", undefined, "Review import"),
      element(
        "p",
        undefined,
        "Import replaces the corresponding local configuration. Provider secrets are cleared, the provider must be saved again, and organize-on-click, skip-review, and auto-filing remain off until you explicitly enable them again.",
      ),
    );
    const list = element("ul");
    items.forEach((item) => list.append(element("li", undefined, item)));
    review.append(list);
    const reviewActions = element("div", "backup-actions");
    reviewActions.append(
      button("Import reviewed backup", "primary", () => {
        void perform("settings-import", async () => {
          const plan = settingsImportPlan;
          if (!plan) return;
          const provider = {
            ...plan.provider,
            reasoningEffort: plan.provider.reasoningEffort ?? undefined,
            customHeaders: {},
            extraBody: {},
          };
          await writeProviderSettings(provider, "", false);
          await writePrivacySettings(plan.privacy);
          await writeWorkflowSettings(plan.workflow);
          if (plan.search) {
            await writeSearchSettings(plan.search.settings);
            if (plan.search.embeddingProvider) {
              await writeEmbeddingProvider({
                config: { ...DEFAULT_EMBEDDING_CONFIG, ...plan.search.embeddingProvider, apiKeyStorage: "session" },
                apiKey: "",
                customHeaders: {},
              });
            }
          }
          await writeCustomOrganizerPrompt(plan.customOrganizerPrompt);
          await writeOrganizerRules(plan.organizerRules);
          await writeGroupNamePreferences(plan.groupNamePreferences);
          diagnosticsState = await writeDiagnosticPricing(plan.diagnosticPricing);
          if (plan.workspaces) popupState.savedStashes = await writeTabStashes(plan.workspaces);
          if (plan.autoFiling) {
            await writeAutoFilingSettings(plan.autoFiling);
            // Saved without a key; it is verified again before it is trusted.
            await writeDecisionModel({ config: plan.autoFiling.decisionModel, apiKey: "" }).catch(() => undefined);
            await loadAutoFilingView();
          }
          settingsImportPlan = null;
          popupState.proposalReview = null;
          popupState.providerJob = null;
          await Promise.all([writeProposalReview(null), clearProviderJob()]);
          await initializeTarget();
          await loadStoredWorkflow();
          popupState.notice = { tone: "success", text: "Backup imported. Re-enter and save the provider secret before organizing." };
        });
      }, { actionName: "settings-import", busyLabel: "Importing…" }),
      button("Cancel import", "quiet", () => {
        settingsImportPlan = null;
        render();
      }),
    );
    review.append(reviewActions);
    group.append(review);
  }
  panel.append(group);
}

export function renderGroupNameMemorySettings(panel: HTMLElement): void {
  if (!popupState.organizerData) return;
  const group = element("div", "settings-group");
  group.append(
    element("h3", undefined, "Preferred group names"),
    element(
      "p",
      "settings-group__copy",
      "Reviewed Apply always counts as approval. Automatic Apply never does. A name becomes provider vocabulary after two approvals.",
    ),
  );
  const preferences = popupState.organizerData.local.groupNamePreferences;
  if (preferences.length === 0) {
    group.append(element("p", "rules-empty", "No approved names yet."));
    panel.append(group);
    return;
  }
  preferences.forEach((preference, index) => {
    const row = element("div", "name-memory");
    const name = input(preference.name);
    name.setAttribute("aria-label", `Preferred group name: ${preference.name}`);
    name.addEventListener("change", () => {
      void perform("group-names", async () => {
        const next = [...preferences];
        next[index] = { ...preference, name: name.value };
        await persistGroupNamePreferences(next);
        popupState.notice = { tone: "success", text: "Preferred group name updated." };
      });
    });
    const meta = element("div", "name-memory__meta");
    meta.append(
      element(
        "span",
        preference.approvalCount >= 2 ? "name-memory__ready" : undefined,
        preference.approvalCount >= 2
          ? `Preferred · ${preference.approvalCount} approvals`
          : "Approved once · not sent yet",
      ),
    );
    const remove = element("button", "rule-remove", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      void perform("group-names", async () => {
        await persistGroupNamePreferences(
          preferences.filter((_, candidate) => candidate !== index),
        );
        popupState.notice = { tone: "success", text: "Preferred group name removed." };
      });
    });
    meta.append(remove);
    row.append(name, meta);
    group.append(row);
  });
  panel.append(group);
}

function projectedCostForThousandActivations(costUsd: number): string {
  const projected = costUsd * 1_000;
  const digits = projected >= 100 ? 0 : projected >= 1 ? 2 : 3;
  return `$${projected.toFixed(digits)} / 1,000 activations`;
}

async function applyProtectionMessage(message: StatefulWindowCaptureMessage): Promise<void> {
  const response = await send(message);
  popupState.viewState = response.state;
  if (!response.ok) throw new Error(response.error);
  userProtections = await readUserProtectionState();
  if (popupState.proposalReview) popupState.discardedPlanReason = "protection changed which tabs it may move";
  popupState.proposalReview = null;
  popupState.providerJob = null;
  pendingOrganizerRule = null;
  await Promise.all([writeProposalReview(null), clearProviderJob()]);
  popupState.immutableRequest = null;
  try {
    await rebuildRequest();
  } catch {
    // A lock can intentionally leave no eligible tabs. The ready state explains that.
  }
}

function isUserProtectionReason(reason: string): boolean {
  return reason.startsWith("User ") || reason.startsWith("Permanent ");
}

function searchTabUserProtectionReasons(tab: SearchableTab): string[] {
  const captured = popupState.viewState.editor?.capturedState;
  if (captured?.windowId === tab.windowId) {
    const capturedTab = captured.tabs.find((candidate) => candidate.id === tab.id);
    if (capturedTab) return capturedTab.protectionReasons.filter(isUserProtectionReason);
  }

  const reasons: string[] = [];
  if (userProtections.session.tabIds.includes(tab.id)) reasons.push("Protected until restart");
  const location = protectionLocation(tab.url);
  if (userProtections.permanentRules.some((rule) =>
    rule.kind === "location" && locationMatchesPattern(location, rule.pattern),
  )) reasons.push("Permanent location rule");
  if (tab.groupName && userProtections.permanentRules.some((rule) =>
    rule.kind === "group_title" && locationMatchesPattern(tab.groupName!, rule.pattern),
  )) reasons.push("Permanent group-name rule");
  return reasons;
}

async function protectSearchTab(
  tab: SearchableTab,
  permanence: "session" | "permanent",
): Promise<void> {
  await applyProtectionMessage({
    type: "protection:protect-tabs",
    targetWindowId: tab.windowId,
    tabIds: [tab.id],
    permanence,
  });
  popupState.notice = {
    tone: "success",
    text: permanence === "session"
      ? `${tab.title} will stay untouched until the browser restarts.`
      : `${tab.title} will stay untouched whenever this location is open.`,
  };
}

function groupHasUserProtection(group: GroupManagerGroup): boolean {
  return userProtections.session.groupIds.includes(group.id) ||
    userProtections.permanentRules.some((rule) =>
      rule.kind === "group_title" && locationMatchesPattern(group.title, rule.pattern),
    );
}

async function protectGroupFromManager(group: GroupManagerGroup): Promise<void> {
  await applyProtectionMessage({
    type: "protection:lock-groups",
    targetWindowId: group.windowId,
    groupIds: [group.id],
    permanence: "session",
  });
  await refreshGroupManagerState(groupManagerPanelContext);
  popupState.notice = {
    tone: "success",
    text: `${group.title.trim() || "Untitled group"} will stay untouched until the browser restarts.`,
  };
}

// This window's restart-only locks: what "Release all" and the Protect-all toggle undo.
function windowSessionLocks(state: SemanticWindowState): { tabIds: number[]; groupIds: number[] } {
  const tabIds = new Set(state.tabs.map((tab) => tab.id));
  const groupIds = new Set(state.groups.map((group) => group.runtimeId));
  return {
    tabIds: userProtections.session.tabIds.filter((id) => tabIds.has(id)),
    groupIds: userProtections.session.groupIds.filter((id) => groupIds.has(id)),
  };
}

// Plain names for the reasons the browser layer holds a tab back on its own.
function safetyReasonCopy(reason: string): { label: string; hint: string } {
  switch (reason) {
    case "Pinned tab": return { label: "Pinned", hint: "Unpin a tab to let it be organized." };
    case "Incognito tab": return { label: "Incognito", hint: "Incognito tabs are never organized." };
    case "Tab belongs to split view": return { label: "In split view", hint: "Leave split view to let these be organized." };
    case "Split-view safety state is unknown": return { label: "Split view unknown", hint: "This browser doesn't report split view, so these are left alone." };
    case "URL is unavailable or unreadable": return { label: "Unreadable address", hint: "The browser didn't share where these tabs are." };
    case "Tab identity is unavailable": return { label: "Unknown tab", hint: "The browser didn't share these tabs' identity." };
    case "Local or private-network location": return { label: "Local network", hint: "Allow local-network tabs in Settings to organize these." };
    case "Group contains a protected tab": return { label: "Shares a group with a held tab", hint: "Groups move as a whole, so the rest of the group stays too." };
    case "Native group state is unavailable": return { label: "Group state unknown", hint: "The browser didn't share this tab's group." };
  }
  if (reason.startsWith("Protected location")) return { label: "Browser page", hint: "Browser and extension pages are never moved." };
  if (reason.startsWith("Unsupported location")) return { label: "Unsupported page", hint: "Only web pages can be organized." };
  return { label: reason, hint: "" };
}

// One held thing the user chose: a tab or a group, how long, and a release toggle.
function heldRow(options: {
  name: string;
  meta: string;
  color?: string;
  duration: string;
  release: FrameLockAction | null;
}): HTMLLIElement {
  const row = element("li", "held-row");
  if (options.color) row.style.setProperty("--slot", `var(--group-${options.color})`);
  const copy = element("div", "held-row__copy");
  copy.append(element("strong", undefined, options.name), element("span", undefined, options.meta));
  row.append(copy, element("span", "held-row__duration", options.duration));
  if (options.release) {
    row.append(slotLockButton(options.name, true, options.release));
  } else {
    // Held by a permanent rule: the rule below is where it is released.
    const icon = element("span", "held-row__rule");
    icon.setAttribute("aria-hidden", "true");
    icon.append(utilityNavIcon("lock"));
    row.append(icon);
  }
  return row;
}

function heldSection(title: string, aside?: HTMLElement | string): HTMLElement {
  const section = element("section", "held-section");
  const heading = element("div", "protection-section-heading");
  heading.append(element("h3", undefined, title));
  if (aside) heading.append(typeof aside === "string" ? element("span", undefined, aside) : aside);
  section.append(heading);
  return section;
}

function renderProtectionManager(panel: HTMLElement): void {
  const state = popupState.viewState.editor?.capturedState;
  if (!state || popupState.targetWindowId === null) return;
  const targetId = popupState.targetWindowId;
  const sessionTabs = new Set(userProtections.session.tabIds);
  const sessionGroups = new Set(userProtections.session.groupIds);
  const groups = [...state.groups].sort((left, right) => left.firstTabIndex - right.firstTabIndex);
  const heldTabs = state.tabs.filter((tab) => tab.protectionReasons.length > 0);

  const page = element("section", "protection-panel");
  const head = element("div", "held-head");
  // Held tabs is a page under Organize, not a tab of its own, so it carries the way back.
  const back = groupManagerIconButton("Back to Organize", "back", () => {
    showUtilityView(null);
    popupState.pendingFocusKey = "protection-summary";
    render();
  });
  back.classList.add("held-head__back");
  back.dataset.focusKey = "held-back";
  head.append(
    back,
    element("h2", undefined, "Held tabs"),
    element("span", "held-head__count", `${heldTabs.length} of ${formatCount(state.tabs.length, "tab")}`),
  );
  page.append(
    head,
    element(
      "p",
      "section-copy",
      heldTabs.length === 0
        ? "Nothing in this window is held. Every tab can be organized."
        : "Held tabs are never sent to the provider.",
    ),
  );

  // Held by you: what the locks on Organize, search, and the rules below put in place.
  const yours: HTMLLIElement[] = [];
  groups.forEach((group) => {
    const session = sessionGroups.has(group.runtimeId);
    const rule = group.protectionReasons.includes("Permanent group-name rule");
    if (!session && !rule) return;
    const name = group.title.trim() || "Untitled group";
    yours.push(heldRow({
      name,
      meta: `Group · ${formatCount(group.memberTabIds.length, "tab")}`,
      color: group.color,
      duration: rule ? "Always · name rule" : "Until restart",
      release: session && !rule
        ? { release: { tabIds: [], groupIds: [group.runtimeId] }, text: `${name} can be organized again.` }
        : null,
    }));
  });
  state.tabs.forEach((tab) => {
    const session = sessionTabs.has(tab.id);
    const rule = tab.protectionReasons.includes("Permanent location rule");
    if (!session && !rule) return;
    yours.push(heldRow({
      name: tab.title,
      meta: protectionLocation(tab.url),
      duration: rule ? "Always · location rule" : "Until restart",
      release: session && !rule
        ? { release: { tabIds: [tab.id], groupIds: [] }, text: `${tab.title} can be organized again.` }
        : null,
    }));
  });
  const releasable = windowSessionLocks(state);
  const releaseCount = releasable.tabIds.length + releasable.groupIds.length;
  let releaseAll: HTMLElement | undefined;
  if (releaseCount > 1) {
    const control = element("button", "held-release-all", "Release all");
    control.type = "button";
    control.dataset.focusKey = "release-window-locks";
    control.setAttribute("aria-label", `Release ${formatCount(releaseCount, "restart-only lock")} in this window`);
    control.disabled = Boolean(busyAction);
    control.addEventListener("click", () => runFrameLock({
      release: releasable,
      text: "Restart-only locks in this window were released.",
    }));
    releaseAll = control;
  }
  const yoursSection = heldSection("Held by you", releaseAll);
  if (yours.length > 0) {
    const list = element("ul", "held-list held-list--yours");
    list.append(...yours);
    yoursSection.append(list);
  } else {
    yoursSection.append(element(
      "p",
      "held-empty",
      "Nothing yet. Use the locks on Organize, or protect selected tabs below.",
    ));
  }
  page.append(yoursSection);

  // Left alone automatically: the browser layer's own reasons, grouped so the cause reads first.
  // Keyed by the plain label: several raw reasons (one per URL scheme) read the same.
  const byReason = new Map<string, { copy: { label: string; hint: string }; tabs: SemanticTab[] }>();
  heldTabs.forEach((tab) => {
    tab.protectionReasons.filter((reason) => !isUserProtectionReason(reason)).forEach((reason) => {
      const copy = safetyReasonCopy(reason);
      const entry = byReason.get(copy.label) ?? { copy, tabs: [] };
      if (!entry.tabs.includes(tab)) entry.tabs.push(tab);
      byReason.set(copy.label, entry);
    });
  });
  if (byReason.size > 0) {
    const safety = heldSection("Left alone automatically", "Automatic");
    const list = element("ul", "held-list");
    byReason.forEach(({ copy, tabs }) => {
      const item = element("li", "held-reason");
      const details = element("details");
      const summary = element("summary");
      summary.append(
        element("strong", undefined, copy.label),
        element("span", "held-reason__count", String(tabs.length)),
        element("span", "visually-hidden", tabs.length === 1 ? "tab" : "tabs"),
      );
      details.append(summary);
      if (copy.hint) details.append(element("p", "held-reason__hint", copy.hint));
      const titles = element("ul", "held-reason__tabs");
      tabs.forEach((tab) => titles.append(element("li", undefined, tab.title)));
      details.append(titles);
      item.append(details);
      list.append(item);
    });
    safety.append(list);
    page.append(safety);
  }

  // Protect more: the Chrome selection, and groups nothing holds yet.
  const more = heldSection("Protect more");
  const highlighted = state.tabs.filter((tab) => tab.highlighted === true);
  const duration = element("div", "protection-duration");
  duration.setAttribute("role", "group");
  duration.setAttribute("aria-label", "Protection duration");
  ([
    ["session", "Until restart"],
    ["permanent", "Always"],
  ] as const).forEach(([value, label]) => {
    const choice = element(
      "button",
      `protection-duration__choice${protectionPermanence === value ? " protection-duration__choice--active" : ""}`,
      label,
    );
    choice.type = "button";
    choice.setAttribute("aria-pressed", String(protectionPermanence === value));
    choice.addEventListener("click", () => {
      protectionPermanence = value;
      popupState.pendingFocusKey = `protection-duration-${value}`;
      render();
    });
    choice.dataset.focusKey = `protection-duration-${value}`;
    duration.append(choice);
  });
  more.append(duration);

  const selection = element("div", "protection-group");
  const selectionCopy = element("div");
  selectionCopy.append(
    element("strong", undefined, "Selected tabs"),
    element(
      "span",
      highlighted.length > 0 ? "protection-selection-count protection-selection-count--ready" : "protection-selection-count",
      highlighted.length > 0 ? `${highlighted.length} selected in Chrome` : "Select tabs in Chrome first",
    ),
  );
  const selectionAction = element(
    "button",
    "protection-action",
    busyAction === "protect-tabs"
      ? "Protecting…"
      : highlighted.length > 1 ? `Protect ${highlighted.length}` : "Protect",
  );
  selectionAction.type = "button";
  selectionAction.dataset.actionName = "protect-tabs";
  selectionAction.disabled = Boolean(busyAction) || highlighted.length === 0;
  selectionAction.setAttribute(
    "aria-label",
    highlighted.length === 0
      ? "Protect selected tabs"
      : `Protect ${highlighted.length} selected tab${highlighted.length === 1 ? "" : "s"}`,
  );
  selectionAction.addEventListener("click", () => void perform("protect-tabs", () => applyProtectionMessage({
    type: "protection:protect-tabs",
    targetWindowId: targetId,
    tabIds: highlighted.map((tab) => tab.id),
    permanence: protectionPermanence,
  })));
  selection.append(selectionCopy, selectionAction);
  more.append(selection);

  groups
    .filter((group) => !group.protectionReasons.some(isUserProtectionReason))
    .forEach((browserGroup) => {
      const row = element("div", "protection-group");
      row.style.setProperty("--slot", `var(--group-${browserGroup.color})`);
      const copy = element("div");
      copy.append(
        element("strong", undefined, browserGroup.title.trim() || "Untitled group"),
        element("span", undefined, `Group · ${formatCount(browserGroup.memberTabIds.length, "tab")}`),
      );
      const actionName = `lock-group-${protectionPermanence}-${browserGroup.runtimeId}`;
      const protectButton = element(
        "button",
        "protection-action",
        busyAction === actionName ? "Protecting…" : "Protect",
      );
      protectButton.type = "button";
      protectButton.disabled = Boolean(busyAction || (protectionPermanence === "permanent" && !browserGroup.title.trim()));
      protectButton.dataset.actionName = actionName;
      protectButton.setAttribute(
        "aria-label",
        `Protect ${browserGroup.title.trim() || "untitled group"} ${protectionPermanence === "session" ? "until restart" : "always by name"}`,
      );
      protectButton.addEventListener("click", () => {
        void perform(actionName, () => applyProtectionMessage({
          type: "protection:lock-groups",
          targetWindowId: targetId,
          groupIds: [browserGroup.runtimeId],
          permanence: protectionPermanence,
        }));
      });
      row.append(copy, protectButton);
      more.append(row);
    });
  page.append(more);

  if (userProtections.permanentRules.length > 0) {
    const rules = heldSection("Permanent rules", "Every window");
    rules.classList.add("protection-rules");
    userProtections.permanentRules.forEach((rule, index) => {
      const row = element("div", "protection-rule");
      const pattern = input(rule.pattern);
      pattern.setAttribute("aria-label", `${rule.kind === "location" ? "Location" : "Group name"} protection pattern`);
      pattern.addEventListener("change", () => {
        const next = [...userProtections.permanentRules];
        next[index] = { ...rule, pattern: pattern.value };
        void perform("protection-rule", () => applyProtectionMessage({
          type: "protection:update-rules",
          rules: next,
        }));
      });
      const meta = element("div", "protection-rule__meta");
      meta.append(element("span", undefined, rule.kind === "location" ? "Location" : "Group name"));
      const removalArmed = protectionRuleRemovalArmedIndex === index;
      const remove = element("button", "rule-remove", removalArmed ? "Confirm remove" : "Remove");
      remove.type = "button";
      remove.dataset.focusKey = `remove-protection-rule-${index}`;
      remove.addEventListener("click", () => {
        if (!removalArmed) {
          protectionRuleRemovalArmedIndex = index;
          popupState.pendingFocusKey = `remove-protection-rule-${index}`;
          render();
          return;
        }
        void perform("protection-rule", () => applyProtectionMessage({
          type: "protection:update-rules",
          rules: userProtections.permanentRules.filter((_, candidate) => candidate !== index),
        }));
        protectionRuleRemovalArmedIndex = null;
      });
      meta.append(remove);
      row.append(pattern, meta);
      rules.append(row);
    });
    page.append(rules);
  }
  panel.append(page);
}

function diffKindLabel(kind: ProposalGroupChangeKind): string {
  switch (kind) {
    case "new": return "New group";
    case "renamed": return "Renamed";
    case "merged": return "Merged";
    case "split": return "Split";
    case "unchanged": return "Unchanged";
  }
}

async function applyReviewedProposal(): Promise<void> {
  if (!popupState.proposalReview || popupState.targetWindowId === null) throw new Error("No plan is ready.");
  organizeStartedAt = performance.now();
  const refreshed = await send({ type: "window-capture:refresh" });
  popupState.viewState = refreshed.state;
  if (!refreshed.ok) throw new Error(refreshed.error);
  const live = refreshed.state.editor?.capturedState ?? null;
  popupState.proposalReview = applyDriftCheckResult(
    popupState.proposalReview,
    checkProposalDrift(
      popupState.proposalReview.inputSnapshot,
      live,
      popupState.proposalReview.request,
      popupState.proposalReview.proposal,
    ),
  );
  if (
    popupState.proposalReview.validationIssues.length > 0 ||
    popupState.proposalReview.regenerationReasons.length > 0 ||
    popupState.proposalReview.signalAcknowledgementRequired ||
    popupState.proposalReview.status === "target_invalid"
  ) {
    await bestEffortDiagnostic(() => recordOperationalDiagnostic({
      kind: "proposal_stale",
      source: "manual",
      detail: "The tab set changed before confirmation. Nothing moved.",
    }));
    await writeProposalReview(popupState.proposalReview);
    throw new Error("The tabs changed. Review the updated plan before applying.");
  }
  popupState.proposalReview = confirmProposalReview(popupState.proposalReview, Date.now(), "user");
  await writeProposalReview(popupState.proposalReview);
  stopHeartbeat();
  const response = await send({
    type: "organization:apply",
    reviewId: popupState.proposalReview.reviewId,
    ownerContextId,
    reportOutcome: floatingPage,
  });
  popupState.viewState = response.state;
  if (!response.ok) {
    await initializeTarget();
    popupState.proposalReview = await readProposalReview();
    throw new Error(response.error);
  }
  const transactionId = response.state.transactionRun?.transactionId;
  if (!transactionId) throw new Error("The transaction did not start.");
  // The background transaction owns a complete journal from this point. The
  // proposal is consumed and must not reappear as a stale review if the popup
  // rerenders or post-transaction capture fails.
  popupState.proposalReview = null;
  popupState.providerJob = null;
  await Promise.all([writeProposalReview(null), clearProviderJob()]);
  // Approving is the floating window's last step: the transaction runs on in the
  // background and its outcome arrives as a notification.
  if (floatingPage) {
    await closeFloatingWindow();
    return;
  }
  await followOrganizationTransaction(transactionId);
}

const TERMINAL_RUN_STATUSES: readonly string[] = ["completed", "rolled_back", "rollback_partial", "interrupted", "failed"];

async function followOrganizationTransaction(transactionId: string): Promise<void> {
  const pollDeadline = Date.now() + ORGANIZATION_TRANSACTION.MAX_POLL_MS;
  // The poll runs every 300 ms for the whole apply; most polls see the same
  // state, and a full redraw for each would rebuild the popup ~3 times a second.
  let renderedState: string | null = null;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, ORGANIZATION_TRANSACTION.POLL_INTERVAL_MS));
    const state = await send({ type: "window-capture:get-state" });
    if (!state.ok) throw new Error(`Tabs may still be changing: ${state.error}`);
    popupState.viewState = state.state;
    const run = state.state.transactionRun;
    if (run?.transactionId === transactionId && TERMINAL_RUN_STATUSES.includes(run.status)) {
      break;
    }
    // A transaction that never reaches a terminal status must not leave the
    // popup polling forever with the heartbeat already stopped.
    if (Date.now() >= pollDeadline) {
      throw new Error("The organization transaction did not finish in time. Reopen the popup to check its status.");
    }
    const stateKey = JSON.stringify(state.state);
    if (stateKey !== renderedState) {
      renderedState = stateKey;
      render();
    }
  }
  if (popupState.viewState.transactionRun?.status === "completed") {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (popupState.viewState.undoPoint?.transactionId === transactionId) break;
      await new Promise((resolve) => setTimeout(resolve, ORGANIZATION_TRANSACTION.POLL_INTERVAL_MS));
      const finalized = await send({ type: "window-capture:get-state" });
      popupState.viewState = finalized.state;
      if (!finalized.ok) break;
    }
    const refreshed = await send({ type: "window-capture:refresh" });
    popupState.viewState = refreshed.state;
    popupState.organizerData = await readOrganizerState();
    openPreferredCleanupReview(organizeStartedAt);
  }
  if (popupState.viewState.transactionRun?.status === "completed") {
    const completedTransactionId = popupState.viewState.transactionRun.transactionId;
    // The result view states the outcome; a matching banner would only repeat it.
    visibleResultTransactionId = completedTransactionId;
  }
}

function formatElapsedInactivity(elapsedMs: number | null): string {
  if (elapsedMs === null || !Number.isFinite(elapsedMs)) return "Inactive time unavailable";
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (totalMinutes < 60) {
    const minutes = Math.max(1, totalMinutes);
    return `Inactive ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourText = `${hours} hour${hours === 1 ? "" : "s"}`;
  return minutes === 0
    ? `Inactive ${hourText}`
    : `Inactive ${hourText} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

type CleanupReasonLabel = {
  kind: "duplicate" | "clutter" | "inactive";
  text: string;
};

function cleanupReasonLabels(suggestion: CleanupSuggestion): CleanupReasonLabel[] {
  const labels: CleanupReasonLabel[] = [];
  if (suggestion.reasons.includes("duplicate")) {
    const duplicateLabel = suggestion.duplicate?.kind === "tracking"
      ? "Tracking-parameter copy"
      : suggestion.duplicate?.kind === "fragment"
        ? "Fragment-only copy"
        : "Exact duplicate";
    labels.push({ kind: "duplicate", text: duplicateLabel });
  } else if (suggestion.reasons.includes("possible_duplicate")) {
    labels.push({ kind: "duplicate", text: "Possibly equivalent" });
  }
  if (suggestion.reasons.includes("blank")) {
    labels.push({ kind: "clutter", text: "Blank new tab" });
  }
  if (suggestion.reasons.includes("low_value")) {
    labels.push({ kind: "clutter", text: "Likely clutter" });
  }
  if (suggestion.reasons.includes("inactive")) {
    labels.push({
      kind: "inactive",
      text: formatElapsedInactivity(suggestion.inactiveForMs),
    });
  } else if (suggestion.reasons.includes("low_value")) {
    labels.push({
      kind: "inactive",
      text: formatElapsedInactivity(suggestion.inactiveForMs),
    });
  }
  return labels;
}

function cleanupSelectedByDefault(suggestion: CleanupSuggestion): boolean {
  return !suggestion.reasons.includes("possible_duplicate");
}

// Several panels read the suggestions during one render; each call re-parses
// every tab URL, so share one result for the duration of a render pass.
let cleanupSuggestionsThisRender: CleanupSuggestion[] | null = null;
let renderPassActive = false;

function currentCleanupSuggestions(): CleanupSuggestion[] {
  if (renderPassActive && cleanupSuggestionsThisRender) return cleanupSuggestionsThisRender;
  const suggestions = computeCleanupSuggestions();
  if (renderPassActive) cleanupSuggestionsThisRender = suggestions;
  return suggestions;
}

function computeCleanupSuggestions(): CleanupSuggestion[] {
  const state = popupState.viewState.editor?.capturedState;
  const workflow = popupState.organizerData?.local.workflow;
  if (!state || !workflow) return [];
  return findCleanupSuggestions(state, Date.now(), {
    inactiveAfterMs: workflow.inactiveSuggestionHours * 60 * 60_000,
    lowValueAfterMs: workflow.lowValueSuggestionHours * 60 * 60_000,
    lowValueTabIds: popupState.viewState.transactionRun?.proposal.lowValueTabIds ?? [],
  }).filter((suggestion) => !ignoredCleanupTabIds.has(suggestion.tabId));
}

function openPreferredCleanupReview(since: number): void {
  if (
    lastUserInteractionAt >= since ||
    cleanupReviewDismissed ||
    !popupState.organizerData?.local.workflow.alwaysShowCleanupReview ||
    popupState.viewState.transactionRun?.status !== "completed"
  ) {
    return;
  }
  if (currentCleanupSuggestions().length === 0) return;
  selectCleanupUtilityView();
}

// The cleanup warning is a stable live region outside the rebuilt subtree, so a
// re-render that leaves the message unchanged does not re-announce the whole
// sentence. The visible paragraph is plain text; this node carries the speech.
let cleanupAnnouncer: HTMLElement | null = null;
let lastCleanupAnnouncement = "";
function announceCleanupWarning(message: string): void {
  if (!cleanupAnnouncer) {
    cleanupAnnouncer = element("p", "visually-hidden");
    cleanupAnnouncer.setAttribute("role", "status");
    cleanupAnnouncer.setAttribute("aria-live", "polite");
    document.body.append(cleanupAnnouncer);
  }
  if (lastCleanupAnnouncement === message) return;
  lastCleanupAnnouncement = message;
  cleanupAnnouncer.textContent = message;
}

// Same idea for confirmations that should be spoken without adding a visible notice.
let statusAnnouncer: HTMLElement | null = null;
function announceStatus(message: string): void {
  if (!statusAnnouncer) {
    statusAnnouncer = element("p", "visually-hidden");
    statusAnnouncer.setAttribute("role", "status");
    statusAnnouncer.setAttribute("aria-live", "polite");
    document.body.append(statusAnnouncer);
  }
  statusAnnouncer.textContent = message;
}

function renderCleanupSuggestions(
  section: HTMLElement,
  suggestions: CleanupSuggestion[],
): void {
  const cleanup = element(
    "section",
    `cleanup-review${cleanupReviewOpen ? " cleanup-review--sidecar" : ""}`,
  );
  const heading = element("div", "cleanup-review__heading");
  heading.append(
    element(
      "strong",
      undefined,
      `${suggestions.length} tab${suggestions.length === 1 ? " may" : "s may"} be worth closing`,
    ),
  );
  cleanup.append(heading);

  if (!cleanupReviewOpen) {
    // Leaving cleanup clears the announcer so re-entering speaks the warning again.
    lastCleanupAnnouncement = "";
    if (cleanupAnnouncer) cleanupAnnouncer.textContent = "";
    return;
  }

  const filterCounts = cleanupSuggestionFilterCounts(suggestions);
  const filters = element("div", "cleanup-review__filters");
  const filterLabels: Array<[CleanupSuggestionFilter, string]> = [
    ["all", "All"],
    ["duplicate", "Duplicates"],
    ["clutter", "Clutter"],
    ["inactive", "Inactive"],
  ];
  // Only reasons that are present get a segment, and a single reason needs no
  // filter at all: "All" would show the same list.
  if (cleanupSuggestionFilter !== "all" && filterCounts[cleanupSuggestionFilter] === 0) cleanupSuggestionFilter = "all";
  const presentFilters = filterLabels.filter(([filter]) => filter !== "all" && filterCounts[filter] > 0);
  if (presentFilters.length < 2) cleanupSuggestionFilter = "all";
  filterLabels.filter(([filter]) => presentFilters.length >= 2 && (filter === "all" || filterCounts[filter] > 0)).forEach(([filter, label]) => {
    const control = element(
      "button",
      `cleanup-filter__button${cleanupSuggestionFilter === filter ? " cleanup-filter__button--active" : ""}`,
      `${label} ${filterCounts[filter]}`,
    );
    control.type = "button";
    control.dataset.focusKey = `cleanup-filter-${filter}`;
    control.setAttribute("aria-pressed", String(cleanupSuggestionFilter === filter));
    control.addEventListener("click", () => {
      cleanupSuggestionFilter = filter;
      render();
    });
    filters.append(control);
  });
  if (filters.childElementCount > 0) cleanup.append(filters);

  const filteredSuggestions = suggestions.filter((suggestion) =>
    cleanupSuggestionMatchesFilter(suggestion, cleanupSuggestionFilter),
  );
  const list = element("div", "cleanup-review__list");
  filteredSuggestions.forEach((suggestion) => {
    const row = element("label", "cleanup-review__item");
    const control = element("input");
    control.type = "checkbox";
    control.dataset.focusKey = `cleanup-tab-${suggestion.tabId}`;
    control.checked = selectedCleanupTabIds.has(suggestion.tabId);
    control.addEventListener("change", () => {
      if (control.checked) selectedCleanupTabIds.add(suggestion.tabId);
      else selectedCleanupTabIds.delete(suggestion.tabId);
      cleanupCloseArmed = false;
      render();
    });
    const rowCopy = element("span", "cleanup-review__item-copy");
    const reasons = element("span", "cleanup-review__reasons");
    cleanupReasonLabels(suggestion).forEach((reason) => {
      reasons.append(
        element(
          "small",
          `cleanup-reason cleanup-reason--${reason.kind}`,
          reason.text,
        ),
      );
    });
    rowCopy.append(
      element("strong", undefined, suggestion.title),
      element("span", "cleanup-review__location", cleanupLocation(suggestion.url)),
      reasons,
    );
    if (suggestion.duplicate) {
      rowCopy.append(
        element("span", "cleanup-review__keeper", suggestion.duplicate.keeperReason),
      );
    }
    row.append(control, rowCopy);
    list.append(row);
  });
  if (filteredSuggestions.length === 0) {
    cleanup.append(
      element("p", "cleanup-review__empty", "No suggestions match this filter."),
    );
  } else {
    cleanup.append(list);
  }

  const selectedTabIds = suggestions
    .filter((suggestion) => selectedCleanupTabIds.has(suggestion.tabId))
    .map((suggestion) => suggestion.tabId);
  const selectedCount = selectedTabIds.length;
  const actions = element("div", "action-row cleanup-review__actions");
  const selectAllButton = button(
    selectedCount === 0 ? "Select all" : "Deselect all",
    "quiet",
    () => {
      if (selectedCount === 0) {
        filteredSuggestions.forEach((suggestion) => selectedCleanupTabIds.add(suggestion.tabId));
      } else {
        selectedCleanupTabIds.clear();
      }
      cleanupCloseArmed = false;
      render();
    },
  );
  selectAllButton.dataset.focusKey = "cleanup-select-all";
  const commitActions = element("div", "cleanup-review__commit-actions");
  const stashButton = button(
    `Save & close ${selectedCount} tab${selectedCount === 1 ? "" : "s"}`,
    "secondary",
    () => {
      cleanupCloseArmed = false;
      void perform("cleanup-stash", async () => {
        if (popupState.targetWindowId === null || selectedTabIds.length === 0) {
          throw new Error("Select at least one suggested tab to save.");
        }
        const state = popupState.viewState.editor?.capturedState;
        if (!state) throw new Error("The reviewed window is no longer available.");
        const scope = { mode: "selection" as const, tabIds: selectedTabIds };
        const preview = buildTabStashPreview(state, scope);
        const response = await send({
          type: "workspace:create",
          targetWindowId: popupState.targetWindowId,
          scope,
          expectedTabIds: preview.tabs.map((tab) => tab.sourceTabId),
          name: preview.name,
        });
        popupState.viewState = response.state;
        if (!response.ok) throw new Error(response.error);
        popupState.savedStashes = await readTabStashes();
        cleanupReviewOpen = false;
        cleanupReviewDismissed = true;
        cleanupSuggestionFilter = "all";
        selectedCleanupTabIds.clear();
        cleanupCloseArmed = false;
        popupState.notice = {
          tone: "success",
          text: `${preview.tabs.length} selected tab${preview.tabs.length === 1 ? "" : "s"} saved as a workspace and closed. Reopen them anytime from Workspaces.`,
        };
      });
    },
    {
      actionName: "cleanup-stash",
      busyLabel: "Saving and closing…",
      disabled: selectedCount === 0,
    },
  );
  stashButton.dataset.focusKey = "cleanup-stash";
  const closeButton = button(
    cleanupCloseArmed
      ? `Confirm close ${selectedCount}`
      : `Close ${selectedCount} tab${selectedCount === 1 ? "" : "s"}`,
    "danger",
    () => {
      if (!cleanupCloseArmed) {
        cleanupCloseArmed = true;
        render();
        return;
      }
      void perform("cleanup-close", async () => {
        if (popupState.targetWindowId === null || selectedTabIds.length === 0) {
          throw new Error("Select at least one suggested tab to close.");
        }
        const requested = selectedTabIds;
        const response = await send({
          type: "cleanup:close-suggested-tabs",
          targetWindowId: popupState.targetWindowId,
          tabIds: requested,
        });
        popupState.viewState = response.state;
        if (!response.ok) throw new Error(response.error);
        const result = response.cleanupCloseResult;
        if (!result) throw new Error("The cleanup result was missing.");
        const refreshedSuggestions = currentCleanupSuggestions();
        const hasRemainingSuggestions = refreshedSuggestions.length > 0;
        cleanupReviewOpen = result.skipped > 0 && hasRemainingSuggestions;
        cleanupReviewDismissed = !cleanupReviewOpen;
        selectedCleanupTabIds.clear();
        cleanupCloseArmed = false;
        if (cleanupReviewOpen) {
          refreshedSuggestions.filter(cleanupSelectedByDefault).forEach((suggestion) =>
            selectedCleanupTabIds.add(suggestion.tabId),
          );
        }
        popupState.notice = {
          tone: result.closed > 0 && result.skipped === 0 ? "success" : "info",
          text: result.closed === 0
            ? `No tabs were closed. ${result.skipped} selection${result.skipped === 1 ? " was" : "s were"} kept because the tabs changed after review.`
            : `${result.closed} reviewed tab${result.closed === 1 ? "" : "s"} closed${result.skipped > 0 ? ` · ${result.skipped} kept because they changed after review` : ""}.`,
        };
      });
    },
    {
      actionName: "cleanup-close",
      busyLabel: "Rechecking tabs…",
      disabled: selectedCount === 0,
    },
  );
  closeButton.dataset.focusKey = "cleanup-close";
  commitActions.append(stashButton, closeButton);
  // One row: the quiet selection toggle leads, the commit pair follows.
  actions.append(selectAllButton, commitActions);
  cleanup.append(actions);
  // Only the armed close needs a warning; the resting state speaks for itself.
  const warningText = cleanupCloseArmed
    ? `Close ${selectedCount} selected tab${selectedCount === 1 ? "" : "s"} permanently? This cannot be undone.`
    : "";
  announceCleanupWarning(warningText);
  if (warningText) cleanup.append(element("p", "cleanup-review__warning", warningText));
  section.append(cleanup);
}

async function runAvailableUndo(): Promise<void> {
  const undo = popupState.viewState.undoPoint;
  if (!undo || undo.status !== "available") throw new Error("Undo is unavailable.");
  const response = await send({
    type: "organization:undo",
    transactionId: undo.transactionId,
  });
  popupState.viewState = response.state;
  organizationHistory = await readCountsOnlyHistory();
  if (!response.ok) throw new Error(response.error);
  // The result view now carries the outcome and any conflicts, titled by tab.
  popupState.notice = null;
  if (popupState.viewState.transactionRun?.transactionId === undo.transactionId) {
    visibleResultTransactionId = undo.transactionId;
  }
}

// Background messages name tabs by browser ID ("Tab 482 is missing."), which the
// user has never seen. The run's own snapshot knows every title, so swap them in.
function nameTabsIn(text: string, snapshot: SemanticWindowState | null | undefined): string {
  if (!snapshot) return text.replace(/\bTab \d+\b/g, "A tab");
  const titles = new Map(snapshot.tabs.map((tab) => [tab.id, tab.title]));
  return text.replace(/\bTab (\d+)\b/g, (_match, id: string) => {
    const title = titles.get(Number(id));
    return title === undefined ? "A tab" : quotedTabTitle(title);
  });
}

function renderIssueList(issues: readonly string[], snapshot: SemanticWindowState | null | undefined): HTMLElement {
  const list = element("ul", "result-issues");
  [...new Set(issues.map((issue) => nameTabsIn(issue, snapshot)))]
    .slice(0, 8)
    .forEach((issue) => list.append(element("li", undefined, issue)));
  if (issues.length > 8) list.append(element("li", undefined, `${issues.length - 8} more in Diagnostics.`));
  return list;
}

interface ResultCopy {
  tone: "success" | "warning" | "error";
  icon: UtilityNavIcon;
  title: string;
  body: string;
  issues: string[];
  issueSnapshot: SemanticWindowState | null | undefined;
}

function resultCopy(run: OrganizationRun): ResultCopy {
  const snapshot = run.journal.rollbackSnapshot;
  const cause = run.error ? nameTabsIn(run.error, snapshot) : null;
  const undo = popupState.viewState.undoPoint;
  if (run.status === "completed" && undo?.transactionId === run.transactionId &&
    (undo.status === "completed" || undo.status === "partial")) {
    return undo.status === "completed"
      ? {
        tone: "success",
        icon: "history",
        title: "Organization undone",
        body: "Tabs are back in their original groups and order. Closed blank tabs were not reopened.",
        issues: [],
        issueSnapshot: undo.before,
      }
      : {
        tone: "warning",
        icon: "history",
        title: "Organization partly undone",
        body: "Undo restored every tab it safely could. These tabs changed after organizing, so Undo left them as they are now:",
        issues: undo.conflicts,
        issueSnapshot: undo.before,
      };
  }
  switch (run.status) {
    case "completed":
      return {
        tone: "success",
        icon: "check",
        title: "Window organized",
        body: `${formatCount(run.journal.touchedTabIds.length, "tab")} regrouped${
          run.journal.arrangedTabIds?.length
            ? `, ${formatCount(run.journal.arrangedTabIds.length, "ungrouped tab")} arranged`
            : ""
        }, verified against the browser.`,
        issues: [],
        issueSnapshot: snapshot,
      };
    case "rolled_back":
      return {
        tone: "warning",
        icon: "history",
        title: "Apply stopped. Your window was restored.",
        body: `Every tab is back in its original group and position.${cause ? ` What stopped it: ${cause}` : ""}`,
        issues: [],
        issueSnapshot: snapshot,
      };
    case "rollback_partial":
      return {
        tone: "error",
        icon: "alert",
        title: "Apply stopped. Some tabs couldn't be put back.",
        body: `${cause ? `What stopped it: ${cause} ` : ""}Everything else is back where it was. Check these tabs:`,
        issues: run.rollbackVerification?.issues ?? [],
        issueSnapshot: snapshot,
      };
    case "interrupted":
      return {
        tone: "warning",
        icon: "alert",
        title: "Apply was interrupted",
        body: cause ?? "The browser stopped the extension mid-apply. Check the window before organizing again.",
        issues: [],
        issueSnapshot: snapshot,
      };
    default:
      return {
        tone: "error",
        icon: "alert",
        title: "Apply didn't run",
        body: cause ?? "Nothing moved.",
        issues: [],
        issueSnapshot: snapshot,
      };
  }
}

function renderResult(shell: HTMLElement): void {
  const run = popupState.viewState.transactionRun;
  if (!run || popupState.proposalReview) return;
  const copy = resultCopy(run);
  const complete = run.status === "completed";
  const undoAvailable = complete && popupState.viewState.undoPoint?.status === "available" &&
    popupState.viewState.undoPoint.transactionId === run.transactionId;
  // A clean outcome is the same compact bar every view uses; only a failure or a
  // partial Undo keeps the full statement with the tabs that need checking.
  const compact = complete && copy.issues.length === 0;
  const section = element("section", `result${compact ? " result--compact" : ""}`);
  if (compact) {
    renderResultBar(section, true);
  }
  const main = element("div", "result__main");
  if (!compact) {
    const status = element("div", `result__status result__status--${copy.tone}`);
    const mark = element("span", `result-mark result-mark--${copy.tone}`);
    mark.append(utilityNavIcon(copy.icon));
    const statusCopy = element("div");
    statusCopy.append(element("h2", undefined, copy.title), element("p", "section-copy", copy.body));
    if (copy.issues.length > 0) statusCopy.append(renderIssueList(copy.issues, copy.issueSnapshot));
    status.append(mark, statusCopy);
    main.append(status);
  }
  const state = popupState.viewState.editor?.capturedState;
  if (complete && state) main.append(renderSortingFrame(state, "This window"));
  // The next step sits in the same commit foot as the Organize home.
  const foot = element("div", "commit-foot commit-foot--ready");
  const failed = !complete;
  if (failed) {
    const actions = element("div", "commit-foot__actions");
    actions.append(
      button("Open diagnostics", "quiet", () => openFullExtensionPage("diagnostics")),
      button("Try again", "secondary", () => {
        void perform("generate", generateProposal);
      }, { actionName: "generate", busyLabel: "Finding topics…" }),
    );
    foot.append(actions);
  } else {
    foot.append(button("Organize again", undoAvailable ? "secondary" : "primary", () => {
      void perform("generate", generateProposal);
    }, { actionName: "generate", busyLabel: "Finding topics…", shortcut: !undoAvailable }));
  }
  main.append(foot);
  section.append(main);
  shell.append(section);
}

// The outcome of the last run, with its Undo, at the top of Organize and Cleanup.
// Undo's one caveat rides on the button rather than as standing fine print.
function renderResultBar(shell: HTMLElement, force = false): void {
  const run = popupState.viewState.transactionRun;
  if (!run || run.status !== "completed" || popupState.proposalReview) return;
  if (!force && visibleResultTransactionId !== run.transactionId) return;
  const bar = element("div", "result-bar");
  const outcome = resultCopy(run);
  const mark = element("span", `result-mark result-mark--${outcome.tone}`);
  mark.append(utilityNavIcon(outcome.icon));
  const copy = element("div", "result-bar__copy");
  const blank = run.blankTabCloseResult;
  const blankNote = blank && blank.requested > 0
    ? ` · ${formatCount(blank.closed, "blank tab")} closed${blank.skipped ? `, ${blank.skipped} skipped` : ""}`
    : "";
  copy.append(
    element("h2", undefined, outcome.title),
    element("p", undefined, outcome.icon === "check"
      ? `${formatCount(run.journal.touchedTabIds.length, "tab")} regrouped, verified${blankNote}`
      : outcome.issues.length > 0
        ? `${formatCount(outcome.issues.length, "tab")} left as they are now`
        : "Original groups and order restored"),
  );
  bar.append(mark, copy);
  if (popupState.viewState.undoPoint?.status === "available" && popupState.viewState.undoPoint.transactionId === run.transactionId) {
    const undo = button(
      "Undo",
      "secondary",
      () => void perform("undo", runAvailableUndo),
      { actionName: "undo", busyLabel: "Checking…" },
    );
    undo.setAttribute("aria-label", "Undo organization");
    const caveat = blank && blank.closed > 0
      ? "Restores the original groups and tab order. Closed blank tabs are not reopened."
      : "Restores the original groups and tab order.";
    undo.title = caveat;
    undo.setAttribute("aria-description", caveat);
    bar.append(undo);
  }
  shell.append(bar);
}

// A first run with no provider is the product's highest-uncertainty moment, so
// it gets a framed explanation and a way forward rather than a greyed button.
let firstRunDismissed = false;

function renderFirstRunCard(): HTMLElement {
  const card = element("div", "first-run");
  card.append(
    element("h2", "first-run__heading", "Connect a model to organize"),
    element(
      "p",
      "first-run__copy",
      "Sheaf uses an AI model you choose to propose tab groups. Setup takes three short steps, and you choose what leaves the browser.",
    ),
  );
  const actions = element("div", "first-run__actions");
  const setup = button("Set up Sheaf", "primary", () => {
    firstRunDismissed = true;
    openSetupPage();
  });
  setup.dataset.focusKey = "first-run-setup";
  const skip = button("Skip for now", "quiet", () => {
    firstRunDismissed = true;
    render();
  });
  skip.dataset.focusKey = "first-run-skip";
  actions.append(setup, skip);
  card.append(actions);
  return card;
}

function renderReady(shell: HTMLElement): void {
  if (popupState.proposalReview && !isSkippingReview()) return;
  const body = element("section", "ready");
  const heading = element("h2", "visually-hidden", "Organize tabs");
  body.append(heading);
  if (popupState.discardedPlanReason) {
    const discarded = element("p", "plan-discarded", `Your reviewed plan was discarded because ${popupState.discardedPlanReason}. Organize again for a new plan.`);
    discarded.setAttribute("role", "status");
    body.append(discarded);
  }
  const filingSuggestion = busyAction === "generate" ? null : renderAutoFilingSuggestion();
  if (filingSuggestion) body.append(filingSuggestion);
  const state = popupState.viewState.editor?.capturedState;
  if (state) {
    body.append(renderSortingFrame(state, "This window", renderFeatureSwitches()));
  }
  const controls = element("div", "ready__controls");
  renderScopeControl(controls);
  body.append(controls);
  const scopeLabel = popupState.viewState.editor
    ? organizationScopeLabel(popupState.viewState.editor.capturedState, organizationScope)
    : "selected scope";
  const skipsReview = popupState.organizerData?.local.workflow.organizeWithoutReview === true;
  const organize = button(
    "Organize",
    "primary",
    () => void perform("generate", generateProposal),
    {
      actionName: "generate",
      busyLabel: skipsReview ? "Organizing…" : "Finding topics…",
      disabled: !providerConfigured() || !popupState.immutableRequest,
      shortcut: true,
    },
  );
  organize.setAttribute("aria-label", `Organize ${scopeLabel.toLocaleLowerCase()}`);
  if (!providerConfigured() && !firstRunDismissed) {
    body.append(renderFirstRunCard());
    shell.append(body);
    return;
  }
  const foot = element("div", "commit-foot commit-foot--ready");
  foot.append(organize);
  if (busyAction === "generate" && backgroundJobInFlight() && !popupState.providerJob?.transactionId) {
    // Not built with button(): that helper disables every control while busy.
    const cancel = element("button", "button button--quiet", "Cancel");
    cancel.type = "button";
    cancel.dataset.focusKey = "cancel-organize";
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      cancelBackgroundOrganize();
    });
    foot.append(cancel);
  }
  if (busyAction === "generate") {
    foot.append(element(
      "p",
      "intro",
      "You can close this popup. Organizing continues in the background.",
    ));
  } else if (!providerConfigured()) {
    const setup = element("button", "setup-link", "Connect a model to organize");
    setup.type = "button";
    setup.dataset.focusKey = "ready-setup";
    setup.addEventListener("click", openSetupPage);
    foot.append(setup);
  } else if (!popupState.immutableRequest) {
    foot.append(
      element(
        "p",
        "empty-note",
        requestBuildError ?? "No tabs are eligible. Check local-page and domain settings.",
      ),
    );
  }
  body.append(foot);
  shell.append(body);
}

function openProtectionManager(): void {
  resetUtilityScroll = true;
  showUtilityView("protection");
  popupState.pendingFocusKey = "held-back";
  render();
}

function renderScopeControl(body: HTMLElement): void {
  const state = popupState.viewState.editor?.capturedState;
  if (!state) return;
  organizationScope = normalizeOrganizationScope(state, organizationScope);

  const section = element("section", "scope-control");
  section.append(element("h3", undefined, "Scope"));
  const mode = element("select", "input scope-select");
  mode.setAttribute("aria-label", "Organization scope");
  const options: Array<{
    value: OrganizationScope["mode"];
    label: string;
    disabled?: boolean;
  }> = [
    { value: "window", label: "Current window" },
    { value: "selected_tabs", label: "Selected tabs" },
    { value: "group", label: "One existing group", disabled: state.groups.length === 0 },
    { value: "ungrouped", label: "Ungrouped tabs only" },
    {
      value: "exclude_groups",
      label: "Everything except selected groups",
      disabled: state.groups.length === 0,
    },
  ];
  options.forEach((item) => {
    const option = element("option", undefined, item.label);
    option.value = item.value;
    option.disabled = item.disabled ?? false;
    option.selected = organizationScope.mode === item.value;
    mode.append(option);
  });
  mode.addEventListener("change", () => {
    const selectedMode = mode.value as OrganizationScope["mode"];
    const firstGroupId = state.groups[0]?.runtimeId;
    const next: OrganizationScope =
      selectedMode === "group" && firstGroupId !== undefined
        ? { mode: "group", groupId: firstGroupId }
        : selectedMode === "exclude_groups"
          ? { mode: "exclude_groups", groupIds: [] }
          : selectedMode === "selected_tabs"
            ? { mode: "selected_tabs" }
            : selectedMode === "ungrouped"
              ? { mode: "ungrouped" }
              : WHOLE_WINDOW_SCOPE;
    void perform("scope", async () => {
      organizationScope = next;
      popupState.immutableRequest = null;
      await rebuildRequest();
    });
  });
  section.append(mode);

  if (organizationScope.mode === "group") {
    const selectedGroupId = organizationScope.groupId;
    const groupSelect = element("select", "input scope-select");
    groupSelect.setAttribute("aria-label", "Existing group to organize");
    state.groups.forEach((group) => {
      const option = element(
        "option",
        undefined,
        `${group.title.trim() || "Untitled group"} · ${group.memberTabIds.length} tabs`,
      );
      option.value = String(group.runtimeId);
      option.selected = group.runtimeId === selectedGroupId;
      groupSelect.append(option);
    });
    groupSelect.addEventListener("change", () => {
      void perform("scope", async () => {
        organizationScope = { mode: "group", groupId: Number(groupSelect.value) };
        popupState.immutableRequest = null;
        await rebuildRequest();
      });
    });
    section.append(groupSelect);
  }

  if (organizationScope.mode === "exclude_groups") {
    const choices = element("fieldset", "scope-groups");
    choices.append(element("legend", undefined, "Leave these groups unchanged"));
    state.groups.forEach((group) => {
      const label = element("label", "scope-group");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = organizationScope.mode === "exclude_groups" &&
        organizationScope.groupIds.includes(group.runtimeId);
      checkbox.addEventListener("change", () => {
        const selected = new Set(
          organizationScope.mode === "exclude_groups"
            ? organizationScope.groupIds
            : [],
        );
        if (checkbox.checked) selected.add(group.runtimeId);
        else selected.delete(group.runtimeId);
        void perform("scope", async () => {
          organizationScope = { mode: "exclude_groups", groupIds: [...selected] };
          popupState.immutableRequest = null;
          await rebuildRequest();
        });
      });
      const copy = element("span");
      copy.append(
        element("strong", undefined, group.title.trim() || "Untitled group"),
        element("small", undefined, `${group.memberTabIds.length} tabs`),
      );
      label.append(checkbox, copy);
      choices.append(label);
    });
    section.append(choices);
  }

  const help = organizationScope.mode === "selected_tabs"
    ? "Select tabs with Cmd/Ctrl-click before opening."
    : organizationScope.mode === "exclude_groups"
      ? "Checked groups stay untouched."
      : null;
  if (help) section.append(element("p", "scope-help", help));
  body.append(section);
}

function renderLoading(shell: HTMLElement): void {
  const body = element("section", "loading");
  body.append(element("div", "skeleton skeleton--title"));
  body.append(element("div", "skeleton skeleton--copy"));
  body.append(element("div", "skeleton skeleton--button"));
  shell.append(body);
}

function diagnosticTitle(event: DiagnosticEvent): string {
  switch (event.kind) {
    case "provider_validated": return "Provider response validated";
    case "provider_repaired": return "Invalid output repaired";
    case "provider_invalid": return "Model output remained invalid";
    case "provider_failed": return "Provider request failed";
    case "proposal_stale": return "Proposal became stale";
    case "rollback_complete": return "Rollback completed";
    case "rollback_partial": return "Rollback was partial";
    case "undo_completed": return "Undo completed";
    case "undo_partial": return "Undo left conflicts";
    case "auto_filing": return "Auto-filing decision";
    case "auto_filing_failed": return "Auto-filing request failed";
    case "storage_lock_released": return "Storage lock force-released";
  }
}

function diagnosticTone(event: DiagnosticEvent): "success" | "warning" | "error" | "neutral" {
  switch (event.kind) {
    case "provider_validated":
    case "provider_repaired":
    case "rollback_complete":
    case "undo_completed":
    case "auto_filing":
      return "success";
    case "proposal_stale":
    case "undo_partial":
    case "storage_lock_released":
      return "warning";
    case "provider_invalid":
    case "provider_failed":
    case "rollback_partial":
    case "auto_filing_failed":
      return "error";
  }
}

function diagnosticUsage(event: DiagnosticEvent): string[] {
  if (!event.usage) return [];
  const values: string[] = [];
  if (event.usage.promptTokens !== null) values.push(`${event.usage.promptTokens} input`);
  if (event.usage.completionTokens !== null) values.push(`${event.usage.completionTokens} output`);
  if (event.usage.totalTokens !== null) values.push(`${event.usage.totalTokens} total`);
  if (event.usage.cachedTokens !== null) values.push(`${event.usage.cachedTokens} cached`);
  return values;
}

function renderDiagnosticsPage(shell: HTMLElement): void {
  if (!diagnosticsPage) return;
  const panel = element("section", "diagnostics-panel");
  panel.setAttribute("aria-labelledby", "diagnostics-title");
  const title = element("h2", undefined, "Run diagnostics");
  title.id = "diagnostics-title";
  const heading = element("div", "diagnostics-heading");
  const headingCopy = element("div");
  headingCopy.append(
    title,
    element(
      "p",
      "section-copy",
      "A bounded local event log with no tab titles, URLs, raw model output, API keys, or custom-header values.",
    ),
  );
  heading.append(headingCopy);
  panel.append(heading);

  const providerEvents = diagnosticsState.events.filter((event) =>
    event.kind.startsWith("provider_"),
  );
  const attentionEvents = diagnosticsState.events.filter((event) =>
    ["provider_invalid", "provider_failed", "proposal_stale", "rollback_partial", "undo_partial"]
      .includes(event.kind),
  );
  const reportedUsage = providerEvents.filter((event) => event.usage?.totalTokens !== null).length;
  const overview = element("dl", "diagnostics-overview");
  [
    ["Provider runs", String(providerEvents.length)],
    ["Needs attention", String(attentionEvents.length)],
    ["Usage reported", `${reportedUsage} of ${providerEvents.length}`],
  ].forEach(([label, value]) => {
    const fact = element("div");
    fact.append(element("dt", undefined, label), element("dd", undefined, value));
    overview.append(fact);
  });
  panel.append(overview);

  const pricing = element("section", "diagnostics-pricing");
  pricing.append(
    element("h3", undefined, "Cost estimates"),
    element(
      "p",
      "settings-group__copy",
      "Optional prices are applied only to future provider-reported token counts. Each measured run is projected to 1,000 activations so small differences remain legible.",
    ),
  );
  const priceFields = element("div", "diagnostics-pricing__fields");
  const inputPrice = input(String(diagnosticsState.pricing.inputPerMillionUsd), "number");
  inputPrice.min = "0";
  inputPrice.step = "0.000001";
  const outputPrice = input(String(diagnosticsState.pricing.outputPerMillionUsd), "number");
  outputPrice.min = "0";
  outputPrice.step = "0.000001";
  priceFields.append(
    field("Input $ / 1M tokens", inputPrice),
    field("Output $ / 1M tokens", outputPrice),
  );
  pricing.append(
    priceFields,
    button(
      "Save cost settings",
      "secondary",
      () => {
        void perform("diagnostic-pricing", async () => {
          const next = {
            inputPerMillionUsd: Number(inputPrice.value),
            outputPerMillionUsd: Number(outputPrice.value),
          };
          if (
            !Number.isFinite(next.inputPerMillionUsd) || next.inputPerMillionUsd < 0 ||
            !Number.isFinite(next.outputPerMillionUsd) || next.outputPerMillionUsd < 0
          ) {
            throw new Error("Token prices must be zero or positive numbers.");
          }
          diagnosticsState = await writeDiagnosticPricing(next);
          popupState.notice = { tone: "success", text: "Diagnostic cost settings saved." };
        });
      },
      { actionName: "diagnostic-pricing", busyLabel: "Saving…" },
    ),
  );
  panel.append(pricing);

  const historyHeading = element("div", "diagnostics-history-heading");
  const historyCopy = element("div");
  historyCopy.append(
    element("h3", undefined, "Recent events"),
    element("p", undefined, `Newest first · up to 100 local records`),
  );
  historyHeading.append(historyCopy);
  if (diagnosticsState.events.length > 0) {
    if (diagnosticClearArmed) {
      const confirmation = element("div", "diagnostics-clear-confirmation");
      confirmation.append(
        element("span", undefined, "Clear all diagnostic events? Cost settings will stay."),
        button(
          "Confirm clear",
          "danger",
          () => {
            void perform("diagnostic-clear", async () => {
              await clearDiagnosticEvents();
              diagnosticsState = await readDiagnosticsState();
              diagnosticClearArmed = false;
              popupState.notice = { tone: "success", text: "Diagnostic event history cleared." };
            });
          },
          { actionName: "diagnostic-clear", busyLabel: "Clearing…" },
        ),
        button("Cancel", "quiet", () => {
          diagnosticClearArmed = false;
          render();
        }),
      );
      historyHeading.append(confirmation);
    } else {
      historyHeading.append(
        button("Clear event history", "quiet", () => {
          diagnosticClearArmed = true;
          render();
        }),
      );
    }
  }
  panel.append(historyHeading);

  if (diagnosticsState.events.length === 0) {
    panel.append(
      element(
        "p",
        "diagnostics-empty",
        "No diagnostics recorded yet. Provider runs and recovery events will appear here.",
      ),
    );
    shell.append(panel);
    return;
  }

  const list = element("ol", "diagnostics-list");
  [...diagnosticsState.events].reverse().forEach((event) => {
    const item = element("li", `diagnostic-event diagnostic-event--${diagnosticTone(event)}`);
    const eventHeading = element("div", "diagnostic-event__heading");
    const title = element("div");
    title.append(
      element("strong", undefined, diagnosticTitle(event)),
      element(
        "time",
        undefined,
        new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(event.timestamp),
      ),
    );
    eventHeading.append(
      title,
      element("span", "diagnostic-event__source", event.source.replaceAll("_", " ")),
    );
    item.append(eventHeading);
    if (event.providerOrigin || event.model) {
      item.append(
        element(
          "p",
          "diagnostic-event__provider",
          [event.model, event.providerOrigin].filter(Boolean).join(" · "),
        ),
      );
    }
    const facts = element("div", "diagnostic-event__facts");
    if (event.durationMs !== null) {
      facts.append(element("span", undefined, `${formatHistoryDuration(event.durationMs)} latency`));
    }
    diagnosticUsage(event).forEach((value) => facts.append(element("span", undefined, value)));
    if (event.estimatedCostUsd !== null) {
      facts.append(element("span", undefined, `Est. ${projectedCostForThousandActivations(event.estimatedCostUsd)}`));
    }
    if (event.conflictCount !== null) {
      facts.append(element("span", undefined, `${event.conflictCount} conflicts`));
    }
    if (facts.childElementCount > 0) item.append(facts);
    if (event.detail) item.append(element("p", "diagnostic-event__detail", event.detail));
    list.append(item);
  });
  panel.append(list);
  shell.append(panel);
}

function formatHistoryDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "Duration unavailable";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function historyUndoLabel(report: OrganizationHistoryReport): string {
  switch (report.undoStatus) {
    case "available": return "Full undo available";
    case "running": return "Undo in progress";
    case "completed": return "Undone";
    case "partial": return `Partial restore · ${report.undoConflictCount ?? 0} conflicts`;
    case "unavailable": return "Undo is no longer available in this browser session";
  }
}

// Per-run disclosure state survives re-renders; the newest run starts open.
const historyDisclosure = new Map<number, boolean>();

const HISTORY_RUN_HEADLINES: Record<OrganizationHistoryReport["resultStatus"], string> = {
  prepared: "Didn't start",
  applying: "Stopped while applying",
  verifying: "Stopped while verifying",
  completed: "",
  rolling_back: "Stopped while rolling back",
  rolled_back: "Rolled back",
  rollback_partial: "Rollback incomplete",
  interrupted: "Interrupted",
  failed: "Failed",
};

function historyDayLabel(timestamp: number, now = new Date()): string {
  const day = new Date(timestamp);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(day)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(day);
}

const numberFormat = new Intl.NumberFormat();

function formatSeconds(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function historyTabsMoved(report: OrganizationHistoryReport): number {
  return report.tabChanges ? totalTabsMoved(report.tabChanges) : report.tabsMoved ?? report.tabsChanged;
}

/** Nonzero tab movements, most significant first. */
function historyTabParts(report: OrganizationHistoryReport): string[] {
  const changes = report.tabChanges;
  if (!changes) return [];
  return ([
    [changes.grouped, "grouped"],
    [changes.regrouped, "changed group"],
    [changes.ungrouped, "left a group"],
    [changes.reordered, "reordered"],
    [changes.closed, "blank closed"],
  ] as const).filter(([count]) => count > 0).map(([count, label]) => `${numberFormat.format(count)} ${label}`);
}

function historyGroupParts(report: OrganizationHistoryReport): string[] {
  const changes = report.groupChanges;
  const parts: [number, string][] = changes
    ? [
        [changes.created, changes.created === 1 ? "new group" : "new groups"],
        [changes.renamed, "renamed"],
        [changes.recolored, "recolored"],
        [changes.removed, changes.removed === 1 ? "group removed" : "groups removed"],
      ]
    : [
        [report.groupsCreated, "created"],
        [report.groupsRenamed ?? 0, "renamed"],
        [report.groupsMerged ?? 0, "merged"],
        [report.groupsSplit ?? 0, "split"],
      ];
  return parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
}

/** "model (low)": the model and its reasoning effort read as one setting. */
function historyModelLabel(report: OrganizationHistoryReport): string {
  const model = report.model || "Unnamed model";
  const effort = report.generation?.reasoningEffort ?? null;
  if (effort === null) return model;
  return `${model} (${effort === "none" ? "no reasoning" : effort})`;
}

function historyTotalTokens(stats: NonNullable<OrganizationHistoryReport["generation"]>): number | null {
  return stats.totalTokens ?? (
    stats.promptTokens !== null && stats.completionTokens !== null ? stats.promptTokens + stats.completionTokens : null
  );
}

/** The one-line model summary under a run; empty for runs recorded before stats existed. */
function historyStatParts(report: OrganizationHistoryReport): string[] {
  const stats = report.generation;
  if (!stats) return [];
  const parts = [historyModelLabel(report)];
  const tokens = historyTotalTokens(stats);
  if (tokens !== null) parts.push(`${numberFormat.format(tokens)} tokens`);
  parts.push(formatHistoryDuration(report.durationMs));
  return parts;
}

function historyTokenFact(stats: NonNullable<OrganizationHistoryReport["generation"]>): string | null {
  const parts: string[] = [];
  if (stats.promptTokens !== null) {
    parts.push(`${numberFormat.format(stats.promptTokens)} in${stats.cachedTokens ? ` (${numberFormat.format(stats.cachedTokens)} cached)` : ""}`);
  }
  if (stats.completionTokens !== null) {
    parts.push(`${numberFormat.format(stats.completionTokens)} out${stats.reasoningTokens ? ` (${numberFormat.format(stats.reasoningTokens)} reasoning)` : ""}`);
  }
  if (parts.length === 0 && stats.totalTokens !== null) parts.push(`${numberFormat.format(stats.totalTokens)} total`);
  return parts.length ? parts.join(" · ") : null;
}

function historySpeedFact(report: OrganizationHistoryReport): string {
  const stats = report.generation;
  const parts = [`${formatHistoryDuration(report.durationMs)} total`];
  if (stats?.providerMs != null) parts.push(`${formatSeconds(stats.providerMs)} model`);
  if (stats?.timeToFirstTokenMs != null) parts.push(`${formatSeconds(stats.timeToFirstTokenMs)} to first token`);
  if (stats?.outputTokensPerSecond != null) parts.push(`${numberFormat.format(Math.round(stats.outputTokensPerSecond))} tok/s`);
  return parts.join(" · ");
}

function renderHistoryRun(report: OrganizationHistoryReport, isLatest: boolean): HTMLElement {
  const completed = report.resultStatus === "completed";
  const tabsMoved = historyTabsMoved(report);
  const tabParts = historyTabParts(report);
  const groupParts = historyGroupParts(report);
  const severity = report.resultStatus === "failed" || report.resultStatus === "rollback_partial" ? "danger" : "warning";

  const item = element("li", `history-item history-run${completed ? "" : ` history-run--${severity}`}`);
  const time = element("time", "history-run__time", new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(report.timestamp));
  time.dateTime = new Date(report.timestamp).toISOString();

  const body = element("details", "history-run__body");
  body.open = historyDisclosure.get(report.timestamp) ?? isLatest;
  body.addEventListener("toggle", () => historyDisclosure.set(report.timestamp, body.open));

  const summary = element("summary", "history-run__summary");
  const text = element("span", "history-run__text");
  const headline = element("strong", "history-run__headline");
  if (completed) {
    headline.textContent = tabsMoved === 0 ? "Nothing needed to move" : `${formatCount(tabsMoved, "tab")} moved`;
  } else {
    headline.append(utilityNavIcon("alert"), document.createTextNode(HISTORY_RUN_HEADLINES[report.resultStatus]));
  }
  text.append(headline);
  // Legacy records only knew group membership changes; say so rather than imply order was tracked.
  const changeLine = [...tabParts, ...groupParts];
  const meta = changeLine.length
    ? changeLine.join(" · ")
    : report.tabChanges ? "No group changes" : `${formatCount(report.groupCount ?? report.groupsCreated, "group")}`;
  text.append(element("span", "history-run__meta", completed ? meta : `Planned: ${meta}`));
  const statParts = historyStatParts(report);
  if (statParts.length) text.append(element("span", "history-run__stats", statParts.join(" · ")));

  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("class", "history-run__chevron");
  chevron.setAttribute("viewBox", "0 0 16 16");
  chevron.setAttribute("aria-hidden", "true");
  const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  chevronPath.setAttribute("d", "M6 4l4 4-4 4");
  chevron.append(chevronPath);
  summary.append(text, chevron);

  const undoRunnableHere = report.undoStatus === "available" && popupState.viewState.undoPoint?.status === "available";
  // History is counts-only and cannot say which window holds an undo point, so a
  // record marked available but not live here must not read like an offer.
  const undoState = report.undoStatus === "available" && !undoRunnableHere ? "elsewhere" : report.undoStatus;
  const undoDetail = undoState === "elsewhere" ? "Not available from this window" : historyUndoLabel(report);

  // Three short sections instead of one long list: what changed (beyond the
  // summary line), which model ran and how it performed, and where it ran.
  const details = element("div", "history-run__details");
  const section = (title: string, facts: [string, string[]][]) => {
    if (facts.length === 0) return;
    const block = element("section", "history-run__section");
    const list = element("dl", "history-run__facts");
    facts.forEach(([term, values]) => {
      const row = element("div", "history-run__fact");
      row.append(element("dt", undefined, term), ...values.map((value) => element("dd", undefined, value)));
      list.append(row);
    });
    block.append(element("h4", "history-run__section-title", title), list);
    details.append(block);
  };

  const changeFacts: [string, string[]][] = [];
  // Legacy records only knew group membership changes; say so rather than imply order was tracked.
  if (!report.tabChanges) changeFacts.push(["Tabs", [`${formatCount(report.tabsMoved ?? report.tabsChanged, "tab")} changed group (order not recorded)`]]);
  const coverage = historyCoverageFacts(report);
  if (coverage.length) changeFacts.push(["Coverage", coverage]);
  section("Changes", changeFacts);

  const stats = report.generation;
  const modelFacts: [string, string[]][] = [["Model", [historyModelLabel(report)]]];
  const tokens = stats ? historyTokenFact(stats) : null;
  if (tokens) modelFacts.push(["Tokens", [tokens]]);
  modelFacts.push(["Time", [historySpeedFact(report)]]);
  if (stats?.repairAttempted) modelFacts.push(["Repair", ["First answer was invalid; one repair request ran"]]);
  section("Model", modelFacts);

  const runFacts: [string, string[]][] = [
    ["Scope", [`${formatCount(report.tabsSubmitted, "tab")} from ${(report.scopeMode ?? "window").replaceAll("_", " ")}`]],
    ["Provider", [report.providerOrigin]],
  ];
  if (report.rollbackStatus !== "not_needed") runFacts.push(["Rollback", [report.rollbackStatus === "complete" ? "Complete" : "Partial"]]);
  // The row already states available, running, and undone; details explain the rest.
  if (undoState === "elsewhere" || undoState === "unavailable" || undoState === "partial") runFacts.push(["Undo", [undoDetail]]);
  section("Run", runFacts);
  body.append(summary, details);

  const aside = element("div", `history-run__undo history-undo history-undo--${undoState}`);
  if (undoRunnableHere) {
    const undo = button("Undo", "secondary", () => {
      void perform("undo", runAvailableUndo);
    }, { actionName: "undo", busyLabel: "Checking…" });
    undo.setAttribute("aria-label", "Undo organization");
    undo.title = "Restores the latest organization only, after checking for conflicts.";
    aside.append(undo);
  } else if (undoState === "running") {
    aside.append(element("span", undefined, "Undoing…"));
  } else if (undoState === "completed") {
    aside.append(element("span", undefined, "Undone"));
  } else if (undoState === "partial") {
    aside.append(element("span", undefined, "Partly undone"));
  }

  item.append(time, body, aside);
  return item;
}

type HistoryTab = "runs" | "filed";
let historyTab: HistoryTab = "runs";

function renderHistoryTabs(filedCount: number): HTMLElement {
  const tabs = element("div", "history-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "History");
  ([
    ["runs", "Organize runs", organizationHistory.length],
    ["filed", "Auto-filed", filedCount],
  ] as const).forEach(([value, label, count]) => {
    const control = element("button", `cleanup-filter__button${historyTab === value ? " cleanup-filter__button--active" : ""}`);
    control.type = "button";
    control.dataset.focusKey = `history-tab-${value}`;
    control.setAttribute("role", "tab");
    control.setAttribute("aria-selected", String(historyTab === value));
    control.append(label, element("span", "history-tabs__count", String(count)));
    control.addEventListener("click", () => {
      historyTab = value;
      render();
    });
    tabs.append(control);
  });
  return tabs;
}

function renderHistory(shell: HTMLElement): void {
  if (!historyOpen) return;
  const panel = element("section", "history-panel");
  const header = element("header", "history-header");
  // Auto-filing gets its own tab once it is on or has filed something; otherwise
  // History is only organize runs and needs no switcher.
  const filedLog = autoFilingView()?.log ?? [];
  const showTabs = Boolean(autoFilingView()?.settings.enabled) || filedLog.length > 0;
  const tab: HistoryTab = showTabs ? historyTab : "runs";
  header.append(element("h2", undefined, tab === "filed" ? "Auto-filing history" : "Organization history"));
  panel.append(header);
  if (showTabs) panel.append(renderHistoryTabs(filedLog.length));

  if (tab === "filed") {
    header.append(element(
      "p",
      "history-summary",
      `${formatCount(filedLog.length, "recent filing")} · this browser session`,
    ));
    const recentlyFiled = renderRecentlyFiled();
    if (recentlyFiled) panel.append(recentlyFiled);
    shell.append(panel);
    return;
  }

  if (organizationHistory.length === 0) {
    panel.append(element("p", "history-empty", "No organization runs yet. Each run you apply is recorded here as counts only."));
    shell.append(panel);
    return;
  }
  const completedRuns = organizationHistory.filter((report) => report.resultStatus === "completed");
  const totalMoved = completedRuns.reduce((sum, report) => sum + historyTabsMoved(report), 0);
  header.append(element(
    "p",
    "history-summary",
    `${formatCount(organizationHistory.length, "run")} · ${formatCount(totalMoved, "tab")} moved`,
  ));
  // What History keeps is a standing fact, so it is said once on hover, not as fine print.
  header.title = "Counts and timings only. Tab titles, URLs, and group names are never stored here.";

  const newestFirst = [...organizationHistory].reverse();
  const days = new Map<string, OrganizationHistoryReport[]>();
  newestFirst.forEach((report) => {
    const label = historyDayLabel(report.timestamp);
    days.set(label, [...(days.get(label) ?? []), report]);
  });
  days.forEach((reports, label) => {
    const day = element("section", "history-day");
    const list = element("ol", "history-list");
    reports.forEach((report) => list.append(renderHistoryRun(report, report === newestFirst[0])));
    day.append(element("h3", "history-day__label", label), list);
    panel.append(day);
  });

  shell.append(panel);
}

export function renderGeneratedGroupCleanupSettings(): HTMLElement {
  const group = element("section", "settings-group generated-group-cleanup");
  group.append(
    element("h3", undefined, "Groups Sheaf created"),
    element(
      "p",
      "settings-group__copy",
      "Remove the groups Sheaf made without closing their tabs. Groups you made yourself are never touched.",
    ),
  );
  const select = element("select", "input");
  select.setAttribute("aria-label", "Automatically ungroup generated tab groups");
  const currentDays = generatedGroupCleanupSummary?.settings.autoUngroupAfterDays ?? null;
  ([
    ["never", "Never automatically"],
    ["1", "After 1 day"],
    ["3", "After 3 days"],
    ["7", "After 7 days"],
    ["14", "After 14 days"],
    ["30", "After 30 days"],
    ["90", "After 90 days"],
  ] as const).forEach(([value, label]) => {
    const option = element("option", undefined, label);
    option.value = value;
    option.selected = value === (currentDays === null ? "never" : String(currentDays));
    select.append(option);
  });
  select.addEventListener("change", () => {
    const autoUngroupAfterDays = select.value === "never"
      ? null
      : Number(select.value) as GeneratedGroupAutoCleanupDays;
    void perform("generated-groups-retention", () => trackSettingsSave(async () => {
      const response = await send({ type: "generated-groups:set-cleanup", autoUngroupAfterDays });
      if (!response.ok) throw new Error(response.error);
      generatedGroupCleanupSummary = response.generatedGroupCleanupSummary ?? null;
    }));
  });
  group.append(field(
    "Ungroup automatically",
    select,
    "Counted from when Sheaf created the group. Protected and shared groups are skipped.",
  ));

  const summary = element("div", "generated-group-cleanup__summary");
  if (generatedGroupCleanupSummary) {
    const live = generatedGroupCleanupSummary.liveGeneratedGroups;
    const blocked = generatedGroupCleanupSummary.blockedGeneratedGroups;
    summary.append(
      element("strong", undefined, `${formatCount(live, "generated group")} currently available`),
      element(
        "span",
        undefined,
        blocked > 0
          ? `${formatCount(blocked, "group")} protected and will be skipped.`
          : "Tabs stay open when their group is removed.",
      ),
    );
    if (generatedGroupCleanupSummary.lastRun) {
      const last = generatedGroupCleanupSummary.lastRun;
      summary.append(element(
        "small",
        undefined,
        `Last ${last.mode} cleanup ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(last.ranAt)} · ${formatCount(last.groupsUngrouped, "group")} removed`,
      ));
    }
  } else {
    summary.append(
      element("strong", undefined, "Cleanup status unavailable"),
      element("span", undefined, "Reload settings to check extension-created groups."),
    );
  }
  group.append(summary);

  const liveCount = generatedGroupCleanupSummary?.liveGeneratedGroups ?? 0;
  if (generatedGroupClearArmed) {
    const confirmation = element("div", "generated-group-cleanup__confirmation");
    confirmation.setAttribute("role", "group");
    confirmation.setAttribute("aria-label", "Confirm generated group cleanup");
    confirmation.append(
      element(
        "span",
        undefined,
        `Ungroup ${formatCount(liveCount, "extension-created group")}? Every tab will stay open. Protected groups will be skipped.`,
      ),
      button("Confirm ungroup", "danger", () => {
        void perform("generated-groups-clear", async () => {
          const response = await send({ type: "generated-groups:clear" });
          if (!response.ok) throw new Error(response.error);
          const result = response.generatedGroupCleanupResult;
          generatedGroupCleanupSummary = response.generatedGroupCleanupSummary ?? null;
          generatedGroupClearArmed = false;
          popupState.notice = result
            ? {
                tone: result.groupsSkipped > 0 ? "info" : "success",
                text: `${formatCount(result.groupsUngrouped, "generated group")} removed. ${formatCount(result.tabsKeptOpen, "tab")} kept open.${result.groupsSkipped > 0 ? ` ${formatCount(result.groupsSkipped, "group")} skipped.` : ""}`,
              }
            : { tone: "success", text: "Generated groups cleared. Tabs stayed open." };
        });
      }, { actionName: "generated-groups-clear", busyLabel: "Ungrouping…" }),
      button("Cancel", "quiet", () => {
        generatedGroupClearArmed = false;
        render();
      }),
    );
    group.append(confirmation);
  } else {
    group.append(button(
      "Clear generated groups now",
      "secondary",
      () => {
        generatedGroupClearArmed = true;
        render();
      },
      { disabled: liveCount === 0, actionName: "generated-groups-arm" },
    ));
  }
  return group;
}

function selectCleanupUtilityView(): void {
  const suggestions = currentCleanupSuggestions();
  showUtilityView("cleanup");
  cleanupReviewDismissed = false;
  cleanupSuggestionFilter = "all";
  selectedCleanupTabIds.clear();
  cleanupCloseArmed = false;
  suggestions.filter(cleanupSelectedByDefault).forEach((suggestion) =>
    selectedCleanupTabIds.add(suggestion.tabId),
  );
}


function openGroupManager(): void {
  resetUtilityScroll = true;
  showUtilityView("groups");
  popupState.pendingFocusKey = "utility-groups";
  void perform("groups-load", async () => {
    // A load failure renders inside the Groups view with its own retry, so it
    // does not also raise a notice above it.
    await refreshGroupManagerState(groupManagerPanelContext).catch(() => undefined);
    if (popupState.searchState.local.settings.semanticEnabled) {
      const response = await send({ type: "semantic-index:get-state" });
      if (response.semanticIndexMeta) popupState.semanticIndexMeta = response.semanticIndexMeta;
    }
  });
}

function renderUtilityDrawer(shell: HTMLElement): void {
  const drawer = element("section", "utility-drawer");
  drawer.id = UTILITY_DRAWER_ID;
  drawer.setAttribute("aria-label", utilityViewLabel(openUtilityView()));
  drawer.append(utilityDrawerContent(currentCleanupSuggestions()));
  shell.append(drawer);
}

function utilityViewLabel(view: UtilityView): string {
  switch (view) {
    case "search": return "Search";
    case "groups": return "Groups";
    case "cleanup": return "Cleanup";
    case "stashes": return "Workspaces";
    case "history": return "History";
    case "protection": return "Protection";
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

// Popup-wide keys: "/" opens Search from anywhere that is not a text field;
// Mod+Enter runs the one primary action the current view marks.
function handlePopupShortcut(event: KeyboardEvent): void {
  if (fullExtensionPage || event.defaultPrevented) return;
  // Escape the controls inside did not claim dismisses the floating window.
  if (floatingPage && event.key === "Escape") {
    event.preventDefault();
    void closeFloatingWindow();
    return;
  }
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !popupState.searchOpen && !isEditableTarget(event.target)) {
    if (busyAction) return;
    event.preventDefault();
    openSearchView();
    return;
  }
  if (event.key === "Enter" && (IS_MAC ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey) {
    const primaryAction = actionRoot.querySelector<HTMLButtonElement>("[data-primary-shortcut]:not(:disabled)");
    if (primaryAction) {
      event.preventDefault();
      primaryAction.click();
      return;
    }
    if (utilityDrawerOpen() && !popupState.searchOpen && organizeFromAnyView()) event.preventDefault();
  }
}

// The inverse of showUtilityView, in the precedence renderUtilityDrawer uses.
function openUtilityView(): UtilityView {
  if (popupState.groupsOpen) return "groups";
  if (popupState.searchOpen) return "search";
  if (cleanupReviewOpen) return "cleanup";
  if (popupState.stashesOpen) return "stashes";
  if (protectionOpen) return "protection";
  return "history";
}

function utilityDrawerContent(suggestions: CleanupSuggestion[]): HTMLElement {
  const view = openUtilityView();
  const content = element(
    "div",
    `utility-drawer__content${view === "cleanup" || view === "search" || view === "groups" ? "" : " utility-drawer__content--scrollable"}`,
  );
  content.dataset.utilityView = view;
  if (view === "groups") {
    renderGroupManager(content, groupManagerPanelContext);
  } else if (view === "search") {
    renderTabSearch(content, tabSearchPanelContext);
  } else if (view === "cleanup") {
    renderResultBar(content);
    if (suggestions.length > 0) {
      renderCleanupSuggestions(content, suggestions);
    } else {
      const empty = element("section", "utility-empty");
      empty.append(
        element("h2", undefined, "Cleanup suggestions"),
        element("p", undefined, "No duplicate, inactive, or likely-clutter tabs meet your current thresholds."),
      );
      content.append(empty);
    }
  } else if (view === "stashes") {
    renderStashes(content);
  } else if (view === "protection") {
    renderProtectionManager(content);
  } else {
    renderHistory(content);
  }
  return content;
}

// Rebuilds only the open drawer's content pane. Interactions that stay inside a
// drawer (a keystroke in the group search, a checkbox in a stash's tab picker)
// cannot change the header, the primary pane, or the nav counts, so they skip
// the whole-page rebuild, whose cost grows with every tab and group on screen.
// Anything that sets a notice or changes shared state still calls render().
function redrawUtilityDrawer(): void {
  const current = actionRoot.querySelector<HTMLElement>(".utility-drawer__content");
  if (renderPassActive || !current || !utilityDrawerOpen() || current.dataset.utilityView !== openUtilityView()) {
    render();
    return;
  }
  renderPassActive = true;
  cleanupSuggestionsThisRender = null;
  try {
    if (activeStashTabTooltip && current.contains(activeStashTabTooltip.owner)) hideStashTabTooltip();
    const focus = captureFocus();
    const scrolls = captureKeyedScroll(current);
    const contentScroll = current.scrollTop;
    const next = utilityDrawerContent(currentCleanupSuggestions());
    current.replaceWith(next);
    next.scrollTop = contentScroll;
    restoreKeyedScroll(next, scrolls);
    restoreFocus(focus);
  } finally {
    renderPassActive = false;
    cleanupSuggestionsThisRender = null;
  }
}

interface FocusSnapshot {
  key: string | null;
  selection: { start: number | null; end: number | null; direction: HTMLInputElement["selectionDirection"] } | null;
}

function captureFocus(): FocusSnapshot {
  const active = document.activeElement;
  return {
    key: active instanceof HTMLElement && actionRoot.contains(active)
      ? active.closest<HTMLElement>("[data-focus-key]")?.dataset.focusKey ?? null
      : null,
    // Checkboxes and other non-text inputs report a null selection and throw on setSelectionRange.
    selection: (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.selectionStart !== null
      ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
      : null,
  };
}

function restoreFocus(snapshot: FocusSnapshot): void {
  const focusKey = popupState.pendingFocusKey ?? snapshot.key;
  popupState.pendingFocusKey = null;
  if (!focusKey) return;
  const focusTarget = actionRoot.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`);
  focusTarget?.focus();
  const { selection } = snapshot;
  if (selection && (focusTarget instanceof HTMLInputElement || focusTarget instanceof HTMLTextAreaElement)) {
    focusTarget.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
  }
}

// Inner scroll containers opt in with data-scroll-key; the key names what the
// container shows, so a position survives a rebuild of the same content but
// not a switch to different content.
function captureKeyedScroll(scope: ParentNode): Map<string, number> {
  const positions = new Map<string, number>();
  scope.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((node) => {
    if (node.scrollTop > 0) positions.set(node.dataset.scrollKey!, node.scrollTop);
  });
  return positions;
}

function restoreKeyedScroll(scope: ParentNode, positions: ReadonlyMap<string, number>): void {
  if (positions.size === 0) return;
  scope.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((node) => {
    const top = positions.get(node.dataset.scrollKey!);
    if (top !== undefined) node.scrollTop = top;
  });
}

function utilityDrawerOpen(): boolean {
  return !fullExtensionPage &&
    (popupState.searchOpen || popupState.groupsOpen || cleanupReviewOpen || historyOpen || popupState.stashesOpen || protectionOpen);
}

export function render(): void {
  renderPassActive = true;
  cleanupSuggestionsThisRender = null;
  try {
    renderPass();
  } finally {
    renderPassActive = false;
    cleanupSuggestionsThisRender = null;
  }
}

function renderPass(): void {
  hideStashTabTooltip();
  clearSearchRedraw();
  if (!popupState.searchOpen && semanticSearchPending()) {
    cancelSemanticSearch();
  }
  if (!popupState.groupsOpen && groupSemanticSearchPending()) {
    cancelGroupSemanticSearch();
  }
  if (!popupState.groupsOpen && groupMemberSemanticSearchPending()) {
    cancelGroupMemberSemanticSearch();
  }
  const previousScrollTop = document.scrollingElement?.scrollTop ?? 0;
  const previousFocus = captureFocus();
  const previousKeyedScroll = captureKeyedScroll(actionRoot);
  const previousPrimaryScroll = actionRoot.querySelector<HTMLElement>(".action-primary")?.scrollTop ?? 0;
  const previousUtilityScroll = actionRoot.querySelector<HTMLElement>(".utility-drawer__content")?.scrollTop ?? 0;
  const previousSidecarScroll = actionRoot.querySelector<HTMLElement>(".cleanup-review--sidecar .cleanup-review__list")?.scrollTop ?? 0;
  const utilityOpen = utilityDrawerOpen();
  document.documentElement.classList.toggle("cleanup-popup-open", utilityOpen);
  document.body.classList.toggle("cleanup-popup-open", utilityOpen);
  const shell = element(
    "div",
    `action-shell${utilityOpen ? " action-shell--utility-open" : ""}`,
  );
  // The popup is one column: command bar and view strip, then exactly one view.
  // Full extension pages keep their own page chrome.
  const primary = fullExtensionPage ? shell : element("div", "action-primary");
  const settingsChrome = fullSettingsPage || setupPage;
  const pageChrome = settingsChrome ? element("div", "settings-page-chrome") : fullExtensionPage ? primary : shell;
  renderHeader(pageChrome);
  renderNotice(pageChrome);
  if (settingsChrome) primary.append(pageChrome);
  if (utilityOpen) {
    renderUtilityDrawer(shell);
  } else if (busyAction === "initial") renderLoading(primary);
  else if (diagnosticsPage) renderDiagnosticsPage(primary);
  else if (setupPage) renderSetup(primary);
  else {
    if (fullExtensionPage) renderSummary(fullSettingsPage ? pageChrome : primary);
    renderSettings(primary);
    if (!fullSettingsPage) {
      if (isSkippingReview()) renderReady(primary);
      else if (popupState.proposalReview) renderReview(primary);
      else if (busyAction === "generate") renderReady(primary);
      else if (popupState.viewState.transactionRun && (
        popupState.viewState.transactionRun.status !== "completed" ||
        visibleResultTransactionId === popupState.viewState.transactionRun.transactionId
      )) renderResult(primary);
      else renderReady(primary);
    }
  }
  if (!fullExtensionPage && !utilityOpen) shell.append(primary);
  actionRoot.replaceChildren(shell);
  schedulePopupReflowCheck();
  restoreFocus(previousFocus);
  if (settingsChrome) {
    const chromeHeight = Math.ceil(pageChrome.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--settings-sticky-top", `${chromeHeight + 16}px`);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  } else {
    document.documentElement.style.removeProperty("--settings-sticky-top");
  }
  const nextPrimary = actionRoot.querySelector<HTMLElement>(".action-primary");
  const nextUtility = actionRoot.querySelector<HTMLElement>(".utility-drawer__content");
  const nextSidecarList = actionRoot.querySelector<HTMLElement>(".cleanup-review--sidecar .cleanup-review__list");
  if (nextPrimary) nextPrimary.scrollTop = previousPrimaryScroll;
  if (nextUtility) nextUtility.scrollTop = resetUtilityScroll ? 0 : previousUtilityScroll;
  resetUtilityScroll = false;
  if (nextSidecarList) nextSidecarList.scrollTop = previousSidecarScroll;
  restoreKeyedScroll(actionRoot, previousKeyedScroll);
  const scrollingElement = document.scrollingElement;
  if (!scrollingElement) return;
  const anchor = renderScrollAnchor;
  const replacement = anchor
    ? [...actionRoot.querySelectorAll<HTMLElement>("[data-action-name]")].find(
        (node) => node.dataset.actionName === anchor.actionName,
      )
    : null;
  if (anchor && replacement) {
    const localScroller = replacement.closest<HTMLElement>(
      ".cleanup-review__list, .action-primary",
    );
    const delta = replacement.getBoundingClientRect().top - anchor.viewportTop;
    if (localScroller) localScroller.scrollTop += delta;
    else scrollingElement.scrollTop += delta;
    if (anchor.restoreFocus) {
      queueMicrotask(() => replacement.focus({ preventScroll: true }));
    }
  } else {
    scrollingElement.scrollTop = previousScrollTop;
  }
}

function schedulePopupReflowCheck(): void {
  if (fullExtensionPage || popupReflowMode || popupReflowCheckTimer !== null) return;
  popupReflowCheckTimer = setTimeout(() => {
    popupReflowCheckTimer = null;
    const root = document.documentElement;
    if (root.scrollWidth <= root.clientWidth + 1) return;
    popupReflowMode = true;
    root.classList.add("action-popup-reflow");
    document.body.classList.add("action-popup-reflow");
  }, 100);
}

// One listener, five concerns: the storage event carries every area's change, so
// registering a listener per concern only multiplied the callbacks Chrome had to
// run for one write.
chrome.storage.onChanged.addListener((changes, areaName) => {
  handleViewStateStorageChange(changes, areaName);
  handleSettingsStorageChange(changes, areaName);
  handleUsageStorageChange(changes, areaName);
  handleAutoFilingStorageChange(changes, areaName);
  handleProviderJobStorageChange(changes, areaName);
});

// The worker writes the editor, lease, run, and undo point to session storage;
// following those writes replaces the whole-window state the heartbeat used to return.
function handleViewStateStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  if (areaName !== "session") return;
  const next = applyViewStateStorageChanges(popupState.viewState, changes);
  if (next) popupState.viewState = next;
}

function handleSettingsStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  const relevantLocal = areaName === "local" && Boolean(changes.organizerLocalState || changes.searchLocalState);
  const relevantSession = areaName === "session" && Boolean(
    changes.searchEmbeddingApiKey || changes.searchEmbeddingCustomHeaders,
  );
  if (!relevantLocal && !relevantSession) return;
  cancelSemanticSearch();
  // A settings change is exactly the remedy a permanent failure asks for, so the
  // gate opens here rather than waiting out a timer.
  clearSearchFailureGate();
  if (storageChangeRefreshTimer) clearTimeout(storageChangeRefreshTimer);
  storageChangeRefreshTimer = setTimeout(() => {
    storageChangeRefreshTimer = null;
    void Promise.all([readSearchState(), readOrganizerState()]).then(async ([nextSearch, nextOrganizerData]) => {
      popupState.searchState = nextSearch;
      popupState.organizerData = nextOrganizerData;
      if (popupState.searchState.local.settings.semanticEnabled) {
        const response = await send({ type: "semantic-index:get-state" });
        if (response.semanticIndexMeta) popupState.semanticIndexMeta = response.semanticIndexMeta;
      }
      if (popupState.searchOpen) {
        setSearchAutofocusPending(true);
        render();
      } else {
        refreshSemanticIndexStatus();
      }
    }).catch(() => undefined);
  }, 50);
}

// Filing happens in the background; the Organize prompt and History → Auto-filed follow it.
// The settings page isn't redrawn under the user's typing.
function handleAutoFilingStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  if (!autoFilingStorageChanged(changes, areaName)) return;
  void loadAutoFilingView().then(() => {
    if (fullSettingsPage || setupPage || busyAction !== null) return;
    if (historyOpen || !utilityDrawerOpen()) render();
  }).catch(() => undefined);
}

// A run started from another open extension page still shows here as running.
function handleProviderJobStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  if (areaName !== "session" || !changes.organizerProviderJob || fullSettingsPage || setupPage || busyAction !== null) return;
  const job = changes.organizerProviderJob.newValue as ProviderJobResult | undefined;
  if (job?.status !== "requesting" || job.ownerContextId !== BACKGROUND_JOB_OWNER) return;
  void perform("generate", followBackgroundOrganize);
}

render();
document.addEventListener("keydown", handlePopupShortcut);
for (const type of ["pointerdown", "keydown"] as const) {
  document.addEventListener(type, () => {
    lastUserInteractionAt = performance.now();
  }, { capture: true });
}
window.addEventListener("pagehide", () => {
  stopHeartbeat();
  stopSemanticIndexPolling();
  cancelSemanticSearch();
  clearSearchFailureGate();
  if (popupReflowCheckTimer) clearTimeout(popupReflowCheckTimer);
  if (storageChangeRefreshTimer) clearTimeout(storageChangeRefreshTimer);
}, { once: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !heartbeatTimer && popupState.targetWindowId !== null) {
    void recoverHeartbeat();
  }
});
// Shows the keys the browser actually bound, not the manifest's suggestions:
// a suggested key that conflicts with another extension is silently dropped.
export function renderShortcutSettings(): HTMLElement {
  const group = element("section", "settings-group shortcut-settings");
  group.append(
    element("h3", undefined, "Keyboard shortcuts"),
    element("p", "settings-group__copy", "These work from any tab while the browser is focused."),
  );
  const list = element("dl", "shortcut-list");
  browserShortcuts.forEach(({ description, shortcut }) => {
    const row = element("div", "shortcut-list__row");
    const keys = element("dd");
    keys.append(shortcut ? keycap(...shortcutKeys(shortcut)) : element("span", "shortcut-list__unset", "Not set"));
    if (shortcut) keys.setAttribute("aria-label", shortcut);
    row.append(element("dt", undefined, description), keys);
    list.append(row);
  });
  const change = button("Change shortcuts", "secondary", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  group.append(list, change);
  return group;
}

// The service worker closes the floating window when focus leaves it; this
// covers Escape.
async function closeFloatingWindow(): Promise<void> {
  const current = await chrome.windows.getCurrent();
  if (current.id !== undefined) await chrome.windows.remove(current.id);
}

void (async () => {
  try {
    await initializeTarget();
    await loadBrowserShortcuts().catch(() => undefined);
    await loadAutoFilingView().catch(() => null);
    const loadedState = await loadStoredWorkflow();
    if (popupState.searchState.local.settings.semanticEnabled) {
      const response = await send({ type: popupState.semanticIndexMeta.status === "building" ? "semantic-index:resume" : "semantic-index:get-state" });
      if (response.semanticIndexMeta) popupState.semanticIndexMeta = response.semanticIndexMeta;
      if (popupState.semanticIndexMeta.status === "building") startSemanticIndexPolling();
    }
    if (popupState.searchOpen) await refreshSearchSnapshots(tabSearchPanelContext);
    if (!fullExtensionPage && !floatingPage) openPreferredCleanupReview(0);
    if (backgroundJobInFlight()) {
      busyAction = null;
      await perform("generate", followBackgroundOrganize);
      return;
    }
    // An unread failure from the last run is shown instead of starting another.
    const shouldOrganizeOnOpen =
      !fullExtensionPage &&
      !hasErrorNotice() &&
      !floatingPage &&
      loadedState.local.workflow.organizeOnExtensionClick &&
      !popupState.proposalReview &&
      !popupState.viewState.transactionRun?.status?.match(/^(applying|verifying|rolling_back)$/);
    if (shouldOrganizeOnOpen) {
      busyAction = null;
      await perform("generate", generateProposal);
      return;
    }
  } catch (error) {
    popupState.notice = {
      tone: "error",
      text: error instanceof Error ? error.message : "The current window could not be loaded.",
    };
  } finally {
    busyAction = null;
    render();
  }
})();
