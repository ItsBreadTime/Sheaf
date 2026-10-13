import { normalizeOrganizerResponse } from "./normalize";
import { LIMITS } from "../shared/limits";
import {
  parseOrganizerResponse,
  ResponseSchemaError,
  type OrganizerResponseV1,
} from "./response-schema";

export const ORGANIZER_LIMITS = {
  MAX_TABS_PER_GROUP: LIMITS.MAX_TABS_PER_GROUP,
} as const;

export class OrganizerValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "OrganizerValidationError";
    this.issues = issues;
  }
}

function validateSubmittedIds(submittedTabIds: readonly number[]): Set<number> {
  const knownIds = new Set<number>();
  const issues: string[] = [];
  submittedTabIds.forEach((id, index) => {
    if (!Number.isSafeInteger(id)) {
      issues.push(`submittedTabIds[${index}] must be a safe integer`);
    } else if (knownIds.has(id)) {
      issues.push(`submitted tab ID ${id} is duplicated`);
    } else {
      knownIds.add(id);
    }
  });
  if (issues.length > 0) {
    throw new OrganizerValidationError(issues);
  }
  return knownIds;
}

// Undersized groups are not rejected here: normalization demotes their members
// to untouched, which is the reduce-only outcome a repair call would also reach.
function validateRawLimits(response: OrganizerResponseV1): void {
  const issues: string[] = [];
  response.groups.forEach((group, index) => {
    if (group.tabIds.length > ORGANIZER_LIMITS.MAX_TABS_PER_GROUP) {
      issues.push(
        `response.groups[${index}].tabIds contains more than ${ORGANIZER_LIMITS.MAX_TABS_PER_GROUP} tabs`,
      );
    }
  });
  if (issues.length > 0) {
    throw new OrganizerValidationError(issues);
  }
}

export function validateOrganizerResponse(
  response: OrganizerResponseV1,
  submittedTabIds: readonly number[],
): void {
  const knownIds = validateSubmittedIds(submittedTabIds);
  const occurrences = new Map<number, number>();
  const temporaryIds = new Set<string>();
  const normalizedTitles = new Set<string>();
  const issues: string[] = [];

  const recordOccurrence = (id: number): void => {
    occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    if (!knownIds.has(id)) {
      issues.push(`response contains unknown tab ID ${id}`);
    }
  };

  for (const [index, group] of response.groups.entries()) {
    const temporaryId = group.temporaryId.trim();
    if (!temporaryId) {
      issues.push(`response.groups[${index}].temporaryId must not be blank`);
    } else if (temporaryIds.has(temporaryId)) {
      issues.push(`response contains duplicate temporaryId ${JSON.stringify(temporaryId)}`);
    }
    temporaryIds.add(temporaryId);

    const trimmedTitle = group.title.trim();
    const normalizedTitle = trimmedTitle.toLowerCase();
    if (!trimmedTitle) {
      issues.push(`response.groups[${index}].title must not be blank`);
    } else if (normalizedTitles.has(normalizedTitle)) {
      issues.push(
        `response contains duplicate group title ${JSON.stringify(trimmedTitle)} after trimming and case-insensitive comparison`,
      );
    }
    normalizedTitles.add(normalizedTitle);
    group.tabIds.forEach(recordOccurrence);
  }
  response.untouchedTabIds.forEach(recordOccurrence);

  const untouchedIds = new Set(response.untouchedTabIds);
  for (const id of response.ungroupTabIds ?? []) {
    if (!untouchedIds.has(id)) issues.push(`response.ungroupTabIds contains tab ID ${id} that is not untouched`);
  }

  const lowValueIds = new Set<number>();
  for (const id of response.lowValueTabIds ?? []) {
    if (!knownIds.has(id)) issues.push(`response.lowValueTabIds contains unknown tab ID ${id}`);
    if (lowValueIds.has(id)) issues.push(`response.lowValueTabIds contains duplicate tab ID ${id}`);
    lowValueIds.add(id);
  }

  for (const [id, count] of occurrences) {
    if (count > 1) {
      issues.push(`tab ID ${id} appears ${count} times`);
    }
  }
  for (const id of knownIds) {
    if (!occurrences.has(id)) {
      issues.push(`submitted tab ID ${id} is missing`);
    }
  }

  if (issues.length > 0) {
    throw new OrganizerValidationError(issues);
  }
}

export function parseNormalizeAndValidateOrganizerResponse(
  value: unknown,
  submittedTabIds: readonly number[],
): OrganizerResponseV1 {
  let parsed: OrganizerResponseV1;
  try {
    parsed = parseOrganizerResponse(value);
  } catch (error: unknown) {
    if (error instanceof ResponseSchemaError) {
      throw new OrganizerValidationError(error.issues);
    }
    throw error;
  }

  validateRawLimits(parsed);
  const normalized = normalizeOrganizerResponse(parsed, submittedTabIds);
  validateOrganizerResponse(normalized, submittedTabIds);
  return normalized;
}
