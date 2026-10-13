import type { OrganizerStoredState, OpenAICompatibleConfig } from "../../shared/organizer-types";
import type { WindowCaptureMessage } from "../../shared/types";
import type { WindowCaptureResponseFor } from "../../shared/message-state";
import { computeProviderFingerprint } from "../../provider/fingerprint";

// Primitives shared by the action popup's modules. Each module owns its own
// state; these helpers take that state as a parameter so they stay leaf
// consumers of one definition.

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function send<Message extends WindowCaptureMessage>(message: Message): Promise<WindowCaptureResponseFor<Message>> {
  return chrome.runtime.sendMessage(message) as Promise<WindowCaptureResponseFor<Message>>;
}

export function currentProviderConfig(state: OrganizerStoredState | null): OpenAICompatibleConfig | null {
  if (!state) return null;
  return {
    ...state.local.provider,
    customHeaders: state.session.customHeaders,
  };
}

export async function isProviderReady(state: OrganizerStoredState | null): Promise<boolean> {
  const config = currentProviderConfig(state);
  const connectionTest = state?.local.connectionTest;
  if (!config || !connectionTest) return false;
  try {
    return (await computeProviderFingerprint(config, connectionTest.capabilities)) === connectionTest.fingerprint;
  } catch {
    return false;
  }
}

export function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { throw new Error(`${label} must be valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function parseStringRecord(value: string, label: string): Record<string, string> {
  const parsed = parseJsonObject(value, label);
  if (Object.values(parsed).some((item) => typeof item !== "string")) {
    throw new Error(`${label} values must all be strings.`);
  }
  return parsed as Record<string, string>;
}

// Appended to both request previews so the two surfaces cannot disagree about
// what privacy level 3 lets leave the device.
export function privacyLevelCaveat(level: number): string {
  return level === 3
    ? " Level 3 sends the full URL path; tokens, emails, and similar identifiers in it are redacted, but any other words in the path leave the device as-is."
    : "";
}

/** Up to three conflict lines inline, then a count, so a notice stays readable. */
export function listConflicts(conflicts: readonly string[]): string {
  const unique = [...new Set(conflicts.map((line) => line.trim()).filter(Boolean))];
  const shown = unique.slice(0, 3).join(" ");
  const rest = unique.length - 3;
  return rest > 0 ? `${shown} ${rest} more in Diagnostics.` : shown;
}

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", then an absolute date. */
export function relativeAge(timestamp: number, now = Date.now()): string {
  const minutes = Math.round((now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return relativeTimeFormat.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relativeTimeFormat.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return relativeTimeFormat.format(-days, "day");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(timestamp);
}
