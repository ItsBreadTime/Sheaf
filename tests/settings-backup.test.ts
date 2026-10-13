import { describe, expect, it } from "vitest";
import { createSettingsBackup, parseSettingsBackup } from "../src/storage/settings-backup";
import { DEFAULT_PRIVACY_SETTINGS, DEFAULT_PROVIDER_CONFIG, DEFAULT_WORKFLOW_SETTINGS } from "../src/storage/organizer-state";
import { DEFAULT_EMBEDDING_CONFIG, DEFAULT_SEARCH_SETTINGS } from "../src/storage/search";

function local() {
  return {
    provider: { ...DEFAULT_PROVIDER_CONFIG, model: "model-a", customHeaders: { authorization: "secret" }, extraBody: { api_key: "also-secret" }, reasoning: { token: "reasoning-secret" }, openRouter: { zdr: true, allowFallbacks: false, dataCollection: "deny" as const } },
    privacy: { ...DEFAULT_PRIVACY_SETTINGS, denylist: ["private.example"] },
    workflow: { ...DEFAULT_WORKFLOW_SETTINGS, organizeWithoutReview: true, aiGroupColors: true },
    customOrganizerPrompt: "Prefer project groups.",
    organizerRules: [{ id: "r1", kind: "keep_location" as const, locationPattern: "example.com/*" }],
    groupNamePreferences: [{ name: "Project", approvalCount: 2, lastApprovedAt: 1 }],
    connectionTest: null,
    persistentApiKey: "secret",
  };
}

function searchLocal() {
  return {
    settings: { ...DEFAULT_SEARCH_SETTINGS, semanticEnabled: true, semanticConsentAt: 5 },
    embeddingConfig: { ...DEFAULT_EMBEDDING_CONFIG, origin: "https://embed.example", model: "embed-v1", customHeaders: { authorization: "secret" }, extraBody: { private: "secret" }, openRouter: { order: ["openai", "azure"], allowFallbacks: false, dataCollection: "deny" as const } },
    persistentApiKey: "secret",
    providerTest: null,
  };
}

describe("settings backup", () => {
  it("exports useful configuration without provider secrets or sensitive collections by default", () => {
    const backup = createSettingsBackup({ local: local(), diagnosticPricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 }, now: 10, searchLocal: searchLocal() });
    const json = JSON.stringify(backup);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("api_key");
    expect(backup).not.toHaveProperty("apiKey");
    expect(backup).not.toHaveProperty("persistentApiKey");
    expect(backup).not.toHaveProperty("regressionCases");
    expect(backup).not.toHaveProperty("workspaces");
    expect(backup.provider.model).toBe("model-a");
    expect(backup.provider.openRouter).toEqual({ zdr: true, allowFallbacks: false, dataCollection: "deny" });
    expect(backup.workflow.aiGroupColors).toBe(true);
    expect(backup.search?.embeddingProvider?.model).toBe("embed-v1");
    expect(backup.search?.embeddingProvider?.openRouter).toEqual({ order: ["openai", "azure"], allowFallbacks: false, dataCollection: "deny" });
    expect(JSON.stringify(backup.search)).not.toContain("secret");
  });

  it("normalizes imports and disables automation and skip-review pending fresh consent", () => {
    const backup = createSettingsBackup({ local: local(), diagnosticPricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 }, searchLocal: searchLocal() });
    const plan = parseSettingsBackup(JSON.stringify(backup));
    expect(plan.workflow).toMatchObject({ organizeWithoutReview: false, organizeOnExtensionClick: false });
    expect(plan.workflow.aiGroupColors).toBe(true);
    expect(plan.search?.settings.semanticEnabled).toBe(false);
    expect(plan.provider.openRouter).toEqual({ zdr: true, allowFallbacks: false, dataCollection: "deny" });
    expect(plan.search?.embeddingProvider?.openRouter).toEqual({ order: ["openai", "azure"], allowFallbacks: false, dataCollection: "deny" });
    expect(plan.privacy.denylist).toEqual(["private.example"]);
    expect(plan.customOrganizerPrompt).toBe("Prefer project groups.");
  });

  it("round-trips direct-search settings without requiring an embedding model", () => {
    const directOnly = { ...searchLocal(), embeddingConfig: { ...DEFAULT_EMBEDDING_CONFIG } };
    const backup = createSettingsBackup({
      local: local(),
      diagnosticPricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      searchLocal: directOnly,
    });
    expect(backup.search?.embeddingProvider).toBeUndefined();
    const plan = parseSettingsBackup(JSON.stringify(backup));
    expect(plan.search?.settings.includeGroupNames).toBe(true);
    expect(plan.search?.embeddingProvider).toBeUndefined();
  });

  it("imports workspaces under the current field or the stash-era field", () => {
    const workspace = {
      id: "w1", name: "Reading", createdAt: 1, updatedAt: 1, lastOpenedAt: null, note: "", revisions: [],
      activeWorkspaceId: null, status: "saved", scope: { mode: "window" },
      tabs: [{ sourceTabId: 1, sourceIndex: 0, title: "A", url: "https://a.test/", groupKey: null }],
      groups: [], excludedTabs: [], closeConflicts: [], restoreResult: null,
    };
    const backup = createSettingsBackup({ local: local(), diagnosticPricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 } });
    expect(parseSettingsBackup(JSON.stringify({ ...backup, workspaces: [workspace] })).workspaces?.map((item) => item.id)).toEqual(["w1"]);
    expect(parseSettingsBackup(JSON.stringify({ ...backup, tabStashes: [workspace] })).workspaces?.map((item) => item.id)).toEqual(["w1"]);
  });

  it("ignores regression cases in older backups", () => {
    const backup = createSettingsBackup({ local: local(), diagnosticPricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }, now: 10 });
    const plan = parseSettingsBackup(JSON.stringify({ ...backup, regressionCases: [{ id: "case-1", name: "Old case" }] }));
    expect(plan).not.toHaveProperty("regressionCases");
    expect(plan.provider.model).toBe("model-a");
  });

  it("rejects invalid JSON and unsupported versions", () => {
    expect(() => parseSettingsBackup("nope")).toThrow("not valid JSON");
    expect(() => parseSettingsBackup('{"schemaVersion":2}')).toThrow("Unsupported");
  });
});

describe("settings backup reasoning effort", () => {
  const backupOf = (value: ReturnType<typeof local>) =>
    createSettingsBackup({ local: value, diagnosticPricing: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 } });

  it("defaults to none and keeps an explicit provider default across a round trip", () => {
    const withDefault = parseSettingsBackup(JSON.stringify(backupOf(local())));
    expect(withDefault.provider.reasoningEffort).toBe("none");

    const providerDefault = local();
    providerDefault.provider = { ...providerDefault.provider, reasoningEffort: undefined };
    const text = JSON.stringify(backupOf(providerDefault));
    expect(parseSettingsBackup(text).provider.reasoningEffort).toBeNull();

    const legacy = JSON.parse(text) as { provider: Record<string, unknown> };
    delete legacy.provider.reasoningEffort;
    expect(parseSettingsBackup(JSON.stringify(legacy)).provider.reasoningEffort).toBe("none");
  });
});
