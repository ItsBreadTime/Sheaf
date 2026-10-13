import { describe, expect, it, vi } from "vitest";
import {
  applyRerankOrder,
  buildRerankMessages,
  parseRerankOrder,
  rerankSemanticResults,
  shouldRerankSemanticResults,
} from "../src/search/semantic-rerank";
import type { SemanticQueryResult } from "../src/search/semantic-query";

function result(mappingKey: string, score: number): SemanticQueryResult {
  return { mappingKey, score, target: { kind: "open", tabId: 1, windowId: 1 } };
}

const candidates = [
  { id: "window:1:tab:1", document: "Title: one\nHost: a.example" },
  { id: "window:1:tab:2", document: "Title: two\nHost: b.example" },
  { id: "window:1:tab:3", document: "Title: three\nHost: c.example" },
];

describe("rerank gate", () => {
  it("fires only on a near-tie that is the only signal available", () => {
    // A sub-0.02 margin is a near-tie that decides the whole ranking.
    expect(shouldRerankSemanticResults({ margin: 0.002, directResultsWeak: true })).toBe(true);
    expect(shouldRerankSemanticResults({ margin: 0.02, directResultsWeak: true })).toBe(true);
    // A decisive margin is the vector ranking being confident, not tied.
    expect(shouldRerankSemanticResults({ margin: 0.058, directResultsWeak: true })).toBe(false);
    // Strong lexical results already answer the query; the shortlist adds nothing.
    expect(shouldRerankSemanticResults({ margin: 0.001, directResultsWeak: false })).toBe(false);
    // One result is not a ranking problem.
    expect(shouldRerankSemanticResults({ margin: null, directResultsWeak: true })).toBe(false);
  });
});

describe("rerank ordering", () => {
  it("asks for identifiers only", () => {
    const messages = buildRerankMessages("the thing about bills", candidates);
    expect(messages[0]?.content).toContain("JSON");
    expect(messages[1]?.content).toContain("the thing about bills");
    for (const candidate of candidates) {
      expect(messages[1]?.content).toContain(candidate.id);
      expect(messages[1]?.content).toContain(candidate.document.split("\n")[1]!);
    }
  });

  it("redacts identifiers in the query before prompting", () => {
    const messages = buildRerankMessages(
      "invoice acme-corp-9f8a7b6c5d4e3f2a1b0c and boss@acme.example",
      candidates,
    );
    expect(messages[1]?.content).toContain("invoice :token and :email");
    expect(messages[1]?.content).not.toContain("boss@acme.example");
  });

  it("reads a JSON order, and keeps everything the model dropped", () => {
    const ids = candidates.map((candidate) => candidate.id);
    expect(parseRerankOrder('{"order":["window:1:tab:3","window:1:tab:1","window:1:tab:2"]}', ids))
      .toEqual(["window:1:tab:3", "window:1:tab:1", "window:1:tab:2"]);
    // Omissions fall back to their original relative order rather than vanishing.
    expect(parseRerankOrder('{"order":["window:1:tab:3"]}', ids))
      .toEqual(["window:1:tab:3", "window:1:tab:1", "window:1:tab:2"]);
    // Duplicates and unknown identifiers are dropped, not trusted.
    expect(parseRerankOrder('{"order":["window:1:tab:2","window:1:tab:2","window:9:tab:9"]}', ids))
      .toEqual(["window:1:tab:2", "window:1:tab:1", "window:1:tab:3"]);
  });

  it("survives a model that answers with prose instead of JSON", () => {
    const ids = candidates.map((candidate) => candidate.id);
    expect(parseRerankOrder("Sure! window:1:tab:2 then window:1:tab:1, then window:1:tab:3.", ids))
      .toEqual(["window:1:tab:2", "window:1:tab:1", "window:1:tab:3"]);
    // Nothing usable: the original order stands.
    expect(parseRerankOrder("I cannot help with that.", ids)).toEqual(ids);
  });

  it("applies an order without losing results", () => {
    const results = [result("a", 0.9), result("b", 0.89), result("c", 0.1)];
    expect(applyRerankOrder(results, ["c", "b", "a"]).map((entry) => entry.mappingKey)).toEqual(["c", "b", "a"]);
    // A result outside the shortlist is retained at the end.
    expect(applyRerankOrder(results, ["b", "a"]).map((entry) => entry.mappingKey)).toEqual(["b", "a", "c"]);
  });
});

describe("rerank execution", () => {
  const base = {
    query: "remembered thing",
    results: [result("window:1:tab:1", 0.9), result("window:1:tab:2", 0.899)],
    candidates,
    config: { origin: "https://chat.example", endpointPath: "/v1/chat/completions", model: "chat-model" } as never,
    apiKey: "key",
  };

  it("reorders when the model can justify a different order", async () => {
    const request = vi.fn(async () => '{"order":["window:1:tab:2","window:1:tab:1"]}');
    const outcome = await rerankSemanticResults({ ...base, dependencies: { request } });
    expect(outcome.results.map((entry) => entry.mappingKey)).toEqual(["window:1:tab:2", "window:1:tab:1"]);
    expect(outcome.reranked).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("declines cleanly when the model keeps the order", async () => {
    const request = vi.fn(async () => '{"order":["window:1:tab:1","window:1:tab:2"]}');
    const outcome = await rerankSemanticResults({ ...base, dependencies: { request } });
    expect(outcome.reranked).toBe(false);
    expect(outcome.results.map((entry) => entry.mappingKey)).toEqual(["window:1:tab:1", "window:1:tab:2"]);
  });

  it("returns the original results when the reranker fails", async () => {
    const request = vi.fn(async () => { throw new Error("provider timed out"); });
    const outcome = await rerankSemanticResults({ ...base, dependencies: { request } });
    // An optional second opinion must never cost the user the search they had.
    expect(outcome.results.map((entry) => entry.mappingKey)).toEqual(["window:1:tab:1", "window:1:tab:2"]);
    expect(outcome.reranked).toBe(false);
    expect(outcome.reason).toBe("provider timed out");
  });

  it("does not call the provider for a shortlist that cannot be reordered", async () => {
    const request = vi.fn(async () => '{"order":[]}');
    const outcome = await rerankSemanticResults({
      ...base,
      results: [result("window:1:tab:1", 0.9)],
      dependencies: { request },
    });
    expect(request).not.toHaveBeenCalled();
    expect(outcome.reason).toBe("too_few_candidates");
  });

  it("hands the provider the budget it was given, not the default one", async () => {
    // The measurement depends on this: a probe that cannot raise the budget measures
    // the deadline rather than the model, which is exactly what happened first.
    let seen = 0;
    const request = vi.fn(async (request: unknown) => {
      seen = (request as { deadlineAt: number }).deadlineAt;
      return '{"order":[]}';
    });
    const now = 1_000_000;
    await rerankSemanticResults({
      ...base,
      deadlineMs: 30_000,
      dependencies: { request: request as never, now: () => now },
    });
    expect(seen - now).toBe(30_000);
  });

  it("sends only sanitized indexed text, never a raw tab", async () => {
    const request = vi.fn(async (_request: unknown) => '{"order":[]}');
    await rerankSemanticResults({ ...base, dependencies: { request: request as never } });
    const call = request.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
    expect(call.messages[1]?.content).toContain("Title: one");
    // The listing is exactly the document text the embedder received, so a rerank
    // request cannot carry anything indexing did not.
    expect(call.messages[1]?.content).not.toContain("https://");
  });
});
