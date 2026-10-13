// First-run setup: it opens on install, the popup's first-run card reaches it,
// one API URL field connects the organizing model, and each step's choices
// land in storage before Finish closes the tab.
import { rm } from "node:fs/promises";
import { assert, launchExtensionContext, listenEphemeral, poll, waitForNewPage } from "./lib/harness.mjs";
import { createPopupMockServer } from "./lib/popup-harness.mjs";

const mock = createPopupMockServer();
let context = null;
let profile = null;
try {
  const origin = await listenEphemeral(mock.server);
  const launched = await launchExtensionContext({ profilePrefix: "sheaf-setup-", keepSetupPage: true });
  context = launched.context;
  profile = launched.profile;
  const { extensionId, browserSession } = launched;
  await browserSession.detach();
  const setupUrl = `chrome-extension://${extensionId}/action.html?view=setup`;

  assert(launched.setupPage, "A fresh install did not open the setup page.");
  let setup = launched.setupPage;
  await setup.getByRole("heading", { name: "Connect a model", exact: true }).waitFor();
  assert(
    await setup.getByRole("button", { name: "Continue", exact: true }).isDisabled(),
    "Setup let the user continue before a model was verified.",
  );
  await setup.close();

  // The popup's first-run card leads to the same page.
  const web = await context.newPage();
  await web.goto(`${origin}/topic-a-1`, { waitUntil: "domcontentloaded" });
  const action = await context.newPage();
  await action.goto(`chrome-extension://${extensionId}/action.html`, { waitUntil: "domcontentloaded" });
  await action.getByRole("heading", { name: "Connect a model to organize", exact: true }).waitFor();
  setup = await waitForNewPage(
    context,
    setupUrl,
    () => action.getByRole("button", { name: "Set up Sheaf", exact: true }).click(),
    "the setup page opened from the popup's first-run card",
  );
  await setup.getByRole("heading", { name: "Connect a model", exact: true }).waitFor();
  assert(new URL(setup.url()).searchParams.has("window"), "Setup lost the window it was opened for.");

  // Step 1: one URL field; a base URL gets the chat route.
  await setup.evaluate(() => { chrome.permissions.request = async () => true; });
  await setup.getByLabel("API URL", { exact: true }).fill(`${origin}/v1`);
  await setup.getByText(`Sheaf will call ${origin}/v1/chat/completions`, { exact: true }).waitFor();
  // The route sits beside the URL: a custom one replaces it, and none uses the URL as typed.
  const route = setup.locator("#provider-organizer").getByLabel("API route", { exact: true });
  assert((await route.inputValue()) === "/chat/completions", "The API route did not start with the usual chat route.");
  await route.fill("/custom/complete");
  await setup.getByText(`Sheaf will call ${origin}/v1/custom/complete`, { exact: true }).waitFor();
  await route.fill("");
  await setup.getByText(`Sheaf will call ${origin}/v1`, { exact: true }).waitFor();
  await route.fill("/chat/completions");
  await setup.getByLabel("Model", { exact: true }).fill("setup-smoke-model");
  await setup.locator('[data-action-name="save-organizer-provider"]').click();
  // A verified model moves setup on by itself.
  await setup.getByRole("heading", { name: "Choose what's sent", exact: true }).waitFor();
  const provider = await setup.evaluate(async () => (await chrome.storage.local.get("organizerLocalState")).organizerLocalState.provider);
  assert(
    provider.origin === origin && provider.endpointPath === "/v1/chat/completions" && provider.model === "setup-smoke-model",
    `Setup stored the wrong connection: ${JSON.stringify(provider)}`,
  );

  // Step 2: request detail and review are saved as they change; skip-review starts on.
  const readLocal = () => setup.evaluate(async () => (await chrome.storage.local.get("organizerLocalState")).organizerLocalState);
  const reviewToggle = setup.getByRole("checkbox", { name: /^Organize without review/ });
  assert(await reviewToggle.isChecked(), "Setup did not present Organize without review as on by default.");
  await setup.getByRole("radio", { name: /^Titles \+ domains/ }).check();
  await poll(readLocal, (local) => local.privacy.level === 1, "the request detail chosen in setup to be saved");
  await setup.getByRole("checkbox", { name: /^Organize without review/ }).uncheck();
  await poll(readLocal, (local) => local.workflow.organizeWithoutReview === false, "the review choice made in setup to be saved");
  await setup.getByText("Live request preview", { exact: true }).waitFor();

  // Step 3: ready, with links to the optional features; Finish closes the tab.
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await setup.getByRole("heading", { name: "You're ready", exact: true }).waitFor();
  await setup.getByRole("link", { name: /Semantic search/ }).waitFor();
  const closed = setup.waitForEvent("close");
  await setup.getByRole("button", { name: "Finish", exact: true }).click();
  await closed;

  // Organize is available in the popup afterwards.
  await action.reload({ waitUntil: "domcontentloaded" });
  await action.getByRole("button", { name: /^Organize/ }).first().waitFor();
  assert(
    (await action.getByRole("heading", { name: "Connect a model to organize" }).count()) === 0,
    "The first-run card stayed after setup connected a model.",
  );

  console.log("Setup smoke passed: install, first-run card, URL connection, privacy choices, and finish.");
} finally {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  await new Promise((resolveClose) => mock.server.close(resolveClose));
}
