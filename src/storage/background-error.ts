/** Owner recorded on provider jobs that the service worker runs for the popup. */
export const BACKGROUND_JOB_OWNER = "background";

const BACKGROUND_ERROR_KEY = "backgroundError";

export interface BackgroundError {
  message: string;
  at: number;
}

/**
 * Records a failure that happened with no page open to show it, and flags the
 * toolbar icon. The popup reads and clears it on its next open, so a badge never
 * appears without a message behind it.
 */
export async function reportBackgroundError(message: string): Promise<void> {
  try {
    await chrome.storage.session.set({
      [BACKGROUND_ERROR_KEY]: { message, at: Date.now() } satisfies BackgroundError,
    });
  } catch {
    // The badge below still tells the user something went wrong.
  }
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#8b2f2f" });
    await chrome.action.setBadgeText({ text: "!" });
  } catch {
    // Badge APIs can fail during shutdown; the stored message remains.
  }
}

export async function takeBackgroundError(): Promise<BackgroundError | null> {
  const values = await chrome.storage.session.get(BACKGROUND_ERROR_KEY);
  const stored = values[BACKGROUND_ERROR_KEY] as Partial<BackgroundError> | undefined;
  if (!stored) return null;
  await chrome.storage.session.remove(BACKGROUND_ERROR_KEY);
  const text = await chrome.action.getBadgeText({}).catch(() => "");
  if (text === "!") await chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
  return typeof stored.message === "string" && typeof stored.at === "number"
    ? { message: stored.message, at: stored.at }
    : null;
}
