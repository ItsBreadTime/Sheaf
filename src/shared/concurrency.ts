/**
 * Runs `task` over `items` with at most `limit` in flight, resolving once all
 * have settled. For per-tab Chrome API calls whose order does not matter (closing
 * tabs, say): one at a time pays a full round trip per tab, while firing all at
 * once floods the browser on a large selection. `task` handles its own errors.
 */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
