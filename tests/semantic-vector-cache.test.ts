import { describe, expect, it, vi } from "vitest";
import { createQueryVectorCache, createSemanticVectorCache } from "../src/search/semantic-vector-cache";
import type { EmbeddingRecord } from "../src/shared/semantic-index-types";

function record(key: string, value = 1): EmbeddingRecord {
  return {
    key,
    modelKey: "model-a",
    dimensions: 2,
    vector: Float32Array.from([value, 0]),
    createdAt: 1,
    lastReferencedAt: 1,
  };
}

describe("semantic vector cache", () => {
  it("reads each vector once while the index identity holds", async () => {
    const source = new Map([["a", record("a")], ["b", record("b")]]);
    const load = vi.fn(async (keys: readonly string[]) =>
      new Map(keys.flatMap((key) => (source.has(key) ? [[key, source.get(key)!] as const] : []))));
    const cache = createSemanticVectorCache({ load });

    const first = await cache.read(["a", "b"], "model-a@1");
    expect([...first.keys()].sort()).toEqual(["a", "b"]);
    const second = await cache.read(["a", "b"], "model-a@1");
    expect([...second.keys()].sort()).toEqual(["a", "b"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toEqual({ hits: 2, misses: 2 });
    // A new key is the only thing that reaches the store again.
    await cache.read(["a", "b", "c"], "model-a@1");
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[0]).toEqual(["c"]);
  });

  it("drops everything when the index identity moves", async () => {
    const load = vi.fn(async (keys: readonly string[]) => new Map(keys.map((key) => [key, record(key)])));
    const cache = createSemanticVectorCache({ load });
    await cache.read(["a"], "model-a@1");
    expect(cache.size()).toBe(1);
    // A batch commit, rebuild, clear or configuration change moves the guard, and a
    // vector from the previous index must not be reused under the new one.
    await cache.read(["a"], "model-a@2");
    expect(load).toHaveBeenCalledTimes(2);
    await cache.read(["a"], "model-b@2");
    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls[2]?.[0]).toEqual(["a"]);
  });

  it("never invents a vector the store did not return", async () => {
    const load = async (keys: readonly string[]) =>
      new Map(keys.filter((key) => key !== "missing").map((key) => [key, record(key)]));
    const cache = createSemanticVectorCache({ load });
    const first = await cache.read(["a", "missing"], "m@1");
    expect([...first.keys()]).toEqual(["a"]);
    const second = await cache.read(["a", "missing"], "m@1");
    expect([...second.keys()]).toEqual(["a"]);
    // The absent key is retried rather than cached as absent forever: it may have
    // been quarantined and re-embedded in the meantime.
    expect(cache.size()).toBe(1);
  });

  it("invalidates on demand and reports what it holds", async () => {
    const load = async (keys: readonly string[]) => new Map(keys.map((key) => [key, record(key)]));
    const cache = createSemanticVectorCache({ load });
    await cache.read(["a", "b"], "m@1");
    cache.invalidate();
    expect(cache.size()).toBe(0);
    await cache.read(["a"], "m@1");
    expect(cache.size()).toBe(1);
  });
});

describe("query vector cache", () => {
  it("embeds a query once per configuration and evicts the least recently used", async () => {
    const cache = createQueryVectorCache(2);
    const embed = vi.fn(async () => Float32Array.from([1, 0]));
    await cache.embed("config-a", "alpha", embed);
    await cache.embed("config-a", "alpha", embed);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(cache.has("alpha")).toBe(true);

    await cache.embed("config-b", "alpha", embed);
    expect(embed).toHaveBeenCalledTimes(2);

    await cache.embed("config-b", "beta", embed);
    expect(cache.size()).toBe(2);
    expect(cache.has("alpha")).toBe(true);
    await cache.embed("config-b", "gamma", embed);
    // "alpha" under config-b was used before "beta", so it is the one evicted.
    expect(cache.has("alpha")).toBe(false);
    expect(cache.has("beta")).toBe(true);
  });

  it("caches nothing when the provider call fails", async () => {
    const cache = createQueryVectorCache();
    await expect(cache.embed("config", "alpha", async () => {
      throw new Error("rate_limited");
    })).rejects.toThrow("rate_limited");
    expect(cache.has("alpha")).toBe(false);
  });
});
