import { element } from "../shared/helpers";

/**
 * One save indicator for every setting that saves on change, shown once in the
 * settings sidebar. Sections no longer carry their own "Saving…" lines or
 * success toasts; connections keep their explicit Save and verify.
 *
 * The page is rebuilt on every render, so the state lives here and the
 * indicator is repainted from it.
 */

type SaveState = "idle" | "saving" | "saved" | "error";

const TEXT: Record<Exclude<SaveState, "error">, string> = {
  idle: "Changes save automatically",
  saving: "Saving…",
  saved: "All changes saved",
};

let state: SaveState = "idle";
let errorText = "";
let node: HTMLElement | null = null;

function paint(): void {
  if (!node) return;
  node.className = `settings-autosave settings-save-status settings-autosave--${state}`;
  node.textContent = state === "error" ? errorText : TEXT[state];
}

export function settingsSaveStatus(): HTMLElement {
  node = element("p");
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  paint();
  return node;
}

export function markSettingsSaving(): void {
  state = "saving";
  paint();
}

export function markSettingsSaved(): void {
  state = "saved";
  paint();
}

export function markSettingsError(text: string): void {
  state = "error";
  errorText = text;
  paint();
}

/** Runs one autosave, reflecting it in the indicator; errors still reach the caller. */
export async function trackSettingsSave(save: () => Promise<void>): Promise<void> {
  markSettingsSaving();
  try {
    await save();
    markSettingsSaved();
  } catch (error) {
    markSettingsError(error instanceof Error ? error.message : "Changes need attention.");
    throw error;
  }
}
