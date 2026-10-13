import { UNGROUPED_GROUP_ID } from "../shared/constants";
import type { OrganizationScope } from "../shared/organizer-types";
import type { SemanticTab, SemanticWindowState } from "../shared/types";

export const WHOLE_WINDOW_SCOPE: OrganizationScope = { mode: "window" };

function groupTitle(state: SemanticWindowState, groupId: number): string {
  const group = state.groups.find((candidate) => candidate.runtimeId === groupId);
  return group?.title.trim() || "Untitled group";
}

export function normalizeOrganizationScope(
  state: SemanticWindowState,
  scope: OrganizationScope,
): OrganizationScope {
  const groupIds = new Set(state.groups.map((group) => group.runtimeId));
  if (scope.mode === "group") {
    return groupIds.has(scope.groupId)
      ? scope
      : state.groups[0]
        ? { mode: "group", groupId: state.groups[0].runtimeId }
        : WHOLE_WINDOW_SCOPE;
  }
  if (scope.mode === "exclude_groups") {
    return {
      mode: "exclude_groups",
      groupIds: [...new Set(scope.groupIds)].filter((groupId) => groupIds.has(groupId)),
    };
  }
  return scope;
}

export function tabIsInOrganizationScope(
  tab: SemanticTab,
  scope: OrganizationScope,
): boolean {
  switch (scope.mode) {
    case "window":
      return true;
    case "selected_tabs":
      return tab.highlighted === true;
    case "group":
      return tab.groupId === scope.groupId;
    case "ungrouped":
      return tab.groupId === UNGROUPED_GROUP_ID;
    case "exclude_groups":
      return !scope.groupIds.includes(tab.groupId);
  }
}

export function validateOrganizationScope(
  state: SemanticWindowState,
  scope: OrganizationScope,
): void {
  if (
    scope.mode === "group" &&
    !state.groups.some((group) => group.runtimeId === scope.groupId)
  ) {
    throw new Error("The selected tab group is no longer available.");
  }
  if (scope.mode === "exclude_groups" && scope.groupIds.length === 0) {
    throw new Error("Choose at least one group to leave unchanged.");
  }
  if (!state.tabs.some((tab) => tabIsInOrganizationScope(tab, scope))) {
    throw new Error(
      scope.mode === "selected_tabs"
        ? "No highlighted tabs are available. Select tabs in the tab strip first."
        : "The selected scope contains no tabs.",
    );
  }
}

export function organizationScopeLabel(
  state: SemanticWindowState,
  scope: OrganizationScope,
): string {
  switch (scope.mode) {
    case "window":
      return "Current window";
    case "selected_tabs": {
      const count = state.tabs.filter((tab) => tab.highlighted === true).length;
      return `${count} selected tab${count === 1 ? "" : "s"}`;
    }
    case "group":
      return `Group: ${groupTitle(state, scope.groupId)}`;
    case "ungrouped":
      return "Ungrouped tabs";
    case "exclude_groups": {
      const count = scope.groupIds.length;
      return `Window except ${count} group${count === 1 ? "" : "s"}`;
    }
  }
}
