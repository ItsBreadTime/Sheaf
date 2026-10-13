import type { ImmutableRequestBundle, ValidatedProposal } from "./organizer-types";
import type { SemanticWindowState } from "./types";

export interface EditorLease {
  editorWindowId: number;
  ownerContextId: string;
  lastHeartbeatAt: number;
  leaseExpiresAt: number;
}

export type ProviderCancellationReason =
  | "editor_closed"
  | "owner_lease_expired"
  | "user_cancelled";

export interface ProposalInputSnapshot {
  browserState: SemanticWindowState;
  requestHash: string;
  capturedAt: number;
}

export type ProposalReviewStatus =
  | "editing"
  | "review_required"
  | "confirmed"
  | "regeneration_required"
  | "target_invalid";

export type ProposalConfirmationSource = "user" | "automatic";

export interface ProposalReviewState {
  reviewId: string;
  request: ImmutableRequestBundle;
  inputSnapshot: ProposalInputSnapshot;
  proposal: ValidatedProposal;
  availableSubmittedTabIds: number[];
  revision: number;
  validationIssues: string[];
  driftWarnings: string[];
  regenerationReasons: string[];
  signalAcknowledgementRequired: boolean;
  confirmedAt: number | null;
  confirmationSource: ProposalConfirmationSource | null;
  status: ProposalReviewStatus;
  /** Model stats from the request that produced this plan, carried into history on Apply. */
  generation?: import("./transaction-types").HistoryGenerationStats;
}

export interface DriftCheckResult {
  proposal: ValidatedProposal;
  availableSubmittedTabIds: number[];
  closedTabIds: number[];
  warnings: string[];
  regenerationReasons: string[];
  signalAcknowledgementRequired: boolean;
  targetInvalid: boolean;
}
