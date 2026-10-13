import {
  aggregateGroupSemanticScores,
  rankGroupSearch,
} from "../../browser/group-manager";
import { searchableLocation, type TabSearchScope } from "../../search/direct-search";
import { semanticMappingKey } from "../../search/semantic-indexer";
import { type SemanticDocumentSource } from "../../search/semantic-document";
import { querySemanticTabs, type SemanticQueryResult } from "../../search/semantic-query";
import { prepareSemanticTabQuery } from "./semantic-tab-query";
import { renderGroupFilingOptOut } from "./auto-filing-ui";
import { readTabStashes } from "../../storage/stashes";
import { listConflicts } from "../shared/helpers";
import { CHROME_GROUP_COLORS } from "../../shared/group-colors";
import {
  DEFAULT_GROUP_MANAGER_OWNERSHIP_FILTER,
  type GroupManagerEditDraft,
  type GroupManagerEditPreview,
  type GroupManagerGroup,
  type GroupManagerOwnershipFilter,
  type GroupManagerRemovalMode,
  type GroupManagerRemovalPreview,
  type GroupManagerScope,
  type GroupManagerState,
  type GroupSemanticScore,
} from "../../shared/group-manager-types";
import type {
  SavedTabStash,
  StashRestoreOptions,
} from "../../shared/stash-types";
import type {
  WindowCaptureMessage,
} from "../../shared/types";
import type { WindowCaptureResponseFor } from "../../shared/message-state";
import type {
  SemanticSearchStatus,
} from "../../shared/search-types";
import { SEMANTIC_SEARCH_DEBOUNCE_MS } from "../../shared/constants";
import type { GroupManagerActionIcon } from "./main";
import { popupState } from "./popup-store";

// DOM and action helpers owned by main.ts, injected so this drawer stays a
// leaf module without importing the main entry. Shared state is in popup-store.
export interface GroupManagerPanelContext {
  element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K];
  input(value: string, type?: HTMLInputElement["type"]): HTMLInputElement;
  field(label: string, control: HTMLElement, help?: string): HTMLElement;
  button(
    label: string,
    variant: "primary" | "secondary" | "quiet" | "danger",
    onClick: () => void,
    options?: { disabled?: boolean; actionName?: string; busyLabel?: string },
  ): HTMLButtonElement;
  formatCount(count: number, singular: string, plural?: string): string;
  lineIcon(paths: readonly string[]): SVGSVGElement;
  utilityNavIcon(icon: "stashes"): SVGSVGElement;
  groupManagerIconButton(
    label: string,
    icon: GroupManagerActionIcon,
    onClick: () => void,
    options?: { disabled?: boolean; actionName?: string; busyLabel?: string },
  ): HTMLButtonElement;
  stashStatusLabel(stash: SavedTabStash): string;
  restoreStash(
    stash: SavedTabStash,
    sourceIndexes?: number[],
    options?: StashRestoreOptions,
  ): Promise<void>;
  send<Message extends WindowCaptureMessage>(message: Message): Promise<WindowCaptureResponseFor<Message>>;
  perform(actionName: string, action: () => Promise<void>): Promise<void>;
  /** Rebuilds only this drawer; every state change here is drawer-local. */
  redraw(): void;
  actionRoot(): HTMLElement;
  semanticSearchAvailability(scope: TabSearchScope): string | null;
  groupHasUserProtection(group: GroupManagerGroup): boolean;
  openProtectionManager(): void;
  protectGroupFromManager(group: GroupManagerGroup): Promise<void>;
}

let panelContext: GroupManagerPanelContext | null = null;

function ui(): GroupManagerPanelContext {
  if (!panelContext) throw new Error("The group manager panel context is unavailable.");
  return panelContext;
}

let groupManagerState: GroupManagerState | null = null;

function loadedGroupManagerState(): GroupManagerState {
  if (!groupManagerState) throw new Error("The group manager state is not loaded.");
  return groupManagerState;
}
let groupManagerStatus: "idle" | "loading" | "ready" | "error" = "idle";
let groupManagerLoadError: string | null = null;
let groupManagerListStale = false;
let groupManagerScope: GroupManagerScope = "current_window";
let groupManagerOwnershipFilter: GroupManagerOwnershipFilter = DEFAULT_GROUP_MANAGER_OWNERSHIP_FILTER;
let groupManagerQuery = "";
let selectedGroupId: number | null = null;
interface GroupManagerStashedGroup {
  id: string;
  stash: SavedTabStash;
  key: string;
  title: string;
  color: chrome.tabGroups.TabGroup["color"];
  collapsed: boolean;
  tabs: SavedTabStash["tabs"];
}
let selectedStashedGroupId: string | null = null;
const selectedGroupIds = new Set<number>();
const selectedStashedGroupIds = new Set<string>();
let groupManagerCompactEditor = false;
let groupEditDraft: GroupManagerEditDraft | null = null;

// For callbacks attached while a draft is open. They read the live draft, as the
// module variable does, but fail with a clear message instead of a TypeError.
function editDraft(): GroupManagerEditDraft {
  if (!groupEditDraft) throw new Error("The group editor has no draft open.");
  return groupEditDraft;
}
const groupEditDrafts = new Map<number, GroupManagerEditDraft>();
let groupEditPreview: GroupManagerEditPreview | null = null;
let groupRemovalPreview: GroupManagerRemovalPreview | null = null;
let groupRemovalTarget: "selected" | "inactive" | "managed" = "selected";
let groupRemovalIncludeActive = false;
let groupMemberPickerOpen = false;
let groupMemberQuery = "";
let groupSemanticScores: GroupSemanticScore[] = [];
let groupSemanticStatus: SemanticSearchStatus = "idle";
let groupSemanticController: AbortController | null = null;
let groupSemanticTimer: ReturnType<typeof setTimeout> | null = null;
let groupSemanticGeneration = 0;
let groupMemberSemanticResults: SemanticQueryResult[] = [];
let groupMemberSemanticStatus: SemanticSearchStatus = "idle";
let groupMemberSemanticController: AbortController | null = null;
let groupMemberSemanticTimer: ReturnType<typeof setTimeout> | null = null;
let groupMemberSemanticGeneration = 0;

export function cancelGroupSemanticSearch(): void {
  groupSemanticGeneration += 1;
  if (groupSemanticTimer) clearTimeout(groupSemanticTimer);
  groupSemanticTimer = null;
  groupSemanticController?.abort();
  groupSemanticController = null;
  groupSemanticScores = [];
  groupSemanticStatus = "idle";
}

export function cancelGroupMemberSemanticSearch(): void {
  groupMemberSemanticGeneration += 1;
  if (groupMemberSemanticTimer) clearTimeout(groupMemberSemanticTimer);
  groupMemberSemanticTimer = null;
  groupMemberSemanticController?.abort();
  groupMemberSemanticController = null;
  groupMemberSemanticResults = [];
  groupMemberSemanticStatus = "idle";
}

function groupManagerGroup(groupId: number | null): GroupManagerGroup | null {
  return groupId === null
    ? null
    : groupManagerState?.groups.find((group) => group.id === groupId) ?? null;
}

function stashedGroupsFrom(stashes: SavedTabStash[]): GroupManagerStashedGroup[] {
  return stashes.flatMap((stash) => stash.groups.flatMap((group) => {
    const tabs = stash.tabs.filter((tab) => tab.groupKey === group.key);
    if (tabs.length === 0) return [];
    return [{
      id: `${stash.id}:${group.key}`,
      stash,
      key: group.key,
      title: group.title.trim() || "Untitled group",
      color: group.color,
      collapsed: group.collapsed,
      tabs,
    }];
  })).sort((left, right) =>
    right.stash.updatedAt - left.stash.updatedAt ||
    left.stash.name.localeCompare(right.stash.name) ||
    left.title.localeCompare(right.title),
  );
}

function groupManagerStashedGroups(): GroupManagerStashedGroup[] {
  return stashedGroupsFrom(popupState.savedStashes);
}

function visibleStashedGroups(): GroupManagerStashedGroup[] {
  const query = groupManagerQuery.normalize("NFKC").trim().toLocaleLowerCase();
  return groupManagerStashedGroups().filter((group) => {
    if (!query) return true;
    return [group.title, group.stash.name, ...group.tabs.flatMap((tab) => {
      const location = searchableLocation(tab.url);
      return [tab.title, location.hostname, location.path];
    })].some((value) => value.normalize("NFKC").toLocaleLowerCase().includes(query));
  });
}

function resetGroupEditDraft(group: GroupManagerGroup | null): void {
  groupEditPreview = null;
  groupMemberPickerOpen = false;
  groupMemberQuery = "";
  cancelGroupMemberSemanticSearch();
  const staged = group ? groupEditDrafts.get(group.id) : null;
  groupEditDraft = group
    ? structuredClone(staged ?? {
        groupId: group.id,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        tabIds: [...group.tabIds],
      })
    : null;
}

function rememberGroupEditDraft(): void {
  if (groupEditDraft) groupEditDrafts.set(groupEditDraft.groupId, structuredClone(groupEditDraft));
}

function discardGroupEditDraft(group: GroupManagerGroup): void {
  groupEditDrafts.delete(group.id);
  resetGroupEditDraft(group);
}

function groupEditHasChanges(group: GroupManagerGroup, draft: GroupManagerEditDraft): boolean {
  return group.title !== draft.title || group.color !== draft.color ||
    group.collapsed !== draft.collapsed ||
    JSON.stringify(group.tabIds) !== JSON.stringify(draft.tabIds);
}

function patchGroupEditActionState(group: GroupManagerGroup, draft: GroupManagerEditDraft): void {
  const dirty = groupEditHasChanges(group, draft);
  const status = ui().actionRoot().querySelector<HTMLElement>(".group-manager__edit-status");
  const discard = ui().actionRoot().querySelector<HTMLButtonElement>(".group-manager__discard");
  const review = ui().actionRoot().querySelector<HTMLButtonElement>(".group-manager__review");
  const titleCount = ui().actionRoot().querySelector<HTMLElement>(".group-manager__title-field .field__help");
  if (status) status.textContent = dirty ? "Unsaved" : "";
  if (discard) discard.disabled = !dirty;
  if (review) review.disabled = !dirty;
  if (titleCount) titleCount.textContent = `${draft.title.length}/24`;
}

function selectManagedGroup(groupId: number): void {
  selectedGroupId = groupId;
  selectedStashedGroupId = null;
  groupManagerCompactEditor = true;
  resetGroupEditDraft(groupManagerGroup(groupId));
}

function selectStashedGroup(groupId: string): void {
  selectedStashedGroupId = groupId;
  selectedGroupId = null;
  groupManagerCompactEditor = true;
  resetGroupEditDraft(null);
}

/** A refresh after a change that already succeeded must not replace its success notice. */
async function refreshAfterChange(): Promise<void> {
  try {
    await refreshGroupManagerState(ui());
  } catch {
    // groupManagerListStale is set; the view says so and offers a refresh.
  }
}

export async function refreshGroupManagerState(context: GroupManagerPanelContext): Promise<void> {
  panelContext = context;
  groupManagerStatus = "loading";
  let response: Awaited<ReturnType<GroupManagerPanelContext["send"]>>;
  let stashes: Awaited<ReturnType<typeof readTabStashes>>;
  try {
    [response, stashes] = await Promise.all([
      ui().send({ type: "group-manager:get-state", currentWindowId: popupState.targetWindowId }),
      readTabStashes(),
    ]);
    if (!response.ok) throw new Error(response.error);
    if (!response.groupManagerState) throw new Error("The group manager state was unavailable.");
  } catch (error) {
    // Never leave the skeleton up: with nothing loaded the view shows the error
    // and a retry; with an older list it keeps that list and says it may be stale.
    groupManagerLoadError = error instanceof Error ? error.message : "Groups could not be loaded.";
    groupManagerStatus = groupManagerState ? "ready" : "error";
    groupManagerListStale = Boolean(groupManagerState);
    throw error;
  }
  groupManagerLoadError = null;
  groupManagerListStale = false;
  popupState.savedStashes = stashes;
  groupManagerState = response.groupManagerState;
  groupManagerStatus = "ready";
  const available = new Set(groupManagerState.groups.map((group) => group.id));
  [...groupEditDrafts.keys()].forEach((id) => { if (!available.has(id)) groupEditDrafts.delete(id); });
  [...selectedGroupIds].forEach((id) => { if (!available.has(id)) selectedGroupIds.delete(id); });
  if (selectedGroupId !== null && !available.has(selectedGroupId)) selectedGroupId = null;
  const availableStashed = new Set(groupManagerStashedGroups().map((group) => group.id));
  [...selectedStashedGroupIds].forEach((id) => { if (!availableStashed.has(id)) selectedStashedGroupIds.delete(id); });
  if (selectedStashedGroupId !== null && !availableStashed.has(selectedStashedGroupId)) selectedStashedGroupId = null;
  if (selectedGroupId === null && selectedStashedGroupId === null) {
    const first = visibleManagedGroups()[0];
    if (first) selectedGroupId = first.id;
    else selectedStashedGroupId = visibleStashedGroups()[0]?.id ?? null;
  }
  resetGroupEditDraft(groupManagerGroup(selectedGroupId));
}

function scopedManagedGroups(): GroupManagerGroup[] {
  if (!groupManagerState) return [];
  return groupManagerState.groups.filter((group) =>
    (groupManagerScope === "all_windows" || group.windowId === popupState.targetWindowId) &&
    (groupManagerOwnershipFilter === "all" || group.managed),
  );
}

function visibleManagedGroups(): GroupManagerGroup[] {
  if (!groupManagerState) return [];
  const groups = scopedManagedGroups();
  const allowed = new Set(groups.map((group) => group.id));
  const ranked = rankGroupSearch({
    ...groupManagerState,
    groups,
    tabs: groupManagerState.tabs.filter((tab) => allowed.has(tab.groupId)),
  }, groupManagerQuery, groupSemanticScores);
  const byId = new Map(groups.map((group) => [group.id, group]));
  return ranked.flatMap((id) => byId.get(id) ?? []);
}

async function queryGroupManagerMeaning(
  query: string,
  scope: GroupManagerScope,
  allowedTabIds: ReadonlySet<number>,
  signal: AbortSignal,
): Promise<SemanticQueryResult[]> {
  if (!groupManagerState || !popupState.organizerData) return [];
  const groupTitles = new Map(groupManagerState.groups.map((group) => [group.id, group.title.trim() || null]));
  const sources: SemanticDocumentSource[] = groupManagerState.tabs.flatMap((tab) =>
    allowedTabIds.has(tab.id) && (scope === "all_windows" || tab.windowId === popupState.targetWindowId)
      ? [{
          mappingKey: semanticMappingKey(tab),
          target: { kind: "open" as const, tabId: tab.id, windowId: tab.windowId },
          title: tab.title,
          url: tab.url,
          groupName: tab.groupId === -1 ? null : groupTitles.get(tab.groupId) ?? null,
        }]
      : [],
  );
  const prepared = await prepareSemanticTabQuery({ sources, meta: popupState.semanticIndexMeta });
  return (await querySemanticTabs({
    query,
    candidates: prepared.candidates,
    meta: popupState.semanticIndexMeta,
    config: prepared.config,
    apiKey: prepared.apiKey,
    expectedDimensions: prepared.providerTest.dimensions,
    signal,
    dependencies: { embedQuery: prepared.client.embedQuery.bind(prepared.client) },
  })).results;
}

function scheduleGroupSemanticSearch(force: boolean): void {
  cancelGroupSemanticSearch();
  const query = groupManagerQuery.trim();
  if (query.length < 2 || !groupManagerState) return;
  const availability = ui().semanticSearchAvailability(groupManagerScope);
  if (availability) {
    groupSemanticStatus = "unavailable";
    ui().redraw();
    return;
  }
  const direct = rankGroupSearch({ ...groupManagerState, groups: scopedManagedGroups() }, query);
  const strong = scopedManagedGroups().some((group) =>
    group.title.trim().toLocaleLowerCase().startsWith(query.toLocaleLowerCase()),
  );
  if (!force && !popupState.searchState.local.settings.semanticAlways &&
    (!popupState.searchState.local.settings.semanticWhenDirectWeak || (strong && direct.length > 0))) return;
  const generation = ++groupSemanticGeneration;
  groupSemanticStatus = "debouncing";
  groupSemanticTimer = setTimeout(() => {
    const controller = new AbortController();
    groupSemanticController = controller;
    groupSemanticStatus = "loading";
    ui().redraw();
    const allowedGroups = new Set(scopedManagedGroups().map((group) => group.id));
    const allowedTabs = new Set(loadedGroupManagerState().tabs.filter((tab) => allowedGroups.has(tab.groupId)).map((tab) => tab.id));
    void queryGroupManagerMeaning(query, groupManagerScope, allowedTabs, controller.signal).then((results) => {
      if (generation !== groupSemanticGeneration || query !== groupManagerQuery.trim()) return;
      groupSemanticScores = aggregateGroupSemanticScores(results.flatMap((result) =>
        result.target.kind === "open" ? [{ tabId: result.target.tabId, score: result.score }] : [],
      ), loadedGroupManagerState().tabs);
      groupSemanticStatus = groupSemanticScores.length > 0 ? "ready" : "empty";
      ui().redraw();
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      groupSemanticStatus = "unavailable";
      ui().redraw();
    });
  }, force ? 0 : SEMANTIC_SEARCH_DEBOUNCE_MS);
  ui().redraw();
}

function scheduleGroupMemberSemanticSearch(force: boolean): void {
  cancelGroupMemberSemanticSearch();
  const query = groupMemberQuery.trim();
  const group = groupManagerGroup(selectedGroupId);
  if (query.length < 2 || !groupManagerState || !group) return;
  const availability = ui().semanticSearchAvailability(group.windowId === popupState.targetWindowId ? "current_window" : "all_windows");
  if (availability) {
    groupMemberSemanticStatus = "unavailable";
    ui().redraw();
    return;
  }
  const candidates = groupManagerState.tabs.filter((tab) =>
    tab.windowId === group.windowId && !groupEditDraft?.tabIds.includes(tab.id));
  const direct = candidates.filter((tab) =>
    `${tab.title} ${tab.hostname}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (!force && !popupState.searchState.local.settings.semanticAlways &&
    (!popupState.searchState.local.settings.semanticWhenDirectWeak || direct.length >= 3)) return;
  const generation = ++groupMemberSemanticGeneration;
  groupMemberSemanticStatus = "debouncing";
  groupMemberSemanticTimer = setTimeout(() => {
    const controller = new AbortController();
    groupMemberSemanticController = controller;
    groupMemberSemanticStatus = "loading";
    ui().redraw();
    const allowed = new Set(candidates.map((tab) => tab.id));
    void queryGroupManagerMeaning(query, group.windowId === popupState.targetWindowId ? "current_window" : "all_windows", allowed, controller.signal).then((results) => {
      if (generation !== groupMemberSemanticGeneration || query !== groupMemberQuery.trim()) return;
      groupMemberSemanticResults = results;
      groupMemberSemanticStatus = results.length > 0 ? "ready" : "empty";
      ui().redraw();
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      groupMemberSemanticStatus = "unavailable";
      ui().redraw();
    });
  }, force ? 0 : SEMANTIC_SEARCH_DEBOUNCE_MS);
  ui().redraw();
}

const GROUP_BADGE_LABELS: Record<GroupManagerGroup["badges"][number], string> = {
  created: "Created here",
  managed: "Managed",
  stashed: "Saved",
  stash_changed: "Workspace changed",
  linked: "Linked",
  protected: "Protected",
  partly_protected: "Partly protected",
  active: "Active",
};

function appendGroupBadges(container: HTMLElement, group: GroupManagerGroup): void {
  const paths: Record<GroupManagerGroup["badges"][number], string[]> = {
    created: ["m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z"],
    managed: ["M7 4h10v16l-5-3-5 3Z"],
    stashed: ["M4 8h16v11H4Z", "M3 5h18v3H3Z"],
    stash_changed: ["M4 8h16v11H4Z", "M3 5h18v3H3Z", "M12 11v3", "M12 17h.01"],
    linked: ["m10 13 4-4", "M8 16H6a4 4 0 0 1 0-8h3", "M16 8h2a4 4 0 1 1 0 8h-3"],
    protected: ["M12 3 5 5v4c0 3.6-2 6.2-5 8-3-1.8-5-4.4-5-8V8Z", "m9.5 12 1.5 1.5 3.5-4"],
    partly_protected: ["M12 3 5 5v4c0 3.6-2 6.2-5 8-3-1.8-5-4.4-5-8V8Z", "M12 7v10"],
    active: ["M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "M12 8v4l3 2"],
  };
  const visibleBadges = group.badges.filter((badge) =>
    badge === "active" || badge === "protected" || badge === "partly_protected" || badge === "stash_changed",
  );
  const allLabels = group.badges.map((badge) => GROUP_BADGE_LABELS[badge]);
  if (allLabels.length > 0) {
    // role="group" so the generic container actually exposes the accessible name.
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", allLabels.join(", "));
  }
  visibleBadges.forEach((badge) => {
    const label = GROUP_BADGE_LABELS[badge];
    const node = ui().element("span", `group-manager__badge group-manager__badge--${badge}`);
    node.title = label;
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", label);
    node.append(ui().lineIcon(paths[badge]));
    container.append(node);
  });
}

function groupRemovalTargetIds(): number[] {
  const groups = scopedManagedGroups();
  if (groupRemovalTarget === "inactive") return groups.filter((group) => !group.active).map((group) => group.id);
  if (groupRemovalTarget === "managed") return groups.filter((group) => group.managed).map((group) => group.id);
  return groups.filter((group) => selectedGroupIds.has(group.id)).map((group) => group.id);
}

function selectedGroupScopeCounts(): { actionable: number; outsideFilters: number } {
  const scoped = new Set(scopedManagedGroups().map((group) => group.id));
  const actionable = [...selectedGroupIds].filter((id) => scoped.has(id)).length;
  return { actionable, outsideFilters: selectedGroupIds.size - actionable };
}

async function openSelectedStashedGroups(): Promise<void> {
  const selected = groupManagerStashedGroups().filter((group) =>
    selectedStashedGroupIds.has(group.id) && group.stash.status !== "closing_interrupted",
  );
  if (selected.length === 0) throw new Error("Select at least one available saved group to open.");
  const byStash = new Map<string, { stash: SavedTabStash; sourceIndexes: Set<number> }>();
  selected.forEach((group) => {
    const entry = byStash.get(group.stash.id) ?? { stash: group.stash, sourceIndexes: new Set<number>() };
    group.tabs.forEach((tab) => entry.sourceIndexes.add(tab.sourceIndex));
    byStash.set(group.stash.id, entry);
  });
  for (const { stash, sourceIndexes } of byStash.values()) {
    await ui().restoreStash(stash, [...sourceIndexes].sort((left, right) => left - right), {
      destination: "current_window",
      duplicateHandling: "reuse",
      afterRestore: "keep",
    });
  }
  selectedStashedGroupIds.clear();
  popupState.notice = {
    tone: "success",
    text: `${selected.length} saved group${selected.length === 1 ? "" : "s"} opened in this window. The saved ${selected.length === 1 ? "copy is" : "copies are"} unchanged.`,
  };
  await refreshAfterChange();
}

async function previewGroupRemovalAction(mode: GroupManagerRemovalMode): Promise<void> {
  const groupIds = groupRemovalTargetIds();
  if (groupIds.length === 0) throw new Error("Select at least one group for this action.");
  const response = await ui().send({
    type: "group-manager:preview-remove",
    groupIds,
    mode,
    includeActive: groupRemovalIncludeActive,
  });
  if (!response.ok) throw new Error(response.error);
  if (!response.groupManagerRemovalPreview) throw new Error("The group action preview was unavailable.");
  groupRemovalPreview = {
    ...response.groupManagerRemovalPreview,
    provenance: response.groupManagerRemovalPreview.provenance?.length
      ? response.groupManagerRemovalPreview.provenance
      : groupIds.flatMap((groupId) => {
          const group = groupManagerGroup(groupId);
          return group?.ownership ? [{ groupId, origin: group.ownership, managed: group.managed }] : [];
        }),
  };
}

async function applyGroupRemovalAction(): Promise<void> {
  if (!groupRemovalPreview) throw new Error("Review the group action first.");
  const response = await ui().send({ type: "group-manager:apply-remove", preview: groupRemovalPreview });
  if (!response.ok) throw new Error(response.error);
  if (!response.groupManagerApplyResult) throw new Error("The group action result was unavailable.");
  const result = response.groupManagerApplyResult;
  popupState.notice = {
    tone: result.conflicts.length > 0 ? "info" : "success",
    text: `${result.recoveryStashId
      ? `${result.tabsChanged} tab${result.tabsChanged === 1 ? "" : "s"} closed after a recovery workspace was saved.${result.skippedGroups ? ` ${result.skippedGroups} group${result.skippedGroups === 1 ? " was" : "s were"} kept.` : ""}`
      : `${result.groupsChanged} group${result.groupsChanged === 1 ? "" : "s"} ungrouped; ${result.tabsChanged} tab${result.tabsChanged === 1 ? " remains" : "s remain"} open.`}${
      result.conflicts.length ? ` ${listConflicts(result.conflicts)}` : ""
    }`,
  };
  groupRemovalPreview = null;
  selectedGroupIds.clear();
  await refreshAfterChange();
}

async function previewGroupEditAction(): Promise<void> {
  if (!groupEditDraft) throw new Error("Select a group to edit.");
  const response = await ui().send({ type: "group-manager:preview-edit", draft: groupEditDraft });
  if (!response.ok) throw new Error(response.error);
  if (!response.groupManagerEditPreview) throw new Error("The group edit preview was unavailable.");
  const group = groupManagerGroup(response.groupManagerEditPreview.draft.groupId);
  groupEditPreview = {
    ...response.groupManagerEditPreview,
    ...(!response.groupManagerEditPreview.provenance && group?.ownership
      ? { provenance: { origin: group.ownership, managed: group.managed } }
      : {}),
  };
}

async function applyGroupEditAction(): Promise<void> {
  if (!groupEditPreview) throw new Error("Review the group edit first.");
  const response = await ui().send({ type: "group-manager:apply-edit", preview: groupEditPreview });
  if (!response.ok) throw new Error(response.error);
  if (!response.groupManagerApplyResult) throw new Error("The group edit result was unavailable.");
  groupEditDrafts.delete(groupEditPreview.draft.groupId);
  popupState.notice = { tone: "success", text: "Group changes applied and verified. Undo is available in Groups." };
  await refreshAfterChange();
}

function renderStashedGroupEditor(editor: HTMLElement, stashed: GroupManagerStashedGroup): void {
  const editorBody = ui().element("div", "group-manager__editor-body");
  editorBody.dataset.scrollKey = `group-editor-stashed-${stashed.id}`;
  const editorHeading = ui().element("div", "group-manager__editor-heading");
  const back = ui().groupManagerIconButton("Back to groups", "back", () => { groupManagerCompactEditor = false; ui().redraw(); });
  back.classList.add("group-manager__back");
  const title = ui().element("div");
  title.append(
    ui().element("strong", undefined, stashed.title),
    ui().element("span", undefined, `${ui().formatCount(stashed.tabs.length, "tab")} · ${stashed.stash.name}`),
  );
  const saved = ui().element("span", "group-manager__stash-label", "Saved");
  editorHeading.append(back, title, saved);
  editorBody.append(editorHeading);

  const summary = ui().element("div", "group-manager__stash-summary");
  summary.append(
    ui().element("strong", undefined, "Saved group"),
    ui().element(
      "span",
      undefined,
      `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(stashed.stash.updatedAt)} · ${ui().stashStatusLabel(stashed.stash)}`,
    ),
  );
  editorBody.append(summary);

  const members = ui().element("section", "group-manager__members");
  const membersHeading = ui().element("div", "group-manager__members-heading");
  membersHeading.append(ui().element("strong", undefined, `Members · ${stashed.tabs.length}`));
  members.append(membersHeading);
  const memberList = ui().element("ol", "group-manager__member-list");
  stashed.tabs.forEach((tab) => {
    const item = ui().element("li", "group-manager__member");
    const location = searchableLocation(tab.url);
    const copy = ui().element("span");
    copy.append(ui().element("strong", undefined, tab.title), ui().element("small", undefined, location.hostname || "Local tab"));
    item.append(copy);
    memberList.append(item);
  });
  members.append(memberList);
  editorBody.append(members);

  const actions = ui().element("div", "group-manager__edit-actions");
  actions.append(
    ui().element("span", "group-manager__edit-status", "Saved copy"),
    ui().button("Open in this window", "primary", () => {
      void ui().perform(`groups-restore-stash-${stashed.id}`, async () => {
        await ui().restoreStash(
          stashed.stash,
          stashed.tabs.map((tab) => tab.sourceIndex),
          { destination: "current_window", duplicateHandling: "reuse", afterRestore: "keep" },
        );
        selectedStashedGroupId = null;
        await refreshAfterChange();
      });
    }, {
      disabled: stashed.stash.status === "closing_interrupted",
      actionName: `groups-restore-stash-${stashed.id}`,
      busyLabel: "Opening…",
    }),
  );
  editor.append(editorBody, actions);
}

// Snapshot accessors for main.ts's utility drawer, usable before the
// manager has ever been rendered.
export function groupManagerSnapshot(): GroupManagerState | null {
  return groupManagerState;
}

export function stashedGroupCount(): number {
  return stashedGroupsFrom(popupState.savedStashes).length;
}

export function groupSemanticSearchPending(): boolean {
  return groupSemanticController !== null || groupSemanticTimer !== null || groupSemanticStatus !== "idle";
}

export function groupMemberSemanticSearchPending(): boolean {
  return groupMemberSemanticController !== null || groupMemberSemanticTimer !== null || groupMemberSemanticStatus !== "idle";
}

export function renderGroupManager(shell: HTMLElement, context: GroupManagerPanelContext): void {
  panelContext = context;
  const manager = ui().element("section", `group-manager${groupManagerCompactEditor ? " group-manager--compact-editor" : ""}`);
  const heading = ui().element("header", "group-manager__heading");
  const copy = ui().element("div");
  const stashedGroupCount = groupManagerStashedGroups().length;
  copy.append(
    ui().element("h2", undefined, "Groups"),
    ui().element(
      "span",
      "group-manager__heading-count",
      groupManagerState
        ? `${groupManagerState.groups.length} open${stashedGroupCount ? ` · ${stashedGroupCount} saved` : ""}`
        : "",
    ),
  );
  const headingActions = ui().element("div", "group-manager__heading-actions");
  if (groupManagerState?.canUndo) {
    headingActions.append(ui().groupManagerIconButton("Undo last change", "undo", () => {
      void ui().perform("groups-undo", async () => {
        const response = await ui().send({ type: "group-manager:undo" });
        if (!response.ok) throw new Error(response.error);
        const conflicts = response.groupManagerUndoResult?.conflicts ?? [];
        popupState.notice = {
          tone: conflicts.length ? "info" : "success",
          text: conflicts.length
            ? `Undo restored everything it safely could. ${listConflicts(conflicts)}`
            : "The last group change was undone.",
        };
        await refreshAfterChange();
      });
    }, { actionName: "groups-undo", busyLabel: "Restoring…" }));
  }
  heading.append(copy, headingActions);
  manager.append(heading);

  if (groupManagerStatus === "error" && !groupManagerState) {
    const failed = ui().element("div", "group-manager__load-error");
    failed.setAttribute("role", "alert");
    failed.append(
      ui().element("strong", undefined, "Groups couldn't load"),
      ui().element("p", undefined, groupManagerLoadError ?? "The browser did not return this window's groups."),
      ui().button("Try again", "secondary", () => {
        void ui().perform("groups-load", () => refreshGroupManagerState(ui()));
      }, { actionName: "groups-load", busyLabel: "Loading…" }),
    );
    manager.append(failed);
    shell.append(manager);
    return;
  }

  if (groupManagerStatus === "loading" || !groupManagerState) {
    const loading = ui().element("div", "group-manager__loading");
    loading.append(ui().element("div", "skeleton skeleton--title"), ui().element("div", "skeleton skeleton--copy"));
    manager.append(loading);
    shell.append(manager);
    return;
  }

  if (groupManagerListStale) {
    const stale = ui().element("div", "group-manager__stale");
    stale.setAttribute("role", "status");
    stale.append(
      ui().element("span", undefined, "This list may be out of date."),
      ui().button("Refresh", "quiet", () => {
        void ui().perform("groups-load", () => refreshGroupManagerState(ui()));
      }, { actionName: "groups-load", busyLabel: "Refreshing…" }),
    );
    manager.append(stale);
  }

  const tools = ui().element("div", "group-manager__tools");
  const searchLabel = ui().element("label", "group-manager__search");
  searchLabel.append(ui().element("span", "group-manager__visually-hidden", "Search groups or tabs"));
  const searchInput = ui().element("input", "input");
  searchInput.type = "search";
  searchInput.dataset.focusKey = "group-search";
  searchInput.value = groupManagerQuery;
  searchInput.placeholder = "Search open or saved groups";
  searchInput.addEventListener("input", () => {
    groupManagerQuery = searchInput.value;
    groupRemovalPreview = null;
    // In the single-column popup the editor replaces the list; searching brings the list back.
    groupManagerCompactEditor = false;
    scheduleGroupSemanticSearch(false);
    ui().redraw();
  });
  searchLabel.append(searchInput);
  // Filters are the same segmented chips Search uses for its scope, not selects.
  const segmented = <T extends string>(
    label: string,
    focusPrefix: string,
    options: ReadonlyArray<readonly [T, string]>,
    current: T,
    onChange: (value: T) => void,
  ): HTMLElement => {
    const group = ui().element("div", "segmented");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    options.forEach(([value, text]) => {
      const control = ui().element("button", `segmented__button${value === current ? " segmented__button--active" : ""}`, text);
      control.type = "button";
      control.dataset.focusKey = `${focusPrefix}-${value}`;
      control.setAttribute("aria-pressed", String(value === current));
      control.addEventListener("click", () => {
        if (value === current) return;
        onChange(value);
        groupRemovalPreview = null;
        scheduleGroupSemanticSearch(false);
        ui().redraw();
      });
      group.append(control);
    });
    return group;
  };
  const owner = segmented<GroupManagerOwnershipFilter>(
    "Group ownership filter",
    "group-owner",
    [["managed", "Managed"], ["all", "All groups"]],
    groupManagerOwnershipFilter,
    (value) => { groupManagerOwnershipFilter = value; },
  );
  const scope = segmented<GroupManagerScope>(
    "Group window scope",
    "group-scope",
    [["current_window", "This window"], ["all_windows", "All windows"]],
    groupManagerScope,
    (value) => { groupManagerScope = value; },
  );
  const semantic = ui().groupManagerIconButton("Search by meaning", "search", () => scheduleGroupSemanticSearch(true), {
    disabled: Boolean(ui().semanticSearchAvailability(groupManagerScope)) || groupManagerQuery.trim().length < 2,
  });
  semantic.title = ui().semanticSearchAvailability(groupManagerScope) ?? "Use the configured semantic index";
  const searchActions = ui().element("div", "group-manager__search-actions");
  const filters = ui().element("div", "group-manager__filters");
  filters.append(owner, scope);
  searchActions.append(searchLabel, semantic, filters);
  const semanticCopy = groupSemanticStatus === "loading" || groupSemanticStatus === "debouncing"
    ? "Searching by meaning…"
    : groupSemanticStatus === "ready"
      ? `${groupSemanticScores.length} related group${groupSemanticScores.length === 1 ? "" : "s"}`
      : groupSemanticStatus === "empty"
        ? "No related groups met the semantic threshold"
      : null;
  tools.append(searchActions);
  if (semanticCopy) tools.append(ui().element("span", "group-manager__semantic-status", semanticCopy));
  manager.append(tools);

  const workspace = ui().element("div", "group-manager__workspace");
  const list = ui().element("div", "group-manager__list");
  list.dataset.scrollKey = "group-list";
  const listHeading = ui().element("div", "group-manager__list-heading");
  const visible = visibleManagedGroups();
  const visibleStashed = visibleStashedGroups();
  const hasVisibleGroups = visible.length > 0;
  const hasVisibleEntries = hasVisibleGroups || visibleStashed.length > 0;
  workspace.classList.toggle("group-manager__workspace--empty", !hasVisibleEntries);
  if (selectedGroupId !== null && !visible.some((group) => group.id === selectedGroupId)) {
    selectedGroupId = null;
    resetGroupEditDraft(null);
  }
  if (selectedStashedGroupId !== null && !visibleStashed.some((group) => group.id === selectedStashedGroupId)) {
    selectedStashedGroupId = null;
  }
  if (selectedGroupId === null && selectedStashedGroupId === null) {
    const firstLive = visible[0];
    if (firstLive) {
      selectedGroupId = firstLive.id;
      resetGroupEditDraft(firstLive);
    } else {
      selectedStashedGroupId = visibleStashed[0]?.id ?? null;
    }
  }
  listHeading.append(
    ui().element("h3", undefined, "Open groups"),
    ui().element("span", undefined, selectedGroupIds.size
      ? `${selectedGroupScopeCounts().actionable} selected${selectedGroupScopeCounts().outsideFilters ? ` · ${selectedGroupScopeCounts().outsideFilters} outside filters` : ""}`
      : ui().formatCount(visible.length, "group")),
  );
  list.append(listHeading);
  if (!hasVisibleEntries) {
    const empty = ui().element("div", "group-manager__empty");
    const emptyTitle = groupManagerOwnershipFilter === "managed"
      ? `No managed groups ${groupManagerScope === "current_window" ? "in this window" : "yet"}`
      : groupManagerQuery.trim()
        ? "No groups match this search"
        : `No tab groups ${groupManagerScope === "current_window" ? "in this window or your workspaces" : "to show"}`;
    const emptyCopy = groupManagerOwnershipFilter === "managed"
      ? "Show all native groups, then choose which ones this extension should manage."
      : groupManagerQuery.trim()
        ? "Clear the search or try a group title, tab, or website."
        : "Create a native group or save a group as a workspace and it will appear here automatically.";
    empty.append(
      ui().element("strong", undefined, emptyTitle),
      ui().element("span", undefined, emptyCopy),
    );
    if (groupManagerOwnershipFilter === "managed") {
      const showAll = ui().button("Show all groups", "secondary", () => {
        groupManagerOwnershipFilter = "all";
        groupRemovalPreview = null;
        ui().redraw();
      });
      empty.append(showAll);
    } else if (groupManagerQuery.trim()) {
      const clearSearch = ui().button("Clear search", "secondary", () => {
        groupManagerQuery = "";
        groupSemanticScores = [];
        groupSemanticStatus = "idle";
        groupRemovalPreview = null;
        ui().redraw();
      });
      empty.append(clearSearch);
    }
    list.append(empty);
  }
  visible.forEach((group) => {
    const row = ui().element("div", `group-manager__row${selectedGroupId === group.id ? " group-manager__row--current" : ""}`);
    row.style.setProperty("--slot", `var(--group-${group.color})`);
    const checkbox = ui().element("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedGroupIds.has(group.id);
    checkbox.dataset.focusKey = `group-select-${group.id}`;
    checkbox.setAttribute("aria-label", `Select ${group.title || "untitled group"}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedGroupIds.add(group.id);
      else selectedGroupIds.delete(group.id);
      if (checkbox.checked) groupRemovalTarget = "selected";
      groupRemovalPreview = null;
      ui().redraw();
    });
    const open = ui().element("button", "group-manager__row-main");
    open.type = "button";
    open.dataset.focusKey = `group-row-${group.id}`;
    open.addEventListener("click", () => { selectManagedGroup(group.id); ui().redraw(); });
    const top = ui().element("span", "group-manager__row-title");
    top.append(ui().element("strong", undefined, group.title.trim() || "Untitled group"));
    top.title = group.title.trim() || "Untitled group";
    const meta = ui().element(
      "span",
      "group-manager__row-meta",
      `${ui().formatCount(group.tabCount, "tab")}${groupManagerScope === "all_windows" ? ` · ${group.windowLabel}` : ""}`,
    );
    meta.setAttribute("role", "group");
    meta.setAttribute("aria-label", `${ui().formatCount(group.tabCount, "tab")} · ${group.windowLabel}`);
    const badges = ui().element("span", "group-manager__badges");
    appendGroupBadges(badges, group);
    open.append(top, meta, badges);
    row.append(checkbox, open);
    list.append(row);
  });
  if (visibleStashed.length > 0) {
    const stashedHeading = ui().element("div", "group-manager__list-heading group-manager__list-heading--stashed");
    stashedHeading.append(
      ui().element("h3", undefined, "Saved groups"),
      ui().element("span", undefined, selectedStashedGroupIds.size
        ? `${selectedStashedGroupIds.size} selected`
        : ui().formatCount(visibleStashed.length, "group")),
    );
    list.append(stashedHeading);
    visibleStashed.forEach((group) => {
      const row = ui().element("div", `group-manager__row group-manager__row--stashed${selectedStashedGroupId === group.id ? " group-manager__row--current" : ""}`);
      row.style.setProperty("--slot", `var(--group-${group.color})`);
      const checkbox = ui().element("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedStashedGroupIds.has(group.id);
      checkbox.dataset.focusKey = `group-select-stashed-${group.id}`;
      checkbox.disabled = group.stash.status === "closing_interrupted";
      checkbox.setAttribute("aria-label", `Select saved group ${group.title}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedStashedGroupIds.add(group.id);
        else selectedStashedGroupIds.delete(group.id);
        ui().redraw();
      });
      const open = ui().element("button", "group-manager__row-main");
      open.type = "button";
      open.dataset.focusKey = `group-row-stashed-${group.id}`;
      open.addEventListener("click", () => { selectStashedGroup(group.id); ui().redraw(); });
      const title = ui().element("span", "group-manager__row-title");
      title.title = group.title;
      title.append(ui().element("strong", undefined, group.title));
      const meta = ui().element("span", "group-manager__row-meta", ui().formatCount(group.tabs.length, "tab"));
      const badge = ui().element("span", "group-manager__badges");
      const stashIcon = ui().element("span", "group-manager__badge group-manager__badge--stashed");
      stashIcon.setAttribute("role", "img");
      stashIcon.setAttribute("aria-label", `Saved in ${group.stash.name}`);
      stashIcon.title = `Saved in ${group.stash.name}`;
      stashIcon.append(ui().utilityNavIcon("stashes"));
      badge.append(stashIcon);
      open.append(title, meta, badge);
      row.append(checkbox, open);
      list.append(row);
    });
  }
  workspace.append(list);

  const editor = ui().element("div", "group-manager__editor");
  const current = groupManagerGroup(selectedGroupId);
  const currentStashed = selectedStashedGroupId === null
    ? null
    : visibleStashed.find((group) => group.id === selectedStashedGroupId) ?? null;
  if (currentStashed) {
    renderStashedGroupEditor(editor, currentStashed);
  } else if (!current || !groupEditDraft) {
    const empty = ui().element("div", "group-manager__empty group-manager__empty--editor");
    empty.append(ui().element("strong", undefined, "Choose a group"), ui().element("span", undefined, "Its details and member tabs will appear here."));
    editor.append(empty);
  } else {
    const editorBody = ui().element("div", "group-manager__editor-body");
    editorBody.dataset.scrollKey = `group-editor-${current.id}`;
    const editorHeading = ui().element("div", "group-manager__editor-heading");
    const back = ui().groupManagerIconButton("Back to groups", "back", () => { groupManagerCompactEditor = false; ui().redraw(); });
    back.classList.add("group-manager__back");
    const editorTitle = ui().element("div");
    const editorContext = [
      ui().formatCount(current.tabCount, "tab"),
      current.windowId === popupState.targetWindowId ? null : current.windowLabel,
      current.ownership === "created" ? "Created here" : null,
    ].filter(Boolean).join(" · ");
    editorTitle.append(
      ui().element("strong", undefined, current.title.trim() || "Untitled group"),
      ui().element("span", undefined, editorContext),
    );
    const management = ui().element("div", "group-manager__management");
    const manage = ui().groupManagerIconButton(current.managed ? "Stop managing this group" : "Manage this group", current.managed ? "unmanage" : "manage", () => {
          void ui().perform("groups-manage", async () => {
            const response = await ui().send({ type: "group-manager:set-managed", groupIds: [current.id], managed: !current.managed });
            if (!response.ok) throw new Error(response.error);
            await refreshAfterChange();
          });
        }, { actionName: "groups-manage", busyLabel: "Saving…" });
    const groupTitle = current.title.trim() || "Untitled group";
    const hasUserProtection = ui().groupHasUserProtection(current);
    const protect = ui().groupManagerIconButton(
      hasUserProtection ? `Manage protection for ${groupTitle}` : `Protect ${groupTitle} until restart`,
      "protect",
      () => {
        if (hasUserProtection) {
          ui().openProtectionManager();
          return;
        }
        void ui().perform(`groups-protect-${current.id}`, () => ui().protectGroupFromManager(current));
      },
      { actionName: hasUserProtection ? undefined : `groups-protect-${current.id}`, busyLabel: "Protecting…" },
    );
    management.append(manage, protect);
    editorHeading.append(back, editorTitle, management);
    editorBody.append(editorHeading);

    const facts = ui().element("div", "group-manager__facts");
    const title = ui().element("input", "input");
    title.dataset.focusKey = "group-title";
    title.value = groupEditDraft.title;
    title.maxLength = 24;
    title.addEventListener("input", () => {
      const hadPreview = groupEditPreview !== null;
      editDraft().title = title.value;
      groupEditPreview = null;
      rememberGroupEditDraft();
      if (hadPreview) ui().redraw();
      else patchGroupEditActionState(current, editDraft());
    });
    const titleField = ui().field("Title", title, `${title.value.length}/24`);
    titleField.classList.add("group-manager__title-field");
    const state = ui().element("select", "input");
    ([ ["false", "Expanded"], ["true", "Collapsed"] ] as const).forEach(([value, label]) => {
      const option = ui().element("option", undefined, label);
      option.value = value;
      option.selected = String(editDraft().collapsed) === value;
      state.append(option);
    });
    state.addEventListener("change", () => {
      const hadPreview = groupEditPreview !== null;
      editDraft().collapsed = state.value === "true";
      groupEditPreview = null;
      rememberGroupEditDraft();
      if (hadPreview) ui().redraw();
      else patchGroupEditActionState(current, editDraft());
    });
    facts.append(titleField, ui().field("State", state));
    const colors = ui().element("fieldset", "group-manager__colors");
    colors.append(ui().element("legend", undefined, "Color"));
    CHROME_GROUP_COLORS.forEach((color) => {
      const control = ui().element("button", `group-manager__color group-color--${color}${editDraft().color === color ? " group-manager__color--selected" : ""}`);
      control.type = "button";
      control.setAttribute("aria-label", `${color} group color`);
      control.setAttribute("aria-pressed", String(editDraft().color === color));
      control.addEventListener("click", () => {
        editDraft().color = color;
        groupEditPreview = null;
        rememberGroupEditDraft();
        ui().redraw();
      });
      colors.append(control);
    });
    facts.append(colors);
    editorBody.append(facts);
    const filingOptOut = renderGroupFilingOptOut(current.title);
    if (filingOptOut) editorBody.append(filingOptOut);

    const members = ui().element("section", "group-manager__members");
    const membersHeading = ui().element("div", "group-manager__members-heading");
    membersHeading.append(
      ui().element("strong", undefined, `Members · ${groupEditDraft.tabIds.length}`),
      ui().groupManagerIconButton(groupMemberPickerOpen ? "Done adding tabs" : "Add tabs", groupMemberPickerOpen ? "done" : "add", () => {
        groupMemberPickerOpen = !groupMemberPickerOpen;
        groupEditPreview = null;
        ui().redraw();
      }),
    );
    members.append(membersHeading);
    if (groupMemberPickerOpen) {
      const picker = ui().element("div", "group-manager__picker");
      const pickerInput = ui().element("input", "input");
      pickerInput.type = "search";
      pickerInput.dataset.focusKey = "group-member-search";
      pickerInput.setAttribute("aria-label", "Search tabs to add");
      pickerInput.value = groupMemberQuery;
      pickerInput.placeholder = "Search tabs to add";
      pickerInput.addEventListener("input", () => {
        groupMemberQuery = pickerInput.value;
        scheduleGroupMemberSemanticSearch(false);
        ui().redraw();
      });
      const related = ui().groupManagerIconButton("Search tabs by meaning", "search", () => scheduleGroupMemberSemanticSearch(true), {
        disabled: groupMemberQuery.trim().length < 2 || Boolean(ui().semanticSearchAvailability(current.windowId === popupState.targetWindowId ? "current_window" : "all_windows")),
      });
      const semanticIds = new Set(groupMemberSemanticResults.flatMap((result) => result.target.kind === "open" ? [result.target.tabId] : []));
      const query = groupMemberQuery.toLocaleLowerCase().trim();
      const candidates = groupManagerState.tabs.filter((tab) =>
        tab.windowId === current.windowId && !editDraft().tabIds.includes(tab.id) &&
        (!query || `${tab.title} ${tab.hostname}`.toLocaleLowerCase().includes(query) || semanticIds.has(tab.id)),
      ).sort((left, right) => Number(semanticIds.has(right.id)) - Number(semanticIds.has(left.id)) || left.index - right.index);
      picker.append(pickerInput, related);
      if (groupMemberSemanticStatus === "loading" || groupMemberSemanticStatus === "debouncing") picker.append(ui().element("span", "group-manager__semantic-status", "Searching by meaning…"));
      const candidateList = ui().element("div", "group-manager__picker-list");
      candidateList.dataset.scrollKey = `group-picker-${current.id}`;
      candidates.slice(0, 30).forEach((tab) => {
        const add = ui().element("button", "group-manager__picker-row");
        add.type = "button";
        const copy = ui().element("span");
        copy.append(ui().element("strong", undefined, tab.title), ui().element("small", undefined, `${tab.hostname || "Local tab"}${tab.groupId !== -1 ? " · moves from another group" : ""}`));
        add.append(copy, ui().element("span", undefined, semanticIds.has(tab.id) ? "Related +" : "+"));
        add.addEventListener("click", () => {
          editDraft().tabIds.push(tab.id);
          groupEditPreview = null;
          rememberGroupEditDraft();
          ui().redraw();
        });
        candidateList.append(add);
      });
      if (candidates.length === 0) candidateList.append(ui().element("p", "group-manager__picker-empty", "No available tabs match this search."));
      picker.append(candidateList);
      members.append(picker);
    }
    const memberList = ui().element("ol", "group-manager__member-list");
    memberList.dataset.scrollKey = `group-members-${current.id}`;
    groupEditDraft.tabIds.forEach((tabId, index) => {
      const tab = loadedGroupManagerState().tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      const item = ui().element("li", "group-manager__member");
      const copy = ui().element("span");
      copy.append(ui().element("strong", undefined, tab.title), ui().element("small", undefined, tab.hostname || "Local tab"));
      const actions = ui().element("span", "group-manager__member-actions");
      const move = (offset: number): void => {
        const next = index + offset;
        if (next < 0 || next >= editDraft().tabIds.length) return;
        const [selected] = editDraft().tabIds.splice(index, 1);
        if (selected !== undefined) editDraft().tabIds.splice(next, 0, selected);
        groupEditPreview = null;
        rememberGroupEditDraft();
        ui().redraw();
      };
      const up = ui().groupManagerIconButton(`Move ${tab.title} up`, "up", () => move(-1), { disabled: index === 0 });
      const down = ui().groupManagerIconButton(`Move ${tab.title} down`, "down", () => move(1), {
        disabled: index === editDraft().tabIds.length - 1,
      });
      const remove = ui().groupManagerIconButton(`Remove ${tab.title} from group`, "remove", () => {
        editDraft().tabIds = editDraft().tabIds.filter((id) => id !== tab.id);
        groupEditPreview = null;
        rememberGroupEditDraft();
        ui().redraw();
      });
      actions.append(up, down, remove);
      item.append(copy, actions);
      memberList.append(item);
    });
    members.append(memberList);
    editorBody.append(members);

    const editActions = ui().element("div", "group-manager__edit-actions");
    if (groupEditPreview) {
      const preview = ui().element("div", "group-manager__edit-preview");
      preview.append(
        ui().element("strong", undefined, "Ready to apply"),
        ui().element("span", undefined, `${groupEditPreview.addedTabIds.length} added · ${groupEditPreview.removedTabIds.length} removed${groupEditPreview.reordered ? " · order changed" : ""}${groupEditPreview.emptiedSourceGroupIds.length ? ` · ${groupEditPreview.emptiedSourceGroupIds.length} source group emptied` : ""}`),
      );
      editActions.append(
        ui().groupManagerIconButton("Cancel review", "done", () => { groupEditPreview = null; ui().redraw(); }),
        preview,
        ui().button("Apply changes", "primary", () => void ui().perform("groups-apply-edit", applyGroupEditAction), { actionName: "groups-apply-edit", busyLabel: "Verifying…" }),
      );
    } else {
      const dirty = groupEditHasChanges(current, groupEditDraft);
      const discard = ui().groupManagerIconButton("Discard changes", "discard", () => { discardGroupEditDraft(current); ui().redraw(); }, { disabled: !dirty });
      discard.classList.add("group-manager__discard");
      const review = ui().button("Review & apply", "primary", () => void ui().perform("groups-preview-edit", previewGroupEditAction), {
        disabled: !dirty,
        actionName: "groups-preview-edit",
        busyLabel: "Checking…",
      });
      review.classList.add("group-manager__review");
      editActions.append(
        discard,
        ui().element("span", "group-manager__edit-status", dirty ? "Unsaved" : ""),
        review,
      );
    }
    editor.append(editorBody, editActions);
  }
  if (hasVisibleEntries) workspace.append(editor);
  manager.append(workspace);

  // The batch foot appears only when there is something to act on: a selection,
  // or one of the standing sets (inactive groups, every extension group). With a
  // selection it targets that selection; without one, "selected" is not offered.
  const scopedGroups = hasVisibleGroups ? scopedManagedGroups() : [];
  const { actionable, outsideFilters } = selectedGroupScopeCounts();
  const hasSelection = actionable + outsideFilters > 0;
  const inactiveCount = scopedGroups.filter((group) => !group.active).length;
  const managedCount = scopedGroups.filter((group) => group.managed).length;
  if (!hasSelection && groupRemovalTarget === "selected") groupRemovalTarget = inactiveCount > 0 ? "inactive" : "managed";
  const offersGroupActions = hasVisibleGroups && (hasSelection || inactiveCount + managedCount > 0);
  if (!offersGroupActions && selectedStashedGroupIds.size === 0) {
    shell.append(manager);
    return;
  }

  const batch = ui().element("footer", "group-manager__batch");
  const batchActions = ui().element("div", "group-manager__batch-actions");
  if (offersGroupActions) {
    // One row: the target names what the actions apply to, with live counts,
    // so the buttons read as "Ungroup / Close <these groups>".
    const target = ui().element("select", "input group-manager__batch-target");
    target.setAttribute("aria-label", "Apply to");
    ([
      ...(hasSelection ? [["selected", `${actionable} selected${outsideFilters ? ` (+${outsideFilters} hidden)` : ""}`] as const] : []),
      ["inactive", `Inactive groups · ${inactiveCount}`] as const,
      ["managed", `All extension groups · ${managedCount}`] as const,
    ]).forEach(([value, label]) => {
      const option = ui().element("option", undefined, label);
      option.value = value;
      option.selected = value === groupRemovalTarget;
      target.append(option);
    });
    target.addEventListener("change", () => { groupRemovalTarget = target.value as typeof groupRemovalTarget; groupRemovalPreview = null; ui().redraw(); });
    batch.append(target);
    const noTargets = groupRemovalTargetIds().length === 0;
    batchActions.append(
      ui().button("Ungroup…", "secondary", () => void ui().perform("groups-preview-ungroup", () => previewGroupRemovalAction("ungroup")), { disabled: noTargets, actionName: "groups-preview-ungroup", busyLabel: "Checking…" }),
      ui().button("Close tabs…", "secondary", () => void ui().perform("groups-preview-close", () => previewGroupRemovalAction("close")), { disabled: noTargets, actionName: "groups-preview-close", busyLabel: "Checking…" }),
    );
  } else {
    batch.append(ui().element("span", "group-manager__batch-summary", `${selectedStashedGroupIds.size} saved selected`));
  }
  if (selectedStashedGroupIds.size > 0) {
    batchActions.append(ui().button(
      `Open saved · ${selectedStashedGroupIds.size}`,
      "secondary",
      () => void ui().perform("groups-open-selected-stashes", openSelectedStashedGroups),
      { actionName: "groups-open-selected-stashes", busyLabel: "Opening…" },
    ));
  }
  batch.append(batchActions);
  if (groupRemovalPreview) {
    const review = ui().element("div", "group-manager__removal-preview");
    review.append(
      ui().element("strong", undefined, groupRemovalPreview.mode === "close" ? "Recovery review" : "Ungroup review"),
      ui().element("span", undefined, `${groupRemovalPreview.eligibleGroupIds.length} groups · ${groupRemovalPreview.eligibleTabIds.length} tabs${groupRemovalPreview.blockedGroups.length ? ` · ${groupRemovalPreview.blockedGroups.length} kept` : ""}`),
    );
    if (groupRemovalPreview.mode === "close" && groupRemovalPreview.activeGroupIds.length > 0) {
      const include = ui().element("label", "group-manager__include-active");
      const control = ui().element("input");
      control.type = "checkbox";
      control.checked = groupRemovalIncludeActive;
      control.addEventListener("change", () => {
        groupRemovalIncludeActive = control.checked;
        void ui().perform("groups-preview-close", () => previewGroupRemovalAction("close"));
      });
      include.append(control, ui().element("span", undefined, "Include the active group"));
      review.append(include);
    }
    groupRemovalPreview.blockedGroups.forEach((blocked) => review.append(ui().element("small", undefined, blocked.reason)));
    const reviewActions = ui().element("div", "group-manager__removal-actions");
    reviewActions.append(
      ui().button("Keep groups", "quiet", () => {
        groupRemovalPreview = null;
        groupRemovalIncludeActive = false;
        ui().redraw();
      }),
      ui().button(groupRemovalPreview.mode === "close" ? "Confirm close and save recovery" : "Confirm ungroup", groupRemovalPreview.mode === "close" ? "danger" : "primary", () => void ui().perform("groups-apply-remove", applyGroupRemovalAction), {
        disabled: groupRemovalPreview.eligibleGroupIds.length === 0,
        actionName: "groups-apply-remove",
        busyLabel: groupRemovalPreview.mode === "close" ? "Saving recovery…" : "Ungrouping…",
      }),
    );
    review.append(
      ui().element("p", undefined, groupRemovalPreview.mode === "close"
        ? "A verified local recovery workspace will be created before any tab closes."
        : "Tabs remain open and keep their current order."),
      reviewActions,
    );
    batch.append(review);
  }
  manager.append(batch);
  shell.append(manager);
}
