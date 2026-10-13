import { buildTabStashPreview } from "../../browser/tab-stashes";
import type {
  SavedTabStash,
  StashedGroup,
  StashRestoreOptions,
  StashRestoreResult,
  StashWorkspaceDiff,
  TabStashSettings,
  TrashedTabStash,
} from "../../shared/stash-types";
import type {
  WindowCaptureMessage,
} from "../../shared/types";
import type { WindowCaptureResponseFor } from "../../shared/message-state";
import { listConflicts, relativeAge } from "../shared/helpers";
import {
  clearTabStashQuarantine,
  readTabStashQuarantine,
  readTabStashes,
  readTabStashTrash,
  tabStashExpiresAt,
  tabStashLastUsedAt,
  TRASH_RETENTION_DAYS,
  writeTabStashSettings,
  type QuarantinedTabStash,
} from "../../storage/stashes";
import { stashRevealMatches } from "./tab-search-ui";
import { popupState } from "./popup-store";
import { trackSettingsSave } from "./settings-save-status";

// DOM and action helpers owned by main.ts, injected so the stash drawer stays a
// leaf module without importing the main entry. Shared state is in popup-store.
export interface StashPanelContext {
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
  showTooltip(owner: HTMLButtonElement, label: string): void;
  hideTooltip(owner?: HTMLButtonElement): void;
  send<Message extends WindowCaptureMessage>(message: Message): Promise<WindowCaptureResponseFor<Message>>;
  perform(actionName: string, action: () => Promise<void>): Promise<void>;
  render(): void;
  /** Rebuilds only the open drawer, for changes that stay inside it. */
  redraw(): void;
}

type StashActionIcon = "background" | "copy" | "edit" | "close" | "delete" | "confirm" | "history";

let stashDeleteArmedId: string | null = null;
let stashRestoreEditorId: string | null = null;
let stashMetadataEditorId: string | null = null;
const selectedStashRestoreIndexes = new Set<number>();
const stashRestoreOptions = new Map<string, StashRestoreOptions>();
const stashWorkspaceDiffs = new Map<string, StashWorkspaceDiff>();

let panelContext: StashPanelContext | null = null;
let quarantinedStashes: QuarantinedTabStash[] = [];
let quarantineDiscardArmed = false;
let trashedStashes: TrashedTabStash[] = [];
let stashTrashOpen = false;
let stashPurgeArmedId: string | null = null;
let stashVersionsId: string | null = null;
let stashDiscardArmedId: string | null = null;
// Keeping the window open is the safer default: nothing closes unless asked.
let stashCreateKeepOpen = true;
// null follows the saved list: the form starts open only when nothing is saved.
let stashCreateOpen: boolean | null = null;
// A Save & close that would also close private tabs it cannot save waits for
// a second, explicit click.
let stashParkArmed: { stashId: string; privateTabs: number } | null = null;

// Registered once at startup: the group manager restores stashes and the
// search drawer reveals them before the stash drawer has ever rendered.
export function setStashPanelContext(context: StashPanelContext): void {
  panelContext = context;
}

function ui(): StashPanelContext {
  if (!panelContext) throw new Error("The stash panel context is unavailable.");
  return panelContext;
}

// Drawer hooks for main.ts: navigation away from the drawer disarms a pending
// delete, and a search result opens its stash with the tab picker showing.
export function disarmStashDelete(): void {
  stashDeleteArmedId = null;
  stashParkArmed = null;
  quarantineDiscardArmed = false;
  stashPurgeArmedId = null;
  stashDiscardArmedId = null;
}

async function loadStashTrash(): Promise<void> {
  trashedStashes = await readTabStashTrash();
}

// Called after stashes are read, since that read is what moves unreadable
// records into the quarantine and expired ones into the trash.
export async function loadStashExtras(): Promise<void> {
  [quarantinedStashes, trashedStashes] = await Promise.all([readTabStashQuarantine(), readTabStashTrash()]);
}

function scrollStashPanelIntoView(stashId: string, selector: string): void {
  requestAnimationFrame(() => {
    document
      .querySelector(`.stash-item[data-stash-id="${CSS.escape(stashId)}"] ${selector}`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

function workspaceDiffSummary(diff: StashWorkspaceDiff): string {
  const parts = [
    [diff.addedTabs, "tab added", "tabs added"],
    [diff.removedTabs, "tab removed", "tabs removed"],
    [diff.changedTabs, "tab changed", "tabs changed"],
    [diff.reorderedTabs, "tab reordered", "tabs reordered"],
    [diff.renamedGroups, "group renamed", "groups renamed"],
    [diff.groupStructureChanges, "group change", "group changes"],
  ] as const;
  const changed = parts.filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return changed.length === 0 ? "No changes since this workspace was last saved." : changed.join(" · ");
}

function renderStashQuarantine(): HTMLElement | null {
  if (quarantinedStashes.length === 0) return null;
  const count = quarantinedStashes.length;
  const notice = ui().element("div", "stash-quarantine");
  notice.setAttribute("role", "status");
  notice.append(
    ui().element("strong", undefined, `${ui().formatCount(count, "saved workspace")} could not be read`),
    ui().element(
      "p",
      undefined,
      `${count === 1 ? "It was" : "They were"} set aside so the rest of your workspaces keep working. Copy the raw data to keep it, then discard.`,
    ),
  );
  const actions = ui().element("div", "stash-quarantine__actions");
  actions.append(
    ui().button("Copy raw data", "secondary", () => {
      void navigator.clipboard.writeText(JSON.stringify(quarantinedStashes, null, 2)).then(() => {
        popupState.notice = { tone: "success", text: "Unreadable workspace data copied." };
        ui().render();
      }).catch(() => {
        popupState.notice = { tone: "error", text: "The workspace data could not be copied." };
        ui().render();
      });
    }),
    ui().button(quarantineDiscardArmed ? "Confirm discard" : "Discard", quarantineDiscardArmed ? "danger" : "quiet", () => {
      if (!quarantineDiscardArmed) {
        quarantineDiscardArmed = true;
        popupState.pendingFocusKey = "stash-quarantine-discard";
        ui().redraw();
        return;
      }
      void ui().perform("stash-quarantine-discard", async () => {
        await clearTabStashQuarantine();
        quarantinedStashes = [];
        quarantineDiscardArmed = false;
        popupState.notice = { tone: "success", text: "Unreadable workspace data discarded." };
      });
    }, { actionName: quarantineDiscardArmed ? "stash-quarantine-discard" : undefined }),
  );
  actions.lastElementChild?.setAttribute("data-focus-key", "stash-quarantine-discard");
  notice.append(actions);
  return notice;
}

export function revealStash(stashId: string): void {
  stashRestoreEditorId = stashId;
  selectedStashRestoreIndexes.clear();
}

function stashIconButton(
  label: string,
  accessibleLabel: string,
  icon: StashActionIcon,
  onClick: () => void,
  options: { disabled?: boolean; actionName?: string; busyLabel?: string; className?: string } = {},
): HTMLButtonElement {
  const node = ui().button(label, "quiet", onClick, options);
  node.classList.add("stash-icon-button");
  options.className?.split(/\s+/).filter(Boolean).forEach((className) => node.classList.add(className));
  node.setAttribute("aria-label", accessibleLabel);
  node.dataset.tooltip = label;
  node.textContent = "";
  node.addEventListener("mouseenter", () => ui().showTooltip(node, label));
  node.addEventListener("mouseleave", () => ui().hideTooltip(node));
  node.addEventListener("focus", () => ui().showTooltip(node, label));
  node.addEventListener("blur", () => ui().hideTooltip(node));
  node.addEventListener("click", () => ui().hideTooltip(node));

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const paths: Record<StashActionIcon, string[]> = {
    background: [
        "M4 5h16v14H4Z",
        "M4 9h16",
        "M14 14H9",
        "m11 11-3 3 3 3",
    ],
    copy: [
        "M8 8h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V8Z",
        "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2",
    ],
    edit: [
      "M4 20h4l11-11-4-4L4 16v4Z",
      "m13 7 4 4",
    ],
    close: [
      "m6 6 12 12",
      "M18 6 6 18",
    ],
    delete: [
      "M4 7h16",
      "M9 7V4h6v3",
      "m6 7 1 13h10l1-13",
      "M10 11v5",
      "M14 11v5",
    ],
    confirm: ["m5 12 4 4L19 6"],
    history: [
      "M3.5 12a8.5 8.5 0 1 0 2.6-6.1",
      "M3.5 4.5v4h4",
      "M12 8v4.5l3 2",
    ],
  };
  paths[icon].forEach((d) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  });
  node.append(svg);
  return node;
}

export function stashStatusLabel(stash: SavedTabStash): string {
  if (stash.status === "saved") return "Ready";
  if (stash.status === "restored") return "Restored before";
  if (stash.status === "restore_partial") return "Partial restore";
  return "Needs recovery";
}

function restoreOptionsFor(stash: SavedTabStash): StashRestoreOptions {
  return stashRestoreOptions.get(stash.id) ?? {
    destination: stash.scope.mode === "window" ? "new_window" : "current_window",
    duplicateHandling: "reuse",
    afterRestore: "keep",
  };
}

export async function restoreStash(
  stash: SavedTabStash,
  sourceIndexes?: number[],
  options = restoreOptionsFor(stash),
): Promise<void> {
  const targetWindowId = popupState.targetWindowId;
  if (targetWindowId === null) throw new Error("No restore window is selected.");
  const response = await ui().send({
    type: "workspace:restore",
    stashId: stash.id,
    targetWindowId,
    ...(sourceIndexes ? { sourceIndexes } : {}),
    options,
  });
  if (!response.ok) throw new Error(response.error);
  popupState.viewState = response.state;
  popupState.savedStashes = await readTabStashes();
  stashRestoreEditorId = null;
  selectedStashRestoreIndexes.clear();
  popupState.notice = restoreNotice(response.stashRestoreResult, sourceIndexes ? "Selected tabs" : "Workspace");
}

// The tone follows what actually happened: a restore where some tabs failed is
// not a success, and one where nothing opened is an error.
function restoreNotice(
  result: StashRestoreResult | undefined,
  subject: string,
): { tone: "success" | "info" | "error"; text: string } {
  if (!result) return { tone: "success", text: `${subject} opened.` };
  const opened = result.openedTabs + (result.reusedTabs ?? 0);
  const reused = result.reusedTabs ? ` · ${result.reusedTabs} already open` : "";
  if (result.conflicts.length === 0) {
    return { tone: "success", text: `${subject} opened: ${opened} tab${opened === 1 ? "" : "s"}${reused}.` };
  }
  if (opened === 0) {
    return { tone: "error", text: `No tabs could be reopened. ${listConflicts(result.conflicts)} The workspace is unchanged.` };
  }
  return {
    tone: "info",
    text: `Opened ${opened} tab${opened === 1 ? "" : "s"}${reused}. ${listConflicts(result.conflicts)} The workspace is unchanged.`,
  };
}

async function openStashTab(stash: SavedTabStash, sourceIndex: number, active: boolean): Promise<void> {
  const targetWindowId = popupState.targetWindowId;
  if (targetWindowId === null) throw new Error("No browser window is selected.");
  const response = await ui().send({ type: "workspace:open-tab", stashId: stash.id, sourceIndex, targetWindowId, active });
  if (!response.ok) throw new Error(response.error);
  popupState.notice = { tone: "success", text: active ? "Saved tab opened. The workspace is unchanged." : "Saved tab opened in the background. The workspace is unchanged." };
}

export function renderStashRetentionSettings(): HTMLElement {
  const group = ui().element("section", "settings-group stash-retention-settings");
  group.append(
    ui().element("h3", undefined, "Workspace retention"),
    ui().element(
      "p",
      "settings-group__copy",
      `Saved workspaces stay until you delete them or they go unused past the limit. Either way they wait in the trash for ${TRASH_RETENTION_DAYS} days first.`,
    ),
  );
  const select = ui().element("select", "input");
  select.setAttribute("aria-label", "Auto-delete saved workspaces");
  ([
    ["never", "Never auto-delete"],
    ["1", "After 1 unused day"],
    ["7", "After 7 unused days"],
    ["30", "After 30 unused days"],
    ["90", "After 90 unused days"],
  ] as const).forEach(([value, label]) => {
    const option = ui().element("option", undefined, label);
    option.value = value;
    option.selected = value === (popupState.stashSettings.autoDeleteAfterDays === null
      ? "never"
      : String(popupState.stashSettings.autoDeleteAfterDays));
    select.append(option);
  });
  select.addEventListener("change", () => {
    void ui().perform("stash-retention-autosave", () => trackSettingsSave(async () => {
      const autoDeleteAfterDays = select.value === "never"
        ? null
        : Number(select.value) as TabStashSettings["autoDeleteAfterDays"];
      const written = await writeTabStashSettings({ autoDeleteAfterDays });
      popupState.stashSettings = written.settings;
      popupState.savedStashes = written.stashes;
    }));
  });
  group.append(
    ui().field("Auto-delete saved workspaces", select, "Counts from the last time a workspace was opened or changed. Workspaces open in a window never expire."),
  );
  return group;
}

export function renderStashes(shell: HTMLElement): void {
  if (!popupState.stashesOpen) return;
  const state = popupState.viewState.editor?.capturedState;
  const savedStashes = popupState.savedStashes;
  const panel = ui().element("section", "stashes-panel");
  // The tab already names the view, so the headline states what is saved and the
  // one way to add to it sits beside it.
  const heading = ui().element("div", "view-heading");
  heading.append(ui().element(
    "h2",
    undefined,
    savedStashes.length === 0 ? "No saved workspaces" : ui().formatCount(savedStashes.length, "saved workspace"),
  ));
  panel.append(heading);

  let createSection: HTMLElement | null = null;
  if (state && popupState.targetWindowId !== null && !(stashCreateOpen ?? savedStashes.length === 0)) {
    const start = ui().button("Save this window…", "secondary", () => {
      stashCreateOpen = true;
      popupState.pendingFocusKey = "stash-create-scope";
      ui().redraw();
    });
    start.classList.add("stash-create-start");
    start.dataset.focusKey = "stash-create-start";
    start.setAttribute("aria-expanded", "false");
    heading.append(start);
  } else if (state && popupState.targetWindowId !== null) {
    const create = ui().element("div", "stash-create");
    const scopeSelect = ui().element("select", "input");
    scopeSelect.setAttribute("aria-label", "What to save");
    scopeSelect.dataset.focusKey = "stash-create-scope";
    const windowOption = ui().element("option", undefined, `Entire window · ${ui().formatCount(state.tabs.length, "tab")}`);
    windowOption.value = "window";
    scopeSelect.append(windowOption);
    state.groups.forEach((group) => {
      const option = ui().element(
        "option",
        undefined,
        `${group.title.trim() || "Untitled group"} · ${ui().formatCount(group.memberTabIds.length, "tab")}`,
      );
      option.value = `group:${group.runtimeId}`;
      scopeSelect.append(option);
    });
    const selectedScope = () => scopeSelect.value === "window"
      ? { mode: "window" as const }
      : { mode: "group" as const, groupId: Number(scopeSelect.value.slice("group:".length)) };
    let currentPreview = buildTabStashPreview(state, selectedScope());
    let generatedName = currentPreview.name;
    const name = ui().input(generatedName);
    name.maxLength = 120;
    name.setAttribute("aria-label", "Workspace name");
    const eligibility = ui().element("div", "stash-create__eligibility");
    const excludedList = ui().element("ul", "stash-create__excluded-list");
    excludedList.setAttribute("aria-label", "Tabs that stay open");
    const keepOpenChoice = ui().element("fieldset", "stash-create__after");
    keepOpenChoice.append(ui().element("legend", undefined, "After saving"));
    const afterOption = (label: string, hint: string, checked: boolean): HTMLInputElement => {
      const radio = ui().element("input");
      radio.type = "radio";
      radio.name = "stash-create-after";
      radio.checked = checked;
      const row = ui().element("label", "stash-create__after-option");
      const copy = ui().element("span");
      copy.append(ui().element("strong", undefined, label), ui().element("small", undefined, hint));
      row.append(radio, copy);
      keepOpenChoice.append(row);
      return radio;
    };
    const keepOpen = afterOption("Keep the window open", "Its changes save automatically until it closes", stashCreateKeepOpen);
    const closeAfter = afterOption("Close the saved tabs", "Protected tabs stay open", !stashCreateKeepOpen);
    keepOpen.dataset.focusKey = "stash-create-keep-open";
    closeAfter.dataset.focusKey = "stash-create-close";
    const keepingOpen = (): boolean => keepOpen.checked && selectedScope().mode === "window";
    const submit = ui().button(
      "",
      "primary",
      () => {
        void ui().perform("stash-tabs", async () => {
          const targetWindowId = popupState.targetWindowId;
          if (targetWindowId === null) return;
          const preview = buildTabStashPreview(state, selectedScope());
          const linked = keepingOpen();
          const response = await ui().send({
            type: "workspace:create",
            targetWindowId,
            scope: preview.scope,
            expectedTabIds: preview.tabs.map((tab) => tab.sourceTabId),
            name: name.value,
            ...(linked ? { keepOpen: true } : {}),
          });
          popupState.viewState = response.state;
          if (!response.ok) throw new Error(response.error);
          popupState.savedStashes = await readTabStashes();
          stashCreateOpen = null;
          popupState.notice = {
            tone: "success",
            text: linked
              ? `Window saved as “${name.value.trim()}”. It stays open and saves its changes when it closes.`
              : `${preview.tabs.length} tab${preview.tabs.length === 1 ? "" : "s"} saved and closed. Reopen the workspace at any time.`,
          };
        });
      },
      { actionName: "stash-tabs", busyLabel: "Saving…" },
    );
    const refreshEligibility = (): void => {
      currentPreview = buildTabStashPreview(state, selectedScope());
      if (!name.value.trim() || name.value === generatedName) name.value = currentPreview.name;
      generatedName = currentPreview.name;
      keepOpenChoice.hidden = selectedScope().mode !== "window";
      const linked = keepingOpen();
      eligibility.replaceChildren(...(linked ? [
        ui().element("strong", undefined, "Saves this window and keeps it open"),
        ui().element("span", undefined, "Private pages are never saved"),
      ] : [
        ui().element("strong", undefined, `${currentPreview.tabs.length} tab${currentPreview.tabs.length === 1 ? "" : "s"} will close`),
        ui().element(
          "span",
          currentPreview.excludedTabs.length > 0 ? "stash-create__excluded" : undefined,
          currentPreview.excludedTabs.length > 0
            ? `${currentPreview.excludedTabs.length} protected tab${currentPreview.excludedTabs.length === 1 ? " stays" : "s stay"} open`
            : "No tabs are excluded",
        ),
      ]));
      const shownExcluded = currentPreview.excludedTabs.slice(0, 5);
      const hiddenExcluded = currentPreview.excludedTabs.length - shownExcluded.length;
      excludedList.replaceChildren(
        ...shownExcluded.map((tab) => {
          const item = ui().element("li");
          item.append(
            ui().element("span", "stash-create__excluded-title", tab.title || "Untitled tab"),
            ui().element("span", "stash-create__excluded-reason", tab.reasons.join(" · ")),
          );
          return item;
        }),
        ...(hiddenExcluded > 0
          ? [ui().element("li", "stash-create__excluded-more", `and ${ui().formatCount(hiddenExcluded, "more tab")}`)]
          : []),
      );
      excludedList.hidden = linked || currentPreview.excludedTabs.length === 0;
      submit.textContent = currentPreview.tabs.length === 0
        ? "No eligible tabs to save"
        : linked
          ? "Save & keep window open"
          : `Save & close ${currentPreview.tabs.length} tab${currentPreview.tabs.length === 1 ? "" : "s"}`;
      submit.disabled = currentPreview.tabs.length === 0 || !name.value.trim();
    };
    const actions = ui().element("div", "stash-create__actions");
    const cancel = ui().button("Cancel", "quiet", () => {
      stashCreateOpen = false;
      popupState.pendingFocusKey = "stash-create-start";
      ui().redraw();
    });
    actions.append(cancel, submit);
    scopeSelect.addEventListener("change", refreshEligibility);
    [keepOpen, closeAfter].forEach((radio) => radio.addEventListener("change", () => {
      stashCreateKeepOpen = keepOpen.checked;
      refreshEligibility();
    }));
    name.addEventListener("input", () => {
      submit.disabled = currentPreview.tabs.length === 0 || !name.value.trim();
    });
    create.append(
      ui().field(
        "What to save",
        scopeSelect,
        state.groups.length === 0 ? "No groups in this window." : undefined,
      ),
      ui().field("Workspace name", name),
      keepOpenChoice,
      eligibility,
      excludedList,
      actions,
    );
    refreshEligibility();
    createSection = create;
  }

  const saved = ui().element("div", "stash-saved");
  const quarantine = renderStashQuarantine();
  if (quarantine) saved.append(quarantine);
  if (savedStashes.length === 0) {
    // With the save form already open above, the headline says enough.
    if (!createSection) saved.append(ui().element("p", "history-empty", "Save a window or group to reopen the same set later."));
  } else {
    const list = ui().element("ul", "stash-list");
    orderedStashes(savedStashes).forEach((stash) => list.append(renderStashRow(stash)));
    saved.append(list);
  }
  if (createSection) panel.append(createSection);
  panel.append(saved);
  const trash = renderStashTrash();
  if (trash) panel.append(trash);
  shell.append(panel);
}

// Open stashes come first, then the rest by most recent use.
function orderedStashes(stashes: readonly SavedTabStash[]): SavedTabStash[] {
  return [...stashes].sort((left, right) =>
    Number(right.activeWorkspaceId !== null) - Number(left.activeWorkspaceId !== null) ||
    tabStashLastUsedAt(right) - tabStashLastUsedAt(left),
  );
}

function daysUntil(timestamp: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((timestamp - now) / (24 * 60 * 60_000)));
}

function stashMetaLine(stash: SavedTabStash): string {
  const counts = `${ui().formatCount(stash.tabs.length, "tab")}${stash.groups.length > 0 ? ` · ${ui().formatCount(stash.groups.length, "group")}` : ""}`;
  if (stash.activeWorkspaceId) return `${counts} · Open in a window, saves when it closes`;
  return stash.lastOpenedAt !== null && stash.lastOpenedAt >= stash.updatedAt
    ? `${counts} · Opened ${relativeAge(stash.lastOpenedAt)}`
    : `${counts} · Saved ${relativeAge(stash.updatedAt)}`;
}

function stashGroupChip(group: StashedGroup): HTMLElement {
  const chip = ui().element("span", "stash-chip");
  chip.append(
    ui().element("span", `group-color group-color--${group.color}`),
    ui().element("span", "stash-chip__label", group.title.trim() || "Untitled group"),
  );
  return chip;
}

// Three chips keep the row scannable; the count opens the rest. Hovering or
// focusing the count peeks at the list, and activating it pins the list open
// so it survives the focus moving on.
function stashRemainingChip(stash: SavedTabStash, rest: readonly StashedGroup[]): HTMLElement {
  const wrapper = ui().element("span", "stash-chip stash-chip--more");
  const panelId = `stash-more-${stash.id}`;
  const trigger = ui().element("button", "stash-more__trigger", `+${rest.length}`);
  trigger.type = "button";
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", panelId);
  trigger.setAttribute("aria-label", `+${rest.length} more groups`);
  const panel = ui().element("div", "stash-more");
  panel.id = panelId;
  const list = ui().element("div", "stash-more__list");
  rest.forEach((group) => {
    const item = ui().element("span", "stash-more__item");
    item.append(
      ui().element("span", `group-color group-color--${group.color}`),
      ui().element("span", "stash-more__label", group.title.trim() || "Untitled group"),
      ui().element("span", "stash-more__count", ui().formatCount(stash.tabs.filter((tab) => tab.groupKey === group.key).length, "tab")),
    );
    list.append(item);
  });
  panel.append(list);
  wrapper.append(trigger, panel);

  const setOpen = (open: boolean) => trigger.setAttribute("aria-expanded", String(open));
  trigger.addEventListener("click", () => setOpen(trigger.getAttribute("aria-expanded") !== "true"));
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
  return wrapper;
}

// What is inside, at a glance: its groups as colored chips, or the most
// frequent sites when it has no groups.
function stashContents(stash: SavedTabStash): HTMLElement | null {
  const contents = ui().element("div", "stash-contents");
  if (stash.groups.length > 0) {
    const groups = [...stash.groups].sort((left, right) => left.sourceIndex - right.sourceIndex);
    groups.slice(0, 3).forEach((group) => contents.append(stashGroupChip(group)));
    if (groups.length > 3) contents.append(stashRemainingChip(stash, groups.slice(3)));
    return contents;
  }
  const hosts = new Map<string, number>();
  stash.tabs.forEach((tab) => {
    try {
      const host = new URL(tab.url).hostname.replace(/^www\./, "");
      if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1);
    } catch {
      // Unparseable addresses are left out of the summary.
    }
  });
  const top = [...hosts].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([host]) => host);
  if (top.length === 0) return null;
  contents.append(ui().element("span", "stash-contents__sites", top.join(", ")));
  return contents;
}

function stashBadges(stash: SavedTabStash): HTMLElement[] {
  const badges: HTMLElement[] = [];
  if (stash.activeWorkspaceId) badges.push(ui().element("span", "stash-workspace-badge", "Open"));
  if (stash.status === "restore_partial" || stash.status === "closing_interrupted") {
    badges.push(ui().element("span", `stash-status stash-status--${stash.status}`, stashStatusLabel(stash)));
  }
  const expiresAt = tabStashExpiresAt(stash, popupState.stashSettings);
  if (expiresAt !== null && daysUntil(expiresAt) <= 7) {
    const days = daysUntil(expiresAt);
    badges.push(ui().element(
      "span",
      "stash-expiry",
      days === 0 ? "Expires today" : `Expires in ${ui().formatCount(days, "day")}`,
    ));
  }
  return badges;
}

function renderStashRow(stash: SavedTabStash): HTMLElement {
  const row = ui().element("li", `stash-item${stash.activeWorkspaceId ? " stash-item--open" : ""}`);
  row.dataset.stashId = stash.id;
  const heading = ui().element("div", "stash-item__heading");
  const copy = ui().element("div");
  copy.append(
    ui().element("strong", undefined, stash.name),
    ui().element("span", undefined, stashMetaLine(stash)),
  );
  const headingMeta = ui().element("span", "stash-item__heading-meta");
  headingMeta.append(...stashBadges(stash));
  heading.append(copy, headingMeta);
  row.append(heading);
  const contents = stashContents(stash);
  if (contents) row.append(contents);
  if (stash.note.trim()) row.append(ui().element("p", "stash-note", stash.note));
  if (stash.closeConflicts.length > 0) {
    row.append(ui().element("p", "stash-conflict", stash.closeConflicts.join(" ")));
  }
  if (stash.restoreResult && stash.restoreResult.conflicts.length > 0) {
    row.append(ui().element("p", "stash-conflict", `Last restore: ${stash.restoreResult.conflicts.join(" ")}`));
  }
  row.append(renderStashActions(stash));
  if (stashParkArmed?.stashId === stash.id && stash.activeWorkspaceId) {
    const count = stashParkArmed.privateTabs;
    row.append(ui().element(
      "p",
      "stash-conflict",
      `${ui().formatCount(count, "private tab")} in this window ${count === 1 ? "is" : "are"} never saved to workspaces and will close with it.`,
    ));
  }
  appendMetadataEditor(row, stash);
  appendWorkspaceDiff(row, stash);
  appendVersions(row, stash);
  appendRestorePicker(row, stash);
  return row;
}

function closePanelsExcept(stashId: string): void {
  stashDeleteArmedId = null;
  if (stashParkArmed?.stashId !== stashId) stashParkArmed = null;
  if (stashVersionsId !== stashId) stashVersionsId = null;
}

function renderStashActions(stash: SavedTabStash): HTMLElement {
  const actions = ui().element("div", "stash-item__actions");
  if (stash.activeWorkspaceId) {
    actions.append(
      ui().button("Switch to window", "secondary", () => {
        closePanelsExcept(stash.id);
        void ui().perform(`focus-stash-${stash.id}`, async () => {
          const response = await ui().send({ type: "workspace:window-focus", stashId: stash.id });
          popupState.savedStashes = await readTabStashes();
          if (!response.ok) throw new Error(response.error);
        });
      }, { actionName: `focus-stash-${stash.id}`, busyLabel: "Switching…" }),
      ui().button(
        stashParkArmed?.stashId === stash.id ? "Save & close anyway" : "Save & close",
        stashParkArmed?.stashId === stash.id ? "danger" : "quiet",
        () => {
          closePanelsExcept(stash.id);
          if (stashParkArmed?.stashId === stash.id) {
            stashParkArmed = null;
            void ui().perform(`park-stash-${stash.id}`, () => parkStash(stash, false));
            return;
          }
          void ui().perform(`park-stash-${stash.id}`, async () => {
            const diff = await ui().send({ type: "workspace:window-diff", stashId: stash.id });
            if (!diff.ok) {
              popupState.savedStashes = await readTabStashes();
              throw new Error(diff.error);
            }
            const privateTabs = diff.stashWorkspaceDiff?.privateTabs ?? 0;
            if (privateTabs > 0) {
              stashParkArmed = { stashId: stash.id, privateTabs };
              popupState.pendingFocusKey = `stash-park-${stash.id}`;
              return;
            }
            await parkStash(stash, false);
          });
        },
        { actionName: `park-stash-${stash.id}`, busyLabel: "Saving…" },
      ),
      ui().button(stashWorkspaceDiffs.has(stash.id) ? "Hide changes" : "Review changes", "quiet", () => {
        closePanelsExcept(stash.id);
        if (stashWorkspaceDiffs.has(stash.id)) {
          stashWorkspaceDiffs.delete(stash.id);
          ui().redraw();
          return;
        }
        void ui().perform(`diff-stash-${stash.id}`, async () => {
          const response = await ui().send({ type: "workspace:window-diff", stashId: stash.id });
          if (!response.ok) {
            popupState.savedStashes = await readTabStashes();
            throw new Error(response.error);
          }
          if (!response.stashWorkspaceDiff) throw new Error("The workspace diff was unavailable.");
          stashWorkspaceDiffs.set(stash.id, response.stashWorkspaceDiff);
        });
      }, { actionName: `diff-stash-${stash.id}`, busyLabel: "Comparing…" }),
    );
    actions.lastElementChild?.previousElementSibling?.setAttribute("data-focus-key", `stash-park-${stash.id}`);
  } else if (stash.status === "closing_interrupted") {
    actions.append(ui().button(
      "Recover workspace",
      "secondary",
      () => {
        closePanelsExcept(stash.id);
        void ui().perform(`recover-stash-${stash.id}`, async () => {
          const response = await ui().send({ type: "workspace:recover-interrupted", stashId: stash.id });
          if (!response.ok) throw new Error(response.error);
          popupState.savedStashes = await readTabStashes();
          popupState.notice = { tone: "success", text: "Workspace recovered. Its saved tabs can be opened again." };
        });
      },
      { actionName: `recover-stash-${stash.id}`, busyLabel: "Recovering…" },
    ));
  } else {
    const open = ui().button(
      "Open",
      "secondary",
      () => {
        closePanelsExcept(stash.id);
        const options: StashRestoreOptions = {
          destination: "new_window",
          duplicateHandling: "duplicate",
          afterRestore: "linked_workspace",
        };
        void ui().perform(`restore-stash-${stash.id}`, () => restoreStash(stash, undefined, options));
      },
      { disabled: stash.tabs.length === 0, actionName: `restore-stash-${stash.id}`, busyLabel: "Opening…" },
    );
    open.setAttribute("aria-label", `Open ${stash.name} in a new linked window`);
    actions.append(open, ui().button(
      stashRestoreEditorId === stash.id ? "Hide tab picker" : "Choose tabs…",
      "quiet",
      () => {
        closePanelsExcept(stash.id);
        if (stashRestoreEditorId === stash.id) {
          stashRestoreEditorId = null;
          selectedStashRestoreIndexes.clear();
        } else {
          stashRestoreEditorId = stash.id;
          selectedStashRestoreIndexes.clear();
          stash.tabs.forEach((tab) => selectedStashRestoreIndexes.add(tab.sourceIndex));
        }
        ui().redraw();
        if (stashRestoreEditorId === stash.id) scrollStashPanelIntoView(stash.id, ".stash-restore-picker");
      },
      { disabled: stash.tabs.length === 0 },
    ));
  }
  const icons = ui().element("div", "stash-item__icons");
  if (stash.revisions.length > 0 && !stash.activeWorkspaceId) {
    const showingVersions = stashVersionsId === stash.id;
    const versions = stashIconButton(
      showingVersions ? "Hide versions" : `Versions (${stash.revisions.length})`,
      showingVersions ? `Hide earlier versions of ${stash.name}` : `Show earlier versions of ${stash.name}`,
      "history",
      () => {
        stashDeleteArmedId = null;
        stashVersionsId = showingVersions ? null : stash.id;
        popupState.pendingFocusKey = `stash-versions-${stash.id}`;
        ui().redraw();
        if (!showingVersions) scrollStashPanelIntoView(stash.id, ".stash-versions");
      },
      { className: "stash-item-icon-button" },
    );
    versions.dataset.focusKey = `stash-versions-${stash.id}`;
    versions.setAttribute("aria-pressed", String(showingVersions));
    icons.append(versions);
  }
  const editingMetadata = stashMetadataEditorId === stash.id;
  const editDetails = stashIconButton(
    editingMetadata ? "Close edit" : "Edit details",
    editingMetadata ? `Close details editor for ${stash.name}` : `Edit details for ${stash.name}`,
    editingMetadata ? "close" : "edit",
    () => {
      stashDeleteArmedId = null;
      stashMetadataEditorId = editingMetadata ? null : stash.id;
      popupState.pendingFocusKey = `stash-edit-${stash.id}`;
      queueMicrotask(() => ui().redraw());
    },
    { className: "stash-item-icon-button" },
  );
  editDetails.dataset.focusKey = `stash-edit-${stash.id}`;
  editDetails.setAttribute("aria-pressed", String(editingMetadata));
  icons.append(editDetails);
  if (!stash.activeWorkspaceId) icons.append(renderDeleteButton(stash));
  actions.append(icons);
  return actions;
}

function renderDeleteButton(stash: SavedTabStash): HTMLButtonElement {
  const deleteArmed = stashDeleteArmedId === stash.id;
  const deleteStash = stashIconButton(
    deleteArmed ? "Confirm move to trash" : "Move to trash",
    deleteArmed ? `Confirm deletion of ${stash.name}` : `Delete ${stash.name}`,
    deleteArmed ? "confirm" : "delete",
    () => {
      if (stashDeleteArmedId !== stash.id) {
        stashDeleteArmedId = stash.id;
        popupState.pendingFocusKey = `stash-delete-${stash.id}`;
        ui().redraw();
        return;
      }
      void ui().perform(`delete-stash-${stash.id}`, async () => {
        const response = await ui().send({ type: "workspace:delete", stashId: stash.id });
        if (!response.ok) throw new Error(response.error);
        popupState.savedStashes = await readTabStashes();
        await loadStashTrash();
        stashDeleteArmedId = null;
        if (stashRestoreEditorId === stash.id) {
          stashRestoreEditorId = null;
          selectedStashRestoreIndexes.clear();
        }
        if (stashMetadataEditorId === stash.id) stashMetadataEditorId = null;
        if (stashVersionsId === stash.id) stashVersionsId = null;
        popupState.notice = {
          tone: "success",
          text: `“${stash.name}” moved to the trash. You can restore it there for ${TRASH_RETENTION_DAYS} days.`,
        };
      });
    },
    {
      actionName: deleteArmed ? `delete-stash-${stash.id}` : undefined,
      className: `stash-item-icon-button stash-item-delete-button${deleteArmed ? " stash-item-icon-button--danger" : ""}`,
    },
  );
  deleteStash.dataset.focusKey = `stash-delete-${stash.id}`;
  deleteStash.setAttribute("aria-pressed", String(deleteArmed));
  if (deleteArmed) {
    deleteStash.addEventListener("blur", () => {
      setTimeout(() => {
        if (stashDeleteArmedId !== stash.id || document.activeElement === deleteStash) return;
        stashDeleteArmedId = null;
        if (popupState.stashesOpen) ui().redraw();
      }, 0);
    });
  }
  return deleteStash;
}

async function parkStash(stash: SavedTabStash, discardChanges: boolean): Promise<void> {
  const response = await ui().send({ type: "workspace:window-close", stashId: stash.id, discardChanges });
  if (!response.ok) throw new Error(response.error);
  popupState.savedStashes = await readTabStashes();
  stashWorkspaceDiffs.delete(stash.id);
  const closed = response.stashWorkspaceParkResult?.windowClosed !== false;
  popupState.notice = {
    tone: closed ? "success" : "info",
    text: discardChanges
      ? `“${stash.name}” closed without saving its changes.`
      : closed
        ? `“${stash.name}” saved and its window closed.`
        : `“${stash.name}” saved, but its window could not be closed. It is no longer linked.`,
  };
}

function appendMetadataEditor(row: HTMLElement, stash: SavedTabStash): void {
  if (stashMetadataEditorId !== stash.id) return;
  const metadata = ui().element("div", "stash-metadata-editor");
  metadata.append(ui().element("strong", "stash-metadata-editor__heading", "Edit details"));
  const stashName = ui().input(stash.name);
  stashName.maxLength = 120;
  const stashNote = ui().element("textarea", "input");
  stashNote.value = stash.note;
  stashNote.maxLength = 2_000;
  stashNote.rows = 2;
  const metadataActions = ui().element("div", "stash-metadata-editor__actions");
  metadataActions.append(
    ui().button("Cancel", "quiet", () => {
      stashMetadataEditorId = null;
      popupState.pendingFocusKey = `stash-edit-${stash.id}`;
      ui().redraw();
    }),
    ui().button("Save", "primary", () => {
      void ui().perform(`metadata-stash-${stash.id}`, async () => {
        const response = await ui().send({
          type: "workspace:update-metadata",
          stashId: stash.id,
          name: stashName.value,
          note: stashNote.value,
        });
        if (!response.ok) throw new Error(response.error);
        popupState.savedStashes = await readTabStashes();
        stashMetadataEditorId = null;
        popupState.notice = { tone: "success", text: "Workspace details saved." };
      });
    }, { actionName: `metadata-stash-${stash.id}`, busyLabel: "Saving…" }),
  );
  metadata.append(ui().field("Name", stashName), ui().field("Note", stashNote), metadataActions);
  row.append(metadata);
}

function titleList(label: string, titles: readonly string[] | undefined, total: number): HTMLElement | null {
  if (!titles || titles.length === 0) return null;
  const section = ui().element("div", "stash-workspace-diff__titles");
  section.append(ui().element("span", undefined, label));
  const list = ui().element("ul");
  titles.forEach((title) => list.append(ui().element("li", undefined, title)));
  if (total > titles.length) list.append(ui().element("li", "stash-workspace-diff__more", `and ${total - titles.length} more`));
  section.append(list);
  return section;
}

function appendWorkspaceDiff(row: HTMLElement, stash: SavedTabStash): void {
  const workspaceDiff = stashWorkspaceDiffs.get(stash.id);
  if (!workspaceDiff || !stash.activeWorkspaceId) return;
  const diff = ui().element("div", "stash-workspace-diff");
  diff.append(
    ui().element("strong", undefined, "Changes since last save"),
    ui().element("p", undefined, workspaceDiffSummary(workspaceDiff)),
  );
  const added = titleList("Added", workspaceDiff.addedTitles, workspaceDiff.addedTabs);
  const removed = titleList("Removed", workspaceDiff.removedTitles, workspaceDiff.removedTabs);
  if (added) diff.append(added);
  if (removed) diff.append(removed);
  if ((workspaceDiff.privateTabs ?? 0) > 0) {
    diff.append(ui().element(
      "p",
      undefined,
      `${ui().formatCount(workspaceDiff.privateTabs!, "private tab")} open here ${workspaceDiff.privateTabs === 1 ? "is" : "are"} not saved: local files, local-network, and browser pages never are.`,
    ));
  }
  diff.append(ui().element("p", "stash-workspace-diff__detach-help", "Changes also save on their own when the window closes."));
  const diffActions = ui().element("div", "stash-workspace-diff__actions");
  diffActions.append(
    ui().button("Save now", "secondary", () => {
      void ui().perform(`update-stash-${stash.id}`, async () => {
        const response = await ui().send({
          type: "workspace:window-save",
          stashId: stash.id,
          putAway: false,
          expectedCaptureToken: workspaceDiff.captureToken,
        });
        if (!response.ok) throw new Error(response.error);
        popupState.savedStashes = await readTabStashes();
        stashWorkspaceDiffs.delete(stash.id);
        popupState.notice = { tone: "success", text: "Workspace saved as a new version. The window stays linked." };
      });
    }, { actionName: `update-stash-${stash.id}`, busyLabel: "Saving…" }),
    ui().button(stashDiscardArmedId === stash.id ? "Confirm discard & close" : "Discard changes & close", stashDiscardArmedId === stash.id ? "danger" : "quiet", () => {
      if (stashDiscardArmedId !== stash.id) {
        stashDiscardArmedId = stash.id;
        popupState.pendingFocusKey = `stash-discard-${stash.id}`;
        ui().redraw();
        return;
      }
      stashDiscardArmedId = null;
      void ui().perform(`discard-stash-${stash.id}`, () => parkStash(stash, true));
    }, { actionName: stashDiscardArmedId === stash.id ? `discard-stash-${stash.id}` : undefined, busyLabel: "Closing…" }),
    ui().button("Stop linking", "quiet", () => {
      void ui().perform(`detach-stash-${stash.id}`, async () => {
        const response = await ui().send({ type: "workspace:window-unlink", stashId: stash.id });
        if (!response.ok) throw new Error(response.error);
        popupState.savedStashes = await readTabStashes();
        stashWorkspaceDiffs.delete(stash.id);
        if (stashParkArmed?.stashId === stash.id) stashParkArmed = null;
        popupState.notice = { tone: "success", text: "Window unlinked. Open tabs and the saved workspace were left unchanged." };
      });
    }),
  );
  diffActions.children[1]?.setAttribute("data-focus-key", `stash-discard-${stash.id}`);
  diff.append(diffActions);
  row.append(diff);
}

function appendVersions(row: HTMLElement, stash: SavedTabStash): void {
  if (stashVersionsId !== stash.id || stash.activeWorkspaceId) return;
  const panel = ui().element("div", "stash-versions");
  panel.append(
    ui().element("strong", undefined, "Earlier versions"),
    ui().element("p", undefined, "Making a version current keeps the present contents as a version too."),
  );
  const list = ui().element("ul", "stash-versions__list");
  stash.revisions.forEach((revision, index) => {
    const item = ui().element("li", "stash-versions__item");
    const copy = ui().element("div");
    copy.append(
      ui().element("strong", undefined, new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      }).format(revision.savedAt)),
      ui().element("span", undefined, `${ui().formatCount(revision.tabs.length, "tab")} · ${ui().formatCount(revision.groups.length, "group")}`),
    );
    const actions = ui().element("div", "stash-versions__actions");
    const openCopies = ui().button("Open copies", "quiet", () => {
      void ui().perform(`open-version-${stash.id}-${index}`, async () => {
        const targetWindowId = popupState.targetWindowId;
        if (targetWindowId === null) throw new Error("No browser window is selected.");
        const response = await ui().send({
          type: "workspace:restore",
          stashId: stash.id,
          targetWindowId,
          revisionId: revision.id,
          options: { destination: "new_window", duplicateHandling: "duplicate", afterRestore: "keep" },
        });
        if (!response.ok) throw new Error(response.error);
        popupState.viewState = response.state;
        const outcome = restoreNotice(response.stashRestoreResult, "That version");
        popupState.notice = outcome.tone === "success"
          ? { tone: "success", text: `${outcome.text.replace(/\.$/, "")} in a new window. The workspace is unchanged.` }
          : outcome;
      });
    }, { actionName: `open-version-${stash.id}-${index}`, busyLabel: "Opening…" });
    openCopies.setAttribute("aria-label", `Open copies of the version from ${new Date(revision.savedAt).toLocaleString()}`);
    const makeCurrent = ui().button("Make current", "quiet", () => {
      void ui().perform(`current-version-${stash.id}-${index}`, async () => {
        const response = await ui().send({ type: "workspace:revision-restore", stashId: stash.id, revisionId: revision.id });
        if (!response.ok) throw new Error(response.error);
        popupState.savedStashes = await readTabStashes();
        popupState.notice = { tone: "success", text: "Earlier version restored. The previous contents were kept as a version." };
      });
    }, { actionName: `current-version-${stash.id}-${index}`, busyLabel: "Restoring…" });
    makeCurrent.setAttribute("aria-label", `Make the version from ${new Date(revision.savedAt).toLocaleString()} current`);
    actions.append(openCopies, makeCurrent);
    item.append(copy, actions);
    list.append(item);
  });
  panel.append(list);
  row.append(panel);
}

function renderStashTrash(): HTMLElement | null {
  if (trashedStashes.length === 0) return null;
  const disclosure = ui().element("details", "stash-trash") as HTMLDetailsElement;
  disclosure.open = stashTrashOpen;
  disclosure.addEventListener("toggle", () => { stashTrashOpen = disclosure.open; });
  const summary = ui().element("summary");
  const summaryCopy = ui().element("span");
  summaryCopy.append(
    ui().element("strong", undefined, `Trash · ${trashedStashes.length}`),
    ui().element("small", undefined, `Deleted and expired workspaces stay here for ${TRASH_RETENTION_DAYS} days`),
  );
  summary.append(summaryCopy);
  disclosure.append(summary);
  const list = ui().element("ul", "stash-trash__list");
  trashedStashes.forEach((entry) => {
    const item = ui().element("li", "stash-trash__item");
    const copy = ui().element("div");
    const remaining = daysUntil(entry.trashedAt + TRASH_RETENTION_DAYS * 24 * 60 * 60_000);
    copy.append(
      ui().element("strong", undefined, entry.stash.name),
      ui().element(
        "span",
        undefined,
        `${ui().formatCount(entry.stash.tabs.length, "tab")} · ${entry.reason === "expired" ? "Expired" : "Deleted"} ${relativeAge(entry.trashedAt)} · ${remaining === 0 ? "Removed today" : `Removed in ${ui().formatCount(remaining, "day")}`}`,
      ),
    );
    const actions = ui().element("div", "stash-trash__actions");
    const restore = ui().button("Restore", "quiet", () => {
      stashPurgeArmedId = null;
      void ui().perform(`untrash-stash-${entry.stash.id}`, async () => {
        const response = await ui().send({ type: "workspace:trash-restore", stashId: entry.stash.id });
        if (!response.ok) throw new Error(response.error);
        popupState.savedStashes = await readTabStashes();
        await loadStashTrash();
        popupState.notice = { tone: "success", text: `“${entry.stash.name}” restored from the trash.` };
      });
    }, { actionName: `untrash-stash-${entry.stash.id}`, busyLabel: "Restoring…" });
    restore.setAttribute("aria-label", `Restore ${entry.stash.name} from the trash`);
    const armed = stashPurgeArmedId === entry.stash.id;
    const purge = ui().button(armed ? "Confirm delete forever" : "Delete forever", armed ? "danger" : "quiet", () => {
      if (!armed) {
        stashPurgeArmedId = entry.stash.id;
        popupState.pendingFocusKey = `stash-purge-${entry.stash.id}`;
        ui().redraw();
        return;
      }
      void ui().perform(`purge-stash-${entry.stash.id}`, async () => {
        const response = await ui().send({ type: "workspace:trash-purge", stashId: entry.stash.id });
        if (!response.ok) throw new Error(response.error);
        stashPurgeArmedId = null;
        await loadStashTrash();
        popupState.notice = { tone: "success", text: `“${entry.stash.name}” deleted permanently.` };
      });
    }, { actionName: armed ? `purge-stash-${entry.stash.id}` : undefined, busyLabel: "Deleting…" });
    purge.dataset.focusKey = `stash-purge-${entry.stash.id}`;
    purge.setAttribute("aria-label", armed ? `Confirm permanent deletion of ${entry.stash.name}` : `Delete ${entry.stash.name} forever`);
    actions.append(restore, purge);
    item.append(copy, actions);
    list.append(item);
  });
  disclosure.append(list);
  return disclosure;
}

function appendRestorePicker(row: HTMLElement, stash: SavedTabStash): void {
  if (stashRestoreEditorId !== stash.id) return;
  const chooser = ui().element("div", "stash-restore-picker");
  const chooserHeading = ui().element("div", "stash-restore-picker__heading");
  chooserHeading.append(
    ui().element("strong", undefined, "Open selected tabs"),
    ui().element("span", undefined, `${selectedStashRestoreIndexes.size} of ${stash.tabs.length} selected`),
  );
  chooser.append(chooserHeading);

  const options = restoreOptionsFor(stash);
  options.afterRestore = "keep";
  stashRestoreOptions.set(stash.id, options);
  const optionsDisclosure = ui().element("details", "stash-open-options");
  const optionsSummary = ui().element("summary");
  const restoreControls = ui().element("div", "stash-restore-options");
  const destination = ui().element("select", "input");
  ([['current_window', 'Current window'], ['new_window', 'New window']] as const).forEach(([value, label]) => {
    const option = ui().element("option", undefined, label);
    option.value = value;
    option.selected = options.destination === value;
    destination.append(option);
  });
  const duplicateHandling = ui().element("select", "input");
  ([['reuse', 'Reuse already-open tabs'], ['skip', 'Skip already-open tabs'], ['duplicate', 'Open another copy']] as const).forEach(([value, label]) => {
    const option = ui().element("option", undefined, label);
    option.value = value;
    option.selected = options.duplicateHandling === value;
    duplicateHandling.append(option);
  });
  const saveRestoreOptions = (): void => {
    stashRestoreOptions.set(stash.id, {
      destination: destination.value as StashRestoreOptions["destination"],
      duplicateHandling: duplicateHandling.value as StashRestoreOptions["duplicateHandling"],
      afterRestore: "keep",
    });
    const destinationLabel = destination.value === "new_window" ? "New window" : "Current window";
    const duplicateLabel = duplicateHandling.value === "reuse"
      ? "reuse open tabs"
      : duplicateHandling.value === "skip"
        ? "skip open tabs"
        : "open copies";
    optionsSummary.textContent = `Options · ${destinationLabel} · ${duplicateLabel}`;
  };
  destination.addEventListener("change", saveRestoreOptions);
  duplicateHandling.addEventListener("change", saveRestoreOptions);
  saveRestoreOptions();
  restoreControls.append(
    ui().field("Destination", destination),
    ui().field("Duplicates", duplicateHandling),
  );
  optionsDisclosure.append(optionsSummary, restoreControls);
  chooser.append(optionsDisclosure);

  const selectionActions = ui().element("div", "stash-selection-actions");
  selectionActions.append(
    ui().button(selectedStashRestoreIndexes.size === stash.tabs.length ? "Clear selection" : "Select all", "quiet", () => {
      if (selectedStashRestoreIndexes.size === stash.tabs.length) {
        selectedStashRestoreIndexes.clear();
      } else {
        stash.tabs.forEach((tab) => selectedStashRestoreIndexes.add(tab.sourceIndex));
      }
      ui().redraw();
    }),
  );
  chooser.append(selectionActions);

  const appendTabChoice = (parent: HTMLElement, tab: SavedTabStash["tabs"][number]): void => {
    const tabIdentity = tab.stableKey ?? `source:${tab.sourceIndex}`;
    const revealed = stashRevealMatches(stash.id, tabIdentity);
    const row = ui().element("div", `stash-restore-row stash-restore-row--tab${revealed ? " stash-restore-row--revealed" : ""}`);
    row.dataset.stashTabId = tabIdentity;
    row.tabIndex = -1;
    const choice = ui().element("label", "stash-restore-choice stash-restore-choice--tab");
    const control = ui().element("input");
    control.type = "checkbox";
    control.checked = selectedStashRestoreIndexes.has(tab.sourceIndex);
    control.dataset.focusKey = `stash-pick-${stash.id}-${tab.sourceIndex}`;
    control.addEventListener("change", () => {
      if (control.checked) selectedStashRestoreIndexes.add(tab.sourceIndex);
      else selectedStashRestoreIndexes.delete(tab.sourceIndex);
      ui().redraw();
    });
    choice.append(control, ui().element("span", undefined, tab.title));
    const tabActions = ui().element("div", "stash-tab-actions");
    tabActions.append(ui().button(
      "Open",
      "quiet",
      () => {
        void ui().perform(`open-stash-${stash.id}-${tab.sourceIndex}`, () => openStashTab(stash, tab.sourceIndex, true));
      },
      {
        actionName: `open-stash-${stash.id}-${tab.sourceIndex}`,
        busyLabel: "Opening…",
      },
    ));
    tabActions.append(
      stashIconButton("Open in background", `Open ${tab.title} in background`, "background", () => {
        void ui().perform(`open-background-${stash.id}-${tab.sourceIndex}`, () => openStashTab(stash, tab.sourceIndex, false));
      }, {
        actionName: `open-background-${stash.id}-${tab.sourceIndex}`,
        className: "stash-tab-icon-button",
      }),
      stashIconButton("Copy URL", `Copy URL for ${tab.title}`, "copy", () => {
        void navigator.clipboard.writeText(tab.url).then(() => {
          popupState.notice = { tone: "success", text: "URL copied. The workspace is unchanged." };
          ui().render();
        }).catch(() => {
          popupState.notice = { tone: "error", text: "The URL could not be copied." };
          ui().render();
        });
      }, { className: "stash-tab-icon-button" }),
    );
    row.append(choice, tabActions);
    parent.append(row);
  };

  const groupedIndexes = new Set<number>();
  [...stash.groups]
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .forEach((group) => {
      const tabs = stash.tabs
        .filter((tab) => tab.groupKey === group.key)
        .sort((left, right) => left.sourceIndex - right.sourceIndex);
      if (tabs.length === 0) return;
      tabs.forEach((tab) => groupedIndexes.add(tab.sourceIndex));
      const section = ui().element("div", "stash-restore-group");
      const groupChoice = ui().element("label", "stash-restore-choice stash-restore-choice--group");
      const control = ui().element("input");
      control.type = "checkbox";
      const selectedCount = tabs.filter((tab) => selectedStashRestoreIndexes.has(tab.sourceIndex)).length;
      control.checked = selectedCount === tabs.length;
      control.indeterminate = selectedCount > 0 && selectedCount < tabs.length;
      control.dataset.focusKey = `stash-pick-group-${stash.id}-${group.sourceIndex}`;
      control.addEventListener("change", () => {
        tabs.forEach((tab) => {
          if (control.checked) selectedStashRestoreIndexes.add(tab.sourceIndex);
          else selectedStashRestoreIndexes.delete(tab.sourceIndex);
        });
        ui().redraw();
      });
      groupChoice.append(
        control,
        ui().element("strong", undefined, group.title.trim() || "Untitled group"),
        ui().element("span", undefined, ui().formatCount(tabs.length, "tab")),
      );
      const groupRow = ui().element("div", "stash-restore-row stash-restore-row--group");
      const openGroup = ui().button(
        "Open group",
        "quiet",
        () => {
          const sourceIndexes = tabs.map((tab) => tab.sourceIndex);
          void ui().perform(`restore-group-${stash.id}-${group.sourceIndex}`, () => restoreStash(stash, sourceIndexes));
        },
        {
          actionName: `restore-group-${stash.id}-${group.sourceIndex}`,
          busyLabel: "Opening…",
        },
      );
      openGroup.setAttribute("aria-label", `Open ${group.title.trim() || "untitled"} group (${ui().formatCount(tabs.length, "tab")})`);
      groupRow.append(groupChoice, openGroup);
      section.append(groupRow);
      tabs.forEach((tab) => appendTabChoice(section, tab));
      chooser.append(section);
    });

  const ungrouped = stash.tabs
    .filter((tab) => !groupedIndexes.has(tab.sourceIndex))
    .sort((left, right) => left.sourceIndex - right.sourceIndex);
  if (ungrouped.length > 0) {
    const section = ui().element("div", "stash-restore-group");
    const ungroupedChoice = ui().element("label", "stash-restore-choice stash-restore-choice--group");
    const control = ui().element("input");
    control.type = "checkbox";
    const selectedCount = ungrouped.filter((tab) => selectedStashRestoreIndexes.has(tab.sourceIndex)).length;
    control.checked = selectedCount === ungrouped.length;
    control.indeterminate = selectedCount > 0 && selectedCount < ungrouped.length;
    control.dataset.focusKey = `stash-pick-ungrouped-${stash.id}`;
    control.addEventListener("change", () => {
      ungrouped.forEach((tab) => {
        if (control.checked) selectedStashRestoreIndexes.add(tab.sourceIndex);
        else selectedStashRestoreIndexes.delete(tab.sourceIndex);
      });
      ui().redraw();
    });
    ungroupedChoice.append(
      control,
      ui().element("strong", undefined, "Ungrouped"),
      ui().element("span", undefined, ui().formatCount(ungrouped.length, "tab")),
    );
    const ungroupedRow = ui().element("div", "stash-restore-row stash-restore-row--group");
    const openUngrouped = ui().button(
      "Open all",
      "quiet",
      () => {
        const sourceIndexes = ungrouped.map((tab) => tab.sourceIndex);
        void ui().perform(`restore-ungrouped-${stash.id}`, () => restoreStash(stash, sourceIndexes));
      },
      {
        actionName: `restore-ungrouped-${stash.id}`,
        busyLabel: "Opening…",
      },
    );
    openUngrouped.setAttribute("aria-label", `Open all ungrouped tabs (${ungrouped.length})`);
    ungroupedRow.append(ungroupedChoice, openUngrouped);
    section.append(ungroupedRow);
    ungrouped.forEach((tab) => appendTabChoice(section, tab));
    chooser.append(section);
  }
  const pickerActions = ui().element("div", "stash-restore-picker__actions");
  pickerActions.append(
    ui().button(
      `Open ${selectedStashRestoreIndexes.size} tab${selectedStashRestoreIndexes.size === 1 ? "" : "s"}`,
      "primary",
      () => {
        const sourceIndexes = [...selectedStashRestoreIndexes].sort((left, right) => left - right);
        void ui().perform(`restore-stash-${stash.id}`, () => restoreStash(stash, sourceIndexes));
      },
      {
        disabled: selectedStashRestoreIndexes.size === 0,
        actionName: `restore-stash-${stash.id}`,
        busyLabel: "Restoring…",
      },
    ),
    ui().button("Close", "quiet", () => {
      stashRestoreEditorId = null;
      selectedStashRestoreIndexes.clear();
      ui().redraw();
    }),
  );
  chooser.append(pickerActions);
  row.append(chooser);
}
