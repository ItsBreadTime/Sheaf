// Turns provider failures into sentences a person can act on. The raw response
// body never reaches the UI: only the provider's own `error.message` survives,
// trimmed, with anything that looks like a key masked and HTML discarded.

const MAX_DETAIL_CHARS = 200;
const ORGANIZER_SETTINGS = "Settings → Providers → Organizer provider";
const EMBEDDING_SETTINGS = "Settings → Providers → Embedding provider";

/** The provider's own explanation from an error body, or null when there is none worth showing. */
export function providerErrorDetail(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed || /^<(!doctype|html|head|body)\b/i.test(trimmed)) return null;
  let text: string | null = null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    text = findMessage(parsed);
  } catch {
    // A short plain-text body is often the most useful thing a proxy says.
    text = trimmed.length <= MAX_DETAIL_CHARS && !/[{}<>]/.test(trimmed) ? trimmed : null;
  }
  if (!text) return null;
  const clean = text
    .replace(/\b(sk|rk|pk|or|key)[-_][A-Za-z0-9_*-]{6,}/gi, "[key]")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  return clean.length > MAX_DETAIL_CHARS ? `${clean.slice(0, MAX_DETAIL_CHARS - 1)}…` : clean;
}

function findMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["error", "message", "detail", "error_description"]) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found;
    if (found && typeof found === "object") {
      const nested = findMessage(found);
      if (nested) return nested;
    }
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the provider";
  }
}

/** Seconds until a retry is sensible, from `Retry-After` in either form, or null. */
export function retryAfterSeconds(retryAfter: string | null, now = Date.now()): number | null {
  if (!retryAfter?.trim()) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1_000));
}

function waitPhrase(seconds: number | null): string {
  if (seconds === null) return "Try again in a minute.";
  if (seconds <= 1) return "Try again now.";
  if (seconds < 90) return `Try again in ${seconds} seconds.`;
  return `Try again in about ${Math.round(seconds / 60)} minutes.`;
}

export function describeProviderHttpError(options: {
  status: number;
  endpointUrl: string;
  model: string;
  detail: string | null;
  retryAfter: string | null;
  /** Where the user fixes this provider's settings. */
  settingsPath?: string;
}): string {
  const { status, detail } = options;
  const said = detail ? ` The provider said: “${detail}”` : "";
  const settings = options.settingsPath ?? ORGANIZER_SETTINGS;
  if (status === 401 || status === 403) {
    return `The provider rejected the API key (HTTP ${status}). Check the key in ${settings}, then save and verify again.`;
  }
  if (status === 402) {
    return `The provider account is out of credit (HTTP 402). Add credit, or switch provider in ${settings}.`;
  }
  if (status === 404) {
    return `The provider couldn't find model “${options.model}” or the endpoint path (HTTP 404). Check both in ${settings}.${said}`;
  }
  if (status === 408) {
    return `The provider timed out (HTTP 408). ${waitPhrase(null)}`;
  }
  if (status === 429) {
    return `The provider is rate-limiting requests (HTTP 429). ${waitPhrase(retryAfterSeconds(options.retryAfter))}`;
  }
  if (status >= 500) {
    return `${hostOf(options.endpointUrl)} had a server error (HTTP ${status}). ${waitPhrase(retryAfterSeconds(options.retryAfter))}`;
  }
  if (status === 400 || status === 422) {
    return `The provider rejected the request (HTTP ${status}).${said || ` Check the model and any extra request options in ${settings}.`}`;
  }
  return `The provider returned HTTP ${status}.${said}`;
}

export function describeNetworkFailure(endpointUrl: string, settingsPath = ORGANIZER_SETTINGS): string {
  return `Couldn't reach ${hostOf(endpointUrl)}. Check your connection or VPN, and the provider origin in ${settingsPath}.`;
}

/**
 * Readable text for an embedding-provider test failure. The embedding client
 * keeps its errors terse so they classify cleanly; this adds the remedy.
 */
export function describeEmbeddingTestFailure(error: unknown, endpointUrl: string, model: string): string {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number" && error.status >= 400) {
    const retryAfter = "retryAfter" in error && typeof error.retryAfter === "string" ? error.retryAfter : null;
    return describeProviderHttpError({
      status: error.status,
      endpointUrl,
      model,
      detail: null,
      retryAfter,
      settingsPath: EMBEDDING_SETTINGS,
    });
  }
  if (error instanceof TypeError) return describeNetworkFailure(endpointUrl, EMBEDDING_SETTINGS);
  return error instanceof Error ? error.message : "The embedding provider did not answer.";
}
