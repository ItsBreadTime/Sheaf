#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scoreBehaviorResponse } from "./lib/behavior-quality.ts";

const resultPath = resolve(
  process.cwd(),
  process.argv[2] ?? "organizer-behavior-benchmark-results.json",
);
const configPath = resolve(
  process.cwd(),
  process.argv[3] ?? "organizer-behavior-benchmark.json",
);
const outputPath = process.argv[4] ? resolve(process.cwd(), process.argv[4]) : "";
const [result, config] = await Promise.all([
  readFile(resultPath, "utf8").then(JSON.parse),
  readFile(configPath, "utf8").then(JSON.parse),
]);
const caseConfig = new Map(config.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]));
const resultCases = new Map(result.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]));

const candidates = result.candidates.map((candidate) => {
  const runs = candidate.cases.map((caseResult) => {
    const benchmarkCase = resultCases.get(caseResult.caseId);
    const configuredCase = caseConfig.get(caseResult.caseId);
    if (!benchmarkCase) throw new Error(`Result references unknown case ${caseResult.caseId}.`);
    if (!configuredCase) throw new Error(`Case ${caseResult.caseId} is missing from the benchmark config.`);
    let input;
    try {
      input = JSON.parse(benchmarkCase.input);
    } catch {
      throw new Error(`Case ${caseResult.caseId} has invalid JSON input.`);
    }
    return {
      caseId: caseResult.caseId,
      runIndex: caseResult.runIndex,
      output: caseResult.output,
      score: scoreBehaviorResponse(
        caseResult.output,
        input.tabs.map((tab) => tab.id),
        configuredCase.behaviorSpec,
      ),
    };
  });
  const average = (selector) =>
    runs.reduce((sum, run) => sum + selector(run.score), 0) / runs.length;
  const byCase = [...new Set(runs.map((run) => run.caseId))].map((caseId) => {
    const caseRuns = runs.filter((run) => run.caseId === caseId);
    return {
      caseId,
      averageScore: caseRuns.reduce((sum, run) => sum + run.score.totalScore, 0) / caseRuns.length,
      groupingScore: caseRuns.reduce((sum, run) => sum + run.score.groupingScore, 0) / caseRuns.length,
      namingScore: caseRuns.reduce((sum, run) => sum + run.score.namingScore, 0) / caseRuns.length,
      clutterScore: caseRuns.reduce((sum, run) => sum + run.score.clutterScore, 0) / caseRuns.length,
      colorScore: caseRuns.reduce((sum, run) => sum + run.score.colorScore, 0) / caseRuns.length,
      contractRate: caseRuns.filter((run) => run.score.contractValid).length / caseRuns.length,
      overmergedGroups: caseRuns.reduce((sum, run) => sum + run.score.overmergedGroups, 0),
    };
  });
  return {
    candidate: candidate.candidate.name,
    promptChars: candidate.systemPromptChars,
    averageScore: average((score) => score.totalScore),
    groupingScore: average((score) => score.groupingScore),
    namingScore: average((score) => score.namingScore),
    clutterScore: average((score) => score.clutterScore),
    colorScore: average((score) => score.colorScore),
    pairPrecision: average((score) => score.pairPrecision),
    pairRecall: average((score) => score.pairRecall),
    contractRate: runs.filter((run) => run.score.contractValid).length / runs.length,
    overmergedGroups: runs.reduce((sum, run) => sum + run.score.overmergedGroups, 0),
    totalTokens: candidate.totalUsage?.totalTokens ?? null,
    promptTokens: candidate.totalUsage?.promptTokens ?? null,
    completionTokens: candidate.totalUsage?.completionTokens ?? null,
    energyJoules: candidate.totalEnergy?.energyJoules ?? null,
    costUsd: candidate.totalCost?.requestCostUsd ?? null,
    averageLatencyMs: candidate.averageDurationMs,
    byCase,
    runs,
  };
});

console.table(candidates.map(({ byCase: _byCase, runs: _runs, ...candidate }) => ({
  ...candidate,
  averageScore: Number(candidate.averageScore.toFixed(1)),
  groupingScore: Number(candidate.groupingScore.toFixed(1)),
  namingScore: Number(candidate.namingScore.toFixed(1)),
  clutterScore: Number(candidate.clutterScore.toFixed(1)),
  colorScore: Number(candidate.colorScore.toFixed(1)),
  pairPrecision: `${Math.round(candidate.pairPrecision * 100)}%`,
  pairRecall: `${Math.round(candidate.pairRecall * 100)}%`,
  contractRate: `${Math.round(candidate.contractRate * 100)}%`,
  energyJoules: Number(candidate.energyJoules?.toFixed(2)),
  costUsd: Number(candidate.costUsd?.toFixed(6)),
  averageLatencyMs: Math.round(candidate.averageLatencyMs),
})));
candidates.forEach((candidate) => {
  process.stdout.write(`\n${candidate.candidate}\n`);
  console.table(candidate.byCase.map((benchmarkCase) => ({
    ...benchmarkCase,
    averageScore: Number(benchmarkCase.averageScore.toFixed(1)),
    groupingScore: Number(benchmarkCase.groupingScore.toFixed(1)),
    namingScore: Number(benchmarkCase.namingScore.toFixed(1)),
    clutterScore: Number(benchmarkCase.clutterScore.toFixed(1)),
    colorScore: Number(benchmarkCase.colorScore.toFixed(1)),
    contractRate: `${Math.round(benchmarkCase.contractRate * 100)}%`,
  })));
});

if (outputPath) {
  await writeFile(
    outputPath,
    `${JSON.stringify({ resultPath, configPath, candidates }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${outputPath}\n`);
}
