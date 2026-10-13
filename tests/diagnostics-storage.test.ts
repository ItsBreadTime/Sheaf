import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticEvent } from "../src/shared/diagnostics-types";
import {
  appendDiagnosticEvent,
  clearDiagnosticEvents,
  MAX_DIAGNOSTIC_EVENTS,
  readDiagnosticsState,
  writeDiagnosticPricing,
} from "../src/storage/diagnostics";

function event(index: number): DiagnosticEvent {
  return {
    schemaVersion: 1,
    id: `event-${index}`,
    timestamp: index,
    kind: "provider_validated",
    source: "manual",
    detail: null,
    providerOrigin: "https://api.example.com",
    model: "model-a",
    durationMs: 500,
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 10 },
    estimatedCostUsd: 0.001,
    transactionId: null,
    conflictCount: null,
  };
}

beforeEach(() => {
  const local: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(key: string) {
          return key in local ? { [key]: structuredClone(local[key]) } : {};
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, structuredClone(values));
        },
      },
    },
  });
});

describe("bounded local diagnostics", () => {
  it("stores pricing separately from a bounded event log", async () => {
    await writeDiagnosticPricing({ inputPerMillionUsd: 2, outputPerMillionUsd: 8 });
    for (let index = 0; index < MAX_DIAGNOSTIC_EVENTS + 3; index += 1) {
      await appendDiagnosticEvent(event(index));
    }
    const state = await readDiagnosticsState();
    expect(state.pricing).toEqual({ inputPerMillionUsd: 2, outputPerMillionUsd: 8 });
    expect(state.events).toHaveLength(MAX_DIAGNOSTIC_EVENTS);
    expect(state.events[0]?.id).toBe("event-3");
  });

  it("clears events without losing cost settings", async () => {
    await writeDiagnosticPricing({ inputPerMillionUsd: 1, outputPerMillionUsd: 4 });
    await appendDiagnosticEvent(event(1));
    await clearDiagnosticEvents();
    expect(await readDiagnosticsState()).toEqual({
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 4 },
      events: [],
    });
  });

  it("keeps every event and the pricing when writes overlap", async () => {
    await Promise.all([
      appendDiagnosticEvent(event(1)),
      appendDiagnosticEvent(event(2)),
      writeDiagnosticPricing({ inputPerMillionUsd: 3, outputPerMillionUsd: 6 }),
      appendDiagnosticEvent(event(3)),
    ]);
    const state = await readDiagnosticsState();
    expect(state.events.map((item) => item.id)).toEqual(["event-1", "event-2", "event-3"]);
    expect(state.pricing).toEqual({ inputPerMillionUsd: 3, outputPerMillionUsd: 6 });
  });
});
