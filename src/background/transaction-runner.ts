import { compareSemanticStates } from "../browser/semantic-compare";
import { UNGROUPED_GROUP_ID } from "../shared/constants";
import type {
  BrowserOperation,
  CompatibilityVerification,
  FaultInjectionMode,
  OrganizationRun,
  SemanticWindowState,
  TransactionJournal,
} from "../shared/types";

export interface TransactionRuntime {
  readWindow(windowId: number): Promise<SemanticWindowState>;
  groupTabs(windowId: number, tabIds: number[], existingGroupId?: number): Promise<number>;
  updateGroup(
    groupId: number,
    update: {
      title: string;
      color: chrome.tabGroups.TabGroup["color"];
      collapsed: boolean;
    },
  ): Promise<void>;
  moveGroup(groupId: number, index: number): Promise<void>;
  moveTabs(tabIds: number[], index: number): Promise<void>;
  ungroupTabs(tabIds: number[]): Promise<void>;
  persist(run: OrganizationRun): Promise<void>;
}

function verification(
  matches: boolean,
  issues: string[],
): CompatibilityVerification {
  return { passed: matches, checkedAt: Date.now(), issues };
}

function verifyIdentityAndMembership(
  expected: SemanticWindowState,
  observed: SemanticWindowState,
): string[] {
  const issues: string[] = [];
  const expectedIds = expected.tabs.map((tab) => tab.id);
  const observedIds = observed.tabs.map((tab) => tab.id);
  const observedIdSet = new Set(observedIds);
  if (
    expectedIds.length !== observedIds.length ||
    expectedIds.some((tabId) => !observedIdSet.has(tabId))
  ) {
    issues.push("Tab membership changed.");
  }
  const observedById = new Map(observed.tabs.map((tab) => [tab.id, tab]));
  for (const tab of expected.tabs) {
    const live = observedById.get(tab.id);
    if (!live) issues.push(`Tab ${tab.id} is missing.`);
    else if (live.url !== tab.url || live.title !== tab.title) {
      issues.push(`Tab ${tab.id} changed identity.`);
    }
  }
  return issues;
}

function verifyOperation(
  journal: TransactionJournal,
  operation: BrowserOperation,
  observed: SemanticWindowState,
): CompatibilityVerification {
  const issues = verifyIdentityAndMembership(journal.rollbackSnapshot, observed);
  if (operation.kind === "create_group") {
    const expectedMembers = JSON.stringify(operation.tabIds);
    if (
      !observed.groups.some(
        (group) => JSON.stringify(group.memberTabIds) === expectedMembers,
      )
    ) {
      issues.push(`Created group ${operation.groupRef} was not found in queried state.`);
    }
  } else if (operation.kind === "update_group") {
    const expectedGroupId = journal.runtimeGroupIds[operation.groupRef];
    const group = observed.groups.find(
      (candidate) => candidate.runtimeId === expectedGroupId,
    );
    if (
      !group ||
      group.title !== operation.title ||
      group.color !== operation.color ||
      group.collapsed !== operation.collapsed
    ) {
      issues.push(`Group metadata for ${operation.groupRef} did not match the plan.`);
    }
  } else if (operation.kind === "move_group") {
    const expectedGroupId = journal.runtimeGroupIds[operation.groupRef];
    const group = observed.groups.find(
      (candidate) => candidate.runtimeId === expectedGroupId,
    );
    if (!group || group.firstTabIndex !== operation.index) {
      issues.push(`Group position for ${operation.groupRef} did not match the plan.`);
    }
  } else if (operation.kind === "order_group") {
    const expectedGroupId = journal.runtimeGroupIds[operation.groupRef];
    const group = observed.groups.find(
      (candidate) => candidate.runtimeId === expectedGroupId,
    );
    if (
      !group ||
      group.firstTabIndex !== operation.index ||
      JSON.stringify(group.memberTabIds) !== JSON.stringify(operation.tabIds)
    ) {
      issues.push(`Tab order for ${operation.groupRef} did not match the plan.`);
    }
  } else if (operation.kind === "ungroup_tabs") {
    const observedById = new Map(observed.tabs.map((tab) => [tab.id, tab]));
    if (operation.tabIds.some((tabId) => observedById.get(tabId)?.groupId !== UNGROUPED_GROUP_ID)) {
      issues.push("Tabs leaving their group are still grouped.");
    }
  } else {
    const tail = observed.tabs.slice(-operation.tabIds.length);
    if (
      JSON.stringify(tail.map((tab) => tab.id)) !== JSON.stringify(operation.tabIds) ||
      tail.some((tab) => tab.groupId !== UNGROUPED_GROUP_ID)
    ) {
      issues.push("Ungrouped tabs were not arranged at the end of the window.");
    }
  }
  return verification(issues.length === 0, issues);
}

async function persistStatus(
  runtime: TransactionRuntime,
  run: OrganizationRun,
  status: OrganizationRun["status"],
): Promise<void> {
  run.status = status;
  if (
    status === "prepared" ||
    status === "applying" ||
    status === "verifying" ||
    status === "rolling_back"
  ) {
    run.journal.status = status;
  }
  await runtime.persist(structuredClone(run));
}

/** Every tab a journal may have moved: membership changes plus pure rearrangement. */
export function journalRestoreTabIds(journal: TransactionJournal): number[] {
  return [...new Set([...journal.touchedTabIds, ...(journal.arrangedTabIds ?? [])])];
}

/**
 * Re-checks the tabs the plan will move against a fresh read, immediately before
 * the first mutation. The journal was built from a snapshot taken before planning
 * and storage writes; a user can pin, group, protect, or navigate a target tab in
 * that window. Aborting here (without rollback) is the only safe outcome: the
 * plan's tab IDs would otherwise mutate a tab the user just changed.
 */
function preMutationSafetyIssues(
  journal: TransactionJournal,
  observed: SemanticWindowState,
): string[] {
  const issues: string[] = [];
  const expectedById = new Map(journal.rollbackSnapshot.tabs.map((tab) => [tab.id, tab]));
  const observedById = new Map(observed.tabs.map((tab) => [tab.id, tab]));
  for (const tabId of journalRestoreTabIds(journal)) {
    const expected = expectedById.get(tabId);
    const live = observedById.get(tabId);
    if (!expected || !live) {
      issues.push(`Tab ${tabId} is missing.`);
      continue;
    }
    if (live.url !== expected.url || live.title !== expected.title) {
      issues.push(`Tab ${tabId} changed identity.`);
    }
    if (live.groupId !== expected.groupId) {
      issues.push(`Tab ${tabId} changed native group membership.`);
    }
    if (live.pinned !== expected.pinned) {
      issues.push(`Tab ${tabId} changed pinned state.`);
    }
    if (
      live.splitView.known !== expected.splitView.known ||
      live.splitView.value !== expected.splitView.value
    ) {
      issues.push(`Tab ${tabId} changed split-view safety state.`);
    }
    if (live.protectionReasons.join("\n") !== expected.protectionReasons.join("\n")) {
      issues.push(`Tab ${tabId} changed protected safety state.`);
    }
  }
  return issues;
}

export async function rollbackTransaction(
  run: OrganizationRun,
  runtime: TransactionRuntime,
  forceFailure = false,
): Promise<OrganizationRun> {
  const restoringTestBaseline =
    run.status === "completed" || run.status === "rollback_partial";
  // Rollback often runs because a write just failed (a full session store, say).
  // Its own status writes are best-effort: a record that cannot be saved must not
  // stop the tabs from being put back.
  let recordSaved = await persistBestEffort(() => persistStatus(runtime, run, "rolling_back"));
  const live = await runtime.readWindow(run.targetWindowId);
  const originalById = new Map(
    run.journal.rollbackSnapshot.tabs.map((tab) => [tab.id, tab]),
  );
  const liveById = new Map(live.tabs.map((tab) => [tab.id, tab]));
  const conflicts: string[] = [];
  const safeToRestore: number[] = [];

  for (const tabId of journalRestoreTabIds(run.journal)) {
    const original = originalById.get(tabId);
    const observed = liveById.get(tabId);
    if (!original || !observed) conflicts.push(`Tab ${tabId} is missing.`);
    else if (original.url !== observed.url || original.title !== observed.title) {
      conflicts.push(`Tab ${tabId} changed identity; rollback skipped it.`);
    } else safeToRestore.push(tabId);
  }

  if (forceFailure) {
    conflicts.push("Injected rollback failure prevented the ungroup operation.");
  } else if (safeToRestore.length > 0) {
    await restoreSnapshotMembership(
      run.journal.rollbackSnapshot,
      safeToRestore,
      runtime,
    );
  }

  const restored = await runtime.readWindow(run.targetWindowId);
  const comparison = compareSemanticStates(
    run.journal.rollbackSnapshot,
    restored,
  );
  const issues = [...conflicts, ...comparison.issues];
  run.rollbackVerification = verification(issues.length === 0, issues);
  run.status = issues.length === 0 ? "rolled_back" : "rollback_partial";
  // The original failure stays the headline; rollback issues live in
  // rollbackVerification so the result can show both the cause and what to check.
  run.error =
    issues.length === 0
      ? restoringTestBaseline
        ? null
        : run.error
      : restoringTestBaseline
        ? issues.join(" ")
        : run.error ?? issues.join(" ");
  recordSaved = await persistBestEffort(() => runtime.persist(structuredClone(run))) && recordSaved;
  if (!recordSaved) {
    run.error = [run.error, ROLLBACK_RECORD_UNSAVED].filter(Boolean).join(" ");
  }
  return run;
}

const ROLLBACK_RECORD_UNSAVED = "The rollback could not be recorded, so reopening the popup may not show this result.";

async function persistBestEffort(write: () => Promise<void>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch {
    // Reported through the run's error once the rollback has finished.
    return false;
  }
}

export async function restoreSnapshotMembership(
  snapshot: SemanticWindowState,
  tabIds: readonly number[],
  runtime: TransactionRuntime,
): Promise<void> {
  const restoreSet = new Set(tabIds);
  if (restoreSet.size === 0) return;
  await runtime.ungroupTabs([...restoreSet]);
  let live = await runtime.readWindow(snapshot.windowId);

  const currentIds = live.tabs.map((tab) => tab.id);
  const liveIds = new Set(currentIds);
  let segment: number[] = [];
  const placeSegment = async (anchorId: number | null): Promise<void> => {
    for (const tabId of segment) {
      const from = currentIds.indexOf(tabId);
      if (from < 0) continue;
      const without = currentIds.filter((id) => id !== tabId);
      const targetIndex = anchorId === null
        ? without.length
        : without.indexOf(anchorId);
      if (targetIndex < 0) continue;
      const next = [...without];
      next.splice(targetIndex, 0, tabId);
      if (next.some((id, index) => id !== currentIds[index])) {
        await runtime.moveTabs([tabId], anchorId === null ? -1 : targetIndex);
        currentIds.splice(0, currentIds.length, ...next);
      }
    }
    segment = [];
  };

  for (const tab of snapshot.tabs) {
    if (!liveIds.has(tab.id)) continue;
    if (restoreSet.has(tab.id)) segment.push(tab.id);
    else await placeSegment(tab.id);
  }
  await placeSegment(null);
  live = await runtime.readWindow(snapshot.windowId);

  for (const originalGroup of snapshot.groups) {
    const restoringMembers = originalGroup.memberTabIds.filter((id) => restoreSet.has(id));
    if (restoringMembers.length === 0) continue;
    const untouchedMembers = originalGroup.memberTabIds.filter((id) => !restoreSet.has(id));
    let target = live.groups.find(
      (group) =>
        JSON.stringify(group.memberTabIds) === JSON.stringify(untouchedMembers) &&
        group.title === originalGroup.title &&
        group.color === originalGroup.color &&
        group.collapsed === originalGroup.collapsed,
    );
    const groupId = await runtime.groupTabs(
      snapshot.windowId,
      restoringMembers,
      target?.runtimeId,
    );
    if (!target) {
      await runtime.updateGroup(groupId, {
        title: originalGroup.title,
        color: originalGroup.color,
        collapsed: originalGroup.collapsed,
      });
      target = { ...originalGroup, runtimeId: groupId };
    }
    live = await runtime.readWindow(snapshot.windowId);
  }
}

export async function executeTransaction(
  initialRun: OrganizationRun,
  runtime: TransactionRuntime,
  faultInjection: FaultInjectionMode,
): Promise<OrganizationRun> {
  const run = structuredClone(initialRun);
  run.faultInjection = faultInjection;

  // Durability barrier: the complete prepared journal must commit before any
  // browser API capable of mutation is called.
  await persistStatus(runtime, run, "prepared");
  await persistStatus(runtime, run, "applying");

  // Last chance to notice a user change before the first mutation. Fail without
  // rollback: nothing has moved yet, and rolling back would fight the user's edit.
  const preflightIssues = preMutationSafetyIssues(
    run.journal,
    await runtime.readWindow(run.targetWindowId),
  );
  if (preflightIssues.length > 0) {
    run.status = "failed";
    run.error = `The window changed just before applying; nothing moved. ${preflightIssues.join(" ")}`;
    await runtime.persist(structuredClone(run));
    return run;
  }

  try {
    for (let index = 0; index < run.journal.operationPlan.length; index += 1) {
      const operation = run.journal.operationPlan[index];
      if (!operation) throw new Error(`Operation ${index} is unavailable.`);
      run.journal.inFlightOperation = index;
      await runtime.persist(structuredClone(run));

      if (faultInjection !== "none" && index === 1) {
        throw new Error("Injected apply failure before operation 2.");
      }

      if (operation.kind === "create_group") {
        const groupId = await runtime.groupTabs(
          run.targetWindowId,
          operation.tabIds,
        );
        run.journal.runtimeGroupIds[operation.groupRef] = groupId;
      } else if (operation.kind === "update_group") {
        const groupId = run.journal.runtimeGroupIds[operation.groupRef];
        if (groupId === undefined) {
          throw new Error(`Runtime group ID for ${operation.groupRef} is unavailable.`);
        }
        await runtime.updateGroup(groupId, {
          title: operation.title,
          color: operation.color,
          collapsed: operation.collapsed,
        });
      } else if (operation.kind === "move_group") {
        const groupId = run.journal.runtimeGroupIds[operation.groupRef];
        if (groupId === undefined) {
          throw new Error(`Runtime group ID for ${operation.groupRef} is unavailable.`);
        }
        await runtime.moveGroup(groupId, operation.index);
      } else if (operation.kind === "order_group") {
        // Chrome keeps membership when tabs move within their own group's span.
        await runtime.moveTabs(operation.tabIds, operation.index);
      } else if (operation.kind === "ungroup_tabs") {
        await runtime.ungroupTabs(operation.tabIds);
      } else {
        await runtime.moveTabs(operation.tabIds, -1);
      }

      const observed = await runtime.readWindow(run.targetWindowId);
      const operationVerification = verifyOperation(run.journal, operation, observed);
      if (!operationVerification.passed) {
        throw new Error(operationVerification.issues.join(" "));
      }
      run.journal.completedThrough = index;
      run.journal.inFlightOperation = null;
      await runtime.persist(structuredClone(run));
    }

    await persistStatus(runtime, run, "verifying");
    const finalState = await runtime.readWindow(run.targetWindowId);
    const comparison = compareSemanticStates(
      run.journal.expectedFinalState,
      finalState,
    );
    run.verification = verification(comparison.matches, comparison.issues);
    if (!comparison.matches) throw new Error(comparison.issues.join(" "));
    run.status = "completed";
    run.error = null;
    await runtime.persist(structuredClone(run));
    return run;
  } catch (error) {
    run.error = error instanceof Error ? error.message : "Transaction failed.";
    return rollbackTransaction(
      run,
      runtime,
      faultInjection === "rollback_failure",
    );
  }
}
