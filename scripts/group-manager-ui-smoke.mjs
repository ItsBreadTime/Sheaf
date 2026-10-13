import { rm } from "node:fs/promises";
import { assert, launchExtensionContext, poll } from "./lib/harness.mjs";

// Deterministic check of the group manager drawer: real tab groups are
// created through the service worker, then the popup's Groups drawer is
// opened as a full page. Covers listing, search filtering, selection, the
// edit draft's unsaved state, and the preview round-trip. No provider or
// semantic search is configured, so the meaning button stays disabled.
const { context, extensionId, browserSession, profile } = await launchExtensionContext({
  profilePrefix: "sheaf-group-manager-",
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
    const first = await chrome.tabs.create({ windowId: win.id, url: "https://example.com/alpha-one" });
    const second = await chrome.tabs.create({ windowId: win.id, url: "https://example.org/alpha-two" });
    const lone = await chrome.tabs.create({ windowId: win.id, url: "https://example.net/lone-tab" });
    const groupId = await chrome.tabs.group({ tabIds: [first.id, second.id] });
    await chrome.tabGroups.update(groupId, { title: "Alpha research", color: "blue" });
    // A tab is protected until its URL commits, and a browser can hold the
    // first navigations (Helium's bundled uBlock Origin does until its filters
    // are ready), so wait for the URLs before the editor reads the group.
    const ids = [first.id, second.id, lone.id];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
      if (tabs.every((tab) => tab.url?.startsWith("https://"))) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    await chrome.tabs.create({ windowId: win.id, url: chrome.runtime.getURL("action.html") });
  });
  await pageOpened;
  const action = await poll(
    () => context.pages().find((page) => page.url().startsWith(`chrome-extension://${extensionId}/action.html`)) ?? null,
    (page) => page !== null,
    "the opened action page",
  );

  await action.getByRole("button", { name: "Groups", exact: true }).first().click();
  await action.locator(".group-manager").waitFor();
  await action.getByRole("heading", { name: "Open groups", exact: true }).waitFor();
  const alphaRow = action.locator(".group-manager__row").filter({ hasText: "Alpha research" }).first();
  await alphaRow.waitFor();
  assert(
    await action.locator(".group-manager__row--stashed").count() === 0,
    "No stashed groups should be listed in a fresh profile.",
  );

  const searchInput = action.getByPlaceholder("Search open or saved groups");
  // A drawer re-render can detach the input between a fill and its input
  // event, losing the value; retry the fill until the UI reflects it.
  await poll(
    async () => {
      await searchInput.fill("zzz-no-match");
      return action.getByText("No groups match this search", { exact: true }).isVisible().catch(() => false);
    },
    (visible) => visible,
    "the empty group search state",
  );
  await poll(
    async () => {
      await searchInput.fill("Alpha");
      return alphaRow.isVisible().catch(() => false);
    },
    (visible) => visible,
    "the Alpha group row after filtering",
  );

  // Drawer-local keystrokes rebuild only the view content, not the popup:
  // the view strip survives, and the rebuilt search input keeps focus and value.
  await action.locator(".view-strip").evaluate((nav) => { nav.dataset.smokeMarker = "kept"; });
  await searchInput.press("End");
  await searchInput.pressSequentially(" r");
  await alphaRow.waitFor();
  const afterTyping = await action.evaluate(() => ({
    navKept: document.querySelector(".view-strip")?.getAttribute("data-smoke-marker") === "kept",
    focusKey: document.activeElement?.getAttribute("data-focus-key") ?? null,
    value: document.activeElement instanceof HTMLInputElement ? document.activeElement.value : null,
  }));
  assert(afterTyping.navKept, "Typing in the group search rebuilt the whole popup instead of the drawer.");
  assert(
    afterTyping.focusKey === "group-search" && afterTyping.value === "Alpha r",
    `The group search lost focus or its value across a drawer redraw: ${JSON.stringify(afterTyping)}`,
  );

  await alphaRow.locator(".group-manager__row-main").click();
  const titleInput = action.locator('[data-focus-key="group-title"]');
  await titleInput.waitFor();
  assert(
    (await titleInput.inputValue()) === "Alpha research",
    "The group editor did not load the selected group's title.",
  );

  await poll(
    async () => {
      await titleInput.fill("Beta research");
      return action.locator(".group-manager__edit-status").filter({ hasText: "Unsaved" }).isVisible().catch(() => false);
    },
    (visible) => visible,
    "the unsaved edit status",
  );
  const review = action.getByRole("button", { name: "Review & apply", exact: true });
  assert(!(await review.isDisabled()), "Review & apply should enable once the draft changes.");
  await review.click();
  await action.getByText("Ready to apply", { exact: true }).waitFor();

  console.log("Group manager UI smoke passed.");
} finally {
  await context?.close();
  await browserSession.detach().catch(() => {});
  if (profile) await rm(profile, { recursive: true, force: true });
}
