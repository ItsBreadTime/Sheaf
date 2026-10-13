#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runSyntheticBenchmark } from "../src/benchmark/benchmark.ts";
import { scoreBehaviorResponse } from "./lib/behavior-quality.ts";

function usage(exitCode = 0) {
  const message = `Sheaf benchmark CLI

Usage:
  sheaf-benchmark --config <file> [--output <file>] [--dry-run]
  sheaf-benchmark --mode filing --config <file> [--output <file>] [--calibrations <file>] [--dry-run]
  npm run benchmark -- --config benchmark.example.json --output benchmark-results.json

Options:
  --config <file>  Benchmark definition JSON.
  --output <file>  Write the complete result, including cases and grades, as JSON.
  --mode <mode>    "organizer" (default) or "filing": the auto-filing decision benchmark.
  --calibrations <file>
                   Filing mode: write the recommended thresholds in the format
                   Settings → Auto-filing → Advanced → Import calibration reads.
  --dry-run        Validate configuration and print the expected call count only.
  --help           Show this help.
`;
  (exitCode === 0 ? process.stdout : process.stderr).write(message);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const result = { config: "", output: "", calibrations: "", dryRun: false, mode: "organizer" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") usage(0);
    if (value === "--dry-run") result.dryRun = true;
    else if (value === "--config" || value === "-c") result.config = argv[++index] ?? "";
    else if (value === "--output" || value === "-o") result.output = argv[++index] ?? "";
    else if (value === "--mode") result.mode = argv[++index] ?? "";
    else if (value === "--calibrations") result.calibrations = argv[++index] ?? "";
    else if (value?.startsWith("-")) throw new Error(`Unknown option: ${value}`);
  }
  if (!result.config) throw new Error("--config is required.");
  if (result.mode !== "organizer" && result.mode !== "filing") throw new Error(`Unknown mode: ${result.mode}`);
  if (result.calibrations && result.mode !== "filing") throw new Error("--calibrations needs --mode filing.");
  return result;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function provider(value, label) {
  const source = object(value, label);
  const origin = String(source.origin ?? "").trim().replace(/\/+$/, "");
  const endpointPath = String(source.endpointPath ?? "/v1/chat/completions").trim();
  const model = String(source.model ?? "").trim();
  const apiKeyEnv = String(source.apiKeyEnv ?? "").trim();
  if (!origin || !/^https?:\/\//.test(origin)) throw new Error(`${label}.origin must be an HTTP(S) URL.`);
  if (!model) throw new Error(`${label}.model is required.`);
  const temperature = source.temperature === undefined ? undefined : Number(source.temperature);
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error(`${label}.temperature must be between 0 and 2.`);
  }
  return {
    name: String(source.name ?? label),
    apiKey: apiKeyEnv ? process.env[apiKeyEnv] : "",
    apiKeyEnv,
    jsonResponseFormat: source.jsonResponseFormat !== false,
    config: {
      origin,
      endpointPath: endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`,
      model,
      customHeaders: object(source.headers ?? {}, `${label}.headers`),
      extraBody: object(source.extraBody ?? {}, `${label}.extraBody`),
      temperature,
      reasoningEffort: source.reasoningEffort,
      reasoning: source.reasoning,
      manualStreamingEnabled: false,
    },
  };
}

function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function finiteMetric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function complete(target, messages, json) {
  const endpoint = new URL(target.config.endpointPath, `${target.config.origin}/`);
  const headers = new Headers(target.config.customHeaders);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`);
  const body = {
    ...target.config.extraBody,
    model: target.config.model,
    messages,
    stream: false,
    ...(json && target.jsonResponseFormat ? { response_format: { type: "json_object" } } : {}),
    ...(target.config.temperature === undefined ? {} : { temperature: target.config.temperature }),
    ...(target.config.reasoningEffort === undefined ? {} : { reasoning_effort: target.config.reasoningEffort }),
    ...(target.config.reasoning === undefined ? {} : { reasoning: target.config.reasoning }),
  };
  let response;
  let text = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    text = await response.text();
    if (response.status !== 429 || attempt === 5) break;
    let retryAfterSeconds = Number(response.headers.get("retry-after"));
    try {
      const errorBody = JSON.parse(text);
      retryAfterSeconds = Number(errorBody?.error?.retry_after ?? retryAfterSeconds);
    } catch {
      // Use the header or exponential fallback when the provider body is not JSON.
    }
    const fallbackSeconds = Math.min(30, 2 ** attempt);
    const delayMs = Math.max(250, Math.min(30_000, (Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : fallbackSeconds) * 1_000));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  if (!response) throw new Error(`${target.name} did not return a response.`);
  if (!response.ok) throw new Error(`${target.name} returned HTTP ${response.status}${text ? `: ${text.slice(0, 2_000)}` : "."}`);
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${target.name} returned a non-JSON Chat Completions response.`); }
  const content = value?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) throw new Error(`${target.name} response did not include assistant text.`);
  const reported = value?.usage ?? {};
  const energy = value?.energy ?? {};
  const cost = value?.cost ?? {};
  return {
    content,
    usage: {
      promptTokens: tokenCount(reported.prompt_tokens),
      completionTokens: tokenCount(reported.completion_tokens),
      totalTokens: tokenCount(reported.total_tokens),
      cachedTokens: tokenCount(reported.prompt_tokens_details?.cached_tokens ?? reported.cached_tokens),
    },
    energy: {
      energyKwh: finiteMetric(energy.energy_kwh),
      energyJoules: finiteMetric(energy.energy_joules),
      averagePowerWatts: finiteMetric(energy.avg_power_watts),
      durationSeconds: finiteMetric(energy.duration_seconds),
      measurementAvailable: typeof energy.measurement_available === "boolean"
        ? energy.measurement_available
        : finiteMetric(energy.energy_joules) !== null,
    },
    cost: {
      requestCostUsd: finiteMetric(cost.request_cost_usd),
      cacheSavingsUsd: finiteMetric(cost.cache_savings_usd),
    },
  };
}

function reportSummary(result) {
  process.stdout.write(`\nCompleted ${result.datasetCount} dataset(s) × ${result.casesPerDataset} case(s) × ${result.repetitions} run(s).\n\n`);
  console.table(result.candidates.map((candidate, index) => ({
    rank: index + 1,
    candidate: candidate.candidate.name,
    provider: candidate.candidate.provider.name,
    model: candidate.candidate.provider.config.model,
    score: Number(candidate.averageScore.toFixed(1)),
    passRate: `${Math.round(candidate.passRate * 100)}%`,
    averageLatencyMs: Math.round(candidate.averageDurationMs),
    promptChars: candidate.systemPromptChars,
    totalTokens: candidate.totalUsage?.totalTokens ?? "unreported",
    energyJoules: candidate.totalEnergy?.energyJoules === null || candidate.totalEnergy?.energyJoules === undefined
      ? "unreported"
      : Number(candidate.totalEnergy.energyJoules.toFixed(3)),
    costUsd: candidate.totalCost?.requestCostUsd === null || candidate.totalCost?.requestCostUsd === undefined
      ? "unreported"
      : Number(candidate.totalCost.requestCostUsd.toFixed(6)),
  })));
}

try {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(process.cwd(), args.config);
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  if (args.mode === "filing") {
    const { runFilingBenchmark, formatFilingReport, filingCalibrations } = await import("./lib/filing-eval.mjs");
    const report = await runFilingBenchmark({ ...raw, dryRun: args.dryRun }, { log: (line) => process.stderr.write(line) });
    if (args.dryRun) process.exit(0);
    process.stdout.write(`${formatFilingReport(report)}\n`);
    if (args.output) {
      await writeFile(resolve(process.cwd(), args.output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`Full report written to ${resolve(process.cwd(), args.output)}\n`);
    }
    if (args.calibrations) {
      const exported = filingCalibrations(report);
      await writeFile(resolve(process.cwd(), args.calibrations), `${JSON.stringify(exported, null, 2)}\n`, "utf8");
      process.stdout.write(`${exported.calibrations.length} calibration(s) written to ${resolve(process.cwd(), args.calibrations)}\n`);
    }
    process.exit(0);
  }
  const config = object(raw, "Benchmark config");
  const fixedCases = Array.isArray(config.cases) ? config.cases.map((item, index) => {
    const benchmarkCase = object(item, `cases[${index}]`);
    return {
      id: String(benchmarkCase.id ?? `case-${index + 1}`),
      input: String(benchmarkCase.input ?? ""),
      gradingNotes: benchmarkCase.gradingNotes === undefined
        ? undefined
        : String(benchmarkCase.gradingNotes),
      behaviorSpec: benchmarkCase.behaviorSpec,
    };
  }) : undefined;
  const prompts = Array.isArray(config.prompts) ? config.prompts.map((item, index) => {
    const prompt = object(item, `prompts[${index}]`);
    return { id: String(prompt.id ?? `prompt-${index + 1}`), name: String(prompt.name ?? `Prompt ${index + 1}`), text: String(prompt.text ?? "") };
  }) : [];
  const candidates = Array.isArray(config.candidates) ? config.candidates.map((item, index) => {
    const candidate = object(item, `candidates[${index}]`);
    return {
      id: String(candidate.id ?? `candidate-${index + 1}`),
      name: String(candidate.name ?? `Candidate ${index + 1}`),
      promptId: String(candidate.promptId ?? ""),
      provider: provider(candidate.provider, `candidates[${index}].provider`),
    };
  }) : [];
  const datasetCount = Number(config.datasetCount ?? 1);
  const caseCount = Number(config.casesPerDataset ?? 5);
  const repetitions = Number(config.runsPerCase ?? 1);
  const candidateConcurrency = Number(config.candidateConcurrency ?? candidates.length);
  const generator = provider(config.generator, "generator");
  const grader = provider(config.grader, "grader");
  const localGrader = String(config.localGrader ?? "");
  const appPipeline = localGrader === "organizer_app_v1"
    ? (await import("./lib/app-pipeline.mjs")).applyAppPipeline
    : null;
  const totalCases = fixedCases?.length ?? datasetCount * caseCount;
  const callsPerCandidateRun = localGrader ? 1 : 2;
  const expectedCalls = (fixedCases ? 0 : datasetCount) +
    totalCases * repetitions * candidates.length * callsPerCandidateRun;
  if (args.dryRun) {
    process.stdout.write(`Configuration valid. Expected model calls: ${expectedCalls}\n`);
    process.exit(0);
  }
  const requiredTargets = [
    generator,
    ...(localGrader ? [] : [grader]),
    ...candidates.map((candidate) => candidate.provider),
  ];
  for (const target of requiredTargets) {
    if (target.apiKeyEnv && !target.apiKey) throw new Error(`${target.name} requires the ${target.apiKeyEnv} environment variable.`);
  }
  process.stderr.write(`Running ${candidates.length} candidate(s) across ${totalCases} ${fixedCases ? "fixed" : "synthetic"} case(s), ${repetitions} time(s) each (~${expectedCalls} calls)…\n`);
  const result = await runSyntheticBenchmark({
    task: String(config.task ?? ""),
    caseCount,
    datasetCount,
    repetitions,
    candidateConcurrency,
    rubric: String(config.rubric ?? ""),
    passScore: config.passScore === undefined ? undefined : Number(config.passScore),
    cases: fixedCases,
    prompts,
    candidates,
    generator,
    grader,
    grade: localGrader === "organizer_behavior_v1" || localGrader === "organizer_app_v1"
      ? (benchmarkCase, completion) => {
          const input = JSON.parse(benchmarkCase.input);
          const submittedIds = Array.isArray(input?.tabs)
            ? input.tabs.map((tab) => tab?.id).filter(Number.isSafeInteger)
            : [];
          if (!benchmarkCase.behaviorSpec || typeof benchmarkCase.behaviorSpec !== "object") {
            throw new Error(`${benchmarkCase.id} requires behaviorSpec for ${localGrader}.`);
          }
          const raw = scoreBehaviorResponse(
            completion.content,
            submittedIds,
            benchmarkCase.behaviorSpec,
          );
          // organizer_app_v1 scores what the extension would show after its local
          // auto-fix and site-bucket guard; raw contract validity is still reported.
          const app = localGrader === "organizer_app_v1" ? appPipeline(completion.content, input) : null;
          const quality = app?.ok
            ? scoreBehaviorResponse(app.content, submittedIds, benchmarkCase.behaviorSpec)
            : raw;
          const metrics = [
            `grouping ${quality.groupingScore.toFixed(0)}`,
            `naming ${quality.namingScore.toFixed(0)}`,
            `precision ${(quality.pairPrecision * 100).toFixed(0)}%`,
            `recall ${(quality.pairRecall * 100).toFixed(0)}%`,
            ...(quality.arrangementScore === null ? [] : [`arrangement ${quality.arrangementScore.toFixed(0)}`]),
            `contract ${raw.contractValid ? "pass" : "fail"}`,
            ...(app ? [app.ok ? `app ${app.demotedTitles.length ? `demoted ${app.demotedTitles.join("/")}` : "ok"}` : `app ${app.error}`] : []),
          ];
          return {
            score: quality.totalScore,
            reason: `${metrics.join("; ")}${quality.reasons.length ? `. ${quality.reasons.join("; ")}.` : "."}`,
          };
        }
      : undefined,
    complete,
  });
  reportSummary(result);
  if (args.output) {
    const outputPath = resolve(process.cwd(), args.output);
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`Full report written to ${outputPath}\n`);
  }
} catch (error) {
  process.stderr.write(`Benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  usage(1);
}
