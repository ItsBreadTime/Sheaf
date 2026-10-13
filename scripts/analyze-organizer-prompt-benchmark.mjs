#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const expectedByCase = {
  "projects-and-isolate": {
    groups: [[1, 2], [3, 4]],
    untouched: [5],
    lowValue: [],
    colorMode: "deterministic",
  },
  "avoid-association-chain": {
    groups: [[2, 3, 4]],
    untouched: [1, 5],
    lowValue: [],
    colorMode: "deterministic",
  },
  "existing-group-churn": {
    groups: [[1, 2], [3, 4], [5, 6]],
    untouched: [],
    lowValue: [],
    colorMode: "deterministic",
  },
  "rules-preference-colors": {
    groups: [[1, 2, 3], [4, 5]],
    untouched: [],
    lowValue: [],
    colorMode: "ai",
  },
  "clutter-and-injection": {
    groups: [[3, 4]],
    untouched: [1, 2, 5, 6],
    lowValue: [1, 2],
    colorMode: "deterministic",
  },
};

const allowedColors = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const sortedSignature = (ids) => [...ids].sort((a, b) => a - b).join(",");
const groupSignatures = (groups) => groups.map(sortedSignature).sort();
const equalArrays = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function strictContract(output, submittedIds) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    return { valid: false, reason: "invalid_json" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, reason: "not_object" };
  if (!equalArrays(Object.keys(value).sort(), ["groups", "lowValueTabIds", "schemaVersion", "untouchedTabIds"])) {
    return { valid: false, reason: "top_level_shape" };
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.groups) || !Array.isArray(value.untouchedTabIds) || !Array.isArray(value.lowValueTabIds)) {
    return { valid: false, reason: "required_fields" };
  }
  const assigned = [];
  for (let index = 0; index < value.groups.length; index += 1) {
    const group = value.groups[index];
    if (!group || typeof group !== "object" || Array.isArray(group)) return { valid: false, reason: "group_object" };
    if (!equalArrays(Object.keys(group).sort(), ["color", "tabIds", "temporaryId", "title"])) return { valid: false, reason: "group_shape" };
    if (group.temporaryId !== `group-${index + 1}` || typeof group.title !== "string" || group.title.length === 0 || Array.from(group.title).length > 24) {
      return { valid: false, reason: "group_identity" };
    }
    if (!Array.isArray(group.tabIds) || group.tabIds.length < 2 || !group.tabIds.every(Number.isSafeInteger)) {
      return { valid: false, reason: "group_ids" };
    }
    assigned.push(...group.tabIds);
  }
  if (!value.untouchedTabIds.every(Number.isSafeInteger) || !value.lowValueTabIds.every(Number.isSafeInteger)) {
    return { valid: false, reason: "id_type" };
  }
  assigned.push(...value.untouchedTabIds);
  const expectedIds = [...submittedIds].sort((a, b) => a - b);
  const actualIds = [...assigned].sort((a, b) => a - b);
  if (!equalArrays(actualIds, expectedIds)) return { valid: false, reason: "assignment_coverage" };
  if (new Set(value.lowValueTabIds).size !== value.lowValueTabIds.length ||
      value.lowValueTabIds.some((id) => !expectedIds.includes(id))) {
    return { valid: false, reason: "low_value_ids" };
  }
  return { valid: true, value };
}

function permissiveValue(output) {
  try {
    return JSON.parse(output);
  } catch {
    const fenced = output.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
    if (!fenced) return null;
    try {
      return JSON.parse(fenced);
    } catch {
      return null;
    }
  }
}

function analyzeCase(benchmarkCase, caseResult) {
  const expected = expectedByCase[benchmarkCase.id];
  const input = JSON.parse(benchmarkCase.input);
  const contract = strictContract(caseResult.output, input.tabs.map((tab) => tab.id));
  const value = contract.valid ? contract.value : permissiveValue(caseResult.output);
  if (!value || !Array.isArray(value.groups) || !Array.isArray(value.untouchedTabIds) || !Array.isArray(value.lowValueTabIds)) {
    return {
      contractValid: false,
      exactPartition: false,
      exactLowValue: false,
      colorValid: false,
      orderValid: false,
      exact: false,
      failure: contract.reason,
    };
  }
  const exactPartition =
    value.groups.every((group) => Array.isArray(group?.tabIds)) &&
    equalArrays(groupSignatures(value.groups.map((group) => group.tabIds)), groupSignatures(expected.groups)) &&
    equalArrays(value.untouchedTabIds, expected.untouched);
  const exactLowValue = equalArrays(value.lowValueTabIds, expected.lowValue);
  const colorValid = value.groups.every((group) =>
    expected.colorMode === "ai" ? allowedColors.has(group.color) : group.color === null);
  const orderedGroupIds = value.groups.flatMap((group) => group.tabIds.slice(0, 1));
  const orderValid =
    equalArrays(orderedGroupIds, [...orderedGroupIds].sort((a, b) => a - b)) &&
    value.groups.every((group) => equalArrays(group.tabIds, [...group.tabIds].sort((a, b) => a - b))) &&
    equalArrays(value.untouchedTabIds, [...value.untouchedTabIds].sort((a, b) => a - b)) &&
    equalArrays(value.lowValueTabIds, [...value.lowValueTabIds].sort((a, b) => a - b));
  return {
    contractValid: contract.valid,
    exactPartition,
    exactLowValue,
    colorValid,
    orderValid,
    exact: contract.valid && exactPartition && exactLowValue && colorValid && orderValid,
    failure: contract.valid ? null : contract.reason,
  };
}

const resultPath = resolve(process.cwd(), process.argv[2] ?? "organizer-prompt-benchmark-results.json");
const outputPath = process.argv[3] ? resolve(process.cwd(), process.argv[3]) : "";
const result = JSON.parse(await readFile(resultPath, "utf8"));
const casesById = new Map(result.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]));
const analysis = result.candidates.map((candidate) => {
  const checks = candidate.cases.map((caseResult) => ({
    caseId: caseResult.caseId,
    runIndex: caseResult.runIndex,
    graderScore: caseResult.grade.score,
    ...analyzeCase(casesById.get(caseResult.caseId), caseResult),
  }));
  const rate = (key) => checks.filter((check) => check[key]).length / checks.length;
  return {
    candidate: candidate.candidate.name,
    model: candidate.candidate.provider.config.model,
    promptChars: candidate.systemPromptChars,
    averageScore: candidate.averageScore,
    passRate: candidate.passRate,
    contractRate: rate("contractValid"),
    exactPartitionRate: rate("exactPartition"),
    exactLowValueRate: rate("exactLowValue"),
    colorRate: rate("colorValid"),
    exactRate: rate("exact"),
    averageLatencyMs: candidate.averageDurationMs,
    promptTokens: candidate.totalUsage?.promptTokens ?? null,
    completionTokens: candidate.totalUsage?.completionTokens ?? null,
    totalTokens: candidate.totalUsage?.totalTokens ?? null,
    energyJoules: candidate.totalEnergy?.energyJoules ?? null,
    costUsd: candidate.totalCost?.requestCostUsd ?? null,
    checks,
  };
});

console.table(analysis.map(({ checks: _checks, ...summary }) => ({
  ...summary,
  passRate: `${Math.round(summary.passRate * 100)}%`,
  contractRate: `${Math.round(summary.contractRate * 100)}%`,
  exactPartitionRate: `${Math.round(summary.exactPartitionRate * 100)}%`,
  exactLowValueRate: `${Math.round(summary.exactLowValueRate * 100)}%`,
  exactRate: `${Math.round(summary.exactRate * 100)}%`,
  energyJoules: summary.energyJoules === null ? null : Number(summary.energyJoules.toFixed(2)),
  costUsd: summary.costUsd === null ? null : Number(summary.costUsd.toFixed(6)),
})));

if (outputPath) {
  await writeFile(outputPath, `${JSON.stringify({ source: resultPath, candidates: analysis }, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n`);
}
