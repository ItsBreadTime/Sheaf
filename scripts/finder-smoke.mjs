import { rm } from "node:fs/promises";
import { assert, launchExtensionContext, poll } from "./lib/harness.mjs";

// Deterministic check of the search shortcut's finder: three tabs with stable
// titles are seeded through the service worker, then finder.html opens in a
// popup window over them, as the shortcut opens it. Covers filtering, the
// empty state, keyboard selection, switching to the chosen tab (which closes
// the finder), and Escape. Search by meaning needs an embedding provider and
// stays covered by the popup smoke and unit tests.
const { context, extensionId, browserSession, profile } = await launchExtensionContext({
  profilePrefix: "sheaf-finder-",
});

try {
  const worker = await poll(
    () => context.serviceWorkers().find((candidate) => new URL(candidate.url()).host === extensionId) ?? null,
    (candidate) => candidate !== null,
    "the extension service worker",
  );
  const seeded = await worker.evaluate(async () => {
    const win = await chrome.windows.create({ url: "data:text/html,<title>Alpha planning doc</title>" });
    const beta = await chrome.tabs.create({ windowId: win.id, url: "data:text/html,<title>Beta review notes</title>" });
    const gamma = await chrome.tabs.create({ windowId: win.id, url: "data:text/html,<title>Gamma archive</title>" });
    await chrome.tabs.update(gamma.id, { active: true });
    return { windowId: win.id, betaId: beta.id };
  });

  const finderUrl = `chrome-extension://${extensionId}/finder.html`;
  const openFinder = async () => {
    const before = new Set(context.pages());
    await worker.evaluate(async (windowId) => {
      await chrome.windows.create({
        url: chrome.runtime.getURL(`finder.html?window=${windowId}`),
        type: "popup",
        width: 560,
        height: 120,
      });
    }, seeded.windowId);
    const finder = await poll(
      () => context.pages().find((page) => !before.has(page) && page.url().startsWith(finderUrl)) ?? null,
      (page) => page !== null,
      "the finder window",
    );
    await finder.waitForLoadState("domcontentloaded");
    return finder;
  };

  let finder = await openFinder();
  const input = finder.locator("#finder-input");
  const rows = finder.locator(".finder__row");
  // The snapshot loads after the page does; retry the fill until it lands.
  await poll(
    async () => {
      await input.fill("review");
      return rows.count();
    },
    (count) => count === 1,
    "one row for 'review'",
  );
  assert(
    (await rows.first().locator(".finder__title").textContent()) === "Beta review notes",
    "The 'review' row should be the Beta tab.",
  );

  await input.fill("zzz-no-match");
  await poll(() => finder.locator(".finder__empty").textContent(), (text) => text?.startsWith("No tabs match") ?? false, "the empty state");
  assert((await rows.count()) === 0, "A query with no match should show no rows.");

  // Arrow keys move the selection; Enter switches to the selected tab and closes the finder.
  await input.fill("a");
  await poll(() => rows.count(), (count) => count >= 2, "several rows for 'a'");
  await input.fill("notes");
  await poll(() => rows.count(), (count) => count === 1, "one row for 'notes'");
  await input.press("ArrowDown");
  assert(
    (await rows.first().getAttribute("aria-selected")) === "true",
    "With one row, ArrowDown should wrap back to it.",
  );
  const closed = finder.waitForEvent("close");
  await input.press("Enter");
  await closed;
  const active = await poll(
    () => worker.evaluate(async (windowId) => (await chrome.tabs.query({ windowId, active: true }))[0]?.id ?? null, seeded.windowId),
    (tabId) => tabId === seeded.betaId,
    "the chosen tab to become active",
  );
  assert(active === seeded.betaId, "Enter should activate the chosen tab.");

  finder = await openFinder();
  await finder.locator("#finder-input").waitFor();
  // Search by meaning loads on first use; make sure that chunk resolves from
  // the extension page, since this smoke never configures a provider.
  const lazyLoaded = await finder.evaluate(async () => {
    const entry = document.querySelector('script[type="module"]')?.getAttribute("src");
    if (!entry) return "no entry script";
    const source = await (await fetch(entry)).text();
    const specifier = source.match(/import\((["'`])(\.\/chunks\/semantic-search-[^"'`]+)\1\)/)?.[2];
    if (!specifier) return "no lazy semantic-search import";
    const module = await import(new URL(specifier, new URL(entry, location.href)).href);
    return typeof module.searchByMeaning === "function" ? "ok" : "missing export";
  });
  assert(lazyLoaded === "ok", `The finder's lazy search-by-meaning chunk did not load: ${lazyLoaded}`);
  const escaped = finder.waitForEvent("close");
  // Escape closes the window on keydown, so the keyup half of the press can
  // find the page already gone.
  await finder.keyboard.press("Escape").catch(() => undefined);
  await escaped;

  console.log("Finder smoke passed.");
} finally {
  await context?.close();
  await browserSession.detach().catch(() => {});
  if (profile) await rm(profile, { recursive: true, force: true });
}
