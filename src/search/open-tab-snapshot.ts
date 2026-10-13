import { searchableLocation, type SearchableTab } from "./direct-search";

// Every non-incognito tab in a normal window, as direct search reads it. The
// target window is listed first and labelled "Current window".
export async function captureOpenTabSnapshot(currentTargetWindowId: number | null): Promise<SearchableTab[]> {
  const [tabs, groups, windows] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.windows.getAll({ windowTypes: ["normal"] }),
  ]);
  const normalWindowIds = new Set(
    windows.filter((window) => !window.incognito).map((window) => window.id),
  );
  const orderedWindowIds = [
    ...(currentTargetWindowId !== null && normalWindowIds.has(currentTargetWindowId) ? [currentTargetWindowId] : []),
    ...windows.flatMap((window) =>
      window.id !== undefined && window.id !== currentTargetWindowId && normalWindowIds.has(window.id)
        ? [window.id]
        : [],
    ),
  ];
  const windowLabels = new Map(
    orderedWindowIds.map((windowId, index) => [
      windowId,
      windowId === currentTargetWindowId ? "Current window" : `Window ${index + 1}`,
    ]),
  );
  const groupNames = new Map(groups.map((group) => [group.id, group.title?.trim() || null]));
  return tabs.flatMap((tab) => {
    if (
      tab.id === undefined ||
      tab.windowId === undefined ||
      tab.incognito ||
      !normalWindowIds.has(tab.windowId)
    ) return [];
    const url = tab.url ?? "";
    const location = searchableLocation(url);
    return [{
      id: tab.id,
      windowId: tab.windowId,
      windowLabel: windowLabels.get(tab.windowId) ?? "Other window",
      title: tab.title?.trim() || "Untitled tab",
      url,
      hostname: location.hostname,
      path: location.path,
      groupName: tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
        ? null
        : groupNames.get(tab.groupId) ?? null,
      lastAccessed: tab.lastAccessed ?? null,
    }];
  });
}
