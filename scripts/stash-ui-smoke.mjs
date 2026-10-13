import { rm } from "node:fs/promises";
import { assert, launchExtensionContext, poll } from "./lib/harness.mjs";

// Deterministic check of the stash drawer: a titled tab group of web tabs is created
// through the service worker, then the popup's Stashes drawer stashes it.
// Covers the create form, the saved-stash row, the tab picker, the details
// editor, linked-window autosave and versions, the trash, keep-open linking,
// quarantine of an unreadable record, and recovery of an interrupted stash.
const { context, extensionId, browserSession, profile } = await launchExtensionContext({
  profilePrefix: "sheaf-stash-",
});

try {
  const worker = await poll(
    () => context.serviceWorkers().find((candidate) => new URL(candidate.url()).host === extensionId) ?? null,
    (candidate) => candidate !== null,
    "the extension service worker",
  );
  const pageOpened = context.waitForEvent("page");
  await worker.evaluate(async () => {
    const win = await chrome.windows.create({ url: "about:blank" });
    const first = await chrome.tabs.create({ windowId: win.id, url: "https://example.com/stash-alpha" });
    const second = await chrome.tabs.create({ windowId: win.id, url: "https://example.org/stash-beta" });
    const groupId = await chrome.tabs.group({ tabIds: [first.id, second.id] });
    await chrome.tabGroups.update(groupId, { title: "Stash smoke", color: "green" });
    // The popup snapshots the window once; a tab whose address has not
    // committed yet reads as unreadable and protected, so wait for both.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const tabs = await Promise.all([first.id, second.id].map((id) => chrome.tabs.get(id)));
      if (tabs.every((tab) => tab.url && !tab.pendingUrl)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await chrome.tabs.create({ windowId: win.id, url: chrome.runtime.getURL("action.html") });
  });
  await pageOpened;
  const action = await poll(
    () => context.pages().find((page) => page.url().startsWith(`chrome-extension://${extensionId}/action.html`)) ?? null,
    (page) => page !== null,
    "the opened action page",
  );

  await action.getByRole("button", { name: "Workspaces", exact: true }).first().click();
  await action.locator(".stashes-panel").waitFor();
  await action.getByRole("heading", { name: "No saved workspaces", exact: true }).waitFor();

  // With nothing saved the form starts open, keeping the window open by default.
  assert(
    await action.getByRole("radio", { name: /^Keep the window open/ }).isChecked(),
    "Saving a workspace should default to keeping the window open.",
  );
  await action.getByRole("radio", { name: /^Close the saved tabs/ }).check();
  // The form paints before the tab snapshot lands; wait for real eligibility
  // so a later re-render cannot wipe the typed name.
  await action.locator(".stash-create__eligibility").getByText("2 tabs will close", { exact: true }).waitFor();
  const scope = action.getByLabel("What to save");
  await scope.selectOption({ label: "Stash smoke · 2 tabs" });
  const name = action.getByLabel("Workspace name");
  assert((await name.inputValue()).trim().length > 0, "The stash name should be prefilled from the scope.");
  await name.fill("Smoke stash");
  await action.getByRole("button", { name: "Save & close 2 tabs", exact: true }).click();

  const row = action.locator(".stash-item").filter({ hasText: "Smoke stash" }).first();
  await row.waitFor();
  await action.getByRole("heading", { name: "1 saved workspace", exact: true }).waitFor();
  assert((await row.locator(".stash-status").count()) === 0, "A healthy new stash should carry no status badge.");
  await row.locator(".stash-chip").getByText("Stash smoke", { exact: true }).waitFor();
  await poll(
    () => worker.evaluate(async () => (await chrome.tabs.query({})).filter((tab) => (tab.pendingUrl ?? tab.url ?? "").includes("/stash-")).length),
    (count) => count === 0,
    "the stashed tabs to close",
  );

  await row.getByRole("button", { name: "Choose tabs…", exact: true }).click();
  const picker = row.locator(".stash-restore-picker");
  await picker.waitFor();
  await picker.getByText("2 of 2 selected", { exact: true }).waitFor();
  await picker.getByRole("button", { name: "Open 2 tabs", exact: true }).waitFor();
  await picker.getByRole("button", { name: "Clear selection", exact: true }).click();
  await picker.getByText("0 of 2 selected", { exact: true }).waitFor();
  await picker.getByRole("button", { name: "Select all", exact: true }).click();
  await picker.getByText("2 of 2 selected", { exact: true }).waitFor();
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await picker.waitFor({ state: "detached" });

  await row.getByRole("button", { name: "Edit details for Smoke stash", exact: true }).click();
  const editor = row.locator(".stash-metadata-editor");
  await editor.waitFor();
  await editor.getByLabel("Name").fill("Renamed smoke stash");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  const renamed = action.locator(".stash-item").filter({ hasText: "Renamed smoke stash" }).first();
  await renamed.waitFor();
  await renamed.locator(".stash-metadata-editor").waitFor({ state: "detached" });

  // Opening links a new window to the stash. Changes there are captured as
  // they happen and saved, as one new version, when the window closes.
  await renamed.getByRole("button", { name: "Open Renamed smoke stash in a new linked window", exact: true }).click();
  const linked = await poll(
    () => worker.evaluate(async () => {
      const { workspaces, linkedWorkspaceWindows } = await chrome.storage.local.get(["workspaces", "linkedWorkspaceWindows"]);
      return { active: workspaces?.[0]?.activeWorkspaceId ?? null, windowId: linkedWorkspaceWindows?.[0]?.windowId ?? null };
    }),
    (value) => value.active !== null && value.windowId !== null,
    "the stash to open in a linked window",
  );
  await action.bringToFront();
  await renamed.getByText("Open in a window, saves when it closes", { exact: false }).waitFor();
  await worker.evaluate(
    (windowId) => chrome.tabs.create({ windowId, url: "https://example.net/stash-gamma", active: false }),
    linked.windowId,
  );
  await poll(
    () => worker.evaluate(async () =>
      (await chrome.storage.local.get("linkedWorkspaceWindows")).linkedWorkspaceWindows?.[0]?.draft?.tabs?.length ?? 0),
    (count) => count === 3,
    "the linked window's draft to include the new tab",
  );
  await worker.evaluate((windowId) => chrome.windows.remove(windowId), linked.windowId);
  const autosaved = await poll(
    () => worker.evaluate(async () => {
      const [stash] = (await chrome.storage.local.get("workspaces")).workspaces;
      const { linkedWorkspaceWindows } = await chrome.storage.local.get("linkedWorkspaceWindows");
      return { tabs: stash.tabs.length, revisions: stash.revisions.length, active: stash.activeWorkspaceId, links: linkedWorkspaceWindows.length };
    }),
    (value) => value.tabs === 3 && value.active === null && value.links === 0,
    "the closed linked window to save into its stash",
  );
  assert(autosaved.revisions === 1, `Closing the linked window should add exactly one version: ${JSON.stringify(autosaved)}`);

  await action.reload();
  await action.getByRole("button", { name: "Workspaces", exact: true }).first().click();
  const reopened = action.locator(".stash-item").filter({ hasText: "Renamed smoke stash" }).first();
  await reopened.getByText("3 tabs", { exact: false }).first().waitFor();
  await reopened.getByRole("button", { name: "Show earlier versions of Renamed smoke stash", exact: true }).click();
  const versions = reopened.locator(".stash-versions");
  await versions.waitFor();
  await versions.getByText("2 tabs · 1 group", { exact: true }).waitFor();
  await versions.getByRole("button", { name: /^Make the version from / }).click();
  await poll(
    () => worker.evaluate(async () => {
      const [stash] = (await chrome.storage.local.get("workspaces")).workspaces;
      return { tabs: stash.tabs.length, revisions: stash.revisions.length };
    }),
    (value) => value.tabs === 2 && value.revisions === 1,
    "the earlier version to become current while keeping the replaced contents",
  );

  // An interrupted close plus one unreadable record: the unreadable record is
  // set aside without hiding the rest, and the interrupted stash recovers.
  await worker.evaluate(async () => {
    const { workspaces } = await chrome.storage.local.get("workspaces");
    const interrupted = { ...workspaces[0], id: "interrupted-smoke", name: "Interrupted smoke", status: "closing_interrupted" };
    await chrome.storage.local.set({ workspaces: [interrupted, { id: "unreadable" }, ...workspaces] });
  });
  await action.reload();
  await action.getByRole("button", { name: "Workspaces", exact: true }).first().click();
  await action.getByText("1 saved workspace could not be read", { exact: true }).waitFor();
  await action.getByRole("heading", { name: "2 saved workspaces", exact: true }).waitFor();
  const interruptedRow = action.locator(".stash-item").filter({ hasText: "Interrupted smoke" }).first();
  await interruptedRow.getByText("Needs recovery", { exact: true }).waitFor();
  await interruptedRow.getByRole("button", { name: "Recover workspace", exact: true }).click();
  await interruptedRow.locator(".stash-status").waitFor({ state: "detached" });
  await interruptedRow.getByText("Recovered after an interrupted close.", { exact: true }).waitFor();
  await action.getByRole("button", { name: "Discard", exact: true }).click();
  await action.getByRole("button", { name: "Confirm discard", exact: true }).click();
  await action.locator(".stash-quarantine").waitFor({ state: "detached" });
  await interruptedRow.getByRole("button", { name: "Delete Interrupted smoke", exact: true }).click();
  await interruptedRow.getByRole("button", { name: "Confirm deletion of Interrupted smoke", exact: true }).click();
  await action.getByRole("heading", { name: "1 saved workspace", exact: true }).waitFor();

  const remaining = action.locator(".stash-item").filter({ hasText: "Renamed smoke stash" }).first();
  await remaining.getByRole("button", { name: "Delete Renamed smoke stash", exact: true }).click();
  await remaining.getByRole("button", { name: "Confirm deletion of Renamed smoke stash", exact: true }).click();
  await action.getByRole("heading", { name: "No saved workspaces", exact: true }).waitFor();

  // Deleting moves to the trash, which can restore or delete for good.
  const trash = action.locator(".stash-trash");
  await trash.locator("summary").getByText("Trash · 2", { exact: true }).click();
  await trash.getByRole("button", { name: "Restore Renamed smoke stash from the trash", exact: true }).click();
  await action.getByRole("heading", { name: "1 saved workspace", exact: true }).waitFor();
  await trash.locator("summary").getByText("Trash · 1", { exact: true }).waitFor();
  await trash.getByRole("button", { name: "Delete Interrupted smoke forever", exact: true }).click();
  await trash.getByRole("button", { name: "Confirm permanent deletion of Interrupted smoke", exact: true }).click();
  await trash.waitFor({ state: "detached" });
  assert(
    (await worker.evaluate(async () => (await chrome.storage.local.get("workspaceTrash")).workspaceTrash.length)) === 0,
    "Deleting forever should empty the stored trash.",
  );

  // Keeping a window open saves all of it and links it in place.
  await worker.evaluate(async () => {
    const [popup] = await chrome.tabs.query({ url: chrome.runtime.getURL("action.html") });
    const tab = await chrome.tabs.create({ windowId: popup.windowId, url: "https://example.com/stash-delta", active: false });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id);
      if (current.url && !current.pendingUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  await action.reload();
  await action.getByRole("button", { name: "Workspaces", exact: true }).first().click();
  await action.getByRole("button", { name: "Save this window…", exact: true }).click();
  await action.getByLabel("What to save").selectOption("window");
  await action.getByRole("radio", { name: /^Keep the window open/ }).check();
  await action.locator(".stash-create__eligibility").getByText("Saves this window and keeps it open", { exact: true }).waitFor();
  await action.getByRole("button", { name: "Save & keep window open", exact: true }).click();
  await action.getByRole("heading", { name: "2 saved workspaces", exact: true }).waitFor();
  // The window's about:blank tab and this extension page are private
  // locations: they stay open but are never written to the workspace.
  const linkedUrls = await worker.evaluate(async () =>
    (await chrome.storage.local.get("workspaces")).workspaces.find((item) => item.activeWorkspaceId)?.tabs.map((tab) => tab.url) ?? []);
  assert(
    linkedUrls.length > 0 && linkedUrls.every((url) => url.startsWith("https://")),
    `A kept-open workspace stored a private location: ${JSON.stringify(linkedUrls)}`,
  );
  const linkedInPlace = action.locator(".stash-item--open").first();
  await linkedInPlace.getByRole("button", { name: "Review changes", exact: true }).click();
  await linkedInPlace.getByText("No changes since this workspace was last saved.", { exact: true }).waitFor();
  // Closing would also close the private about:blank tab, which is never
  // saved, so Save & close asks first. It is not confirmed here: that would
  // close the window this page lives in.
  await linkedInPlace.getByRole("button", { name: "Save & close", exact: true }).click();
  await linkedInPlace.getByText("1 private tab in this window is never saved to workspaces and will close with it.", { exact: true }).waitFor();
  await linkedInPlace.getByRole("button", { name: "Save & close anyway", exact: true }).waitFor();
  await linkedInPlace.getByRole("button", { name: "Stop linking", exact: true }).click();
  await action.locator(".stash-item--open").waitFor({ state: "detached" });

  // A row shows three groups and counts the rest; the count opens them, by
  // hover or by keyboard, without moving anything below the row.
  await worker.evaluate(async () => {
    const [popup] = await chrome.tabs.query({ url: chrome.runtime.getURL("action.html") });
    const specs = [
      { title: "Alpha group", color: "blue" },
      { title: "Beta group", color: "red" },
      { title: "Gamma group", color: "green" },
      { title: "Delta group", color: "purple" },
      { title: "Epsilon group", color: "orange" },
    ];
    const tabs = [];
    for (const [index, spec] of specs.entries()) {
      const tab = await chrome.tabs.create({ windowId: popup.windowId, url: `https://example.com/overflow-${index}`, active: false });
      const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: popup.windowId } });
      await chrome.tabGroups.update(groupId, { title: spec.title, color: spec.color });
      tabs.push(tab.id);
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await Promise.all(tabs.map((id) => chrome.tabs.get(id)));
      if (current.every((tab) => tab.url && !tab.pendingUrl)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  await action.reload();
  await action.getByRole("button", { name: "Workspaces", exact: true }).first().click();
  await action.getByRole("button", { name: "Save this window…", exact: true }).click();
  await action.getByLabel("What to save").selectOption("window");
  await action.getByRole("radio", { name: /^Keep the window open/ }).check();
  await action.getByLabel("Workspace name").fill("Group overflow");
  await action.getByRole("button", { name: "Save & keep window open", exact: true }).click();

  const overflow = action.locator(".stash-item").filter({ hasText: "Group overflow" }).first();
  await overflow.getByText("5 groups", { exact: false }).first().waitFor();
  const chipLabels = overflow.locator(".stash-chip:not(.stash-chip--more) .stash-chip__label");
  assert(
    (await chipLabels.count()) === 3,
    `A row should show three group chips: ${JSON.stringify(await chipLabels.allTextContents())}`,
  );
  const moreTrigger = overflow.getByRole("button", { name: "+2 more groups", exact: true });
  await moreTrigger.waitFor();
  const morePanel = overflow.locator(".stash-more");
  assert(!(await morePanel.isVisible()), "The remaining groups should stay hidden until the count is opened.");
  await moreTrigger.hover();
  await morePanel.getByText("Delta group", { exact: true }).waitFor();
  await morePanel.getByText("Epsilon group", { exact: true }).waitFor();
  assert(
    (await morePanel.getByText("Alpha group", { exact: true }).count()) === 0,
    "The opened list should hold the rest of the groups, not the three already shown.",
  );
  assert(
    (await morePanel.getByText("1 tab", { exact: true }).count()) === 2,
    "Every opened group should carry its tab count.",
  );
  assert(await morePanel.isVisible(), "Hovering the count should open the remaining groups.");
  await moreTrigger.click();
  assert(
    (await moreTrigger.getAttribute("aria-expanded")) === "true",
    "Activating the count should pin the list open for a keyboard.",
  );
  await action.keyboard.press("Escape");
  assert(
    (await moreTrigger.getAttribute("aria-expanded")) === "false",
    "Escape should close the pinned list.",
  );

  console.log("Workspace UI smoke passed.");
} finally {
  await context?.close();
  await browserSession.detach().catch(() => {});
  if (profile) await rm(profile, { recursive: true, force: true });
}
