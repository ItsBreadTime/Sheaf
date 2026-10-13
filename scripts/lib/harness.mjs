import { copyFile, cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export const projectRoot = resolve(import.meta.dirname, "..", "..");

export function requireBrowserPath() {
  const browserPath = process.env.BROWSER_PATH;
  if (!browserPath) {
    throw new Error("Set BROWSER_PATH to a Chromium-family browser executable.");
  }
  return browserPath;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function poll(read, accept, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(latest)}`);
}

// chrome.tabs.create reports a new page before its URL commits, and a burst
// of tab creations can deliver an unrelated "page" event first, so waiting on
// the context's "page" event races the navigation. Poll the page list for a
// page that did not exist before the trigger and has committed the expected
// URL instead.
export async function waitForNewPage(pageContext, urlPrefix, trigger, description, timeoutMs = 30_000) {
  const known = new Set(pageContext.pages());
  const opened = poll(
    () => pageContext.pages().find((candidate) =>
      !known.has(candidate) && candidate.url().startsWith(urlPrefix)) ?? null,
    (candidate) => candidate !== null,
    description,
    timeoutMs,
  );
  try {
    await trigger();
  } catch (error) {
    // Nothing will await the poll now; swallow its eventual timeout so it
    // cannot surface later as an unhandled rejection masking this error.
    opened.catch(() => {});
    throw error;
  }
  return opened;
}

// Launches an isolated Chromium profile with the built extension from dist
// loaded over CDP. The CDP session stays attached because some harnesses
// drive raw Target commands; callers must detach it when done.
//
// `testPages` names pages from scripts/fixtures to serve from the extension
// origin (a blank page with chrome.* access, say). They are added to a copy of
// the build inside the profile, so they never ship in dist.
export async function launchExtensionContext({
  profilePrefix,
  headless = true,
  colorScheme = "light",
  args = [],
  extensionPath = resolve(projectRoot, "dist"),
  testPages = [],
  keepSetupPage = false,
} = {}) {
  const executablePath = requireBrowserPath();
  const profile = await mkdtemp(resolve(tmpdir(), profilePrefix));
  if (testPages.length > 0) {
    const copy = resolve(profile, "extension-under-test");
    await cp(extensionPath, copy, { recursive: true });
    for (const page of testPages) {
      await copyFile(resolve(projectRoot, "scripts", "fixtures", page), resolve(copy, page));
    }
    extensionPath = copy;
  }
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless,
    colorScheme,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      ...args,
    ],
  });
  const browser = context.browser();
  assert(browser, "The isolated browser connection is unavailable.");
  const browserSession = await browser.newBrowserCDPSession();
  const loaded = await browserSession.send("Extensions.loadUnpacked", {
    path: extensionPath,
  });
  await waitForBundledUblock(context, browserSession);
  // A fresh install opens guided setup in a new tab. Most smokes start from a
  // known tab layout, so close it unless the caller is testing setup itself.
  const setupPage = await poll(
    () => context.pages().find((page) => page.url().includes(`${loaded.id}/action.html?view=setup`)) ?? null,
    (page) => page !== null,
    "the first-run setup page to open",
    5_000,
  ).catch(() => null);
  if (setupPage && !keepSetupPage) await setupPage.close();
  return { context, extensionId: loaded.id, browserSession, profile, setupPage: keepSetupPage ? setupPage : null };
}

// Helium bundles uBlock Origin, which on a fresh profile reloads every web
// tab that loaded before its filters were ready, aborting in-flight
// navigations. Wait until it reports ready so smoke tabs open after that.
async function waitForBundledUblock(context, browserSession) {
  const { targetInfos } = await browserSession.send("Target.getTargets");
  const ublock = targetInfos.find((target) =>
    target.type === "background_page" && target.title === "uBlock Origin");
  if (!ublock) return;
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${new URL(ublock.url).host}/dashboard.html`, { waitUntil: "domcontentloaded" });
    await poll(
      () => page.evaluate(() => typeof vAPI === "undefined"
        ? false
        : vAPI.messaging.send("default", { what: "readyToFilter" })).catch(() => false),
      (ready) => ready === true,
      "the bundled uBlock Origin to finish starting",
    );
  } finally {
    await page.close();
  }
}

// Binds a server to an ephemeral loopback port and returns its origin.
export async function listenEphemeral(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Smoke server address is unavailable.");
  return `http://127.0.0.1:${address.port}`;
}
