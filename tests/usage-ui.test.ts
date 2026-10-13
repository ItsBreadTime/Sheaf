// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyUsageStats, recordUsageInState, USAGE_STATS_KEY } from "../src/storage/usage-stats";
import type { UsageStatsState } from "../src/shared/usage-types";

// The panel module keeps its state in module scope, so each test imports a
// fresh copy (and with it a fresh popup store).
let popupState: typeof import("../src/ui/action/popup-store").popupState;

async function loadPanel() {
  vi.resetModules();
  ({ popupState } = await import("../src/ui/action/popup-store"));
  return await import("../src/ui/action/usage-ui");
}

let local: Record<string, unknown>;
let notices: Array<{ tone: string; text: string } | null>;

function stored(state: UsageStatsState): void {
  local[USAGE_STATS_KEY] = structuredClone(state);
}

function withRequests(at: number): UsageStatsState {
  let state = emptyUsageStats(at - 40 * 86_400_000);
  // One organize request 35 days ago (outside "30 days"), one today.
  state = recordUsageInState(state, {
    kind: "llm", task: "organize", at: at - 35 * 86_400_000, ok: true, startsRun: true,
    usage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200, cachedTokens: null }, costUsd: 0.5,
  });
  state = recordUsageInState(state, {
    kind: "llm", task: "organize", at, ok: true, startsRun: true,
    usage: { promptTokens: 2_000, completionTokens: 400, totalTokens: 2_400, cachedTokens: null }, costUsd: 0.25,
  });
  return state;
}

async function mount() {
  const panel = await loadPanel();
  panel.setUsagePanelContext({
    input(value, type = "text") {
      const input = document.createElement("input");
      input.type = type;
      input.value = value;
      return input;
    },
    field(label, control) {
      const wrapper = document.createElement("label");
      wrapper.append(label, control);
      return wrapper;
    },
    button(label, _variant, onClick) {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", onClick);
      return button;
    },
    // Like the popup's perform(): a thrown error becomes an error notice.
    async perform(_name, action) {
      try {
        await action();
      } catch (error) {
        popupState.notice = { tone: "error", text: (error as Error).message };
      }
      notices.push(popupState.notice);
    },
  });
  await panel.loadUsageStats();
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  panel.renderUsageSettings(root);
  return { panel, root };
}

function overviewValue(root: HTMLElement, label: string): string | undefined {
  const facts = [...root.querySelectorAll(".usage-stats__live .usage-overview > div")];
  return facts.find((fact) => fact.querySelector("dt")?.textContent === label)?.querySelector("dd")?.textContent ?? undefined;
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!match) throw new Error(`No "${label}" button.`);
  return match;
}

beforeEach(() => {
  local = {};
  notices = [];
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

describe("Settings → Usage panel", () => {
  it("shows all-time totals and narrows them when a period is picked", async () => {
    stored(withRequests(Date.now()));
    const { root } = await mount();
    expect(overviewValue(root, "Requests")).toBe("2");
    expect(overviewValue(root, "Cost")).toBe("$0.750");

    const month = button(root, "30 days");
    month.click();
    expect(overviewValue(root, "Requests")).toBe("1");
    expect(overviewValue(root, "Cost")).toBe("$0.250");
    expect(month.getAttribute("aria-pressed")).toBe("true");
    expect(button(root, "All time").getAttribute("aria-pressed")).toBe("false");
  });

  it("redraws the numbers on a storage change without rebuilding the price fields", async () => {
    stored(emptyUsageStats());
    const { panel, root } = await mount();
    expect(overviewValue(root, "Requests")).toBe("0");
    const priceInput = root.querySelector<HTMLInputElement>(".usage-pricing input");
    expect(priceInput).not.toBeNull();
    priceInput!.value = "3.5";

    stored(withRequests(Date.now()));
    panel.handleUsageStorageChange({ [USAGE_STATS_KEY]: { newValue: local[USAGE_STATS_KEY] } }, "local");
    await vi.waitFor(() => expect(overviewValue(root, "Requests")).toBe("2"));
    expect(root.querySelector(".usage-pricing input")).toBe(priceInput);
    expect(priceInput!.value).toBe("3.5");
  });

  it("ignores storage changes for other keys and areas", async () => {
    stored(emptyUsageStats());
    const { panel, root } = await mount();
    stored(withRequests(Date.now()));
    panel.handleUsageStorageChange({ other: { newValue: 1 } }, "local");
    panel.handleUsageStorageChange({ [USAGE_STATS_KEY]: { newValue: 1 } }, "session");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overviewValue(root, "Requests")).toBe("0");
  });

  it("saves typed prices and rejects a negative one", async () => {
    stored(emptyUsageStats());
    const { root } = await mount();
    const [llmInput] = root.querySelectorAll<HTMLInputElement>(".usage-pricing input");
    llmInput!.value = "2";
    button(root, "Save prices").click();
    await vi.waitFor(() => expect(notices).toContainEqual({ tone: "success", text: "Usage prices saved." }));
    expect((local[USAGE_STATS_KEY] as UsageStatsState).pricing.llm.inputPerMillionUsd).toBe(2);

    llmInput!.value = "-1";
    button(root, "Save prices").click();
    await vi.waitFor(() => expect(notices).toContainEqual({
      tone: "error",
      text: "Token prices must be zero or positive numbers.",
    }));
    expect((local[USAGE_STATS_KEY] as UsageStatsState).pricing.llm.inputPerMillionUsd).toBe(2);
  });

  it("shows a loading line and no price form before stats are loaded", async () => {
    const panel = await loadPanel();
    const root = document.createElement("div");
    panel.renderUsageSettings(root);
    expect(root.textContent).toContain("Usage is loading.");
    expect(root.querySelector(".usage-pricing")).toBeNull();
    expect(panel.usageNavCopy()).toBe("Requests, tokens, and cost");
  });
});
