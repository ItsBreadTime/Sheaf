import type {
  OrganizerResponseGroupV1,
  OrganizerResponseV1,
} from "./response-schema";
import { LIMITS } from "../shared/limits";
import { sanitizeText } from "../privacy/sanitize-text";

export const MAX_GROUP_TITLE_CHARS = LIMITS.MAX_GROUP_TITLE_CHARS;

// Delegates to the privacy sanitizer so an applied group title and the
// group-name-memory key derived from it agree: NFKC-normalized, control and bidi
// characters handled, whitespace collapsed, trimmed, and truncated.
export function sanitizeGroupTitle(title: string): string {
  return sanitizeText(title, MAX_GROUP_TITLE_CHARS);
}

/**
 * Model titles often run a few characters past the limit, and a hard cut leaves
 * "Checkout Latency Inciden". Drop whole trailing words instead; a single word
 * longer than the limit still gets the hard cut.
 */
export function fitProposedGroupTitle(title: string): string {
  const clean = sanitizeText(title, Number.MAX_SAFE_INTEGER);
  const characters = Array.from(clean);
  if (characters.length <= MAX_GROUP_TITLE_CHARS) return clean;
  const head = characters.slice(0, MAX_GROUP_TITLE_CHARS + 1).join("");
  const boundary = head.lastIndexOf(" ");
  const fitted = boundary > 0 ? head.slice(0, boundary) : head;
  return sanitizeGroupTitle(fitted.replace(/[\s\-–—:&,/+|]+$/u, ""));
}

function unique(ids: readonly number[], keep: (id: number) => boolean = () => true): number[] {
  const seen = new Set<number>();
  return ids.filter((id) => {
    if (seen.has(id) || !keep(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Repairs recoverable model mistakes locally, but only in the direction of doing
 * less: a tab whose placement is missing, contradictory, or would leave a singleton
 * group becomes untouched, and an unknown ID is dropped. Nothing is ever guessed
 * into a group, so the result is as safe to apply without review (Automatic mode)
 * as the model's own untouched assignments. Problems that cannot be resolved by
 * doing less — blank or duplicate titles, oversized groups — are left for
 * validation and the provider repair pass.
 *
 * Without submittedTabIds, IDs are only de-duplicated; coverage is left to the
 * validator.
 */
export function normalizeOrganizerResponse(
  response: OrganizerResponseV1,
  submittedTabIds?: readonly number[],
): OrganizerResponseV1 {
  const known = submittedTabIds ? new Set(submittedTabIds) : null;
  const isKnown = (id: number): boolean => known === null || known.has(id);

  const groupTabIds = response.groups.map((group) => unique(group.tabIds, isKnown));
  const groupCount = new Map<number, number>();
  groupTabIds.flat().forEach((id) => groupCount.set(id, (groupCount.get(id) ?? 0) + 1));
  const listedUntouched = unique(response.untouchedTabIds, isKnown);
  const untouchedSet = new Set(listedUntouched);
  // A tab claimed by two groups, or by a group and untouched, has no single
  // intended home; untouched is the placement that changes nothing.
  const contested = (id: number): boolean =>
    (groupCount.get(id) ?? 0) > 1 || untouchedSet.has(id);

  const groups: OrganizerResponseGroupV1[] = [];
  const demoted: number[] = [];
  const temporaryIds = new Set<string>();
  const temporaryIdFor = (candidate: string): string => {
    let id = candidate.trim();
    for (let next = groups.length + 1; !id || temporaryIds.has(id); next += 1) {
      id = `group-${next}`;
    }
    temporaryIds.add(id);
    return id;
  };
  response.groups.forEach((group, index) => {
    const tabIds = groupTabIds[index]!.filter((id) => !contested(id));
    if (tabIds.length < LIMITS.MIN_GROUP_SIZE) {
      demoted.push(...tabIds);
      return;
    }
    groups.push({
      temporaryId: temporaryIdFor(group.temporaryId),
      title: fitProposedGroupTitle(group.title),
      ...(group.color ? { color: group.color } : {}),
      tabIds,
    });
  });

  const grouped = new Set(groups.flatMap((group) => group.tabIds));
  const untouchedTabIds = unique(
    [...listedUntouched, ...demoted, ...(submittedTabIds ?? [])],
    (id) => !grouped.has(id),
  );
  const untouched = new Set(untouchedTabIds);

  return {
    schemaVersion: 1,
    groups,
    untouchedTabIds,
    ungroupTabIds: unique(response.ungroupTabIds ?? [], (id) => untouched.has(id)),
    lowValueTabIds: unique(response.lowValueTabIds ?? [], isKnown),
  };
}
