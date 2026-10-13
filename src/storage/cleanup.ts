const IGNORED_CLEANUP_TABS_KEY = "ignoredCleanupTabIds";

export async function readIgnoredCleanupTabIds(): Promise<number[]> {
  const values = await chrome.storage.session.get(IGNORED_CLEANUP_TABS_KEY);
  const stored = values[IGNORED_CLEANUP_TABS_KEY];
  if (stored === undefined) return [];
  if (!Array.isArray(stored) || !stored.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    await chrome.storage.session.remove(IGNORED_CLEANUP_TABS_KEY);
    return [];
  }
  return [...new Set(stored)];
}

export async function writeIgnoredCleanupTabIds(tabIds: readonly number[]): Promise<number[]> {
  const normalized = [...new Set(tabIds.filter((value) => Number.isSafeInteger(value) && value >= 0))];
  await chrome.storage.session.set({ [IGNORED_CLEANUP_TABS_KEY]: normalized });
  return normalized;
}
