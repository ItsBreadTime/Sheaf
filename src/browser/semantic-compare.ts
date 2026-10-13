import type {
  SemanticComparison,
  SemanticGroup,
  SemanticWindowState,
} from "../shared/types";

interface CanonicalGroup {
  title: string;
  color: chrome.tabGroups.TabGroup["color"];
  collapsed: boolean;
  memberTabIds: number[];
  firstTabIndex: number;
}

function canonicalGroup(group: SemanticGroup): CanonicalGroup {
  return {
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
    memberTabIds: group.memberTabIds,
    firstTabIndex: group.firstTabIndex,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function compareSemanticStates(
  expected: SemanticWindowState,
  observed: SemanticWindowState,
): SemanticComparison {
  const issues: string[] = [];
  const expectedTabIds = expected.tabs.map((tab) => tab.id);
  const observedTabIds = observed.tabs.map((tab) => tab.id);
  if (stableJson(expectedTabIds) !== stableJson(observedTabIds)) {
    issues.push("Tab membership or relative ordering changed.");
  }

  const observedTabsById = new Map(observed.tabs.map((tab) => [tab.id, tab]));
  for (const expectedTab of expected.tabs) {
    const observedTab = observedTabsById.get(expectedTab.id);
    if (!observedTab) {
      issues.push(`Tab ${expectedTab.id} is missing.`);
      continue;
    }
    if (observedTab.url !== expectedTab.url) {
      issues.push(`Tab ${expectedTab.id} navigated.`);
    }
    if (observedTab.title !== expectedTab.title) {
      issues.push(`Tab ${expectedTab.id} title changed.`);
    }
  }

  const expectedGroups = expected.groups.map(canonicalGroup);
  const observedGroups = observed.groups.map(canonicalGroup);
  if (stableJson(expectedGroups) !== stableJson(observedGroups)) {
    issues.push("Native group semantics differ from the captured state.");
  }

  return { matches: issues.length === 0, issues };
}
