#!/usr/bin/env node

// Searches agreement ensembles over a filing benchmark report (scripts/lib/filing-eval.mjs).
// A member is (candidate, minimum top probability, whether both option orders must agree);
// an ensemble files only when every member's top option is the same and clears its bar.
// Rules are chosen on one fold of source windows and scored on the other, as in the report.
//
//   node scripts/analyze-filing-benchmark.mjs --report private/results/filing.json \
//     --config private/filing-benchmark-config.json [--top 8]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildFilingCases, foldOf, GATE } from "./lib/filing-eval.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
const report = JSON.parse(await readFile(resolve(args.report), "utf8"));
const config = JSON.parse(await readFile(resolve(args.config), "utf8"));
const topCount = Number(args.top ?? 8);

const corpora = [];
for (const source of config.corpora) {
  corpora.push(...((await import(resolve(source.module)))[source.export] ?? []));
}
const cases = buildFilingCases([...new Map(corpora.map((item) => [item.id, item])).values()], {
  adversarialEvery: config.adversarialEvery ?? 3,
});

const models = report.candidates
  .filter((candidate) => candidate.raw?.[0]?.runs)
  .map((candidate) => ({ name: candidate.name, runs: new Map(candidate.raw.map((entry) => [entry.caseId, entry.runs])) }));

function top(probabilities) {
  let best = ["", -1];
  for (const entry of Object.entries(probabilities)) if (entry[1] > best[1]) best = entry;
  return best;
}

// Precompute each model's top option and probability per case and order.
const tops = models.map((model) => new Map(cases.map((filingCase) => {
  const runs = model.runs.get(filingCase.id);
  return [filingCase.id, runs?.[0] ? runs.map((run) => (run ? top(run.probabilities) : null)) : null];
})));

const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99];

function pick(filingCase, members) {
  let option = null;
  for (const member of members) {
    const caseTops = tops[member.model].get(filingCase.id);
    if (!caseTops) return undefined;
    const orders = member.bothOrders ? [caseTops[0], caseTops[1]] : [caseTops[0]];
    for (const entry of orders) {
      if (!entry || entry[1] < member.threshold) return null;
      if (option === null) option = entry[0];
      else if (entry[0] !== option) return null;
    }
  }
  if (option === "stay" || (!filingCase.grouped && option === "none")) return null;
  return option;
}

function score(subset, members, grouped) {
  const counts = { positives: 0, correct: 0, wrong: 0, negatives: 0, negativeMoved: 0, missing: 0 };
  for (const filingCase of subset) {
    if (filingCase.grouped !== grouped) continue;
    const option = pick(filingCase, members);
    if (option === undefined) {
      counts.missing += 1;
      continue;
    }
    const negative = filingCase.kind === "distractor" || filingCase.kind === "control";
    if (negative) {
      counts.negatives += 1;
      if (option !== null) counts.negativeMoved += 1;
    } else {
      counts.positives += 1;
      if (option === filingCase.expected) counts.correct += 1;
      else if (option !== null) counts.wrong += 1;
    }
  }
  const recall = counts.correct / (counts.positives || 1);
  const wrongRate = counts.wrong / (counts.positives || 1);
  const negativeRate = counts.negativeMoved / (counts.negatives || 1);
  const scored = counts.positives + counts.negatives;
  const feasible = counts.missing <= 0.1 * (scored + counts.missing) &&
    wrongRate <= GATE.wrongGroup && negativeRate <= (grouped ? GATE.falseMoveOut : GATE.falseFile);
  return { ...counts, recall, wrongRate, negativeRate, feasible };
}

function* memberSets() {
  for (let left = 0; left < models.length; left += 1) {
    for (const threshold of THRESHOLDS) for (const bothOrders of [false, true]) {
      yield [{ model: left, threshold, bothOrders }];
    }
    for (let right = left + 1; right < models.length; right += 1) {
      for (const leftThreshold of THRESHOLDS) for (const rightThreshold of THRESHOLDS) {
        for (const leftBoth of [false, true]) for (const rightBoth of [false, true]) {
          yield [
            { model: left, threshold: leftThreshold, bothOrders: leftBoth },
            { model: right, threshold: rightThreshold, bothOrders: rightBoth },
          ];
        }
      }
    }
  }
}

const describe = (members) => members
  .map((member) => `${models[member.model].name} ≥${member.threshold}${member.bothOrders ? " both orders" : ""}`)
  .join(" + ");
const pct = (value) => `${(value * 100).toFixed(1)}%`;

for (const grouped of [false, true]) {
  const folds = [0, 1].map((fold) => cases.filter((filingCase) => foldOf(filingCase) === fold));
  const results = [];
  for (const members of memberSets()) {
    const all = score(cases, members, grouped);
    if (!all.feasible) continue;
    const cv = [0, 1].map((fold) => {
      const train = score(folds[fold], members, grouped);
      return train.feasible ? score(folds[1 - fold], members, grouped) : null;
    });
    results.push({ members, all, cv });
  }
  results.sort((left, right) => right.all.recall - left.all.recall || left.members.length - right.members.length);
  // Keep the best rule per distinct model combination, so the list shows alternatives.
  const seen = new Set();
  const best = results.filter((result) => {
    const key = result.members.map((member) => member.model).join("+");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, topCount);
  process.stdout.write(`\n${grouped ? "Grouped tabs that changed site (move or leave)" : "Ungrouped tabs (file into a group)"} — feasible rules by recall\n`);
  for (const result of best) {
    const negative = grouped ? "false-move-out" : "false-file";
    const cv = result.cv.map((fold) => (fold ? `${pct(fold.recall)}/${pct(fold.negativeRate)}/${pct(fold.wrongRate)}` : "infeasible on train")).join(", ");
    process.stdout.write(`  ${pct(result.all.recall)} ${grouped ? "drift handled" : "filed"}, wrong ${pct(result.all.wrongRate)}, ${negative} ${pct(result.all.negativeRate)} | held-out folds (recall/${negative}/wrong): ${cv}\n    ${describe(result.members)}\n`);
  }
}
