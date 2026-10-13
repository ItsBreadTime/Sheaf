import {
  isChromeGroupColor,
  type ChromeGroupColor,
} from "../shared/group-colors";
import { UNTOUCHED_PROPOSAL_DESTINATION } from "../shared/constants";

export interface OrganizerResponseGroupV1 {
  temporaryId: string;
  title: string;
  color?: ChromeGroupColor;
  tabIds: number[];
}

export interface OrganizerResponseV1 {
  schemaVersion: 1;
  groups: OrganizerResponseGroupV1[];
  untouchedTabIds: number[];
  /** Subset of untouchedTabIds to take out of their current native group. */
  ungroupTabIds?: number[];
  lowValueTabIds?: number[];
}

export class ResponseSchemaError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "ResponseSchemaError";
    this.issues = issues;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownProperties(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowedProperties = new Set(allowed);
  for (const property of Object.keys(value)) {
    if (!allowedProperties.has(property)) {
      issues.push(`${path} contains unsupported property ${JSON.stringify(property)}`);
    }
  }
}

function parseTabIds(value: unknown, path: string, issues: string[]): number[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }

  const result: number[] = [];
  value.forEach((id: unknown, index: number) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      issues.push(`${path}[${index}] must be a safe integer`);
      return;
    }
    result.push(id);
  });
  return result;
}

export function parseOrganizerResponse(value: unknown): OrganizerResponseV1 {
  const issues: string[] = [];
  if (!isJsonObject(value)) {
    throw new ResponseSchemaError(["response must be a JSON object"]);
  }

  rejectUnknownProperties(
    value,
    ["schemaVersion", "groups", "untouchedTabIds", "ungroupTabIds", "lowValueTabIds"],
    "response",
    issues,
  );

  if (value.schemaVersion !== 1) {
    issues.push("response.schemaVersion must be 1");
  }

  const groups: OrganizerResponseGroupV1[] = [];
  if (!Array.isArray(value.groups)) {
    issues.push("response.groups must be an array");
  } else {
    value.groups.forEach((candidate: unknown, index: number) => {
      const path = `response.groups[${index}]`;
      if (!isJsonObject(candidate)) {
        issues.push(`${path} must be a JSON object`);
        return;
      }

      rejectUnknownProperties(candidate, ["temporaryId", "title", "color", "tabIds"], path, issues);
      const temporaryId = candidate.temporaryId;
      const title = candidate.title;
      const color = candidate.color;
      if (typeof temporaryId !== "string") {
        issues.push(`${path}.temporaryId must be a string`);
      } else if (temporaryId === UNTOUCHED_PROPOSAL_DESTINATION) {
        // Reserved: the editor uses this string to mean "leave the tab loose",
        // so a group carrying it would silently ungroup tabs moved to it.
        issues.push(`${path}.temporaryId must not be the reserved value "${UNTOUCHED_PROPOSAL_DESTINATION}"`);
      }
      if (typeof title !== "string") {
        issues.push(`${path}.title must be a string`);
      }
      if (color !== undefined && color !== null && !isChromeGroupColor(color)) {
        issues.push(`${path}.color must be a supported Chrome group color or null`);
      }
      const tabIds = parseTabIds(candidate.tabIds, `${path}.tabIds`, issues);

      if (typeof temporaryId === "string" && typeof title === "string") {
        groups.push({
          temporaryId,
          title,
          ...(isChromeGroupColor(color) ? { color } : {}),
          tabIds,
        });
      }
    });
  }

  const untouchedTabIds = parseTabIds(
    value.untouchedTabIds,
    "response.untouchedTabIds",
    issues,
  );
  const ungroupTabIds = value.ungroupTabIds === undefined
    ? []
    : parseTabIds(value.ungroupTabIds, "response.ungroupTabIds", issues);
  const lowValueTabIds = value.lowValueTabIds === undefined
    ? []
    : parseTabIds(value.lowValueTabIds, "response.lowValueTabIds", issues);

  if (issues.length > 0) {
    throw new ResponseSchemaError(issues);
  }

  return {
    schemaVersion: 1,
    groups,
    untouchedTabIds,
    ungroupTabIds,
    lowValueTabIds,
  };
}
