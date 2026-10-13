import {
  organizeCostPerThousand,
  projectedYearlyCostUsd,
  readUsageStats,
  resetUsageStats,
  sumUsageCounters,
  USAGE_DAYS_KEPT,
  USAGE_STATS_KEY,
  usageCostUsd,
  usageDayKey,
  writeUsagePricing,
} from "../../storage/usage-stats";
import {
  USAGE_KINDS,
  type UsageCounters,
  type UsageKind,
  type UsagePricing,
  type UsageStatsState,
} from "../../shared/usage-types";
import { element } from "../shared/helpers";
import { popupState } from "./popup-store";

/**
 * Settings → Usage: requests, tokens, and cost for each kind of provider call.
 * The numbers redraw in place when a request lands, so the price fields beside
 * them are never rebuilt under the user's typing.
 */

export interface UsagePanelContext {
  input(value: string, type?: HTMLInputElement["type"]): HTMLInputElement;
  field(label: string, control: HTMLElement, help?: string): HTMLElement;
  button(
    label: string,
    variant: "primary" | "secondary" | "quiet" | "danger",
    onClick: () => void,
    options?: { disabled?: boolean; actionName?: string; busyLabel?: string },
  ): HTMLButtonElement;
  perform(actionName: string, action: () => Promise<void>): Promise<void>;
}

type UsageRange = "today" | "week" | "month" | "all";

const RANGE_LABELS: ReadonlyArray<readonly [UsageRange, string]> = [
  ["today", "Today"],
  ["week", "7 days"],
  ["month", "30 days"],
  ["all", "All time"],
];

const KIND_LABELS: Record<UsageKind, { title: string; copy: string }> = {
  llm: { title: "Organizer LLM", copy: "Organize runs, repairs, search reranking, connection tests" },
  decision: { title: "Decision model", copy: "Auto-filing questions and its connection check" },
  embedding: { title: "Embeddings", copy: "Semantic index builds and search queries" },
};

let context: UsagePanelContext | null = null;
let stats: UsageStatsState | null = null;
let range: UsageRange = "all";
let resetArmed = false;
/** The live blocks, redrawn in place on storage changes. */
let liveBlock: HTMLElement | null = null;
let featureBlock: HTMLElement | null = null;

export function setUsagePanelContext(next: UsagePanelContext): void {
  context = next;
}

function ui(): UsagePanelContext {
  if (!context) throw new Error("Usage UI is not initialized.");
  return context;
}

export async function loadUsageStats(): Promise<UsageStatsState> {
  stats = await readUsageStats();
  return stats;
}

export function usageStats(): UsageStatsState | null {
  return stats;
}

/** Redraws only the numbers when a request is recorded while Settings is open. */
export function handleUsageStorageChange(changes: Record<string, chrome.storage.StorageChange>, areaName: string): void {
  if (areaName !== "local" || !changes[USAGE_STATS_KEY]) return;
  void loadUsageStats().then(() => {
    if (liveBlock?.isConnected) liveBlock.replaceChildren(...renderLiveContent());
    if (featureBlock?.isConnected) featureBlock.replaceChildren(...renderFeatureContent());
  }).catch(() => undefined);
}

const numberFormat = new Intl.NumberFormat();
const compactFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function tokens(value: number): string {
  return value >= 100_000 ? compactFormat.format(value) : numberFormat.format(value);
}

function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(value < 10 ? 3 : 2)}`;
}

function countersFor(state: UsageStatsState, kind: UsageKind): UsageCounters {
  if (range === "all") return state.totals[kind];
  const days = range === "today" ? 1 : range === "week" ? 7 : USAGE_DAYS_KEPT;
  const now = Date.now();
  const keys = Array.from({ length: days }, (_, offset) => usageDayKey(now - offset * 86_400_000));
  return sumUsageCounters(keys.map((key) => state.days[key]?.[kind]));
}

function costLabel(counters: UsageCounters, pricing: UsagePricing): string {
  const cost = usageCostUsd(counters, pricing);
  const unpriced = counters.unpricedPromptTokens + counters.unpricedCompletionTokens;
  if (cost.usd === 0 && unpriced > 0) return "No price set";
  return `${cost.estimated ? "≈ " : ""}${usd(cost.usd)}`;
}

/** Totals plus a breakdown per kind, for the selected range. */
function renderLiveContent(): HTMLElement[] {
  const state = stats;
  if (!state) return [element("p", "settings-group__copy", "Usage is loading.")];
  const perKind = USAGE_KINDS.map((kind) => ({ kind, counters: countersFor(state, kind) }));
  const all = sumUsageCounters(perKind.map((item) => item.counters));
  const totalCost = perKind.reduce((sum, item) => sum + usageCostUsd(item.counters, state.pricing[item.kind]).usd, 0);
  const anyEstimate = perKind.some((item) => usageCostUsd(item.counters, state.pricing[item.kind]).estimated);

  const overview = element("dl", "usage-overview");
  ([
    ["Requests", numberFormat.format(all.requests)],
    ["Tokens", tokens(all.promptTokens + all.completionTokens)],
    ["Cost", `${anyEstimate ? "≈ " : ""}${usd(totalCost)}`],
  ] as const).forEach(([label, value]) => {
    const fact = element("div");
    fact.append(element("dt", undefined, label), element("dd", undefined, value));
    overview.append(fact);
  });

  const table = element("table", "usage-table");
  const head = element("thead");
  const headRow = element("tr");
  ["Kind", "Requests", "Input", "Output", "Cost"].forEach((label, index) => {
    const cell = element("th", index === 0 ? undefined : "usage-table__number", label);
    cell.scope = "col";
    headRow.append(cell);
  });
  head.append(headRow);
  const body = element("tbody");
  perKind.forEach(({ kind, counters }) => {
    const row = element("tr");
    const name = element("th");
    name.scope = "row";
    const details: string[] = [];
    if (counters.failures > 0) details.push(`${numberFormat.format(counters.failures)} failed`);
    if (counters.cancellations > 0) details.push(`${numberFormat.format(counters.cancellations)} cancelled`);
    if (counters.cachedTokens > 0) details.push(`${tokens(counters.cachedTokens)} cached`);
    if (counters.reasoningTokens > 0) details.push(`${tokens(counters.reasoningTokens)} reasoning`);
    // A cancelled request never had an answer to carry token counts.
    const unreported = counters.requests - counters.reportedRequests - counters.cancellations;
    if (unreported > 0) details.push(`${numberFormat.format(unreported)} without token counts`);
    const lastAt = state.lastAt[kind];
    if (lastAt && range === "all") {
      details.push(`last ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(lastAt)}`);
    }
    name.append(
      element("strong", undefined, KIND_LABELS[kind].title),
      element("small", undefined, details.length ? details.join(" · ") : KIND_LABELS[kind].copy),
    );
    row.append(
      name,
      element("td", "usage-table__number", numberFormat.format(counters.requests)),
      element("td", "usage-table__number", tokens(counters.promptTokens)),
      element("td", "usage-table__number", kind === "embedding" && counters.completionTokens === 0 ? "—" : tokens(counters.completionTokens)),
      element("td", "usage-table__number", costLabel(counters, state.pricing[kind])),
    );
    body.append(row);
  });
  table.append(head, body);
  const scroller = element("div", "usage-table__scroller");
  scroller.append(table);

  const since = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(state.since);
  return [
    overview,
    scroller,
    element(
      "p",
      "usage-note",
      `Counting since ${since}. Daily detail covers the last ${USAGE_DAYS_KEPT} days. ` +
        "Cost uses the price the provider reports (OpenRouter does); ≈ marks an estimate from your rates below.",
    ),
  ];
}

function historyLabel(days: number): string {
  const whole = Math.floor(days);
  return whole < 1 ? "from today so far" : `over the last ${numberFormat.format(whole)} ${whole === 1 ? "day" : "days"}`;
}

/**
 * What each feature costs in units that mean something: organizing per 1,000
 * runs, and the always-on features (search, auto-filing) per year at the
 * recent pace. Not tied to the period buttons above.
 */
function renderFeatureContent(): HTMLElement[] {
  const state = stats;
  if (!state) return [];
  const perRun = organizeCostPerThousand(state);
  const search = projectedYearlyCostUsd(state, "search");
  const filing = projectedYearlyCostUsd(state, "autoFile");
  const searchUsed = USAGE_KINDS.some((kind) => state.tasks.search[kind]?.requests);
  const filingUsed = USAGE_KINDS.some((kind) => state.tasks.autoFile[kind]?.requests);
  const facts: Array<readonly [string, string, string]> = [
    [
      "Organizing / 1,000 runs",
      perRun ? `${perRun.estimated ? "≈ " : ""}${usd(perRun.usd)}` : "—",
      perRun ? `from ${numberFormat.format(perRun.runs)} ${perRun.runs === 1 ? "run" : "runs"}` : "No runs yet",
    ],
    [
      "Semantic search / year",
      searchUsed ? `≈ ${usd(search.usd)}` : "—",
      searchUsed ? historyLabel(search.days) : "Not used yet",
    ],
    [
      "Auto-filing / year",
      filingUsed ? `≈ ${usd(filing.usd)}` : "—",
      filingUsed ? historyLabel(filing.days) : "Not used yet",
    ],
  ];
  const overview = element("dl", "usage-overview usage-overview--features");
  facts.forEach(([label, value, detail]) => {
    const fact = element("div");
    fact.append(element("dt", undefined, label), element("dd", undefined, value), element("small", undefined, detail));
    overview.append(fact);
  });
  const early = Math.min(search.days, filing.days) < 7 && (searchUsed || filingUsed);
  return [
    overview,
    element(
      "p",
      "usage-note",
      "Organizing includes repair requests. Search covers index builds, query embeddings, and reranking. " +
        "Yearly figures scale your last 30 days of spend to 365 days" +
        (early ? "; with under a week of history they are rough." : ".") +
        " Connection tests aren't counted here.",
    ),
  ];
}

function renderRangeControl(): HTMLElement {
  const modes = element("div", "usage-range");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Usage period");
  const controls: HTMLButtonElement[] = [];
  const sync = (): void => controls.forEach((control) => {
    const active = control.dataset.range === range;
    control.classList.toggle("cleanup-filter__button--active", active);
    control.setAttribute("aria-pressed", String(active));
  });
  RANGE_LABELS.forEach(([value, label]) => {
    const control = element("button", "cleanup-filter__button", label);
    control.type = "button";
    control.dataset.range = value;
    control.dataset.focusKey = `usage-range-${value}`;
    control.addEventListener("click", () => {
      range = value;
      sync();
      if (liveBlock) liveBlock.replaceChildren(...renderLiveContent());
    });
    controls.push(control);
    modes.append(control);
  });
  sync();
  return modes;
}

function renderPricing(state: UsageStatsState): HTMLElement {
  const group = element("section", "settings-group");
  group.append(
    element("h3", undefined, "Prices for estimates"),
    element(
      "p",
      "settings-group__copy",
      "Used only when a provider doesn't report its own cost. Rates apply to past and future counts alike, so you can fix a price later.",
    ),
  );
  const fields = element("div", "usage-pricing");
  const controls = USAGE_KINDS.map((kind) => {
    const inputPrice = ui().input(String(state.pricing[kind].inputPerMillionUsd), "number");
    inputPrice.min = "0";
    inputPrice.step = "0.000001";
    const outputPrice = ui().input(String(state.pricing[kind].outputPerMillionUsd), "number");
    outputPrice.min = "0";
    outputPrice.step = "0.000001";
    const row = element("div", "usage-pricing__row");
    row.append(element("strong", undefined, KIND_LABELS[kind].title), ui().field(`${KIND_LABELS[kind].title} input $ / 1M tokens`, inputPrice));
    // Embedding endpoints bill input only.
    if (kind !== "embedding") row.append(ui().field(`${KIND_LABELS[kind].title} output $ / 1M tokens`, outputPrice));
    fields.append(row);
    return { kind, inputPrice, outputPrice };
  });
  group.append(fields);
  const actions = element("div", "backup-actions");
  actions.append(ui().button("Save prices", "secondary", () => {
    void ui().perform("usage-pricing", async () => {
      const pricing = Object.fromEntries(controls.map(({ kind, inputPrice, outputPrice }) => {
        const input = Number(inputPrice.value || 0);
        const output = kind === "embedding" ? 0 : Number(outputPrice.value || 0);
        if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
          throw new Error("Token prices must be zero or positive numbers.");
        }
        return [kind, { inputPerMillionUsd: input, outputPerMillionUsd: output }];
      })) as Record<UsageKind, UsagePricing>;
      stats = await writeUsagePricing(pricing);
      popupState.notice = { tone: "success", text: "Usage prices saved." };
    });
  }, { actionName: "usage-pricing", busyLabel: "Saving…" }));
  if (resetArmed) {
    actions.append(
      ui().button("Confirm reset", "danger", () => {
        void ui().perform("usage-reset", async () => {
          stats = await resetUsageStats();
          resetArmed = false;
          popupState.notice = { tone: "success", text: "Usage counts reset. Prices were kept." };
        });
      }, { actionName: "usage-reset", busyLabel: "Resetting…" }),
      ui().button("Cancel", "quiet", () => {
        void ui().perform("usage-reset-cancel", async () => { resetArmed = false; });
      }, { actionName: "usage-reset-cancel" }),
    );
  } else {
    actions.append(ui().button("Reset counts", "quiet", () => {
      void ui().perform("usage-reset-arm", async () => { resetArmed = true; });
    }, { actionName: "usage-reset-arm" }));
  }
  group.append(actions);
  return group;
}

export function renderUsageSettings(category: HTMLElement): void {
  const state = stats;
  const live = element("section", "settings-group usage-stats");
  live.append(element("h3", undefined, "Requests, tokens, and cost"), renderRangeControl());
  liveBlock = element("div", "usage-stats__live");
  liveBlock.setAttribute("aria-live", "polite");
  liveBlock.append(...renderLiveContent());
  live.append(liveBlock);
  const features = element("section", "settings-group usage-stats");
  features.append(element("h3", undefined, "Cost by feature"));
  featureBlock = element("div", "usage-stats__live");
  featureBlock.setAttribute("aria-live", "polite");
  featureBlock.append(...renderFeatureContent());
  features.append(featureBlock);
  category.append(live);
  if (state) category.append(features, renderPricing(state));
}

/** One line for the settings index. */
export function usageNavCopy(): string {
  if (!stats) return "Requests, tokens, and cost";
  const today = usageDayKey(Date.now());
  const counters = USAGE_KINDS.map((kind) => stats!.days[today]?.[kind]);
  const requests = sumUsageCounters(counters).requests;
  const cost = USAGE_KINDS.reduce((sum, kind) =>
    sum + usageCostUsd(stats!.days[today]?.[kind] ?? sumUsageCounters([]), stats!.pricing[kind]).usd, 0);
  return requests === 0 ? "No requests today" : `${numberFormat.format(requests)} request${requests === 1 ? "" : "s"} today · ${usd(cost)}`;
}
