/**
 * Escalation from filing to a full organize run. The backlog is the set of
 * ungrouped candidates that abstained; it escalates once it reaches the
 * threshold, or when the model says the leftovers form a new topic, subject to
 * a per-window cooldown.
 */

const ESCALATION_BACKLOG_THRESHOLD = 5;
const ESCALATION_REORGANIZE_THRESHOLD = 0.7;
export const ESCALATION_COOLDOWN_MS = 10 * 60_000;

export interface WindowEscalationState {
  /** Abstained ungrouped tab IDs, in the order they abstained. */
  backlog: number[];
  lastEscalatedAt: number | null;
}

export const emptyEscalationState = (): WindowEscalationState => ({ backlog: [], lastEscalatedAt: null });

export function recordAbstention(state: WindowEscalationState, tabId: number): WindowEscalationState {
  return state.backlog.includes(tabId) ? state : { ...state, backlog: [...state.backlog, tabId] };
}

/** A tab leaves the backlog once it is grouped, closed, or filed. */
export function clearFromBacklog(state: WindowEscalationState, tabId: number): WindowEscalationState {
  return state.backlog.includes(tabId)
    ? { ...state, backlog: state.backlog.filter((id) => id !== tabId) }
    : state;
}

export function shouldEscalate(
  state: WindowEscalationState,
  options: { now: number; reorganize: number | null; reviewOpen: boolean },
): boolean {
  if (options.reviewOpen) return false;
  if (state.lastEscalatedAt !== null && options.now - state.lastEscalatedAt < ESCALATION_COOLDOWN_MS) return false;
  if (state.backlog.length >= ESCALATION_BACKLOG_THRESHOLD) return true;
  return state.backlog.length > 0 && (options.reorganize ?? 0) > ESCALATION_REORGANIZE_THRESHOLD;
}

export function markEscalated(now: number): WindowEscalationState {
  return { backlog: [], lastEscalatedAt: now };
}
