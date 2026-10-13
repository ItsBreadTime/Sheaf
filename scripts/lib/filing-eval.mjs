// Auto-filing benchmark (docs/auto-filing-plan.md, Evaluation). Builds filing
// cases from the grouped organizer corpora, asks each candidate for a
// distribution over a window's groups, and reports the metrics that decide the
// ship gate: file accuracy on held-out tabs, the false-file rate on
// distractors, the false-move-out rate on same-task controls, drift accuracy,
// calibration, option-order sensitivity, latency, and cost. Thresholds are
// chosen on one half of the source windows and reported on the other half, so
// the recommended presets are not fitted to the cases they are scored on.
//
// The request builder, both wire adapters, and the policy are the extension's
// own modules (src/decision), so the benchmark measures what ships.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { getDomain } = await import("tldts");
const {
  buildFilingDecisionRequest, filingDistribution, fileQuestionId, fitsQuestionId, NONE_OPTION, STAY_OPTION,
} = await import("../../src/decision/filing-state.ts");
const { decisionApiBody, parseDecisionApiAnswers } = await import("../../src/decision/decision-api-adapter.ts");
const {
  buildChatLogprobPrompt, buildChatConfidencePrompt, distributionFromLogprobs, distributionFromConfidence,
} = await import("../../src/decision/chat-decision-adapter.ts");
const { decideFiling } = await import("../../src/decision/filing-policy.ts");
const { buildSemanticDocument } = await import("../../src/search/semantic-document.ts");
const { sanitizeTabTitleForProvider } = await import("../../src/privacy/sanitize-text.ts");

// ---------------------------------------------------------------------------
// Corpus → filing cases

const registrable = (hostname) => getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;

function normalizeCorpusCase(source) {
  const request = source.request ?? (typeof source.input === "string" ? JSON.parse(source.input) : source.input);
  const spec = source.spec ?? source.behaviorSpec;
  if (!request?.tabs || !spec?.groups?.length) return null;
  const tabs = new Map(request.tabs.map((tab) => [tab.id, {
    id: tab.id,
    title: tab.title,
    hostname: tab.hostname ?? tab.domain,
    path: tab.path ?? "/",
    site: registrable(tab.hostname ?? tab.domain),
  }]));
  const groups = spec.groups
    .map((group, index) => ({
      key: `g${index + 1}`,
      name: group.title?.preferred?.[0] ?? group.title?.requiredAny?.[0] ?? `Group ${index + 1}`,
      members: group.tabIds.map((id) => tabs.get(id)).filter(Boolean),
      optional: new Set(group.optional ?? []),
    }))
    .filter((group) => group.members.length > 0);
  const claimed = new Set(spec.groups.flatMap((group) => [...group.tabIds, ...(group.optional ?? [])]));
  // A copy of a member page isn't a distractor: filing it next to its twin is right.
  const memberTitles = new Set(groups.flatMap((group) => group.members.map((tab) => tab.title.trim().toLowerCase())));
  const duplicateOf = new Map(request.tabs.map((tab) => [tab.id, tab.duplicateOfTabId]));
  const distractors = [...tabs.values()].filter((tab) =>
    !claimed.has(tab.id) &&
    !claimed.has(duplicateOf.get(tab.id)) &&
    !memberTitles.has(tab.title.trim().toLowerCase()));
  return { id: source.id, groups, distractors };
}

const ADVERSARIAL_TEMPLATES = [
  (title, group) => `${title} — handy reference for anyone working on ${group}`,
  (title, group) => `${title} | Related: ${group} guide`,
  (title, group) => `${title} (saved for ${group})`,
];

function windowGroups(corpus, without) {
  return corpus.groups.map((group) => {
    const members = group.members.filter((tab) => !without.has(tab.id));
    return {
      key: group.key,
      name: group.name,
      sites: [...new Set(members.map((tab) => tab.site))],
      sampleTitles: members.map((tab) => sanitizeTabTitleForProvider(tab.title, tab.hostname)),
      members,
    };
  });
}

function filingCase(corpus, kind, page, { without, currentGroupKey = null, expected, wrongGroup = null, variant = 0 }) {
  const title = wrongGroup
    ? ADVERSARIAL_TEMPLATES[variant % ADVERSARIAL_TEMPLATES.length](page.title, wrongGroup.name)
    : page.title;
  return {
    id: `${corpus.id}/${kind}/${page.id}${currentGroupKey ? `@${currentGroupKey}` : ""}${wrongGroup ? `/adv-${wrongGroup.key}` : ""}`,
    corpusId: corpus.id,
    kind,
    adversarial: Boolean(wrongGroup),
    grouped: Boolean(currentGroupKey),
    expected,
    groups: windowGroups(corpus, without).filter((group) => group.members.length > 0),
    tab: {
      key: "t1",
      title: sanitizeTabTitleForProvider(title, page.hostname),
      site: page.site,
      hostname: page.hostname,
      path: page.path,
      currentGroupKey,
    },
  };
}

function stableHash(value) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

export function buildFilingCases(corpora, { adversarialEvery = 3 } = {}) {
  const cases = [];
  // Stable per case, so editing one corpus window doesn't reshuffle which cases get an adversarial copy.
  const maybeAdversarial = (corpus, kind, page, options, wrongCandidates) => {
    const base = filingCase(corpus, kind, page, options);
    cases.push(base);
    const hash = stableHash(base.id);
    const wrongGroup = wrongCandidates[hash % Math.max(1, wrongCandidates.length)];
    if (hash % adversarialEvery === 0 && wrongGroup) {
      cases.push(filingCase(corpus, kind, page, { ...options, wrongGroup, variant: Math.floor(hash / adversarialEvery) }));
    }
  };
  for (const source of corpora) {
    const corpus = normalizeCorpusCase(source);
    if (!corpus) continue;
    const { groups, distractors } = corpus;
    for (const group of groups) {
      const others = groups.filter((other) => other !== group);
      // Held-out: one member removed from its group should be filed back.
      if (group.members.length >= 2) {
        for (const member of group.members) {
          maybeAdversarial(corpus, "heldout", member, { without: new Set([member.id]), expected: group.key }, others);
        }
      }
      // Control: a member navigated to another same-task page on a different site; it should stay.
      if (group.members.length >= 3) {
        for (const [index, member] of group.members.entries()) {
          const page = group.members.find((other, otherIndex) => otherIndex !== index && other.site !== member.site);
          if (!page || index > 1) continue;
          maybeAdversarial(corpus, "control", page, {
            without: new Set([member.id, page.id]), currentGroupKey: group.key, expected: STAY_OPTION,
          }, others);
        }
      }
      if (group.members.length < 2) continue;
      const mover = group.members[0];
      // Drift into another group's task: it should move there.
      for (const target of others) {
        if (target.members.length < 2) continue;
        const page = target.members[(groups.indexOf(group) + 1) % target.members.length];
        maybeAdversarial(corpus, "drift_move", page, {
          without: new Set([mover.id, page.id]), currentGroupKey: group.key, expected: target.key,
        }, [group, ...others.filter((other) => other !== target)]);
      }
      // Drift to an unrelated page: it should leave its group.
      for (const page of distractors.slice(groups.indexOf(group) * 2, groups.indexOf(group) * 2 + 2)) {
        maybeAdversarial(corpus, "drift_out", page, {
          without: new Set([mover.id]), currentGroupKey: group.key, expected: NONE_OPTION,
        }, [group]);
      }
    }
    // Distractor: a tab that belongs to no group should stay ungrouped.
    for (const page of distractors) {
      maybeAdversarial(corpus, "distractor", page, { without: new Set(), expected: NONE_OPTION }, groups);
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Candidates

function inputFor(filingCase, reverse, style = "json") {
  const groups = reverse ? [...filingCase.groups].reverse() : filingCase.groups;
  return {
    groups: groups.map(({ key, name, sites, sampleTitles }) => ({ key, name, sites, sampleTitles })),
    tabs: [filingCase.tab],
    askFits: !filingCase.grouped,
    style,
  };
}

function stateFor(filingCase, reverse, style) {
  return buildFilingDecisionRequest(inputFor(filingCase, reverse, style));
}

export class RateLimitStop extends Error {}

function retryAfterMs(response, text) {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const match = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(text);
  if (!match || !match[0].match(/\d/)) return null;
  return ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000;
}

async function postJson(url, apiKey, body, headers = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const started = performance.now();
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      if (attempt < 3) continue;
      throw error;
    }
    const text = await response.text();
    const latencyMs = performance.now() - started;
    if (response.status === 429 || response.status === 529 || response.status >= 500) {
      const wait = retryAfterMs(response, text);
      // A quota window (an hourly cap) can't be waited out per call: stop the candidate and keep what we have.
      if (wait !== null && wait > 60_000) throw new RateLimitStop(text.slice(0, 200));
      if (attempt < 12) {
        await new Promise((resolve) => setTimeout(resolve, wait ?? Math.min(20_000, 500 * 2 ** attempt) * (0.5 + Math.random())));
        continue;
      }
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return { json: JSON.parse(text), latencyMs };
  }
}

function usageCost(json) {
  const cost = json?.usage?.cost;
  if (typeof cost === "number") return cost;
  if (typeof cost?.usd === "number") return cost.usd;
  return null;
}

async function runDecisionApi(candidate, filingCase, reverse) {
  const input = inputFor(filingCase, reverse, candidate.style);
  const request = buildFilingDecisionRequest(input);
  const { json, latencyMs } = await postJson(candidate.url, candidate.apiKey,
    decisionApiBody(candidate.model, request, candidate.extraBody), candidate.headers);
  const answers = parseDecisionApiAnswers(json, request);
  const probabilities = filingDistribution(answers, input, filingCase.tab);
  if (!probabilities) throw new Error("Decision response is missing the filing answers.");
  return {
    probabilities,
    fits: answers[fitsQuestionId("t1")]?.noul ?? null,
    source: "native",
    latencyMs,
    cost: usageCost(json),
  };
}

async function runChatQuestion(candidate, state, question) {
  const prompt = candidate.logprobs === false
    ? buildChatConfidencePrompt(state, question)
    : buildChatLogprobPrompt(state, question);
  const { json, latencyMs } = await postJson(candidate.url, candidate.apiKey, {
    ...candidate.extraBody,
    model: candidate.model,
    messages: prompt.messages,
    ...prompt.body,
    ...(candidate.logprobs === false && candidate.maxTokens ? { max_tokens: candidate.maxTokens } : {}),
  }, candidate.headers);
  let probabilities = candidate.logprobs === false ? null : distributionFromLogprobs(json, prompt.labels);
  let source = "logprobs";
  if (!probabilities) {
    probabilities = distributionFromConfidence(json, prompt.labels, candidate.confidenceTable);
    source = "confidence";
  }
  if (!probabilities) {
    // An unusable answer abstains: all mass on the safe option.
    const safe = Object.values(prompt.labels).find((option) => option === STAY_OPTION || option === NONE_OPTION || option === "no");
    probabilities = Object.fromEntries(Object.values(prompt.labels).map((option) => [option, option === safe ? 1 : 0]));
    source = "unusable";
  }
  return { probabilities, source, latencyMs, cost: usageCost(json), provider: typeof json.provider === "string" ? json.provider : null };
}

async function runChat(candidate, filingCase, reverse) {
  const request = stateFor(filingCase, reverse);
  const file = runChatQuestion(candidate, request.state, request.questions[fileQuestionId("t1")]);
  const fitsQuestion = candidate.askFits ? request.questions[fitsQuestionId("t1")] : undefined;
  const fits = fitsQuestion ? runChatQuestion(candidate, request.state, fitsQuestion) : null;
  const [fileResult, fitsResult] = await Promise.all([file, fits]);
  return {
    probabilities: fileResult.probabilities,
    fits: fitsResult ? fitsResult.probabilities.yes ?? 0 : null,
    source: fileResult.source,
    provider: fileResult.provider,
    latencyMs: Math.max(fileResult.latencyMs, fitsResult?.latencyMs ?? 0),
    cost: fileResult.cost === null ? null : fileResult.cost + (fitsResult?.cost ?? 0),
  };
}

// --- Embeddings (tier 1) -----------------------------------------------------

const EMBEDDING_PRIVACY = {
  level: 2, includeExistingGroups: false, allowLocalNetworkTabs: false, allowFileTabs: false,
  closeInactiveBlankTabs: false, allowlist: [], denylist: [],
};

function embeddingDocument(tab) {
  const result = buildSemanticDocument({
    mappingKey: "m", target: { kind: "tab", tabId: 1 }, title: tab.title,
    url: `https://${tab.hostname}${tab.path.replace(/:[a-z]+/g, "x")}`, groupName: null,
  }, EMBEDDING_PRIVACY);
  return result.status === "ready" ? result.document : `Title: ${tab.title.toLowerCase()}\nHost: ${tab.hostname}`;
}

async function embedAll(candidate, cases) {
  const documents = new Map();
  for (const filingCase of cases) {
    documents.set(embeddingDocument(filingCase.tab), null);
    for (const group of filingCase.groups) for (const member of group.members) documents.set(embeddingDocument(member), null);
  }
  const texts = [...documents.keys()];
  for (let index = 0; index < texts.length; index += 64) {
    const batch = texts.slice(index, index + 64);
    const { json } = await postJson(candidate.url, candidate.apiKey, { ...candidate.extraBody, model: candidate.model, input: batch }, candidate.headers);
    json.data.forEach((item, offset) => documents.set(batch[item.index ?? offset], normalize(item.embedding)));
  }
  return documents;
}

function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);

/**
 * Raw tier-1 evidence: per group, the cosine to the normalized member mean and
 * the best single-member cosine (a one-neighbour kNN, so a mixed group doesn't
 * average itself into the middle). The score is the larger of the two.
 */
function embeddingScores(vectors, filingCase) {
  const query = vectors.get(embeddingDocument(filingCase.tab));
  const scores = {};
  for (const group of filingCase.groups) {
    const members = group.members.map((member) => vectors.get(embeddingDocument(member)));
    const mean = normalize(members[0].map((_, dimension) => members.reduce((sum, vector) => sum + vector[dimension], 0)));
    scores[group.key] = Math.max(dot(query, mean), ...members.map((vector) => dot(query, vector)));
  }
  return scores;
}

/** Softmax over groups plus a fixed `none` logit; stay is the current group's mass. */
export function embeddingDistribution(scores, filingCase, { temperature, noneBias }) {
  const logits = { ...scores, [NONE_OPTION]: noneBias };
  if (filingCase.grouped) {
    logits[STAY_OPTION] = logits[filingCase.tab.currentGroupKey];
    delete logits[filingCase.tab.currentGroupKey];
  }
  const max = Math.max(...Object.values(logits));
  const exp = Object.fromEntries(Object.entries(logits).map(([key, value]) => [key, Math.exp((value - max) / temperature)]));
  const total = Object.values(exp).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(exp).map(([key, value]) => [key, value / total]));
}

// ---------------------------------------------------------------------------
// Running

async function pool(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  let stopped = null;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      if (stopped) break;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (error instanceof RateLimitStop) {
          stopped = error;
          break;
        }
        results[index] = { error: error instanceof Error ? error.message : String(error) };
      }
      done += 1;
      onProgress?.(done, items.length);
    }
  }));
  return { results, stopped };
}

export async function runCandidate(candidate, cases, { orderRuns = 2, onProgress, cache } = {}) {
  if (candidate.protocol === "embedding") {
    const vectors = await embedAll(candidate, cases);
    return { entries: cases.map((filingCase) => ({ caseId: filingCase.id, scores: embeddingScores(vectors, filingCase) })) };
  }
  const run = candidate.protocol === "decision_api" ? runDecisionApi : runChat;
  const jobs = cases.flatMap((filingCase) => Array.from({ length: orderRuns }, (_, order) => ({ filingCase, order })));
  const key = (job) => `${job.filingCase.id}#${job.order}`;
  const pending = jobs.filter((job) => !cache?.has(key(job)));
  const { stopped } = await pool(pending, candidate.concurrency ?? 8, async (job) => {
    const result = { caseId: job.filingCase.id, order: job.order, ...(await run(candidate, job.filingCase, job.order === 1)) };
    await cache?.set(key(job), result);
    return result;
  }, onProgress);
  const byCase = new Map(cases.map((filingCase) => [filingCase.id, { caseId: filingCase.id, runs: [] }]));
  for (const job of jobs) {
    const result = cache?.get(key(job));
    if (result) byCase.get(job.filingCase.id).runs[job.order] = result;
  }
  return { entries: [...byCase.values()].filter((entry) => entry.runs[0]), stopped: stopped?.message ?? null };
}

/** Successful results only, keyed by case and option order, appended as JSON lines so a stopped run resumes. */
export async function openResultCache(path) {
  const { readFile, appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  const entries = new Map();
  try {
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const { key, value } = JSON.parse(line);
      entries.set(key, value);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    has: (key) => entries.has(key),
    get: (key) => entries.get(key),
    async set(key, value) {
      if (value.error) return;
      entries.set(key, value);
      await appendFile(path, `${JSON.stringify({ key, value })}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring

const APPLY_GRID = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.99];
const MARGIN_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
const FIT_GRID = [null, 0.3, 0.5, 0.7, 0.9];
const STAY_GRID = [0.01, 0.03, 0.05, 0.1, 0.2, 0.3];

export const GATE = { falseFile: 0.02, wrongGroup: 0.02, falseMoveOut: 0.01, heldoutFiled: 0.5 };

function outcome(filingCase, evidence, thresholds) {
  const verdict = decideFiling({ ...evidence, grouped: filingCase.grouped }, thresholds);
  if (verdict.action === "abstain") return "abstain";
  const landed = verdict.action === "ungroup" ? NONE_OPTION : verdict.target;
  return landed === filingCase.expected ? "correct" : "wrong";
}

export function scoreUngrouped(cases, evidenceFor, thresholds) {
  const counts = { heldout: 0, heldoutCorrect: 0, heldoutWrong: 0, distractor: 0, distractorFiled: 0 };
  for (const filingCase of cases) {
    if (filingCase.grouped) continue;
    const evidence = evidenceFor(filingCase);
    if (!evidence) continue;
    const result = outcome(filingCase, evidence, thresholds);
    if (filingCase.kind === "heldout") {
      counts.heldout += 1;
      if (result === "correct") counts.heldoutCorrect += 1;
      if (result === "wrong") counts.heldoutWrong += 1;
    } else {
      counts.distractor += 1;
      if (result === "wrong") counts.distractorFiled += 1;
    }
  }
  return {
    ...counts,
    fileAccuracy: counts.heldoutCorrect / (counts.heldout || 1),
    wrongGroupRate: counts.heldoutWrong / (counts.heldout || 1),
    falseFileRate: counts.distractorFiled / (counts.distractor || 1),
  };
}

export function scoreGrouped(cases, evidenceFor, thresholds) {
  const counts = { control: 0, controlMoved: 0, driftMove: 0, driftMoveCorrect: 0, driftOut: 0, driftOutCorrect: 0, driftWrong: 0 };
  for (const filingCase of cases) {
    if (!filingCase.grouped) continue;
    const evidence = evidenceFor(filingCase);
    if (!evidence) continue;
    const result = outcome(filingCase, evidence, thresholds);
    if (filingCase.kind === "control") {
      counts.control += 1;
      if (result !== "abstain") counts.controlMoved += 1;
      continue;
    }
    const key = filingCase.kind === "drift_move" ? "driftMove" : "driftOut";
    counts[key] += 1;
    if (result === "correct") counts[`${key}Correct`] += 1;
    if (result === "wrong") counts.driftWrong += 1;
  }
  const drift = counts.driftMove + counts.driftOut;
  return {
    ...counts,
    falseMoveOutRate: counts.controlMoved / (counts.control || 1),
    driftAccuracy: (counts.driftMoveCorrect + counts.driftOutCorrect) / (drift || 1),
    driftMoveAccuracy: counts.driftMoveCorrect / (counts.driftMove || 1),
    driftOutAccuracy: counts.driftOutCorrect / (counts.driftOut || 1),
    driftWrongRate: counts.driftWrong / (drift || 1),
  };
}

const BASE_THRESHOLDS = { apply: 0.85, margin: 0.3, fit: null, applyGrouped: 0.9, stay: 0.1 };

export function sweepUngrouped(cases, evidenceFor, hasFits) {
  let best = null;
  for (const apply of APPLY_GRID) for (const margin of MARGIN_GRID) for (const fit of hasFits ? FIT_GRID : [null]) {
    const thresholds = { ...BASE_THRESHOLDS, apply, margin, fit };
    const score = scoreUngrouped(cases, evidenceFor, thresholds);
    if (score.falseFileRate > GATE.falseFile || score.wrongGroupRate > GATE.wrongGroup) continue;
    // Prefer more correct filings, then the stricter setting on ties.
    const rank = score.fileAccuracy - (apply + margin + (fit ?? 0)) * 1e-4;
    if (!best || rank > best.rank) best = { rank, thresholds, score };
  }
  return best;
}

export function sweepGrouped(cases, evidenceFor) {
  let best = null;
  for (const applyGrouped of APPLY_GRID) for (const margin of MARGIN_GRID) for (const stay of STAY_GRID) {
    const thresholds = { ...BASE_THRESHOLDS, applyGrouped, margin, stay };
    const score = scoreGrouped(cases, evidenceFor, thresholds);
    if (score.falseMoveOutRate > GATE.falseMoveOut || score.driftWrongRate > GATE.wrongGroup) continue;
    const rank = score.driftAccuracy - (applyGrouped + margin - stay) * 1e-4;
    if (!best || rank > best.rank) best = { rank, thresholds, score };
  }
  return best;
}

/** Expected calibration error of the top option, over 10 equal-width bins. */
export function calibration(cases, evidenceFor) {
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
  let total = 0;
  for (const filingCase of cases) {
    const evidence = evidenceFor(filingCase);
    if (!evidence) continue;
    const [top, probability] = Object.entries(evidence.probabilities).sort((left, right) => right[1] - left[1])[0];
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count += 1;
    bin.confidence += probability;
    bin.correct += top === filingCase.expected ? 1 : 0;
    total += 1;
  }
  const ece = bins.reduce((sum, bin) => sum + (bin.count ? Math.abs(bin.confidence - bin.correct) : 0), 0) / (total || 1);
  return {
    ece,
    bins: bins.map((bin, index) => ({
      range: `${index / 10}-${(index + 1) / 10}`,
      count: bin.count,
      meanConfidence: bin.count ? bin.confidence / bin.count : null,
      accuracy: bin.count ? bin.correct / bin.count : null,
    })),
  };
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

/** Two folds split by source window, so cases from one window never straddle the split. */
export function foldOf(filingCase) {
  return stableHash(filingCase.corpusId) % 2;
}

// ---------------------------------------------------------------------------
// Benchmark entry point

function resolveCandidate(source, env) {
  const protocol = source.protocol ?? "decision_api";
  if (!["decision_api", "chat", "embedding"].includes(protocol)) throw new Error(`Unknown protocol ${protocol}.`);
  const origin = String(env[source.originEnv] ?? source.origin ?? "").replace(/\/+$/, "");
  const model = String(env[source.modelEnv] ?? source.model ?? "");
  if (!/^https?:\/\//.test(origin) || !model) throw new Error(`${source.name}: origin and model are required.`);
  const apiKey = source.apiKeyEnv ? env[source.apiKeyEnv] : "";
  if (source.apiKeyEnv && !apiKey) throw new Error(`${source.name} requires ${source.apiKeyEnv}.`);
  return { ...source, protocol, model, apiKey, url: `${origin}${source.endpointPath ?? ""}`, extraBody: source.extraBody ?? {}, headers: source.headers ?? {} };
}

function evidenceFromRuns(entry, order = 0) {
  const run = entry?.runs?.[order];
  return run && !run.error ? { probabilities: run.probabilities, fits: run.fits } : null;
}

function summarizeModel(cases, results, hasFits) {
  const byId = new Map(results.map((entry) => [entry.caseId, entry]));
  const evidence = (order) => (filingCase) => evidenceFromRuns(byId.get(filingCase.id), order);
  const runs = results.flatMap((entry) => entry.runs ?? []);
  const errors = runs.filter((run) => run?.error);
  let flips = 0;
  let paired = 0;
  for (const entry of results) {
    const [first, second] = entry.runs ?? [];
    if (!first || !second || first.error || second.error) continue;
    const top = (run) => Object.entries(run.probabilities).sort((left, right) => right[1] - left[1])[0][0];
    paired += 1;
    if (top(first) !== top(second)) flips += 1;
  }
  const costs = runs.map((run) => run?.cost).filter(Number.isFinite);
  return {
    calls: runs.length,
    errors: errors.length,
    errorSamples: [...new Set(errors.map((run) => run.error))].slice(0, 3),
    providers: Object.fromEntries([...new Set(runs.map((run) => run?.provider).filter(Boolean))]
      .map((provider) => [provider, runs.filter((run) => run?.provider === provider).length])),
    sources: Object.fromEntries([...new Set(runs.map((run) => run?.source).filter(Boolean))]
      .map((source) => [source, runs.filter((run) => run?.source === source).length])),
    latencyMs: { p50: percentile(runs.map((run) => run?.latencyMs), 0.5), p95: percentile(runs.map((run) => run?.latencyMs), 0.95) },
    costPerThousandDecisionsUsd: costs.length ? (costs.reduce((sum, cost) => sum + cost, 0) / costs.length) * 1000 : null,
    orderFlipRate: paired ? flips / paired : null,
    ...analyze(cases, evidence(0), hasFits),
    reversedOrder: analyzeFixed(cases, evidence(1)),
  };
}

function analyzeFixed(cases, evidenceFor) {
  return { calibration: calibration(cases, evidenceFor).ece, argmax: argmaxReport(cases, evidenceFor) };
}

/** What the top option alone would do with no thresholds, per case kind. */
function argmaxReport(cases, evidenceFor) {
  const report = {};
  for (const filingCase of cases) {
    const evidence = evidenceFor(filingCase);
    if (!evidence) continue;
    const top = Object.entries(evidence.probabilities).sort((left, right) => right[1] - left[1])[0][0];
    const key = `${filingCase.kind}${filingCase.adversarial ? "+adv" : ""}`;
    report[key] ??= { n: 0, correct: 0 };
    report[key].n += 1;
    if (top === filingCase.expected) report[key].correct += 1;
  }
  return Object.fromEntries(Object.entries(report).map(([key, value]) => [key, { n: value.n, accuracy: value.correct / value.n }]));
}

function analyze(cases, evidenceFor, hasFits) {
  const folds = [0, 1].map((fold) => cases.filter((filingCase) => foldOf(filingCase) === fold));
  const crossValidated = folds.map((train, fold) => {
    const test = folds[1 - fold];
    const ungrouped = sweepUngrouped(train, evidenceFor, hasFits);
    const grouped = sweepGrouped(train, evidenceFor);
    return {
      trainedOnFold: fold,
      ungrouped: ungrouped && { thresholds: ungrouped.thresholds, test: scoreUngrouped(test, evidenceFor, ungrouped.thresholds) },
      grouped: grouped && { thresholds: grouped.thresholds, test: scoreGrouped(test, evidenceFor, grouped.thresholds) },
    };
  });
  const ungrouped = sweepUngrouped(cases, evidenceFor, hasFits);
  const grouped = sweepGrouped(cases, evidenceFor);
  const adversarial = cases.filter((filingCase) => filingCase.adversarial);
  const recommended = ungrouped && grouped
    ? { ...ungrouped.thresholds, applyGrouped: grouped.thresholds.applyGrouped, stay: grouped.thresholds.stay, marginGrouped: grouped.thresholds.margin }
    : null;
  return {
    argmax: argmaxReport(cases, evidenceFor),
    calibration: calibration(cases, evidenceFor),
    recommended,
    inSample: { ungrouped: ungrouped?.score ?? null, grouped: grouped?.score ?? null },
    crossValidated,
    adversarialAtRecommended: recommended && {
      ungrouped: scoreUngrouped(adversarial, evidenceFor, recommended),
      grouped: scoreGrouped(adversarial, evidenceFor, { ...recommended, margin: recommended.marginGrouped }),
    },
    planDefaults: {
      ungrouped: scoreUngrouped(cases, evidenceFor, { ...BASE_THRESHOLDS, fit: hasFits ? 0.5 : null }),
      grouped: scoreGrouped(cases, evidenceFor, BASE_THRESHOLDS),
    },
  };
}

function summarizeEmbedding(cases, results) {
  const byId = new Map(results.map((entry) => [entry.caseId, entry.scores]));
  let best = null;
  const sweeps = [];
  for (const temperature of [0.01, 0.02, 0.03, 0.05]) {
    for (const noneBias of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75]) {
      const settings = { temperature, noneBias };
      const evidenceFor = (filingCase) => ({ probabilities: embeddingDistribution(byId.get(filingCase.id), filingCase, settings), fits: null });
      const summary = analyze(cases, evidenceFor, false);
      const fileAccuracy = summary.inSample.ungrouped?.fileAccuracy ?? 0;
      sweeps.push({ ...settings, fileAccuracy, driftAccuracy: summary.inSample.grouped?.driftAccuracy ?? 0 });
      if (!best || fileAccuracy > best.fileAccuracy) best = { settings, fileAccuracy, summary };
    }
  }
  return { softmax: best.settings, ...best.summary, sweeps };
}

/** Every n-th case within each kind, so a subset keeps the kind mix. */
function stratifiedSubset(cases, limit) {
  const fraction = Math.min(1, limit / cases.length);
  const seen = {};
  return cases.filter((filingCase) => {
    const key = `${filingCase.kind}${filingCase.adversarial ? "+adv" : ""}`;
    seen[key] = (seen[key] ?? 0) + 1;
    return Math.floor(seen[key] * fraction) !== Math.floor((seen[key] - 1) * fraction);
  });
}

export async function runFilingBenchmark(config, { env = process.env, log = () => {} } = {}) {
  const corpora = [];
  for (const source of config.corpora ?? []) {
    const module = await import(new URL(source.module, `file://${process.cwd()}/`).href);
    corpora.push(...(module[source.export] ?? []));
  }
  const unique = [...new Map(corpora.map((item) => [item.id, item])).values()];
  let cases = buildFilingCases(unique, { adversarialEvery: config.adversarialEvery ?? 3 });
  if (config.maxCases) cases = cases.filter((_, index) => index % Math.ceil(cases.length / config.maxCases) === 0);
  const kinds = Object.fromEntries([...new Set(cases.map((item) => item.kind))]
    .map((kind) => [kind, cases.filter((item) => item.kind === kind).length]));
  log(`${cases.length} filing cases from ${unique.length} windows: ${JSON.stringify(kinds)}, adversarial ${cases.filter((item) => item.adversarial).length}\n`);
  if (config.dryRun) return { cases: cases.length, kinds };
  const candidates = (config.candidates ?? []).map((source) => resolveCandidate(source, env));
  const report = { generatedAt: new Date().toISOString(), gate: GATE, caseCounts: kinds, candidates: [] };
  for (const candidate of candidates) {
    log(`→ ${candidate.name} (${candidate.protocol}, ${candidate.model})\n`);
    const started = Date.now();
    const candidateCases = candidate.maxCases ? stratifiedSubset(cases, candidate.maxCases) : cases;
    const slug = `${candidate.protocol}-${candidate.model}${candidate.style && candidate.style !== "json" ? `-${candidate.style}` : ""}`.replace(/[^a-z0-9.-]+/gi, "_");
    const cache = config.cacheDir ? await openResultCache(`${config.cacheDir}/${slug}.jsonl`) : undefined;
    const { entries: results, stopped } = await runCandidate(candidate, candidateCases, {
      orderRuns: candidate.orderRuns ?? 2,
      cache,
      onProgress: (done, total) => { if (done % 50 === 0 || done === total) log(`  ${done}/${total}\n`); },
    });
    if (stopped) log(`  stopped by the provider's rate limit after ${results.length}/${candidateCases.length} cases: ${stopped}\n`);
    const scoredCases = candidateCases.filter((filingCase) => results.some((entry) => entry.caseId === filingCase.id));
    const hasFits = (candidate.protocol === "decision_api" && candidate.style !== "per_group") || Boolean(candidate.askFits);
    const summary = candidate.protocol === "embedding"
      ? summarizeEmbedding(scoredCases, results)
      : summarizeModel(scoredCases, results, hasFits);
    report.candidates.push({
      name: candidate.name, protocol: candidate.protocol, model: candidate.model, style: candidate.style ?? "json",
      casesScored: scoredCases.length, casesPlanned: candidateCases.length, stoppedByRateLimit: stopped ?? null,
      wallSeconds: (Date.now() - started) / 1000, ...summary, raw: results,
    });
  }
  return report;
}

export function formatFilingReport(report) {
  const pct = (value) => (value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`);
  const lines = [`Filing benchmark — gate: false-file ≤ ${pct(GATE.falseFile)}, false-move-out ≤ ${pct(GATE.falseMoveOut)}, held-out filed ≥ ${pct(GATE.heldoutFiled)}`];
  for (const candidate of report.candidates) {
    lines.push("", `${candidate.name} [${candidate.protocol} ${candidate.model}] — ${candidate.casesScored}/${candidate.casesPlanned} cases${candidate.stoppedByRateLimit ? " (stopped by rate limit)" : ""}`);
    if (candidate.calls !== undefined) {
      lines.push(`  calls ${candidate.calls}, errors ${candidate.errors}, sources ${JSON.stringify(candidate.sources)}, providers ${JSON.stringify(candidate.providers)}, p50 ${Math.round(candidate.latencyMs.p50 ?? 0)} ms, p95 ${Math.round(candidate.latencyMs.p95 ?? 0)} ms, $/1k ${candidate.costPerThousandDecisionsUsd?.toFixed(4) ?? "—"}, order flips ${pct(candidate.orderFlipRate)}`);
    } else {
      lines.push(`  softmax T=${candidate.softmax.temperature}, none bias ${candidate.softmax.noneBias}`);
    }
    lines.push(`  argmax: ${Object.entries(candidate.argmax).map(([key, value]) => `${key} ${pct(value.accuracy)} (${value.n})`).join(", ")}`);
    lines.push(`  ECE ${candidate.calibration.ece.toFixed(3)}`);
    const u = candidate.inSample.ungrouped;
    const g = candidate.inSample.grouped;
    lines.push(`  recommended ${JSON.stringify(candidate.recommended)}`);
    if (candidate.protocol !== "embedding") {
      const gate = crossValidatedGate(candidate);
      lines.push(`  ship gate (cross-validated): filing ${gate.ungrouped ? "passes" : "fails"}, re-filing grouped tabs ${gate.grouped ? "passes" : "fails"}`);
    }
    lines.push(`  in-sample ungrouped: filed ${pct(u?.fileAccuracy)}, wrong group ${pct(u?.wrongGroupRate)}, false-file ${pct(u?.falseFileRate)}`);
    lines.push(`  in-sample grouped: drift ${pct(g?.driftAccuracy)} (move ${pct(g?.driftMoveAccuracy)}, out ${pct(g?.driftOutAccuracy)}), false-move-out ${pct(g?.falseMoveOutRate)}, drift wrong ${pct(g?.driftWrongRate)}`);
    for (const fold of candidate.crossValidated) {
      lines.push(`  CV train ${fold.trainedOnFold}→test: filed ${pct(fold.ungrouped?.test.fileAccuracy)}, false-file ${pct(fold.ungrouped?.test.falseFileRate)}, wrong ${pct(fold.ungrouped?.test.wrongGroupRate)}; drift ${pct(fold.grouped?.test.driftAccuracy)}, drift wrong ${pct(fold.grouped?.test.driftWrongRate)}, false-move-out ${pct(fold.grouped?.test.falseMoveOutRate)}`);
    }
    const pd = candidate.planDefaults;
    lines.push(`  plan defaults (0.85/0.3): filed ${pct(pd.ungrouped.fileAccuracy)}, false-file ${pct(pd.ungrouped.falseFileRate)}, wrong ${pct(pd.ungrouped.wrongGroupRate)}; drift ${pct(pd.grouped.driftAccuracy)}, drift wrong ${pct(pd.grouped.driftWrongRate)}, false-move-out ${pct(pd.grouped.falseMoveOutRate)}`);
    const adv = candidate.adversarialAtRecommended;
    if (adv) lines.push(`  adversarial @recommended: filed ${pct(adv.ungrouped.fileAccuracy)}, false-file ${pct(adv.ungrouped.falseFileRate)}, wrong ${pct(adv.ungrouped.wrongGroupRate)}; false-move-out ${pct(adv.grouped.falseMoveOutRate)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Calibration export: the file Settings → Auto-filing → Advanced → Import calibration reads.

export const CALIBRATION_FORMAT = "sheaf-filing-calibrations";

function crossValidatedGate(candidate) {
  const folds = candidate.crossValidated ?? [];
  const ungrouped = folds.length > 0 && folds.every((fold) => fold.ungrouped &&
    fold.ungrouped.test.falseFileRate <= GATE.falseFile &&
    fold.ungrouped.test.wrongGroupRate <= GATE.wrongGroup &&
    fold.ungrouped.test.fileAccuracy >= GATE.heldoutFiled);
  const grouped = folds.length > 0 && folds.every((fold) => fold.grouped &&
    fold.grouped.test.falseMoveOutRate <= GATE.falseMoveOut &&
    fold.grouped.test.driftWrongRate <= GATE.wrongGroup);
  return { ungrouped, grouped };
}

/**
 * One calibration per decision-model candidate with a recommendation. The
 * extension has one margin for both kinds of tab, so it takes the stricter of
 * the two the benchmark recommends. Embedding candidates are skipped: the
 * extension has no embedding tier.
 */
export function filingCalibrations(report) {
  const calibrations = [];
  for (const candidate of report.candidates) {
    if (candidate.protocol === "embedding" || !candidate.recommended) continue;
    const { apply, margin, fit, applyGrouped, stay, marginGrouped } = candidate.recommended;
    const gate = crossValidatedGate(candidate);
    calibrations.push({
      protocol: candidate.protocol,
      model: candidate.model,
      style: candidate.style ?? "json",
      thresholds: { apply, margin: Math.max(margin, marginGrouped ?? margin), fit: fit ?? null, applyGrouped, stay },
      meetsGate: gate.ungrouped,
      refileMeetsGate: gate.grouped,
      casesScored: candidate.casesScored,
    });
  }
  return { format: CALIBRATION_FORMAT, version: 1, generatedAt: report.generatedAt, calibrations };
}
