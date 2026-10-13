import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderJob,
  readOrganizerState,
  recordGroupNameApprovals,
  writeConnectionTest,
  writeCustomOrganizerPrompt,
  writeOrganizerRules,
  writeGroupNamePreferences,
  writeProviderSettings,
  writeWorkflowSettings,
} from "../src/storage/organizer-state";
import type { OpenAICompatibleConfig } from "../src/shared/organizer-types";

afterEach(() => vi.unstubAllGlobals());

function installStorage(): {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
} {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (values: Record<string, unknown>) => ({
    async get(keys: string | string[]) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.flatMap((key) => (key in values ? [[key, values[key]]] : [])));
    },
    async set(items: Record<string, unknown>) {
      Object.assign(values, structuredClone(items));
    },
    async remove(keys: string | string[]) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete values[key]);
    },
  });
  vi.stubGlobal("chrome", { storage: { local: area(local), session: area(session) } });
  return { local, session };
}

function config(origin = "https://api.example.com"): OpenAICompatibleConfig {
  return {
    origin,
    endpointPath: "/v1/chat/completions",
    model: "model-a",
    customHeaders: { "x-secret": "header-value" },
    extraBody: {},
    manualStreamingEnabled: false,
  };
}

describe("organizer state storage boundaries", () => {
  it("keeps API keys and custom header values session-only by default", async () => {
    const stores = installStorage();
    await writeProviderSettings(config(), "api-secret", false);

    expect(JSON.stringify(stores.local)).not.toContain("api-secret");
    expect(JSON.stringify(stores.local)).not.toContain("header-value");
    expect(JSON.stringify(stores.session)).toContain("api-secret");
    expect(JSON.stringify(stores.session)).toContain("header-value");
    const state = await readOrganizerState();
    expect(state.session.apiKey).toBe("api-secret");
    expect(state.session.customHeaders).toEqual({ "x-secret": "header-value" });
  });

  it("persists a key only after explicit opt-in and invalidates tests on origin change", async () => {
    installStorage();
    await writeProviderSettings(config(), "persist-me", true);
    const tested = await writeConnectionTest({
      fingerprint: "f".repeat(64),
      testedAt: 1,
      providerOrigin: "https://api.example.com",
      capabilities: { structuredOutput: "prompt", streaming: false },
    });
    expect(tested.local.persistentApiKey).toBe("persist-me");
    expect(tested.local.connectionTest).not.toBeNull();

    const changed = await writeProviderSettings(
      config("https://other.example.com"),
      "persist-me",
      true,
    );
    expect(changed.local.connectionTest).toBeNull();
  });

  it("fails closed on a corrupt stored connection fingerprint", async () => {
    const stores = installStorage();
    stores.local.organizerLocalState = {
      provider: config(),
      privacy: { level: 2, includeExistingGroups: false, allowlist: [], denylist: [] },
      connectionTest: {
        fingerprint: "not-a-digest",
        testedAt: 1,
        providerOrigin: "https://api.example.com",
        capabilities: { structuredOutput: "prompt", streaming: false },
      },
    };
    await expect(readOrganizerState()).rejects.toThrow("Stored organizer settings are corrupt");
  });

  it("defaults skip-review and AI colors on, other automation off, and persists explicit choices", async () => {
    installStorage();
    const initial = await readOrganizerState();
    expect(initial.local.workflow).toEqual({
      organizeWithoutReview: true,
      aiGroupColors: true,
      organizeOnExtensionClick: false,
      pinUtilityPanelOpen: false,
      alwaysShowCleanupReview: false,
      inactiveSuggestionHours: 24,
      lowValueSuggestionHours: 6,
      includeInactivityDuration: true,
    });

    const updated = await writeWorkflowSettings({
      organizeWithoutReview: true,
      aiGroupColors: true,
      organizeOnExtensionClick: true,
      pinUtilityPanelOpen: true,
      alwaysShowCleanupReview: true,
      inactiveSuggestionHours: 48,
      lowValueSuggestionHours: 12,
      includeInactivityDuration: false,
    });
    expect(updated.local.workflow).toEqual({
      organizeWithoutReview: true,
      aiGroupColors: true,
      organizeOnExtensionClick: true,
      pinUtilityPanelOpen: true,
      alwaysShowCleanupReview: true,
      inactiveSuggestionHours: 48,
      lowValueSuggestionHours: 12,
      includeInactivityDuration: false,
    });
  });

  it("persists only normalized editable correction rules", async () => {
    installStorage();
    const updated = await writeOrganizerRules([
      { id: "rule-1", kind: "assign_location", locationPattern: " Example.com/Docs/* ", groupName: " Work " },
      { id: "rule-2", kind: "rename_group", fromName: "Physics", toName: "Physics class" },
    ]);
    expect(updated.local.organizerRules).toEqual([
      { id: "rule-1", kind: "assign_location", locationPattern: "example.com/docs/*", groupName: "Work" },
      { id: "rule-2", kind: "rename_group", fromName: "Physics", toName: "Physics class" },
    ]);
  });

  it("stores a custom organizer prompt locally and resets it explicitly", async () => {
    installStorage();
    const updated = await writeCustomOrganizerPrompt("  Prefer project-specific groups.\r\nLeave uncertain tabs untouched.  ");
    expect(updated.local.customOrganizerPrompt).toBe(
      "Prefer project-specific groups.\nLeave uncertain tabs untouched.",
    );

    const reset = await writeCustomOrganizerPrompt(null);
    expect(reset.local.customOrganizerPrompt).toBeNull();
    await expect(writeCustomOrganizerPrompt("   ")).rejects.toThrow("cannot be empty");
  });

  it("records approved group names across successful runs and allows edits", async () => {
    installStorage();
    await recordGroupNameApprovals(["Toy catalog", "Physics"], 100);
    const repeated = await recordGroupNameApprovals(["Toy catalog"], 200);
    expect(repeated.local.groupNamePreferences).toEqual([
      { name: "Toy catalog", approvalCount: 2, lastApprovedAt: 200 },
      { name: "Physics", approvalCount: 1, lastApprovedAt: 100 },
    ]);

    const edited = await writeGroupNamePreferences([
      { name: "Physics class", approvalCount: 1, lastApprovedAt: 100 },
    ]);
    expect(edited.local.groupNamePreferences).toEqual([
      { name: "Physics class", approvalCount: 1, lastApprovedAt: 100 },
    ]);
  });
  it("keeps a running background job when a page clears the provider job", async () => {
    const { session } = installStorage();
    const job = {
      status: "requesting",
      startedAt: 1,
      finishedAt: null,
      proposal: null,
      repairAttempted: false,
      error: null,
      ownerContextId: "background",
      cancellationReason: null,
      transactionId: null,
    };
    session.organizerProviderJob = job;
    await clearProviderJob();
    expect(session.organizerProviderJob).toEqual(job);

    session.organizerProviderJob = { ...job, status: "failed", finishedAt: 2, error: "Timed out." };
    await clearProviderJob();
    expect(session.organizerProviderJob).toBeUndefined();
  });
});
