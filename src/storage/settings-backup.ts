import { normalizeCustomOrganizerPrompt } from "../organizer/prompt";
import { normalizeGroupNamePreferences } from "../organizer/group-name-memory";
import { normalizeOrganizerRules } from "../organizer/rules";
import { normalizeDomainRules } from "../privacy/domain-policy";
import { normalizeProviderConfig } from "../provider/request-policy";
import type { DiagnosticPricing } from "../shared/diagnostics-types";
import type { OpenAICompatibleConfig, OrganizerLocalState, PrivacySettings, ReasoningEffort, WorkflowSettings } from "../shared/organizer-types";
import type { SavedTabStash } from "../shared/stash-types";
import type { EmbeddingConfig, SearchLocalState, SearchSettings } from "../shared/search-types";
import { normalizeEmbeddingConfig, normalizeEmbeddingProfileId } from "../search/embedding-config";
import { DEFAULT_PRIVACY_SETTINGS, DEFAULT_WORKFLOW_SETTINGS, parseStoredReasoningEffort, parseStoredReasoningOffMethod } from "./organizer-state";
import { normalizeTabStashes } from "./stashes";
import { parseAutoFilingSettings } from "./auto-filing";
import type { AutoFilingSettings } from "../shared/auto-filing-types";

export interface SettingsBackupV1 {
  schemaVersion: 1;
  exportedAt: number;
  provider: Pick<OrganizerLocalState["provider"], "origin" | "endpointPath" | "model" | "temperature" | "reasoningOffMethod" | "openRouter" | "manualStreamingEnabled"> & {
    /** null is "Provider default"; JSON would drop undefined and read back as "none". */
    reasoningEffort: ReasoningEffort | null;
  };
  privacy: PrivacySettings;
  workflow: WorkflowSettings;
  customOrganizerPrompt: string | null;
  organizerRules: OrganizerLocalState["organizerRules"];
  groupNamePreferences: OrganizerLocalState["groupNamePreferences"];
  diagnosticPricing: DiagnosticPricing;
  search?: {
    settings: SearchSettings;
    embeddingProvider?: Pick<EmbeddingConfig, "origin" | "endpointPath" | "model" | "dimensions" | "openRouter" | "timeoutMs">;
  };
  workspaces?: SavedTabStash[];
  /** The decision model's key, header values, and extra body are never included. */
  autoFiling?: AutoFilingSettings;
}

/** Drops what a backup never carries: header values and the extra body (keys live elsewhere). */
function backupAutoFilingSettings(settings: AutoFilingSettings): AutoFilingSettings {
  return {
    ...structuredClone(settings),
    decisionModel: settings.decisionModel
      ? { ...structuredClone(settings.decisionModel), customHeaders: {}, extraBody: {} }
      : null,
  };
}

export type SettingsImportPlan = SettingsBackupV1;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup must be a JSON object.");
  return value as Record<string, unknown>;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function createSettingsBackup(options: {
  local: OrganizerLocalState;
  diagnosticPricing: DiagnosticPricing;
  workspaces?: readonly SavedTabStash[];
  searchLocal?: SearchLocalState;
  autoFiling?: AutoFilingSettings;
  now?: number;
}): SettingsBackupV1 {
  const provider = options.local.provider;
  return {
    schemaVersion: 1,
    exportedAt: options.now ?? Date.now(),
    provider: {
      origin: provider.origin,
      endpointPath: provider.endpointPath,
      model: provider.model,
      temperature: provider.temperature,
      reasoningEffort: provider.reasoningEffort ?? null,
      reasoningOffMethod: provider.reasoningOffMethod,
      openRouter: provider.openRouter ? structuredClone(provider.openRouter) : undefined,
      manualStreamingEnabled: false,
    },
    privacy: structuredClone(options.local.privacy),
    workflow: structuredClone(options.local.workflow),
    customOrganizerPrompt: options.local.customOrganizerPrompt,
    organizerRules: structuredClone(options.local.organizerRules),
    groupNamePreferences: structuredClone(options.local.groupNamePreferences),
    diagnosticPricing: structuredClone(options.diagnosticPricing),
    ...(options.searchLocal ? {
      search: {
        settings: structuredClone(options.searchLocal.settings),
        ...(options.searchLocal.embeddingConfig.model ? { embeddingProvider: {
          origin: options.searchLocal.embeddingConfig.origin,
          endpointPath: options.searchLocal.embeddingConfig.endpointPath,
          model: options.searchLocal.embeddingConfig.model,
          dimensions: options.searchLocal.embeddingConfig.dimensions,
          openRouter: options.searchLocal.embeddingConfig.openRouter
            ? structuredClone(options.searchLocal.embeddingConfig.openRouter)
            : undefined,
          timeoutMs: options.searchLocal.embeddingConfig.timeoutMs,
        } } : {}),
      },
    } : {}),
    ...(options.workspaces ? { workspaces: structuredClone([...options.workspaces]) } : {}),
    ...(options.autoFiling ? { autoFiling: backupAutoFilingSettings(options.autoFiling) } : {}),
  };
}

export function parseSettingsBackup(text: string): SettingsImportPlan {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Backup is not valid JSON."); }
  const root = record(parsed);
  if (root.schemaVersion !== 1) throw new Error("Unsupported backup version.");
  const providerValue = record(root.provider);
  const provider = normalizeProviderConfig({
    origin: typeof providerValue.origin === "string" ? providerValue.origin : "",
    endpointPath: typeof providerValue.endpointPath === "string" ? providerValue.endpointPath : "",
    model: typeof providerValue.model === "string" ? providerValue.model : "",
    customHeaders: {},
    extraBody: {},
    temperature: typeof providerValue.temperature === "number" ? providerValue.temperature : undefined,
    reasoningEffort: parseStoredReasoningEffort(providerValue.reasoningEffort),
    reasoningOffMethod: parseStoredReasoningOffMethod(providerValue.reasoningOffMethod),
    openRouter: providerValue.openRouter && typeof providerValue.openRouter === "object" && !Array.isArray(providerValue.openRouter)
      ? providerValue.openRouter as OpenAICompatibleConfig["openRouter"]
      : undefined,
    manualStreamingEnabled: false,
  });
  const privacyValue = record(root.privacy);
  const privacy: PrivacySettings = {
    level: privacyValue.level === 1 || privacyValue.level === 2 || privacyValue.level === 3 ? privacyValue.level : DEFAULT_PRIVACY_SETTINGS.level,
    includeExistingGroups: privacyValue.includeExistingGroups !== false,
    allowLocalNetworkTabs: privacyValue.allowLocalNetworkTabs !== false,
    allowFileTabs: privacyValue.allowFileTabs !== false,
    closeInactiveBlankTabs: privacyValue.closeInactiveBlankTabs === true,
    allowlist: normalizeDomainRules(Array.isArray(privacyValue.allowlist) ? privacyValue.allowlist.filter((item): item is string => typeof item === "string") : []),
    denylist: normalizeDomainRules(Array.isArray(privacyValue.denylist) ? privacyValue.denylist.filter((item): item is string => typeof item === "string") : []),
  };
  const workflowValue = record(root.workflow);
  const workflow: WorkflowSettings = {
    ...DEFAULT_WORKFLOW_SETTINGS,
    // Restored automation stays off until the user turns it on again, even though
    // skip-review is on for a fresh install.
    organizeWithoutReview: false,
    aiGroupColors: workflowValue.aiGroupColors !== false,
    pinUtilityPanelOpen: workflowValue.pinUtilityPanelOpen === true,
    alwaysShowCleanupReview: workflowValue.alwaysShowCleanupReview === true,
    inactiveSuggestionHours: integer(workflowValue.inactiveSuggestionHours, 24, 1, 8_760),
    lowValueSuggestionHours: integer(workflowValue.lowValueSuggestionHours, 6, 1, 8_760),
    includeInactivityDuration: workflowValue.includeInactivityDuration !== false,
  };
  const pricingValue = record(root.diagnosticPricing);
  let search: SettingsBackupV1["search"];
  if (root.search !== undefined) {
    const searchValue = record(root.search);
    const searchSettings = record(searchValue.settings);
    const embeddingValue = searchValue.embeddingProvider === undefined
      ? null
      : record(searchValue.embeddingProvider);
    const model = embeddingValue && typeof embeddingValue.model === "string" ? embeddingValue.model : "";
    const normalizedEmbedding = embeddingValue && model ? normalizeEmbeddingConfig({
      origin: typeof embeddingValue.origin === "string" ? embeddingValue.origin : "https://api.openai.com",
      endpointPath: typeof embeddingValue.endpointPath === "string" ? embeddingValue.endpointPath : "/v1/embeddings",
      model: model || "not-configured",
      dimensions: typeof embeddingValue.dimensions === "number" ? embeddingValue.dimensions : null,
      apiKeyStorage: "session",
      modelProfile: normalizeEmbeddingProfileId(embeddingValue.modelProfile),
      customHeaders: {},
      extraBody: {},
      openRouter: embeddingValue.openRouter && typeof embeddingValue.openRouter === "object" && !Array.isArray(embeddingValue.openRouter)
        ? embeddingValue.openRouter as EmbeddingConfig["openRouter"]
        : undefined,
      timeoutMs: integer(embeddingValue.timeoutMs, 30_000, 1_000, 120_000),
    }) : null;
    search = {
      settings: {
        defaultScope: searchSettings.defaultScope === "all_windows" ? "all_windows" : "current_window",
        includeGroupNames: searchSettings.includeGroupNames !== false,
        closeAfterFocus: searchSettings.closeAfterFocus !== false,
        semanticEnabled: false,
        semanticConsentAt: null,
        // Consent-adjacent like the two fields above: a restored backup must not
        // re-widen what leaves the device without the user saying so again.
        semanticIncludeGroupNames: false,
        semanticRerank: false,
        semanticAlways: searchSettings.semanticAlways === true,
        semanticWhenDirectWeak: searchSettings.semanticWhenDirectWeak !== false,
        semanticIndexScope: searchSettings.semanticIndexScope === "current_window" ? "current_window" : "all_windows",
        semanticIndexPaused: false,
      },
      ...(normalizedEmbedding ? { embeddingProvider: {
        origin: normalizedEmbedding.origin,
        endpointPath: normalizedEmbedding.endpointPath,
        model,
        dimensions: normalizedEmbedding.dimensions,
        openRouter: normalizedEmbedding.openRouter,
        timeoutMs: normalizedEmbedding.timeoutMs,
      } } : {}),
    };
  }
  const price = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    schemaVersion: 1,
    exportedAt: typeof root.exportedAt === "number" && Number.isFinite(root.exportedAt) ? root.exportedAt : 0,
    provider: { origin: provider.origin, endpointPath: provider.endpointPath, model: provider.model, temperature: provider.temperature, reasoningEffort: provider.reasoningEffort ?? null, reasoningOffMethod: provider.reasoningOffMethod, openRouter: provider.openRouter, manualStreamingEnabled: false },
    privacy,
    workflow,
    customOrganizerPrompt: typeof root.customOrganizerPrompt === "string" ? normalizeCustomOrganizerPrompt(root.customOrganizerPrompt) : null,
    organizerRules: normalizeOrganizerRules(root.organizerRules),
    groupNamePreferences: normalizeGroupNamePreferences(root.groupNamePreferences),
    diagnosticPricing: { inputPerMillionUsd: price(pricingValue.inputPerMillionUsd), outputPerMillionUsd: price(pricingValue.outputPerMillionUsd) },
    ...(search ? { search } : {}),
    // Older backups may carry `regressionCases`; the feature is gone, so they are ignored.
    // Backups from before the rename carry the same records as `tabStashes`.
    ...((root.workspaces ?? root.tabStashes) === undefined
      ? {}
      : { workspaces: normalizeTabStashes(root.workspaces ?? root.tabStashes) }),
    ...(root.autoFiling === undefined ? {} : { autoFiling: restoredAutoFilingSettings(root.autoFiling) }),
  };
}

/**
 * Like organize-without-review, automation comes back off: filing stays
 * disabled and escalation at most suggests, until the user turns them on again.
 */
function restoredAutoFilingSettings(value: unknown): AutoFilingSettings {
  const settings = backupAutoFilingSettings(parseAutoFilingSettings(record(value)));
  return {
    ...settings,
    enabled: false,
    escalation: settings.escalation === "organize" ? "suggest" : settings.escalation,
    decisionModel: settings.decisionModel ? { ...settings.decisionModel, apiKeyStorage: "session" } : null,
  };
}
