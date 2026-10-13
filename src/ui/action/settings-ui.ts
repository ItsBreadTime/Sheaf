import { renderStashRetentionSettings } from "./stash-ui";
import { autoFilingView, decisionModelStatus, renderAutoFilingSettings, renderDecisionModelProvider } from "./auto-filing-ui";
import { renderProviderConnection, resolveApiKey, type ConnectionStatus } from "./provider-connection-ui";
import { markSettingsError, markSettingsSaving, settingsSaveStatus, trackSettingsSave } from "./settings-save-status";
import { renderUsageSettings, usageNavCopy } from "./usage-ui";
import { popupState } from "./popup-store";
import { element, parseJsonObject, relativeAge } from "../shared/helpers";
import { DEFAULT_ORGANIZER_PROMPT, MAX_CUSTOM_ORGANIZER_PROMPT_CHARS } from "../../organizer/prompt";
import { findDomainRuleConflicts, normalizeDomainRules } from "../../privacy/domain-policy";
import { testProviderConnection } from "../../provider/connection-test";
import { normalizeProviderConfig, normalizeProviderEndpoint } from "../../provider/request-policy";
import { describeAutoReasoningOff } from "../../provider/reasoning-off";
import { clearProviderJob, DEFAULT_PROVIDER_CONFIG, writeConnectionTest, writeCustomOrganizerPrompt, writePrivacySettings, writeProviderSettings, writeWorkflowSettings } from "../../storage/organizer-state";
import { writeProposalReview } from "../../storage/proposal-review";
import type {
  OpenAICompatibleConfig,
  PrivacySettings,
  WorkflowSettings,
} from "../../shared/organizer-types";

type Main = typeof import("./main");

// DOM and action helpers owned by main.ts, injected so the settings page stays a
// leaf module without importing the main entry. Shared state is in popup-store.
export interface SettingsPanelContext {
  readonly fullSettingsPage: boolean;
  advancedDisclosure: Main["advancedDisclosure"];
  button: Main["button"];
  check: Main["check"];
  createDomainRuleEditor: Main["createDomainRuleEditor"];
  currentProviderConfig: Main["currentProviderConfig"];
  field: Main["field"];
  fullExtensionPageUrl: Main["fullExtensionPageUrl"];
  initializeTarget: Main["initializeTarget"];
  input: Main["input"];
  lineIcon: Main["lineIcon"];
  perform: Main["perform"];
  render: Main["render"];
  providerConfigured: Main["providerConfigured"];
  rebuildRequest: Main["rebuildRequest"];
  renderBackupSettings: Main["renderBackupSettings"];
  renderEmbeddingProviderSettings: Main["renderEmbeddingProviderSettings"];
  embeddingProviderStatus: Main["embeddingProviderStatus"];
  renderGeneratedGroupCleanupSettings: Main["renderGeneratedGroupCleanupSettings"];
  renderGroupNameMemorySettings: Main["renderGroupNameMemorySettings"];
  renderOrganizerRulesSettings: Main["renderOrganizerRulesSettings"];
  renderRequestPreviewBody: Main["renderRequestPreviewBody"];
  renderSearchSettings: Main["renderSearchSettings"];
  renderShortcutSettings: Main["renderShortcutSettings"];
  settingsEditChip: Main["settingsEditChip"];
  settingsSummary: Main["settingsSummary"];
  updateProviderReadiness: Main["updateProviderReadiness"];
  utilityNavIcon: Main["utilityNavIcon"];
}

let panelContext: SettingsPanelContext | null = null;

export function setSettingsPanelContext(context: SettingsPanelContext): void {
  panelContext = context;
}

function ui(): SettingsPanelContext {
  if (!panelContext) throw new Error("The settings panel context is unavailable.");
  return panelContext;
}

/** The same helpers, for the setup page, which shares these components. */
export function settingsContext(): SettingsPanelContext {
  return ui();
}

let settingsSearchQuery = "";
let settingsPageCleanup: (() => void) | null = null;
// The All settings page shows one section at a time; the hash keeps the
// section across reloads and lets other surfaces link straight to one.
let settingsSection = location.hash.slice(1);

// Older links and bookmarks name sections that were merged or renamed.
const SECTION_ALIASES: Record<string, string> = {
  providers: "connections",
  general: "organize",
  "rules-protection": "organize",
  "privacy-cleanup": "privacy",
  "data-maintenance": "data",
};

export const REQUEST_DETAIL_OPTIONS: ReadonlyArray<readonly [PrivacySettings["level"], string, string]> = [
  [1, "Titles + domains", "The least detail. Groups by site."],
  [2, "Titles + route context", "Adds hostnames and readable path words; IDs and tokens are removed."],
  [3, "Titles + hostnames + full paths", "The most detail, for the best grouping on sites with many sections."],
];

/** Discards a reviewed plan and rebuilds the preview after a setting changed what Organize sends. */
export async function invalidatePlanAfterSettingsChange(): Promise<void> {
  const s = popupState;
  if (s.proposalReview) s.discardedPlanReason = "a setting changed what Organize sends";
  s.proposalReview = null;
  s.providerJob = null;
  await Promise.all([writeProposalReview(null), clearProviderJob()]);
  try {
    await ui().rebuildRequest();
  } catch (error) {
    s.immutableRequest = null;
    s.notice = {
      tone: "info",
      text: error instanceof Error ? error.message : "Options saved.",
    };
  }
}

export function organizerConnectionStatus(): ConnectionStatus {
  const s = popupState;
  const config = ui().currentProviderConfig();
  const test = s.organizerData?.local.connectionTest;
  if (s.providerReady && config) {
    return { state: "ready", text: `Verified${test ? ` ${relativeAge(test.testedAt)}` : ""} · ${config.model}` };
  }
  return ui().providerConfigured()
    ? { state: "unverified", text: "Saved · not verified. Organize stays unavailable until it is." }
    : { state: "unset", text: "Not set up. Organize needs this connection." };
}

/**
 * The organizing model's connection card. Settings → Connections and the
 * setup page both use it, so there is one form to learn and maintain.
 */
export function renderOrganizerConnection(options: { open?: boolean; onVerified?: () => void } = {}): HTMLElement {
  const s = popupState;
  const { currentProviderConfig, field, input, providerConfigured, updateProviderReadiness } = ui();
  const config = currentProviderConfig()!;
  const configured = providerConfigured();
  const temperature = input(config.temperature === undefined ? "" : String(config.temperature), "number");
  temperature.min = "0";
  temperature.max = "2";
  temperature.step = "0.1";
  const reasoningEffort = element("select", "input");
  ([
    ["none", "None (default)"],
    ["provider", "Provider default (omit override)"],
    ["minimal", "Minimal"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra high"],
  ] as const).forEach(([value, label]) => {
    const option = element("option", undefined, label);
    option.value = value;
    option.selected = value === (config.reasoningEffort ?? "provider");
    reasoningEffort.append(option);
  });
  const reasoningOff = element("select", "input");
  ([
    ["auto", "Auto-detect"],
    ["reasoning_effort", "reasoning_effort: \"none\" (OpenAI, Gemini, OpenRouter, Groq)"],
    ["thinking", "thinking: disabled (DeepSeek, GLM, Kimi)"],
    ["enable_thinking", "enable_thinking: false (Qwen on Alibaba Cloud, SiliconFlow)"],
    ["chat_template_kwargs", "chat_template_kwargs (vLLM, SGLang, llama.cpp)"],
    ["think", "think: false (Ollama)"],
    ["no_think_prompt", "/no_think in the prompt (Qwen3 on any host)"],
  ] as const).forEach(([value, label]) => {
    const option = element("option", undefined, label);
    option.value = value;
    option.selected = value === (config.reasoningOffMethod ?? "auto");
    reasoningOff.append(option);
  });
  const autoReasoningOff = configured
    ? ` For ${config.origin}, Auto sends ${describeAutoReasoningOff(config.origin, config.model)}.`
    : "";
  const reasoningOffField = field(
    "Turn reasoning off with",
    reasoningOff,
    `Used when effort is None. Auto picks by host and model, and retries without the switch if the server rejects it.${autoReasoningOff}`,
  );
  const showReasoningOff = (): void => {
    reasoningOffField.hidden = reasoningEffort.value !== "none";
  };
  showReasoningOff();
  reasoningEffort.addEventListener("change", showReasoningOff);
  const reasoning = element("textarea", "input textarea provider-json");
  reasoning.value = config.reasoning ? JSON.stringify(config.reasoning, null, 2) : "";
  reasoning.placeholder = "Optional JSON object";
  const organizerKey = s.organizerData!.session.apiKey;
  const form = renderProviderConnection(ui(), {
    id: "organizer",
    title: "Organizing model",
    purpose: "The chat model that reads sanitized tab titles and proposes groups.",
    summary: configured ? `${config.model} · ${config.origin}` : "Required for Organize",
    status: organizerConnectionStatus(),
    open: options.open ?? !configured,
    // An untouched default isn't the user's choice; show an empty URL field.
    origin: configured ? config.origin : "",
    endpointPath: config.endpointPath,
    defaultPath: () => DEFAULT_PROVIDER_CONFIG.endpointPath,
    model: config.model,
    modelPlaceholder: "The model name your service expects",
    key: {
      saved: organizerKey !== "",
      persistent: s.organizerData!.local.persistentApiKey !== null,
      optional: true,
    },
    advanced: {
      customHeaders: config.customHeaders,
      extraBody: config.extraBody,
      customized: config.temperature !== undefined ||
        config.reasoningEffort !== "none" ||
        config.reasoningOffMethod !== undefined ||
        config.reasoning !== undefined,
      extras: [
        field("Temperature", temperature, "Optional, from 0 to 2."),
        field("Reasoning effort", reasoningEffort, "Choose Provider default to send no reasoning setting at all."),
        reasoningOffField,
        field("Provider-specific reasoning (JSON)", reasoning, "For gateways that take a nested reasoning object."),
      ],
    },
    openRouter: { preferences: config.openRouter },
    saveCopy: "Chrome may ask for access to this site, then Sheaf sends one test request.",
    forgetKey: async () => {
      s.organizerData = await writeProviderSettings(config, "", false);
      s.organizerData = await writeConnectionTest(null);
      await updateProviderReadiness();
      s.notice = { tone: "info", text: "API key forgotten. Save and verify a key to organize again." };
    },
    save: async (values) => {
      const normalized = normalizeProviderConfig({
        ...config,
        origin: values.origin,
        endpointPath: values.endpointPath,
        model: values.model,
        temperature: temperature.value.trim() ? Number(temperature.value) : undefined,
        reasoningEffort: reasoningEffort.value === "provider"
          ? undefined
          : reasoningEffort.value as OpenAICompatibleConfig["reasoningEffort"],
        reasoningOffMethod: reasoningOff.value === "auto"
          ? undefined
          : reasoningOff.value as OpenAICompatibleConfig["reasoningOffMethod"],
        customHeaders: values.customHeaders,
        extraBody: values.extraBody,
        reasoning: reasoning.value.trim()
          ? parseJsonObject(reasoning.value, "Organizing model: reasoning")
          : undefined,
        openRouter: values.openRouter,
      });
      const normalizedEndpoint = normalizeProviderEndpoint(normalized.origin, normalized.endpointPath);
      const granted = await chrome.permissions.request({ origins: [normalizedEndpoint.permissionPattern] });
      if (!granted) throw new Error("Chrome didn't grant access to the organizing model's site.");
      s.organizerData = await writeProviderSettings(
        normalized,
        resolveApiKey(values.typedApiKey, { origin: config.origin, apiKey: organizerKey }, normalized.origin),
        values.persistKey,
      );
      s.organizerData = await writeConnectionTest(null);
      try {
        const tested = await testProviderConnection({
          config: currentProviderConfig()!,
          apiKey: s.organizerData.session.apiKey,
        });
        s.organizerData = await writeConnectionTest(tested);
        await updateProviderReadiness();
        if (!s.providerReady) throw new Error("the saved configuration did not match the verified connection");
        s.notice = { tone: "success", text: `Organizing model saved and verified: ${normalized.model}.` };
        options.onVerified?.();
      } catch (error) {
        await updateProviderReadiness();
        throw new Error(`Organizing model saved, but the check failed. ${error instanceof Error ? error.message : "The provider did not answer."}`);
      }
    },
  });
  [temperature, reasoningEffort, reasoningOff, reasoning].forEach((control) => control.addEventListener("input", form.markDirty));
  return form.node;
}

/** What Organize would send from this window right now, under the current privacy settings. */
export function renderLiveRequestPreview(): HTMLElement {
  const s = popupState;
  const requestPreview = element("details", "privacy-request-preview");
  requestPreview.open = true;
  const requestPreviewSummary = element("summary");
  const requestPreviewHeading = element("span");
  requestPreviewHeading.append(
    element("strong", undefined, "Live request preview"),
    element("small", undefined, "What Organize would send from this window"),
  );
  const requestPreviewStatus = element(
    "span",
    s.immutableRequest ? "privacy-request-preview__status privacy-request-preview__status--ready" : "privacy-request-preview__status",
    s.immutableRequest
      ? `${s.immutableRequest.submittedTabIds.length} sent · ${s.immutableRequest.excludedTabs.length} excluded`
      : "Nothing to send",
  );
  const requestPreviewChevron = ui().lineIcon(["m9.5 6 6 6-6 6"]);
  requestPreviewChevron.classList.add("privacy-request-preview__chevron");
  requestPreviewSummary.append(requestPreviewHeading, requestPreviewStatus, requestPreviewChevron);
  requestPreview.append(requestPreviewSummary);
  if (s.immutableRequest) {
    requestPreview.append(ui().renderRequestPreviewBody(s.immutableRequest, s.organizerData!.local.privacy.level));
  } else {
    requestPreview.append(
      element("p", "privacy-request-preview__empty", "No tabs in this window pass your protection and privacy rules."),
    );
  }
  return requestPreview;
}

export function renderSettings(shell: HTMLElement): void {
  const s = popupState;
  const { advancedDisclosure, button, check, createDomainRuleEditor, embeddingProviderStatus, field, fullExtensionPageUrl, initializeTarget, input, lineIcon, perform, providerConfigured, renderBackupSettings, renderEmbeddingProviderSettings, renderGeneratedGroupCleanupSettings, renderGroupNameMemorySettings, renderOrganizerRulesSettings, renderSearchSettings, renderShortcutSettings, settingsSummary, utilityNavIcon } = ui();
  if (!ui().fullSettingsPage || !s.organizerData) return;
  settingsPageCleanup?.();
  settingsPageCleanup = null;
  const panel = element("section", "settings-panel");

  const settingsGrid = element("div", "advanced-settings-grid settings-layout");
  const settingsSidebar = element("aside", "settings-sidebar");
  const searchField = element("div", "settings-search");
  const searchLabel = element("label", "settings-search__label", "Search settings");
  const searchInput = input(settingsSearchQuery, "search");
  searchInput.id = "settings-search";
  searchInput.placeholder = "Find a setting…";
  searchInput.setAttribute("aria-controls", "settings-content");
  searchLabel.htmlFor = searchInput.id;
  const searchControl = element("div", "settings-search__control");
  const searchIcon = utilityNavIcon("search");
  searchIcon.classList.add("settings-search__icon");
  const clearSearch = element("button", "settings-search__clear", "Clear");
  clearSearch.type = "button";
  clearSearch.hidden = settingsSearchQuery.length === 0;
  searchControl.append(searchIcon, searchInput, clearSearch);
  const searchStatus = element("p", "settings-search__status", "");
  searchStatus.setAttribute("role", "status");
  searchStatus.setAttribute("aria-live", "polite");
  const searchResults = element("div", "settings-search__results");
  searchResults.hidden = true;
  searchField.append(searchLabel, searchControl, searchStatus, searchResults);
  const settingsNav = element("nav", "settings-nav");
  settingsNav.setAttribute("aria-label", "Settings sections");
  const settingsContent = element("div", "settings-content");
  settingsContent.id = "settings-content";
  const createCategory = (id: string, title: string, copy: string): HTMLElement => {
    const category = element("section", "settings-category");
    category.id = id;
    category.append(
      element("h2", undefined, title),
      element("p", "settings-category__copy", copy),
    );
    return category;
  };

  const privacy = s.organizerData.local.privacy;
  const workflow = s.organizerData.local.workflow;
  const semanticSettings = s.searchState.local.settings;
  const embeddingStatus = embeddingProviderStatus();
  const decisionStatus = decisionModelStatus();
  const filingEnabled = autoFilingView()?.settings.enabled === true;
  const optionalReady = [embeddingStatus, decisionStatus].filter((status) => status?.state === "ready").length;
  // Sections follow the order a new user sets things up: connect, then decide
  // how organizing behaves and what it may send, then the optional features.
  const categories = [
    {
      id: "connections",
      title: "Connections",
      navCopy: s.providerReady
        ? `Organizing model ready${optionalReady > 0 ? ` · ${optionalReady} more` : ""}`
        : providerConfigured() ? "Organizing model not verified" : "Organizing model needed",
      copy: "The AI services Sheaf talks to. Each feature has its own connection, and each uses Save and verify instead of saving automatically.",
      aliases: "provider api key url token secret endpoint origin model connection openrouter ollama local embedding decision organizer verify forget remember",
    },
    {
      id: "organize",
      title: "Organize",
      navCopy: workflow.organizeWithoutReview ? "Applies without review" : "Reviews before applying",
      copy: "What happens when you organize, and the preferences Sheaf has learned from you.",
      aliases: "organize on click review apply colors rules corrections preferred group names prompt instructions",
    },
    {
      id: "privacy",
      title: "Privacy",
      navCopy: REQUEST_DETAIL_OPTIONS.find(([level]) => level === privacy.level)?.[1] ?? "What's sent",
      copy: "Everything that may leave the browser. Semantic search and auto-filing send the same sanitized details at this level.",
      aliases: "send share url domain allowlist denylist localhost local file inactivity request detail preview",
    },
    {
      id: "search",
      title: "Search",
      navCopy: semanticSettings.semanticEnabled ? "Direct + semantic" : "Direct only",
      copy: "Find open tabs as you type. Semantic search can add related results using an embeddings model.",
      aliases: "find tabs semantic embeddings vector related scope index",
    },
    {
      id: "auto-filing",
      title: "Auto-filing",
      navCopy: filingEnabled ? "On" : "Off",
      copy: "Files new tabs into the groups you already have.",
      aliases: "auto file filing decision model confidence new tabs escalation undo calibration",
    },
    {
      id: "cleanup",
      title: "Cleanup",
      navCopy: `Suggests after ${workflow.inactiveSuggestionHours} h idle`,
      copy: "When tabs are suggested for closing, and how Sheaf tidies up after itself.",
      aliases: "inactive clutter close blank tabs suggestions generated groups ungroup",
    },
    {
      id: "shortcuts",
      title: "Shortcuts",
      navCopy: "Keyboard shortcuts",
      copy: "Keys that work from any tab while the browser is focused.",
      aliases: "keyboard shortcut hotkey keybind",
    },
    {
      id: "usage",
      title: "Usage",
      navCopy: usageNavCopy(),
      copy: "Requests, tokens, and cost for each connection. Counts only.",
      aliases: "usage stats tokens cost price spend billing requests",
    },
    {
      id: "data",
      title: "Data",
      navCopy: "Backup and retention",
      copy: "What Sheaf keeps on this device, and how to back it up.",
      aliases: "backup export import restore retention workspaces diagnostics",
    },
  ];
  // Sections that still need the user carry a dot in the index.
  const navAttention: Record<string, boolean> = {
    connections: !s.providerReady ||
      (semanticSettings.semanticEnabled && embeddingStatus.state !== "ready") ||
      (filingEnabled && decisionStatus !== null && decisionStatus.state === "unverified"),
  };
  const categoryById = new Map<string, HTMLElement>();
  categories.forEach((item) => {
    const link = element("a", "settings-nav__link");
    link.href = `#${item.id}`;
    link.append(
      element("strong", undefined, item.title),
      element(
        "span",
        navAttention[item.id] ? "settings-nav__status settings-nav__status--attention" : "settings-nav__status",
        item.navCopy,
      ),
    );
    settingsNav.append(link);
    const category = createCategory(item.id, item.title, item.copy);
    categoryById.set(item.id, category);
    settingsContent.append(category);
  });
  settingsSidebar.append(searchField, settingsNav, settingsSaveStatus());
  settingsGrid.append(settingsSidebar, settingsContent);
  panel.append(settingsGrid);
  const connectionsCategory = categoryById.get("connections")!;
  const organizeCategory = categoryById.get("organize")!;
  const privacyCategory = categoryById.get("privacy")!;
  const searchCategory = categoryById.get("search")!;
  const cleanupCategory = categoryById.get("cleanup")!;
  const dataCategory = categoryById.get("data")!;

  // Only Organize depends on the organizing model, so only it says it's missing.
  if (!s.providerReady) {
    const setupNotice = element("div", "settings-setup-notice");
    setupNotice.setAttribute("role", "note");
    const setupNoticeCopy = element("p");
    setupNoticeCopy.append(
      element(
        "strong",
        undefined,
        providerConfigured() ? "The organizing model is saved but not verified." : "Organize needs an organizing model.",
      ),
      element("span", undefined, "Connect one to start organizing."),
    );
    const setupLinks = element("div", "settings-setup-notice__links");
    const connectLink = element("a", "settings-setup-notice__link", "Set up in Connections");
    connectLink.href = "#connections";
    connectLink.dataset.providerTarget = "organizer";
    const guidedLink = element("a", "settings-setup-notice__link", "Guided setup");
    guidedLink.href = fullExtensionPageUrl("setup");
    setupLinks.append(connectLink, guidedLink);
    setupNotice.append(setupNoticeCopy, setupLinks);
    organizeCategory.querySelector(":scope > .settings-category__copy")!.after(setupNotice);
  }

  // --- Connections -------------------------------------------------------------
  connectionsCategory.append(renderOrganizerConnection(), renderEmbeddingProviderSettings());
  const decisionProvider = renderDecisionModelProvider();
  if (decisionProvider) connectionsCategory.append(decisionProvider);

  // --- Organize ----------------------------------------------------------------
  const skipReview = check(
    "Organize without review",
    "Applies the plan right away. Undo is always available.",
    workflow.organizeWithoutReview,
  );
  const organizeOnClick = check(
    "Organize when the extension opens",
    "Starts organizing as soon as you click the Sheaf icon.",
    workflow.organizeOnExtensionClick,
  );
  const aiGroupColors = check(
    "Let AI choose colors for new groups",
    "Existing groups keep their color.",
    workflow.aiGroupColors,
  );
  const everydayGroup = element("section", "settings-group");
  everydayGroup.append(
    element("h3", undefined, "When you organize"),
    organizeOnClick.wrapper,
    skipReview.wrapper,
    aiGroupColors.wrapper,
  );
  organizeCategory.append(everydayGroup);
  renderOrganizerRulesSettings(organizeCategory);
  renderGroupNameMemorySettings(organizeCategory);

  const customPrompt = s.organizerData.local.customOrganizerPrompt;
  const organizerPrompt = element("textarea", "input textarea prompt-editor");
  organizerPrompt.value = customPrompt ?? DEFAULT_ORGANIZER_PROMPT;
  organizerPrompt.maxLength = MAX_CUSTOM_ORGANIZER_PROMPT_CHARS;
  organizerPrompt.spellcheck = true;
  organizerPrompt.setAttribute("aria-label", "Custom grouping instructions");
  const promptCount = element(
    "span",
    "prompt-editor__count",
    `${organizerPrompt.value.length.toLocaleString()} / ${MAX_CUSTOM_ORGANIZER_PROMPT_CHARS.toLocaleString()}`,
  );
  organizerPrompt.addEventListener("input", () => {
    promptCount.textContent = `${organizerPrompt.value.length.toLocaleString()} / ${MAX_CUSTOM_ORGANIZER_PROMPT_CHARS.toLocaleString()}`;
  });
  const promptHelp = element("div", "prompt-settings__help");
  promptHelp.append(
    element(
      "p",
      undefined,
      "Replaces the default grouping instructions. Sheaf's safety checks, validation, and protected-tab rules still apply.",
    ),
    promptCount,
  );
  const savePrompt = async (value: string | null): Promise<void> => {
    const custom = value !== null && value.trim() === DEFAULT_ORGANIZER_PROMPT.trim()
      ? null
      : value;
    s.organizerData = await writeCustomOrganizerPrompt(custom);
    s.proposalReview = null;
    s.providerJob = null;
    await Promise.all([writeProposalReview(null), clearProviderJob()]);
  };
  organizerPrompt.addEventListener("change", () => {
    void perform("organizer-prompt-autosave", () => trackSettingsSave(() => savePrompt(organizerPrompt.value)));
  });
  const promptActions = element("div", "prompt-settings__actions");
  promptActions.append(
    button(
      "Reset to default",
      "secondary",
      () => {
        void perform("organizer-prompt-reset", () => trackSettingsSave(() => savePrompt(null)));
      },
      {
        disabled: customPrompt === null,
        actionName: "organizer-prompt-reset",
        busyLabel: "Resetting…",
      },
    ),
  );
  const promptLabel = element("h3", undefined, "Custom grouping instructions");
  organizeCategory.append(advancedDisclosure(
    "organize",
    "Custom grouping instructions",
    [promptLabel, promptHelp, organizerPrompt, promptActions],
    element("span", customPrompt === null ? "prompt-status" : "prompt-status prompt-status--custom", customPrompt === null ? "Default" : "Custom"),
  ));

  // --- Privacy -----------------------------------------------------------------
  const allowLocal = check(
    "Include localhost and private networks",
    "Lets Sheaf group and send the titles of local development pages.",
    privacy.allowLocalNetworkTabs,
  );
  const allowFiles = check(
    "Include local file pages",
    "Only the title is sent, never the file path.",
    privacy.allowFileTabs,
  );
  const existingGroups = check(
    "Include existing group names",
    "Helps Sheaf keep and extend groups you already have.",
    privacy.includeExistingGroups,
  );
  const includeInactivity = check(
    "Include how long each tab has been idle",
    "Rounded minutes only, never the exact time. Improves cleanup suggestions.",
    workflow.includeInactivityDuration,
  );
  const level = element("select", "input");
  REQUEST_DETAIL_OPTIONS.forEach(([value, label]) => {
    const option = element("option", undefined, label);
    option.value = String(value);
    option.selected = value === privacy.level;
    level.append(option);
  });
  const currentWindowDomains = normalizeDomainRules(
    (s.viewState.editor?.capturedState.tabs ?? []).flatMap((tab) => {
      try {
        const url = new URL(tab.url);
        return url.protocol === "http:" || url.protocol === "https:" ? [url.hostname] : [];
      } catch {
        return [];
      }
    }),
  );
  const allowlist = createDomainRuleEditor(
    "Allowlist",
    "When not empty, only matching domains are sent.",
    privacy.allowlist,
    currentWindowDomains,
  );
  const denylist = createDomainRuleEditor(
    "Denylist",
    "Matching domains always stay local.",
    privacy.denylist,
    currentWindowDomains,
  );
  const domainConflict = element("p", "domain-rule-conflict");
  domainConflict.setAttribute("role", "alert");
  const refreshDomainConflicts = (): void => {
    const conflicts = findDomainRuleConflicts(allowlist.values(), denylist.values());
    domainConflict.textContent = conflicts.length === 0
      ? "No allow/deny conflicts."
      : `Resolve before saving: ${conflicts.map((conflict) =>
          `${conflict.allowRule} overlaps ${conflict.denyRule}`
        ).join("; ")}. Denylist wins.`;
    domainConflict.className = conflicts.length === 0
      ? "domain-rule-conflict domain-rule-conflict--clear"
      : "domain-rule-conflict";
  };
  refreshDomainConflicts();

  const sent = element("section", "settings-group");
  sent.append(
    element("h3", undefined, "What's sent"),
    element("p", "settings-group__copy", "Tab titles are always sanitized. Add only the context that helps grouping."),
    field(
      "Request detail",
      level,
      REQUEST_DETAIL_OPTIONS.find(([value]) => value === privacy.level)?.[2],
    ),
    existingGroups.wrapper,
    includeInactivity.wrapper,
    allowLocal.wrapper,
    allowFiles.wrapper,
    renderLiveRequestPreview(),
  );
  const domainRules = element("details", "advanced");
  domainRules.open = privacy.allowlist.length > 0 || privacy.denylist.length > 0;
  domainRules.append(settingsSummary("Allowlist and denylist"), allowlist.node, denylist.node, domainConflict);
  sent.append(domainRules);
  privacyCategory.append(sent);

  // --- Cleanup -----------------------------------------------------------------
  const alwaysShowCleanup = check(
    "Show cleanup suggestions after organizing",
    "Opens the cleanup list when there's something to close. Closing still needs your confirmation.",
    workflow.alwaysShowCleanupReview,
  );
  const closeBlank = check(
    "Close inactive blank new tabs",
    "Never the active, pinned, grouped, audible, or navigated tab.",
    privacy.closeInactiveBlankTabs,
  );
  const inactiveHours = input(String(workflow.inactiveSuggestionHours), "number");
  inactiveHours.min = "1";
  inactiveHours.max = "8760";
  inactiveHours.step = "1";
  const lowValueHours = input(String(workflow.lowValueSuggestionHours), "number");
  lowValueHours.min = "1";
  lowValueHours.max = "8760";
  lowValueHours.step = "1";
  const cleanupGroup = element("section", "settings-group");
  cleanupGroup.append(
    element("h3", undefined, "Cleanup suggestions"),
    alwaysShowCleanup.wrapper,
    closeBlank.wrapper,
    field("Suggest idle tabs after (hours)", inactiveHours, "Default: 24."),
    field("Suggest likely clutter after (hours)", lowValueHours, "For tabs that look disposable, like search results. Default: 6."),
  );
  cleanupCategory.append(cleanupGroup, renderGeneratedGroupCleanupSettings());

  // --- Search, auto-filing, shortcuts, usage, data -----------------------------
  renderSearchSettings(searchCategory);
  renderAutoFilingSettings(categoryById.get("auto-filing")!);
  categoryById.get("shortcuts")!.append(renderShortcutSettings());
  renderUsageSettings(categoryById.get("usage")!);
  renderBackupSettings(dataCategory);
  dataCategory.append(renderStashRetentionSettings());
  const toolsGroup = element("section", "settings-group settings-tools");
  toolsGroup.append(element("h3", undefined, "Diagnostics"));
  const toolLinks = element("div", "settings-tool-links");
  const diagnosticsLink = element("a", "settings-tool-link");
  diagnosticsLink.href = fullExtensionPageUrl("diagnostics");
  diagnosticsLink.append(
    element("span", undefined, "Diagnostics"),
    element("small", undefined, "Inspect provider runs and recovery events"),
    lineIcon(["m9.5 6 6 6-6 6"]),
  );
  toolLinks.append(diagnosticsLink);
  toolsGroup.append(toolLinks);
  dataCategory.append(toolsGroup);

  // Organize, Privacy, and Cleanup controls share one stored record, so they share one save.
  const persistPreferences = async (): Promise<void> => {
    const next: PrivacySettings = {
      level: Number(level.value) as PrivacySettings["level"],
      includeExistingGroups: existingGroups.control.checked,
      allowLocalNetworkTabs: allowLocal.control.checked,
      allowFileTabs: allowFiles.control.checked,
      closeInactiveBlankTabs: closeBlank.control.checked,
      allowlist: allowlist.values(),
      denylist: denylist.values(),
    };
    if (findDomainRuleConflicts(next.allowlist, next.denylist).length > 0) {
      throw new Error("Resolve the allowlist and denylist conflicts before saving.");
    }
    const nextWorkflow: WorkflowSettings = {
      organizeWithoutReview: skipReview.control.checked,
      aiGroupColors: aiGroupColors.control.checked,
      organizeOnExtensionClick: organizeOnClick.control.checked,
      // Organize is always the startup view; the stored flag is kept for backups only.
      pinUtilityPanelOpen: false,
      alwaysShowCleanupReview: alwaysShowCleanup.control.checked,
      inactiveSuggestionHours: Number(inactiveHours.value),
      lowValueSuggestionHours: Number(lowValueHours.value),
      includeInactivityDuration: includeInactivity.control.checked,
    };
    if (
      !Number.isInteger(nextWorkflow.inactiveSuggestionHours) ||
      nextWorkflow.inactiveSuggestionHours < 1 ||
      nextWorkflow.inactiveSuggestionHours > 8_760 ||
      !Number.isInteger(nextWorkflow.lowValueSuggestionHours) ||
      nextWorkflow.lowValueSuggestionHours < 1 ||
      nextWorkflow.lowValueSuggestionHours > 8_760
    ) {
      throw new Error("Cleanup suggestion periods must be whole hours from 1 to 8,760.");
    }
    await writePrivacySettings(next);
    s.organizerData = await writeWorkflowSettings(nextWorkflow);
    await initializeTarget();
    // Only settings that change what Organize sends invalidate a plan. Turning
    // on organize-on-click or the cleanup review leaves a reviewed plan intact.
    const planAffected =
      JSON.stringify(next) !== JSON.stringify(privacy) ||
      nextWorkflow.aiGroupColors !== workflow.aiGroupColors ||
      nextWorkflow.inactiveSuggestionHours !== workflow.inactiveSuggestionHours ||
      nextWorkflow.lowValueSuggestionHours !== workflow.lowValueSuggestionHours ||
      nextWorkflow.includeInactivityDuration !== workflow.includeInactivityDuration;
    if (s.proposalReview && !planAffected) return;
    await invalidatePlanAfterSettingsChange();
  };
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleAutosave = (): void => {
    // Pending counts as saving, so the status never claims a change is saved early.
    markSettingsSaving();
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void perform("preferences-autosave", () => trackSettingsSave(persistPreferences));
    }, 500);
  };
  const handleDomainRulesChange = (): void => {
    refreshDomainConflicts();
    if (findDomainRuleConflicts(allowlist.values(), denylist.values()).length > 0) {
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      markSettingsError("Resolve the allowlist and denylist conflict to save.");
      return;
    }
    scheduleAutosave();
  };
  [
    organizeOnClick.control,
    skipReview.control,
    aiGroupColors.control,
    alwaysShowCleanup.control,
    includeInactivity.control,
    allowLocal.control,
    allowFiles.control,
    closeBlank.control,
    existingGroups.control,
    inactiveHours,
    lowValueHours,
    level,
  ].forEach((control) => control.addEventListener("change", scheduleAutosave));
  allowlist.onChange(handleDomainRulesChange);
  denylist.onChange(handleDomainRulesChange);

  const applySettingsSearch = (): void => {
    const query = searchInput.value.trim().toLocaleLowerCase();
    settingsSearchQuery = searchInput.value;
    searchResults.replaceChildren();
    if (query.length === 0) {
      searchStatus.textContent = "";
      searchResults.hidden = true;
      clearSearch.hidden = true;
      return;
    }

    const terms = query.split(/\s+/).filter(Boolean);
    const candidates = [...settingsContent.querySelectorAll<HTMLElement>(
      ".check, .field, .settings-group > h3, details > summary, .settings-tool-link",
    )].flatMap((target) => {
      const category = target.closest<HTMLElement>(".settings-category");
      const categoryItem = categories.find((item) => item.id === category?.id);
      if (!category || !categoryItem) return [];
      // Sections are paged, so the category itself is usually hidden; only a
      // hidden ancestor inside it (an option that does not apply) excludes a match.
      const hiddenAncestor = target.closest<HTMLElement>("[hidden]");
      if (hiddenAncestor && hiddenAncestor !== category) return [];
      const label = target.matches(".check")
        ? target.querySelector("strong")?.textContent?.trim()
        : target.matches(".field")
          ? target.querySelector(".field__label")?.textContent?.trim()
          : target.matches(".settings-tool-link")
            ? target.querySelector(":scope > span")?.textContent?.trim()
            : target.querySelector(":scope > strong, :scope > span > strong, .settings-subdisclosure__label")?.textContent?.trim() ??
              target.textContent?.trim();
      if (!label) return [];
      // Connections repeat the same field names, so a match names its card.
      const connection = target.closest<HTMLElement>(".provider-settings")
        ?.querySelector(":scope > summary strong")?.textContent?.trim();
      const place = connection && connection !== label ? `${categoryItem.title} · ${connection}` : categoryItem.title;
      const normalizedLabel = label.toLocaleLowerCase();
      const searchable = `${label} ${target.textContent ?? ""} ${place} ${categoryItem.aliases}`
        .toLocaleLowerCase();
      if (!terms.every((term) => searchable.includes(term))) return [];
      const score = normalizedLabel === query
        ? 0
        : normalizedLabel.startsWith(query)
          ? 1
          : normalizedLabel.includes(query)
            ? 2
            : 3;
      return [{ target, label, category: place, categoryId: categoryItem.id, score }];
    }).sort((left, right) => left.score - right.score || left.label.localeCompare(right.label));

    const unique = candidates.filter((candidate, index, all) =>
      all.findIndex((item) => item.label === candidate.label && item.category === candidate.category) === index,
    ).slice(0, 8);
    if (unique.length === 0) {
      searchStatus.textContent = "No matching settings";
      searchResults.hidden = true;
    } else {
      searchStatus.textContent = `${unique.length}${candidates.length > unique.length ? "+" : ""} matching setting${unique.length === 1 ? "" : "s"}`;
      unique.forEach((candidate) => {
        const result = element("button", "settings-search__result");
        result.type = "button";
        result.append(
          element("strong", undefined, candidate.label),
          element("span", undefined, candidate.category),
        );
        result.addEventListener("click", () => {
          showSection(candidate.categoryId);
          let details = candidate.target.closest<HTMLDetailsElement>("details");
          while (details) {
            details.open = true;
            details = details.parentElement?.closest<HTMLDetailsElement>("details") ?? null;
          }
          candidate.target.scrollIntoView({ block: "center" });
          candidate.target.classList.remove("settings-search-target");
          requestAnimationFrame(() => candidate.target.classList.add("settings-search-target"));
          const focusTarget = candidate.target.matches("button, a, input, select, textarea, summary")
            ? candidate.target
            : candidate.target.querySelector<HTMLElement>("input, select, textarea, button, a, summary");
          focusTarget?.focus({ preventScroll: true });
        });
        searchResults.append(result);
      });
      searchResults.hidden = false;
    }
    clearSearch.hidden = query.length === 0;
  };
  const navLinks = [...settingsNav.querySelectorAll<HTMLAnchorElement>(".settings-nav__link")];
  function showSection(requested: string, moveFocus = false): void {
    const id = SECTION_ALIASES[requested] ?? requested;
    const next = categoryById.has(id) ? id : categories[0]!.id;
    const changed = next !== settingsSection;
    settingsSection = next;
    categoryById.forEach((category, categoryId) => {
      category.hidden = categoryId !== next;
    });
    navLinks.forEach((link) => {
      if (link.hash !== `#${next}`) {
        link.removeAttribute("aria-current");
        return;
      }
      link.setAttribute("aria-current", "page");
      // On narrow pages the index is a horizontal strip; keep the current item in it.
      requestAnimationFrame(() => {
        if (settingsNav.scrollWidth <= settingsNav.clientWidth) return;
        settingsNav.scrollLeft = Math.max(0, link.offsetLeft - settingsNav.offsetLeft - 16);
      });
    });
    if (location.hash !== `#${next}`) history.replaceState(null, "", `#${next}`);
    if (changed) window.scrollTo({ top: 0 });
    if (moveFocus) categoryById.get(next)?.querySelector<HTMLElement>(":scope > h2")?.focus({ preventScroll: true });
  }
  categoryById.forEach((category) => category.querySelector<HTMLElement>(":scope > h2")?.setAttribute("tabindex", "-1"));
  navLinks.forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    showSection(link.hash.slice(1), true);
  }));
  // The setup notice and each feature's connection row open that card in Connections.
  settingsContent.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[data-provider-target]");
    if (!link) return;
    event.preventDefault();
    showSection("connections", true);
    const target = document.getElementById(`provider-${link.dataset.providerTarget}`);
    if (!(target instanceof HTMLDetailsElement)) return;
    target.open = true;
    target.scrollIntoView({ block: "start" });
    target.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
  });
  const followHash = (): void => showSection(location.hash.slice(1), true);
  showSection(settingsSection);
  searchInput.addEventListener("input", applySettingsSearch);
  clearSearch.addEventListener("click", () => {
    searchInput.value = "";
    applySettingsSearch();
    searchInput.focus();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || searchInput.value.length === 0) return;
    searchInput.value = "";
    applySettingsSearch();
  });
  applySettingsSearch();
  window.addEventListener("hashchange", followHash);
  settingsPageCleanup = () => window.removeEventListener("hashchange", followHash);
  shell.append(panel);
}
