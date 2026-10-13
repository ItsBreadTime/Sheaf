export const UNGROUPED_GROUP_ID = -1;

export const WINDOW_CAPTURE = {
  SESSION_KEYS: {
    editor: "windowCaptureEditor",
  },
} as const;

export const ORGANIZATION_RUN = {
  PLANNED_GROUP_TITLE: "Planned",
  PLANNED_GROUP_COLOR: "blue" as const,
  SYNTHETIC_GROUP_ID_START: -10_000,
  SESSION_KEYS: {
    activeRun: "organizationRunActiveRun",
  },
} as const;

export const PROPOSAL_REVIEW = {
  EDITOR_HEARTBEAT_INTERVAL_MS: 2_000,
  EDITOR_LEASE_MS: 8_000,
  SESSION_KEYS: {
    editorLease: "proposalReviewEditorLease",
    proposalReview: "proposalReviewSession",
    inputSnapshot: "proposalReviewInputSnapshot",
  },
} as const;

/**
 * The reserved destination that means "leave this tab loose". A model-supplied
 * group temporaryId must never equal it, or moving a tab to that group would
 * silently ungroup the tab instead.
 */
export const UNTOUCHED_PROPOSAL_DESTINATION = "untouched" as const;

export const ORGANIZATION_TRANSACTION = {
  DEFAULT_GROUP_COLOR: "blue" as const,
  GROUP_COLORS: [
    "blue",
    "purple",
    "green",
    "orange",
    "pink",
    "cyan",
    "red",
    "yellow",
  ] as const satisfies readonly chrome.tabGroups.TabGroup["color"][],
  POLL_INTERVAL_MS: 300,
  // Upper bound on how long the popup waits for the background transaction to
  // reach a terminal status before giving up with a clear message.
  MAX_POLL_MS: 120_000,
  SESSION_KEYS: {
    undoPoint: "organizationUndoPoint",
  },
  LOCAL_KEYS: {
    history: "organizationHistory",
  },
  MAX_HISTORY_REPORTS: 50,
} as const;

// Debounce window for semantic ("search by meaning") queries in the action
// popup's search and group-manager views.
export const SEMANTIC_SEARCH_DEBOUNCE_MS = 750;
