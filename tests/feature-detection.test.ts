import { describe, expect, it } from "vitest";
import {
  readSharedState,
  readSplitViewState,
} from "../src/browser/feature-detection";

describe("optional safety-property detection", () => {
  it("treats an absent shared property as unknown", () => {
    const group = {
      collapsed: false,
      color: "blue",
      id: 1,
      title: "Example",
      windowId: 2,
    } as chrome.tabGroups.TabGroup;
    expect(readSharedState(group)).toEqual({ known: false, value: null });
  });

  it("uses property presence even when the shared value is false", () => {
    const group = {
      collapsed: false,
      color: "blue",
      id: 1,
      shared: false,
      title: "Example",
      windowId: 2,
    } as chrome.tabGroups.TabGroup;
    expect(readSharedState(group)).toEqual({ known: true, value: false });
  });

  it("treats an absent splitViewId property as unknown", () => {
    expect(readSplitViewState({ id: 10 } as chrome.tabs.Tab)).toEqual({
      known: false,
      value: null,
    });
  });
});
