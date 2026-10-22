import { probeDecisionModel } from "../../decision/connection-probe";
import { NONE_OPTION, REORGANIZE_QUESTION, STAY_OPTION } from "../../decision/filing-state";
import {
  DEFAULT_DECISION_ENDPOINT_PATH,
  type DecisionAnswer,
  type DecisionProtocol,
  type DecisionQuestion,
} from "../../decision/types";
import { normalizeProviderEndpoint, providerRoute } from "../../provider/request-policy";
import type {
  AutoFilingSettings,
  AutoFilingViewState,
  DecisionCalibration,
  DecisionModelConfig,
  EscalationMode,
  FilingLogEntry,
  LastDecisionRequest,
} from "../../shared/auto-filing-types";
import type { ConfidencePreset } from "../../decision/filing-policy";
import {
  AUTO_FILING_LOCAL_KEY,
  AUTO_FILING_SESSION_KEYS,
  calibrationFor,
  DEFAULT_CHAT_DECISION_ENDPOINT_PATH,
  defaultDecisionModelConfig,
  mergeCalibrations,
  parseCalibrationImport,
  readDecisionConnection,
  writeAutoFilingSettings,
  writeDecisionModel,
  writeDecisionProbe,
} from "../../storage/auto-filing";
import { readOrganizerState } from "../../storage/organizer-state";
import { element, relativeAge, send } from "../shared/helpers";
import { popupState } from "./popup-store";
import { providerLinkRow, renderProviderConnection, resolveApiKey, type ConnectionStatus } from "./provider-connection-ui";
import { trackSettingsSave } from "./settings-save-status";

/**
 * The popup's auto-filing surfaces (docs/auto-filing-plan.md): the settings
 * section with the decision model provider, the Auto-filed history tab with
 * Undo, the escalation prompt, and the per-group opt-out in the Groups view.
 * The service worker owns filing and undo; this module only shows its state
 * and saves settings.
 */

export interface AutoFilingPanelContext {
  input(value: string, type?: HTMLInputElement["type"]): HTMLInputElement;
  field(label: string, control: HTMLElement, help?: string): HTMLElement;
  check(label: string, copy: string, checked: boolean): { wrapper: HTMLLabelElement; control: HTMLInputElement };
  button(
    label: string,
    variant: "primary" | "secondary" | "quiet" | "danger",
    onClick: () => void,
    options?: { disabled?: boolean; actionName?: string; busyLabel?: string },
  ): HTMLButtonElement;
  settingsSummary(text: string): HTMLElement;
  settingsEditChip(): HTMLElement;
  advancedDisclosure(key: string, contents: string, children: readonly Node[], badge?: HTMLElement): HTMLDetailsElement;
  lineIcon(paths: string[]): SVGSVGElement;
  perform(actionName: string, action: () => Promise<void>): Promise<void>;
  render(): void;
  /** Starts a normal organize of the ungrouped tabs, as if the user had picked that scope. */
  organizeUngrouped(): void;
}

let context: AutoFilingPanelContext | null = null;
let view: AutoFilingViewState | null = null;
/** Session-only header values, shown in the form so saving doesn't drop them. */
let sessionHeaders: Record<string, string> = {};

export function setAutoFilingPanelContext(next: AutoFilingPanelContext): void {
  context = next;
}

function ui(): AutoFilingPanelContext {
  if (!context) throw new Error("Auto-filing UI is not initialized.");
  return context;
}

export function autoFilingView(): AutoFilingViewState | null {
  return view;
}

export async function loadAutoFilingView(): Promise<AutoFilingViewState | null> {
  const [response, session] = await Promise.all([
    send({ type: "auto-filing:get-state" }),
    chrome.storage.session.get(AUTO_FILING_SESSION_KEYS.customHeaders),
  ]);
  if (response.ok && response.autoFilingView) view = response.autoFilingView;
  const headers = session[AUTO_FILING_SESSION_KEYS.customHeaders];
  sessionHeaders = headers && typeof headers === "object" ? headers as Record<string, string> : {};
  return view;
}

/** True when a storage change touches what this module shows. */
export function autoFilingStorageChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string): boolean {
  if (areaName === "local") return Boolean(changes[AUTO_FILING_LOCAL_KEY]);
  return areaName === "session" && Boolean(
    changes[AUTO_FILING_SESSION_KEYS.log] || changes[AUTO_FILING_SESSION_KEYS.suggestion],
  );
}

async function saveSettings(update: (settings: AutoFilingSettings) => AutoFilingSettings): Promise<void> {
  const current = view?.settings ?? (await loadAutoFilingView())?.settings;
  if (!current) throw new Error("Auto-filing settings could not be loaded.");
  const settings = await writeAutoFilingSettings(update(current));
  view = view ? { ...view, settings } : await loadAutoFilingView();
}

/** The Organize view's quick switch; the rest of the settings stay as saved. */
export async function setAutoFilingEnabled(enabled: boolean): Promise<void> {
  await saveSettings((current) => ({ ...current, enabled }));
}

function filingDescription(entry: FilingLogEntry): string {
  if (entry.toGroupId === null) return `Left ${entry.fromGroupTitle || "its group"}`;
  const into = `Filed into ${entry.toGroupTitle || "an untitled group"}`;
  const from = entry.fromGroupId === null ? "" : ` from ${entry.fromGroupTitle || "another group"}`;
  return `${into}${from}${entry.previousWindowId === undefined ? "" : " · other window"}`;
}

// --- Escalation prompt (Organize view) -----------------------------------------

export function renderAutoFilingSuggestion(): HTMLElement | null {
  const suggestion = view?.suggestion;
  if (!suggestion || suggestion.windowId !== popupState.targetWindowId) return null;
  const box = element("div", "filing-suggestion");
  box.setAttribute("role", "status");
  box.append(element(
    "p",
    undefined,
    `${suggestion.ungroupedCount} ungrouped tab${suggestion.ungroupedCount === 1 ? "" : "s"} don't fit your groups. Organize them?`,
  ));
  const actions = element("div", "filing-suggestion__actions");
  actions.append(
    ui().button("Organize ungrouped tabs", "secondary", () => {
      void send({ type: "auto-filing:dismiss-suggestion" }).then((response) => {
        if (response.ok && response.autoFilingView) view = response.autoFilingView;
        ui().organizeUngrouped();
      });
    }, { actionName: "filing-suggestion-accept" }),
    ui().button("Not now", "quiet", () => {
      void ui().perform("filing-suggestion-dismiss", async () => {
        const response = await send({ type: "auto-filing:dismiss-suggestion" });
        if (!response.ok) throw new Error(response.error);
        view = response.autoFilingView ?? view;
      });
    }, { actionName: "filing-suggestion-dismiss" }),
  );
  box.append(actions);
  return box;
}

// --- Auto-filed (History view, its own tab) ----------------------------------------

export function renderRecentlyFiled(): HTMLElement | null {
  if (!view || (!view.settings.enabled && view.log.length === 0)) return null;
  const section = element("section", "filing-log");
  if (view.log.length === 0) {
    section.append(element("p", "history-empty", "Auto-filing hasn't moved any tabs yet."));
    return section;
  }
  const list = element("ol", "filing-log__list");
  view.log.forEach((entry) => {
    const row = element("li", "filing-log__row");
    const copy = element("div", "filing-log__copy");
    const title = element("strong", undefined, entry.tabTitle || entry.site || "Untitled tab");
    title.title = entry.tabTitle;
    copy.append(
      title,
      element(
        "span",
        "filing-log__meta",
        `${filingDescription(entry)} · ${entry.source === "rule" ? "rule" : `${Math.round(entry.confidence * 100)}%`} · ${relativeAge(entry.at)}`,
      ),
    );
    const actions = element("div", "filing-log__actions");
    const undo = ui().button("Undo", "secondary", () => {
      void ui().perform(`filing-undo-${entry.id}`, async () => {
        const response = await send({ type: "auto-filing:undo", entryId: entry.id });
        if (!response.ok) throw new Error(response.error);
        view = response.autoFilingView ?? view;
        popupState.notice = { tone: "info", text: response.autoFilingMessage ?? "Filing undone." };
      });
    }, { actionName: `filing-undo-${entry.id}`, busyLabel: "Undoing…" });
    undo.setAttribute("aria-label", `Undo filing of ${entry.tabTitle || entry.site}`);
    actions.append(undo);
    if (entry.site && entry.toGroupId !== null) {
      const never = ui().button("Don't file this site here", "quiet", () => {
        void ui().perform(`filing-never-${entry.id}`, async () => {
          const response = await send({ type: "auto-filing:never-file", entryId: entry.id });
          if (!response.ok) throw new Error(response.error);
          view = response.autoFilingView ?? view;
          popupState.notice = { tone: "success", text: response.autoFilingMessage ?? "Rule saved." };
        });
      }, { actionName: `filing-never-${entry.id}`, busyLabel: "Saving…" });
      never.setAttribute("aria-label", `Don't auto-file ${entry.site} into ${entry.toGroupTitle || "this group"}`);
      actions.append(never);
    }
    row.append(copy, actions);
    list.append(row);
  });
  section.append(list);
  return section;
}

// --- Group opt-out (Groups view) --------------------------------------------------

/** The opt-out switch for one group, or null while auto-filing is off. Matched by title, like protection rules. */
export function renderGroupFilingOptOut(groupTitle: string): HTMLElement | null {
  const settings = view?.settings;
  const title = groupTitle.trim();
  if (!settings?.enabled || !title) return null;
  const optedOut = settings.optedOutGroupTitles.some((item) => item.toLocaleLowerCase() === title.toLocaleLowerCase());
  const toggle = ui().check(
    "Don't auto-file into this group",
    "Its tabs also stay put. Applies to every group with this title.",
    optedOut,
  );
  toggle.wrapper.classList.add("group-manager__filing-opt-out");
  toggle.control.dataset.focusKey = "group-filing-opt-out";
  toggle.control.addEventListener("change", () => {
    const next = toggle.control.checked;
    void ui().perform("group-filing-opt-out", () => saveSettings((current) => ({
      ...current,
      optedOutGroupTitles: next
        ? [...current.optedOutGroupTitles, title]
        : current.optedOutGroupTitles.filter((item) => item.toLocaleLowerCase() !== title.toLocaleLowerCase()),
    })));
  });
  return toggle.wrapper;
}

// --- Settings → Auto-filing ----------------------------------------------------------

const PRESET_LABELS: Record<ConfidencePreset, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  eager: "Eager",
};

const ESCALATION_LABELS: Record<EscalationMode, string> = {
  off: "Do nothing",
  suggest: "Suggest organizing",
  organize: "Organize automatically",
};

/** Always placed in a field(), whose label names it. */
function select<Value extends string>(
  options: ReadonlyArray<readonly [Value, string]>,
  selected: Value,
): HTMLSelectElement {
  const node = element("select", "input");
  options.forEach(([value, text]) => {
    const option = element("option", undefined, text);
    option.value = value;
    option.selected = value === selected;
    node.append(option);
  });
  return node;
}

function probeStatus(state: AutoFilingViewState): { text: string; ready: boolean } {
  const config = state.settings.decisionModel;
  if (!config) return { text: "Not set up. Without it, only your filing rules apply.", ready: false };
  const probe = state.probe;
  if (!probe || probe.model !== config.model || probe.protocol !== config.protocol) {
    return { text: "Saved · not verified", ready: false };
  }
  if (probe.probabilities === "confidence") {
    return {
      text: `Connection works · ${probe.latencyMs} ms · This model doesn't return probabilities. Filing will be more cautious.`,
      ready: true,
    };
  }
  return {
    text: `Connection verified · ${probe.probabilities === "native" ? "probabilities" : "probabilities from logprobs"} · ${probe.latencyMs} ms`,
    ready: true,
  };
}

function calibrationSummary(calibration: DecisionCalibration): string {
  const { apply, margin, applyGrouped } = calibration.thresholds;
  return `apply ${apply.toFixed(2)} · margin ${margin.toFixed(2)} · grouped ${applyGrouped.toFixed(2)} · ${calibration.style} requests`;
}

export function renderAutoFilingSettings(category: HTMLElement): void {
  if (!view) {
    category.append(element("p", "settings-group__copy", "Auto-filing settings are loading."));
    return;
  }
  const state = view;
  const settings = state.settings;

  const behavior = element("section", "settings-group");
  const enabled = ui().check(
    "Auto-file new tabs into existing groups",
    "A new tab joins a group only when the filing model is confident. Every filing can be undone.",
    settings.enabled,
  );
  const refile = ui().check(
    "Also re-file grouped tabs that move to another site",
    "They may move to another group or leave theirs. Riskier, so off by default.",
    settings.refileGroupedTabs,
  );
  const crossWindow = ui().check(
    "Allow filing into groups in other windows",
    "The tab you're on moves only after you leave it.",
    settings.crossWindow,
  );
  const notify = ui().check(
    "Notify on each filing",
    "With an Undo button. History → Auto-filed has Undo too.",
    settings.notifyOnFiling,
  );
  const confidence = select(
    (Object.keys(PRESET_LABELS) as ConfidencePreset[]).map((key) => [key, PRESET_LABELS[key]] as const),
    settings.confidence,
  );
  const escalation = select(
    (Object.keys(ESCALATION_LABELS) as EscalationMode[]).map((key) => [key, ESCALATION_LABELS[key]] as const),
    settings.escalation,
  );
  const wholeWindow = ui().check(
    "Organize the whole window",
    "Instead of only the ungrouped tabs. Review still follows your Organize setting.",
    settings.escalationWholeWindow,
  );
  // Like semantic search, the options appear once filing is on.
  const options = element("div", "filing-options");
  const syncEnabled = (): void => {
    options.hidden = !enabled.control.checked;
    wholeWindow.wrapper.hidden = escalation.value !== "organize";
  };
  const persist = (): void => {
    syncEnabled();
    void ui().perform("auto-filing-settings", () => trackSettingsSave(() => saveSettings((current) => ({
      ...current,
      enabled: enabled.control.checked,
      refileGroupedTabs: refile.control.checked,
      crossWindow: crossWindow.control.checked,
      notifyOnFiling: notify.control.checked,
      confidence: confidence.value as ConfidencePreset,
      escalation: escalation.value as EscalationMode,
      escalationWholeWindow: wholeWindow.control.checked,
    }))));
  };
  [enabled.control, refile.control, crossWindow.control, notify.control, wholeWindow.control, confidence, escalation]
    .forEach((control) => control.addEventListener("change", persist));
  const connection = state.settings.decisionModel;
  const calibration = connection ? calibrationFor(settings, connection) : null;
  options.append(
    refile.wrapper,
    crossWindow.wrapper,
    ui().field(
      "Confidence",
      confidence,
      connection && !calibration
        ? "This model has no calibration yet, so filing uses Conservative whatever you choose."
        : "Conservative files fewer tabs and makes fewer mistakes.",
    ),
    ui().field("When tabs don't fit any group", escalation, "Organizing uses your organizing model and keeps its Undo."),
    wholeWindow.wrapper,
    notify.wrapper,
  );
  syncEnabled();
  behavior.append(
    element("h3", undefined, "Filing"),
    element(
      "p",
      "settings-group__copy",
      "Never creates, renames, or closes a group. Protected, shared, and opted-out groups are left alone.",
    ),
    enabled.wrapper,
    options,
  );
  // The connection itself lives in Providers with the others.
  const decisionStatus = decisionModelStatus()!;
  const decisionLink = element("div", "settings-tool-links");
  decisionLink.append(providerLinkRow(ui().lineIcon, {
    id: "decision",
    title: "Filing model",
    status: decisionStatus.state,
    detail: connection
      ? `${connection.model} · ${connection.useOrganizerConnection ? "organizing model's connection" : connection.origin}`
      : "Optional · without one, only your filing rules apply",
  }));
  behavior.append(decisionLink);
  category.append(
    behavior,
    ui().advancedDisclosure("auto-filing", "Calibration and the last filing request", [
      renderCalibrationSettings(state),
      renderLastRequest(state),
    ]),
  );
}

/** The decision model's connection state, or null until auto-filing has loaded. */
export function decisionModelStatus(): ConnectionStatus | null {
  if (!view) return null;
  const status = probeStatus(view);
  if (status.ready) return { state: "ready", text: status.text };
  return { state: view.settings.decisionModel ? "unverified" : "unset", text: status.text };
}

/** The decision model's connection form, for Settings → Providers. */
export function renderDecisionModelProvider(): HTMLElement | null {
  if (!view) return null;
  const state = view;
  const saved = state.settings.decisionModel;
  const config: DecisionModelConfig = saved ?? defaultDecisionModelConfig();
  const status = decisionModelStatus()!;

  const protocol = select<"none" | DecisionProtocol>([
    ["none", "None"],
    ["decision_api", "Decision API"],
    ["chat", "Chat completions"],
  ], saved ? saved.protocol : "none");
  const protocolField = ui().field("Protocol", protocol, "None removes the filing model; only your filing rules apply.");
  const reuse = ui().check(
    "Use the organizing model's connection",
    "Reuses its URL, key, and headers. Pick a model name below; it can be a smaller, faster one.",
    config.useOrganizerConnection,
  );
  const disableReasoning = ui().check(
    "Turn off reasoning",
    "Chat only. Sends the same reasoning-off body as the organizer, for thinking models that otherwise answer with a reasoning token.",
    config.disableReasoning,
  );
  const ownsConnection = saved !== null && !saved.useOrganizerConnection;
  const defaultPath = (): string => protocol.value === "chat"
    ? DEFAULT_CHAT_DECISION_ENDPOINT_PATH
    : DEFAULT_DECISION_ENDPOINT_PATH;
  const form = renderProviderConnection(ui(), {
    id: "decision",
    title: "Filing model",
    purpose: "Scores how well each new tab fits your groups, for auto-filing. Any OpenAI-compatible chat model works, or a server that speaks the decision API. It gets the same sanitized details as Organize.",
    summary: saved
      ? `${saved.model} · ${saved.useOrganizerConnection ? "organizing model's connection" : saved.origin}`
      : "Optional · only auto-filing uses it",
    status,
    open: state.settings.enabled && status.state !== "ready",
    origin: ownsConnection ? config.origin : "",
    endpointPath: config.endpointPath,
    urlPlaceholder: "https://api.openai.com/v1 or http://localhost:8080/v1",
    defaultPath,
    model: config.model,
    modelPlaceholder: "The model name the server expects",
    modelHelp: "Free text: whatever the server expects.",
    key: {
      saved: ownsConnection && state.hasApiKey,
      persistent: config.apiKeyStorage === "persistent",
      optional: true,
    },
    leading: [protocolField, reuse.wrapper],
    advanced: {
      customHeaders: sessionHeaders,
      extraBody: config.extraBody,
      timeoutMs: { value: config.timeoutMs, default: 10_000, max: 60_000 },
      customized: config.disableReasoning,
      extras: [disableReasoning.wrapper],
    },
    saveCopy: "Chrome may ask for access to this site, then Sheaf sends one test question about made-up tabs.",
    forgetKey: saved && ownsConnection ? async () => {
      await writeDecisionModel({ config: saved, apiKey: "" });
      await loadAutoFilingView();
      popupState.notice = { tone: "info", text: "Filing model API key forgotten. Save and verify a key to use it again." };
    } : undefined,
    save: async (values) => {
      if (protocol.value === "none") {
        await writeDecisionModel({ config: null, apiKey: "" });
        await loadAutoFilingView();
        popupState.notice = { tone: "success", text: "Filing model removed. Only your filing rules apply." };
        return;
      }
      const kind = protocol.value as DecisionProtocol;
      const next: DecisionModelConfig = {
        protocol: kind,
        // Reusing the organizing model's connection hides the URL; keep the stored one.
        origin: values.origin || config.origin,
        endpointPath: values.endpointPath || defaultPath(),
        model: values.model,
        customHeaders: values.customHeaders,
        extraBody: values.extraBody,
        useOrganizerConnection: kind === "chat" && reuse.control.checked,
        apiKeyStorage: values.persistKey ? "persistent" : "session",
        disableReasoning: kind === "chat" && disableReasoning.control.checked,
        timeoutMs: values.timeoutMs ?? 10_000,
      };
      let apiKey = "";
      if (!next.useOrganizerConnection) {
        const target = normalizeProviderEndpoint(next.origin, next.endpointPath);
        // Asked from this click, so Chrome can show its prompt; an origin already granted is not asked again.
        const granted = await chrome.permissions.request({ origins: [target.permissionPattern] });
        if (!granted) throw new Error("Chrome didn't grant access to the filing model's site.");
        const savedKey = !values.typedApiKey && saved && ownsConnection
          ? (await readDecisionConnection(await readOrganizerState()))?.apiKey ?? ""
          : "";
        apiKey = resolveApiKey(values.typedApiKey, saved ? { origin: saved.origin, apiKey: savedKey } : null, target.origin);
      }
      await writeDecisionModel({ config: next, apiKey });
      await loadAutoFilingView();
      const connection = await readDecisionConnection(await readOrganizerState());
      if (!connection) throw new Error("The filing model could not be read back after saving.");
      try {
        const probe = await probeDecisionModel(connection);
        await writeDecisionProbe(probe);
        await loadAutoFilingView();
        popupState.notice = probe.probabilities === "confidence"
          ? { tone: "info", text: "Filing model saved and verified. It doesn't return probabilities, so filing will be more cautious." }
          : { tone: "success", text: `Filing model saved and verified in ${probe.latencyMs} ms.` };
      } catch (error) {
        throw new Error(`Filing model saved, but the check failed. ${error instanceof Error ? error.message : ""}`.trim());
      }
    },
  });

  const sync = (): void => {
    const kind = protocol.value;
    const none = kind === "none";
    reuse.wrapper.hidden = kind !== "chat";
    const ownConnection = !none && !(kind === "chat" && reuse.control.checked);
    form.connectionFields.forEach((node) => { node.hidden = !ownConnection; });
    form.modelField.hidden = none;
    form.advanced.hidden = none;
    disableReasoning.wrapper.hidden = kind !== "chat";
  };
  protocol.addEventListener("change", () => {
    // Each protocol has its own usual route. Switching replaces the other
    // protocol's route, in the route field or at the end of a pasted URL;
    // a route the user chose is kept.
    if (protocol.value !== "none") {
      const next = providerRoute(defaultPath());
      const other = [DEFAULT_DECISION_ENDPOINT_PATH, DEFAULT_CHAT_DECISION_ENDPOINT_PATH]
        .map(providerRoute)
        .find((candidate) => candidate !== next);
      if (other && form.route.value.trim() === other) form.route.value = next;
      const current = form.url.value.trim().replace(/\/+$/, "");
      if (other && current.endsWith(other)) form.url.value = current.slice(0, -other.length);
    }
    form.refreshUrl();
    sync();
    form.markDirty();
  });
  reuse.control.addEventListener("change", () => {
    sync();
    form.markDirty();
  });
  disableReasoning.control.addEventListener("change", form.markDirty);
  sync();
  return form.node;
}

function renderCalibrationSettings(state: AutoFilingViewState): HTMLElement {
  const group = element("section", "settings-group filing-calibrations");
  group.append(
    element("h3", undefined, "Calibration"),
    element(
      "p",
      "settings-group__copy",
      "Sets the Balanced bar for a model. Generate the file with npm run benchmark -- --mode filing --calibrations <file>. A model without one uses Conservative.",
    ),
  );
  const config = state.settings.decisionModel;
  if (state.settings.calibrations.length === 0) {
    group.append(element("p", "rules-empty", "No calibrations imported."));
  } else {
    const list = element("ul", "filing-calibrations__list");
    state.settings.calibrations.forEach((calibration, index) => {
      const row = element("li", "filing-calibrations__row");
      const active = config !== null && calibrationFor({ ...state.settings, calibrations: [calibration] }, config) !== null;
      const copy = element("span");
      copy.append(
        element("strong", undefined, `${calibration.model}${active ? " · in use" : ""}`),
        element("small", undefined, `${calibration.protocol === "chat" ? "Chat" : "Decision API"} · ${calibrationSummary(calibration)}`),
      );
      const remove = ui().button("Remove", "quiet", () => {
        void ui().perform(`calibration-remove-${index}`, () => saveSettings((current) => ({
          ...current,
          calibrations: current.calibrations.filter((_, position) => position !== index),
        })));
      }, { actionName: `calibration-remove-${index}` });
      remove.setAttribute("aria-label", `Remove calibration for ${calibration.model}`);
      row.append(copy, remove);
      list.append(row);
    });
    group.append(list);
  }
  const file = element("input", "backup-file-input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.setAttribute("aria-label", "Calibration file to import");
  file.addEventListener("change", () => {
    const selected = file.files?.[0];
    if (!selected) return;
    void ui().perform("calibration-import", async () => {
      const imported = parseCalibrationImport(await selected.text());
      await saveSettings((current) => ({ ...current, calibrations: mergeCalibrations(current.calibrations, imported) }));
      popupState.notice = {
        tone: "success",
        text: `Imported ${imported.length} calibration${imported.length === 1 ? "" : "s"}: ${imported.map((item) => item.model).join(", ")}.`,
      };
    });
  });
  const actions = element("div", "backup-actions");
  actions.append(ui().button("Import calibration", "secondary", () => file.click(), { actionName: "calibration-import", busyLabel: "Importing…" }), file);
  group.append(actions);
  return group;
}

// --- Last decision request preview ------------------------------------------------

/** Survives the popup's re-renders, like the organizer preview's mode. */
let lastRequestOpen = false;
let lastRequestMode: "readable" | "json" = "readable";

/** Tab key → title, read back from either request style's state. */
function tabTitlesFromState(state: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  if (typeof state === "string") {
    for (const match of state.matchAll(/^Tab (t\d+)(?: \([^)]*\))?: "(.*)" on \S+$/gm)) titles.set(match[1]!, match[2]!);
  } else if (state && typeof state === "object" && Array.isArray((state as { tabs?: unknown }).tabs)) {
    for (const tab of (state as { tabs: Array<{ key?: unknown; title?: unknown }> }).tabs) {
      if (typeof tab.key === "string" && typeof tab.title === "string") titles.set(tab.key, tab.title);
    }
  }
  return titles;
}

/** What a question asks, in plain words, from its opaque id. */
function questionHeading(id: string, titles: Map<string, string>): { kind: string; subject: string | null } {
  const tab = (key: string | undefined): string | null => (key ? titles.get(key) ?? `Tab ${key}` : null);
  if (id === REORGANIZE_QUESTION) return { kind: "New topic?", subject: "Do the ungrouped tabs need a new group?" };
  let match = /^file_(t\d+)$/.exec(id);
  if (match) return { kind: "Where does it go?", subject: tab(match[1]) };
  match = /^fits_(t\d+)$/.exec(id);
  if (match) return { kind: "Fits a group?", subject: tab(match[1]) };
  match = /^in_(.+)_(t\d+)$/.exec(id);
  if (match) return { kind: `In group ${match[1]}?`, subject: tab(match[2]) };
  return { kind: id, subject: null };
}

/** Option key and description → a short label and the evidence behind it. */
function optionLabel(key: string, description: string | null): { label: string; detail: string | null } {
  if (key === NONE_OPTION) return { label: "No group", detail: description };
  if (key === STAY_OPTION) return { label: "Stay in its group", detail: description };
  const name = description ? /the "([^"]+)" group/.exec(description)?.[1] : undefined;
  return { label: name ? `${name}` : `Group ${key}`, detail: description };
}

interface OptionRow { key: string; label: string; detail: string | null; probability: number | null }

function optionRows(question: DecisionQuestion, answer: DecisionAnswer | undefined): OptionRow[] {
  if (question.type === "noul") {
    const yes = answer?.type === "noul" ? answer.noul : null;
    return [
      { key: "yes", label: "Yes", detail: question.criteria?.true ?? null, probability: yes },
      { key: "no", label: "No", detail: question.criteria?.false ?? null, probability: yes === null ? null : 1 - yes },
    ];
  }
  const probabilities = answer?.type === "choice" ? answer.probabilities : null;
  const rows = Object.entries(question.criteria).map(([key, description]) => ({
    key,
    ...optionLabel(key, description),
    probability: probabilities ? probabilities[key] ?? 0 : null,
  }));
  // Once answered, the likeliest options lead; before that, the order sent.
  return probabilities ? rows.sort((left, right) => (right.probability ?? 0) - (left.probability ?? 0)) : rows;
}

function percent(value: number): string {
  const rounded = Math.round(value * 100);
  return rounded === 0 && value > 0 ? "<1%" : `${rounded}%`;
}

function renderDecisionQuestion(
  id: string,
  question: DecisionQuestion,
  answer: DecisionAnswer | undefined,
  titles: Map<string, string>,
): HTMLElement {
  const item = element("li", "decision-question");
  const heading = questionHeading(id, titles);
  const head = element("div", "decision-question__head");
  head.append(element("span", "decision-question__kind", heading.kind));
  if (heading.subject) {
    const subject = element("strong", "decision-question__subject", heading.subject);
    subject.title = heading.subject;
    head.append(subject);
  }
  item.append(head);
  const rows = optionRows(question, answer);
  const picked = answer?.type === "choice" ? answer.choice : answer?.type === "noul" ? (answer.noul >= 0.5 ? "yes" : "no") : null;
  const list = element("ol", "decision-options");
  rows.forEach((row) => {
    const option = element("li", `decision-option${row.key === picked ? " decision-option--picked" : ""}`);
    const copy = element("div", "decision-option__copy");
    const label = element("span", "decision-option__label", row.label);
    copy.append(label);
    if (row.key === picked) copy.append(element("span", "decision-option__badge", "Picked"));
    option.append(copy);
    if (row.probability !== null) {
      const meter = element("span", "decision-option__meter");
      const bar = element("span", "decision-option__bar");
      bar.style.width = `${Math.max(0, Math.min(1, row.probability)) * 100}%`;
      meter.append(bar);
      option.append(meter, element("span", "decision-option__value", percent(row.probability)));
    }
    if (row.detail) {
      const detail = element("small", "decision-option__detail", row.detail);
      detail.title = row.detail;
      option.append(detail);
    }
    list.append(option);
  });
  item.append(list);
  const instructions = element("details", "decision-question__instructions");
  instructions.append(element("summary", undefined, "Instructions sent"), element("p", undefined, question.instructions));
  item.append(instructions);
  return item;
}

function renderReadableDecisionRequest(last: LastDecisionRequest): HTMLElement {
  const view = element("div", "privacy-request-preview__readable");
  const request = last.request!;
  const questions = Object.entries(request.questions);
  const facts = element("dl", "privacy-request-facts");
  const fact = (label: string, value: string): void => {
    const row = element("div");
    row.append(element("dt", undefined, label), element("dd", undefined, value));
    facts.append(row);
  };
  if (last.model) fact("Model", last.model);
  fact("Questions", String(questions.length));
  const outcome = last.outcome;
  fact("Result", !outcome ? "Waiting for an answer" : outcome.status === "failed" ? "Failed" : `Answered in ${outcome.latencyMs} ms`);
  view.append(facts);
  if (outcome?.status === "failed") view.append(element("p", "decision-request__error", outcome.error));

  view.append(element("h4", "privacy-request-list__heading", "What the model was shown"));
  view.append(element(
    "pre",
    "decision-request__state",
    typeof request.state === "string" ? request.state : JSON.stringify(request.state, null, 2),
  ));
  view.append(element(
    "h4",
    "privacy-request-list__heading",
    outcome?.status === "answered" ? "Questions and the model's answers" : "Questions asked",
  ));
  const titles = tabTitlesFromState(request.state);
  const answers = outcome?.status === "answered" ? outcome.answers : {};
  const list = element("ol", "decision-questions");
  questions.forEach(([id, question]) => list.append(renderDecisionQuestion(id, question, answers[id], titles)));
  view.append(list);
  return view;
}

function renderLastRequest(state: AutoFilingViewState): HTMLElement {
  const last = state.lastRequest;
  const preview = element("details", "filing-request-preview");
  preview.open = lastRequestOpen && last !== null;
  preview.addEventListener("toggle", () => { lastRequestOpen = preview.open; });
  const summary = element("summary");
  const heading = element("span");
  heading.append(
    element("strong", undefined, "View last decision request"),
    element("small", undefined, last
      ? [
        last.model,
        last.protocol === "chat" ? "Chat completions" : "Decision API",
        relativeAge(last.at),
      ].filter(Boolean).join(" · ")
      : "Nothing sent this session"),
  );
  summary.append(heading);
  if (last?.outcome) {
    summary.append(element(
      "span",
      last.outcome.status === "answered"
        ? "privacy-request-preview__status privacy-request-preview__status--ready"
        : "privacy-request-preview__status decision-request__status--failed",
      last.outcome.status === "answered" ? `Answered · ${last.outcome.latencyMs} ms` : "Failed",
    ));
  }
  preview.append(summary);
  if (!last) {
    preview.append(element("p", "privacy-request-preview__empty", "The exact request appears here after auto-filing asks the decision model about a tab."));
    return preview;
  }
  const json = element("div", "privacy-request-preview__json");
  json.append(
    element("p", "privacy-request-preview__copy", "The body as sent. Opaque keys (g1, t1) stand in for groups and tabs; browser IDs stay on this device."),
    element("pre", undefined, last.body),
  );
  // Requests saved before the readable view existed only have their body.
  if (!last.request) {
    preview.append(json);
    return preview;
  }
  const readable = renderReadableDecisionRequest(last);
  const modes = element("div", "privacy-request-preview__modes");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Decision request format");
  const controls: HTMLButtonElement[] = [];
  const sync = (): void => {
    readable.hidden = lastRequestMode !== "readable";
    json.hidden = lastRequestMode !== "json";
    controls.forEach((control) => {
      const active = control.dataset.previewMode === lastRequestMode;
      control.classList.toggle("privacy-request-preview__mode--active", active);
      control.setAttribute("aria-pressed", String(active));
    });
  };
  ([["readable", "Readable"], ["json", "JSON"]] as const).forEach(([mode, label]) => {
    const control = element("button", "privacy-request-preview__mode", label);
    control.type = "button";
    control.dataset.previewMode = mode;
    control.addEventListener("click", () => {
      lastRequestMode = mode;
      sync();
    });
    controls.push(control);
    modes.append(control);
  });
  preview.append(modes, readable, json);
  sync();
  return preview;
}
