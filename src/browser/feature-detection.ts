import type { FeatureValue } from "../shared/types";

export function readSharedState(
  group: chrome.tabGroups.TabGroup,
): FeatureValue<boolean> {
  if (!("shared" in group)) {
    return { known: false, value: null };
  }

  return {
    known: true,
    value: Boolean((group as chrome.tabGroups.TabGroup & { shared: boolean }).shared),
  };
}

export function readSplitViewState(
  tab: chrome.tabs.Tab,
): FeatureValue<number> {
  if (!("splitViewId" in tab)) {
    return { known: false, value: null };
  }

  const value = (tab as chrome.tabs.Tab & { splitViewId: number }).splitViewId;
  return { known: true, value };
}
