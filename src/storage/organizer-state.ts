import { normalizeDomainRules } from "../privacy/domain-policy";
import { normalizeProviderConfig } from "../provider/request-policy";
import { normalizeOrganizerRules } from "../organizer/rules";
import { normalizeCustomOrganizerPrompt } from "../organizer/prompt";
import {
  normalizeGroupNamePreferences,
  recordApprovedGroupNames,
} from "../organizer/group-name-memory";
import type {
  ConnectionTestRecord,
  ImmutableRequestBundle,
  GroupNamePreference,
  OpenAICompatibleConfig,
  OrganizerRule,
  OrganizerLocalState,
  OrganizerStoredState,
  PrivacySettings,
  ProviderJobResult,
  ReasoningEffort,
  ReasoningOffMethod,
  WorkflowSettings,
} from "../shared/organizer-types";
import type { ProviderCancellationReason } from "../shared/proposal-review-types";
import { isRecord } from "../shared/guards";
import { ensureSessionStorageCapacity } from "./session-budget";
import { withCrossContextMutationLock } from "./mutation-lock";
import { BACKGROUND_JOB_OWNER } from "./background-error";

const LOCAL_KEY = "organizerLocalState";
const SESSION_KEYS = {
  apiKey: "organizerApiKey",
  customHeaders: "organizerCustomHeaders",
  immutableRequest: "organizerImmutableRequest",
  providerJob: "organizerProviderJob",
} as const;

export const DEFAULT_PROVIDER_CONFIG: OpenAICompatibleConfig = {
  origin: "https://api.openai.com",
  endpointPath: "/v1/chat/completions",
  model: "",
  customHeaders: {},
  extraBody: {},
  reasoningEffort: "none",
  manualStreamingEnabled: false,
};

const REASONING_EFFORT_VALUES: readonly unknown[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Reads a stored reasoning effort. "Provider default" sends no override and is
 * stored as null; a missing value means the setting was never chosen, so it
 * gets the default, "none".
 */
export function parseStoredReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === null) return undefined;
  return REASONING_EFFORT_VALUES.includes(value) ? value as ReasoningEffort : "none";
}

const REASONING_OFF_METHOD_VALUES: readonly unknown[] = [
  "reasoning_effort", "thinking", "enable_thinking", "chat_template_kwargs", "think", "no_think_prompt",
];

/** A hand-picked way to turn reasoning off; anything else is Auto. */
export function parseStoredReasoningOffMethod(value: unknown): ReasoningOffMethod | undefined {
  return REASONING_OFF_METHOD_VALUES.includes(value) ? value as ReasoningOffMethod : undefined;
}

/** Storage drops undefined, which would turn "Provider default" back into "none". */
function storedLocalState(local: OrganizerLocalState): Record<string, unknown> {
  return { ...local, provider: { ...local.provider, reasoningEffort: local.provider.reasoningEffort ?? null } };
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  level: 2,
  includeExistingGroups: true,
  allowLocalNetworkTabs: true,
  allowFileTabs: true,
  closeInactiveBlankTabs: false,
  allowlist: [],
  denylist: [],
};

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  organizeWithoutReview: true,
  aiGroupColors: true,
  organizeOnExtensionClick: false,
  pinUtilityPanelOpen: false,
  alwaysShowCleanupReview: false,
  inactiveSuggestionHours: 24,
  lowValueSuggestionHours: 6,
  includeInactivityDuration: true,
};

function parseSuggestionHours(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 8_760
    ? Math.round(value)
    : fallback;
}

function parseConnectionTest(value: unknown): ConnectionTestRecord | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isRecord(value.capabilities)) {
    throw new Error("Stored provider connection test is corrupt.");
  }
  const mode = value.capabilities.structuredOutput;
  if (
    typeof value.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.fingerprint) ||
    typeof value.testedAt !== "number" ||
    !Number.isFinite(value.testedAt) ||
    typeof value.providerOrigin !== "string" ||
    (mode !== "json_schema" && mode !== "json_object" && mode !== "prompt") ||
    value.capabilities.streaming !== false
  ) {
    throw new Error("Stored provider connection test is corrupt.");
  }
  return {
    fingerprint: value.fingerprint,
    testedAt: value.testedAt,
    providerOrigin: value.providerOrigin,
    capabilities: { structuredOutput: mode, streaming: false },
  };
}

function parseLocalState(value: unknown): OrganizerLocalState {
  if (!isRecord(value)) {
    return {
      provider: DEFAULT_PROVIDER_CONFIG,
      privacy: DEFAULT_PRIVACY_SETTINGS,
      workflow: DEFAULT_WORKFLOW_SETTINGS,
      customOrganizerPrompt: null,
      organizerRules: [],
      groupNamePreferences: [],
      connectionTest: null,
      persistentApiKey: null,
    };
  }
  try {
    const providerValue = isRecord(value.provider) ? value.provider : {};
    const privacyValue = isRecord(value.privacy) ? value.privacy : {};
    const workflowValue = isRecord(value.workflow) ? value.workflow : {};
    const level = privacyValue.level;
    const provider: OpenAICompatibleConfig = {
      ...DEFAULT_PROVIDER_CONFIG,
      origin:
        typeof providerValue.origin === "string"
          ? providerValue.origin
          : DEFAULT_PROVIDER_CONFIG.origin,
      endpointPath:
        typeof providerValue.endpointPath === "string"
          ? providerValue.endpointPath
          : DEFAULT_PROVIDER_CONFIG.endpointPath,
      model: typeof providerValue.model === "string" ? providerValue.model : "",
      customHeaders: {},
      extraBody: isRecord(providerValue.extraBody) ? providerValue.extraBody : {},
      temperature:
        typeof providerValue.temperature === "number"
          ? providerValue.temperature
          : undefined,
      reasoningEffort: parseStoredReasoningEffort(providerValue.reasoningEffort),
      reasoningOffMethod: parseStoredReasoningOffMethod(providerValue.reasoningOffMethod),
      reasoning: isRecord(providerValue.reasoning) ? providerValue.reasoning : undefined,
      openRouter: isRecord(providerValue.openRouter)
        ? {
            zdr: providerValue.openRouter.zdr === true,
            order: Array.isArray(providerValue.openRouter.order)
              ? providerValue.openRouter.order.filter((item): item is string => typeof item === "string")
              : undefined,
            sort:
              providerValue.openRouter.sort === "price" ||
              providerValue.openRouter.sort === "throughput" ||
              providerValue.openRouter.sort === "latency"
                ? providerValue.openRouter.sort
                : undefined,
            allowFallbacks: typeof providerValue.openRouter.allowFallbacks === "boolean"
              ? providerValue.openRouter.allowFallbacks
              : undefined,
            dataCollection:
              providerValue.openRouter.dataCollection === "allow" || providerValue.openRouter.dataCollection === "deny"
                ? providerValue.openRouter.dataCollection
                : undefined,
            requireParameters: providerValue.openRouter.requireParameters === true,
          }
        : undefined,
      manualStreamingEnabled: false,
    };
    const privacy: PrivacySettings = {
      level: level === 1 || level === 2 || level === 3 ? level : 2,
      includeExistingGroups: privacyValue.includeExistingGroups !== false,
      allowLocalNetworkTabs: privacyValue.allowLocalNetworkTabs !== false,
      allowFileTabs: privacyValue.allowFileTabs !== false,
      closeInactiveBlankTabs: privacyValue.closeInactiveBlankTabs === true,
      allowlist: Array.isArray(privacyValue.allowlist)
        ? normalizeDomainRules(privacyValue.allowlist.filter((item): item is string => typeof item === "string"))
        : [],
      denylist: Array.isArray(privacyValue.denylist)
        ? normalizeDomainRules(privacyValue.denylist.filter((item): item is string => typeof item === "string"))
        : [],
    };
    const workflow: WorkflowSettings = {
      organizeWithoutReview: workflowValue.organizeWithoutReview !== false,
      aiGroupColors: workflowValue.aiGroupColors !== false,
      organizeOnExtensionClick: workflowValue.organizeOnExtensionClick === true,
      pinUtilityPanelOpen: workflowValue.pinUtilityPanelOpen === true,
      alwaysShowCleanupReview: workflowValue.alwaysShowCleanupReview === true,
      inactiveSuggestionHours: parseSuggestionHours(
        workflowValue.inactiveSuggestionHours,
        DEFAULT_WORKFLOW_SETTINGS.inactiveSuggestionHours,
      ),
      lowValueSuggestionHours: parseSuggestionHours(
        workflowValue.lowValueSuggestionHours,
        DEFAULT_WORKFLOW_SETTINGS.lowValueSuggestionHours,
      ),
      includeInactivityDuration: workflowValue.includeInactivityDuration !== false,
    };
    return {
      provider,
      privacy,
      workflow,
      customOrganizerPrompt:
        typeof value.customOrganizerPrompt === "string"
          ? normalizeCustomOrganizerPrompt(value.customOrganizerPrompt)
          : null,
      organizerRules: normalizeOrganizerRules(value.organizerRules),
      groupNamePreferences: normalizeGroupNamePreferences(value.groupNamePreferences),
      connectionTest: parseConnectionTest(value.connectionTest),
      persistentApiKey:
        typeof value.persistentApiKey === "string" ? value.persistentApiKey : null,
    };
  } catch {
    throw new Error("Stored organizer settings are corrupt and were not used.");
  }
}

export async function readOrganizerState(): Promise<OrganizerStoredState> {
  const [localValues, sessionValues] = await Promise.all([
    chrome.storage.local.get(LOCAL_KEY),
    chrome.storage.session.get(Object.values(SESSION_KEYS)),
  ]);
  const local = parseLocalState(localValues[LOCAL_KEY]);
  const sessionApiKey = sessionValues[SESSION_KEYS.apiKey];
  const sessionHeaders = sessionValues[SESSION_KEYS.customHeaders];
  return {
    local,
    session: {
      apiKey:
        typeof sessionApiKey === "string"
          ? sessionApiKey
          : local.persistentApiKey ?? "",
      customHeaders: isRecord(sessionHeaders)
        ? Object.fromEntries(
            Object.entries(sessionHeaders).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {},
      immutableRequest:
        (sessionValues[SESSION_KEYS.immutableRequest] as ImmutableRequestBundle | undefined) ??
        null,
      providerJob:
        (sessionValues[SESSION_KEYS.providerJob] as ProviderJobResult | undefined) ?? null,
    },
  };
}

// Every write to the shared organizer local key goes through here. The popup
// saves settings while the worker records approvals into the same object, so
// the lock spans contexts: neither writer can lose the other's update.
async function mutateLocalState(
  update: (previous: OrganizerLocalState) => OrganizerLocalState,
): Promise<OrganizerStoredState> {
  await withCrossContextMutationLock(LOCAL_KEY, async () => {
    const previous = await readOrganizerState();
    await chrome.storage.local.set({ [LOCAL_KEY]: storedLocalState(update(previous.local)) });
  });
  return readOrganizerState();
}

export async function writeProviderSettings(
  config: OpenAICompatibleConfig,
  apiKey: string,
  persistApiKey: boolean,
): Promise<OrganizerStoredState> {
  const normalized = normalizeProviderConfig(config);
  await withCrossContextMutationLock(LOCAL_KEY, async () => {
    const previous = await readOrganizerState();
    const originChanged = previous.local.provider.origin !== normalized.origin;
    const local: OrganizerLocalState = {
      ...previous.local,
      provider: { ...normalized, customHeaders: {} },
      connectionTest: originChanged ? null : previous.local.connectionTest,
      persistentApiKey: persistApiKey ? apiKey : null,
    };
    await Promise.all([
      chrome.storage.local.set({ [LOCAL_KEY]: storedLocalState(local) }),
      chrome.storage.session.set({
        [SESSION_KEYS.apiKey]: apiKey,
        [SESSION_KEYS.customHeaders]: normalized.customHeaders,
      }),
    ]);
  });
  return readOrganizerState();
}

export async function writePrivacySettings(
  privacy: PrivacySettings,
): Promise<OrganizerStoredState> {
  return mutateLocalState((previous) => ({
    ...previous,
    privacy: {
      level: privacy.level,
      includeExistingGroups: privacy.includeExistingGroups,
      allowLocalNetworkTabs: privacy.allowLocalNetworkTabs,
      allowFileTabs: privacy.allowFileTabs,
      closeInactiveBlankTabs: privacy.closeInactiveBlankTabs,
      allowlist: normalizeDomainRules(privacy.allowlist),
      denylist: normalizeDomainRules(privacy.denylist),
    },
  }));
}

export async function writeWorkflowSettings(
  workflow: WorkflowSettings,
): Promise<OrganizerStoredState> {
  return mutateLocalState((previous) => ({
    ...previous,
    workflow: {
      organizeWithoutReview: workflow.organizeWithoutReview,
      aiGroupColors: workflow.aiGroupColors === true,
      organizeOnExtensionClick: workflow.organizeOnExtensionClick,
      pinUtilityPanelOpen: workflow.pinUtilityPanelOpen === true,
      alwaysShowCleanupReview: workflow.alwaysShowCleanupReview,
      inactiveSuggestionHours: parseSuggestionHours(
        workflow.inactiveSuggestionHours,
        DEFAULT_WORKFLOW_SETTINGS.inactiveSuggestionHours,
      ),
      lowValueSuggestionHours: parseSuggestionHours(
        workflow.lowValueSuggestionHours,
        DEFAULT_WORKFLOW_SETTINGS.lowValueSuggestionHours,
      ),
      includeInactivityDuration: workflow.includeInactivityDuration,
    },
  }));
}

export async function writeCustomOrganizerPrompt(
  prompt: string | null,
): Promise<OrganizerStoredState> {
  return mutateLocalState((previous) => ({
    ...previous,
    customOrganizerPrompt: prompt === null ? null : normalizeCustomOrganizerPrompt(prompt),
  }));
}

export async function writeOrganizerRules(
  rules: readonly OrganizerRule[],
): Promise<OrganizerStoredState> {
  return mutateLocalState((previous) => ({
    ...previous,
    organizerRules: normalizeOrganizerRules(rules),
  }));
}

export async function writeGroupNamePreferences(
  preferences: readonly GroupNamePreference[],
): Promise<OrganizerStoredState> {
  return mutateLocalState((previous) => ({
    ...previous,
    groupNamePreferences: normalizeGroupNamePreferences(preferences),
  }));
}

export async function recordGroupNameApprovals(
  names: readonly string[],
  now = Date.now(),
): Promise<OrganizerStoredState> {
  return mutateLocalState((previous) => ({
    ...previous,
    groupNamePreferences: normalizeGroupNamePreferences(
      recordApprovedGroupNames(previous.groupNamePreferences, names, now),
    ),
  }));
}

export async function writeConnectionTest(
  connectionTest: ConnectionTestRecord | null,
): Promise<OrganizerStoredState> {
  return mutateLocalState((previous) => ({ ...previous, connectionTest }));
}

export async function writeImmutableRequest(
  request: ImmutableRequestBundle,
): Promise<void> {
  await ensureSessionStorageCapacity({ [SESSION_KEYS.immutableRequest]: request });
  await chrome.storage.session.set({ [SESSION_KEYS.immutableRequest]: request });
}

export async function writeProviderJob(job: ProviderJobResult): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEYS.providerJob]: job });
}

// A background organize that is still requesting is owned by the service
// worker; erasing its record would make every page show idle while it runs.
// Only the worker settles it (done, failed, or cancelled).
export async function clearProviderJob(): Promise<void> {
  const values = await chrome.storage.session.get(SESSION_KEYS.providerJob);
  const job = values[SESSION_KEYS.providerJob] as ProviderJobResult | undefined;
  if (job?.status === "requesting" && job.ownerContextId === BACKGROUND_JOB_OWNER) return;
  await chrome.storage.session.remove(SESSION_KEYS.providerJob);
}

export async function cancelRequestingProviderJob(
  reason: ProviderCancellationReason,
  ownerContextId?: string,
): Promise<ProviderJobResult | null> {
  const values = await chrome.storage.session.get(SESSION_KEYS.providerJob);
  const job = (values[SESSION_KEYS.providerJob] as ProviderJobResult | undefined) ?? null;
  if (
    !job ||
    job.status !== "requesting" ||
    (ownerContextId !== undefined && job.ownerContextId !== ownerContextId)
  ) {
    return job;
  }
  const cancelled: ProviderJobResult = {
    ...job,
    status: "cancelled",
    finishedAt: Date.now(),
    error:
      reason === "editor_closed"
        ? "Organizing stopped because its window was closed. Nothing moved."
        : reason === "owner_lease_expired"
          ? "Organizing stopped because the popup lost its connection to the window. Nothing moved. Organize again."
          : "Organizing was cancelled. Nothing moved.",
    cancellationReason: reason,
  };
  await writeProviderJob(cancelled);
  return cancelled;
}
