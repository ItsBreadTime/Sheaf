import { isLoopbackProviderHostname } from "../shared/network-address";
import type {
  OpenAICompatibleConfig,
  OpenRouterProviderPreferences,
} from "../shared/organizer-types";

const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "host",
  "origin",
  "referer",
  "cookie",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const OWNED_BODY_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "response_format",
  "reasoning",
  "reasoning_effort",
  "provider",
  "temperature",
  "authorization",
  "deadline",
  "timeout",
]);

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const REASONING_OFF_METHODS = new Set([
  "auto", "reasoning_effort", "thinking", "enable_thinking", "chat_template_kwargs", "think", "no_think_prompt",
]);
const OPENROUTER_SORTS = new Set(["price", "throughput", "latency"]);
const OPENROUTER_DATA_COLLECTION = new Set(["allow", "deny"]);

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface NormalizedEndpoint {
  origin: string;
  endpointPath: string;
  url: string;
  permissionPattern: string;
}

/** The route a connection appends to a base URL: `/v1/chat/completions` → `/chat/completions`. */
export function providerRoute(defaultPath: string): string {
  return defaultPath.replace(/^\/v\d+(?=\/)/, "");
}

function normalizeRoute(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/[?#]|:\/\//.test(trimmed)) throw new Error("The API route must be a path, like /chat/completions.");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Settings take an API URL and an API route; storage keeps an origin and an
 * endpoint path. The route is appended to the URL unless the URL already ends
 * with it, so a full endpoint URL can be pasted as-is. A bare origin with the
 * connection's usual route gets its usual path (`/v1/chat/completions`). An
 * empty route means the URL is used exactly as typed.
 */
export function splitProviderUrl(
  input: string,
  route: string,
  defaultPath: string,
): { origin: string; endpointPath: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter the API URL, like https://api.openai.com/v1.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`"${trimmed}" isn't a full URL. Include https://, like https://api.openai.com/v1.`);
  }
  if (url.search || url.hash) throw new Error("The API URL can't contain a query or fragment.");
  const path = url.pathname.replace(/\/+$/, "");
  const suffix = normalizeRoute(route);
  const endpointPath = !suffix
    ? path || "/"
    : !path && suffix === providerRoute(defaultPath)
      ? defaultPath
      : path.endsWith(suffix) ? path : `${path}${suffix}`;
  return { origin: url.origin, endpointPath };
}

/**
 * The URL and route fields for a stored connection: the usual route is shown
 * split off a base URL; any other path is shown whole, with no route.
 */
export function displayProviderUrl(
  origin: string,
  endpointPath: string,
  defaultPath: string,
): { url: string; route: string } {
  const base = origin.trim().replace(/\/+$/, "");
  const route = providerRoute(defaultPath);
  if (endpointPath.endsWith(route) && endpointPath.length > route.length) {
    return { url: `${base}${endpointPath.slice(0, -route.length)}`, route };
  }
  return { url: `${base}${endpointPath}`, route: "" };
}

export function joinProviderUrl(origin: string, endpointPath: string): string {
  return `${origin.trim().replace(/\/+$/, "")}${endpointPath.trim()}`;
}

export function isOpenRouterOrigin(originInput: string): boolean {
  try {
    const hostname = new URL(originInput.trim()).hostname.toLowerCase();
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

export function normalizeOpenRouterPreferences(
  value: OpenRouterProviderPreferences | undefined,
): OpenRouterProviderPreferences | undefined {
  if (value === undefined) return undefined;
  if (value.zdr !== undefined && typeof value.zdr !== "boolean") {
    throw new Error("OpenRouter ZDR must be a boolean.");
  }
  if (value.order !== undefined && (
    !Array.isArray(value.order) || value.order.some((provider) => typeof provider !== "string")
  )) {
    throw new Error("OpenRouter provider order must be a list of provider slugs.");
  }
  if (value.allowFallbacks !== undefined && typeof value.allowFallbacks !== "boolean") {
    throw new Error("OpenRouter fallback policy must be a boolean.");
  }
  if (value.requireParameters !== undefined && typeof value.requireParameters !== "boolean") {
    throw new Error("OpenRouter require-parameters setting must be a boolean.");
  }
  const order = value.order === undefined
    ? undefined
    : [...new Set(value.order.map((provider) => provider.trim()).filter(Boolean))];
  if (order && (order.length > 32 || order.some((provider) => provider.length > 100))) {
    throw new Error("OpenRouter provider order must contain at most 32 provider slugs of 100 characters or fewer.");
  }
  if (value.sort !== undefined && !OPENROUTER_SORTS.has(value.sort)) {
    throw new Error("OpenRouter sort must be price, throughput, or latency.");
  }
  if (value.dataCollection !== undefined && !OPENROUTER_DATA_COLLECTION.has(value.dataCollection)) {
    throw new Error("OpenRouter data collection must be allow or deny.");
  }
  const normalized: OpenRouterProviderPreferences = {
    ...(value.zdr === true ? { zdr: true } : {}),
    ...(order?.length ? { order } : {}),
    ...(value.sort === undefined ? {} : { sort: value.sort }),
    ...(value.allowFallbacks === undefined ? {} : { allowFallbacks: value.allowFallbacks }),
    ...(value.dataCollection === undefined ? {} : { dataCollection: value.dataCollection }),
    ...(value.requireParameters === true ? { requireParameters: true } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function openRouterProviderBody(
  value: OpenRouterProviderPreferences | undefined,
): Record<string, unknown> | undefined {
  const preferences = normalizeOpenRouterPreferences(value);
  if (!preferences) return undefined;
  return {
    ...(preferences.zdr === undefined ? {} : { zdr: preferences.zdr }),
    ...(preferences.order === undefined ? {} : { order: preferences.order }),
    ...(preferences.sort === undefined ? {} : { sort: preferences.sort }),
    ...(preferences.allowFallbacks === undefined ? {} : { allow_fallbacks: preferences.allowFallbacks }),
    ...(preferences.dataCollection === undefined ? {} : { data_collection: preferences.dataCollection }),
    ...(preferences.requireParameters === undefined ? {} : { require_parameters: preferences.requireParameters }),
  };
}

export function normalizeProviderEndpoint(
  originInput: string,
  endpointPathInput: string,
): NormalizedEndpoint {
  let originUrl: URL;
  try {
    originUrl = new URL(originInput.trim());
  } catch {
    throw new Error("Provider origin must be a full URL, like https://api.openai.com.");
  }
  if (originUrl.username || originUrl.password) {
    throw new Error("Embedded provider URL credentials are not allowed.");
  }
  if (originUrl.pathname !== "/" || originUrl.search || originUrl.hash) {
    throw new Error("Provider origin must not contain a path, query, or fragment.");
  }
  const localHttp = originUrl.protocol === "http:" && isLoopbackProviderHostname(originUrl.hostname);
  if (originUrl.protocol !== "https:" && !localHttp) {
    throw new Error("HTTPS is required except for localhost and loopback providers.");
  }

  const endpointUrl = new URL(endpointPathInput.trim(), originUrl.origin);
  if (endpointUrl.origin !== originUrl.origin) {
    throw new Error("Endpoint path must remain on the configured provider origin.");
  }
  if (!endpointPathInput.trim().startsWith("/")) {
    throw new Error("Endpoint path must begin with /.");
  }
  if (endpointUrl.search || endpointUrl.hash) {
    throw new Error("Endpoint path must not contain a query or fragment.");
  }
  return {
    origin: originUrl.origin,
    endpointPath: endpointUrl.pathname,
    url: endpointUrl.href,
    // Chromium host match patterns cannot express ports. Permission is
    // therefore narrowed to scheme + host, while endpoint validation below
    // continues to enforce the exact configured origin including its port.
    permissionPattern: `${originUrl.protocol}//${originUrl.hostname}/*`,
  };
}

export function normalizeCustomHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (!HEADER_NAME.test(name)) throw new Error(`Invalid custom header name: ${rawName}`);
    if (FORBIDDEN_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("sec-")) {
      throw new Error(`Custom header ${rawName} is controlled by the adapter.`);
    }
    if (/\r|\n/.test(rawValue)) {
      throw new Error(`Custom header ${rawName} contains a line break.`);
    }
    normalized[name] = rawValue.slice(0, 4096);
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function validateJsonValue(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers.`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} contains an unsupported value.`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateJsonValue(child, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`${path} contains dangerous key ${key}.`);
      validateJsonValue(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

/** Rejects non-JSON values, cycles, and prototype keys in a user-supplied body. */
export function validateJsonBody(value: Record<string, unknown>, path: string): void {
  validateJsonValue(value, path, new WeakSet());
}

export function validateExtraBody(extraBody: Record<string, unknown>): void {
  for (const key of Object.keys(extraBody)) {
    if (OWNED_BODY_KEYS.has(key.toLowerCase())) {
      throw new Error(`Extra body cannot override adapter-owned field ${key}.`);
    }
  }
  validateJsonValue(extraBody, "extraBody", new WeakSet());
}

export function normalizeProviderConfig(
  config: OpenAICompatibleConfig,
): OpenAICompatibleConfig {
  const endpoint = normalizeProviderEndpoint(config.origin, config.endpointPath);
  if (!config.model.trim()) throw new Error("Provider model is required.");
  if (
    config.temperature !== undefined &&
    (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)
  ) {
    throw new Error("Temperature must be between 0 and 2.");
  }
  validateExtraBody(config.extraBody);
  if (config.reasoning !== undefined) {
    validateJsonValue(config.reasoning, "reasoning", new WeakSet());
  }
  if (config.reasoningEffort !== undefined && !REASONING_EFFORTS.has(config.reasoningEffort)) {
    throw new Error("Reasoning effort must be none, minimal, low, medium, high, or xhigh.");
  }
  if (config.reasoningOffMethod !== undefined && !REASONING_OFF_METHODS.has(config.reasoningOffMethod)) {
    throw new Error("Unknown way to turn reasoning off.");
  }
  const openRouter = normalizeOpenRouterPreferences(config.openRouter);
  return {
    ...config,
    origin: endpoint.origin,
    endpointPath: endpoint.endpointPath,
    model: config.model.trim().slice(0, 200),
    customHeaders: normalizeCustomHeaders(config.customHeaders),
    openRouter,
    manualStreamingEnabled: false,
  };
}
