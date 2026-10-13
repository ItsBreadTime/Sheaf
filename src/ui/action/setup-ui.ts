import { popupState } from "./popup-store";
import {
  invalidatePlanAfterSettingsChange,
  REQUEST_DETAIL_OPTIONS,
  renderLiveRequestPreview,
  renderOrganizerConnection,
  settingsContext,
} from "./settings-ui";
import { element } from "../shared/helpers";
import { writePrivacySettings, writeWorkflowSettings } from "../../storage/organizer-state";
import type { PrivacySettings } from "../../shared/organizer-types";

/**
 * First-run setup (action.html?view=setup): three short steps that cover what
 * a new user must decide before the first Organize. It opens on install and
 * from the popup, and reuses the Settings components, so a choice made here
 * looks the same when it's changed later in Settings.
 */

const STEPS = [
  { title: "Connect a model", short: "Connect" },
  { title: "Choose what's sent", short: "What's sent" },
  { title: "You're ready", short: "Done" },
] as const;

// Survives the page's re-renders (every save redraws it).
let step = 0;
let focusHeading = false;

function goTo(next: number): void {
  step = next;
  focusHeading = true;
  window.scrollTo({ top: 0 });
  settingsContext().render();
}

function closeSetup(): void {
  void chrome.tabs.getCurrent().then((tab) => {
    if (tab?.id !== undefined) return chrome.tabs.remove(tab.id);
  });
}

function renderProgress(): HTMLElement {
  const list = element("ol", "setup-progress");
  list.setAttribute("aria-label", "Setup steps");
  STEPS.forEach((item, index) => {
    const state = index < step ? "done" : index === step ? "current" : "upcoming";
    const entry = element("li", `setup-progress__step setup-progress__step--${state}`);
    if (index === step) entry.setAttribute("aria-current", "step");
    entry.append(
      element("span", "setup-progress__number", String(index + 1)),
      element("span", "setup-progress__label", item.short),
    );
    list.append(entry);
  });
  return list;
}

function renderConnectStep(body: HTMLElement, actions: HTMLElement): void {
  const { button } = settingsContext();
  body.append(
    element(
      "p",
      "settings-category__copy",
      "Sheaf asks an AI model to propose groups from your tab titles. Any OpenAI-compatible service works: OpenAI, OpenRouter, or a local server like Ollama or LM Studio. Paste its API URL, a model name, and a key.",
    ),
    renderOrganizerConnection({
      open: true,
      onVerified: () => {
        step = 1;
        focusHeading = true;
      },
    }),
  );
  const ready = popupState.providerReady;
  if (!ready) {
    actions.append(button("Skip for now", "quiet", () => {
      goTo(1);
    }));
  }
  actions.append(button("Continue", "primary", () => {
    goTo(1);
  }, { disabled: !ready }));
}

function renderPrivacyStep(body: HTMLElement, actions: HTMLElement): void {
  const { button, check, perform } = settingsContext();
  const data = popupState.organizerData!;
  const privacy = data.local.privacy;
  const workflow = data.local.workflow;
  body.append(
    element(
      "p",
      "settings-category__copy",
      "Only sanitized tab titles and addresses leave the browser, never page contents. Choose how much address detail helps grouping. The preview shows exactly what this window would send.",
    ),
  );

  const save = (next: { level?: PrivacySettings["level"]; organizeWithoutReview?: boolean }): void => {
    void perform("setup-preferences", async () => {
      const current = popupState.organizerData!.local;
      if (next.level !== undefined && next.level !== current.privacy.level) {
        await writePrivacySettings({ ...current.privacy, level: next.level });
      }
      popupState.organizerData = await writeWorkflowSettings({
        ...current.workflow,
        organizeWithoutReview: next.organizeWithoutReview ?? current.workflow.organizeWithoutReview,
      });
      if (next.level !== undefined) await invalidatePlanAfterSettingsChange();
    });
  };

  const levels = element("fieldset", "settings-group setup-choice");
  levels.append(element("legend", undefined, "Request detail"));
  REQUEST_DETAIL_OPTIONS.forEach(([value, label, help]) => {
    const option = element("label", "check");
    const radio = element("input");
    radio.type = "radio";
    radio.name = "setup-request-detail";
    radio.value = String(value);
    radio.checked = value === privacy.level;
    radio.addEventListener("change", () => save({ level: value }));
    const text = element("span");
    text.append(element("strong", undefined, label), element("small", undefined, help));
    option.append(radio, text);
    levels.append(option);
  });
  body.append(levels, renderLiveRequestPreview());

  const review = element("section", "settings-group");
  const skipReview = check(
    "Organize without review",
    "Applies each plan right away; Undo is always one click away. Turn off to review every plan before anything moves.",
    workflow.organizeWithoutReview,
  );
  skipReview.control.addEventListener("change", () => save({ organizeWithoutReview: skipReview.control.checked }));
  review.append(element("h3", undefined, "When you organize"), skipReview.wrapper);
  body.append(review);

  actions.append(
    button("Back", "quiet", () => {
      goTo(0);
    }),
    button("Continue", "primary", () => {
      goTo(2);
    }),
  );
}

function renderDoneStep(body: HTMLElement, actions: HTMLElement): void {
  const { button, fullExtensionPageUrl, lineIcon, renderShortcutSettings } = settingsContext();
  body.append(
    element(
      "p",
      "settings-category__copy",
      popupState.providerReady
        ? "Click the Sheaf icon in the toolbar and choose Organize. Every change can be undone."
        : "Organize stays unavailable until you connect a model. You can do that now or later in Settings → Connections.",
    ),
  );

  const extras = element("section", "settings-group");
  extras.append(
    element("h3", undefined, "Optional extras"),
    element("p", "settings-group__copy", "Both are off until you turn them on in Settings."),
  );
  const links = element("div", "settings-tool-links");
  ([
    ["Semantic search", "Find tabs by meaning, not just matching words. Needs an embeddings model.", "search"],
    ["Auto-filing", "File new tabs into your existing groups as you browse.", "auto-filing"],
  ] as const).forEach(([title, detail, section]) => {
    const link = element("a", "settings-tool-link");
    link.href = `${fullExtensionPageUrl("settings")}#${section}`;
    link.append(element("span", undefined, title), element("small", undefined, detail), lineIcon(["m9.5 6 6 6-6 6"]));
    links.append(link);
  });
  extras.append(links);

  const pin = element("section", "settings-group");
  pin.append(
    element("h3", undefined, "Keep Sheaf in reach"),
    element("p", "settings-group__copy", "Open the puzzle-piece menu in the toolbar and pin Sheaf, or use a keyboard shortcut."),
  );
  body.append(extras, pin, renderShortcutSettings());

  actions.append(
    button("Back", "quiet", () => {
      goTo(1);
    }),
  );
  if (!popupState.providerReady) {
    actions.append(button("Connect a model", "secondary", () => {
      goTo(0);
    }));
  }
  actions.append(button("Finish", "primary", closeSetup));
}

export function renderSetup(shell: HTMLElement): void {
  if (!popupState.organizerData) return;
  const page = element("div", "setup");
  const section = element("section", "settings-category setup-step");
  section.id = `setup-step-${step + 1}`;
  const heading = element("h2", undefined, STEPS[step]!.title);
  heading.setAttribute("tabindex", "-1");
  section.append(
    element("p", "setup-step__count", `Step ${step + 1} of ${STEPS.length}`),
    heading,
  );
  const actions = element("div", "setup-actions");
  if (step === 0) renderConnectStep(section, actions);
  else if (step === 1) renderPrivacyStep(section, actions);
  else renderDoneStep(section, actions);
  page.append(renderProgress(), section, actions);
  const panel = element("section", "settings-panel");
  panel.append(page);
  shell.append(panel);
  if (focusHeading) {
    focusHeading = false;
    requestAnimationFrame(() => heading.focus({ preventScroll: true }));
  }
}
