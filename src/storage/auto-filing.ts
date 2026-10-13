import { normalizeFilingThresholds } from "../decision/filing-policy";
import { DEFAULT_DECISION_ENDPOINT_PATH, type DecisionAnswers, type DecisionProtocol, type DecisionRequest } from "../decision/types";
import { appendFilingLog } from "../decision/filing-log";
import { emptyEscalationState, type WindowEscalationState } from "../decision/escalation";
import type { DecisionConnection } from "../decision/decision-client";
import { validateDecisionExtraBody } from "../decision/decision-client";
import { normalizeCustomHeaders, normalizeProviderEndpoint } from "../provider/request-policy";
import {
  DEFAULT_AUTO_FILING_SETTINGS,
  type AutoFilingSettings,
  type AutoFilingSuggestion,
  type AutoFilingViewState,
  type DecisionCalibration,
  type DecisionModelConfig,
  type DecisionProbeResult,
  type FilingLogEntry,
  type LastDecisionRequest,
} from "../shared/auto-filing-types";
import type { OrganizerStoredState } from "../shared/organizer-types";
import { withStorageMutationLock } from "./mutation-lock";

export const AUTO_FILING_LOCAL_KEY = "autoFilingLocalState";
export const AUTO_FILING_SESSION_KEYS = {
  apiKey: "autoFilingApiKey",
  customHeaders: "autoFilingCustomHeaders",
  log: "autoFilingLog",
  sticky: "autoFilingStickyTabIds",
  escalation: "autoFilingEscalation",
  suggestion: "autoFilingSuggestion",
  lastRequest: "autoFilingLastRequest",
} as const;

export const DEFAULT_CHAT_DECISION_ENDPOINT_PATH = "/v1/chat/completions";
const DEFAULT_DECISION_TIMEOUT_MS = 10_000;
const MAX_CALIBRATIONS = 20;
const MAX_OPTED_OUT = 200;

export function defaultDecisionModelConfig(protocol: DecisionProtocol = "decision_api"): DecisionModelConfig {
  return {
    protocol,
    origin: "",
    endpointPath: protocol === "decision_api" ? DEFAULT_DECISION_ENDPOINT_PATH : DEFAULT_CHAT_DECISION_ENDPOINT_PATH,
    model: "",
    customHeaders: {},
    extraBody: {},
    useOrganizerConnection: false,
    apiKeyStorage: "session",
    disableReasoning: false,
    timeoutMs: DEFAULT_DECISION_TIMEOUT_MS,
  };
}

interface AutoFilingLocalState {
  settings: AutoFilingSettings;
  persistentApiKey: string | null;
  probe: DecisionProbeResult | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const protocolOf = (value: unknown): DecisionProtocol | null =>
  value === "decision_api" || value === "chat" ? value : null;

function parseDecisionModel(value: unknown): DecisionModelConfig | null {
  const item = record(value);
  const protocol = protocolOf(item.protocol);
  if (!protocol) return null;
  const defaults = defaultDecisionModelConfig(protocol);
  const timeout = typeof item.timeoutMs === "number" && Number.isFinite(item.timeoutMs)
    ? Math.min(60_000, Math.max(1_000, Math.round(item.timeoutMs)))
    : defaults.timeoutMs;
  return {
    protocol,
    origin: typeof item.origin === "string" ? item.origin : "",
    endpointPath: typeof item.endpointPath === "string" && item.endpointPath ? item.endpointPath : defaults.endpointPath,
    model: typeof item.model === "string" ? item.model.slice(0, 200) : "",
    customHeaders: {},
    extraBody: record(item.extraBody),
    useOrganizerConnection: item.useOrganizerConnection === true && protocol === "chat",
    apiKeyStorage: item.apiKeyStorage === "persistent" ? "persistent" : "session",
    disableReasoning: item.disableReasoning === true,
    timeoutMs: timeout,
  };
}

export function parseCalibration(value: unknown): DecisionCalibration | null {
  const item = record(value);
  const protocol = protocolOf(item.protocol);
  const thresholds = normalizeFilingThresholds(item.thresholds);
  const model = typeof item.model === "string" ? item.model.trim().slice(0, 200) : "";
  const style = item.style === "json" || item.style === "per_group" ? item.style : "text";
  return protocol && thresholds && model ? { protocol, model, style, thresholds } : null;
}

/**
 * Reads a calibration file from the filing benchmark (`--calibrations`), a bare
 * array of calibrations, or a single one. Entries that aren't valid are
 * dropped; a file with none left is an error.
 */
export function parseCalibrationImport(text: string): DecisionCalibration[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("The calibration file is not valid JSON."); }
  const root = record(parsed);
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(root.calibrations) ? root.calibrations : [parsed];
  const calibrations = entries.map(parseCalibration).filter((entry): entry is DecisionCalibration => entry !== null);
  if (calibrations.length === 0) throw new Error("The file has no calibration the extension can use.");
  return calibrations;
}

const sameCalibration = (left: Pick<DecisionCalibration, "protocol" | "model">, right: Pick<DecisionCalibration, "protocol" | "model">): boolean =>
  left.protocol === right.protocol && left.model.toLocaleLowerCase() === right.model.toLocaleLowerCase();

/** Imported calibrations replace any earlier one for the same (protocol, model) pair. */
export function mergeCalibrations(
  current: readonly DecisionCalibration[],
  imported: readonly DecisionCalibration[],
): DecisionCalibration[] {
  const kept = current.filter((item) => !imported.some((next) => sameCalibration(item, next)));
  return [...imported, ...kept].slice(0, MAX_CALIBRATIONS);
}

export function parseAutoFilingSettings(value: unknown): AutoFilingSettings {
  const item = record(value);
  const defaults = DEFAULT_AUTO_FILING_SETTINGS;
  const rate = item.maxFilingsPerWindowPerMinute;
  return {
    enabled: item.enabled === true,
    refileGroupedTabs: item.refileGroupedTabs === true,
    crossWindow: item.crossWindow === true,
    decisionModel: parseDecisionModel(item.decisionModel),
    calibrations: Array.isArray(item.calibrations)
      ? item.calibrations.map(parseCalibration).filter((entry): entry is DecisionCalibration => entry !== null).slice(0, MAX_CALIBRATIONS)
      : [],
    confidence: item.confidence === "conservative" || item.confidence === "eager" ? item.confidence : "balanced",
    escalation: item.escalation === "off" || item.escalation === "organize" ? item.escalation : "suggest",
    escalationWholeWindow: item.escalationWholeWindow === true,
    notifyOnFiling: item.notifyOnFiling === true,
    optedOutGroupTitles: Array.isArray(item.optedOutGroupTitles)
      ? [...new Set(item.optedOutGroupTitles.filter((title): title is string => typeof title === "string")
          .map((title) => title.trim().slice(0, 200)).filter(Boolean))].slice(0, MAX_OPTED_OUT)
      : [],
    maxFilingsPerWindowPerMinute: typeof rate === "number" && Number.isFinite(rate)
      ? Math.min(60, Math.max(1, Math.round(rate)))
      : defaults.maxFilingsPerWindowPerMinute,
  };
}

function parseProbe(value: unknown): DecisionProbeResult | null {
  const item = record(value);
  const protocol = protocolOf(item.protocol);
  const source = item.probabilities;
  return protocol && typeof item.testedAt === "number" && typeof item.model === "string" &&
    typeof item.latencyMs === "number" && (source === "native" || source === "logprobs" || source === "confidence")
    ? { testedAt: item.testedAt, protocol, model: item.model, latencyMs: item.latencyMs, probabilities: source }
    : null;
}

async function readLocal(): Promise<AutoFilingLocalState> {
  const values = await chrome.storage.local.get(AUTO_FILING_LOCAL_KEY);
  const root = record(values[AUTO_FILING_LOCAL_KEY]);
  return {
    settings: parseAutoFilingSettings(root.settings),
    persistentApiKey: typeof root.persistentApiKey === "string" ? root.persistentApiKey : null,
    probe: parseProbe(root.probe),
  };
}

export async function readAutoFilingSettings(): Promise<AutoFilingSettings> {
  return (await readLocal()).settings;
}

/** Validates the provider fields; the model may be blank only when nothing is configured. */
function normalizeDecisionModelConfig(config: DecisionModelConfig): DecisionModelConfig {
  if (!config.model.trim()) throw new Error("Enter the decision model's name.");
  validateDecisionExtraBody(config.protocol, config.extraBody);
  if (config.useOrganizerConnection) {
    if (config.protocol !== "chat") throw new Error("Reusing the organizer connection needs the chat protocol.");
    return { ...config, origin: "", customHeaders: {}, model: config.model.trim().slice(0, 200) };
  }
  const endpoint = normalizeProviderEndpoint(config.origin, config.endpointPath);
  return {
    ...config,
    origin: endpoint.origin,
    endpointPath: endpoint.endpointPath,
    model: config.model.trim().slice(0, 200),
    customHeaders: normalizeCustomHeaders(config.customHeaders),
  };
}

export async function writeAutoFilingSettings(settings: AutoFilingSettings): Promise<AutoFilingSettings> {
  return withStorageMutationLock(AUTO_FILING_LOCAL_KEY, async () => {
    const local = await readLocal();
    const next = parseAutoFilingSettings({
      ...settings,
      // The provider is saved only through writeDecisionModel, which verifies it.
      decisionModel: local.settings.decisionModel,
    });
    await chrome.storage.local.set({ [AUTO_FILING_LOCAL_KEY]: { ...local, settings: next } });
    return next;
  });
}

export async function writeDecisionModel(options: {
  config: DecisionModelConfig | null;
  apiKey: string;
}): Promise<void> {
  await withStorageMutationLock(AUTO_FILING_LOCAL_KEY, async () => {
    const local = await readLocal();
    const config = options.config ? normalizeDecisionModelConfig(options.config) : null;
    const persistent = config?.apiKeyStorage === "persistent" && !config.useOrganizerConnection;
    await Promise.all([
      chrome.storage.local.set({
        [AUTO_FILING_LOCAL_KEY]: {
          settings: { ...local.settings, decisionModel: config ? { ...config, customHeaders: {} } : null },
          persistentApiKey: persistent ? options.apiKey : null,
          probe: null,
        },
      }),
      chrome.storage.session.set({
        [AUTO_FILING_SESSION_KEYS.apiKey]: persistent || !config ? "" : options.apiKey,
        [AUTO_FILING_SESSION_KEYS.customHeaders]: config?.customHeaders ?? {},
      }),
    ]);
  });
}

export async function writeDecisionProbe(probe: DecisionProbeResult | null): Promise<void> {
  await withStorageMutationLock(AUTO_FILING_LOCAL_KEY, async () => {
    const local = await readLocal();
    await chrome.storage.local.set({ [AUTO_FILING_LOCAL_KEY]: { ...local, probe } });
  });
}

/** The connection the decision model is called with, or null when none is configured. */
export async function readDecisionConnection(organizer: OrganizerStoredState): Promise<DecisionConnection | null> {
  const [local, session] = await Promise.all([
    readLocal(),
    chrome.storage.session.get([AUTO_FILING_SESSION_KEYS.apiKey, AUTO_FILING_SESSION_KEYS.customHeaders]),
  ]);
  const config = local.settings.decisionModel;
  if (!config?.model) return null;
  if (config.useOrganizerConnection) {
    const provider = organizer.local.provider;
    return {
      protocol: "chat",
      origin: provider.origin,
      endpointPath: provider.endpointPath,
      model: config.model,
      apiKey: organizer.session.apiKey,
      customHeaders: organizer.session.customHeaders,
      extraBody: config.extraBody,
      timeoutMs: config.timeoutMs,
      disableReasoning: config.disableReasoning,
      ...(provider.openRouter ? { openRouter: provider.openRouter } : {}),
    };
  }
  const headers = record(session[AUTO_FILING_SESSION_KEYS.customHeaders]);
  const sessionKey = session[AUTO_FILING_SESSION_KEYS.apiKey];
  return {
    protocol: config.protocol,
    origin: config.origin,
    endpointPath: config.endpointPath,
    model: config.model,
    apiKey: config.apiKeyStorage === "persistent" ? local.persistentApiKey ?? "" : typeof sessionKey === "string" ? sessionKey : "",
    customHeaders: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    extraBody: config.extraBody,
    timeoutMs: config.timeoutMs,
    disableReasoning: config.disableReasoning,
  };
}

export function calibrationFor(
  settings: AutoFilingSettings,
  connection: Pick<DecisionConnection, "protocol" | "model">,
): DecisionCalibration | null {
  return settings.calibrations.find((item) => sameCalibration(item, connection)) ?? null;
}

// --- Session state ---------------------------------------------------------

function parseLogEntry(value: unknown): FilingLogEntry | null {
  const item = record(value);
  const location = (entry: unknown): number | null | undefined =>
    entry === null ? null : typeof entry === "number" && Number.isInteger(entry) ? entry : undefined;
  const from = location(item.fromGroupId);
  const to = location(item.toGroupId);
  if (
    typeof item.id !== "string" || typeof item.tabId !== "number" || typeof item.windowId !== "number" ||
    from === undefined || to === undefined || typeof item.previousIndex !== "number" ||
    (item.source !== "rule" && item.source !== "decision_model") || typeof item.confidence !== "number" ||
    typeof item.at !== "number"
  ) return null;
  return {
    id: item.id,
    tabId: item.tabId,
    windowId: item.windowId,
    fromGroupId: from,
    toGroupId: to,
    previousIndex: item.previousIndex,
    ...(typeof item.previousWindowId === "number" ? { previousWindowId: item.previousWindowId } : {}),
    source: item.source,
    confidence: item.confidence,
    at: item.at,
    tabTitle: typeof item.tabTitle === "string" ? item.tabTitle : "",
    site: typeof item.site === "string" ? item.site : "",
    fromGroupTitle: typeof item.fromGroupTitle === "string" ? item.fromGroupTitle : null,
    toGroupTitle: typeof item.toGroupTitle === "string" ? item.toGroupTitle : null,
  };
}

export async function readFilingLog(): Promise<FilingLogEntry[]> {
  const values = await chrome.storage.session.get(AUTO_FILING_SESSION_KEYS.log);
  const raw = values[AUTO_FILING_SESSION_KEYS.log];
  return Array.isArray(raw) ? raw.map(parseLogEntry).filter((entry): entry is FilingLogEntry => entry !== null) : [];
}

export async function recordFiling(entry: FilingLogEntry): Promise<void> {
  await withStorageMutationLock(AUTO_FILING_SESSION_KEYS.log, async () => {
    await chrome.storage.session.set({ [AUTO_FILING_SESSION_KEYS.log]: appendFilingLog(await readFilingLog(), entry) });
  });
}

export async function removeFilingLogEntry(id: string): Promise<void> {
  await withStorageMutationLock(AUTO_FILING_SESSION_KEYS.log, async () => {
    const log = await readFilingLog();
    await chrome.storage.session.set({ [AUTO_FILING_SESSION_KEYS.log]: log.filter((entry) => entry.id !== id) });
  });
}

export async function readStickyTabIds(): Promise<Set<number>> {
  const values = await chrome.storage.session.get(AUTO_FILING_SESSION_KEYS.sticky);
  const raw = values[AUTO_FILING_SESSION_KEYS.sticky];
  return new Set(Array.isArray(raw) ? raw.filter((id): id is number => typeof id === "number") : []);
}

export async function markTabsSticky(tabIds: readonly number[]): Promise<void> {
  if (tabIds.length === 0) return;
  await withStorageMutationLock(AUTO_FILING_SESSION_KEYS.sticky, async () => {
    const sticky = await readStickyTabIds();
    tabIds.forEach((id) => sticky.add(id));
    // Tab IDs are never reused within a session; the cap only bounds a very long one.
    await chrome.storage.session.set({ [AUTO_FILING_SESSION_KEYS.sticky]: [...sticky].slice(-2_000) });
  });
}

async function readEscalationStates(): Promise<Record<number, WindowEscalationState>> {
  const values = await chrome.storage.session.get(AUTO_FILING_SESSION_KEYS.escalation);
  const raw = record(values[AUTO_FILING_SESSION_KEYS.escalation]);
  const states: Record<number, WindowEscalationState> = {};
  for (const [key, value] of Object.entries(raw)) {
    const item = record(value);
    states[Number(key)] = {
      backlog: Array.isArray(item.backlog) ? item.backlog.filter((id): id is number => typeof id === "number") : [],
      lastEscalatedAt: typeof item.lastEscalatedAt === "number" ? item.lastEscalatedAt : null,
    };
  }
  return states;
}

export async function updateEscalationState(
  windowId: number,
  update: (state: WindowEscalationState) => WindowEscalationState,
): Promise<WindowEscalationState> {
  return withStorageMutationLock(AUTO_FILING_SESSION_KEYS.escalation, async () => {
    const states = await readEscalationStates();
    const next = update(states[windowId] ?? emptyEscalationState());
    states[windowId] = next;
    await chrome.storage.session.set({ [AUTO_FILING_SESSION_KEYS.escalation]: states });
    return next;
  });
}

export async function forgetEscalationWindow(windowId: number): Promise<void> {
  await withStorageMutationLock(AUTO_FILING_SESSION_KEYS.escalation, async () => {
    const states = await readEscalationStates();
    if (!(windowId in states)) return;
    delete states[windowId];
    await chrome.storage.session.set({ [AUTO_FILING_SESSION_KEYS.escalation]: states });
  });
}

export async function readSuggestion(): Promise<AutoFilingSuggestion | null> {
  const values = await chrome.storage.session.get(AUTO_FILING_SESSION_KEYS.suggestion);
  const item = record(values[AUTO_FILING_SESSION_KEYS.suggestion]);
  return typeof item.windowId === "number" && typeof item.ungroupedCount === "number" && typeof item.at === "number"
    ? { windowId: item.windowId, ungroupedCount: item.ungroupedCount, at: item.at }
    : null;
}

export async function writeSuggestion(suggestion: AutoFilingSuggestion | null): Promise<void> {
  await chrome.storage.session.set({ [AUTO_FILING_SESSION_KEYS.suggestion]: suggestion });
}

function isDecisionRequest(value: unknown): value is DecisionRequest {
  const questions = record(record(value).questions);
  return Object.keys(questions).length > 0 &&
    Object.values(questions).every((question) => {
      const item = record(question);
      return (item.type === "choice" || item.type === "noul") && typeof item.instructions === "string";
    });
}

/** Written by this extension only, so a light shape check is enough for display. */
function parseOutcome(value: unknown): Pick<LastDecisionRequest, "outcome"> {
  const outcome = record(value);
  if (outcome.status === "failed" && typeof outcome.error === "string") {
    return { outcome: { status: "failed", error: outcome.error } };
  }
  if (outcome.status === "answered" && typeof outcome.latencyMs === "number") {
    return { outcome: { status: "answered", answers: record(outcome.answers) as DecisionAnswers, latencyMs: outcome.latencyMs } };
  }
  return {};
}

export async function writeLastDecisionRequest(entry: LastDecisionRequest | null): Promise<void> {
  await chrome.storage.session.set({ [AUTO_FILING_SESSION_KEYS.lastRequest]: entry });
}

export async function readAutoFilingView(): Promise<AutoFilingViewState> {
  const [local, log, suggestion, session] = await Promise.all([
    readLocal(),
    readFilingLog(),
    readSuggestion(),
    chrome.storage.session.get([AUTO_FILING_SESSION_KEYS.lastRequest, AUTO_FILING_SESSION_KEYS.apiKey]),
  ]);
  const last = record(session[AUTO_FILING_SESSION_KEYS.lastRequest]);
  const protocol = protocolOf(last.protocol);
  const config = local.settings.decisionModel;
  return {
    settings: local.settings,
    probe: local.probe,
    log,
    suggestion,
    lastRequest: protocol && typeof last.at === "number" && typeof last.body === "string"
      ? {
        at: last.at,
        protocol,
        body: last.body,
        ...(typeof last.model === "string" ? { model: last.model } : {}),
        ...(isDecisionRequest(last.request) ? { request: last.request } : {}),
        ...(parseOutcome(last.outcome)),
      }
      : null,
    hasApiKey: config?.apiKeyStorage === "persistent"
      ? Boolean(local.persistentApiKey)
      : typeof session[AUTO_FILING_SESSION_KEYS.apiKey] === "string" && session[AUTO_FILING_SESSION_KEYS.apiKey] !== "",
  };
}
