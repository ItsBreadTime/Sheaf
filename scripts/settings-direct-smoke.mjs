import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { assert, launchExtensionContext, listenEphemeral, waitForNewPage } from "./lib/harness.mjs";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Settings smoke target</title>");
});

let context = null;
let profile = null;
try {
  const origin = await listenEphemeral(server);

  const launched = await launchExtensionContext({
    profilePrefix: "sheaf-settings-",
    colorScheme: process.env.COLOR_SCHEME === "dark" ? "dark" : "light",
  });
  context = launched.context;
  profile = launched.profile;
  const { extensionId, browserSession } = launched;
  await browserSession.detach();

  const target = context.pages()[0];
  await target.goto(`${origin}`, { waitUntil: "domcontentloaded" });
  const action = await context.newPage();
  await action.goto(`chrome-extension://${extensionId}/action.html`, { waitUntil: "domcontentloaded" });

  // chrome.tabs.create fires the "page" event before the new tab's URL
  // commits, so a URL predicate on the event is evaluated once against
  // about:blank and never matches; poll the page list instead.
  // Every settings entry point must open the All settings page directly;
  // the popup has no settings view of its own.
  const headerPage = await waitForNewPage(
    context,
    `chrome-extension://${extensionId}/action.html?view=settings`,
    () => action.getByRole("button", { name: "Settings", exact: true }).click(),
    "the All settings page opened from the header",
  );
  await headerPage.getByRole("heading", { name: "All settings", exact: true }).waitFor();
  assert(
    (await action.locator(".utility-drawer").count()) === 0,
    "The header Settings button opened an in-popup settings view.",
  );
  await headerPage.close();

  await action.reload({ waitUntil: "domcontentloaded" });
  await action.getByRole("button", { name: "Search", exact: true }).click();
  await action.getByRole("heading", { name: "Find a tab", exact: true }).waitFor();
  const utilityPage = await waitForNewPage(
    context,
    `chrome-extension://${extensionId}/action.html?view=settings`,
    () => action.locator('[data-focus-key="utility-settings"]').click(),
    "the All settings page opened from the utility entry point",
  );
  await utilityPage.getByRole("heading", { name: "All settings", exact: true }).waitFor();
  await utilityPage.close();

  await action.reload({ waitUntil: "domcontentloaded" });
  await action.getByRole("button", { name: "Search", exact: true }).click();
  await action.getByRole("heading", { name: "Find a tab", exact: true }).waitFor();
  const semanticPage = await waitForNewPage(
    context,
    `chrome-extension://${extensionId}/action.html?view=settings`,
    () => action.getByRole("button", { name: "Set up", exact: true }).click(),
    "the All settings page opened from the semantic search setup card",
  );
  await semanticPage.getByRole("heading", { name: "All settings", exact: true }).waitFor();
  // The semantic search card deep-links to its own section.
  await semanticPage.locator('.settings-nav__link[href="#search"][aria-current="page"]').waitFor();
  assert(await semanticPage.locator("#search").isVisible(), "The semantic search card did not open Settings → Search.");

  // All settings shows one section at a time; autosaves report in the one sidebar status.
  await semanticPage.getByRole("link", { name: /^Cleanup/ }).click();
  await semanticPage.getByRole("heading", { name: "Groups Sheaf created", exact: true }).waitFor();
  const generatedRetention = semanticPage.getByLabel("Automatically ungroup generated tab groups");
  await generatedRetention.selectOption("7");
  await semanticPage.locator(".settings-save-status", { hasText: "All changes saved" }).waitFor();
  const storedGeneratedCleanup = await semanticPage.evaluate(async () => {
    const stored = await chrome.storage.local.get("generatedGroupCleanupSettings");
    return stored.generatedGroupCleanupSettings;
  });
  assert(
    storedGeneratedCleanup?.autoUngroupAfterDays === 7,
    "Generated-group retention did not persist through the background entry point.",
  );
  assert(
    await semanticPage.getByRole("button", { name: "Clear generated groups now" }).isDisabled(),
    "Manual generated-group cleanup should be disabled when no generated groups are available.",
  );
  if (process.env.SETTINGS_SCREENSHOT_PATH) {
    await semanticPage.getByRole("link", { name: /^Cleanup/ }).click();
    await semanticPage.screenshot({ path: process.env.SETTINGS_SCREENSHOT_PATH, fullPage: true });
  }

  console.log("Direct All settings smoke passed for the header, utility, and search-setup routes.");
} finally {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  await new Promise((resolveClose) => server.close(resolveClose));
}
