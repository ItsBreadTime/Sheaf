import { CHROME_GROUP_COLORS } from "../shared/group-colors";
import { LIMITS } from "../shared/limits";

export const ORGANIZER_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "groups", "untouchedTabIds", "ungroupTabIds", "lowValueTabIds"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["temporaryId", "title", "color", "tabIds"],
        properties: {
          temporaryId: { type: "string" },
          title: { type: "string", maxLength: 64 },
          color: {
            type: ["string", "null"],
            enum: [...CHROME_GROUP_COLORS, null],
          },
          tabIds: {
            type: "array",
            minItems: LIMITS.MIN_GROUP_SIZE,
            maxItems: LIMITS.MAX_TABS_PER_GROUP,
            items: { type: "integer" },
          },
        },
      },
    },
    untouchedTabIds: {
      type: "array",
      items: { type: "integer" },
    },
    ungroupTabIds: {
      type: "array",
      items: { type: "integer" },
    },
    lowValueTabIds: {
      type: "array",
      items: { type: "integer" },
    },
  },
} as const;
