import { describe, expect, it } from "vitest";
import { assertWindowCaptureMessage } from "../src/shared/message-validation";

describe("service-worker message validation", () => {
  it("accepts well-formed messages, with optional fields omitted or present", () => {
    for (const message of [
      { type: "window-capture:get-state" },
      { type: "popup:heartbeat", targetWindowId: 4, ownerContextId: "ctx" },
      { type: "group-manager:get-state", currentWindowId: null },
      { type: "generated-groups:set-cleanup", autoUngroupAfterDays: null },
      { type: "protection:protect-tabs", targetWindowId: 1, tabIds: [2, 3], permanence: "session" },
      { type: "workspace:restore", stashId: "s", targetWindowId: 1 },
      { type: "workspace:restore", stashId: "s", targetWindowId: 1, sourceIndexes: [0], options: {}, revisionId: "r" },
      { type: "workspace:preview-search-edit", items: [], operation: "move", targetStashId: null },
      { type: "auto-filing:undo" },
    ]) {
      expect(() => assertWindowCaptureMessage(message), message.type).not.toThrow();
    }
  });

  it("rejects unknown types and non-object messages", () => {
    expect(() => assertWindowCaptureMessage(null)).toThrow("Unknown message.");
    expect(() => assertWindowCaptureMessage({ type: "toString" })).toThrow("Unknown message.");
    expect(() => assertWindowCaptureMessage({ type: "tabs:close-everything" })).toThrow("Unknown message.");
  });

  it("rejects mistyped fields", () => {
    expect(() => assertWindowCaptureMessage({ type: "cleanup:close-suggested-tabs", targetWindowId: 1, tabIds: ["2"] }))
      .toThrow("invalid tabIds");
    expect(() => assertWindowCaptureMessage({ type: "cleanup:close-suggested-tabs", targetWindowId: "1", tabIds: [] }))
      .toThrow("invalid targetWindowId");
    expect(() => assertWindowCaptureMessage({ type: "protection:lock-groups", targetWindowId: 1, groupIds: [1], permanence: "forever" }))
      .toThrow("invalid permanence");
    expect(() => assertWindowCaptureMessage({ type: "workspace:delete" })).toThrow("invalid stashId");
    expect(() => assertWindowCaptureMessage({ type: "organization:generate", targetWindowId: 1, scope: [] }))
      .toThrow("invalid scope");
    expect(() => assertWindowCaptureMessage({ type: "workspace:open-tab", stashId: "s", sourceIndex: 1.5, targetWindowId: 1, active: true }))
      .toThrow("invalid sourceIndex");
  });
});
