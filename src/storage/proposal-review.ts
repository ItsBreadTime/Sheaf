import { PROPOSAL_REVIEW } from "../shared/constants";
import type {
  ProposalInputSnapshot,
  ProposalReviewState,
} from "../shared/proposal-review-types";
import type { SemanticWindowState } from "../shared/types";
import { ensureSessionStorageCapacity } from "./session-budget";

export async function createProposalInputSnapshot(
  browserState: SemanticWindowState,
  requestJson: string,
): Promise<ProposalInputSnapshot> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requestJson),
  );
  const requestHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    browserState: structuredClone(browserState),
    requestHash,
    capturedAt: browserState.capturedAt,
  };
}

export async function readProposalReview(): Promise<ProposalReviewState | null> {
  const values = await chrome.storage.session.get(
    PROPOSAL_REVIEW.SESSION_KEYS.proposalReview,
  );
  return (
    (values[
      PROPOSAL_REVIEW.SESSION_KEYS.proposalReview
    ] as ProposalReviewState | undefined) ?? null
  );
}

export async function writeProposalReview(
  review: ProposalReviewState | null,
): Promise<void> {
  if (review) {
    const values = {
      [PROPOSAL_REVIEW.SESSION_KEYS.proposalReview]: review,
      [PROPOSAL_REVIEW.SESSION_KEYS.inputSnapshot]: review.inputSnapshot,
    };
    await ensureSessionStorageCapacity(values);
    await chrome.storage.session.set(values);
  } else {
    await chrome.storage.session.remove([
      PROPOSAL_REVIEW.SESSION_KEYS.proposalReview,
      PROPOSAL_REVIEW.SESSION_KEYS.inputSnapshot,
    ]);
  }
}
