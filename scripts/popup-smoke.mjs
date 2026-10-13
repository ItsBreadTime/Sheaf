import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assert, launchExtensionContext, listenEphemeral, poll, projectRoot, waitForNewPage } from "./lib/harness.mjs";
import { captureFullPageFromTop, createPopupMockServer, measureContrast, waitForOrganizeOutcome } from "./lib/popup-harness.mjs";

// The provider disclosures are opened through their <summary>; it toggles, so only
// click it when the disclosure is still closed.
const providerDisclosure = (page, title) => page.locator("details.provider-settings", {
  has: page.locator(":scope > summary strong", { hasText: title }),
});
const openProviderDisclosure = async (page, title) => {
  const disclosure = providerDisclosure(page, title);
  if (!(await disclosure.evaluate((node) => node.open))) await disclosure.locator(":scope > summary").click();
};

const colorScheme = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const headless = process.env.HEADLESS !== "0";
const mock = createPopupMockServer();
const server = mock.server;
const state = mock.state;
let profile = null;
let context = null;
try {
  const origin = await listenEphemeral(server);

  const launched = await launchExtensionContext({
    profilePrefix: "sheaf-popup-",
    headless,
    testPages: ["control.html"],
  });
  context = launched.context;
  profile = launched.profile;
  const { extensionId, browserSession } = launched;
  await browserSession.detach();

  const protectedPage = context.pages()[0];
  await protectedPage.goto("chrome://settings", { waitUntil: "domcontentloaded" });
  const first = await context.newPage();
  await first.goto(`${origin}/topic-a-1`, { waitUntil: "domcontentloaded" });
  const second = await context.newPage();
  await second.goto(`${origin}/topic-b-1`, { waitUntil: "domcontentloaded" });
  const third = await context.newPage();
  await third.goto(`${origin}/topic-a-2`, { waitUntil: "domcontentloaded" });
  const fourth = await context.newPage();
  await fourth.goto(`${origin}/topic-b-2`, { waitUntil: "domcontentloaded" });
  const singleton = await context.newPage();
  await singleton.goto(`${origin}/singleton`, { waitUntil: "domcontentloaded" });
  const existingOne = await context.newPage();
  await existingOne.goto(`${origin}/existing-one`, { waitUntil: "domcontentloaded" });
  const existingTwo = await context.newPage();
  await existingTwo.goto(`${origin}/existing-two`, { waitUntil: "domcontentloaded" });
  const blank = await context.newPage();
  await blank.goto("about:blank");

  const setupWorker = await poll(
    async () => context.serviceWorkers().find(
      (candidate) => new URL(candidate.url()).host === extensionId,
    ) ?? null,
    (candidate) => candidate !== null,
    "extension service worker for mixed-state setup",
  );
  await setupWorker.evaluate(async (urls) => {
    const tabs = (await Promise.all(urls.map(async (url) => (await chrome.tabs.query({ url }))[0])))
      .flatMap((tab) => tab?.id === undefined ? [] : [tab.id]);
    if (tabs.length !== urls.length) throw new Error("The existing-group smoke tabs are unavailable.");
    const groupId = await chrome.tabs.group({ tabIds: tabs });
    await chrome.tabGroups.update(groupId, { title: "Existing group", color: "blue" });
  }, [`${origin}/existing-one`, `${origin}/existing-two`]);

  const action = await context.newPage();
  const actionPageErrors = [];
  const settingsPageErrors = [];
  action.on("pageerror", (error) => actionPageErrors.push(`${error.message}\n${error.stack ?? ""}`));
  await action.setViewportSize({ width: 420, height: 600 });
  await action.emulateMedia({ colorScheme });
  await action.goto(`chrome-extension://${extensionId}/action.html`, { waitUntil: "domcontentloaded" });
  await action.getByRole("region", { name: "This window" }).waitFor();
  async function openSettingsPage() {
    const page = await waitForNewPage(
      context,
      `chrome-extension://${extensionId}/action.html?`,
      () => action.getByRole("button", { name: "Settings", exact: true }).click(),
      "the All settings page",
    );
    page.on("pageerror", (error) => settingsPageErrors.push(error.message));
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.emulateMedia({ colorScheme });
    await page.getByRole("heading", { name: "All settings" }).waitFor();
    assert(
      (await action.evaluate(() => document.querySelector(".utility-drawer__content")?.dataset.utilityView ?? null)) !== "settings",
      "The Settings gear left an in-popup settings view open.",
    );
    await page.locator(".advanced-settings-grid").waitFor();
    assert(
      (await page.getByText("Open Search first", { exact: true }).count()) === 0 &&
        (await page.getByLabel("Auto-delete saved workspaces").count()) === 1,
      "All settings kept the retired startup-view option or lost the stash auto-delete setting.",
    );
    const advancedLayout = await page.evaluate(() => {
      const shell = document.querySelector(".action-shell");
      const grid = document.querySelector(".advanced-settings-grid");
      return {
        shellWidth: shell?.getBoundingClientRect().width,
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
      };
    });
    assert(
      (advancedLayout.shellWidth ?? 0) >= 1100 && advancedLayout.columns === 2,
      `All settings did not use the available desktop width: ${JSON.stringify(advancedLayout)}`,
    );
    const settingsUrl = new URL(page.url());
    assert(settingsUrl.searchParams.has("window"), "Settings did not preserve the originating window.");
    assert(
      (await page.getByRole("heading", { name: "Window organized" }).count()) === 0,
      "Opening All settings triggered organization automation.",
    );
    return page;
  }
  // All settings shows one section at a time; the index switches them.
  async function showSettingsSection(page, id) {
    await page.locator(`.settings-nav__link[href="#${id}"]`).click();
    await page.locator(`#${id}`).waitFor();
    await page.locator(`.settings-nav__link[href="#${id}"][aria-current="page"]`).waitFor();
  }
  async function closeSettingsPage(page, reloadAction = true) {
    const closed = page.waitForEvent("close");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await closed;
    if (reloadAction) {
      await action.bringToFront();
      await action.reload({ waitUntil: "domcontentloaded" });
    }
  }
  async function waitForSettingsAutosave(page) {
    await page.locator(".settings-autosave--saving").first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".settings-autosave--saving").length === 0);
  }
  async function openSemanticIndexManagement(page) {
    const manage = page.locator(".semantic-index-manage");
    await manage.waitFor();
    if (!(await manage.evaluate((node) => node.open))) {
      await page.getByText("Manage index", { exact: true }).click();
    }
  }
  async function openSearchUtility() {
    if (await action.getByLabel("Search open and saved tabs").count()) return;
    await action.locator("[data-search-trigger]").click();
    await action.getByRole("heading", { name: "Find a tab" }).waitFor();
  }
  const worker = await poll(
    async () => context.serviceWorkers().find((candidate) => new URL(candidate.url()).host === extensionId) ?? null,
    (candidate) => candidate !== null,
    "extension service worker",
  );
  const registeredCommands = await worker.evaluate(async () =>
    (await chrome.commands.getAll()).map((command) => command.name),
  );
  assert(
    registeredCommands.includes("organize-selected-tabs") &&
      registeredCommands.includes("protect-selected-tabs") &&
      registeredCommands.includes("undo-last-organization") &&
      registeredCommands.includes("organize-window") &&
      registeredCommands.includes("search-tabs"),
    `Keyboard commands were not registered: ${JSON.stringify(registeredCommands)}`,
  );
  await openSearchUtility();
  await action.setViewportSize({ width: 480, height: 600 });
  await action.getByRole("heading", { name: "Find a tab" }).waitFor();
  const tabSearch = action.getByLabel("Search open and saved tabs");
  assert(
    await action.getByRole("group", { name: "Open-tab scope", exact: true }).isVisible() &&
      (await action.getByRole("group", { name: "Open-tab scope", exact: true }).getAttribute("title"))?.includes("saved workspaces are always searched"),
    "Search did not explain that window scope applies only to open tabs.",
  );
  await tabSearch.fill("Topic A one");
  const directSearchRow = action.locator(".tab-search__result").filter({ hasText: "Topic A one" });
  await directSearchRow.waitFor();
  const searchScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-search-${colorScheme}.png`,
  );
  await action.screenshot({ path: searchScreenshotPath });
  const directSearchEvidence = {
    optionCount: await action.locator(".tab-search__result").count(),
    titleReasonCount: await action.locator(".tab-search__result[aria-label*=\"Matches Title\"]").count(),
    text: await action.locator(".tab-search").innerText(),
  };
  assert(
    directSearchEvidence.optionCount === 1 && directSearchEvidence.titleReasonCount === 1,
    `Direct tab search did not rank the exact title as the only match: ${JSON.stringify(directSearchEvidence)}`,
  );
  await directSearchRow.locator(".tab-search__result-main").click();
  await poll(
    () => worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url),
    (url) => url === `${origin}/topic-a-1`,
    "search result to focus its tab",
  );
  await action.bringToFront();
  await action.setViewportSize({ width: 420, height: 600 });
  await action.getByRole("button", { name: "Search", exact: true }).waitFor();
  await worker.evaluate(async ({ origin }) => {
    await chrome.storage.local.set({
      workspaces: [{
        id: "search-stash",
        name: "Saved reading",
        createdAt: Date.now(),
        status: "saved",
        scope: { mode: "window" },
        tabs: [
          { sourceTabId: 9101, sourceIndex: 0, title: "Unique stashed semantic guide", url: `${origin}/stashed-one`, groupKey: null },
          { sourceTabId: 9102, sourceIndex: 1, title: "Unselected stash companion", url: `${origin}/stashed-other`, groupKey: null },
        ],
        groups: [],
        excludedTabs: [],
        closeConflicts: [],
        restoreResult: null,
      }, {
        id: "copy-target",
        name: "Copy target",
        createdAt: Date.now(),
        status: "saved",
        scope: { mode: "window" },
        tabs: [{ sourceTabId: 9201, sourceIndex: 0, title: "Existing target tab", url: `${origin}/copy-target`, groupKey: null }],
        groups: [],
        excludedTabs: [],
        closeConflicts: [],
        restoreResult: null,
      }, {
        id: "active-target",
        name: "Active target",
        createdAt: Date.now(),
        activeWorkspaceId: "active-target-workspace",
        status: "saved",
        scope: { mode: "window" },
        tabs: [{ sourceTabId: 9301, sourceIndex: 0, title: "Linked target tab", url: `${origin}/active-target`, groupKey: null }],
        groups: [],
        excludedTabs: [],
        closeConflicts: [],
        restoreResult: null,
      }],
    });
    await chrome.storage.local.set({
      linkedWorkspaceWindows: [{
        id: "active-target-workspace",
        stashId: "active-target",
        windowId: 999999,
        mode: "tracked_tabs",
        trackedTabIds: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });
  }, { origin });
  await openSearchUtility();
  const stashSearch = action.getByLabel("Search open and saved tabs");
  await stashSearch.fill("Unique stashed semantic guide");
  await action.locator(".tab-search__section-heading").filter({ hasText: "Saved tabs · 1" }).waitFor();
  const stashSectionOrder = await action.locator(".tab-search__section-heading").allTextContents();
  assert(
    stashSectionOrder[0]?.startsWith("Saved tabs · 1") &&
      stashSectionOrder.every((heading) => !heading.startsWith("Open tabs")) &&
      await action.locator(".tab-search__result").filter({ hasText: "Unique stashed semantic guide" }).isVisible(),
    `Stashed search results were not listed, or an empty section was shown: ${JSON.stringify(stashSectionOrder)}`,
  );
  await action.locator(".tab-search__result").filter({ hasText: "Unique stashed semantic guide" }).locator(".tab-search__result-main").click();
  await poll(
    () => worker.evaluate(async ({ origin }) => (await chrome.tabs.query({ url: `${origin}/stashed-one` })).length, { origin }),
    (count) => count === 1,
    "single stashed search result to open",
  );
  const stashOpenEvidence = await worker.evaluate(async ({ origin }) => ({
    companionCount: (await chrome.tabs.query({ url: `${origin}/stashed-other` })).length,
    stashCount: ((await chrome.storage.local.get("workspaces")).workspaces ?? []).length,
  }), { origin });
  assert(
    stashOpenEvidence.companionCount === 0 && stashOpenEvidence.stashCount === 3,
    `Opening a stashed search result consumed or restored the whole stash: ${JSON.stringify(stashOpenEvidence)}`,
  );
  await action.bringToFront();
  await openSearchUtility();
  const destructiveSearch = action.getByLabel("Search open and saved tabs");
  await destructiveSearch.fill("Unique stashed semantic guide");
  await action.getByRole("button", { name: "Select saved tabs", exact: true }).click();
  await action.getByLabel("Select Unique stashed semantic guide from Saved reading").check();
  await action.locator(".tab-search__selection-more summary").click();
  await action.getByRole("button", { name: "Edit source workspaces…", exact: true }).click();
  await action.getByText("This changes saved workspaces. Open tabs and linked windows are never changed.", { exact: true }).waitFor();
  const editOperation = action.getByLabel("Change", { exact: true });
  assert(await editOperation.evaluate((node) => node === document.activeElement), "Opening stash editing did not move focus to the operation control.");
  await editOperation.press("Escape");
  await action.locator(".tab-search__edit-panel").waitFor({ state: "detached" });
  const restoredEditTrigger = action.getByRole("button", { name: "Edit source workspaces…", exact: true });
  assert(await restoredEditTrigger.evaluate((node) => node === document.activeElement), "Escape did not return focus to Edit source stashes.");
  await restoredEditTrigger.click();
  await action.getByLabel("Change", { exact: true }).selectOption({ label: "Copy into another workspace" });
  const destination = action.getByLabel("Destination", { exact: true });
  assert(
    await destination.getByRole("option", { name: "Active target · 1 tab · linked", exact: true }).isDisabled(),
    "A stash with an active linked workspace was available as an edit destination.",
  );
  await destination.selectOption({ label: "Copy target · 1 tab" });
  const embeddingRequestsBeforeCopy = state.embeddingRequestCount;
  await action.getByRole("button", { name: "Review changes", exact: true }).click();
  await action.getByText("Saved reading: 2 tabs → 2 tabs · 0 groups → 0 groups", { exact: true }).waitFor();
  await action.getByText("Copy target (destination): 1 tab → 2 tabs · 0 groups → 0 groups", { exact: true }).waitFor();
  await action.evaluate(() => {
    const original = chrome.storage.local.get.bind(chrome.storage.local);
    let fail = true;
    chrome.storage.local.get = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("Injected post-apply refresh failure");
      }
      return original(...args);
    };
  });
  await worker.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB);
    let fail = true;
    indexedDB.open = (...args) => {
      if (fail) {
        fail = false;
        throw new Error("Injected post-apply semantic reconciliation failure");
      }
      return original(...args);
    };
  });
  await action.getByRole("button", { name: "Confirm copy", exact: true }).click();
  await action.getByRole("button", { name: "Undo", exact: true }).waitFor();
  await action.getByText("Copied 1 selected tab, but the search list could not refresh. Reopen Search to reload it. Undo is still available below.", { exact: true }).waitFor({ state: "attached" });
  const copiedEvidence = await worker.evaluate(async () => {
    const stashes = (await chrome.storage.local.get("workspaces")).workspaces ?? [];
    return {
      source: stashes.find((stash) => stash.id === "search-stash")?.tabs?.map((tab) => tab.title) ?? [],
      target: stashes.find((stash) => stash.id === "copy-target")?.tabs?.map((tab) => tab.title) ?? [],
    };
  });
  assert(
    copiedEvidence.source.join("|") === "Unique stashed semantic guide|Unselected stash companion" &&
      copiedEvidence.target.join("|") === "Existing target tab|Unique stashed semantic guide",
    `Copy edit mutated its source or lost destination data: ${JSON.stringify(copiedEvidence)}`,
  );
  await action.evaluate(() => {
    const original = chrome.storage.local.get.bind(chrome.storage.local);
    let fail = true;
    chrome.storage.local.get = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("Injected post-undo refresh failure");
      }
      return original(...args);
    };
  });
  await worker.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB);
    let fail = true;
    indexedDB.open = (...args) => {
      if (fail) {
        fail = false;
        throw new Error("Injected post-undo semantic reconciliation failure");
      }
      return original(...args);
    };
  });
  await action.getByRole("button", { name: "Undo", exact: true }).click();
  await action.getByText("The workspace edit was undone, but the search list could not refresh. Reopen Search to reload it.", { exact: true }).waitFor({ state: "attached" });
  await action.waitForTimeout(250);
  const copyUndoEvidence = await worker.evaluate(async () => {
    const stashes = (await chrome.storage.local.get("workspaces")).workspaces ?? [];
    return {
      source: stashes.find((stash) => stash.id === "search-stash")?.tabs?.map((tab) => tab.title) ?? [],
      target: stashes.find((stash) => stash.id === "copy-target")?.tabs?.map((tab) => tab.title) ?? [],
    };
  });
  assert(
    copyUndoEvidence.source.join("|") === "Unique stashed semantic guide|Unselected stash companion" &&
      copyUndoEvidence.target.join("|") === "Existing target tab" &&
      state.embeddingRequestCount === embeddingRequestsBeforeCopy,
    `Copy undo or provider isolation failed: ${JSON.stringify({ copyUndoEvidence, embeddingRequestsBeforeCopy, embeddingRequestCount: state.embeddingRequestCount })}`,
  );
  await action.getByRole("button", { name: "Select saved tabs", exact: true }).click();
  await action.getByLabel("Select Unique stashed semantic guide from Saved reading").check();
  await action.locator(".tab-search__selection-more summary").click();
  await action.getByRole("button", { name: "Edit source workspaces…", exact: true }).click();
  await action.getByRole("button", { name: "Review changes", exact: true }).click();
  await action.getByText("Saved reading: 2 tabs → 1 tab · 0 groups → 0 groups", { exact: true }).waitFor();
  await action.setViewportSize({ width: 480, height: 600 });
  await action.screenshot({
    path: resolve(projectRoot, "docs", "screenshots", `google-chrome-action-search-edit-${colorScheme}.png`),
  });
  await action.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await action.getByRole("button", { name: "Undo", exact: true }).waitFor();
  const removedTitles = await worker.evaluate(async () => {
    const stashes = (await chrome.storage.local.get("workspaces")).workspaces ?? [];
    return stashes.find((stash) => stash.id === "search-stash")?.tabs?.map((tab) => tab.title) ?? [];
  });
  assert(
    removedTitles.join("|") === "Unselected stash companion",
    `Reviewed search removal changed the wrong stash tabs: ${JSON.stringify(removedTitles)}`,
  );
  await action.getByRole("button", { name: "Undo", exact: true }).click();
  await action.getByText("The workspace edit was undone and every affected workspace was restored.", { exact: true }).waitFor({ state: "attached" });
  const undoneTitles = await worker.evaluate(async () => {
    const stashes = (await chrome.storage.local.get("workspaces")).workspaces ?? [];
    return stashes.find((stash) => stash.id === "search-stash")?.tabs?.map((tab) => tab.title) ?? [];
  });
  assert(
    undoneTitles.join("|") === "Unique stashed semantic guide|Unselected stash companion",
    `Search stash undo did not restore the exact source snapshot: ${JSON.stringify(undoneTitles)}`,
  );
  await action.bringToFront();
  await openSearchUtility();
  const batchSearch = action.getByLabel("Search open and saved tabs");
  await batchSearch.fill("Unique stashed semantic guide");
  await action.getByRole("button", { name: "Select saved tabs", exact: true }).click();
  await action.getByLabel("Select Unique stashed semantic guide from Saved reading").check();
  await batchSearch.fill("Unselected stash companion");
  await action.getByLabel("Select Unselected stash companion from Saved reading").check();
  await action.getByRole("button", { name: "2 selected from 2 searches", exact: true }).waitFor();
  await batchSearch.fill("");
  await action.getByRole("button", { name: "2 selected from 2 searches", exact: true }).waitFor();
  await action.getByRole("button", { name: "Open in linked window", exact: true }).click();
  const workspaceName = action.locator(".tab-search__workspace-form input");
  await workspaceName.fill("Search smoke workspace");
  await action.getByRole("button", { name: "Create and open", exact: true }).click();
  await action.waitForTimeout(1_000);
  const workspaceCreationNotice = await action.locator(".notice").allTextContents();
  const workspaceEvidence = await poll(
    async () => ({ ...await worker.evaluate(async () => {
      const stashes = (await chrome.storage.local.get("workspaces")).workspaces ?? [];
      const workspaces = (await chrome.storage.local.get("linkedWorkspaceWindows")).linkedWorkspaceWindows ?? [];
      const source = stashes.find((stash) => stash.id === "search-stash");
      const created = stashes.find((stash) => stash.name === "Search smoke workspace");
      return {
        stashCount: stashes.length,
        sourceTitles: source?.tabs?.map((tab) => tab.title) ?? [],
        createdId: created?.id ?? null,
        createdTitles: created?.tabs?.map((tab) => tab.title) ?? [],
        provenanceKind: created?.provenance?.kind ?? null,
        activeWorkspaceId: created?.activeWorkspaceId ?? null,
        workspaces: workspaces.map((workspace) => ({ id: workspace.id, stashId: workspace.stashId, windowId: workspace.windowId })),
        openWindowIds: (await chrome.windows.getAll()).flatMap((window) => window.id === undefined ? [] : [window.id]),
      };
    }), noticeText: workspaceCreationNotice.join(" | ") }),
    (evidence) => evidence.createdId !== null && evidence.activeWorkspaceId !== null,
    "search selection linked workspace creation",
  );
  assert(
    workspaceEvidence.stashCount === 4 &&
      workspaceEvidence.sourceTitles.join("|") === "Unique stashed semantic guide|Unselected stash companion" &&
      workspaceEvidence.createdTitles.join("|") === "Unique stashed semantic guide|Unselected stash companion" &&
      workspaceEvidence.provenanceKind === "search_selection",
    `Search workspace creation mutated its source or lost selection data: ${JSON.stringify(workspaceEvidence)}`,
  );
  await worker.evaluate(async ({ origin }) => {
    const opened = await chrome.tabs.query({ url: `${origin}/stashed-one` });
    if (opened.length > 0) await chrome.tabs.remove(opened.flatMap((tab) => tab.id === undefined ? [] : [tab.id]));
    const workspaces = (await chrome.storage.local.get("linkedWorkspaceWindows")).linkedWorkspaceWindows ?? [];
    for (const workspace of workspaces) {
      try { await chrome.windows.remove(workspace.windowId); } catch { /* the linked window may already be gone */ }
    }
    await chrome.storage.local.set({ linkedWorkspaceWindows: [] });
    await chrome.storage.local.set({ workspaces: [] });
  }, { origin });
  await action.bringToFront();
  await action.reload({ waitUntil: "domcontentloaded" });
  let settingsPage = await openSettingsPage();
  const settingsSearch = settingsPage.getByLabel("Search settings");
  await settingsSearch.fill("Reasoning effort");
  await settingsPage.getByText("1 matching setting", { exact: true }).waitFor();
  const reasoningSearchResult = settingsPage.locator(".settings-search__result").filter({ hasText: "Reasoning effort" });
  await reasoningSearchResult.waitFor();
  const settingsSearchScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-settings-search-${colorScheme}.png`,
  );
  await settingsPage.screenshot({ path: settingsSearchScreenshotPath });
  assert(
    await settingsPage.locator("#connections").isVisible() &&
      await settingsPage.locator(".settings-search__result").count() === 1,
    "Settings search replaced the current section instead of presenting direct results.",
  );
  await reasoningSearchResult.click();
  assert(
    await settingsPage.getByLabel("Reasoning effort", { exact: true }).evaluate((node) => node === document.activeElement),
    "Selecting a settings search result did not focus the matching control.",
  );
  await settingsSearch.fill("setting that does not exist");
  await settingsPage.getByText("No matching settings", { exact: true }).waitFor();
  assert(
    (await settingsPage.locator(".settings-search__result").count()) === 0,
    "Settings search displayed results for a query with no matches.",
  );
  await settingsSearch.press("Escape");
  assert(
    (await settingsSearch.inputValue()) === "" &&
      await settingsPage.locator("#connections").isVisible() &&
      (await settingsPage.locator(".settings-category:visible").count()) === 1,
    "Clearing settings search did not leave exactly the current settings section shown.",
  );
  assert(
    await providerDisclosure(settingsPage, "Organizing model").locator(":scope > summary").isVisible() &&
      await settingsPage.locator(".settings-disclosure-summary button").count() === 0,
    "The organizing model did not expose a summary free of nested buttons.",
  );
  await showSettingsSection(settingsPage, "privacy");
  const pagedEvidence = await settingsPage.evaluate(() => ({
    hash: location.hash,
    visible: [...document.querySelectorAll(".settings-category")].filter((node) => !node.hidden).map((node) => node.id),
  }));
  assert(
    pagedEvidence.hash === "#privacy" &&
      pagedEvidence.visible.length === 1 && pagedEvidence.visible[0] === "privacy",
    `Settings index did not switch to exactly one section: ${JSON.stringify(pagedEvidence)}`,
  );
  await showSettingsSection(settingsPage, "search");
  assert(
    await settingsPage.locator('#search a.provider-link[data-provider-target="embedding"]').isVisible() &&
      await settingsPage.locator("#search details.provider-settings").count() === 0,
    "Search did not link to the embeddings model in Connections.",
  );
  await settingsPage.getByRole("checkbox", { name: /^Match group names/ }).uncheck();
  await waitForSettingsAutosave(settingsPage);
  await closeSettingsPage(settingsPage);
  await openSearchUtility();
  await action.locator('#tab-search-input[placeholder="Title, site, or path"]').waitFor();
  assert(
    (await action.getByLabel("Search open and saved tabs").getAttribute("placeholder")) === "Title, site, or path" &&
      (await action.getByText(/group name/i).count()) === 0,
    "Search UI still advertised group-name matching after that option was disabled.",
  );
  await action.locator('[data-focus-key="utility-organize"]').click();
  assert(
    await action.locator('[data-focus-key="utility-organize"]').evaluate((node) => node === document.activeElement),
    "Leaving Search did not keep focus on the Organize view control.",
  );
  settingsPage = await openSettingsPage();
  await showSettingsSection(settingsPage, "search");
  await settingsPage.getByRole("checkbox", { name: /^Match group names/ }).check();
  await waitForSettingsAutosave(settingsPage);
  await showSettingsSection(settingsPage, "data");
  assert(
    await settingsPage.getByRole("link", { name: /Diagnostics/ }).isVisible() &&
      (await settingsPage.getByRole("link", { name: /AI benchmark/ }).count()) === 0 &&
      (await settingsPage.getByRole("link", { name: /Regression cases/ }).count()) === 0,
    "The evaluation tools were not removed from the settings tools group.",
  );
  await showSettingsSection(settingsPage, "organize");
  // Custom instructions are the Organize section's Advanced area; it stays open across saves.
  await settingsPage.locator('#organize details[data-advanced="organize"] > summary').click();
  await settingsPage.getByLabel("Custom grouping instructions").fill(
    "Prefer stable project groups. Leave ambiguous tabs untouched.",
  );
  await settingsPage.getByLabel("Custom grouping instructions").blur();
  await settingsPage.locator("#organize .prompt-status--custom").waitFor();
  assert(
    (await settingsPage.getByLabel("Custom grouping instructions").inputValue()) ===
      "Prefer stable project groups. Leave ambiguous tabs untouched.",
    "The saved custom organizer prompt was not restored in All settings.",
  );
  await settingsPage.getByRole("button", { name: "Reset to default" }).click();
  await settingsPage.locator("#organize .prompt-status:not(.prompt-status--custom)", { hasText: "Default" }).waitFor();
  await settingsPage.locator('#organize details[data-advanced="organize"] > summary').click();
  await settingsPage.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await settingsPage.getByRole("heading", { name: "Diagnostics", exact: true }).waitFor();
  await settingsPage.getByRole("heading", { name: "Run diagnostics", exact: true }).waitFor();
  const diagnosticsNavigation = {
    url: settingsPage.url(),
    runHeadingCount: await settingsPage.getByRole("heading", { name: "Run diagnostics", exact: true }).count(),
  };
  assert(
    new URL(diagnosticsNavigation.url).searchParams.get("view") === "diagnostics" &&
      diagnosticsNavigation.runHeadingCount === 1,
    `The dedicated diagnostics page did not open in the All settings tab: ${JSON.stringify(diagnosticsNavigation)}`,
  );
  await settingsPage.getByLabel("Input $ / 1M tokens").fill("2");
  await settingsPage.getByLabel("Output $ / 1M tokens").fill("8");
  await settingsPage.getByRole("button", { name: "Save cost settings" }).click();
  await settingsPage.getByText("Diagnostic cost settings saved.").waitFor();
  await settingsPage.getByRole("button", { name: "All settings" }).click();
  await settingsPage.getByRole("heading", { name: "All settings" }).waitFor();
  await settingsPage.locator(".advanced-settings-grid").waitFor();

  await showSettingsSection(settingsPage, "connections");
  await openProviderDisclosure(settingsPage, "Organizing model");
  const organizerForm = providerDisclosure(settingsPage, "Organizing model");
  // One URL field; a base URL gets the chat route.
  await organizerForm.getByLabel("API URL", { exact: true }).fill(`${origin}/v1`);
  await organizerForm.getByText(`Sheaf will call ${origin}/v1/chat/completions`, { exact: true }).waitFor();
  await organizerForm.getByLabel("Model", { exact: true }).fill("popup-smoke-model");
  await organizerForm.locator("details.provider-advanced > summary").click();
  await organizerForm.getByLabel("Temperature").fill("0.4");
  assert(
    (await organizerForm.getByLabel("Reasoning effort").inputValue()) === "none",
    "Reasoning effort did not default to None.",
  );
  await organizerForm.getByLabel("Reasoning effort").selectOption("low");
  await organizerForm.getByLabel("Custom headers (JSON)", { exact: true }).fill('{"x-popup-smoke":"session-header"}');
  await organizerForm.getByLabel("Extra request body (JSON)", { exact: true }).fill('{"seed":42}');
  await organizerForm.getByLabel("Provider-specific reasoning (JSON)").fill('{"budget":256}');
  await settingsPage.evaluate(() => {
    chrome.permissions.request = async () => true;
  });
  await settingsPage.locator('[data-action-name="save-organizer-provider"]').click();
  await settingsPage.getByText("Organizing model saved and verified: popup-smoke-model.").waitFor();
  await openProviderDisclosure(settingsPage, "Embeddings model");
  const embeddingForm = providerDisclosure(settingsPage, "Embeddings model");
  await embeddingForm.getByLabel("API URL", { exact: true }).fill(`${origin}/v1/embeddings`);
  // Exact, because the "Model family" select's label is a legitimate superset
  // of this one and Playwright matches substrings by default.
  await embeddingForm.getByLabel("Model", { exact: true }).fill("alibaba/qwen3-embedding-8b");
  await embeddingForm.getByLabel("API key", { exact: true }).fill("embedding-session-key");
  assert(
    await settingsPage.getByRole("button", { name: "Copy organizer connection" }).count() === 0 &&
      await settingsPage.getByRole("button", { name: "Test embedding provider" }).count() === 0,
    "Removed embedding-provider actions are still present.",
  );
  const embeddingActionLayout = await settingsPage.locator('[data-action-name="save-embedding-provider"]').evaluate((button) => ({
    buttonWidth: button.getBoundingClientRect().width,
    containerWidth: button.parentElement?.getBoundingClientRect().width ?? 0,
    visibleActionCount: button.parentElement?.querySelectorAll("button").length ?? 0,
  }));
  assert(
    embeddingActionLayout.visibleActionCount === 1 &&
      embeddingActionLayout.buttonWidth < embeddingActionLayout.containerWidth / 2,
    `Embedding provider action was not reduced to one compact button: ${JSON.stringify(embeddingActionLayout)}`,
  );
  await settingsPage.locator('[data-action-name="save-embedding-provider"]').click();
  try {
    await settingsPage.getByText(/Embeddings model saved and verified: 3 dimensions/).waitFor();
  } catch (error) {
    throw new Error(`Embedding provider UI test failed. Settings text: ${await settingsPage.locator("body").innerText()}`, { cause: error });
  }
  await showSettingsSection(settingsPage, "search");
  await settingsPage.getByText("Use semantic search", { exact: true }).click();
  await settingsPage.getByText("I understand what semantic search sends", { exact: true }).click();
  await waitForSettingsAutosave(settingsPage);
  const searchProviderStorage = await settingsPage.evaluate(async () => ({
    local: (await chrome.storage.local.get("searchLocalState")).searchLocalState,
    session: await chrome.storage.session.get(["searchEmbeddingApiKey", "searchEmbeddingCustomHeaders"]),
  }));
  assert(
    searchProviderStorage.local.settings.semanticEnabled === true &&
      searchProviderStorage.local.providerTest.dimensions === 3 &&
      searchProviderStorage.local.persistentApiKey === null &&
      !JSON.stringify(searchProviderStorage.local).includes("embedding-session-key") &&
      searchProviderStorage.session.searchEmbeddingApiKey === "embedding-session-key",
    `Embedding provider storage boundaries failed: ${JSON.stringify(searchProviderStorage)}`,
  );
  await showSettingsSection(settingsPage, "privacy");
  assert(
    await settingsPage.getByRole("checkbox", { name: /^Include localhost and private networks/ }).isChecked(),
    "Localhost and private networks were not included by default.",
  );
  await showSettingsSection(settingsPage, "search");
  const readSemanticIndex = () => settingsPage.evaluate(async () => {
    const db = await new Promise((resolveOpen, rejectOpen) => {
      const request = indexedDB.open("sheaf-semantic-index", 1);
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => rejectOpen(request.error);
    });
    const readAll = (storeName) => new Promise((resolveRead, rejectRead) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolveRead(request.result);
      request.onerror = () => rejectRead(request.error);
    });
    const [metaRows, queue, mappings, embeddings] = await Promise.all([
      readAll("meta"), readAll("queue"), readAll("tabs"), readAll("embeddings"),
    ]);
    db.close();
    return { meta: metaRows[0] ?? null, queue, mappings, embeddings };
  });
  await worker.evaluate(async ({ origin }) => {
    await chrome.storage.local.set({
      workspaces: [{
        id: "semantic-search-stash",
        name: "Semantic reading",
        createdAt: Date.now(),
        status: "saved",
        scope: { mode: "window" },
        tabs: [{ sourceTabId: 9201, sourceIndex: 0, title: "Unique stashed semantic guide", url: `${origin}/semantic-stash`, groupKey: null }],
        groups: [],
        excludedTabs: [],
        closeConflicts: [],
        restoreResult: null,
      }],
    });
  }, { origin });
  await settingsPage.getByRole("button", { name: "Build index", exact: true }).click();
  await settingsPage.getByText("Semantic indexing started. Direct search remains available.", { exact: true }).waitFor();
  const unsavedDirectScope = settingsPage.getByLabel("Search in", { exact: true });
  await unsavedDirectScope.selectOption("all_windows");
  await unsavedDirectScope.focus();
  await settingsPage.waitForTimeout(900);
  assert(
    await unsavedDirectScope.inputValue() === "all_windows" && await unsavedDirectScope.evaluate((node) => document.activeElement === node),
    "Semantic progress polling replaced the settings DOM, losing focus or an unsaved control value.",
  );
  const queuedSemanticIndex = await readSemanticIndex();
  assert(
    queuedSemanticIndex.meta?.status === "building" &&
      queuedSemanticIndex.queue.length > 0 &&
      queuedSemanticIndex.mappings.some((mapping) => mapping.status === "pending") &&
      !JSON.stringify(queuedSemanticIndex).includes("embedding-session-key"),
    `Semantic work was not persisted before the network batch: ${JSON.stringify(queuedSemanticIndex)}`,
  );
  const semanticWatchdog = await poll(
    () => worker.evaluate(() => chrome.alarms.get("semantic-index-resume")),
    (alarm) => typeof alarm?.scheduledTime === "number",
    "semantic index worker-restart watchdog",
    5_000,
  );
  assert(
    typeof semanticWatchdog?.scheduledTime === "number" && semanticWatchdog.scheduledTime > Date.now(),
    `Semantic indexing did not schedule a worker-restart watchdog: ${JSON.stringify(semanticWatchdog)}`,
  );
  await settingsPage.getByRole("button", { name: "Cancel", exact: true }).click();
  await settingsPage.getByText("Indexing cancelled. Pending sanitized documents were removed; completed vectors remain cached locally.", { exact: true }).waitFor();
  const cancelledSemanticIndex = await readSemanticIndex();
  assert(
    cancelledSemanticIndex.meta?.status === "cancelled" &&
      cancelledSemanticIndex.meta.pending > 0 &&
      cancelledSemanticIndex.queue.length === 0,
    `Cancelling retained readable pending documents or lost progress counts: ${JSON.stringify(cancelledSemanticIndex)}`,
  );
  await settingsPage.getByRole("button", { name: "Refresh index", exact: true }).click();
  await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "complete",
    "completed semantic index",
    15_000,
  );
  const completedSemanticIndex = await readSemanticIndex();
  const expectedReady = completedSemanticIndex.mappings.filter((mapping) => mapping.status === "ready").length;
  assert(
    expectedReady > 0 &&
      completedSemanticIndex.meta.ready === expectedReady &&
      completedSemanticIndex.meta.pending === 0 &&
      completedSemanticIndex.queue.length === 0 &&
      completedSemanticIndex.embeddings.every((record) => {
        const magnitude = Math.sqrt(record.vector.reduce((sum, value) => sum + value * value, 0));
        return Math.abs(magnitude - 1) < 0.0001;
      }),
    `Completed semantic batches were not normalized and committed atomically: ${JSON.stringify(completedSemanticIndex)}`,
  );
  await settingsPage.getByText(`${expectedReady} indexed tabs ready`, { exact: true }).waitFor();
  const semanticIndexScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-semantic-index-${colorScheme}.png`,
  );
  await settingsPage.locator(".semantic-index-status").screenshot({ path: semanticIndexScreenshotPath });
  const semanticEditRequestsBefore = state.embeddingRequestCount;
  await worker.evaluate(async ({ origin }) => {
    const transient = await chrome.tabs.create({ url: `${origin}/semantic-edit-transient`, active: false });
    if (transient.id !== undefined) await chrome.tabs.remove(transient.id);
  }, { origin });
  const semanticEdit = await settingsPage.evaluate(async () => {
    const stash = ((await chrome.storage.local.get("workspaces")).workspaces ?? [])
      .find((candidate) => candidate.id === "semantic-search-stash");
    if (!stash) throw new Error("Semantic edit stash is unavailable.");
    const item = {
      stashId: stash.id,
      stashRevisionId: `current:${stash.updatedAt ?? stash.createdAt}`,
      stashTabId: stash.tabs[0]?.stableKey ?? `source:${stash.tabs[0]?.sourceIndex}`,
    };
    const preview = await chrome.runtime.sendMessage({
      type: "workspace:preview-search-edit",
      items: [item],
      operation: "remove",
    });
    const applied = await chrome.runtime.sendMessage({
      type: "workspace:apply-search-edit",
      items: [item],
      operation: "remove",
      targetStashId: null,
      reviewedSelectionToken: preview.stashSearchEditPreview.reviewedSelectionToken,
    });
    return { item, applied: applied.stashSearchEditApplyResult };
  });
  assert(semanticEdit.applied?.applied === true, `Semantic-indexed stash edit did not apply: ${JSON.stringify(semanticEdit)}`);
  await poll(
    readSemanticIndex,
    (snapshot) => !snapshot.mappings.some((mapping) => mapping.mappingKey === "stash:semantic-search-stash:tab:0"),
    "local-only semantic mapping removal after stash edit",
  );
  await settingsPage.waitForTimeout(2_000);
  assert(
    state.embeddingRequestCount === semanticEditRequestsBefore,
    "A reviewed stash edit started provider work after the normal reconciliation delay.",
  );
  const semanticUndo = await settingsPage.evaluate(async (transactionId) =>
    chrome.runtime.sendMessage({ type: "workspace:undo-search-edit", transactionId }), semanticEdit.applied.transactionId);
  assert(semanticUndo.stashSearchEditUndoResult?.undone === true, `Semantic stash edit undo failed: ${JSON.stringify(semanticUndo)}`);
  await poll(
    readSemanticIndex,
    (snapshot) => snapshot.mappings.some((mapping) =>
      mapping.mappingKey === "stash:semantic-search-stash:tab:0" && mapping.status === "ready"),
    "local-only semantic mapping restoration after stash undo",
  );
  await settingsPage.waitForTimeout(2_000);
  assert(
    state.embeddingRequestCount === semanticEditRequestsBefore,
    "Undoing a reviewed stash edit started provider work after the normal reconciliation delay.",
  );
  const requestsBeforeCacheRebuild = state.embeddingRequestCount;
  await openSemanticIndexManagement(settingsPage);
  await settingsPage.getByRole("button", { name: "Rebuild index", exact: true }).click();
  await settingsPage.getByText("Semantic index is already ready from cached vectors.", { exact: true }).waitFor();
  const cachedSemanticIndex = await readSemanticIndex();
  assert(
    cachedSemanticIndex.meta?.status === "complete" &&
      cachedSemanticIndex.meta.cacheHits === cachedSemanticIndex.meta.ready &&
      state.embeddingRequestCount === requestsBeforeCacheRebuild,
    `Rebuild did not reuse compatible cached vectors: ${JSON.stringify(cachedSemanticIndex)}`,
  );
  const lifecycleRequestsBeforeCreate = state.embeddingRequestCount;
  const lifecycleInputsBeforeCreate = state.embeddingDocumentInputs.length;
  const lifecycleTab = await worker.evaluate(async ({ origin, windowId }) => {
    const tab = await chrome.tabs.create({
      ...(windowId == null ? {} : { windowId }),
      url: `${origin}/lifecycle-first`,
      active: false,
    });
    if (tab.id === undefined) throw new Error("Lifecycle smoke tab has no ID.");
    await chrome.tabs.update(tab.id, { url: `${origin}/lifecycle-final` });
    return { id: tab.id, windowId: tab.windowId };
  }, { origin, windowId: cachedSemanticIndex.meta.targetWindowId });
  const lifecycleMappingKey = `window:${lifecycleTab.windowId}:tab:${lifecycleTab.id}`;
  const createdLifecycleIndex = await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "complete" &&
      snapshot.mappings.some((mapping) => mapping.mappingKey === lifecycleMappingKey && mapping.status === "ready"),
    "debounced semantic tab creation reconciliation",
    12_000,
  );
  const createdLifecycleHash = createdLifecycleIndex.mappings.find((mapping) =>
    mapping.mappingKey === lifecycleMappingKey)?.documentHash;
  await settingsPage.waitForTimeout(2_000);
  const lifecycleCreateInputs = state.embeddingDocumentInputs.slice(lifecycleInputsBeforeCreate);
  assert(
    state.embeddingRequestCount === lifecycleRequestsBeforeCreate + 1 &&
      lifecycleCreateInputs.length === 1 &&
      lifecycleCreateInputs[0].includes("/lifecycle-final") &&
      !lifecycleCreateInputs[0].includes("/lifecycle-first"),
    `Rapid create/update events did not embed only the final document: ${JSON.stringify(lifecycleCreateInputs)}`,
  );
  const lifecycleInputsAfterCreate = state.embeddingDocumentInputs.length;
  await worker.evaluate(({ tabId, origin }) => chrome.tabs.update(tabId, {
    url: `${origin}/lifecycle-updated`,
  }), { tabId: lifecycleTab.id, origin });
  await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "complete" && snapshot.mappings.some((mapping) =>
      mapping.mappingKey === lifecycleMappingKey && mapping.status === "ready" &&
      mapping.documentHash !== createdLifecycleHash),
    "settled semantic tab navigation reconciliation",
    12_000,
  );
  await settingsPage.waitForTimeout(2_000);
  const lifecycleUpdateInputs = state.embeddingDocumentInputs.slice(lifecycleInputsAfterCreate);
  assert(
    state.embeddingRequestCount === lifecycleRequestsBeforeCreate + 2 &&
      lifecycleUpdateInputs.length === 1 && lifecycleUpdateInputs[0].includes("/lifecycle-updated"),
    `A settled URL update did not embed only its changed document: ${JSON.stringify(lifecycleUpdateInputs)}`,
  );
  await worker.evaluate((tabId) => chrome.tabs.remove(tabId), lifecycleTab.id);
  await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "complete" &&
      !snapshot.mappings.some((mapping) => mapping.mappingKey === lifecycleMappingKey),
    "closed semantic tab mapping removal",
  );
  const stashInputsBeforeCreate = state.embeddingDocumentInputs.length;
  await worker.evaluate(async ({ origin }) => {
    const current = (await chrome.storage.local.get("workspaces")).workspaces ?? [];
    await chrome.storage.local.set({
      workspaces: [...current, {
        id: "semantic-lifecycle-stash",
        name: "Lifecycle stash",
        createdAt: Date.now(),
        status: "saved",
        scope: { mode: "window" },
        tabs: [{ sourceTabId: 9301, sourceIndex: 0, title: "Lifecycle stash article", url: `${origin}/lifecycle-stash`, groupKey: null }],
        groups: [],
        excludedTabs: [],
        closeConflicts: [],
        restoreResult: null,
      }],
    });
  }, { origin });
  await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "complete" &&
      snapshot.mappings.some((mapping) => mapping.mappingKey === "stash:semantic-lifecycle-stash:tab:0" && mapping.status === "ready"),
    "new stash semantic reconciliation",
    12_000,
  );
  await settingsPage.waitForTimeout(2_000);
  const stashCreateInputs = state.embeddingDocumentInputs.slice(stashInputsBeforeCreate);
  assert(
    stashCreateInputs.length === 1 && stashCreateInputs[0].includes("/lifecycle-stash"),
    `Adding one stash re-embedded unchanged documents: ${JSON.stringify(stashCreateInputs)}`,
  );
  const stashInputsBeforeDelete = state.embeddingDocumentInputs.length;
  await worker.evaluate(async () => {
    const current = (await chrome.storage.local.get("workspaces")).workspaces ?? [];
    await chrome.storage.local.set({
      workspaces: current.filter((stash) => stash.id !== "semantic-lifecycle-stash"),
    });
  });
  await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "complete" &&
      !snapshot.mappings.some((mapping) => mapping.mappingKey === "stash:semantic-lifecycle-stash:tab:0"),
    "deleted stash semantic mapping removal",
  );
  await settingsPage.waitForTimeout(2_000);
  assert(
    state.embeddingDocumentInputs.length === stashInputsBeforeDelete,
    "Deleting a stash sent an unnecessary embedding document.",
  );
  const preGcIndex = await readSemanticIndex();
  const gcNow = Date.now();
  await settingsPage.evaluate(async ({ modelKey, now }) => {
    const db = await new Promise((resolveOpen, rejectOpen) => {
      const request = indexedDB.open("sheaf-semantic-index", 1);
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => rejectOpen(request.error);
    });
    const transaction = db.transaction("embeddings", "readwrite");
    const store = transaction.objectStore("embeddings");
    for (const record of [
      { key: "smoke-obsolete-vector", modelKey: "obsolete-model", lastReferencedAt: now },
      { key: "smoke-expired-vector", modelKey, lastReferencedAt: now - 31 * 24 * 60 * 60_000 },
      { key: "smoke-retained-vector", modelKey, lastReferencedAt: now },
    ]) store.put({
      ...record,
      dimensions: 3,
      vector: Float32Array.from([1, 0, 0]),
      createdAt: record.lastReferencedAt,
    });
    await new Promise((resolveDone, rejectDone) => {
      transaction.oncomplete = resolveDone;
      transaction.onerror = () => rejectDone(transaction.error);
      transaction.onabort = () => rejectDone(transaction.error);
    });
    db.close();
    await chrome.alarms.create("semantic-index-maintenance", { when: Date.now() + 100 });
  }, { modelKey: preGcIndex.meta.modelKey, now: gcNow });
  // The durable vector cache is the contract, not expiry: cached vectors are kept
  // indefinitely by default, including inactive configurations, so the same three
  // records assert retention. The pass is driven through the message that returns its
  // own result, because a maintenance run that deletes nothing by design has no
  // database change to poll for.
  const maintenanceResult = await settingsPage.evaluate(async (indexedWindowId) => {
    // The worker validates message shapes, so the build names a window like the popup does.
    const targetWindowId = indexedWindowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
    const response = await chrome.runtime.sendMessage({ type: "semantic-index:build", targetWindowId });
    if (!response?.ok) throw new Error(response?.error ?? "Semantic maintenance pass failed.");
    return response.semanticIndexMeta;
  }, preGcIndex.meta.targetWindowId ?? null);
  assert(
    typeof maintenanceResult?.updatedAt === "number" && maintenanceResult.updatedAt >= gcNow,
    `The semantic maintenance pass did not complete: ${JSON.stringify(maintenanceResult)}`,
  );
  const garbageCollectedIndex = await readSemanticIndex();
  const survivingKeys = new Set(garbageCollectedIndex.embeddings.map((record) => record.key));
  for (const key of ["smoke-obsolete-vector", "smoke-expired-vector", "smoke-retained-vector"]) {
    assert(
      survivingKeys.has(key),
      `A maintenance pass expired the durable vector cache (${key}): ${JSON.stringify([...survivingKeys])}`,
    );
  }
  assert(
    garbageCollectedIndex.embeddings.some((record) =>
      record.key === "smoke-retained-vector" && record.modelKey === preGcIndex.meta.modelKey),
    `Semantic GC did not retain a recent compatible cache entry: ${JSON.stringify(garbageCollectedIndex.embeddings)}`,
  );
  await settingsPage.evaluate(() => chrome.alarms.create("semantic-index-maintenance", { periodInMinutes: 24 * 60 }));
  const originalSemanticScope = garbageCollectedIndex.meta.indexScope ?? "all_windows";
  const originalSemanticWindowId = garbageCollectedIndex.meta.targetWindowId ?? await settingsPage.evaluate(async () =>
    (await chrome.windows.getCurrent()).id);
  await settingsPage.evaluate(async () => {
    const stored = (await chrome.storage.local.get("searchLocalState")).searchLocalState;
    await chrome.storage.local.set({
      searchLocalState: {
        ...stored,
        settings: { ...stored.settings, semanticIndexScope: "current_window" },
      },
    });
  });
  const temporarySemanticWindowId = await worker.evaluate(async ({ origin }) => {
    const created = await chrome.windows.create({
      url: `${origin}/semantic-window-lifecycle`,
      focused: false,
      type: "normal",
    });
    if (created.id === undefined) throw new Error("Temporary semantic window has no ID.");
    return created.id;
  }, { origin });
  await settingsPage.evaluate(async (targetWindowId) => {
    const response = await chrome.runtime.sendMessage({ type: "semantic-index:build", targetWindowId });
    if (!response?.ok) throw new Error(response?.error ?? "Temporary-window semantic build failed.");
  }, temporarySemanticWindowId);
  await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "complete" &&
      snapshot.meta.targetWindowId === temporarySemanticWindowId,
    "temporary-window semantic index",
    12_000,
  );
  await worker.evaluate((windowId) => chrome.windows.remove(windowId), temporarySemanticWindowId);
  const closedWindowSemanticIndex = await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "stale" &&
      snapshot.meta.lastErrorCode === "target_window_closed" && snapshot.mappings.length === 0,
    "closed target-window semantic invalidation",
  );
  assert(
    closedWindowSemanticIndex.queue.length === 0,
    `Closing the indexed window retained semantic work: ${JSON.stringify(closedWindowSemanticIndex)}`,
  );
  await settingsPage.evaluate(async ({ targetWindowId, semanticIndexScope }) => {
    const stored = (await chrome.storage.local.get("searchLocalState")).searchLocalState;
    await chrome.storage.local.set({
      searchLocalState: {
        ...stored,
        settings: { ...stored.settings, semanticIndexScope },
      },
    });
    const response = await chrome.runtime.sendMessage({ type: "semantic-index:build", targetWindowId });
    if (!response?.ok) throw new Error(response?.error ?? "Original-window semantic rebuild failed.");
  }, { targetWindowId: originalSemanticWindowId, semanticIndexScope: originalSemanticScope });
  await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "complete" &&
      snapshot.meta.indexScope === originalSemanticScope &&
      snapshot.meta.targetWindowId === (originalSemanticScope === "current_window" ? originalSemanticWindowId : null),
    "restored original-window semantic index",
    12_000,
  );
  await action.bringToFront();
  if (await action.getByRole("button", { name: "Done", exact: true }).count()) {
    await action.getByRole("button", { name: "Done", exact: true }).click();
  }
  await openSearchUtility();
  const semanticSearch = action.getByLabel("Search open and saved tabs");
  await semanticSearch.waitFor();
  const actionSearchStorage = await action.evaluate(() => chrome.storage.local.get("searchLocalState"));
  assert(
    actionSearchStorage.searchLocalState?.settings?.semanticEnabled === true,
    `Semantic Search was not enabled before the search drawer opened: ${JSON.stringify(actionSearchStorage)}`,
  );
  const requestsBeforeStrongSearch = state.embeddingRequestCount;
  await semanticSearch.fill("Topic A one");
  await action.locator(".tab-search__result").filter({ hasText: "Topic A one" }).waitFor();
  await action.waitForTimeout(500);
  const headingsBeforeSemanticSearch = await action.locator(".tab-search__section-heading").allTextContents();
  assert(
    state.embeddingRequestCount === requestsBeforeStrongSearch &&
      await action.getByRole("button", { name: "Search by meaning" }).isEnabled() &&
      headingsBeforeSemanticSearch.length === 1 &&
      headingsBeforeSemanticSearch[0] === "Open tabs · 1",
    `A strong direct match invoked or displayed semantic search before completion: ${JSON.stringify(headingsBeforeSemanticSearch)}`,
  );
  await action.getByRole("button", { name: "Search by meaning" }).click();
  await action.getByRole("button", { name: "Searching by meaning…", exact: true }).waitFor();
  await poll(
    async () => state.embeddingRequestCount,
    (count) => count === requestsBeforeStrongSearch + 1,
    "explicit semantic query request",
  );
  await action.getByText(/related tab(s)? found/).waitFor();
  assert(
    (await action.locator(".tab-search__result").filter({ hasText: "Topic A one" }).count()) === 1,
    "A direct and semantic overlap was rendered twice.",
  );
  const requestsBeforeWeakSearch = state.embeddingRequestCount;
  const weakQuery = "remembered saved article";
  const relatedStashedRow = action.locator(".tab-search__result").filter({ hasText: "Unique stashed semantic guide" }).and(action.locator('[aria-label*="Related"]'));
  await semanticSearch.fill("slow old query");
  await poll(
    async () => state.embeddingRequestCount,
    (count) => count === requestsBeforeWeakSearch + 1,
    "delayed semantic query request",
  );
  await semanticSearch.fill(weakQuery);
  await action.getByText("Searching by meaning…", { exact: true }).last().waitFor();
  assert(state.embeddingRequestCount === requestsBeforeWeakSearch + 1, "Weak semantic search did not preserve the debounce window.");
  // The debounced query only survives if the fill outlives the drawer's
  // snapshot re-render (a wiped input cancels the in-flight query), so re-fill
  // only when the input no longer holds the query — an unconditional refill
  // every poll would keep resetting the 750 ms debounce window.
  await poll(
    async () => {
      if ((await semanticSearch.inputValue().catch(() => "")) !== weakQuery) await semanticSearch.fill(weakQuery);
      return state.embeddingRequestCount;
    },
    (count) => count >= requestsBeforeWeakSearch + 2,
    "debounced weak semantic query request",
    30_000,
  );
  await poll(
    async () => {
      if ((await semanticSearch.inputValue().catch(() => "")) !== weakQuery) await semanticSearch.fill(weakQuery);
      return relatedStashedRow.isVisible().catch(() => false);
    },
    (visible) => visible,
    "the related stashed semantic row",
    30_000,
  );
  await action.waitForTimeout(1_300);
  assert(
    await relatedStashedRow.isVisible(),
    "A cancelled older semantic response replaced the current query results.",
  );
  // Related rows join their tab's section with a "Related" tag and lead it when
  // nothing matched literally.
  const semanticHeadingOrder = await action.locator(".tab-search__section-heading").allTextContents();
  const savedSection = await action.locator(".tab-search__result").evaluateAll((rows) => rows
    .filter((row) => row.id.startsWith("tab-search-stash-"))
    .map((row) => Boolean(row.querySelector(".tab-search__related-tag"))));
  assert(
    semanticHeadingOrder.every((heading) => !heading.startsWith("Related")) &&
      semanticHeadingOrder.some((heading) => heading.startsWith("Saved tabs")) &&
      savedSection[0] === true,
    `Related results did not lead their section with a Related tag: ${JSON.stringify({ semanticHeadingOrder, savedSection })}`,
  );
  await action.screenshot({ path: searchScreenshotPath });
  const requestsBeforeDisable = state.embeddingRequestCount;
  await semanticSearch.fill("slow old query");
  await poll(
    async () => state.embeddingRequestCount,
    (count) => count === requestsBeforeDisable + 1,
    "semantic request before cross-page disable",
  );
  await worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get("searchLocalState")).searchLocalState;
    await chrome.storage.local.set({
      searchLocalState: { ...stored, settings: { ...stored.settings, semanticEnabled: false } },
    });
  });
  // The setup prompt replaces the inline "off" status once semantic search is disabled.
  await action.locator(".tab-search__setup").getByRole("button", { name: "Set up", exact: true }).waitFor();
  await semanticSearch.fill("disabled semantic request");
  await action.waitForTimeout(500);
  assert(
    state.embeddingRequestCount === requestsBeforeDisable + 1,
    "Disabling semantic search in another extension page allowed another provider request.",
  );
  await semanticSearch.fill("Topic A one");
  await worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get("searchLocalState")).searchLocalState;
    await chrome.storage.local.set({
      searchLocalState: { ...stored, settings: { ...stored.settings, semanticEnabled: true } },
    });
  });
  await action.getByRole("button", { name: "Search by meaning" }).waitFor();
  await action.waitForTimeout(1_300);
  assert(
    (await action.locator(".tab-search__result").filter({ hasText: "Topic A one" }).count()) === 1,
    "A semantic response completed after cross-page disable and replaced the current direct result.",
  );
  const requestsBeforeQueryFailure = state.embeddingRequestCount;
  await semanticSearch.fill("query failure");
  await poll(
    async () => state.embeddingRequestCount,
    (count) => count === requestsBeforeQueryFailure + 1,
    "semantic query provider failure",
  );
  await action.getByText(/^Nothing matched directly, and search by meaning failed: /).waitFor();
  await action.waitForTimeout(100);
  assert(
    actionPageErrors.length === 0,
    `Semantic query failure produced an uncaught action-page error: ${JSON.stringify(actionPageErrors)}`,
  );
  // A different query is a different question. The failure gate is scoped to the query
  // that failed, because a global block would leave the user with no related search at
  // all for 20 seconds after one transient 429 — so this attempt is the intended behavior.
  await semanticSearch.fill("another weak concept");
  await poll(
    async () => state.embeddingRequestCount,
    (count) => count === requestsBeforeQueryFailure + 2,
    "a different query to be attempted after another query failed",
  );
  // The query that failed does not go back to the provider while its cooldown runs.
  const requestsAfterRecovery = state.embeddingRequestCount;
  await semanticSearch.fill("query failure");
  await action.waitForTimeout(700);
  assert(
    state.embeddingRequestCount === requestsAfterRecovery,
    "A query that already failed reached the provider again inside its cooldown.",
  );
  await action.locator('[data-focus-key="utility-organize"]').click();
  await worker.evaluate(() => chrome.storage.local.set({ workspaces: [] }));
  await settingsPage.bringToFront();
  // The setting that governs the indexed text is the search consent, not the organizer's
  // own "Include existing group names": the two consents are deliberately separate, so
  // the organizer's promise about its requests is not silently extended to the semantic
  // index. This step therefore flips the consent that actually changes the document,
  // which is the one that must invalidate the mappings.
  await showSettingsSection(settingsPage, "search");
  await settingsPage.getByText("Index group names too", { exact: true }).click();
  await waitForSettingsAutosave(settingsPage);
  await settingsPage.getByText("Index is out of date · rebuild with the current provider and privacy settings", { exact: true }).waitFor();
  const staleSemanticIndex = await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "stale" && snapshot.mappings.length === 0,
    "semantic mapping invalidation after the indexed-text consent changed",
  );
  assert(
      staleSemanticIndex.queue.length === 0,
    `Consent changes did not invalidate mappings: ${JSON.stringify(staleSemanticIndex)}`,
  );
  // The vectors survive: they are keyed by the configuration that produced them, so an
  // inactive configuration's cache is inert rather than dangerous, and switching back
  // reuses it.
  assert(
    staleSemanticIndex.embeddings.length > 0,
    `A consent change expired the durable vector cache: ${JSON.stringify(staleSemanticIndex.embeddings.map((record) => record.key))}`,
  );
  await settingsPage.locator('#search a.provider-link[data-provider-target="embedding"]').click();
  await settingsPage.locator("#connections").waitFor();
  const embeddingConnection = providerDisclosure(settingsPage, "Embeddings model");
  const embeddingRequestControls = embeddingConnection.locator("details.provider-advanced");
  if (!(await embeddingRequestControls.evaluate((node) => node.open))) {
    await embeddingConnection.locator("details.provider-advanced > summary").click();
  }
  await embeddingConnection.getByLabel("Extra request body (JSON)", { exact: true }).fill('{"smokeTerminalFailure":true}');
  await settingsPage.locator('[data-action-name="save-embedding-provider"]').click();
  await settingsPage.getByText(/Embeddings model saved and verified: 3 dimensions/).waitFor();
  await showSettingsSection(settingsPage, "search");
  await settingsPage.getByRole("button", { name: "Refresh index", exact: true }).click();
  const terminalSemanticIndex = await poll(
    readSemanticIndex,
    (snapshot) => snapshot.meta?.status === "failed",
    "terminal semantic provider failure",
    10_000,
  );
  assert(
    terminalSemanticIndex.queue.length === 0 &&
      terminalSemanticIndex.mappings.some((mapping) => mapping.status === "failed") &&
      terminalSemanticIndex.meta.pending === 0,
    `Terminal provider failure retained readable queued documents: ${JSON.stringify(terminalSemanticIndex)}`,
  );
  await openSemanticIndexManagement(settingsPage);
  await settingsPage.getByRole("button", { name: "Clear semantic index", exact: true }).click();
  await settingsPage.getByRole("button", { name: "Confirm clear index", exact: true }).click();
  await settingsPage.getByText("Semantic index cleared. Direct search is unchanged.", { exact: true }).waitFor();
  const clearedSemanticIndex = await readSemanticIndex();
  assert(
    clearedSemanticIndex.meta === null &&
      clearedSemanticIndex.queue.length === 0 &&
      clearedSemanticIndex.mappings.length === 0 &&
      clearedSemanticIndex.embeddings.length === 0,
    `Clearing left semantic index data behind: ${JSON.stringify(clearedSemanticIndex)}`,
  );
  await showSettingsSection(settingsPage, "organize");
  const promptAdvanced = settingsPage.locator('#organize details[data-advanced="organize"]');
  await promptAdvanced.locator(":scope > summary").click();
  const promptEditorScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-organizer-prompt-${colorScheme}.png`,
  );
  await promptAdvanced.screenshot({ path: promptEditorScreenshotPath });
  await promptAdvanced.locator(":scope > summary").click();
  const advancedSettingsScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-advanced-settings-${colorScheme}.png`,
  );
  await settingsPage.evaluate(() => window.scrollTo(0, 0));
  await settingsPage.screenshot({ path: advancedSettingsScreenshotPath });
  const advancedProviderStorage = await settingsPage.evaluate(async () => ({
    local: (await chrome.storage.local.get("organizerLocalState")).organizerLocalState,
    headers: (await chrome.storage.session.get("organizerCustomHeaders")).organizerCustomHeaders,
  }));
  assert(
    advancedProviderStorage.local.provider.temperature === 0.4 &&
      advancedProviderStorage.local.provider.extraBody.seed === 42 &&
    advancedProviderStorage.local.provider.reasoningEffort === "low" &&
      advancedProviderStorage.local.provider.reasoning.budget === 256 &&
      advancedProviderStorage.local.connectionTest?.capabilities?.structuredOutput === "json_schema" &&
      !JSON.stringify(advancedProviderStorage.local).includes("session-header") &&
      advancedProviderStorage.headers["x-popup-smoke"] === "session-header",
    `Advanced provider controls did not preserve their storage boundaries: ${JSON.stringify(advancedProviderStorage)}`,
  );

  await showSettingsSection(settingsPage, "privacy");
  const livePrivacyPreview = JSON.parse(
    await settingsPage.locator(".privacy-request-preview pre").textContent(),
  );
  assert(
    livePrivacyPreview.tabs.length > 0 &&
      livePrivacyPreview.tabs.some((tab) => tab.title === "Topic A one") &&
      livePrivacyPreview.tabs.every((tab) => !("url" in tab) && !("browserTabId" in tab)),
    `The privacy preview was not built from the current sanitized window request: ${JSON.stringify(livePrivacyPreview)}`,
  );
  const privacyPreviewScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-privacy-preview-${colorScheme}.png`,
  );
  await settingsPage.locator(".privacy-request-preview").scrollIntoViewIfNeeded();
  await settingsPage.screenshot({ path: privacyPreviewScreenshotPath });

  await settingsPage.getByText("Allowlist and denylist", { exact: true }).click();
  assert(
    (await settingsPage.locator(".domain-suggestion").count()) > 0,
    "The domain editors did not suggest domains from the current window.",
  );
  assert(
    await settingsPage.getByRole("button", { name: "Add to Allowlist", exact: true }).isVisible() &&
      await settingsPage.getByRole("button", { name: "Add to Denylist", exact: true }).isVisible(),
    "Allowlist and denylist Add buttons did not have distinct accessible names.",
  );
  await settingsPage.getByLabel("Domain or wildcard for Allowlist").fill("https://Docs.Example.com/private/path");
  await settingsPage.getByLabel("Domain or wildcard for Allowlist").press("Enter");
  await settingsPage.getByText("docs.example.com", { exact: true }).waitFor();
  await settingsPage.getByLabel("Domain or wildcard for Denylist").fill("example.com");
  await settingsPage.getByLabel("Domain or wildcard for Denylist").press("Enter");
  await settingsPage.getByText("Resolve before saving:", { exact: false }).waitFor();
  await settingsPage.getByLabel("Remove example.com from Denylist").click();
  await settingsPage.getByLabel("Remove docs.example.com from Allowlist").click();
  await settingsPage.getByLabel("Domain or wildcard for Allowlist").fill("*.*.wild.example.com");
  await settingsPage.getByLabel("Domain or wildcard for Allowlist").press("Enter");
  await settingsPage.getByText("Enter a valid domain, wildcard, or URL.", { exact: true }).waitFor();
  await settingsPage.getByLabel("Domain or wildcard for Allowlist").fill("*.wild.example.com");
  await settingsPage.getByLabel("Domain or wildcard for Allowlist").press("Enter");
  await settingsPage.getByText("*.wild.example.com", { exact: true }).waitFor();
  await settingsPage.getByLabel("Domain or wildcard for Denylist").fill("docs.wild.example.com");
  await settingsPage.getByLabel("Domain or wildcard for Denylist").press("Enter");
  await settingsPage.getByText("*.wild.example.com overlaps docs.wild.example.com", { exact: false }).waitFor();
  await settingsPage.getByLabel("Remove docs.wild.example.com from Denylist").click();
  await settingsPage.getByLabel("Remove *.wild.example.com from Allowlist").click();
  await settingsPage.getByLabel("Domain or wildcard for Denylist").fill("blocked.example");
  await settingsPage.getByLabel("Domain or wildcard for Denylist").press("Enter");
  await settingsPage.getByText("blocked.example", { exact: true }).waitFor();

  await showSettingsSection(settingsPage, "cleanup");
  await settingsPage.getByText("Close inactive blank new tabs").click();
  await waitForSettingsAutosave(settingsPage);
  // Every autosave reports in the one sidebar status; sections carry none of their own.
  assert(
    (await settingsPage.locator(".settings-autosave").count()) === 1 &&
      (await settingsPage.locator(".settings-save-status").textContent()) === "All changes saved",
    "Settings showed more than the one sidebar save status.",
  );
  const backupDownloadPromise = settingsPage.waitForEvent("download");
  await showSettingsSection(settingsPage, "data");
  await settingsPage.getByRole("button", { name: "Export backup" }).click();
  const backupDownload = await backupDownloadPromise;
  const backupPath = await backupDownload.path();
  assert(backupPath, "The safe settings backup did not produce a file.");
  const backupText = await readFile(backupPath, "utf8");
  const backupJson = JSON.parse(backupText);
  assert(
    !backupText.includes("header-value") &&
      !backupText.includes("apiKey") &&
      !backupText.includes("customHeaders") &&
      !backupText.includes("extraBody") &&
      !("regressionCases" in backupJson) &&
      !("workspaces" in backupJson),
    `The default backup included secrets or opt-in sensitive collections: ${backupText}`,
  );
  backupJson.workflow.organizeWithoutReview = true;
  backupJson.workflow.organizeOnExtensionClick = true;
  await settingsPage.getByLabel("Backup file to import").setInputFiles({
    name: "settings-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backupJson)),
  });
  await settingsPage.getByText("Review import", { exact: true }).waitFor();
  await settingsPage.getByText("organize-on-click, skip-review, and auto-filing remain off", { exact: false }).waitFor();
  await settingsPage.getByRole("button", { name: "Import reviewed backup" }).click();
  await settingsPage.getByText("Backup imported. Re-enter and save the provider secret before organizing.").waitFor();
  await showSettingsSection(settingsPage, "connections");
  await openProviderDisclosure(settingsPage, "Organizing model");
  await settingsPage.locator('[data-action-name="save-organizer-provider"]').click();
  await settingsPage.getByText("Organizing model saved and verified: popup-smoke-model.").waitFor();
  await showSettingsSection(settingsPage, "organize");
  assert(
    await settingsPage.getByRole("checkbox", { name: /^Let AI choose colors for new groups/ }).isChecked(),
    "AI group colors were not kept on through the backup import.",
  );
  await closeSettingsPage(settingsPage);

  const windowsBefore = await worker.evaluate(() => chrome.windows.getAll({ populate: true }));
  await worker.evaluate(async (activeUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === activeUrl);
    if (tab?.id === undefined) throw new Error("The active topic tab is unavailable.");
    await chrome.tabs.update(tab.id, { active: true });
  }, `${origin}/topic-a-1`);
  await waitForOrganizeOutcome(
    action,
    "Review plan",
    () => action.getByRole("button", { name: "Organize current window" }).click({ timeout: 5_000 }),
    "the organize run to reach review",
    60_000,
    actionPageErrors,
  );
  assert(state.sawAiGroupColorMode, "The provider request did not freeze AI group-color mode.");
  const groupTitle = action.locator(".group-title").first();
  await groupTitle.waitFor();
  assert(await groupTitle.inputValue() === "Topic A", "The first short topic title was not shown in review.");
  assert(
    await action.locator(".group-title").nth(1).inputValue() === "Topic B",
    "The second short topic title was not shown in review.",
  );
  const topicAColor = action.getByRole("combobox", { name: "Color for Topic A" });
  const topicBColor = action.getByRole("combobox", { name: "Color for Topic B" });
  assert(
    await topicAColor.inputValue() === "orange" && await topicBColor.inputValue() === "purple",
    "The Review UI did not expose the AI-selected native colors.",
  );
  await topicAColor.selectOption("green");
  await groupTitle.fill("Focused topic");
  await groupTitle.blur();
  await action.getByText("Keep this correction for future runs?").waitFor();
  const correctionScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-remember-correction-${colorScheme}.png`,
  );
  await captureFullPageFromTop(action, correctionScreenshotPath);
  await action.getByRole("button", { name: "Remember this correction" }).click();
  await action.getByText("Correction saved as an editable rule.").waitFor();
  await groupTitle.fill("Topic A");
  await groupTitle.blur();
  await action.getByText("Keep this correction for future runs?").waitFor();
  await action.getByRole("button", { name: "Only this time" }).click();
  await action.getByText("1 inactive blank tab will close").waitFor();
  const mixedReviewText = await action.locator(".review").innerText();
  assert(
    mixedReviewText.includes("4 of 5 previously ungrouped tabs assigned") &&
      mixedReviewText.includes("7 tabs sent · 3 excluded by protection or privacy rules"),
    `The mixed grouped/ungrouped review was not disclosed correctly: ${mixedReviewText}`,
  );
  assert(
    state.sawMixedCurrentGroupMembership,
    "The live provider request did not distinguish grouped and ungrouped tabs.",
  );
  assert(
    (await action.getByText(/left ungrouped/).count()) === 0,
    "The review still describes every untouched tab as left ungrouped.",
  );
  const contrastFloor = await measureContrast(action);

  const screenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-review-popup-${colorScheme}.png`,
  );
  await mkdir(dirname(screenshotPath), { recursive: true });
  await captureFullPageFromTop(action, screenshotPath);

  const windowsAfterReview = await worker.evaluate(() => chrome.windows.getAll({ populate: true }));
  assert(
    windowsAfterReview.length === windowsBefore.length,
    "Review opened a separate window.",
  );

  await action.getByRole("button", { name: "Apply plan" }).click();
  try {
    await action.getByRole("heading", { name: "Window organized" }).waitFor({ timeout: 15_000 });
  } catch (error) {
    throw new Error(`Apply did not complete. Popup state: ${await action.locator("body").innerText()}`, {
      cause: error,
    });
  }
  await action.locator(".result-bar__copy").getByText(/· 1 blank tab closed$/).waitFor();
  await action.screenshot({ path: resolve(projectRoot, "docs", "screenshots", `google-chrome-action-result-${colorScheme}.png`) });

  const final = await worker.evaluate(async () => {
    const currentWindow = await chrome.windows.getCurrent();
    return {
      tabs: await chrome.tabs.query({ windowId: currentWindow.id }),
      groups: await chrome.tabGroups.query({ windowId: currentWindow.id }),
    };
  });
  assert(!final.tabs.some((tab) => tab.url === "about:blank"), "Inactive blank tab was not closed.");
  const topicTabs = final.tabs.filter((tab) => tab.url?.startsWith(`${origin}/topic-`));
  assert(
    JSON.stringify(topicTabs.map((tab) => new URL(tab.url).pathname)) ===
      JSON.stringify(["/topic-a-1", "/topic-a-2", "/topic-b-1", "/topic-b-2"]),
    `Interleaved topic tabs had an unexpected final order: ${JSON.stringify(topicTabs.map((tab) => tab.url))}`,
  );
  const groupsByTitle = new Map(final.groups.map((group) => [group.title, group.id]));
  const groupDetailsByTitle = new Map(final.groups.map((group) => [group.title, group]));
  assert(
    groupsByTitle.has("Topic A") && groupsByTitle.has("Topic B"),
    "Both topic groups were not created.",
  );
  assert(
    topicTabs[0]?.groupId === groupsByTitle.get("Topic A") &&
      topicTabs[1]?.groupId === groupsByTitle.get("Topic A") &&
      topicTabs[2]?.groupId === groupsByTitle.get("Topic B") &&
      topicTabs[3]?.groupId === groupsByTitle.get("Topic B"),
    "Interleaved topic tabs did not end in the expected native groups.",
  );
  assert(
    topicTabs.every((tab, index) => tab.index === index),
    `Organized groups were not packed against the left edge: ${JSON.stringify(topicTabs.map((tab) => tab.index))}`,
  );
  assert(
    groupDetailsByTitle.get("Topic A")?.collapsed === false &&
      groupDetailsByTitle.get("Topic B")?.collapsed === true,
    "Only the group containing the active tab should remain expanded.",
  );
  assert(
    groupDetailsByTitle.get("Topic A")?.color === "green" &&
      groupDetailsByTitle.get("Topic B")?.color === "purple" &&
      groupDetailsByTitle.get("Existing group")?.color === "blue",
    `AI colors or the existing-group color were not preserved: ${JSON.stringify([...groupDetailsByTitle.entries()])}`,
  );
  assert(topicTabs[0]?.active === true, "The active grouped tab was not preserved.");
  assert(
    final.tabs.find((tab) => tab.url?.startsWith("chrome://settings"))?.index === 4,
    "The unpinned protected tab was not placed after the organized group blocks.",
  );

  await worker.evaluate(async (baseUrl) => {
    const current = (await chrome.storage.local.get("workspaces")).workspaces ?? [];
    const fixture = {
      id: "group-manager-stash-fixture",
      name: "Archived workspace",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      note: "",
      revisions: [],
      activeWorkspaceId: null,
      status: "saved",
      scope: { mode: "group", groupId: 80_001 },
      tabs: [
        { sourceTabId: 80_001, sourceIndex: 0, title: "Archived brief", url: `${baseUrl}/archived-brief`, groupKey: "archived-topic-c" },
        { sourceTabId: 80_002, sourceIndex: 1, title: "Archived notes", url: `${baseUrl}/archived-notes`, groupKey: "archived-topic-c" },
      ],
      groups: [{ key: "archived-topic-c", sourceGroupId: 80_001, sourceIndex: 0, title: "Archived Topic C", color: "cyan", collapsed: true }],
      excludedTabs: [],
      closeConflicts: [],
      restoreResult: null,
    };
    await chrome.storage.local.set({ workspaces: [fixture, ...current.filter((stash) => stash.id !== fixture.id)] });
  }, origin);
  await action.getByRole("button", { name: "Groups", exact: true }).click();
  const groupManager = action.locator(".group-manager");
  // The popup is one column: while a group's editor is open the list is hidden
  // behind "Back to groups", so return to the list before picking another row.
  // The drawer shows either the list or one group's editor; list actions need the list.
  const showGroupList = async () => {
    const back = groupManager.getByRole("button", { name: "Back to groups", exact: true });
    if (await back.first().isVisible().catch(() => false)) await back.first().click();
  };
  const openGroupRow = async (row) => {
    await showGroupList();
    await row.locator(".group-manager__row-main").click();
  };
  await groupManager.getByRole("heading", { name: "Open groups", exact: true }).waitFor();
  assert(
    (await groupManager.getByRole("group", { name: "Group ownership filter" }).getByRole("button", { name: "All groups", exact: true }).getAttribute("aria-pressed")) === "true" &&
      (await groupManager.locator(".group-manager__row").filter({ hasText: "Existing group" }).count()) === 1,
    `The group manager did not show a pre-existing native group on first open: ${await groupManager.innerText()}`,
  );
  await groupManager.getByRole("heading", { name: "Saved groups", exact: true }).waitFor();
  await action.screenshot({ path: resolve(projectRoot, "docs", "screenshots", `google-chrome-action-groups-list-${colorScheme}.png`) });
  const initialGroupSections = await groupManager.evaluate((manager) => {
    const openRows = [...manager.querySelectorAll(".group-manager__row:not(.group-manager__row--stashed)")];
    const stashedHeading = manager.querySelector(".group-manager__list-heading--stashed");
    return {
      lastOpenBottom: openRows.at(-1)?.getBoundingClientRect().bottom ?? 0,
      stashedTop: stashedHeading?.getBoundingClientRect().top ?? 0,
    };
  });
  assert(
    initialGroupSections.stashedTop >= initialGroupSections.lastOpenBottom,
    `Stashed groups were not listed below open groups: ${JSON.stringify(initialGroupSections)}`,
  );
  const archivedSelection = groupManager.getByLabel("Select saved group Archived Topic C", { exact: true });
  await archivedSelection.check();
  assert(
    await archivedSelection.isChecked() &&
      await groupManager.getByRole("button", { name: "Open saved · 1", exact: true }).isVisible(),
    "Selecting a stashed group did not expose its batch open action.",
  );
  await archivedSelection.uncheck();
  await groupManager.getByRole("group", { name: "Group ownership filter" }).getByRole("button", { name: "Managed", exact: true }).click();
  const groupSearch = groupManager.getByLabel("Search groups or tabs");
  await groupSearch.click();
  await groupSearch.pressSequentially("Archived Topic C");
  assert(
    (await groupSearch.inputValue()) === "Archived Topic C" &&
      await groupSearch.evaluate((node) => node === document.activeElement),
    "Typing in the group search replaced or unfocused the search field.",
  );
  const archivedGroupRow = groupManager.locator(".group-manager__row--stashed").filter({ hasText: "Archived Topic C" });
  await archivedGroupRow.waitFor();
  assert(
    (await groupManager.locator(".group-manager__row").count()) === 1,
    "Group search did not include and isolate the matching stashed group.",
  );
  await openGroupRow(archivedGroupRow);
  await groupManager.getByRole("button", { name: "Open in this window", exact: true }).waitFor();
  await groupSearch.fill("Topic B");
  await groupManager.locator(".group-manager__row").filter({ hasText: "Topic B" }).waitFor();
  assert((await groupManager.locator(".group-manager__row").count()) === 1, "Group search did not filter the managed group list.");
  const semanticGroupSearch = groupManager.getByRole("button", { name: "Search by meaning", exact: true });
  assert(
    (await semanticGroupSearch.locator("path").first().getAttribute("d")) === "m21 21-4.35-4.35",
    "The group semantic-search action did not use the standard search icon.",
  );
  if (await semanticGroupSearch.isEnabled()) {
    await semanticGroupSearch.click();
    await poll(
      () => groupManager.locator(".group-manager__semantic-status").allTextContents(),
      (items) => items.some((item) => /related group|No related groups/.test(item)),
      "semantic group search completion",
    );
  }
  await groupSearch.fill("");
  const topicBRow = groupManager.locator(".group-manager__row").filter({ hasText: "Topic B" });
  await openGroupRow(topicBRow);
  await groupManager.getByRole("button", { name: "Protect Topic B until restart", exact: true }).waitFor();
  await groupManager.getByRole("button", { name: "Add tabs", exact: true }).click();
  const addTabsSearch = groupManager.getByLabel("Search tabs to add");
  await addTabsSearch.waitFor();
  const addTabsToolbarAlignment = await groupManager.evaluate((manager) => {
    const input = manager.querySelector(".group-manager__picker > input")?.getBoundingClientRect();
    const action = manager.querySelector(".group-manager__picker > button")?.getBoundingClientRect();
    return input && action
      ? Math.abs((input.top + input.height / 2) - (action.top + action.height / 2))
      : Number.POSITIVE_INFINITY;
  });
  assert(addTabsToolbarAlignment <= 2, `Add-tabs search and semantic action were not on one line: ${addTabsToolbarAlignment}`);
  await groupManager.getByRole("button", { name: "Done adding tabs", exact: true }).click();
  const groupManagerScreenshotPath = resolve(projectRoot, "docs", "screenshots", `google-chrome-action-groups-${colorScheme}.png`);
  const groupTitleEditor = groupManager.getByLabel("Title");
  await groupTitleEditor.fill("Topic B work");
  assert(
    await groupManager.getByRole("button", { name: "Review & apply", exact: true }).isEnabled(),
    "A title-only group edit did not enable Review & apply immediately.",
  );
  await groupManager.getByRole("button", { name: "yellow group color", exact: true }).click();
  await groupManager.getByLabel("State").selectOption("false");
  const topicARowForDraftSwitch = groupManager.locator(".group-manager__row").filter({ hasText: "Topic A" });
  await openGroupRow(topicARowForDraftSwitch);
  await openGroupRow(topicBRow);
  assert(
    (await groupManager.getByLabel("Title").inputValue()) === "Topic B work" &&
      (await groupManager.getByRole("button", { name: "yellow group color", exact: true }).getAttribute("aria-pressed")) === "true" &&
      (await groupManager.getByLabel("State").inputValue()) === "false",
    "Switching groups discarded the staged title, color, or expanded-state edit.",
  );
  await groupManager.getByText("Unsaved", { exact: true }).waitFor();
  // The drawer is one column: the editor replaces the list, so the editor heading is
  // measured here and the toolbar and rows after returning to the list.
  const editorLayout = await groupManager.evaluate((manager) => {
    // Only the visible icon buttons: the hidden list keeps its own in the DOM.
    const iconEvidence = [...manager.querySelectorAll(".group-manager__icon-button svg")]
      .filter((svg) => svg.closest(".group-manager__icon-button")?.checkVisibility())
      .map((svg) => ({
        width: svg.getBoundingClientRect().width,
        paths: [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d")),
      }));
    const editorControls = [
      manager.querySelector(".group-manager__back"),
      manager.querySelector(".group-manager__editor-heading > div:not(.group-manager__management)"),
      manager.querySelector(".group-manager__management"),
    ].filter(Boolean).map((node) => node.getBoundingClientRect());
    return {
      editorCenterSpread: Math.max(...editorControls.map((box) => box.top + box.height / 2)) -
        Math.min(...editorControls.map((box) => box.top + box.height / 2)),
      iconsValid: iconEvidence.length >= 4 && iconEvidence.every((icon) =>
        icon.width >= 16 && icon.paths.length > 0 && icon.paths.every((path) => typeof path === "string" && path.length > 0),
      ),
    };
  });
  await groupManager.getByRole("button", { name: "Back to groups", exact: true }).click();
  await topicBRow.waitFor();
  const compactGroupLayout = await groupManager.evaluate((manager) => {
    const toolbar = manager.querySelector(".group-manager__search-actions");
    const toolbarControls = [...(toolbar?.children ?? [])].map((node) => node.getBoundingClientRect());
    const center = (box) => box.top + box.height / 2;
    const rowHeights = [...manager.querySelectorAll(".group-manager__row")].map((row) => row.getBoundingClientRect().height);
    const titleWidths = [...manager.querySelectorAll(".group-manager__row-title")].map((title) => title.getBoundingClientRect().width);
    return {
      toolbarRows: new Set(toolbarControls.map((box) => Math.round(box.top))).size,
      searchActionSpread: toolbarControls.length >= 2
        ? Math.abs(center(toolbarControls[0]) - center(toolbarControls[1]))
        : Number.POSITIVE_INFINITY,
      maxRowHeight: Math.max(...rowHeights),
      minimumTitleWidth: Math.min(...titleWidths),
    };
  });
  assert(
    compactGroupLayout.toolbarRows <= 2 && compactGroupLayout.searchActionSpread <= 2 && editorLayout.editorCenterSpread <= 2 &&
      compactGroupLayout.maxRowHeight <= 48 && compactGroupLayout.minimumTitleWidth >= 96 && editorLayout.iconsValid,
    `The group manager did not keep its toolbar, editor context, and list rows compact: ${JSON.stringify({ ...compactGroupLayout, ...editorLayout })}`,
  );
  await openGroupRow(topicBRow);
  await groupManager.getByText("Unsaved", { exact: true }).waitFor();
  await action.screenshot({ path: groupManagerScreenshotPath });
  await groupManager.getByRole("button", { name: "Review & apply", exact: true }).click();
  await groupManager.getByText("Ready to apply", { exact: true }).waitFor();
  await groupManager.getByRole("button", { name: "Apply changes", exact: true }).click();
  await action.getByText("Group changes applied and verified. Undo is available in Groups.", { exact: true }).waitFor();
  const renamedGroup = await worker.evaluate(async () =>
    (await chrome.tabGroups.query({})).find((group) => group.title === "Topic B work"));
  assert(
    renamedGroup?.color === "yellow" && renamedGroup.collapsed === false,
    `The reviewed group metadata edit was not applied: ${JSON.stringify(renamedGroup)}`,
  );
  const groupSessionAfterEdit = await worker.evaluate(async () =>
    (await chrome.storage.session.get("groupManagerSession")).groupManagerSession);
  const ownershipAfterEdit = groupSessionAfterEdit?.ownership ?? [];
  assert(
    ownershipAfterEdit.some((item) => item.groupId === renamedGroup.id && item.origin === "created"),
    `The group edit lost created provenance before Undo: ${JSON.stringify({ renamedGroup, ownershipAfterEdit })}`,
  );
  assert(
    groupSessionAfterEdit?.undoPoint?.points?.[0]?.provenance?.some((item) => item.origin === "created"),
    `The group edit Undo journal omitted created provenance: ${JSON.stringify(groupSessionAfterEdit?.undoPoint)}`,
  );
  await groupManager.getByRole("button", { name: "Undo last change", exact: true }).click();
  await action.getByText("The last group change was undone.", { exact: true }).waitFor();
  const undoGroupDebug = await worker.evaluate(async () => ({
    groups: await chrome.tabGroups.query({}),
    session: (await chrome.storage.session.get("groupManagerSession")).groupManagerSession,
  }));
  assert(
    (await groupManager.locator(".group-manager__row").filter({ hasText: "Topic B" }).count()) === 1,
    `Group edit Undo did not restore a managed Topic B row: ${JSON.stringify(undoGroupDebug)} UI=${await groupManager.innerText()}`,
  );

  const topicBAfterUndo = groupManager.locator(".group-manager__row").filter({ hasText: "Topic B" });
  await openGroupRow(topicBAfterUndo);
  await groupManager.getByRole("button", { name: "Stop managing this group", exact: true }).click();
  await action.waitForTimeout(250);
  const optOutDebug = await worker.evaluate(async () => ({
    session: (await chrome.storage.session.get("groupManagerSession")).groupManagerSession,
    groups: await chrome.tabGroups.query({}),
  }));
  const optedOutRowCount = await groupManager.locator(".group-manager__row").filter({ hasText: "Topic B" }).count();
  assert(
    optedOutRowCount === 0,
    `Created-group management opt-out was not reflected: ${JSON.stringify(optOutDebug)} UI=${await groupManager.innerText()}`,
  );
  await groupManager.getByRole("group", { name: "Group ownership filter" }).getByRole("button", { name: "All groups", exact: true }).click();
  const optedOutTopicB = groupManager.locator(".group-manager__row").filter({ hasText: "Topic B" });
  await openGroupRow(optedOutTopicB);
  await groupManager.getByRole("button", { name: "Manage this group", exact: true }).click();
  // The opt-in finishes asynchronously and redraws the drawer; wait for it before leaving the editor.
  await groupManager.getByRole("button", { name: "Stop managing this group", exact: true }).waitFor();
  await groupManager.getByRole("group", { name: "Group ownership filter" }).getByRole("button", { name: "Managed", exact: true }).click();

  const restoredTopicBRow = groupManager.locator(".group-manager__row").filter({ hasText: "Topic B" });
  await showGroupList();
  await restoredTopicBRow.locator('input[type="checkbox"]').check();
  await groupManager.getByRole("button", { name: "Ungroup…", exact: true }).click();
  await groupManager.getByText("Ungroup review", { exact: true }).waitFor();
  await groupManager.getByRole("button", { name: "Confirm ungroup", exact: true }).click();
  await action.getByText(/group ungrouped; 2 tabs remain open/).waitFor();
  const ungroupedTopicB = await worker.evaluate(async (urlPrefix) =>
    (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith(urlPrefix) && ["/topic-b-1", "/topic-b-2"].includes(new URL(tab.url).pathname)), origin);
  assert(ungroupedTopicB.every((tab) => tab.groupId === -1), "Ungroup kept Topic B tabs inside a native group.");
  await groupManager.getByRole("button", { name: "Undo last change", exact: true }).click();
  await action.getByText("The last group change was undone.", { exact: true }).waitFor();

  const temporaryCloseGroup = await worker.evaluate(async (baseUrl) => {
    const currentWindow = await chrome.windows.getCurrent();
    const first = await chrome.tabs.create({ windowId: currentWindow.id, url: `${baseUrl}/close-one`, active: false });
    const second = await chrome.tabs.create({ windowId: currentWindow.id, url: `${baseUrl}/close-two`, active: false });
    const groupId = await chrome.tabs.group({ tabIds: [first.id, second.id], createProperties: { windowId: currentWindow.id } });
    await chrome.tabGroups.update(groupId, { title: "Close me", color: "orange", collapsed: true });
    return { groupId, tabIds: [first.id, second.id] };
  }, origin);
  await action.locator('[data-focus-key="utility-organize"]').click();
  await action.getByRole("button", { name: "Groups", exact: true }).click();
  await groupManager.getByRole("heading", { name: "Open groups", exact: true }).waitFor();
  await groupManager.getByRole("group", { name: "Group ownership filter" }).getByRole("button", { name: "All groups", exact: true }).click();
  const closeMeRow = groupManager.locator(".group-manager__row").filter({ hasText: "Close me" });
  await openGroupRow(closeMeRow);
  await groupManager.getByRole("button", { name: "Manage this group", exact: true }).click();
  await groupManager.getByRole("button", { name: "Stop managing this group", exact: true }).waitFor();
  await showGroupList();
  await closeMeRow.locator('input[type="checkbox"]').check();
  await groupManager.getByRole("button", { name: "Close tabs…", exact: true }).click();
  await groupManager.getByText("Recovery review", { exact: true }).waitFor();
  await groupManager.getByText("A verified local recovery workspace will be created before any tab closes.", { exact: true }).waitFor();
  await groupManager.getByRole("button", { name: "Keep groups", exact: true }).click();
  await groupManager.getByText("Recovery review", { exact: true }).waitFor({ state: "detached" });
  await groupManager.getByRole("button", { name: "Close tabs…", exact: true }).click();
  await groupManager.getByText("Recovery review", { exact: true }).waitFor();
  await groupManager.getByRole("button", { name: "Confirm close and save recovery", exact: true }).click();
  const groupCloseNotice = await poll(
    () => action.locator(".notice").allTextContents(),
    (items) => items.length > 0,
    "group close result",
  );
  assert(
    groupCloseNotice.includes("2 tabs closed after a recovery workspace was saved."),
    `Group close failed: ${JSON.stringify(groupCloseNotice)}`,
  );
  const recovery = await worker.evaluate(async () => {
    const stashes = (await chrome.storage.local.get("workspaces")).workspaces ?? [];
    return stashes.find((stash) => stash.name.startsWith("Group cleanup"));
  });
  assert(
    recovery?.tabs.length === 2 && recovery?.groups.length === 1 && recovery?.groups[0]?.title === "Close me",
    `Group close did not persist a complete recovery stash: ${JSON.stringify(recovery)}`,
  );
  assert(
    await worker.evaluate(async (ids) => Promise.all(ids.map(async (id) => {
      try { await chrome.tabs.get(id); return false; } catch { return true; }
    })).then((items) => items.every(Boolean)), temporaryCloseGroup.tabIds),
    "Reviewed group tabs remained open after confirmed close.",
  );
  const restoreRecovery = await action.evaluate(async (stashId) => {
    const currentWindow = await chrome.windows.getCurrent();
    return chrome.runtime.sendMessage({ type: "workspace:restore", stashId, targetWindowId: currentWindow.id });
  }, recovery.id);
  assert(restoreRecovery.ok, `Recovery stash could not restore the closed group: ${JSON.stringify(restoreRecovery)}`);
  const restoredCloseGroup = await worker.evaluate(async () =>
    (await chrome.tabGroups.query({})).find((group) => group.title === "Close me"));
  assert(Boolean(restoredCloseGroup), "Recovery stash did not restore the closed group's native structure.");
  await worker.evaluate(async ({ baseUrl, stashId }) => {
    const tabs = await chrome.tabs.query({});
    const cleanupIds = tabs.flatMap((tab) => tab.id !== undefined && tab.url?.startsWith(`${baseUrl}/close-`) ? [tab.id] : []);
    if (cleanupIds.length) await chrome.tabs.remove(cleanupIds);
    const values = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({ workspaces: (values.workspaces ?? []).filter((stash) => stash.id !== stashId) });
  }, { baseUrl: origin, stashId: recovery.id });
  await action.locator('[data-focus-key="utility-organize"]').click();

  await action.getByRole("button", { name: "Undo organization" }).click();
  await action.getByRole("heading", { name: "Organization undone", exact: true }).first().waitFor({ timeout: 15_000 });
  const undone = await worker.evaluate(async () => {
    const currentWindow = await chrome.windows.getCurrent();
    return {
      tabs: await chrome.tabs.query({ windowId: currentWindow.id }),
      groups: await chrome.tabGroups.query({ windowId: currentWindow.id }),
    };
  });
  const undoneTopicTabs = undone.tabs.filter((tab) => tab.url?.startsWith(`${origin}/topic-`));
  assert(
    JSON.stringify(undoneTopicTabs.map((tab) => new URL(tab.url).pathname)) ===
      JSON.stringify(["/topic-a-1", "/topic-b-1", "/topic-a-2", "/topic-b-2"]),
    `Undo did not restore the original interleaved order: ${JSON.stringify(undoneTopicTabs.map((tab) => tab.url))}`,
  );
  assert(
    undoneTopicTabs.every((tab) => tab.groupId === -1),
    "Undo did not restore the original ungrouped membership.",
  );
  assert(
    undone.tabs.find((tab) => tab.url?.startsWith("chrome://settings"))?.index === 0,
    "Undo did not restore the protected tab's original position.",
  );
  await singleton.close();
  await existingOne.close();
  await existingTwo.close();

  const duplicate = await context.newPage();
  await duplicate.goto(`${origin}/topic-a-1#duplicate`, { waitUntil: "domcontentloaded" });
  await worker.evaluate(async (activeUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === activeUrl);
    if (tab?.id === undefined) throw new Error("The original topic tab is unavailable.");
    await chrome.tabs.update(tab.id, { active: true });
  }, `${origin}/topic-a-1`);

  settingsPage = await openSettingsPage();
  await showSettingsSection(settingsPage, "privacy");
  await settingsPage.getByText("blocked.example", { exact: true }).waitFor();
  await showSettingsSection(settingsPage, "organize");
  await settingsPage.getByText("Preferred rename").waitFor();
  await settingsPage.getByText("Approved once · not sent yet").first().waitFor();
  await showSettingsSection(settingsPage, "organize");
  await settingsPage.getByText("Organize when the extension opens").click();
  await settingsPage.getByText("Organize without review").click();
  await showSettingsSection(settingsPage, "cleanup");
  await settingsPage.getByText("Show cleanup suggestions after organizing").click();
  await waitForSettingsAutosave(settingsPage);
  await action.addInitScript(() => {
    window.__reviewHeadingSeen = false;
    document.addEventListener("DOMContentLoaded", () => {
      const detectReview = () => {
        if ([...document.querySelectorAll("h1,h2,h3")].some((node) => node.textContent === "Review plan")) {
          window.__reviewHeadingSeen = true;
        }
      };
      new MutationObserver(detectReview).observe(document.body, { childList: true, subtree: true });
      detectReview();
    });
  });
  await closeSettingsPage(settingsPage, false);
  await action.bringToFront();
  await action.reload({ waitUntil: "domcontentloaded" });
  // No re-trigger here: the background automation owns the run, and reloading
  // again would cancel a requesting job when the popup reopens.
  await waitForOrganizeOutcome(
    action,
    "Window organized",
    () => Promise.resolve(),
    "the one-click organization to finish",
  );
  assert(
    (await action.evaluate(() => window.__reviewHeadingSeen)) === false,
    "One-click organization briefly rendered the review screen.",
  );
  const automated = await worker.evaluate(async () => {
    const currentWindow = await chrome.windows.getCurrent();
    return {
      tabs: await chrome.tabs.query({ windowId: currentWindow.id }),
      groups: await chrome.tabGroups.query({ windowId: currentWindow.id }),
    };
  });
  assert(
    automated.groups.some((group) => group.title === "Topic A") &&
      automated.groups.some((group) => group.title === "Topic B"),
    "One-click organization did not apply both generated groups.",
  );
  // A real action popup resizes to its document width. This harness opens the
  // action page as a normal tab, so emulate that browser-owned resize here.
  await action.setViewportSize({ width: 480, height: 600 });
  if ((await action.getByText("Fragment-only copy").count()) === 0) {
    await action.locator('[data-focus-key="utility-cleanup"]').click();
  }
  await action.getByText("Fragment-only copy").first().waitFor({ state: "attached" });
  assert(
    await action.getByRole("heading", { name: "Window organized" }).isVisible(),
    "Opening Cleanup replaced the verified completion state with a fresh Organize action.",
  );
  await action.getByRole("button", { name: /Save & close \d+ tabs?/ }).waitFor({ state: "visible" });
  const cleanupLayout = await action.evaluate(() => ({
    shellWidth: document.querySelector(".action-shell")?.getBoundingClientRect().width,
    hasPrimaryBeside: Boolean(document.querySelector(".action-primary")),
    resultBar: Boolean(document.querySelector(".result-bar")),
    sidecarWidth: document.querySelector(".cleanup-review--sidecar")?.getBoundingClientRect().width,
    sidecarDisplay: getComputedStyle(document.querySelector(".cleanup-review--sidecar")).display,
    sidecarOverflow: getComputedStyle(document.querySelector(".cleanup-review--sidecar")).overflow,
    sidecarListHeight: document.querySelector(".cleanup-review--sidecar .cleanup-review__list")?.getBoundingClientRect().height,
    sidecarScrollbarWidth: getComputedStyle(document.querySelector(".cleanup-review--sidecar .cleanup-review__list")).scrollbarWidth,
    listOverflowX: getComputedStyle(document.querySelector(".cleanup-review--sidecar .cleanup-review__list")).overflowX,
    actionsBottom: document.querySelector(".cleanup-review__actions")?.getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
    documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
    documentOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    bodyOverflowY: document.body.scrollHeight - document.body.clientHeight,
    headerOverflowX: (() => {
      const header = document.querySelector(".command-header");
      return header ? header.scrollWidth - header.clientWidth : null;
    })(),
  }));
  assert(
    cleanupLayout.shellWidth === 480 &&
      cleanupLayout.hasPrimaryBeside === false &&
      cleanupLayout.resultBar === true &&
      (cleanupLayout.sidecarWidth ?? 0) >= 478 &&
      cleanupLayout.sidecarDisplay === "flex" &&
      cleanupLayout.sidecarOverflow === "hidden" &&
      cleanupLayout.sidecarScrollbarWidth === "thin" &&
      cleanupLayout.listOverflowX === "hidden" &&
      (cleanupLayout.actionsBottom ?? Infinity) <= cleanupLayout.viewportHeight &&
      cleanupLayout.documentOverflowX === 0 &&
      cleanupLayout.bodyOverflowX === 0 &&
      cleanupLayout.documentOverflowY === 0 &&
      cleanupLayout.bodyOverflowY === 0 &&
      cleanupLayout.headerOverflowX === 0 &&
      (cleanupLayout.sidecarListHeight ?? 0) >= 120,
    `Cleanup review did not open as a contained single-column view with its result and Undo: ${JSON.stringify(cleanupLayout)}`,
  );
  // A single reason needs no filter: only reasons that are present get a segment.
  assert(
    (await action.locator(".cleanup-review__filters").count()) === 0 &&
      (await action.locator(".cleanup-review__item .cleanup-reason--duplicate").count()) === 1,
    "Cleanup review showed reason filters for a single reason.",
  );
  const cleanupScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-cleanup-sidecar-${colorScheme}.png`,
  );
  await action.screenshot({ path: cleanupScreenshotPath });
  const dangerContrastFloor = await measureContrast(action, [".button--danger"]);
  await action.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "cleanup-reason-contrast-probe";
    probe.style.cssText = "position:fixed;inset:0 auto auto 0;background:var(--bg);";
    ["duplicate", "clutter", "inactive"].forEach((kind) => {
      const label = document.createElement("small");
      label.className = `cleanup-reason cleanup-reason--${kind}`;
      label.textContent = kind;
      probe.append(label);
    });
    document.body.append(probe);
  });
  const reasonContrastFloor = await measureContrast(action, [
    ".cleanup-reason--duplicate",
    ".cleanup-reason--clutter",
    ".cleanup-reason--inactive",
  ]);
  const reasonColors = await action.evaluate(() =>
    ["duplicate", "clutter", "inactive"].map((kind) =>
      getComputedStyle(document.querySelector(`.cleanup-reason--${kind}`)).color,
    ),
  );
  assert(new Set(reasonColors).size === 3, "Cleanup reasons do not use three distinct colors.");
  await action.evaluate(() => document.querySelector("#cleanup-reason-contrast-probe")?.remove());
  const cleanupActionLayout = await action.locator(".cleanup-review__actions .button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right };
    }),
  );
  // Select all, Save & close, and Close share one line in that order.
  const sameRow = (a, b) => Math.round(a.top) === Math.round(b.top);
  const inOrder = (a, b) => sameRow(a, b) && a.right <= b.left;
  assert(
    cleanupActionLayout.length === 3 &&
      inOrder(cleanupActionLayout[0], cleanupActionLayout[1]) &&
      inOrder(cleanupActionLayout[1], cleanupActionLayout[2]),
    `Cleanup actions wrapped or overlapped: ${JSON.stringify(cleanupActionLayout)}`,
  );
  await action.getByRole("button", { name: "Close 1 tab", exact: true }).click();
  await action.getByRole("button", { name: "Confirm close 1" }).waitFor();
  await action.locator(".cleanup-review__warning", { hasText: "Close 1 selected tab permanently? This cannot be undone." }).waitFor();
  await action.getByRole("button", { name: "Deselect all" }).click();
  assert(
    await action.getByRole("button", { name: "Close 0 tabs", exact: true }).isDisabled() &&
      await action.getByRole("button", { name: "Select all" }).isVisible() &&
      (await action.getByRole("button", { name: "Confirm close 1" }).count()) === 0 &&
      (await action.locator(".cleanup-review__item input:checked").count()) === 0,
    "Deselect all did not clear the selection, flip to Select all, and cancel close confirmation.",
  );
  await action.reload({ waitUntil: "domcontentloaded" });
  // With cleanup suggestions pending, the reload's organize-on-open completion
  // must not steal a drawer the user opened while the run was in flight.
  await action.locator('[data-focus-key="utility-stashes"]').click();
  await action.locator(".stashes-panel .view-heading h2").waitFor();
  await action.waitForFunction(async () => {
    const stored = await chrome.storage.session.get("proposalReviewSession");
    return Boolean(stored.proposalReviewSession);
  }, undefined, { timeout: 60_000 });
  const retainedDrawer = await action.evaluate(() => ({
    view: document.querySelector(".utility-drawer__content")?.dataset.utilityView ?? null,
  }));
  assert(
    retainedDrawer.view === "stashes",
    `The organize-on-open completion switched the utility drawer away from the view the user opened: ${JSON.stringify(retainedDrawer)}`,
  );
  await action.locator('[data-focus-key="utility-cleanup"]').click();
  await action.getByRole("button", { name: "Close 1 tab", exact: true }).waitFor();
  await action.getByRole("button", { name: "Close 1 tab", exact: true }).click();
  await action.getByRole("button", { name: "Confirm close 1" }).click();
  await action.getByText("1 reviewed tab closed.").waitFor({ timeout: 15_000 });
  assert(
    (await action.locator(".utility-drawer").count()) === 0,
    "Closing the final cleanup tab did not return the popup to Organize.",
  );
  const afterCleanup = await worker.evaluate(async (pagePrefix) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => tab.url?.startsWith(pagePrefix)).map((tab) => tab.url);
  }, `${origin}/topic-a-1`);
  assert(
    afterCleanup.length === 1,
    `Manual duplicate review did not leave exactly one copy: ${JSON.stringify(afterCleanup)}`,
  );
  settingsPage = await openSettingsPage();
  await showSettingsSection(settingsPage, "organize");
  await settingsPage.getByText("Approved once · not sent yet").first().waitFor();
  await closeSettingsPage(settingsPage, false);
  await action.bringToFront();
  const storedHistory = await worker.evaluate(async () => {
    const key = "organizationHistory";
    const history = (await chrome.storage.local.get(key))[key] ?? [];
    if (history[0]) {
      const legacy = { ...history[0] };
      delete legacy.eligibleUngroupedSubmitted;
      delete legacy.newlyGrouped;
      delete legacy.remainingUngrouped;
      history[0] = legacy;
      await chrome.storage.local.set({ [key]: history });
    }
    return history;
  });
  const latestHistory = storedHistory.at(-1);
  assert(
    latestHistory &&
      Number.isInteger(latestHistory.eligibleUngroupedSubmitted) &&
      Number.isInteger(latestHistory.newlyGrouped) &&
      Number.isInteger(latestHistory.remainingUngrouped),
    `Completed history omitted exact ungrouped coverage: ${JSON.stringify(latestHistory)}`,
  );
  await action.getByRole("button", { name: "History" }).click();
  await action.getByRole("heading", { name: "Organization history" }).waitFor();
  const historyLayout = await action.evaluate(() => ({
    shellWidth: document.querySelector(".action-shell")?.getBoundingClientRect().width,
    bodyWidth: document.body.getBoundingClientRect().width,
    cleanupClass: document.body.classList.contains("cleanup-popup-open"),
    hasPrimaryBeside: Boolean(document.querySelector(".action-primary")),
    overflowX: document.body.scrollWidth - document.body.clientWidth,
  }));
  assert(
    historyLayout.shellWidth === 480 &&
      historyLayout.bodyWidth === 480 &&
      historyLayout.cleanupClass === true &&
      historyLayout.hasPrimaryBeside === false &&
      historyLayout.overflowX === 0,
    `History did not replace the organizer in the single-column popup: ${JSON.stringify(historyLayout)}`,
  );
  await action.locator(".view-strip__item").filter({ hasText: "Cleanup" }).waitFor();
  await action.locator(".view-strip__item").filter({ hasText: "Workspaces" }).waitFor();
  const viewStripLayout = await action.locator(".view-strip").evaluate((nav) => {
    const navBox = nav.getBoundingClientRect();
    const controls = [...nav.querySelectorAll("button")];
    const boxes = controls.map((control) => control.getBoundingClientRect());
    return {
      rows: new Set(boxes.map((box) => Math.round(box.top))).size,
      horizontalOverflow: nav.scrollWidth - nav.clientWidth,
      controlsInside: boxes.every((box) => box.left >= navBox.left - 1 && box.right <= navBox.right + 1),
      textFits: controls.every((control) => control.scrollWidth <= control.clientWidth),
      overlaps: boxes.some((box, index) => boxes.some((other, otherIndex) =>
        index !== otherIndex && box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
    };
  });
  assert(
    viewStripLayout.rows === 1 && viewStripLayout.horizontalOverflow <= 1 &&
      viewStripLayout.controlsInside && viewStripLayout.textFits && !viewStripLayout.overlaps,
    `The view strip was not a contained single row: ${JSON.stringify(viewStripLayout)}`,
  );
  await action.locator('[data-focus-key="utility-settings"]').hover();
  await action.locator(".stash-tab-tooltip").filter({ hasText: /^Settings$/ }).waitFor();
  for (const label of ["Organize", "Groups", "Cleanup", "Workspaces", "History"]) {
    assert(
      (await action.locator(".view-strip__label").filter({ hasText: new RegExp(`^${label}$`) }).count()) === 1,
      `The view strip rendered duplicate ${label} controls.`,
    );
  }
  const cleanupNav = action.locator('[data-focus-key="utility-cleanup"]');
  await cleanupNav.focus();
  await cleanupNav.press("Enter");
  assert(
    await action.locator('[data-focus-key="utility-cleanup"]').evaluate((node) => node === document.activeElement),
    "Cleanup utility activation did not preserve keyboard focus.",
  );
  const stashesNav = action.locator('[data-focus-key="utility-stashes"]');
  await stashesNav.press("Enter");
  assert(
    await action.locator('[data-focus-key="utility-stashes"]').evaluate((node) => node === document.activeElement),
    "Stashes utility activation did not preserve keyboard focus.",
  );
  const historyNav = action.locator('[data-focus-key="utility-history"]');
  await historyNav.press("Enter");
  await action.getByRole("heading", { name: "Organization history" }).waitFor();
  assert(
    await action.locator('[data-focus-key="utility-history"]').evaluate((node) => node === document.activeElement),
    "History utility activation did not preserve keyboard focus.",
  );
  assert(
    (await action.locator(".history-item").count()) >= 2,
    "History did not retain the completed organization runs.",
  );
  await action.getByRole("button", { name: "Undo organization", exact: true }).waitFor();
  await action.getByText("Undone", { exact: true }).waitFor();
  const latestHistoryItem = action.locator(".history-item").first();
  await latestHistoryItem.getByText(
    `${latestHistory.newlyGrouped} of ${latestHistory.eligibleUngroupedSubmitted} eligible ungrouped tabs assigned`,
    { exact: true },
  ).waitFor();
  await latestHistoryItem.getByText(
    `${latestHistory.remainingUngrouped} eligible submitted tab${latestHistory.remainingUngrouped === 1 ? "" : "s"} remained ungrouped`,
    { exact: true },
  ).waitFor();
  assert(
    (await action.locator(".history-item").last().getByText(/eligible ungrouped tabs assigned/).count()) === 0,
    "Legacy history unexpectedly invented unavailable coverage facts.",
  );
  const historyScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-history-${colorScheme}.png`,
  );
  await action.screenshot({ path: historyScreenshotPath, fullPage: true });
  settingsPage = await openSettingsPage();
  await closeSettingsPage(settingsPage);
  await action.locator("[data-search-trigger]").click();
  const protectionSearch = action.getByLabel("Search open and saved tabs");
  await protectionSearch.fill("Topic A one");
  const protectionSearchRow = action.locator(".tab-search__result").filter({ hasText: "Topic A one" }).first();
  await protectionSearchRow.waitFor();
  await protectionSearchRow.getByLabel("More actions for Topic A one", { exact: true }).click();
  await protectionSearchRow.getByRole("button", { name: "Protect until restart", exact: true }).click();
  await action.getByText("Topic A one will stay untouched until the browser restarts.", { exact: true }).waitFor();
  // Held tabs live inside Organize: reach them from the frame's Held row.
  await action.locator('[data-focus-key="utility-organize"]').click();
  await action.locator('[data-focus-key="protection-summary"]').click();
  await action.getByRole("heading", { name: "Held tabs" }).waitFor();
  assert(
    (await action.locator('[data-focus-key="utility-protection"]').count()) === 0 &&
      await action.locator('[data-focus-key="utility-organize"]').getAttribute("aria-current") === "page",
    "Held tabs did not open as part of the Organize view.",
  );
  const heldByYou = action.locator(".held-list--yours .held-row");
  await heldByYou.filter({ hasText: "Topic A one" }).filter({ hasText: "Until restart" }).waitFor();
  assert((await heldByYou.count()) === 1, `Unexpected held-by-you rows: ${await heldByYou.count()}`);
  await action.getByRole("button", { name: "Always", exact: true }).click();
  await action.getByRole("button", { name: "Protect 1 selected tab", exact: true }).click();
  await action.locator(".protection-rule").first().waitFor();
  await action.getByRole("button", { name: "Until restart", exact: true }).click();
  await action.getByRole("button", { name: /until restart/ }).filter({ hasText: "Protect" }).first().click();
  await poll(
    async () => ({
      rows: await action.locator(".held-list--yours .held-row").allTextContents(),
      storage: await worker.evaluate(async () => chrome.storage.session.get("sessionUserProtections")),
      notices: await action.locator(".notice").allTextContents(),
    }),
    (value) => value.rows.some((row) => row.includes("Group ·") && row.includes("Until restart")),
    "the session group lock to appear under Held by you",
  );
  // Releasing a restart-only lock from its row puts the group back in Protect more.
  const heldGroupRow = action.locator(".held-list--yours .held-row").filter({ hasText: "Group ·" }).filter({ hasText: "Until restart" }).first();
  const heldGroupName = (await heldGroupRow.locator("strong").textContent())?.trim() ?? "";
  await heldGroupRow.getByRole("button", { name: `Stop protecting ${heldGroupName}`, exact: true }).click();
  await poll(
    async () => ({
      count: await action.locator(".held-list--yours .held-row").filter({ has: action.locator("strong", { hasText: new RegExp(`^${heldGroupName}$`) }) }).count(),
      name: heldGroupName,
      rows: await action.locator(".held-list--yours .held-row").allTextContents(),
      storage: await worker.evaluate(async () => chrome.storage.session.get("sessionUserProtections")),
      notices: await action.locator(".notice").allTextContents(),
    }),
    (value) => value.count === 0,
    "the released group to leave Held by you",
  );
  await action.getByRole("button", { name: "Always", exact: true }).click();
  await action.getByRole("button", { name: /always by name/ }).first().click();
  await action.locator(".protection-rule").nth(1).waitFor();
  await action.locator(".held-list--yours .held-row").filter({ hasText: "Always · name rule" }).first().waitFor();
  const protectionScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-protection-locks-${colorScheme}.png`,
  );
  await captureFullPageFromTop(action, protectionScreenshotPath);
  // Held tabs is a page under Organize; its Back button returns to the frame and refocuses the Held row.
  await action.getByRole("button", { name: "Back to Organize", exact: true }).click();
  await action.locator('[data-focus-key="protection-summary"]').waitFor();
  assert(
    await action.locator('[data-focus-key="protection-summary"]').evaluate((node) => node === document.activeElement),
    "Back to Organize did not return focus to the Held row.",
  );
  // Protect all is a toggle: pressed once every tab is held, and pressing it again releases this window's restart-only locks.
  const protectAll = action.getByRole("button", { name: "Protect every tab in this window until restart", exact: true });
  await protectAll.click();
  const releaseAll = action.getByRole("button", { name: "Stop protecting every tab in this window", exact: true });
  await releaseAll.waitFor();
  assert(
    (await releaseAll.getAttribute("aria-pressed")) === "true" && (await releaseAll.textContent())?.includes("All protected"),
    "Protect all did not switch to its pressed state once every tab was held.",
  );
  await releaseAll.click();
  await protectAll.waitFor();
  assert(
    (await protectAll.getAttribute("aria-pressed")) === "false",
    "Protect all did not release the window's restart-only locks on a second press.",
  );
  settingsPage = await openSettingsPage();
  await showSettingsSection(settingsPage, "data");
  await settingsPage.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await settingsPage.getByRole("heading", { name: "Run diagnostics" }).waitFor();
  await settingsPage.getByText("Provider response validated", { exact: true }).first().waitFor();
  await settingsPage.getByText("150 total", { exact: true }).first().waitFor();
  await settingsPage.getByText("40 cached", { exact: true }).first().waitFor();
  await settingsPage.getByText("Est. $", { exact: false }).first().waitFor();
  const diagnosticsScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-diagnostics-${colorScheme}.png`,
  );
  await settingsPage.screenshot({ path: diagnosticsScreenshotPath, fullPage: true });
  await settingsPage.getByRole("button", { name: "All settings" }).click();
  await settingsPage.getByRole("heading", { name: "All settings" }).waitFor();
  assert(
    (await settingsPage.getByRole("heading", { name: "Protection locks" }).count()) === 0,
    "All settings still exposed the window-scoped protection manager.",
  );
  await closeSettingsPage(settingsPage, false);
  await worker.evaluate(async (baseUrl) => {
    const groupedTabs = Array.from({ length: 8 }, (_, index) => ({
      sourceTabId: 30_000 + index,
      sourceIndex: index,
      title: `Grouped saved tab ${index + 1}`,
      url: `${baseUrl}/saved-group-${index + 1}`,
      groupKey: "saved-group",
    }));
    const ungroupedTabs = Array.from({ length: 8 }, (_, index) => ({
      sourceTabId: 31_000 + index,
      sourceIndex: 8 + index,
      title: `Loose saved tab ${index + 1}`,
      url: `${baseUrl}/saved-loose-${index + 1}`,
      groupKey: null,
    }));
    await chrome.storage.local.set({
      workspaces: [{
        id: "selection-scroll-fixture",
        name: "Selection scroll fixture",
        createdAt: Date.now(),
        status: "saved",
        scope: { mode: "group", groupId: 77 },
        tabs: [...groupedTabs, ...ungroupedTabs],
        groups: [{
          key: "saved-group",
          sourceGroupId: 77,
          sourceIndex: 0,
          title: "Saved group",
          color: "blue",
          collapsed: false,
        }],
        excludedTabs: [],
        closeConflicts: [],
        restoreResult: null,
      }],
    });
  }, origin);
  await action.bringToFront();
  await action.reload({ waitUntil: "domcontentloaded" });
  // The popup always opens on Organize; Search loads its snapshots when opened.
  await action.getByRole("region", { name: "This window" }).waitFor();
  await action.locator("[data-search-trigger]").click();
  await action.getByRole("heading", { name: "Find a tab" }).waitFor();
  assert(
    await action.getByText(/\d+ open tabs? and \d+ workspace tabs? ready to search/).isVisible(),
    "Search opened before its tab snapshots were populated.",
  );
  await action.locator('[data-focus-key="utility-stashes"]').click();
  await action.locator(".stashes-panel .view-heading h2").waitFor();
  assert(
    (await action.locator(".stashes-panel .help-tip").count()) === 0,
    "The Stashes view still contained hover-only help controls.",
  );
  assert(
    (await action.getByRole("button", { name: "Review cleanup suggestions", exact: true }).count()) === 0,
    "The redundant cleanup-review button remained outside the dedicated Cleanup tab.",
  );
  const stashOrder = await action.evaluate(() => {
    const saved = document.querySelector(".stash-saved")?.getBoundingClientRect();
    const start = document.querySelector(".stash-create-start");
    return {
      savedTop: saved?.top ?? Number.POSITIVE_INFINITY,
      createTop: start?.getBoundingClientRect().top ?? Number.NEGATIVE_INFINITY,
      inHeading: start instanceof HTMLElement && start.closest(".view-heading") !== null,
      createOpen: document.querySelector(".stash-create") !== null,
    };
  });
  assert(
    stashOrder.createTop < stashOrder.savedTop && stashOrder.inHeading && !stashOrder.createOpen,
    `The Save this window button did not sit in the headline above the saved list: ${JSON.stringify(stashOrder)}`,
  );
  await action.getByRole("button", { name: "Save this window…", exact: true }).click();
  await action.getByLabel("What to save").selectOption("window");
  assert(
    await action.getByRole("radio", { name: /^Keep the window open/ }).isChecked(),
    "Saving a workspace did not default to keeping the window open.",
  );
  await action.getByRole("button", { name: "Save & keep window open", exact: true }).waitFor();
  await action.getByRole("radio", { name: /^Close the saved tabs/ }).check();
  await action.getByRole("button", { name: /^Save & close \d+ tabs?$/ }).waitFor();
  await action.getByText("will close", { exact: false }).first().waitFor();
  await action.getByText("protected tab", { exact: false }).first().waitFor();
  assert(
    (await action.getByRole("button", { name: /Review selected group|Review entire window/ }).count()) === 0,
    "Stash creation still inserted a redundant review step.",
  );
  assert(
    (await action.getByLabel("Auto-delete saved workspaces").count()) === 0,
    "Stash auto-delete remained in the Stashes view instead of All settings.",
  );
  await action.getByRole("button", { name: "Choose tabs…", exact: true }).click();
  await action.getByText("Open selected tabs", { exact: true }).waitFor();
  await action.getByText("16 of 16 selected", { exact: true }).waitFor();
  await action.getByRole("button", { name: "Clear selection", exact: true }).click();
  await action.getByText("0 of 16 selected", { exact: true }).waitFor();
  assert(
    (await action.getByRole("button", { name: "Open Saved group group (8 tabs)", exact: true }).count()) === 1 &&
      (await action.getByRole("button", { name: "Open all ungrouped tabs (8)", exact: true }).count()) === 1 &&
      (await action.getByRole("button", { name: "Open", exact: true }).count()) === 16 &&
      (await action.getByRole("button", { name: /Open .* in background/ }).count()) === 16 &&
      (await action.getByRole("button", { name: /Copy URL for/ }).count()) === 16 &&
      (await action.locator(".stash-tab-more").count()) === 0 &&
      (await action.locator(".stash-tab-icon-button").count()) === 32,
    "Group, ungrouped, selection, or direct per-tab opening actions were not available.",
  );
  const groupActionLayout = await action.locator(".stash-restore-row--group").first().evaluate((row) => {
    const choice = row.querySelector(".stash-restore-choice--group")?.getBoundingClientRect();
    const open = row.querySelector("button")?.getBoundingClientRect();
    return {
      choiceRight: choice?.right ?? null,
      openLeft: open?.left ?? null,
      openHeight: open?.height ?? null,
    };
  });
  assert(
    groupActionLayout.choiceRight !== null && groupActionLayout.openLeft !== null &&
      groupActionLayout.openLeft >= groupActionLayout.choiceRight &&
      (groupActionLayout.openHeight ?? 0) >= 40,
    `The group-level open action was not aligned as a direct row action: ${JSON.stringify(groupActionLayout)}`,
  );
  const utilityContent = action.locator(".utility-drawer__content");
  const backgroundIcon = action.getByRole("button", { name: "Open Grouped saved tab 1 in background", exact: true });
  const copyIcon = action.getByRole("button", { name: "Copy URL for Grouped saved tab 1", exact: true });
  const iconEvidence = await backgroundIcon.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const svg = node.querySelector("svg");
    return {
      width: box.width,
      height: box.height,
      tooltip: node.dataset.tooltip,
      svgHidden: svg?.getAttribute("aria-hidden"),
      svgFocusable: svg?.getAttribute("focusable"),
    };
  });
  await backgroundIcon.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await backgroundIcon.focus();
  const focusEvidence = await backgroundIcon.evaluate((node) => {
    const tooltip = document.querySelector('[role="tooltip"]');
    const tooltipBox = tooltip?.getBoundingClientRect();
    return {
      focused: document.activeElement === node,
      describedBy: node.getAttribute("aria-describedby"),
      tooltipText: tooltip?.textContent,
      tooltipTop: tooltipBox?.top,
      tooltipBottom: tooltipBox?.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  assert(
    iconEvidence.width >= 24 && iconEvidence.height >= 24 &&
      iconEvidence.tooltip === "Open in background" && iconEvidence.svgHidden === "true" &&
      iconEvidence.svgFocusable === "false" && focusEvidence.focused &&
      focusEvidence.describedBy === "stash-tab-tooltip" && focusEvidence.tooltipText === "Open in background" &&
      (focusEvidence.tooltipTop ?? -1) >= 0 &&
      (focusEvidence.tooltipBottom ?? Number.POSITIVE_INFINITY) <= focusEvidence.viewportHeight,
    `Direct stash icon actions lost their target size, SVG semantics, focus, or tooltip: ${JSON.stringify({ iconEvidence, focusEvidence })}`,
  );
  await utilityContent.evaluate((node) => { node.scrollTop += 1; });
  await action.waitForTimeout(50);
  const scrolledTooltipEvidence = await backgroundIcon.evaluate((node) => {
    const tooltip = document.querySelector(".stash-tab-tooltip");
    const box = tooltip?.getBoundingClientRect();
    return {
      describedBy: node.getAttribute("aria-describedby"),
      top: box?.top,
      bottom: box?.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  assert(
    scrolledTooltipEvidence.describedBy === "stash-tab-tooltip" &&
      (scrolledTooltipEvidence.top ?? -1) >= 0 &&
      (scrolledTooltipEvidence.bottom ?? Number.POSITIVE_INFINITY) <= scrolledTooltipEvidence.viewportHeight,
    `The focused direct-action tooltip was not repositioned after the drawer scrolled: ${JSON.stringify(scrolledTooltipEvidence)}`,
  );
  await backgroundIcon.click();
  await poll(
    () => worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0] ?? null, `${origin}/saved-group-1`),
    (tab) => tab !== null && tab.active === false,
    "direct background stash icon to open its tab without activation",
  );
  await copyIcon.click();
  await action.getByText("URL copied. The workspace is unchanged.", { exact: true }).waitFor();
  const directIconState = await worker.evaluate(async (url) => ({
    stashCount: ((await chrome.storage.local.get("workspaces")).workspaces ?? []).length,
    openedTabIds: (await chrome.tabs.query({ url })).flatMap((tab) => tab.id === undefined ? [] : [tab.id]),
  }), `${origin}/saved-group-1`);
  assert(
    directIconState.stashCount === 1 && directIconState.openedTabIds.length === 1,
    `Direct icon actions changed the stash or opened the wrong number of tabs: ${JSON.stringify(directIconState)}`,
  );
  await worker.evaluate((tabIds) => chrome.tabs.remove(tabIds), directIconState.openedTabIds);
  // Closing the tab re-renders the drawer; a scroll set before that render
  // lands on the outgoing content, and a later render can still grow it, so
  // retry until the bottom position sticks across reads of a stable height.
  let previousScrollHeight = -1;
  const { scrollTop: scrollBeforeTabToggle } = await poll(
    async () => {
      const read = await utilityContent.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
        return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight };
      });
      const settled = read.scrollTop > 0 && read.scrollHeight === previousScrollHeight;
      previousScrollHeight = read.scrollHeight;
      if (!settled) await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      return { ...read, settled };
    },
    (read) => read.settled,
    "the stash drawer to settle scrolled to its last tab",
  );
  const looseLast = action.getByRole("checkbox", { name: "Loose saved tab 8", exact: true });
  await looseLast.check();
  const scrollAfterTabToggle = await utilityContent.evaluate((node) => node.scrollTop);
  const ungroupedChoice = action.getByRole("checkbox", { name: "Ungrouped 8 tabs", exact: true });
  assert(
    scrollBeforeTabToggle > 0 && Math.abs(scrollAfterTabToggle - scrollBeforeTabToggle) <= 2 &&
      await ungroupedChoice.evaluate((node) => node.indeterminate),
    `Stash selection lost its scroll position or Ungrouped indeterminate state: ${JSON.stringify({ scrollBeforeTabToggle, scrollAfterTabToggle })}`,
  );
  await ungroupedChoice.click();
  await action.getByText("8 of 16 selected", { exact: true }).waitFor();
  await action.getByRole("checkbox", { name: "Ungrouped 8 tabs", exact: true }).click();
  await action.getByText("0 of 16 selected", { exact: true }).waitFor();
  const stashActionOrder = await action.locator(".stash-item__actions").evaluate((node) => {
    const restore = [...node.querySelectorAll("button")].find((button) => button.textContent === "Open");
    const icon = node.querySelector(".stash-item-icon-button");
    return { restoreLeft: restore?.getBoundingClientRect().left ?? null, iconLeft: icon?.getBoundingClientRect().left ?? null };
  });
  assert(
    stashActionOrder.restoreLeft !== null && stashActionOrder.iconLeft !== null &&
      stashActionOrder.iconLeft > stashActionOrder.restoreLeft &&
      (await action.locator(".stash-item__menu").count()) === 0 &&
      (await action.getByRole("button", { name: "Edit details for Selection scroll fixture", exact: true }).count()) === 1 &&
      (await action.getByRole("button", { name: "Delete Selection scroll fixture", exact: true }).count()) === 1,
    `Direct stash edit/delete icons were not positioned after Open in linked window: ${JSON.stringify(stashActionOrder)}`,
  );
  const editStash = action.getByRole("button", { name: "Edit details for Selection scroll fixture", exact: true });
  const deleteStash = action.getByRole("button", { name: "Delete Selection scroll fixture", exact: true });
  const stashIconEvidence = await editStash.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      tooltip: node.dataset.tooltip,
      svgHidden: node.querySelector("svg")?.getAttribute("aria-hidden"),
    };
  });
  await editStash.click();
  const closeEdit = action.getByRole("button", { name: "Close details editor for Selection scroll fixture", exact: true });
  await closeEdit.waitFor();
  // Focus lands after the drawer's re-render settles, which can trail the
  // button's appearance and replace the node the locator first resolved, so
  // match the focused element by its label rather than by node identity.
  const closeFocused = await poll(
    () => action.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
    (label) => label === "Close details editor for Selection scroll fixture",
    "focus on the stash details editor's close button",
    2_000,
  ).then(() => true, () => false);
  const editFocusEvidence = {
    closeFocused: closeFocused && await closeEdit.evaluate((node) => document.activeElement === node),
    editorVisible: await action.locator(".stash-metadata-editor__heading").filter({ hasText: "Edit details" }).isVisible(),
    activeLabel: await action.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? null),
  };
  const metadataAlignment = await action.locator(".stash-metadata-editor .field").evaluateAll((fields) =>
    fields.map((field) => ({
      top: field.getBoundingClientRect().top,
      left: field.getBoundingClientRect().left,
      controlTop: field.querySelector(".input")?.getBoundingClientRect().top ?? null,
    })),
  );
  assert(
    stashIconEvidence.width >= 24 && stashIconEvidence.height >= 24 &&
      stashIconEvidence.tooltip === "Edit details" && stashIconEvidence.svgHidden === "true" &&
      editFocusEvidence.closeFocused && editFocusEvidence.editorVisible &&
      // The popup column stacks the fields: same left edge, same label-to-control offset.
      metadataAlignment.length === 2 &&
      metadataAlignment[1].top > metadataAlignment[0].top &&
      Math.abs(metadataAlignment[0].left - metadataAlignment[1].left) <= 1 &&
      metadataAlignment.every((field) => field.controlTop !== null) &&
      Math.abs((metadataAlignment[0].controlTop - metadataAlignment[0].top) -
        (metadataAlignment[1].controlTop - metadataAlignment[1].top)) <= 1,
    `The direct edit icon or aligned metadata editor regressed: ${JSON.stringify({ stashIconEvidence, editFocusEvidence, metadataAlignment })}`,
  );
  await closeEdit.click();
  await editStash.waitFor();
  assert(
    await editStash.evaluate((node) => document.activeElement === node),
    "Closing the stash details editor did not restore focus to its edit icon.",
  );
  await deleteStash.click();
  const confirmDelete = action.getByRole("button", { name: "Confirm deletion of Selection scroll fixture", exact: true });
  await confirmDelete.waitFor();
  assert(
    await confirmDelete.evaluate((node) => document.activeElement === node) &&
      await confirmDelete.getAttribute("aria-pressed") === "true",
    "Arming stash deletion did not retain focus on an explicit confirmation control.",
  );
  await looseLast.click();
  await deleteStash.waitFor();
  assert(
    (await action.getByRole("button", { name: "Confirm deletion of Selection scroll fixture", exact: true }).count()) === 0,
    "Using a control inside the open-tabs picker did not cancel armed stash deletion.",
  );
  await deleteStash.click();
  await confirmDelete.waitFor();
  await action.locator('[data-focus-key="utility-history"]').click();
  await action.getByRole("heading", { name: "Organization history", exact: true }).waitFor();
  await action.locator('[data-focus-key="utility-stashes"]').click();
  await action.locator(".stashes-panel .view-heading h2").waitFor();
  assert(
    (await action.getByRole("button", { name: "Confirm deletion of Selection scroll fixture", exact: true }).count()) === 0 &&
      (await action.getByRole("button", { name: "Delete Selection scroll fixture", exact: true }).count()) === 1,
    "Stash deletion remained armed after leaving and returning to Stashes.",
  );
  const stashesScreenshotPath = resolve(
    projectRoot,
    "docs",
    "screenshots",
    `google-chrome-action-stash-review-${colorScheme}.png`,
  );
  await action.screenshot({ path: stashesScreenshotPath, fullPage: true });
  await worker.evaluate(() => chrome.storage.local.set({ workspaces: [] }));
  await worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get("organizerLocalState")).organizerLocalState;
    await chrome.storage.local.set({
      organizerLocalState: {
        ...stored,
        workflow: { ...stored.workflow, pinUtilityPanelOpen: false },
      },
    });
  });
  await action.locator('[data-focus-key="utility-organize"]').click();
  await action.close();
  const controlPage = await context.newPage();
  await controlPage.goto(`chrome-extension://${extensionId}/control.html`, { waitUntil: "domcontentloaded" });
  const diagnosticState = await worker.evaluate(async () =>
    (await chrome.storage.local.get("diagnosticsState")).diagnosticsState,
  );
  const diagnosticJson = JSON.stringify(diagnosticState);
  assert(
    diagnosticState?.events?.some((event) => event.source === "manual" && event.kind === "provider_validated") &&
    diagnosticState.events.some((event) => event.source === "undo" && event.kind === "undo_completed") &&
      diagnosticState.events.some((event) => event.usage?.totalTokens === 150 && event.usage?.cachedTokens === 40) &&
      diagnosticState.pricing?.inputPerMillionUsd === 2 &&
      diagnosticState.pricing?.outputPerMillionUsd === 8 &&
      !diagnosticJson.includes("Topic A one") &&
      !diagnosticJson.includes("/topic-a-1") &&
      !diagnosticJson.includes("header-value"),
    `Diagnostics were incomplete or retained sensitive tab data: ${diagnosticJson}`,
  );

  const stashFixture = await controlPage.evaluate(async (baseUrl) => {
    const created = await chrome.windows.create({
      url: [`${baseUrl}/stash-group-a`, `${baseUrl}/stash-group-b`, `${baseUrl}/stash-pinned`, `${baseUrl}/stash-loose`],
      focused: false,
    });
    if (!created?.id || !created.tabs || created.tabs.some((tab) => tab.id === undefined)) {
      throw new Error("Could not create the stash test window.");
    }
    const [first, second, pinned] = created.tabs;
    const expectedUrls = new Map([
      [first.id, `${baseUrl}/stash-group-a`],
      [second.id, `${baseUrl}/stash-group-b`],
    ]);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const ready = await Promise.all([...expectedUrls].map(async ([tabId, expectedUrl]) =>
        (await chrome.tabs.get(tabId)).url === expectedUrl,
      ));
      if (ready.every(Boolean)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await chrome.tabs.update(pinned.id, { pinned: true });
    const groupId = await chrome.tabs.group({ tabIds: [first.id, second.id], createProperties: { windowId: created.id } });
    await chrome.tabGroups.update(groupId, { title: "Stash project", color: "green", collapsed: true });
    return { windowId: created.id, groupId, groupTabIds: [first.id, second.id] };
  }, origin);
  const groupStashResponse = await controlPage.evaluate(async (fixture) =>
    chrome.runtime.sendMessage({
      type: "workspace:create",
      targetWindowId: fixture.windowId,
      scope: { mode: "group", groupId: fixture.groupId },
      expectedTabIds: fixture.groupTabIds,
      name: "Stash project",
    }), stashFixture);
  assert(groupStashResponse.ok, `Group stash failed: ${JSON.stringify(groupStashResponse)}`);
  let stashState = await controlPage.evaluate(async () =>
    (await chrome.storage.local.get("workspaces")).workspaces,
  );
  const groupStash = stashState[0];
  assert(
    groupStash?.name === "Stash project" &&
      groupStash.tabs.length === 2 &&
      groupStash.tabs.every((tab) => tab.url.includes("/stash-group-")) &&
      groupStash.groups[0]?.color === "green" &&
      groupStash.groups[0]?.collapsed === true,
    `Group stash did not preserve URLs and structure: ${JSON.stringify(groupStash)}`,
  );
  const selectiveRestoreTarget = await controlPage.evaluate(async () => {
    const created = await chrome.windows.create({ url: "about:blank", focused: false });
    if (created.id === undefined) throw new Error("Could not create the selective-restore target window.");
    return created.id;
  });
  const selectedSourceIndex = groupStash.tabs[0].sourceIndex;
  const selectiveRestoreResponse = await controlPage.evaluate(async ({ stashId, targetWindowId, sourceIndexes }) =>
    chrome.runtime.sendMessage({ type: "workspace:restore", stashId, targetWindowId, sourceIndexes }), {
      stashId: groupStash.id,
      targetWindowId: selectiveRestoreTarget,
      sourceIndexes: [selectedSourceIndex],
    });
  assert(selectiveRestoreResponse.ok, `Selective stash restore failed: ${JSON.stringify(selectiveRestoreResponse)}`);
  const selectivelyRestored = await poll(
    async () => controlPage.evaluate(async (windowId) => ({
      tabs: await chrome.tabs.query({ windowId }),
      groups: await chrome.tabGroups.query({ windowId }),
    }), selectiveRestoreTarget),
    (value) => value.tabs.filter((tab) => tab.url?.includes("/stash-group-")).length === 1 &&
      value.groups.some((group) => group.title === "Stash project" && group.color === "green" && group.collapsed),
    "one selected grouped stash tab to restore",
  );
  assert(
    selectivelyRestored.tabs.filter((tab) => tab.url?.includes("/stash-group-")).length === 1,
    `Selective restore opened more than the chosen tab: ${JSON.stringify(selectivelyRestored.tabs)}`,
  );
  const stashAfterSelectiveRestore = await controlPage.evaluate(async (stashId) =>
    ((await chrome.storage.local.get("workspaces")).workspaces ?? []).find((stash) => stash.id === stashId),
  groupStash.id);
  assert(
    stashAfterSelectiveRestore?.tabs.length === 2 &&
      JSON.stringify(stashAfterSelectiveRestore.tabs.map((tab) => tab.sourceIndex)) ===
        JSON.stringify(groupStash.tabs.map((tab) => tab.sourceIndex)),
    `Selective restore mutated the reusable stash contents: ${JSON.stringify(stashAfterSelectiveRestore)}`,
  );
  await controlPage.evaluate((windowId) => chrome.windows.remove(windowId), selectiveRestoreTarget);
  const groupRestoreResponse = await controlPage.evaluate(async ({ stashId, windowId }) =>
    chrome.runtime.sendMessage({ type: "workspace:restore", stashId, targetWindowId: windowId }), {
      stashId: groupStash.id,
      windowId: stashFixture.windowId,
    });
  assert(groupRestoreResponse.ok, `Group stash restore failed: ${JSON.stringify(groupRestoreResponse)}`);
  await poll(
    async () => controlPage.evaluate(async (windowId) => ({
      tabs: await chrome.tabs.query({ windowId }),
      groups: await chrome.tabGroups.query({ windowId }),
    }), stashFixture.windowId),
    (value) => value.tabs.filter((tab) => tab.url?.includes("/stash-group-")).length === 2 &&
      value.groups.some((group) => group.title === "Stash project" && group.color === "green" && group.collapsed),
    "the group stash restore",
  );
  const replayResponse = await controlPage.evaluate(async ({ stashId, windowId }) =>
    chrome.runtime.sendMessage({ type: "workspace:restore", stashId, targetWindowId: windowId }), {
      stashId: groupStash.id,
      windowId: stashFixture.windowId,
    });
  assert(replayResponse.ok, `Replaying a restored stash failed: ${JSON.stringify(replayResponse)}`);
  const replayedGroup = await poll(
    async () => controlPage.evaluate(async (windowId) => ({
      tabs: await chrome.tabs.query({ windowId }),
      groups: await chrome.tabGroups.query({ windowId }),
    }), stashFixture.windowId),
    (value) => value.tabs.filter((tab) => tab.url?.includes("/stash-group-")).length === 4,
    "the reusable group stash replay",
  );
  const wholeEligible = replayedGroup.tabs
    .filter((tab) => !tab.pinned)
    .map((tab) => tab.id);
  const windowStashResponse = await controlPage.evaluate(async ({ windowId, expectedTabIds }) =>
    chrome.runtime.sendMessage({
      type: "workspace:create",
      targetWindowId: windowId,
      scope: { mode: "window" },
      expectedTabIds,
      name: "Whole test window",
    }), { windowId: stashFixture.windowId, expectedTabIds: wholeEligible });
  assert(windowStashResponse.ok, `Whole-window stash failed: ${JSON.stringify(windowStashResponse)}`);
  stashState = await controlPage.evaluate(async () =>
    (await chrome.storage.local.get("workspaces")).workspaces,
  );
  const windowStash = stashState.find((stash) => stash.scope?.mode === "window");
  assert(
    windowStash?.tabs.length === wholeEligible.length &&
      windowStash.excludedTabs.some((tab) => tab.reasons.includes("Pinned tab")),
    `Whole-window stash did not retain structure and exclusions: ${JSON.stringify(windowStash)}`,
  );
  const windowRestoreResponse = await controlPage.evaluate(async ({ stashId, targetWindowId }) =>
    chrome.runtime.sendMessage({ type: "workspace:restore", stashId, targetWindowId }), {
      stashId: windowStash.id,
      targetWindowId: stashFixture.windowId,
    });
  assert(windowRestoreResponse.ok, `Whole-window stash restore failed: ${JSON.stringify(windowRestoreResponse)}`);
  stashState = await controlPage.evaluate(async () =>
    (await chrome.storage.local.get("workspaces")).workspaces,
  );
  const restoredWindowStash = stashState.find((stash) => stash.id === windowStash.id);
  assert(
    restoredWindowStash.status === "restored" &&
      restoredWindowStash.restoreResult.openedTabs === windowStash.tabs.length &&
      restoredWindowStash.restoreResult.restoredGroups === windowStash.groups.length,
    `Whole-window restore did not report its result: ${JSON.stringify(restoredWindowStash)}`,
  );

  const resumeWorkspaceResponses = await controlPage.evaluate(async ({ stashId, targetWindowId }) =>
    Promise.all([0, 1].map(() => chrome.runtime.sendMessage({
        type: "workspace:restore",
        stashId,
        targetWindowId,
        options: {
          destination: "new_window",
          duplicateHandling: "duplicate",
          afterRestore: "linked_workspace",
        },
      }))), {
      stashId: windowStash.id,
      targetWindowId: stashFixture.windowId,
    });
  assert(
    resumeWorkspaceResponses.filter((response) => response.ok).length === 1 &&
      resumeWorkspaceResponses.filter((response) => !response.ok).length === 1,
    `Concurrent linked workspace resume was not serialized: ${JSON.stringify(resumeWorkspaceResponses)}`,
  );
  const linkedWorkspace = await poll(
    async () => controlPage.evaluate(async (stashId) => {
      const [local, session] = await Promise.all([
        chrome.storage.local.get("workspaces"),
        chrome.storage.local.get("linkedWorkspaceWindows"),
      ]);
      const stash = local.workspaces.find((candidate) => candidate.id === stashId);
      const workspace = session.linkedWorkspaceWindows.find((candidate) => candidate.id === stash.activeWorkspaceId);
      return { stash, workspace };
    }, windowStash.id),
    (state) => Boolean(state.stash?.activeWorkspaceId) && state.workspace?.mode === "whole_window",
    "linked workspace ownership to persist",
  );
  const readWorkspaceDiff = () => controlPage.evaluate(async (stashId) =>
    chrome.runtime.sendMessage({ type: "workspace:window-diff", stashId }), windowStash.id);
  const addedWorkspaceTabId = await controlPage.evaluate(async ({ windowId, baseUrl }) => {
    const tab = await chrome.tabs.create({ windowId, url: `${baseUrl}/workspace-added`, active: false });
    return tab.id;
  }, { windowId: linkedWorkspace.workspace.windowId, baseUrl: origin });
  // The capture token hashes each tab's title and URL, so a token taken while
  // the added tab is still loading goes stale when it finishes; wait for the
  // load before reading the diff whose token the update below reuses.
  await poll(
    () => controlPage.evaluate(async (tabId) => (await chrome.tabs.get(tabId)).status, addedWorkspaceTabId),
    (status) => status === "complete",
    "the added workspace tab to finish loading",
  );
  // chrome.tabs.create resolves before the service worker's tab-event
  // listeners observe the new tab, so every membership-dependent assertion
  // below polls the read-only diff until the worker's view catches up.
  const workspaceDiffResponse = await poll(
    readWorkspaceDiff,
    (response) => response.ok && response.stashWorkspaceDiff?.addedTabs === 1,
    "the linked workspace diff to report the added tab",
  );
  const racedWorkspaceTabId = await controlPage.evaluate(async ({ windowId, baseUrl }) => {
    const tab = await chrome.tabs.create({ windowId, url: `${baseUrl}/workspace-raced`, active: false });
    return tab.id;
  }, { windowId: linkedWorkspace.workspace.windowId, baseUrl: origin });
  await poll(
    readWorkspaceDiff,
    (response) => response.ok && response.stashWorkspaceDiff?.addedTabs === 2,
    "the linked workspace diff to report the raced tab",
  );
  const staleUpdateResponse = await controlPage.evaluate(async ({ stashId, expectedCaptureToken }) =>
    chrome.runtime.sendMessage({ type: "workspace:window-save", stashId, putAway: false, expectedCaptureToken }), {
      stashId: windowStash.id,
      expectedCaptureToken: workspaceDiffResponse.stashWorkspaceDiff.captureToken,
    });
  assert(
    !staleUpdateResponse.ok && staleUpdateResponse.error.includes("changed after review"),
    `A stale workspace diff was accepted: ${JSON.stringify(staleUpdateResponse)}`,
  );
  await controlPage.evaluate(async (tabId) => chrome.tabs.remove(tabId), racedWorkspaceTabId);
  await poll(
    readWorkspaceDiff,
    (response) => response.ok && response.stashWorkspaceDiff?.addedTabs === 1,
    "the linked workspace diff to drop the removed raced tab",
  );
  const updateWorkspaceResponse = await controlPage.evaluate(async ({ stashId, expectedCaptureToken }) =>
    chrome.runtime.sendMessage({ type: "workspace:window-save", stashId, putAway: false, expectedCaptureToken }), {
      stashId: windowStash.id,
      expectedCaptureToken: workspaceDiffResponse.stashWorkspaceDiff.captureToken,
    });
  assert(updateWorkspaceResponse.ok, `Linked workspace update failed: ${JSON.stringify(updateWorkspaceResponse)}`);
  await controlPage.evaluate(async (tabId) => chrome.tabs.remove(tabId), addedWorkspaceTabId);
  await poll(
    readWorkspaceDiff,
    (response) => response.ok && response.stashWorkspaceDiff?.addedTabs === 0,
    "the linked workspace diff to drop the removed added tab",
  );
  const putAwayDiffResponse = await readWorkspaceDiff();
  assert(putAwayDiffResponse.ok, `Put-away diff failed: ${JSON.stringify(putAwayDiffResponse)}`);
  const putAwayResponse = await controlPage.evaluate(async ({ stashId, expectedCaptureToken }) =>
    chrome.runtime.sendMessage({ type: "workspace:window-save", stashId, putAway: true, expectedCaptureToken }), {
      stashId: windowStash.id,
      expectedCaptureToken: putAwayDiffResponse.stashWorkspaceDiff.captureToken,
    });
  assert(putAwayResponse.ok, `Linked workspace put-away failed: ${JSON.stringify(putAwayResponse)}`);
  const putAwayState = await poll(
    async () => controlPage.evaluate(async ({ stashId, workspaceWindowId }) => {
      const [local, session] = await Promise.all([
        chrome.storage.local.get("workspaces"),
        chrome.storage.local.get("linkedWorkspaceWindows"),
      ]);
      const stash = local.workspaces.find((candidate) => candidate.id === stashId);
      let windowStillOpen = true;
      try { await chrome.windows.get(workspaceWindowId); } catch { windowStillOpen = false; }
      return { stash, workspaces: session.linkedWorkspaceWindows ?? [], windowStillOpen };
    }, { stashId: windowStash.id, workspaceWindowId: linkedWorkspace.workspace.windowId }),
    (state) => state.stash?.activeWorkspaceId === null &&
      state.stash.revisions.length === 2 &&
      state.workspaces.length === 0 &&
      state.windowStillOpen === false,
    "the put-away end state",
  );
  assert(
    putAwayState.stash?.activeWorkspaceId === null,
    `Put away did not verify, revise, detach, and close in order: ${JSON.stringify(putAwayState)}`,
  );

  const largeWindowId = final.tabs.find((tab) => tab.url?.startsWith(origin))?.windowId;
  assert(Number.isInteger(largeWindowId), "The large-proposal target window is unavailable.");
  await worker.evaluate(async ({ windowId, baseUrl }) => {
    await Promise.all(Array.from({ length: 26 }, (_, index) => chrome.tabs.create({
      windowId,
      url: `${baseUrl}/large-proposal-${index + 1}`,
      active: false,
    })));
    const stored = (await chrome.storage.local.get("organizerLocalState")).organizerLocalState;
    await chrome.storage.local.set({
      organizerLocalState: {
        ...stored,
        provider: {
          ...stored.provider,
          extraBody: { ...stored.provider.extraBody, largeProposalSmoke: true },
        },
        workflow: {
          ...stored.workflow,
          organizeWithoutReview: false,
          organizeOnExtensionClick: false,
        },
        connectionTest: null,
      },
    });
  }, { windowId: largeWindowId, baseUrl: origin });
  const largeAction = await waitForNewPage(
    context,
    `chrome-extension://${extensionId}/action.html`,
    () => worker.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url, active: true }), {
      windowId: largeWindowId,
      url: `chrome-extension://${extensionId}/action.html`,
    }),
    "the large-proposal action page",
  );
  await largeAction.setViewportSize({ width: 480, height: 700 });
  await largeAction.emulateMedia({ colorScheme });
  await largeAction.goto(`chrome-extension://${extensionId}/action.html`, { waitUntil: "domcontentloaded" });
  await waitForOrganizeOutcome(
    largeAction,
    "Review plan",
    () => largeAction.getByRole("button", { name: /Organize again|Organize current window/ }).click({ timeout: 5_000 }),
    "the large-proposal organize run to reach review",
  );
  const largeGroups = largeAction.locator("details.review-group");
  const largeGroupCount = await largeGroups.count();
  const openLargeGroupCount = await largeAction.locator("details.review-group[open]").count();
  const largeApply = largeAction.locator(".commit-foot").getByRole("button", { name: /^Apply plan/ });
  const largeApplyInView = await largeApply.evaluate((node) => node.getBoundingClientRect().bottom <= window.innerHeight);
  assert(
    largeGroupCount === 13 && openLargeGroupCount === 0 && largeApplyInView,
    `Large proposals did not open as a collapsed frame with Apply in view: ${JSON.stringify({ largeGroupCount, openLargeGroupCount, largeApplyInView })}`,
  );
  const firstLargeGroup = largeGroups.first();
  const firstLargeSummary = firstLargeGroup.locator("summary").first();
  await firstLargeSummary.focus();
  await firstLargeSummary.press("Enter");
  assert(await firstLargeGroup.evaluate((node) => node.open), "A large group could not be expanded by keyboard.");
  const largeMoveSelect = firstLargeGroup.locator(".move-select").first();
  assert(
    await largeMoveSelect.locator("option").count() === 14,
    "Large move destinations were not populated eagerly.",
  );
  const largeTitle = firstLargeGroup.getByLabel("Group name: Large topic 1");
  await largeTitle.fill("Renamed large");
  await largeTitle.blur();
  await largeAction.getByLabel("Group name: Renamed large").waitFor();
  assert(
    await largeAction.locator("details.review-group").first().evaluate((node) => node.open),
    "Editing a large proposal collapsed the active group.",
  );
  await largeApply.click();
  await largeAction.locator(".commit-foot").getByRole("button", { name: "Applying…" }).waitFor();
  await largeAction.getByRole("heading", { name: "Window organized" }).waitFor({ timeout: 15_000 });

  console.log(JSON.stringify({
    popupReviewInline: true,
    interleavedLocalTabsGrouped: true,
    groupsPackedLeft: true,
    inactiveGroupsCollapsed: true,
    activeGroupExpanded: true,
    nativeGroupColors: final.groups.map((group) => group.color),
    undoRestoredOriginalOrder: true,
    oneClickOrganizationAppliedWithoutReview: true,
    skipModeNeverRenderedReview: true,
    duplicateCleanupRequiredReview: true,
    duplicateKeeperDecisionExplained: true,
    cleanupReasonFiltersWorked: true,
    cleanupReviewOpenedInSidecar: true,
    cleanupReviewOpenedAutomatically: true,
    cleanupReviewDismissedForSession: true,
    cleanupReviewUsedTwoColumns: true,
    settingsAutosavePreservedScrollPosition: true,
    providerReceivedTabInactivityMinutes: true,
    providerReceivedSafeRouteContext: true,
    correctionRuleRememberedAndEditable: true,
    skipReviewDidNotApproveGroupNames: true,
    multiRunCountsOnlyHistoryVisible: true,
    historyOpenedInSharedUtilityDrawer: true,
    contextualProtectionActionsWorked: true,
    sessionAndPermanentProtectionLocksVisible: true,
    advancedSettingsOpenedInFullTab: true,
    keyboardCommandsRegistered: true,
    rowBasedDomainRulesValidatedAndPersisted: true,
    safeBackupExportAndReviewedImportWorked: true,
    advancedProviderRequestControlsWorked: true,
    reasoningAmountDefaultedToNone: true,
    diagnosticsRecordedSafeRunAndRecoveryTelemetry: true,
    stashCreationDisclosedFullUrlStorage: true,
    savedStashesPrecededCreation: true,
    restoredStashRemainedReplayable: true,
    groupAndWholeWindowStashesRestoredStructure: true,
    searchableGroupManagerWorked: true,
    groupManagerEditUngroupUndoWorked: true,
    groupManagerRecoveryCloseRestoredStructure: true,
    largeProposalReviewScaled: true,
    destructiveButtonContrastFloor: Number(dangerContrastFloor.toFixed(2)),
    cleanupReasonContrastFloor: Number(reasonContrastFloor.toFixed(2)),
    finalTopicOrder: topicTabs.map((tab) => new URL(tab.url).pathname),
    inactiveBlankTabsClosed: true,
    activeTabsPreserved: final.tabs.some((tab) => tab.active),
    contrastFloor: Number(contrastFloor.toFixed(2)),
    screenshotPath,
    correctionScreenshotPath,
    historyScreenshotPath,
    protectionScreenshotPath,
    cleanupScreenshotPath,
    promptEditorScreenshotPath,
    advancedSettingsScreenshotPath,
    semanticIndexScreenshotPath,
    diagnosticsScreenshotPath,
    stashesScreenshotPath,
    groupManagerScreenshotPath,
  }, null, 2));
} finally {
  if (context) {
    let contextCloseSucceeded = false;
    const contextClose = context.close().then(
      () => { contextCloseSucceeded = true; },
      () => undefined,
    );
    await Promise.race([contextClose, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    if (!contextCloseSucceeded) {
      const browser = context.browser();
      if (browser?.isConnected()) {
        const session = await browser.newBrowserCDPSession().catch(() => null);
        if (session) {
          await session.send("Browser.close").catch(() => undefined);
          await session.detach().catch(() => undefined);
        }
      }
      await Promise.race([contextClose, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    }
  }
  if (server.listening) {
    const serverClosed = new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await serverClosed;
  }
  if (profile) await rm(profile, { recursive: true, force: true });
}
