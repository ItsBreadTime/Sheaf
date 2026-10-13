import type { ConfidencePreset, FilingThresholds } from "../decision/filing-policy";
import type { FilingRequestStyle } from "../decision/filing-state";
import type { DecisionAnswers, DecisionProtocol, DecisionRequest } from "../decision/types";

export type EscalationMode = "off" | "suggest" | "organize";
export type DecisionKeyStorage = "session" | "persistent";

export interface DecisionModelConfig {
  protocol: DecisionProtocol;
  origin: string;
  endpointPath: string;
  /** Free text: whatever the server expects. */
  model: string;
  /** Session-only unless the key is persisted; never written to local storage with the config. */
  customHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  /** Reuse the organizer provider's origin, key, and headers with the chat protocol. */
  useOrganizerConnection: boolean;
  apiKeyStorage: DecisionKeyStorage;
  /** Chat protocol only: send the organizer's reasoning-off body, for thinking models. */
  disableReasoning: boolean;
  timeoutMs: number;
}

/**
 * Thresholds measured by the filing benchmark for one (protocol, model) pair.
 * They become that model's Balanced preset; Conservative and Eager are derived
 * from them. A model without a calibration uses Conservative defaults.
 */
export interface DecisionCalibration {
  protocol: DecisionProtocol;
  model: string;
  style: FilingRequestStyle;
  thresholds: FilingThresholds;
}

export interface AutoFilingSettings {
  enabled: boolean;
  /** Grouped tabs that navigate to another site. Off by default: the benchmark put it just over the false-move-out gate. */
  refileGroupedTabs: boolean;
  crossWindow: boolean;
  decisionModel: DecisionModelConfig | null;
  calibrations: DecisionCalibration[];
  confidence: ConfidencePreset;
  escalation: EscalationMode;
  /** Organize automatically: the whole window instead of only ungrouped tabs. */
  escalationWholeWindow: boolean;
  notifyOnFiling: boolean;
  /** Group titles the user opted out of, matched like protection rules. */
  optedOutGroupTitles: string[];
  maxFilingsPerWindowPerMinute: number;
}

export const DEFAULT_AUTO_FILING_SETTINGS: AutoFilingSettings = {
  enabled: false,
  refileGroupedTabs: false,
  crossWindow: false,
  decisionModel: null,
  calibrations: [],
  confidence: "balanced",
  escalation: "suggest",
  escalationWholeWindow: false,
  notifyOnFiling: false,
  optedOutGroupTitles: [],
  maxFilingsPerWindowPerMinute: 6,
};

/** `null` means ungrouped. */
export type FilingLocation = number | null;

export type FilingSource = "rule" | "decision_model";

export interface FilingLogEntry {
  /** Unique per filing, so the popup can undo one row. */
  id: string;
  tabId: number;
  windowId: number;
  fromGroupId: FilingLocation;
  toGroupId: FilingLocation;
  previousIndex: number;
  /** Set for a cross-window move, so undo can return the tab. */
  previousWindowId?: number;
  source: FilingSource;
  confidence: number;
  at: number;
  /** Local display only (session storage): never sent and never in diagnostics. */
  tabTitle: string;
  site: string;
  fromGroupTitle: string | null;
  toGroupTitle: string | null;
}

export interface DecisionProbeResult {
  testedAt: number;
  protocol: DecisionProtocol;
  model: string;
  latencyMs: number;
  /** Where probabilities came from; `confidence` means the model returns none. */
  probabilities: "native" | "logprobs" | "confidence";
}

export interface AutoFilingSuggestion {
  windowId: number;
  ungroupedCount: number;
  at: number;
}

/**
 * The last decision request, kept in session storage for the settings preview:
 * the wire body, the request it was built from (for the readable view), and
 * what came back once the model answered.
 */
export interface LastDecisionRequest {
  at: number;
  protocol: DecisionProtocol;
  body: string;
  model?: string;
  request?: DecisionRequest;
  outcome?:
    | { status: "answered"; answers: DecisionAnswers; latencyMs: number }
    | { status: "failed"; error: string };
}

export interface AutoFilingViewState {
  settings: AutoFilingSettings;
  probe: DecisionProbeResult | null;
  /** Newest first. */
  log: FilingLogEntry[];
  suggestion: AutoFilingSuggestion | null;
  /** The last decision request as sent, for the settings preview. */
  lastRequest: LastDecisionRequest | null;
  hasApiKey: boolean;
}
