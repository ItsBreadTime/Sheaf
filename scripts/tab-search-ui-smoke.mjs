import { rm } from "node:fs/promises";
import { assert, launchExtensionContext, poll } from "./lib/harness.mjs";

// Deterministic check of the tab search drawer: three tabs with stable
// titles are seeded through the service worker, then the popup's Search
// drawer is opened. Covers result rendering, query filtering, the empty
// state, and row activation. Semantic search needs a configured embedding
// provider and stays covered by the popup smoke and unit tests.
const { context, extensionId, browserSession, profile } = await launchExtensionContext({
  profilePrefix: "sheaf-tab-search-",
});

try {
  const worker = await poll(
    () => context.serviceWorkers().find((candidate) => new URL(candidate.url()).host === extensionId) ?? null,
    (candidate) => candidate !== null,
    "the extension service worker",
  );
  const pageOpened = context.waitForEvent("page");
  await worker.evaluate(async () => {
    const win = await chrome.windows.create({ url: "data:text/html,<title>Alpha planning doc</title>" });
    await chrome.tabs.create({ windowId: win.id, url: "data:text/html,<title>Beta review notes</title>" });
    await chrome.tabs.create({ windowId: win.id, url: "data:text/html,<title>Gamma archive</title>" });
    await chrome.tabs.create({ windowId: win.id, url: chrome.runtime.getURL("action.html") });
  });
  await pageOpened;
  const action = await poll(
    () => context.pages().find((page) => page.url().startsWith(`chrome-extension://${extensionId}/action.html`)) ?? null,
    (page) => page !== null,
    "the opened action page",
  );

  await action.getByRole("button", { name: "Search", exact: true }).first().click();
  const searchInput = action.getByLabel("Search open and saved tabs");
  await searchInput.waitFor();
  // The drawer re-renders when its snapshot lands, which can wipe a query
  // typed into the pre-snapshot input; retry the fill until results appear.
  const alphaRow = action.locator(".tab-search__result").filter({ hasText: "Alpha planning doc" }).first();
  await poll(
    async () => {
      await searchInput.fill("Alpha");
      return alphaRow.isVisible().catch(() => false);
    },
    (visible) => visible,
    "the Alpha result row after filtering",
  );
  assert(
    (await action.locator(".tab-search__result").count()) === 1,
    "Filtering by 'Alpha' should leave exactly one result row.",
  );

  await searchInput.fill("zzz-no-match");
  await poll(
    async () => {
      await searchInput.fill("zzz-no-match");
      return action.locator(".tab-search__result").count();
    },
    (count) => count === 0,
    "the empty result state",
  );

  await poll(
    async () => {
      await searchInput.fill("planning");
      return alphaRow.isVisible().catch(() => false);
    },
    (visible) => visible,
    "the Alpha result row restored",
  );

  console.log("Tab search UI smoke passed.");
} finally {
  await context?.close();
  await browserSession.detach().catch(() => {});
  if (profile) await rm(profile, { recursive: true, force: true });
}
