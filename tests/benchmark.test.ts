import { describe, expect, it } from "vitest";
import {
  parseGrade,
  parseSyntheticCases,
  runSyntheticBenchmark,
  type BenchmarkProvider,
} from "../src/benchmark/benchmark";

const usage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  cachedTokens: 0,
};

function provider(name: string): BenchmarkProvider {
  return {
    name,
    apiKey: "",
    config: {
      origin: "https://api.example.com",
      endpointPath: "/v1/chat/completions",
      model: name,
      customHeaders: {},
      extraBody: {},
      manualStreamingEnabled: false,
    },
  };
}

describe("synthetic AI benchmark", () => {
  it("accepts fenced synthetic data and clamps grader scores", () => {
    expect(parseSyntheticCases('```json\n{"cases":[{"id":"a","input":"Alpha"}]}\n```', 1))
      .toEqual([{ id: "a", input: "Alpha" }]);
    expect(parseGrade('{"score": 120, "reason": "Strong."}'))
      .toEqual({ score: 100, reason: "Strong." });
  });

  it("runs any number of candidates and ranks them by independent grades", async () => {
    const calls: string[] = [];
    const result = await runSyntheticBenchmark({
      task: "Answer the input",
      caseCount: 2,
      datasetCount: 2,
      repetitions: 2,
      candidateConcurrency: 2,
      rubric: "Prefer correct concise answers",
      prompts: [
        { id: "short", name: "Short", text: "Be concise" },
        { id: "long", name: "Long", text: "Be detailed" },
      ],
      candidates: [
        { id: "a", name: "A", promptId: "short", provider: provider("weak") },
        { id: "b", name: "B", promptId: "long", provider: provider("strong") },
        { id: "c", name: "C", promptId: "short", provider: provider("middle") },
      ],
      generator: provider("generator"),
      grader: provider("grader"),
      complete: async (target, messages, json) => {
        calls.push(target.name);
        if (target.name === "generator") {
          return { content: '{"cases":[{"id":"one","input":"1"},{"id":"two","input":"2"}]}', usage };
        }
        if (target.name === "grader") {
          const response = messages[1]?.content ?? "";
          const score = response.includes("strong-output") ? 95 : response.includes("middle-output") ? 75 : 40;
          return { content: JSON.stringify({ score, reason: "Measured against rubric." }), usage };
        }
        return { content: `${target.name}-output`, usage: json ? null : usage };
      },
    });

    expect(result.cases).toHaveLength(4);
    expect(result).toMatchObject({ datasetCount: 2, casesPerDataset: 2, repetitions: 2 });
    expect(result.candidates.map((candidate) => candidate.candidate.name)).toEqual(["B", "C", "A"]);
    expect(result.candidates[0]).toMatchObject({ averageScore: 95, passRate: 1 });
    expect(result.candidates[2]).toMatchObject({ averageScore: 40, passRate: 0 });
    expect(result.candidates[0]?.totalUsage?.totalTokens).toBe(120);
    expect(result.candidates[0]?.systemPromptChars).toBe("Be detailed".length);
    expect(result.candidates.every((candidate) => candidate.candidate.provider.apiKey === "")).toBe(true);
    expect(calls.filter((name) => name === "generator")).toHaveLength(2);
    expect(calls.filter((name) => name === "grader")).toHaveLength(24);
  });

  it("uses fixed hidden-answer cases and aggregates provider energy and cost", async () => {
    const calls: string[] = [];
    const result = await runSyntheticBenchmark({
      task: "Answer the input",
      caseCount: 1,
      repetitions: 2,
      rubric: "Prefer the expected answer",
      cases: [{
        id: "fixed",
        input: "Question",
        gradingNotes: "The expected answer is 42.",
      }],
      prompts: [{ id: "short", name: "Short", text: "Answer." }],
      candidates: [{ id: "a", name: "A", promptId: "short", provider: provider("candidate") }],
      generator: provider("generator"),
      grader: provider("grader"),
      complete: async (target, messages) => {
        calls.push(target.name);
        if (target.name === "grader") {
          expect(messages[1]?.content).toContain("The expected answer is 42.");
          return { content: '{"score":100,"reason":"Correct."}', usage };
        }
        return {
          content: "42",
          usage,
          energy: {
            energyKwh: 0.000001,
            energyJoules: 3.6,
            averagePowerWatts: 10,
            durationSeconds: 0.36,
            measurementAvailable: true,
          },
          cost: { requestCostUsd: 0.0002, cacheSavingsUsd: 0.00001 },
        };
      },
    });

    expect(calls).toEqual(["candidate", "grader", "candidate", "grader"]);
    expect(result.candidates[0]?.totalEnergy?.energyJoules).toBeCloseTo(7.2);
    expect(result.candidates[0]?.totalCost?.requestCostUsd).toBeCloseTo(0.0004);
    expect(result.candidates[0]?.cases[0]?.energy?.measurementAvailable).toBe(true);
  });
});
