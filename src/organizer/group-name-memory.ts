import { sanitizeGroupTitle } from "../privacy/sanitize-text";
import type { GroupNamePreference } from "../shared/organizer-types";
import type { ProposalConfirmationSource } from "../shared/proposal-review-types";
import { isRecord } from "../shared/guards";

export function shouldRecordGroupNameApprovals(
  confirmationSource: ProposalConfirmationSource | null,
): boolean {
  return confirmationSource === "user";
}

const MAX_PREFERENCES = 100;

function normalizedName(value: unknown): string {
  return typeof value === "string" ? sanitizeGroupTitle(value).trim() : "";
}

export function normalizeGroupNamePreferences(value: unknown): GroupNamePreference[] {
  if (!Array.isArray(value)) return [];
  const normalized: GroupNamePreference[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, MAX_PREFERENCES)) {
    if (!isRecord(item)) continue;
    const name = normalizedName(item.name);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    const approvalCount = typeof item.approvalCount === "number" &&
      Number.isSafeInteger(item.approvalCount) && item.approvalCount >= 1
      ? Math.min(item.approvalCount, 1_000_000)
      : 1;
    const lastApprovedAt = typeof item.lastApprovedAt === "number" &&
      Number.isFinite(item.lastApprovedAt) && item.lastApprovedAt >= 0
      ? item.lastApprovedAt
      : 0;
    seen.add(key);
    normalized.push({ name, approvalCount, lastApprovedAt });
  }
  return normalized.sort((left, right) =>
    right.approvalCount - left.approvalCount ||
    right.lastApprovedAt - left.lastApprovedAt ||
    left.name.localeCompare(right.name),
  );
}

export function recordApprovedGroupNames(
  current: readonly GroupNamePreference[],
  approvedNames: readonly string[],
  now = Date.now(),
): GroupNamePreference[] {
  const byName = new Map(
    normalizeGroupNamePreferences(current).map((item) => [item.name.toLocaleLowerCase(), item]),
  );
  const namesThisRun = new Map<string, string>();
  approvedNames.forEach((value) => {
    const name = normalizedName(value);
    if (name) namesThisRun.set(name.toLocaleLowerCase(), name);
  });
  for (const [key, name] of namesThisRun) {
    const existing = byName.get(key);
    byName.set(key, existing
      ? { ...existing, approvalCount: existing.approvalCount + 1, lastApprovedAt: now }
      : { name, approvalCount: 1, lastApprovedAt: now });
  }
  return normalizeGroupNamePreferences([...byName.values()]).slice(0, MAX_PREFERENCES);
}

export function preferredGroupNameVocabulary(
  preferences: readonly GroupNamePreference[],
): string[] {
  return normalizeGroupNamePreferences(preferences)
    .filter((item) => item.approvalCount >= 2)
    .map((item) => item.name);
}
