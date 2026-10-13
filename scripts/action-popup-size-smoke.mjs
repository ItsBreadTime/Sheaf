import { rm } from "node:fs/promises";
import { assert, launchExtensionContext, poll } from "./lib/harness.mjs";

const { context, extensionId, browserSession, profile: profileDir } = await launchExtensionContext({
  profilePrefix: "sheaf-action-popup-",
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("data:text/html,<title>Popup sizing fixture</title>");

  const worker = await poll(
    () => context.serviceWorkers().find((candidate) => new URL(candidate.url()).host === extensionId) ?? null,
    (candidate) => candidate !== null,
    "the extension service worker",
  );
  const targetsBefore = await browserSession.send("Target.getTargets");
  const existingTargetIds = new Set(targetsBefore.targetInfos.map((target) => target.targetId));
  await worker.evaluate(async () => {
    const current = await chrome.windows.getCurrent();
    await chrome.action.openPopup({ windowId: current.id });
  });

  const popupTarget = await poll(
    async () => (await browserSession.send("Target.getTargets")).targetInfos.find((target) =>
      !existingTargetIds.has(target.targetId) &&
      target.url === `chrome-extension://${extensionId}/action.html`,
    ) ?? null,
    (target) => target !== null,
    "the real browser action popup target",
  );
  const attached = await browserSession.send("Target.attachToTarget", {
    targetId: popupTarget.targetId,
    flatten: false,
  });
  const sendToPopup = (method, params = {}) => browserSession.send("Target.sendMessageToTarget", {
    sessionId: attached.sessionId,
    message: JSON.stringify({ id: Date.now(), method, params }),
  });
  await sendToPopup("Runtime.enable");

  const evaluate = async (expression) => {
    const id = Math.floor(Math.random() * 1_000_000_000);
    const responsePromise = new Promise((resolveResponse) => {
      const listener = (event) => {
        if (event.sessionId !== attached.sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== id) return;
        browserSession.off("Target.receivedMessageFromTarget", listener);
        resolveResponse(message);
      };
      browserSession.on("Target.receivedMessageFromTarget", listener);
    });
    await browserSession.send("Target.sendMessageToTarget", {
      sessionId: attached.sessionId,
      message: JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    });
    const response = await responsePromise;
    if (response.error) throw new Error(response.error.message);
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  };

  const compact = await poll(
    () => evaluate(`(() => {
      const shell = document.querySelector('.action-shell');
      return shell ? {
        ready: !document.querySelector('.loading'),
        innerWidth: window.innerWidth,
        bodyWidth: document.body.getBoundingClientRect().width,
        shellWidth: shell.getBoundingClientRect().width,
        scrollWidth: document.documentElement.scrollWidth,
      } : null;
    })()`),
    (value) => value?.ready === true,
    "the compact action popup layout",
  );
  assert(
    compact.innerWidth >= 460 && compact.bodyWidth === 480 && compact.shellWidth >= 460,
    `The real action popup collapsed in compact mode: ${JSON.stringify(compact)}`,
  );

  await evaluate(`(() => {
    const search = document.querySelector('[data-search-trigger]');
    if (!search) throw new Error('Search action is unavailable.');
    search.click();
  })()`);
  const utility = await poll(
    () => evaluate(`(() => {
      const shell = document.querySelector('.action-shell--utility-open');
      return shell ? {
        innerWidth: window.innerWidth,
        bodyWidth: document.body.getBoundingClientRect().width,
        shellWidth: shell.getBoundingClientRect().width,
        drawerWidth: document.querySelector('.utility-drawer')?.getBoundingClientRect().width,
        hasPrimaryBeside: Boolean(document.querySelector('.action-primary')),
        scrollWidth: document.documentElement.scrollWidth,
      } : null;
    })()`),
    (value) => value !== null,
    "the utility-open action popup layout",
  );
  assert(
    utility.innerWidth >= 460 && utility.bodyWidth === 480 && utility.shellWidth === 480 &&
      utility.drawerWidth === 480 && utility.hasPrimaryBeside === false,
    `The real action popup collapsed in utility mode: ${JSON.stringify(utility)}`,
  );

  console.log(JSON.stringify({ compact, utility }, null, 2));
  await browserSession.send("Target.closeTarget", { targetId: popupTarget.targetId });
  await browserSession.detach();
} finally {
  await context.close();
  await rm(profileDir, { recursive: true, force: true });
}
