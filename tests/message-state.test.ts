import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { replyIncludesViewState, VIEW_STATE_FREE_MESSAGE_TYPES } from "../src/shared/message-state";
import { applyViewStateStorageChanges } from "../src/storage/session";
import { ORGANIZATION_RUN, PROPOSAL_REVIEW, WINDOW_CAPTURE } from "../src/shared/constants";
import type { WindowCaptureViewState } from "../src/shared/types";

describe("service-worker reply view state", () => {
  it("skips the view state for the semantic-index status poll", () => {
    expect(replyIncludesViewState({ type: "semantic-index:get-state" })).toBe(false);
  });

  it("skips the view state for the 2 s heartbeat", () => {
    expect(replyIncludesViewState({ type: "popup:heartbeat" })).toBe(false);
  });

  it("keeps the view state for messages whose callers read it", () => {
    for (const type of [
      "window-capture:get-state",
      "window-capture:refresh",
      "popup:initialize",
      "organization:apply",
      "organization:undo",
      "cleanup:close-suggested-tabs",
      "protection:protect-tabs",
      "workspace:create",
      "workspace:restore",
    ] as const) {
      expect(replyIncludesViewState({ type }), type).toBe(true);
    }
  });

  it("is applied by the service worker's reply path", async () => {
    // The worker is not loadable under the unit suite, so lock the wiring statically.
    const source = await readFile(resolve("src/background/service-worker.ts"), "utf8");
    const listener = source.slice(source.indexOf("chrome.runtime.onMessage.addListener("));
    expect(listener).toContain("...await viewStateFor(message)");
    expect(listener.slice(0, listener.indexOf("\n);"))).not.toContain("state: await readWindowCaptureViewState()");
    expect(new Set(VIEW_STATE_FREE_MESSAGE_TYPES).size).toBe(VIEW_STATE_FREE_MESSAGE_TYPES.length);
  });
});

describe("view state from storage change events", () => {
  const empty: WindowCaptureViewState = { editor: null, editorLease: null, transactionRun: null, undoPoint: null };

  it("ignores events that touch no view-state key", () => {
    expect(applyViewStateStorageChanges(empty, { unrelated: { newValue: 1 } })).toBeNull();
  });

  it("applies new values and treats a removed key as null", () => {
    const lease = { ownerContextId: "a" } as unknown as WindowCaptureViewState["editorLease"];
    const withLease = applyViewStateStorageChanges(empty, {
      [PROPOSAL_REVIEW.SESSION_KEYS.editorLease]: { newValue: lease },
    });
    expect(withLease).toEqual({ ...empty, editorLease: lease });
    const cleared = applyViewStateStorageChanges(withLease!, {
      [PROPOSAL_REVIEW.SESSION_KEYS.editorLease]: { oldValue: lease },
      [ORGANIZATION_RUN.SESSION_KEYS.activeRun]: { newValue: { transactionId: "t" } },
      [WINDOW_CAPTURE.SESSION_KEYS.editor]: { newValue: { targetWindowId: 3 } },
    });
    expect(cleared).toMatchObject({ editorLease: null, transactionRun: { transactionId: "t" }, editor: { targetWindowId: 3 } });
  });
});
