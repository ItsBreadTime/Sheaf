import { getDomain } from "tldts";
import { LIMITS } from "../shared/limits";
import type { PrivacyLevel } from "../shared/organizer-types";
import type { LocationMutationPolicy } from "../browser/domain-policy";
import { redactSensitiveIdentifiers, sanitizeText } from "./sanitize-text";

export interface SanitizedLocation {
  hostname: string;
  domain: string;
  path?: string;
}

function sanitizePathSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep the encoded segment when malformed escapes prevent decoding.
  }
  decoded = decoded.replace(/[\\/?#]/g, " ");
  decoded = redactSensitiveIdentifiers(decoded);
  return sanitizeText(decoded, LIMITS.MAX_PATH_CHARS);
}

function sanitizedPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => sanitizePathSegment(segment))
    .join("/");
}

export function sanitizePublicLocation(
  rawUrl: string,
  privacyLevel: PrivacyLevel,
  policy: LocationMutationPolicy = {
    allowLocalNetworkTabs: false,
    allowFileTabs: false,
  },
): SanitizedLocation {
  const url = new URL(rawUrl);
  if (url.protocol === "file:" && policy.allowFileTabs) {
    return { hostname: "local-file", domain: "local-file" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only allowed HTTP(S) or local-file tab locations can be submitted.");
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const domain =
    getDomain(hostname, { allowPrivateDomains: true }) ??
    (policy.allowLocalNetworkTabs ? hostname : null);
  if (!domain) {
    throw new Error("A registrable public domain could not be derived.");
  }
  const result: SanitizedLocation = { hostname, domain };
  if (privacyLevel === 2) {
    result.path = sanitizeText(
      sanitizedPath(url.pathname),
      LIMITS.MAX_PATH_CHARS,
    );
  } else if (privacyLevel === 3) {
    // Level 3 keeps the path exactly as the address bar shows it, but the
    // identifier redaction level 2 gets still applies.
    result.path = sanitizeText(redactSensitiveIdentifiers(url.pathname), LIMITS.MAX_PATH_CHARS);
  }
  return result;
}
