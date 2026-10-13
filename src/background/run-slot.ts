/**
 * A single-occupancy slot for a long-running job, such as the background
 * organize. `claim` is synchronous, so a caller that claims before its first
 * `await` cannot race a second trigger past the check; `release` only clears
 * the slot for its own claim, so a run that finishes late cannot drop a newer
 * run's claim.
 */
export function createRunSlot<Claim extends object>() {
  let owner: Claim | null = null;
  return {
    current: (): Claim | null => owner,
    /** Takes the slot, or returns false when another run holds it. */
    claim(claim: Claim): boolean {
      if (owner) return false;
      owner = claim;
      return true;
    },
    release(claim: Claim): void {
      if (owner === claim) owner = null;
    },
  };
}
