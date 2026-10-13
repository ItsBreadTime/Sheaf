import { describe, expect, it } from "vitest";
import { forEachWithConcurrency } from "../src/shared/concurrency";

describe("forEachWithConcurrency", () => {
  it("visits every item once with at most `limit` in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, item % 4));
      seen.push(item);
      inFlight -= 1;
    });
    expect(peak).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it("does nothing for an empty list", async () => {
    let calls = 0;
    await forEachWithConcurrency([], 8, async () => { calls += 1; });
    expect(calls).toBe(0);
  });
});
