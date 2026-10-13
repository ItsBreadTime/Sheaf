import type { ChromeGroupColor } from "./group-colors";

export type PrivacyLevel = 1 | 2 | 3;

export type RecencyBucket =
  | "under_20_minutes"
  | "20_to_59_minutes"
  | "1_to_6_hours"
  | "6_to_24_hours"
  | "over_24_hours"
  | "unknown";

export interface PrivacySettings {
  level: PrivacyLevel;
  includeExistingGroups: boolean;
  allowLocalNetworkTabs: boolean;
  allowFileTabs: boolean;
  closeInactiveBlankTabs: boolean;
  allowlist: string[];
  denylist: string[];
}

export interface WorkflowSettings {
  organizeWithoutReview: boolean;
  aiGroupColors: boolean;
  organizeOnExtensionClick: boolean;
  pinUtilityPanelOpen: boolean;
  alwaysShowCleanupReview: boolean;
  inactiveSuggestionHours: number;
  lowValueSuggestionHours: number;
  includeInactivityDuration: boolean;
}

export type OrganizerRule =
  | {
      id: string;
      kind: "assign_location";
      locationPattern: string;
      groupName: string;
    }
  | {
      id: string;
      kind: "keep_location";
      locationPattern: string;
    }
  | {
      id: string;
      kind: "rename_group";
      fromName: string;
      toName: string;
    }
  | {
      id: string;
      kind: "never_clutter_location";
      locationPattern: string;
    }
  | {
      /** Blocks auto-filing only; organize is unaffected and never sees the rule. */
      id: string;
      kind: "never_file_location";
      locationPattern: string;
      /** When set, only filing into this group (by title) is blocked. */
      groupName?: string;
    };

export type SanitizedOrganizerRule = OrganizerRule extends infer Rule
  ? Rule extends OrganizerRule
    ? Omit<Rule, "id">
    : never
  : never;

export interface GroupNamePreference {
  name: string;
  approvalCount: number;
  lastApprovedAt: number;
}

export type OrganizationScope =
  | { mode: "window" }
  | { mode: "selected_tabs" }
  | { mode: "group"; groupId: number }
  | { mode: "ungrouped" }
  | { mode: "exclude_groups"; groupIds: number[] };

export interface SanitizedTabRecord {
  id: number;
  title: string;
  domain: string;
  /** Always emitted by current request builders; optional only for stored legacy requests. */
  isCurrentlyGrouped?: boolean;
  hostname?: string;
  path?: string;
  existingGroup?: string;
  openerTabId?: number;
  /** Set on the less recently used copies of a tab whose full URL is identical. */
  duplicateOfTabId?: number;
  recencyBucket: RecencyBucket;
  inactiveForMinutes?: number;
  meetsLowValueInactivityThreshold?: boolean;
  isActive: boolean;
  isAudible: boolean;
}

export interface SanitizedOrganizationRequest {
  schemaVersion: 1;
  privacyLevel: PrivacyLevel;
  /** Missing only on stored legacy requests. */
  groupColorMode?: "deterministic" | "ai";
  existingGroupMetadataIncluded: boolean;
  inactivityPolicy: {
    generalSuggestionAfterHours: number;
    lowValueSuggestionAfterHours: number;
    closingRequiresManualReview: true;
  };
  organizerRules?: SanitizedOrganizerRule[];
  preferredGroupNames?: string[];
  tabs: SanitizedTabRecord[];
}

export interface ExcludedRequestTab {
  browserTabId: number;
  title: string;
  reason: string;
}

export interface ImmutableRequestBundle {
  approvedRequest: SanitizedOrganizationRequest;
  requestJson: string;
  submittedTabIds: number[];
  ephemeralToBrowserTabId: Record<number, number>;
  excludedTabs: ExcludedRequestTab[];
  scope?: OrganizationScope;
  outOfScopeTabCount?: number;
  byteLength: number;
}

export interface OpenAICompatibleConfig {
  origin: string;
  endpointPath: string;
  model: string;
  customHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  /** How reasoning effort "none" is sent; unset means "auto". */
  reasoningOffMethod?: ReasoningOffMethod;
  reasoning?: Record<string, unknown>;
  openRouter?: OpenRouterProviderPreferences;
  manualStreamingEnabled: boolean;
}

export type OpenRouterProviderSort = "price" | "throughput" | "latency";
export type OpenRouterDataCollection = "allow" | "deny";

export interface OpenRouterProviderPreferences {
  zdr?: boolean;
  order?: string[];
  sort?: OpenRouterProviderSort;
  allowFallbacks?: boolean;
  dataCollection?: OpenRouterDataCollection;
  requireParameters?: boolean;
}

export interface ProviderSecrets {
  apiKey: string;
  persistentApiKey: boolean;
}

export type StructuredOutputMode = "json_schema" | "json_object" | "prompt";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ReasoningOffMethod =
  | "auto"
  | "reasoning_effort"
  | "thinking"
  | "enable_thinking"
  | "chat_template_kwargs"
  | "think"
  | "no_think_prompt";

export interface ProviderCapabilities {
  structuredOutput: StructuredOutputMode;
  streaming: false;
}

export interface ConnectionTestRecord {
  fingerprint: string;
  testedAt: number;
  providerOrigin: string;
  capabilities: ProviderCapabilities;
}

export interface OrganizerLocalState {
  provider: OpenAICompatibleConfig;
  privacy: PrivacySettings;
  workflow: WorkflowSettings;
  customOrganizerPrompt: string | null;
  organizerRules: OrganizerRule[];
  groupNamePreferences: GroupNamePreference[];
  connectionTest: ConnectionTestRecord | null;
  persistentApiKey: string | null;
}

export interface OrganizerSessionState {
  apiKey: string;
  customHeaders: Record<string, string>;
  immutableRequest: ImmutableRequestBundle | null;
  providerJob: ProviderJobResult | null;
}

export interface OrganizerStoredState {
  local: OrganizerLocalState;
  session: OrganizerSessionState;
}

export interface ProposedGroupResponse {
  temporaryId: string;
  title: string;
  color?: ChromeGroupColor;
  tabIds: number[];
}

export interface ValidatedProposal {
  schemaVersion: 1;
  groups: ProposedGroupResponse[];
  /** Tabs outside new groups, in the order loose tabs should be arranged. */
  untouchedTabIds: number[];
  /** Subset of untouchedTabIds that leave their current native group. */
  ungroupTabIds?: number[];
  lowValueTabIds?: number[];
}

export type ProviderJobStatus =
  | "idle"
  | "requesting"
  | "validated"
  | "cancelled"
  | "failed";

export interface ProviderJobResult {
  status: ProviderJobStatus;
  startedAt: number | null;
  finishedAt: number | null;
  proposal: ValidatedProposal | null;
  repairAttempted: boolean;
  error: string | null;
  usage?: ProviderUsage;
  metrics?: GenerationMetrics;
  /** Set once a background run that skips review has started its transaction. */
  transactionId?: string | null;
  ownerContextId?: string | null;
  cancellationReason?:
    | "editor_closed"
    | "owner_lease_expired"
    | "user_cancelled"
    | null;
}

export interface ProviderUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens?: number | null;
}

/** Timing for one organize request, including a repair round-trip when one ran. */
export interface GenerationMetrics {
  /** Configured reasoning effort; null means the provider default was used. */
  reasoningEffort: ReasoningEffort | null;
  /** Request start to the first streamed token; null when the provider did not stream. */
  timeToFirstTokenMs: number | null;
  /** Wall time across every provider request in the run. */
  providerMs: number;
  /** Output tokens per second while tokens were arriving; null when unmeasurable. */
  outputTokensPerSecond: number | null;
  streamed: boolean;
}
