import { LIMITS } from "../shared/limits";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_FORMATTING = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const LONG_NUMERIC_ID = /\d{6,}/g;
const HIGH_ENTROPY = /[A-Za-z0-9_-]{16,}/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// A query string or fragment runs from "?"/"#" to the next whitespace. Titles
// copy the address bar verbatim, so this is where session tokens live; the old
// guard only recognised fully-formed URLs and let "Checkout?session=…" through.
const QUERY_OR_FRAGMENT = /[?#]\S*/g;
const URL_SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
const IPV4_LITERAL = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6_LITERAL = /\[[0-9a-f:.]+\]/i;
// A port only follows a host, never a clock time or a ratio, so require a
// recognisable host shape (localhost or a dotted name) before the colon.
const HOST_WITH_PORT =
  /(?:^|[\s("'[<])(?:localhost|(?:[^\s:/?#@]+\.)+[^\s:/?#@]+):\d{2,5}(?:[/?#]|$)/i;
// Any dotted token at a token boundary followed by a path, query, fragment, or
// the end. Matches non-ASCII hosts ("пример.рф/…") that have no dotted ASCII TLD.
const DOTTED_HOST =
  /(?:^|[\s("'[<:])(?:[^\s:/?#@]+\.)+[^\s:/?#@]+(?:[/?#]|$)/;

function looksLikeUrl(value: string): boolean {
  return (
    URL_SCHEME.test(value) ||
    IPV4_LITERAL.test(value) ||
    IPV6_LITERAL.test(value) ||
    HOST_WITH_PORT.test(value) ||
    DOTTED_HOST.test(value)
  );
}

export function sanitizeText(value: string, maxChars: number): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(BIDI_FORMATTING, "")
    .replace(/\s+/g, " ")
    .trim();
  // Truncate by code points, not UTF-16 units, so a cap never splits a
  // surrogate pair and leaves a lone half-character.
  return Array.from(cleaned).slice(0, maxChars).join("");
}

export function redactSensitiveIdentifiers(value: string): string {
  return value
    .replace(EMAIL, ":email")
    .replace(UUID, ":uuid")
    .replace(LONG_NUMERIC_ID, ":number")
    .replace(HIGH_ENTROPY, (candidate) => {
      const hasLetters = /[A-Za-z]/.test(candidate);
      const hasDigits = /\d/.test(candidate);
      const looksOpaqueHex = /^[0-9a-f]{24,}$/i.test(candidate);
      const parts = candidate.split(/[-_]/).filter(Boolean);
      const looksReadableSlug = parts.length > 1 && parts.every(
        (part) => /^[A-Za-z]{2,}$/.test(part) || /^\d{1,5}$/.test(part),
      );
      if (looksReadableSlug) return candidate;
      return (hasLetters && hasDigits) || looksOpaqueHex ? ":token" : candidate;
    });
}

export function sanitizeTabTitle(value: string): string {
  return sanitizeText(value, LIMITS.MAX_TAB_TITLE_CHARS) || "Untitled tab";
}

export function sanitizeTabTitleForProvider(
  value: string,
  safeLocationLabel: string,
): string {
  const title = sanitizeTabTitle(value);
  if (looksLikeUrl(title)) {
    return sanitizeText(safeLocationLabel, LIMITS.MAX_TAB_TITLE_CHARS) || "Untitled tab";
  }
  return sanitizeText(
    redactSensitiveIdentifiers(title.replace(QUERY_OR_FRAGMENT, "")),
    LIMITS.MAX_TAB_TITLE_CHARS,
  ) || "Untitled tab";
}

export function sanitizeGroupTitle(
  value: string,
  maxChars: number = LIMITS.MAX_GROUP_TITLE_CHARS,
): string {
  return sanitizeText(value, maxChars);
}

/** A group title a provider may see: identifiers are redacted on top of the
 * usual cleaning, since a title can carry a client or codename. */
export function sanitizeGroupTitleForProvider(
  value: string,
  maxChars: number = LIMITS.MAX_GROUP_TITLE_CHARS,
): string {
  return sanitizeText(redactSensitiveIdentifiers(value), maxChars);
}

/** Free text a provider may see, such as the search box contents. */
export function redactQueryText(value: string): string {
  return redactSensitiveIdentifiers(value.normalize("NFKC").trim());
}
