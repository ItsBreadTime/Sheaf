import { setUsageSink } from "../provider/usage-meter";
import {
  USAGE_KINDS,
  USAGE_TASKS,
  type UsageCounters,
  type UsageKind,
  type UsagePricing,
  type UsageSample,
  type UsageStatsState,
  type UsageTask,
  type UsageTaskCounters,
} from "../shared/usage-types";
import { isRecord } from "../shared/guards";
import { withStorageMutationLock } from "./mutation-lock";

/**
 * Request, token, and cost counts per provider kind, for Settings → Usage.
 * Counts only: no titles, URLs, models, or request bodies are kept here.
 */

export const USAGE_STATS_KEY = "usageStats";
export const USAGE_DAYS_KEPT = 30;
/** Yearly projections scale to this many days. */
const USAGE_YEAR_DAYS = 365;
const DAY_MS = 86_400_000;

const ZERO_PRICING: UsagePricing = { inputPerMillionUsd: 0, outputPerMillionUsd: 0 };

function emptyUsageCounters(): UsageCounters {
  return {
    requests: 0,
    failures: 0,
    cancellations: 0,
    reportedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    reportedCostUsd: 0,
    unpricedPromptTokens: 0,
    unpricedCompletionTokens: 0,
  };
}

function perKind<Value>(make: () => Value): Record<UsageKind, Value> {
  return Object.fromEntries(USAGE_KINDS.map((kind) => [kind, make()])) as Record<UsageKind, Value>;
}

function perTask<Value>(make: () => Value): Record<UsageTask, Value> {
  return Object.fromEntries(USAGE_TASKS.map((task) => [task, make()])) as Record<UsageTask, Value>;
}

export function emptyUsageStats(now = Date.now(), pricing?: Record<UsageKind, UsagePricing>): UsageStatsState {
  return {
    schemaVersion: 1,
    since: now,
    totals: perKind(emptyUsageCounters),
    days: {},
    lastAt: {},
    pricing: pricing ?? perKind(() => ({ ...ZERO_PRICING })),
    tasks: perTask(() => ({})),
    taskDays: {},
    organizeRuns: 0,
    tasksSince: now,
  };
}

function nonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseCounters(value: unknown): UsageCounters {
  const record = isRecord(value) ? value : {};
  const counters = emptyUsageCounters();
  (Object.keys(counters) as Array<keyof UsageCounters>).forEach((key) => { counters[key] = nonnegative(record[key]); });
  return counters;
}

function parsePricing(value: unknown): UsagePricing {
  const record = isRecord(value) ? value : {};
  return {
    inputPerMillionUsd: nonnegative(record.inputPerMillionUsd),
    outputPerMillionUsd: nonnegative(record.outputPerMillionUsd),
  };
}

function parseKindCounters(value: unknown): Partial<Record<UsageKind, UsageCounters>> {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(USAGE_KINDS
    .filter((kind) => isRecord(record[kind]))
    .map((kind) => [kind, parseCounters(record[kind])]));
}

export function parseUsageStats(value: unknown, now = Date.now()): UsageStatsState {
  if (!isRecord(value) || value.schemaVersion !== 1) return emptyUsageStats(now);
  const totals = isRecord(value.totals) ? value.totals : {};
  const pricing = isRecord(value.pricing) ? value.pricing : {};
  const lastAt = isRecord(value.lastAt) ? value.lastAt : {};
  const days: UsageStatsState["days"] = {};
  if (isRecord(value.days)) {
    for (const [day, bucket] of Object.entries(value.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isRecord(bucket)) continue;
      days[day] = parseKindCounters(bucket);
    }
  }
  const tasks = isRecord(value.tasks) ? value.tasks : {};
  const taskDays: UsageStatsState["taskDays"] = {};
  if (isRecord(value.taskDays)) {
    for (const [day, bucket] of Object.entries(value.taskDays)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isRecord(bucket)) continue;
      taskDays[day] = Object.fromEntries(USAGE_TASKS
        .filter((task) => isRecord(bucket[task]))
        .map((task) => [task, parseKindCounters(bucket[task])]));
    }
  }
  const since = typeof value.since === "number" && Number.isFinite(value.since) ? value.since : now;
  return {
    schemaVersion: 1,
    since,
    totals: Object.fromEntries(USAGE_KINDS.map((kind) => [kind, parseCounters(totals[kind])])) as Record<UsageKind, UsageCounters>,
    days,
    lastAt: Object.fromEntries(USAGE_KINDS
      .filter((kind) => typeof lastAt[kind] === "number")
      .map((kind) => [kind, lastAt[kind] as number])),
    pricing: Object.fromEntries(USAGE_KINDS.map((kind) => [kind, parsePricing(pricing[kind])])) as Record<UsageKind, UsagePricing>,
    tasks: Object.fromEntries(USAGE_TASKS.map((task) => [task, parseKindCounters(tasks[task])])) as Record<UsageTask, UsageTaskCounters>,
    taskDays,
    organizeRuns: nonnegative(value.organizeRuns),
    // Stats saved before tasks were tracked start their task history now.
    tasksSince: typeof value.tasksSince === "number" && Number.isFinite(value.tasksSince) ? value.tasksSince : now,
  };
}

/** Local calendar day, so "Today" matches the user's clock. */
export function usageDayKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addUsageSample(counters: UsageCounters, sample: UsageSample): UsageCounters {
  const next = { ...counters };
  next.requests += 1;
  if (sample.cancelled) next.cancellations += 1;
  else if (!sample.ok) next.failures += 1;
  const usage = sample.usage;
  const prompt = usage?.promptTokens ?? 0;
  // Embedding responses report only prompt and total tokens.
  const completion = usage?.completionTokens ??
    (usage?.totalTokens !== null && usage?.totalTokens !== undefined && usage.promptTokens !== null
      ? Math.max(0, usage.totalTokens - usage.promptTokens)
      : 0);
  if (usage) next.reportedRequests += 1;
  next.promptTokens += prompt;
  next.completionTokens += completion;
  next.cachedTokens += usage?.cachedTokens ?? 0;
  next.reasoningTokens += usage?.reasoningTokens ?? 0;
  if (sample.costUsd !== null) {
    next.reportedCostUsd += sample.costUsd;
  } else {
    next.unpricedPromptTokens += prompt;
    next.unpricedCompletionTokens += completion;
  }
  return next;
}

function addToKind(counters: UsageTaskCounters | undefined, sample: UsageSample): UsageTaskCounters {
  return { ...counters, [sample.kind]: addUsageSample(counters?.[sample.kind] ?? emptyUsageCounters(), sample) };
}

function keepNewestDays<Bucket>(days: Record<string, Bucket>): Record<string, Bucket> {
  const kept = Object.keys(days).sort().slice(-USAGE_DAYS_KEPT);
  return Object.fromEntries(kept.map((key) => [key, days[key]!]));
}

export function recordUsageInState(state: UsageStatsState, sample: UsageSample): UsageStatsState {
  const day = usageDayKey(sample.at);
  const next: UsageStatsState = {
    ...state,
    totals: { ...state.totals, [sample.kind]: addUsageSample(state.totals[sample.kind], sample) },
    days: keepNewestDays({ ...state.days, [day]: addToKind(state.days[day], sample) }),
    lastAt: { ...state.lastAt, [sample.kind]: sample.at },
  };
  const task = sample.task;
  if (!task) return next;
  const taskBucket = state.taskDays[day] ?? {};
  return {
    ...next,
    tasks: { ...state.tasks, [task]: addToKind(state.tasks[task], sample) },
    taskDays: keepNewestDays({ ...state.taskDays, [day]: { ...taskBucket, [task]: addToKind(taskBucket[task], sample) } }),
    organizeRuns: state.organizeRuns + (task === "organize" && sample.startsRun && sample.ok ? 1 : 0),
  };
}

export function sumUsageCounters(items: ReadonlyArray<UsageCounters | undefined>): UsageCounters {
  const sum = emptyUsageCounters();
  for (const item of items) {
    if (!item) continue;
    (Object.keys(sum) as Array<keyof UsageCounters>).forEach((key) => { sum[key] += item[key]; });
  }
  return sum;
}

/** Reported cost plus the user's rates applied to the tokens nobody priced. */
export function usageCostUsd(counters: UsageCounters, pricing: UsagePricing): { usd: number; estimated: boolean } {
  const estimate = (counters.unpricedPromptTokens * pricing.inputPerMillionUsd +
    counters.unpricedCompletionTokens * pricing.outputPerMillionUsd) / 1_000_000;
  return { usd: counters.reportedCostUsd + estimate, estimated: estimate > 0 };
}

/** Cost of one task's requests across the kinds it used, each at its own rates. */
function taskCostUsd(
  counters: UsageTaskCounters | undefined,
  pricing: Record<UsageKind, UsagePricing>,
): { usd: number; estimated: boolean } {
  let usd = 0;
  let estimated = false;
  for (const kind of USAGE_KINDS) {
    const item = counters?.[kind];
    if (!item) continue;
    const cost = usageCostUsd(item, pricing[kind]);
    usd += cost.usd;
    estimated ||= cost.estimated;
  }
  return { usd, estimated };
}

/** Average cost of 1,000 organize runs, repairs included; null before the first run. */
export function organizeCostPerThousand(state: UsageStatsState): { usd: number; estimated: boolean; runs: number } | null {
  if (state.organizeRuns === 0) return null;
  const cost = taskCostUsd(state.tasks.organize, state.pricing);
  return { usd: (cost.usd / state.organizeRuns) * 1_000, estimated: cost.estimated, runs: state.organizeRuns };
}

/**
 * A task's spend over the last 30 days (or since tracking began, if sooner),
 * scaled to a year. `days` is how much history the projection rests on.
 */
export function projectedYearlyCostUsd(
  state: UsageStatsState,
  task: UsageTask,
  now = Date.now(),
): { usd: number; estimated: boolean; days: number } {
  const today = new Date(now);
  const windowFloor = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (USAGE_DAYS_KEPT - 1)).getTime();
  const windowStart = Math.max(windowFloor, state.since, state.tasksSince);
  const firstDay = usageDayKey(windowStart);
  let usd = 0;
  let estimated = false;
  for (const [day, bucket] of Object.entries(state.taskDays)) {
    if (day < firstDay) continue;
    const cost = taskCostUsd(bucket[task], state.pricing);
    usd += cost.usd;
    estimated ||= cost.estimated;
  }
  // At least a day, so the first hour's spend doesn't project to a fortune.
  const days = Math.max(1, (now - windowStart) / DAY_MS);
  return { usd: (usd / days) * USAGE_YEAR_DAYS, estimated, days };
}

/**
 * Every extension context (worker, popup, finder) records, so writes are
 * serialized across contexts with a Web Lock where available.
 */
async function withUsageLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) return await locks.request(USAGE_STATS_KEY, task) as T;
  return await withStorageMutationLock(USAGE_STATS_KEY, task);
}

export async function readUsageStats(): Promise<UsageStatsState> {
  const values = await chrome.storage.local.get(USAGE_STATS_KEY);
  return parseUsageStats(values[USAGE_STATS_KEY]);
}

async function updateUsageStats(update: (state: UsageStatsState) => UsageStatsState): Promise<UsageStatsState> {
  return await withUsageLock(async () => {
    const next = update(await readUsageStats());
    await chrome.storage.local.set({ [USAGE_STATS_KEY]: next });
    return next;
  });
}

async function recordUsageSample(sample: UsageSample): Promise<void> {
  await updateUsageStats((state) => recordUsageInState(state, sample));
}

export async function writeUsagePricing(pricing: Record<UsageKind, UsagePricing>): Promise<UsageStatsState> {
  return await updateUsageStats((state) => ({
    ...state,
    pricing: Object.fromEntries(USAGE_KINDS.map((kind) => [kind, parsePricing(pricing[kind])])) as Record<UsageKind, UsagePricing>,
  }));
}

/** Clears the counts; keeps the prices. */
export async function resetUsageStats(): Promise<UsageStatsState> {
  return await updateUsageStats((state) => emptyUsageStats(Date.now(), state.pricing));
}

/** Called once per extension context that sends provider requests. */
export function installUsageRecorder(): void {
  setUsageSink((sample) => {
    void recordUsageSample(sample).catch(() => undefined);
  });
}
