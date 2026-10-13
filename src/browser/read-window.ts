import {
  DEFAULT_LOCATION_MUTATION_POLICY,
  getProtectedLocationReason,
  type LocationMutationPolicy,
} from "./domain-policy";
import { readSharedState, readSplitViewState } from "./feature-detection";
import { UNGROUPED_GROUP_ID } from "../shared/constants";
import type {
  SemanticGroup,
  SemanticTab,
  SemanticWindowState,
} from "../shared/types";

function addUniqueReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function directTabProtectionReasons(
  tab: chrome.tabs.Tab,
  policy: LocationMutationPolicy,
): string[] {
  const reasons: string[] = [];
  if (tab.pinned) {
    reasons.push("Pinned tab");
  }
  if (tab.incognito) {
    reasons.push("Incognito tab");
  }
  if (tab.id === undefined || tab.windowId === undefined) {
    reasons.push("Tab identity is unavailable");
  }
  if (!tab.url) {
    reasons.push("URL is unavailable or unreadable");
  } else {
    const locationReason = getProtectedLocationReason(tab.url, policy);
    if (locationReason) {
      reasons.push(locationReason);
    }
  }

  const splitView = readSplitViewState(tab);
  if (!splitView.known) {
    reasons.push("Split-view safety state is unknown");
  } else if (splitView.value !== UNGROUPED_GROUP_ID) {
    reasons.push("Tab belongs to split view");
  }

  return reasons;
}

export async function readSemanticWindow(
  windowId: number,
  policy: LocationMutationPolicy = DEFAULT_LOCATION_MUTATION_POLICY,
): Promise<SemanticWindowState> {
  const window = await chrome.windows.get(windowId);
  if (window.type !== "normal") {
    throw new Error("The selected target is not a normal browser window.");
  }
  if (window.incognito) {
    throw new Error("Incognito windows are outside the v0.1 scope.");
  }

  const [rawTabs, rawGroups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);
  rawTabs.sort((left, right) => left.index - right.index);

  const rawTabsByGroup = new Map<number, chrome.tabs.Tab[]>();
  for (const tab of rawTabs) {
    if (tab.groupId === UNGROUPED_GROUP_ID) {
      continue;
    }
    const members = rawTabsByGroup.get(tab.groupId) ?? [];
    members.push(tab);
    rawTabsByGroup.set(tab.groupId, members);
  }

  const groups: SemanticGroup[] = rawGroups
    .map((group) => {
      const shared = readSharedState(group);
      const groupReasons: string[] = [];
      if (!shared.known) {
        groupReasons.push("Shared-group safety state is unknown");
      } else if (shared.value) {
        groupReasons.push("Shared group");
      }

      const members = (rawTabsByGroup.get(group.id) ?? []).sort(
        (left, right) => left.index - right.index,
      );
      if (members.some((tab) => directTabProtectionReasons(tab, policy).length > 0)) {
        groupReasons.push("Group contains a protected tab");
      }

      return {
        runtimeId: group.id,
        windowId: group.windowId,
        title: group.title ?? "",
        color: group.color,
        collapsed: group.collapsed,
        shared,
        memberTabIds: members.flatMap((tab) =>
          tab.id === undefined ? [] : [tab.id],
        ),
        firstTabIndex: members[0]?.index ?? -1,
        protectionReasons: groupReasons,
      };
    })
    .sort((left, right) => left.firstTabIndex - right.firstTabIndex);

  const groupsById = new Map(groups.map((group) => [group.runtimeId, group]));
  const tabs: SemanticTab[] = rawTabs.flatMap((tab) => {
    if (tab.id === undefined) {
      return [];
    }

    const protectionReasons = directTabProtectionReasons(tab, policy);
    if (tab.groupId !== UNGROUPED_GROUP_ID) {
      const group = groupsById.get(tab.groupId);
      if (!group) {
        addUniqueReason(protectionReasons, "Native group state is unavailable");
      } else {
        for (const reason of group.protectionReasons) {
          addUniqueReason(protectionReasons, reason);
        }
      }
    }

    return [
      {
        id: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        title: tab.title ?? "Untitled tab",
        url: tab.url ?? "",
        groupId: tab.groupId,
        active: tab.active,
        highlighted: tab.highlighted,
        pinned: tab.pinned,
        audible: tab.audible ?? false,
        openerTabId: tab.openerTabId ?? null,
        lastAccessed: tab.lastAccessed ?? null,
        splitView: readSplitViewState(tab),
        protectionReasons,
      },
    ];
  });

  return {
    windowId,
    capturedAt: Date.now(),
    tabs,
    groups,
    eligibleTabIds: tabs
      .filter((tab) => tab.protectionReasons.length === 0)
      .map((tab) => tab.id),
    protectedTabIds: tabs
      .filter((tab) => tab.protectionReasons.length > 0)
      .map((tab) => tab.id),
    featureSupport: {
      sharedGroupProperty:
        rawGroups.length > 0 && rawGroups.every((group) => "shared" in group),
      splitViewIdProperty: rawTabs.every((tab) => "splitViewId" in tab),
      storageSession: "session" in chrome.storage,
    },
  };
}
