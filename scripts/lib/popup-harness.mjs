import { createServer } from "node:http";
import { measureContrastRatios } from "./contrast.mjs";
import { assert, poll } from "./harness.mjs";

// Shared infrastructure for scripts/popup-smoke.mjs: the mock provider
// server, its request counters, and the render-race-safe wait helpers. This
// is the part of the popup harness that scenario modules will reuse; the
// scenario bodies themselves still live in popup-smoke.mjs.

export function createPopupMockServer() {
  const state = {
    embeddingRequestCount: 0,
    embeddingDocumentInputs: [],
    embeddingQueryInputs: [],
    benchmarkRequestCount: 0,
    sawMixedCurrentGroupMembership: false,
    sawAiGroupColorMode: false,
  };
  const server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,content-type,x-popup-smoke",
      });
      response.end();
      return;
    }
    if (request.method === "GET") {
      const titleByPath = new Map([
        ["/topic-a-1", "Topic A one"],
        ["/topic-b-1", "Topic B one"],
        ["/topic-a-2", "Topic A two"],
        ["/topic-b-2", "Topic B two"],
      ]);
      const title = titleByPath.get(request.url ?? "") ?? "Browser organization notes";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/v1/embeddings") {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        state.embeddingRequestCount += 1;
        for (const input of inputs) {
          if (typeof input !== "string") continue;
          if (input.includes("Title:")) state.embeddingDocumentInputs.push(input);
          else state.embeddingQueryInputs.push(input);
        }
        if (inputs.some((input) => typeof input === "string" && input.includes("query failure"))) {
          response.writeHead(429, { "content-type": "application/json", "access-control-allow-origin": "*" });
          response.end(JSON.stringify({ error: "semantic query smoke failure" }));
          return;
        }
        if (body.smokeTerminalFailure === true && inputs.some((input) => typeof input === "string" && input.includes("Title:"))) {
          response.writeHead(401, { "content-type": "application/json", "access-control-allow-origin": "*" });
          response.end(JSON.stringify({ error: "terminal smoke failure" }));
          return;
        }
        const respond = () => {
          if (response.destroyed) return;
          // Document text is lowercased by the product's semantic normalizer
          // (only the "Title:" prefix keeps its case), so matchers on document
          // content must be case-insensitive or the mocked vectors depend on
          // batch order instead of content.
          const matchedEmbedding = (candidate) =>
            typeof candidate === "string" && (
              candidate.toLowerCase().includes("unique stashed semantic guide") ||
              candidate.toLowerCase().includes("remembered saved article")
            );
          response.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          });
          response.end(JSON.stringify({
            object: "list",
            data: inputs.map((input, index) => ({
              object: "embedding",
              index,
              embedding: matchedEmbedding(input) ? [0, 1, 0] : [1, index + 1, 2],
            })),
            model: body.model,
          }));
        };
        if (inputs.some((input) => typeof input === "string" && input.includes("Title:"))) setTimeout(respond, 2_500);
        else if (inputs.some((input) => typeof input === "string" && input.includes("slow old query"))) setTimeout(respond, 1_200);
        else if (inputs.some((input) => typeof input === "string" && input.includes("Query:Topic A one"))) setTimeout(respond, 300);
        else respond();
        return;
      }
      const systemMessage = body.messages?.find((message) => message.role === "system")?.content ?? "";
      const userMessage = body.messages?.findLast((message) => message.role === "user")?.content ?? "";
      const sendChatContent = (content, scoreModel = body.model) => {
        response.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        response.end(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content } }],
          usage: {
            prompt_tokens: scoreModel === "popup-smoke-model-b" ? 140 : 120,
            completion_tokens: 30,
            total_tokens: scoreModel === "popup-smoke-model-b" ? 170 : 150,
            prompt_tokens_details: { cached_tokens: scoreModel === "popup-smoke-model-b" ? 20 : 40 },
          },
        }));
      };
      if (systemMessage.includes("Create a diverse, adversarial but realistic evaluation set")) {
        state.benchmarkRequestCount += 1;
        const count = Number(userMessage.match(/Generate exactly (\d+)/)?.[1] ?? 1);
        sendChatContent(JSON.stringify({
          cases: Array.from({ length: count }, (_, index) => ({
            id: `smoke-${index + 1}`,
            input: `Synthetic tab set ${index + 1}: docs, issue tracker, and a local preview`,
          })),
        }));
        return;
      }
      if (systemMessage.includes("impartial benchmark grader")) {
        state.benchmarkRequestCount += 1;
        const strong = userMessage.includes("popup-smoke-model-b");
        sendChatContent(JSON.stringify({
          score: strong ? 92 : 78,
          reason: strong ? "Clear grouping and complete coverage." : "Useful answer with minor ambiguity.",
        }));
        return;
      }
      // Identify the organizer request by its shape, not by prompt wording. The default
      // organizer prompt no longer carries the IMMUTABLE CONSTRAINTS marker (it now only
      // appears on custom prompts), and a matcher on prose goes stale silently: this branch
      // answered every organizer request with a benchmark string, so provider verification
      // failed for a reason that had nothing to do with the code under test.
      let data = null;
      try {
        data = JSON.parse(userMessage);
      } catch {
        data = null;
      }
      const isOrganizerRequest = data !== null && typeof data === "object" &&
        Array.isArray(data.tabs) && Boolean(data.inactivityPolicy);
      if (!isOrganizerRequest) {
        state.benchmarkRequestCount += 1;
        sendChatContent(`Mock benchmark response from ${body.model}.`);
        return;
      }
      try {
        assert(
          data.inactivityPolicy?.generalSuggestionAfterHours === 24 &&
            data.inactivityPolicy?.lowValueSuggestionAfterHours === 6 &&
            data.inactivityPolicy?.closingRequiresManualReview === true,
          "The provider request did not include the configured inactivity policy.",
        );
        assert(
          (data.tabs ?? []).every((tab) => Number.isInteger(tab.inactiveForMinutes)),
          "The default provider request omitted a tab inactivity duration.",
        );
        const currentGroupMembership = (data.tabs ?? []).map((tab) => tab.isCurrentlyGrouped);
        if (currentGroupMembership.includes(true) && currentGroupMembership.includes(false)) {
          state.sawMixedCurrentGroupMembership = true;
        }
        const localRecords = (data.tabs ?? []).filter((tab) => tab.domain === "127.0.0.1");
        assert(
          (data.tabs ?? []).every((tab) => typeof tab.hostname === "string") &&
            localRecords.every((tab) =>
              tab.hostname === "127.0.0.1" &&
              typeof tab.path === "string" &&
              !tab.path.includes("?") &&
              !tab.path.includes("#")
            ),
          "The default provider request omitted safe hostname/route context.",
        );
      } catch (error) {
        console.error("MOCK-SERVER-REJECT", error instanceof Error ? error.message : error);
        response.writeHead(500, { "content-type": "application/json", "access-control-allow-origin": "*" });
        response.end(JSON.stringify({ error: "mock organizer request rejected" }));
        return;
      }
      const ids = (data.tabs ?? []).map((tab) => tab.id);
      const comparisonVariant = body.model === "popup-smoke-model-b";
      const largeProposalVariant = body.largeProposalSmoke === true;
      if (data.groupColorMode === "ai") state.sawAiGroupColorMode = true;
      const proposal = {
        schemaVersion: 1,
        groups: largeProposalVariant && ids.length >= 26
          ? Array.from({ length: 13 }, (_, index) => ({
              temporaryId: `large-group-${index + 1}`,
              title: `Large topic ${index + 1}`,
              color: data.groupColorMode === "ai" ? "blue" : null,
              tabIds: [ids[index * 2], ids[index * 2 + 1]],
            }))
          : comparisonVariant && ids.length >= 2
          ? [{ temporaryId: "mixed-one", title: "Mixed one", color: data.groupColorMode === "ai" ? "cyan" : null, tabIds: [ids[0], ids[1]] }]
          : ids.length >= 4
            ? [
                { temporaryId: "topic-a", title: "Topic A", color: data.groupColorMode === "ai" ? "orange" : null, tabIds: [ids[0], ids[2]] },
                { temporaryId: "topic-b", title: "Topic B", color: data.groupColorMode === "ai" ? "purple" : null, tabIds: [ids[1], ids[3]] },
              ]
            : [],
        untouchedTabIds: ids.slice(largeProposalVariant && ids.length >= 26
          ? 26
          : comparisonVariant && ids.length >= 2
            ? 2
            : ids.length >= 4
              ? 4
              : 0),
        lowValueTabIds: largeProposalVariant ? [] : ids.slice(ids.length >= 4 ? 4 : 0),
      };
      response.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      response.end(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(proposal) } }],
        usage: {
          prompt_tokens: body.model === "popup-smoke-model-b" ? 140 : 120,
          completion_tokens: 30,
          total_tokens: body.model === "popup-smoke-model-b" ? 170 : 150,
          prompt_tokens_details: { cached_tokens: body.model === "popup-smoke-model-b" ? 20 : 40 },
        },
      }));
    });
  });
  return { server, state };
}

export async function measureContrast(page, selectors = [
  ".review-group__meta",
  ".review-tab__copy span",
  ".commit-foot__line",
  ".cleanup-note span",
  ".button--primary",
]) {
  const ratios = await measureContrastRatios(page, selectors);
  const entries = Object.entries(ratios);
  // Math.min over an empty list is Infinity, which would pass the AA assert
  // vacuously; require every requested selector to have produced a ratio.
  assert(selectors.length > 0, "Contrast check needs at least one selector.");
  assert(entries.length === selectors.length, "Contrast check did not measure every selector.");
  const floor = Math.min(...entries.map(([, ratio]) => ratio));
  assert(Number.isFinite(floor), "Contrast floor is not a finite number.");
  assert(floor >= 4.5, `Popup contrast floor ${floor.toFixed(2)} is below WCAG AA.`);
  return floor;
}

export async function captureFullPageFromTop(page, path) {
  await page.evaluate(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.querySelectorAll(".utility-drawer__content, .action-primary").forEach((node) => {
      node.scrollTop = 0;
    });
  });
  await page.screenshot({ path, fullPage: true });
}

// Organize runs re-render the popup while the job is in flight, so a fixed
// one-shot wait races the render cycle. Worse, a re-render landing between a
// click's mousedown and mouseup swallows the activation entirely, leaving the
// popup idle forever. Poll to the terminal state instead — review heading or
// the popup's own error notice — and re-fire the trigger only while the run
// has not observably started ("Finding topics…" is the active button's busy
// label; the accessible name stays "Organize …" via aria-label).
export async function waitForOrganizeOutcome(page, headingName, trigger, description, timeoutMs = 60_000, pageErrors = []) {
  const heading = page.getByRole("heading", { name: headingName });
  const errorNotice = page.locator(".notice--error");
  await poll(
    async () => {
      const state = {
        reached: await heading.isVisible().catch(() => false),
        failed: await errorNotice.isVisible().catch(() => false),
        busy: await page.getByText("Finding topics…", { exact: true }).isVisible().catch(() => false),
      };
      if (!state.reached && !state.failed && !state.busy) {
        await trigger().catch(() => {});
      }
      if (Date.now() > (waitForOrganizeOutcome.lastDiagnostics ?? 0) + 5_000) {
        waitForOrganizeOutcome.lastDiagnostics = Date.now();
        console.log("[organize-wait]", JSON.stringify({
          ...state,
          errors: pageErrors,
          stored: await page.evaluate(async () => ({
            review: (await chrome.storage.session.get("proposalReviewSession")).proposalReviewSession?.status ?? null,
            workflow: (await chrome.storage.local.get("organizerLocalState")).organizerLocalState?.workflow ?? null,
          })).catch(() => "unreadable"),
          popup: (await page.locator("body").innerText().catch(() => "unreadable")).slice(0, 500),
        }));
      }
      return state;
    },
    (state) => state.reached || state.failed,
    description,
    timeoutMs,
  );
  if (!(await heading.isVisible().catch(() => false))) {
    const errorText = await errorNotice.innerText().catch(() => "no error notice rendered");
    assert(false, `${description} ended in an error notice: ${errorText}`);
  }
}
