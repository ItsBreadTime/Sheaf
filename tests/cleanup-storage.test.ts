import { afterEach, describe, expect, it, vi } from "vitest";
import { readIgnoredCleanupTabIds, writeIgnoredCleanupTabIds } from "../src/storage/cleanup";

afterEach(() => vi.unstubAllGlobals());

function installSessionStorage(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        async get(key: string) {
          return key in values ? { [key]: structuredClone(values[key]) } : {};
        },
        async set(items: Record<string, unknown>) {
          Object.assign(values, structuredClone(items));
        },
        async remove(key: string) {
          delete values[key];
        },
      },
    },
  });
  return values;
}

describe("ignored cleanup suggestions", () => {
  it("keeps ignored tab identities for the browser session and removes duplicates", async () => {
    installSessionStorage();
    expect(await writeIgnoredCleanupTabIds([7, 8, 7])).toEqual([7, 8]);
    expect(await readIgnoredCleanupTabIds()).toEqual([7, 8]);
  });

  it("clears corrupt ancillary session data without blocking startup", async () => {
    const values = installSessionStorage();
    values.ignoredCleanupTabIds = [7, "bad"];
    expect(await readIgnoredCleanupTabIds()).toEqual([]);
    expect(values.ignoredCleanupTabIds).toBeUndefined();
  });

  it("does not persist a partial ignore set when session storage rejects", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          async get() { return {}; },
          async set() { throw new Error("storage unavailable"); },
        },
      },
    });
    await expect(writeIgnoredCleanupTabIds([7])).rejects.toThrow("storage unavailable");
    expect(await readIgnoredCleanupTabIds()).toEqual([]);
  });
});
