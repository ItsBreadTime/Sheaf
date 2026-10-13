import { isLocalNetworkHostname } from "../shared/network-address";

const PROTECTED_SCHEMES = new Set([
  "about:",
  "blob:",
  "brave:",
  "chrome:",
  "chrome-extension:",
  "data:",
  "devtools:",
  "edge:",
  "file:",
  "helium:",
  "view-source:",
]);

export interface LocationMutationPolicy {
  allowLocalNetworkTabs: boolean;
  allowFileTabs: boolean;
}

export const DEFAULT_LOCATION_MUTATION_POLICY: LocationMutationPolicy = {
  allowLocalNetworkTabs: false,
  allowFileTabs: false,
};

export function getProtectedLocationReason(
  rawUrl: string,
  policy: LocationMutationPolicy = DEFAULT_LOCATION_MUTATION_POLICY,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "URL is unavailable or unreadable";
  }

  if (parsed.protocol === "file:" && policy.allowFileTabs) {
    return null;
  }

  if (PROTECTED_SCHEMES.has(parsed.protocol)) {
    return `Protected location (${parsed.protocol})`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported location (${parsed.protocol})`;
  }

  if (isLocalNetworkHostname(parsed.hostname)) {
    return policy.allowLocalNetworkTabs
      ? null
      : "Local or private-network location";
  }

  return null;
}

const BLANK_NEW_TAB_URLS = new Set([
  "about:blank",
  "brave://newtab/",
  "chrome://new-tab-page/",
  "chrome://newtab/",
  "edge://newtab/",
  "helium://newtab/",
]);

export function isBlankNewTabUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const normalized = `${url.protocol}//${url.host}${url.pathname}`;
    return BLANK_NEW_TAB_URLS.has(rawUrl) || BLANK_NEW_TAB_URLS.has(normalized);
  } catch {
    return false;
  }
}
