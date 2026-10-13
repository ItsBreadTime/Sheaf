import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { assert, launchExtensionContext, listenEphemeral, poll } from "./lib/harness.mjs";

// Auto-filing end to end against mock decision models (docs/auto-filing-plan.md):
// the settings section saves and verifies a decision-API and a chat model,
// imports a calibration, and then real tabs are filed, left alone, undone,
// opted out, and escalated. The mock decides by the group name: a tab whose
// title names exactly one group goes there with 0.96, two names split evenly
// (borderline), and none goes to "none".

const decisionRequests = { decisionApi: 0, chat: 0 };

function groupNameOf(description) {
  return /the "([^"]+)" group/.exec(description ?? "")?.[1] ?? null;
}

function mentions(title, name) {
  const stem = name.toLowerCase().replace(/s$/, "");
  return title.toLowerCase().includes(stem);
}

/** The mock's distribution over a choice question's options. */
function decide(state, instructions, criteria) {
  const options = Object.keys(criteria);
  const tabKey = /Tab (t\d+)/.exec(instructions)?.[1];
  const title = tabKey ? new RegExp(`Tab ${tabKey}[^:\\n]*: "([^"\\n]*)"`).exec(state)?.[1] ?? "" : "";
  const matches = options.filter((option) => {
    const name = groupNameOf(criteria[option]);
    return name !== null && option !== "stay" && mentions(title, name);
  });
  const winners = matches.length > 0 ? matches : options.includes("none") ? ["none"] : [options[0]];
  const share = winners.length === 1 ? 0.96 : 1 / winners.length;
  const rest = winners.length === 1 ? 0.04 / Math.max(1, options.length - 1) : 0;
  return Object.fromEntries(options.map((option) => [option, winners.includes(option) ? share : rest]));
}

function noulProbability(id, instructions) {
  if (id === "reorganize" || /coherent new topic/.test(instructions)) return 0.1;
  return 0.95;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
    });
    response.end();
    return;
  }
  if (request.method === "GET") {
    const url = new URL(request.url ?? "/", "http://mock");
    const title = url.searchParams.get("t") ?? "Untitled page";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${title.replace(/</g, "&lt;")}</title><h1>${title.replace(/</g, "&lt;")}</h1>`);
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/v1/systemone") {
      decisionRequests.decisionApi += 1;
      const state = typeof body.state === "string" ? body.state : JSON.stringify(body.state);
      const answers = {};
      for (const [id, question] of Object.entries(body.questions ?? {})) {
        if (question.type === "noul") {
          answers[id] = { noul: noulProbability(id, question.instructions) };
          continue;
        }
        const probabilities = decide(state, question.instructions, question.criteria);
        const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
        answers[id] = { choice, probabilities, confidence: probabilities[choice] };
      }
      json(response, 200, { model: body.model, answers, usage: { calls: 1 } });
      return;
    }
    if (request.url === "/v1/chat/completions") {
      decisionRequests.chat += 1;
      const content = body.messages?.findLast((message) => message.role === "user")?.content ?? "";
      const state = /State:\n([\s\S]*?)\n\nQuestion:/.exec(content)?.[1] ?? "";
      const instructions = /Question: ([\s\S]*?)\n\nOptions:/.exec(content)?.[1] ?? "";
      const lines = (/Options:\n([\s\S]*?)\n\n/.exec(content)?.[1] ?? "").split("\n");
      const labels = {};
      const criteria = {};
      for (const line of lines) {
        const match = /^(\w): (\S+)(?: — (.*))?$/.exec(line);
        if (!match) continue;
        labels[match[2]] = match[1];
        criteria[match[2]] = match[3] ?? "";
      }
      const probabilities = Object.keys(criteria).includes("yes")
        ? { yes: noulProbability("", instructions), no: 1 - noulProbability("", instructions) }
        : decide(state, instructions, criteria);
      const top = Object.entries(probabilities).map(([option, probability]) => ({
        token: labels[option],
        logprob: Math.log(Math.max(probability, 1e-6)),
      }));
      const best = top.sort((a, b) => b.logprob - a.logprob)[0]?.token ?? "A";
      json(response, 200, {
        choices: [{ index: 0, message: { role: "assistant", content: best }, logprobs: { content: [{ token: best, top_logprobs: top }] } }],
        usage: { prompt_tokens: 50, completion_tokens: 1, total_tokens: 51 },
      });
      return;
    }
    json(response, 404, { error: "not found" });
  });
});

let context = null;
let profile = null;
let browserSession = null;
try {
  const origin = await listenEphemeral(server);
  const page = (title) => `${origin}/page?t=${encodeURIComponent(title)}`;
  const launched = await launchExtensionContext({
    profilePrefix: "sheaf-auto-filing-",
    colorScheme: process.env.COLOR_SCHEME === "dark" ? "dark" : "light",
  });
  ({ context, profile, browserSession } = launched);
  const { extensionId } = launched;
  const worker = await poll(
    () => context.serviceWorkers().find((candidate) => new URL(candidate.url()).host === extensionId) ?? null,
    (candidate) => candidate !== null,
    "the extension service worker",
  );

  // A window with two groups the user built, before filing is turned on.
  const setup = await worker.evaluate(async (urls) => {
    const win = await chrome.windows.create({ url: urls.recipesOne, focused: false });
    const [first] = await chrome.tabs.query({ windowId: win.id });
    const second = await chrome.tabs.create({ windowId: win.id, url: urls.recipesTwo, active: false });
    const tax = await chrome.tabs.create({ windowId: win.id, url: urls.taxes, active: false });
    const ids = [first.id, second.id, tax.id];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
      if (tabs.every((tab) => tab.status === "complete" && tab.url?.startsWith("http"))) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    const recipes = await chrome.tabs.group({ tabIds: [first.id, second.id], createProperties: { windowId: win.id } });
    await chrome.tabGroups.update(recipes, { title: "Recipes", color: "green" });
    const taxes = await chrome.tabs.group({ tabIds: [tax.id], createProperties: { windowId: win.id } });
    await chrome.tabGroups.update(taxes, { title: "Taxes", color: "red" });
    return { windowId: win.id, recipes, taxes };
  }, {
    recipesOne: page("Recipes: lemon tart"),
    recipesTwo: page("Recipes: shortcrust pastry"),
    taxes: page("Taxes: filing deadline checklist"),
  });

  // --- Settings: enable, save and verify both protocols, import a calibration.
  const settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${extensionId}/action.html?view=settings&window=${setup.windowId}`, { waitUntil: "domcontentloaded" });
  await settingsPage.locator('.settings-nav__link[href="#auto-filing"]').waitFor({ timeout: 15_000 }).catch(async (error) => {
    throw new Error(`The Auto-filing settings section did not render: ${await settingsPage.locator("body").innerText()}`, { cause: error });
  });
  await settingsPage.locator('.settings-nav__link[href="#auto-filing"]').click();
  await settingsPage.locator("#auto-filing").waitFor();
  await settingsPage.evaluate(() => { chrome.permissions.request = async () => true; });
  const section = settingsPage.locator("#auto-filing");
  await section.getByText("Auto-file new tabs into existing groups", { exact: true }).click();
  await poll(
    () => worker.evaluate(async () => (await chrome.storage.local.get("autoFilingLocalState")).autoFilingLocalState?.settings?.enabled),
    (enabled) => enabled === true,
    "auto-filing to be enabled in storage",
  );

  // Auto-filing links to its connection; the form itself is in Connections.
  await section.locator('a.provider-link[data-provider-target="decision"]').click();
  await settingsPage.locator("#connections").waitFor();
  const decisionModel = settingsPage.locator("#provider-decision");
  if (!(await decisionModel.evaluate((node) => node.open))) await decisionModel.locator("summary.settings-disclosure-summary").click();
  await decisionModel.getByLabel("Protocol", { exact: true }).selectOption("chat");
  // A base URL gets the chat route; the field says exactly where requests go.
  await decisionModel.getByLabel("API URL", { exact: true }).fill(`${origin}/v1`);
  await decisionModel.getByText(`Sheaf will call ${origin}/v1/chat/completions`, { exact: true }).waitFor();
  await decisionModel.getByLabel("Model", { exact: true }).fill("smoke-chat");
  await decisionModel.locator('[data-action-name="save-decision-provider"]').click();
  await settingsPage.getByText(/Filing model saved and verified/).waitFor();
  assert(decisionRequests.chat >= 1, "The chat probe did not reach the mock chat server.");
  const chatProbe = await worker.evaluate(async () => (await chrome.storage.local.get("autoFilingLocalState")).autoFilingLocalState?.probe);
  assert(chatProbe?.probabilities === "logprobs", `The chat probe did not read logprobs: ${JSON.stringify(chatProbe)}`);

  if (!(await decisionModel.evaluate((node) => node.open))) await decisionModel.locator("summary.settings-disclosure-summary").click();
  await decisionModel.getByLabel("Protocol", { exact: true }).selectOption("decision_api");
  // The saved chat connection shows as a base URL plus its route; switching protocol swaps the route.
  assert(
    (await decisionModel.getByLabel("API URL", { exact: true }).inputValue()) === `${origin}/v1` &&
      (await decisionModel.getByLabel("API route", { exact: true }).inputValue()) === "/systemone",
    "Choosing the decision API did not switch the API route.",
  );
  await decisionModel.getByText(`Sheaf will call ${origin}/v1/systemone`, { exact: true }).waitFor();
  await decisionModel.getByLabel("Model", { exact: true }).fill("smoke-decider");
  await decisionModel.getByLabel("API key", { exact: true }).fill("decision-session-key");
  await decisionModel.locator('[data-action-name="save-decision-provider"]').click();
  await settingsPage.getByText(/Filing model saved and verified/).waitFor();
  const stored = await worker.evaluate(async () => ({
    local: (await chrome.storage.local.get("autoFilingLocalState")).autoFilingLocalState,
    session: await chrome.storage.session.get("autoFilingApiKey"),
  }));
  assert(
    stored.local.probe?.probabilities === "native" &&
      stored.local.settings.decisionModel.model === "smoke-decider" &&
      !JSON.stringify(stored.local).includes("decision-session-key") &&
      stored.session.autoFilingApiKey === "decision-session-key",
    `Decision model storage boundaries failed: ${JSON.stringify(stored)}`,
  );

  await settingsPage.locator('.settings-nav__link[href="#auto-filing"]').click();
  await section.waitFor();
  // Calibration is an expert control, inside the section's Advanced area.
  await section.locator('details[data-advanced="auto-filing"] > summary').click();
  await section.locator('input[type="file"][aria-label="Calibration file to import"]').setInputFiles({
    name: "calibrations.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      format: "sheaf-filing-calibrations",
      version: 1,
      calibrations: [{
        protocol: "decision_api",
        model: "smoke-decider",
        style: "text",
        thresholds: { apply: 0.85, margin: 0.3, fit: 0.5, applyGrouped: 0.9, stay: 0.1 },
        meetsGate: true,
      }],
    })),
  });
  await settingsPage.getByText("Imported 1 calibration: smoke-decider.").waitFor();
  await section.getByText("smoke-decider · in use", { exact: true }).waitFor();

  // --- Filing: a confident tab is filed; unrelated and borderline tabs stay.
  const openTab = (title) => worker.evaluate(async ({ windowId, url }) =>
    (await chrome.tabs.create({ windowId, url, active: false })).id, { windowId: setup.windowId, url: page(title) });
  const groupOf = (tabId) => worker.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, tabId);
  const requestsBefore = decisionRequests.decisionApi;
  const scones = await openTab("Recipes: cheese scones");
  const weather = await openTab("Weather this weekend");
  const borderline = await openTab("Recipes for a taxes party");
  await poll(() => groupOf(scones), (groupId) => groupId === setup.recipes, "the recipe tab to be filed into Recipes", 20_000);
  await poll(() => decisionRequests.decisionApi, (count) => count > requestsBefore, "a decision request");
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
  assert((await groupOf(weather)) === -1, "An unrelated tab was filed.");
  assert((await groupOf(borderline)) === -1, "A borderline tab was filed.");
  const lastRequest = await worker.evaluate(async () => (await chrome.storage.session.get("autoFilingLastRequest")).autoFilingLastRequest);
  assert(
    lastRequest?.protocol === "decision_api" && lastRequest.body.includes("smoke-decider") &&
      !new RegExp(`"${scones}"`).test(lastRequest.body),
    "The last decision request was not recorded, or it carried browser tab IDs.",
  );

  // --- History → Auto-filed and Undo, from the popup.
  // Opened as a tab in the filing window, so the popup targets that window.
  const actionUrl = `chrome-extension://${extensionId}/action.html`;
  await worker.evaluate(async ({ windowId, url }) => { await chrome.tabs.create({ windowId, url }); }, { windowId: setup.windowId, url: actionUrl });
  const action = await poll(
    () => context.pages().find((candidate) => candidate.url() === actionUrl) ?? null,
    (candidate) => candidate !== null,
    "the action page in the filing window",
  );
  await action.waitForLoadState("domcontentloaded");
  await action.getByRole("button", { name: "History", exact: true }).first().click();
  await action.getByRole("tab", { name: /^Auto-filed/ }).click();
  const filedRow = action.locator(".filing-log__row").filter({ hasText: "Recipes: cheese scones" });
  await filedRow.waitFor();
  assert((await filedRow.innerText()).includes("Filed into Recipes"), "History → Auto-filed did not name the group.");
  await filedRow.getByRole("button", { name: /^Undo filing/ }).click();
  await poll(() => groupOf(scones), (groupId) => groupId === -1, "Undo to take the tab back out of Recipes");
  await action.locator(".filing-log__row").filter({ hasText: "Recipes: cheese scones" }).waitFor({ state: "detached" });
  const sticky = await worker.evaluate(async () => (await chrome.storage.session.get("autoFilingStickyTabIds")).autoFilingStickyTabIds);
  assert(Array.isArray(sticky) && sticky.includes(scones), "An undone tab was not kept from being filed again.");

  // A tab the user moves themselves is never auto-moved afterwards.
  const manual = await openTab("Recipes: apple crumble");
  await poll(() => groupOf(manual), (groupId) => groupId === setup.recipes, "the second recipe tab to be filed", 20_000);
  await worker.evaluate(async (id) => chrome.tabs.ungroup(id), manual);
  await poll(
    () => worker.evaluate(async () => (await chrome.storage.session.get("autoFilingStickyTabIds")).autoFilingStickyTabIds ?? []),
    (ids) => ids.includes(manual),
    "a user ungroup to make the tab sticky",
  );

  // --- Opt-out from the Groups view: the group is no longer a target.
  await action.getByRole("button", { name: "Groups", exact: true }).first().click();
  await action.locator(".group-manager__row").filter({ hasText: "Recipes" }).first().locator(".group-manager__row-main").click();
  await action.getByText("Don't auto-file into this group", { exact: true }).click();
  await poll(
    () => worker.evaluate(async () => (await chrome.storage.local.get("autoFilingLocalState")).autoFilingLocalState?.settings?.optedOutGroupTitles),
    (titles) => Array.isArray(titles) && titles.includes("Recipes"),
    "the Recipes opt-out to be saved",
  );
  const optedOutRequests = decisionRequests.decisionApi;
  const blocked = await openTab("Recipes: banana bread");
  await poll(() => decisionRequests.decisionApi, (count) => count > optedOutRequests, "a decision request after the opt-out");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  assert((await groupOf(blocked)) === -1, "A tab was filed into an opted-out group.");

  // --- Escalation: enough tabs that fit no group suggest an organize.
  for (const title of ["Train times to Porto", "Football results", "Laptop reviews"]) await openTab(title);
  const suggestion = await poll(
    () => worker.evaluate(async () => (await chrome.storage.session.get("autoFilingSuggestion")).autoFilingSuggestion ?? null),
    (value) => value !== null,
    "an organize suggestion",
    20_000,
  );
  assert(suggestion.windowId === setup.windowId && suggestion.ungroupedCount >= 5, `Unexpected suggestion: ${JSON.stringify(suggestion)}`);
  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  assert(badge === String(suggestion.ungroupedCount), `The badge did not show the suggestion: ${badge}`);
  await action.reload({ waitUntil: "domcontentloaded" });
  const prompt = action.locator(".filing-suggestion");
  await prompt.waitFor();
  assert((await prompt.innerText()).includes("don't fit your groups"), "The Organize view did not show the suggestion.");
  await prompt.getByRole("button", { name: "Not now", exact: true }).click();
  await prompt.waitFor({ state: "detached" });
  assert((await worker.evaluate(() => chrome.action.getBadgeText({}))) === "", "Dismissing the suggestion left the badge.");

  // --- With the opt-out lifted, the next tab is filed and logged newest first.
  await worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get("autoFilingLocalState")).autoFilingLocalState;
    stored.settings.optedOutGroupTitles = [];
    await chrome.storage.local.set({ autoFilingLocalState: stored });
  });
  const taxForm = await openTab("Taxes: receipts for the tax form");
  await poll(() => groupOf(taxForm), (groupId) => groupId === setup.taxes, "the tax tab to be filed into Taxes", 20_000);
  const log = await worker.evaluate(async () => (await chrome.storage.session.get("autoFilingLog")).autoFilingLog);
  assert(log?.[0]?.tabId === taxForm && log[0].toGroupTitle === "Taxes", "The filing log did not record the latest filing first.");

  console.log("Auto-filing smoke passed.");
} finally {
  await context?.close();
  await browserSession?.detach().catch(() => {});
  server.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
