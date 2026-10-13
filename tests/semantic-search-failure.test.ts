import { describe, expect, it, vi } from "vitest";
import { SemanticSearchFailureGate } from "../src/search/semantic-search-failure";

function harness() {
  const redraw = vi.fn();
  let now = 1_000;
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const gate = new SemanticSearchFailureGate(redraw, {
    now: () => now,
    setTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      timers[Number(timer) - 1] = { callback: () => undefined, delayMs: 0 };
    },
    baseCooldownMs: 1_000,
    maxCooldownMs: 8_000,
  });
  return {
    gate,
    redraw,
    timers,
    advance: (ms: number) => { now += ms; },
    fire: () => timers.filter((timer) => timer.delayMs > 0).forEach((timer) => timer.callback()),
  };
}

describe("semantic search failure gate", () => {
  it("scopes a transient cooldown to the query that failed", () => {
    const { gate } = harness();
    expect(gate.blocks("dashboard")).toBe(false);
    gate.note("dashboard", "rate_limited");
    expect(gate.blocks("dashboard")).toBe(true);
    // A previous query's rate limit says nothing about another query.
    expect(gate.blocks("invoice")).toBe(false);
    expect(gate.blocks("")).toBe(false);
  });

  it("backs off further while the same query keeps failing, and caps", () => {
    const { gate, timers } = harness();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      gate.note("dashboard", "timeout");
      delays.push(timers.filter((timer) => timer.delayMs > 0).at(-1)!.delayMs);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it("does not escalate the cooldown for an unrelated query", () => {
    const { gate, timers } = harness();
    gate.note("dashboard", "timeout");
    gate.note("dashboard", "timeout");
    expect(timers.filter((timer) => timer.delayMs > 0).at(-1)!.delayMs).toBe(2_000);
    // Failing query A must not lengthen the delay for unrelated query B.
    gate.note("invoice", "timeout");
    expect(timers.filter((timer) => timer.delayMs > 0).at(-1)!.delayMs).toBe(1_000);
  });

  it("re-enables the query when the cooldown expires and lets the next attempt probe", () => {
    const { gate, redraw, advance, fire } = harness();
    gate.note("dashboard", "network");
    expect(gate.blocks("dashboard")).toBe(true);
    advance(1_000);
    fire();
    expect(gate.blocks("dashboard")).toBe(false);
    expect(redraw).toHaveBeenCalledTimes(1);
    // A success clears the streak, so a later failure starts from the base delay.
    gate.clear();
    expect(gate.errorCode()).toBeNull();
    expect(gate.requiresSettingsChange()).toBe(false);
  });

  it("keeps a permanent failure blocking until settings change, with no timer", () => {
    const { gate, timers } = harness();
    gate.note("dashboard", "authentication");
    expect(gate.requiresSettingsChange()).toBe(true);
    expect(gate.errorCode()).toBe("authentication");
    // Every query is blocked: retrying a different one cannot fix credentials.
    expect(gate.blocks("dashboard")).toBe(true);
    expect(gate.blocks("anything else")).toBe(true);
    expect(timers.filter((timer) => timer.delayMs > 0)).toHaveLength(0);
    gate.clear();
    expect(gate.blocks("anything else")).toBe(false);
  });

  it("treats a rebuild-required verdict as permanent rather than retryable", () => {
    const { gate, timers } = harness();
    // Dimension drift cannot be waited out: the index, not the request, is what
    // has to change.
    gate.note("dashboard", "configuration_changed");
    expect(gate.requiresSettingsChange()).toBe(true);
    expect(gate.blocks("unrelated query")).toBe(true);
    expect(timers.filter((timer) => timer.delayMs > 0)).toHaveLength(0);
  });

  it("restarts the backoff after an intervening success", () => {
    const { gate, timers } = harness();
    gate.note("dashboard", "rate_limited");
    gate.note("dashboard", "rate_limited");
    expect(timers.filter((timer) => timer.delayMs > 0).at(-1)!.delayMs).toBe(2_000);
    gate.clear();
    gate.note("dashboard", "rate_limited");
    expect(timers.filter((timer) => timer.delayMs > 0).at(-1)!.delayMs).toBe(1_000);
  });
});
