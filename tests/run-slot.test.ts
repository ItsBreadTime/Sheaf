import { describe, expect, it } from "vitest";
import { createRunSlot } from "../src/background/run-slot";

describe("background run slot", () => {
  it("lets only the first of two overlapping triggers start a run", async () => {
    const slot = createRunSlot<{ id: number }>();
    let started = 0;
    // The service worker's shape: check, claim synchronously, then await.
    const trigger = async (id: number): Promise<boolean> => {
      const claim = { id };
      if (!slot.claim(claim)) return false;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        started += 1;
        return true;
      } finally {
        slot.release(claim);
      }
    };
    expect(await Promise.all([trigger(1), trigger(2)])).toEqual([true, false]);
    expect(started).toBe(1);
    expect(slot.current()).toBeNull();
  });

  it("does not let a late finisher release a newer run's claim", () => {
    const slot = createRunSlot<{ id: number }>();
    const first = { id: 1 };
    const second = { id: 2 };
    expect(slot.claim(first)).toBe(true);
    slot.release(first);
    expect(slot.claim(second)).toBe(true);
    slot.release(first);
    expect(slot.current()).toBe(second);
  });
});
