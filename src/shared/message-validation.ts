import type { WindowCaptureMessage } from "./types";
import { isRecord } from "./guards";

/**
 * A shallow shape check for messages reaching the service worker.
 *
 * The sender check already limits callers to this extension's own pages; this
 * is the second layer, so a page that is compromised or simply out of date
 * cannot hand a privileged handler a string where a tab ID belongs, or an
 * object where an array is iterated. Nested structures (drafts, previews,
 * scopes) are only checked to be objects or arrays; their handlers validate
 * them where they are used.
 */
type FieldRule =
  | "int"
  | "int?"
  | "intOrNull"
  | "string"
  | "string?"
  | "stringOrNull?"
  | "boolean"
  | "boolean?"
  | "intArray"
  | "intArray?"
  | "stringArray"
  | "array"
  | "object"
  | "object?"
  | readonly string[];

type MessageRules = {
  [Type in WindowCaptureMessage["type"]]: Record<string, FieldRule>;
};

const PERMANENCE = ["session", "permanent"] as const;

const MESSAGE_RULES = {
  "window-capture:get-state": {},
  "popup:initialize": { targetWindowId: "int", ownerContextId: "string" },
  "popup:heartbeat": { targetWindowId: "int", ownerContextId: "string" },
  "window-capture:refresh": {},
  "organization:generate": { targetWindowId: "int", scope: "object" },
  "organization:cancel-generate": {},
  "organization:apply": { reviewId: "string", ownerContextId: "string", reportOutcome: "boolean?" },
  "organization:undo": { transactionId: "string" },
  "group-manager:get-state": { currentWindowId: "intOrNull" },
  "group-manager:set-managed": { groupIds: "intArray", managed: "boolean" },
  "group-manager:preview-edit": { draft: "object" },
  "group-manager:apply-edit": { preview: "object" },
  "group-manager:preview-remove": { groupIds: "intArray", mode: ["ungroup", "close"], includeActive: "boolean" },
  "group-manager:apply-remove": { preview: "object" },
  "group-manager:undo": {},
  "generated-groups:get-cleanup": {},
  "generated-groups:set-cleanup": { autoUngroupAfterDays: "intOrNull" },
  "generated-groups:clear": {},
  "cleanup:close-suggested-tabs": { targetWindowId: "int", tabIds: "intArray" },
  "protection:protect-tabs": { targetWindowId: "int", tabIds: "intArray", permanence: PERMANENCE },
  "protection:lock-groups": { targetWindowId: "int", groupIds: "intArray", permanence: PERMANENCE },
  "protection:update-rules": { rules: "array" },
  "protection:release-session": { targetWindowId: "int", tabIds: "intArray", groupIds: "intArray" },
  "workspace:create": {
    targetWindowId: "int",
    scope: "object",
    expectedTabIds: "intArray",
    name: "string",
    keepOpen: "boolean?",
  },
  "workspace:restore": {
    stashId: "string",
    targetWindowId: "int",
    sourceIndexes: "intArray?",
    options: "object?",
    revisionId: "string?",
  },
  "workspace:open-tab": { stashId: "string", sourceIndex: "int", targetWindowId: "int", active: "boolean" },
  "workspace:open-copies": {
    items: "array",
    targetWindowId: "int",
    destination: ["current_window", "new_window"],
    duplicateHandling: ["reuse", "skip", "duplicate"],
  },
  "workspace:create-from-selection": {
    items: "array",
    targetWindowId: "int",
    name: "string",
    preserveGroups: "boolean",
    sourceQueries: "stringArray",
    reviewedSelectionToken: "string",
  },
  "workspace:preview-search-edit": { items: "array", operation: ["remove", "move", "merge"], targetStashId: "stringOrNull?" },
  "workspace:apply-search-edit": {
    items: "array",
    operation: ["remove", "move", "merge"],
    targetStashId: "stringOrNull?",
    reviewedSelectionToken: "string",
  },
  "workspace:undo-search-edit": { transactionId: "string" },
  "workspace:window-diff": { stashId: "string" },
  "workspace:window-save": { stashId: "string", putAway: "boolean", expectedCaptureToken: "string" },
  "workspace:window-unlink": { stashId: "string" },
  "workspace:update-metadata": { stashId: "string", name: "string", note: "string" },
  "workspace:delete": { stashId: "string" },
  "workspace:recover-interrupted": { stashId: "string" },
  "workspace:window-close": { stashId: "string", discardChanges: "boolean" },
  "workspace:window-focus": { stashId: "string" },
  "workspace:trash-restore": { stashId: "string" },
  "workspace:trash-purge": { stashId: "string" },
  "workspace:revision-restore": { stashId: "string", revisionId: "string" },
  "auto-filing:get-state": {},
  "auto-filing:undo": { entryId: "string?" },
  "auto-filing:never-file": { entryId: "string" },
  "auto-filing:accept-suggestion": {},
  "auto-filing:dismiss-suggestion": {},
  "semantic-index:get-state": {},
  "semantic-index:build": { targetWindowId: "int" },
  "semantic-index:resume": {},
  "semantic-index:cancel": {},
  "semantic-index:clear": {},
} as const satisfies MessageRules;

const isInt = (value: unknown): boolean => Number.isSafeInteger(value);

function fieldMatches(value: unknown, rule: FieldRule): boolean {
  if (typeof rule !== "string") return typeof value === "string" && rule.includes(value);
  if (rule.endsWith("?") && value === undefined) return true;
  switch (rule) {
    case "int":
    case "int?":
      return isInt(value);
    case "intOrNull":
      return value === null || isInt(value);
    case "string":
    case "string?":
      return typeof value === "string";
    case "stringOrNull?":
      return value === null || typeof value === "string";
    case "boolean":
    case "boolean?":
      return typeof value === "boolean";
    case "intArray":
    case "intArray?":
      return Array.isArray(value) && value.every(isInt);
    case "stringArray":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "array":
      return Array.isArray(value);
    case "object":
    case "object?":
      return isRecord(value);
  }
}

/** Throws unless the message is a known type whose top-level fields have the declared shapes. */
export function assertWindowCaptureMessage(message: unknown): asserts message is WindowCaptureMessage {
  if (!isRecord(message) || typeof message.type !== "string" || !Object.hasOwn(MESSAGE_RULES, message.type)) {
    throw new Error("Unknown message.");
  }
  const rules: Record<string, FieldRule> = MESSAGE_RULES[message.type as WindowCaptureMessage["type"]];
  for (const [field, rule] of Object.entries(rules)) {
    if (!fieldMatches(message[field], rule)) {
      throw new Error(`Malformed ${message.type} message: invalid ${field}.`);
    }
  }
}
