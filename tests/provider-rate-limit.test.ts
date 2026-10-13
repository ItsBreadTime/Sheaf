import { describe, expect, it, vi } from "vitest";
import { noteProviderRetryAfter, waitForProviderSlot } from "../src/search/provider-rate-limit";

function harness(notBefore = 0) {
  let stored = notBefore;
  let now = 10_000;
  const waits: number[] = [];
  const store = {
    read: async () => stored,
    write: async (value: number) => { stored = value; },
  };
  return {
    store,
    waits,
    advance: (ms: number) => { now += ms; },
    current: () => stored,
    options: {
      store,
      now: () => now,
      sleep: async (ms: number) => { waits.push(ms); now += ms; },
    },
  };
}

describe("provider rate limit coordination", () => {
  it("holds the background build for the provider's own delay", async () => {
    const { options, waits } = harness(16_000);
    const waited = await waitForProviderSlot({ ...options, priority: "background" });
    expect(waited).toBe(6_000);
    expect(waits).toEqual([6_000]);
  });

  it("does not hold back an interactive query, which is one request the user waits for", async () => {
    const { options, waits } = harness(16_000);
    expect(await waitForProviderSlot({ ...options, priority: "interactive" })).toBe(0);
    expect(waits).toEqual([]);
  });

  it("does not wait once the reservation has expired", async () => {
    const { options, waits } = harness(9_000);
    expect(await waitForProviderSlot({ ...options, priority: "background" })).toBe(0);
    expect(waits).toEqual([]);
  });

  it("keeps the longest outstanding reservation", async () => {
    const { options, current } = harness();
    await noteProviderRetryAfter(30_000, options);
    expect(current()).toBe(40_000);
    // A shorter delay from the other context must not shorten the pause the
    // provider already asked for.
    await noteProviderRetryAfter(5_000, options);
    expect(current()).toBe(40_000);
    await noteProviderRetryAfter(60_000, options);
    expect(current()).toBe(70_000);
  });

  it("keeps the longest reservation when two notes overlap", async () => {
    let stored = 0;
    const yieldThen = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 0));
    const store = {
      read: () => yieldThen(stored),
      write: async (value: number) => { await yieldThen(undefined); stored = value; },
    };
    const options = { now: () => 10_000, store };
    await Promise.all([noteProviderRetryAfter(60_000, options), noteProviderRetryAfter(5_000, options)]);
    expect(stored).toBe(70_000);
  });

  it("ignores a reservation that carries no usable delay", async () => {
    const { options, current } = harness();
    await noteProviderRetryAfter(0, options);
    await noteProviderRetryAfter(Number.NaN, options);
    expect(current()).toBe(0);
    vi.restoreAllMocks();
  });
});
