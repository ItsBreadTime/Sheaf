import type {
  OpenAICompatibleConfig,
  ProviderUsage,
} from "../shared/organizer-types";

export interface BenchmarkProvider {
  name: string;
  config: OpenAICompatibleConfig;
  apiKey: string;
  jsonResponseFormat?: boolean;
}

export interface BenchmarkPrompt {
  id: string;
  name: string;
  text: string;
}

export interface BenchmarkCandidate {
  id: string;
  name: string;
  promptId: string;
  provider: BenchmarkProvider;
}

export interface SyntheticBenchmarkCase {
  id: string;
  input: string;
  datasetIndex?: number;
  gradingNotes?: string;
  behaviorSpec?: unknown;
}

export interface BenchmarkGrade {
  score: number;
  reason: string;
}

export interface BenchmarkEnergy {
  energyKwh: number | null;
  energyJoules: number | null;
  averagePowerWatts: number | null;
  durationSeconds: number | null;
  measurementAvailable: boolean | null;
}

export interface BenchmarkCost {
  requestCostUsd: number | null;
  cacheSavingsUsd: number | null;
}

export interface BenchmarkCompletion {
  content: string;
  usage: ProviderUsage | null;
  energy?: BenchmarkEnergy | null;
  cost?: BenchmarkCost | null;
}

export interface BenchmarkCaseResult {
  caseId: string;
  runIndex: number;
  output: string;
  durationMs: number;
  usage: ProviderUsage | null;
  energy: BenchmarkEnergy | null;
  cost: BenchmarkCost | null;
  grade: BenchmarkGrade;
}

export interface BenchmarkCandidateResult {
  candidate: BenchmarkCandidate;
  systemPromptChars: number;
  averageScore: number;
  passRate: number;
  averageDurationMs: number;
  totalUsage: ProviderUsage | null;
  totalEnergy: BenchmarkEnergy | null;
  totalCost: BenchmarkCost | null;
  cases: BenchmarkCaseResult[];
}

export interface BenchmarkRunResult {
  startedAt: number;
  finishedAt: number;
  datasetCount: number;
  repetitions: number;
  casesPerDataset: number;
  cases: SyntheticBenchmarkCase[];
  candidates: BenchmarkCandidateResult[];
}

export interface BenchmarkRunOptions {
  task: string;
  caseCount: number;
  datasetCount?: number;
  repetitions?: number;
  candidateConcurrency?: number;
  rubric: string;
  passScore?: number;
  cases?: SyntheticBenchmarkCase[];
  prompts: BenchmarkPrompt[];
  candidates: BenchmarkCandidate[];
  generator: BenchmarkProvider;
  grader: BenchmarkProvider;
  grade?: (
    benchmarkCase: SyntheticBenchmarkCase,
    completion: BenchmarkCompletion,
    candidate: BenchmarkCandidate,
  ) => BenchmarkGrade | Promise<BenchmarkGrade>;
  complete: (
    provider: BenchmarkProvider,
    messages: Array<{ role: "system" | "user"; content: string }>,
    json: boolean,
  ) => Promise<BenchmarkCompletion>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced) as unknown;
    const start = Math.min(
      ...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((index) => index >= 0),
    );
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (Number.isFinite(start) && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    throw new Error("The model did not return valid JSON.");
  }
}

export function parseSyntheticCases(content: string, expectedCount: number): SyntheticBenchmarkCase[] {
  const value = parseJsonContent(content);
  const source = Array.isArray(value) ? value : record(value)?.cases;
  if (!Array.isArray(source)) throw new Error("Synthetic data must contain a cases array.");
  const cases = source.flatMap((item, index) => {
    const entry = record(item);
    const input = typeof entry?.input === "string" ? entry.input.trim() : "";
    if (!input) return [];
    return [{
      id: typeof entry?.id === "string" && entry.id.trim() ? entry.id.trim().slice(0, 80) : `case-${index + 1}`,
      input: input.slice(0, 20_000),
    }];
  }).slice(0, expectedCount);
  if (cases.length !== expectedCount) {
    throw new Error(`Synthetic generator returned ${cases.length} usable cases; expected ${expectedCount}.`);
  }
  return cases;
}

export function parseGrade(content: string): BenchmarkGrade {
  const value = record(parseJsonContent(content));
  const rawScore = value?.score;
  const score = typeof rawScore === "number" && Number.isFinite(rawScore)
    ? Math.max(0, Math.min(100, rawScore))
    : null;
  if (score === null) throw new Error("Grader response must include a numeric score from 0 to 100.");
  return {
    score,
    reason: typeof value?.reason === "string" && value.reason.trim()
      ? value.reason.trim().slice(0, 2_000)
      : "No grader explanation provided.",
  };
}

function addUsage(values: Array<ProviderUsage | null>): ProviderUsage | null {
  const available = values.filter((value): value is ProviderUsage => value !== null);
  if (available.length === 0) return null;
  const sum = (key: keyof ProviderUsage): number | null => {
    const counts = available.map((value) => value[key]);
    return counts.some((value) => value === null)
      ? null
      : counts.reduce<number>((total, value) => total + (value ?? 0), 0);
  };
  return {
    promptTokens: sum("promptTokens"),
    completionTokens: sum("completionTokens"),
    totalTokens: sum("totalTokens"),
    cachedTokens: sum("cachedTokens"),
  };
}

function sumMetric<T>(
  values: Array<T | null>,
  key: keyof T,
): number | null {
  const available = values.filter((value): value is T => value !== null);
  if (available.length === 0) return null;
  const counts = available.map((value) => value[key]);
  return counts.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ? null
    : counts.reduce<number>((total, value) => total + (value as number), 0);
}

function addEnergy(values: Array<BenchmarkEnergy | null>): BenchmarkEnergy | null {
  const available = values.filter((value): value is BenchmarkEnergy => value !== null);
  if (available.length === 0) return null;
  return {
    energyKwh: sumMetric(available, "energyKwh"),
    energyJoules: sumMetric(available, "energyJoules"),
    averagePowerWatts: null,
    durationSeconds: sumMetric(available, "durationSeconds"),
    measurementAvailable: available.every((value) => value.measurementAvailable === true),
  };
}

function addCost(values: Array<BenchmarkCost | null>): BenchmarkCost | null {
  const available = values.filter((value): value is BenchmarkCost => value !== null);
  if (available.length === 0) return null;
  return {
    requestCostUsd: sumMetric(available, "requestCostUsd"),
    cacheSavingsUsd: sumMetric(available, "cacheSavingsUsd"),
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await transform(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function runSyntheticBenchmark(options: BenchmarkRunOptions): Promise<BenchmarkRunResult> {
  const startedAt = Date.now();
  const fixedCases = options.cases?.map((benchmarkCase, index) => ({
    ...benchmarkCase,
    id: benchmarkCase.id.trim() || `case-${index + 1}`,
    input: benchmarkCase.input.trim(),
    gradingNotes: benchmarkCase.gradingNotes?.trim(),
    datasetIndex: benchmarkCase.datasetIndex ?? 0,
  })) ?? [];
  const datasetCount = fixedCases.length > 0 ? 1 : options.datasetCount ?? 1;
  const repetitions = options.repetitions ?? 1;
  const candidateConcurrency = options.candidateConcurrency ?? options.candidates.length;
  if (!options.task.trim()) throw new Error("Describe the task to benchmark.");
  if (!Number.isInteger(options.caseCount) || options.caseCount < 1 || options.caseCount > 25) {
    throw new Error("Synthetic case count must be between 1 and 25.");
  }
  if (fixedCases.some((benchmarkCase) => !benchmarkCase.input)) {
    throw new Error("Every fixed benchmark case must include a non-empty input.");
  }
  if (!Number.isInteger(datasetCount) || datasetCount < 1 || datasetCount > 10) {
    throw new Error("Synthetic dataset count must be between 1 and 10.");
  }
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("Runs per case must be between 1 and 10.");
  }
  if (!Number.isInteger(candidateConcurrency) || candidateConcurrency < 1 || candidateConcurrency > 20) {
    throw new Error("Candidate concurrency must be between 1 and 20.");
  }
  if (options.prompts.length === 0) throw new Error("Add at least one prompt.");
  if (options.candidates.length === 0) throw new Error("Add at least one model configuration.");
  if (!options.rubric.trim()) throw new Error("Describe how the grader should score responses.");
  const promptById = new Map(options.prompts.map((prompt) => [prompt.id, prompt]));
  options.candidates.forEach((candidate) => {
    if (!promptById.has(candidate.promptId)) throw new Error(`${candidate.name} must use an available prompt.`);
  });

  const cases: SyntheticBenchmarkCase[] = [...fixedCases];
  for (let datasetIndex = 0; fixedCases.length === 0 && datasetIndex < datasetCount; datasetIndex += 1) {
    const synthetic = await options.complete(options.generator, [
      {
        role: "system",
        content: "Create a diverse, adversarial but realistic evaluation set. Return only JSON as {\"cases\":[{\"id\":\"case-1\",\"input\":\"...\"}]}. Do not include answers or grading hints.",
      },
      {
        role: "user",
        content: `Task:\n${options.task.trim()}\n\nGenerate exactly ${options.caseCount} distinct cases for synthetic dataset ${datasetIndex + 1} of ${datasetCount}. Cover straightforward, ambiguous, boundary, and failure-prone inputs where relevant. Make this set internally diverse.`,
      },
    ], true);
    cases.push(...parseSyntheticCases(synthetic.content, options.caseCount).map((benchmarkCase) => ({
      ...benchmarkCase,
      id: `set-${datasetIndex + 1}-${benchmarkCase.id}`,
      datasetIndex,
    })));
  }
  const passScore = options.passScore ?? 70;

  const candidateResults = await mapWithConcurrency(
    options.candidates,
    candidateConcurrency,
    async (candidate) => {
    const prompt = promptById.get(candidate.promptId)!;
    const results: BenchmarkCaseResult[] = [];
    for (const benchmarkCase of cases) {
      for (let runIndex = 0; runIndex < repetitions; runIndex += 1) {
        let usage: ProviderUsage | null = null;
        const began = performance.now();
        const completion = await options.complete(candidate.provider, [
          { role: "system", content: prompt.text },
          { role: "user", content: benchmarkCase.input },
        ], false);
        usage = completion.usage;
        const durationMs = Math.max(0, performance.now() - began);
        const grade = options.grade
          ? await options.grade(benchmarkCase, completion, candidate)
          : parseGrade((await options.complete(options.grader, [
              {
                role: "system",
                content: "You are an impartial benchmark grader. Return only JSON as {\"score\":0-100,\"reason\":\"concise evidence-based explanation\"}. Judge only the supplied input and response. Do not infer which model produced it.",
              },
              {
                role: "user",
                content: `Task:\n${options.task.trim()}\n\nRubric:\n${options.rubric.trim()}${benchmarkCase.gradingNotes ? `\n\nCase-specific grading notes (hidden from the candidate):\n${benchmarkCase.gradingNotes}` : ""}\n\nInput:\n${benchmarkCase.input}\n\nResponse:\n${completion.content}`,
              },
            ], true)).content);
        results.push({
          caseId: benchmarkCase.id,
          runIndex,
          output: completion.content,
          durationMs,
          usage,
          energy: completion.energy ?? null,
          cost: completion.cost ?? null,
          grade,
        });
      }
    }
    const averageScore = results.reduce((sum, result) => sum + result.grade.score, 0) / results.length;
    return {
      candidate: {
        ...candidate,
        provider: {
          ...candidate.provider,
          apiKey: "",
          jsonResponseFormat: candidate.provider.jsonResponseFormat,
          config: { ...candidate.provider.config, customHeaders: {} },
        },
      },
      systemPromptChars: prompt.text.length,
      averageScore,
      passRate: results.filter((result) => result.grade.score >= passScore).length / results.length,
      averageDurationMs: results.reduce((sum, result) => sum + result.durationMs, 0) / results.length,
      totalUsage: addUsage(results.map((result) => result.usage)),
      totalEnergy: addEnergy(results.map((result) => result.energy)),
      totalCost: addCost(results.map((result) => result.cost)),
      cases: results,
      } satisfies BenchmarkCandidateResult;
    },
  );

  candidateResults.sort((left, right) => right.averageScore - left.averageScore);
  return {
    startedAt,
    finishedAt: Date.now(),
    datasetCount,
    repetitions,
    casesPerDataset: fixedCases.length || options.caseCount,
    cases,
    candidates: candidateResults,
  };
}
