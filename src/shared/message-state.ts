import type { WindowCaptureMessage, WindowCaptureResponse } from "./types";

// Messages whose replies carry no view state. Serializing the whole view state
// (captured window, proposal run, undo point, leases) into every reply is
// wasted work for callers that never read it — most visibly the 750 ms
// semantic-index status poll. Only add a type here once no caller reads
// `response.state` for it; the response type below makes that a compile error.
export const VIEW_STATE_FREE_MESSAGE_TYPES = [
  // Sent every 2 s: the popup follows view-state changes through
  // chrome.storage.onChanged instead of receiving the whole window per beat.
  "popup:heartbeat",
  "semantic-index:get-state",
  "semantic-index:build",
  "semantic-index:resume",
  "semantic-index:cancel",
  "semantic-index:clear",
  "group-manager:get-state",
  "group-manager:set-managed",
  "group-manager:preview-edit",
  "group-manager:apply-edit",
  "group-manager:preview-remove",
  "group-manager:apply-remove",
  "group-manager:undo",
  "generated-groups:get-cleanup",
  "generated-groups:set-cleanup",
  "generated-groups:clear",
  "workspace:open-tab",
  "workspace:open-copies",
  "workspace:create-from-selection",
  "workspace:preview-search-edit",
  "workspace:apply-search-edit",
  "workspace:undo-search-edit",
  "workspace:window-diff",
  "workspace:window-save",
  "workspace:window-unlink",
  "workspace:update-metadata",
  "workspace:delete",
  "workspace:recover-interrupted",
  "workspace:window-close",
  "workspace:window-focus",
  "workspace:trash-restore",
  "workspace:trash-purge",
  "workspace:revision-restore",
  "auto-filing:get-state",
  "auto-filing:undo",
  "auto-filing:never-file",
  "auto-filing:accept-suggestion",
  "auto-filing:dismiss-suggestion",
] as const satisfies readonly WindowCaptureMessage["type"][];

export type ViewStateFreeMessageType = (typeof VIEW_STATE_FREE_MESSAGE_TYPES)[number];

/** Messages whose replies always carry `state`. */
export type StatefulWindowCaptureMessage = Exclude<WindowCaptureMessage, { type: ViewStateFreeMessageType }>;

const viewStateFreeTypes: ReadonlySet<string> = new Set(VIEW_STATE_FREE_MESSAGE_TYPES);

export function replyIncludesViewState(message: Pick<WindowCaptureMessage, "type">): boolean {
  return !viewStateFreeTypes.has(message.type);
}

type WithoutViewState<Response> = Response extends unknown ? Omit<Response, "state"> : never;

/**
 * The reply shape for a message. `state` is promised only when every type the
 * message could have is outside the view-state-free list, so a caller holding a
 * broad `WindowCaptureMessage` cannot read a state that may not be there.
 */
export type WindowCaptureResponseFor<Message extends WindowCaptureMessage> =
  [Message["type"]] extends [Exclude<WindowCaptureMessage["type"], ViewStateFreeMessageType>]
    ? WindowCaptureResponse
    : WithoutViewState<WindowCaptureResponse>;
