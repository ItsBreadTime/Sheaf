import type { OrganizationRun } from "../shared/types";

// A run persisted as "prepared" has not started mutating yet, but nothing else
// ever clears it: if the worker is killed between the durability write and the
// "applying" write, it stays non-terminal and every later organize/group/apply is
// refused for the rest of the session. Treat it as interruptible on wake, exactly
// as failStrandedTransaction already does.
export function interruptActiveTransaction(
  run: OrganizationRun | null,
): OrganizationRun | null {
  if (
    !run ||
    (run.status !== "prepared" &&
      run.status !== "applying" &&
      run.status !== "verifying" &&
      run.status !== "rolling_back")
  ) {
    return run;
  }
  return {
    ...run,
    status: "interrupted",
    error:
      "The extension runtime stopped during the transaction. The operation was not replayed automatically.",
  };
}

// A transaction that throws past its own rollback (for example, a tab closed
// while rollback was restoring it) must still end in a terminal state. Left
// non-terminal, every waiting surface polls forever without a message and
// later applies are refused as "already active".
export function failStrandedTransaction(
  run: OrganizationRun,
  error: unknown,
): OrganizationRun {
  if (
    run.status !== "prepared" &&
    run.status !== "applying" &&
    run.status !== "verifying" &&
    run.status !== "rolling_back"
  ) {
    return run;
  }
  const reason = error instanceof Error && error.message
    ? error.message
    : "The transaction stopped unexpectedly.";
  return {
    ...run,
    status: "failed",
    error: `${reason} The transaction could not finish or roll back; check the window before organizing again.`,
  };
}
