import { getPrivacyExclusionReason, normalizeDomainRules } from "../privacy/domain-policy";
import { sanitizePublicLocation } from "../privacy/sanitize-url";
import { sanitizeGroupTitleForProvider, sanitizeTabTitleForProvider } from "../privacy/sanitize-text";
import { LIMITS } from "../shared/limits";
import type { PrivacySettings } from "../shared/organizer-types";
import type { EmbeddingConfig } from "../shared/search-types";
import type { SemanticIndexTarget } from "../shared/semantic-index-types";
import { EMBEDDING_MODEL_PROFILE_VERSION } from "./model-profiles";

export const SEMANTIC_DOCUMENT_FORMAT_VERSION = 3;
// Version 3: group titles and level-3 paths get identifier redaction.
const SEMANTIC_SANITIZER_VERSION = 3;

/**
 * The semantic index answers to the search consent, not to the organizer's.
 *
 * `includeExistingGroups` in the organizer privacy settings decides what the
 * *organizer prompt* may contain. Group titles in the tab-search index are a
 * different promise, with their own opt-in, so the index must not follow the
 * organizer flag in either direction: turning the organizer flag on must not
 * silently start sending group titles to the embedding provider, and turning it
 * off must not churn the index. Folding the search flag into the view also means
 * the compatibility key — which hashes this view — invalidates exactly when the
 * search consent changes, and not when the organizer setting does.
 */
export function semanticDocumentPrivacy(
  privacy: PrivacySettings,
  semanticIncludeGroupNames: boolean,
): PrivacySettings {
  return privacy.includeExistingGroups === semanticIncludeGroupNames
    ? privacy
    : { ...privacy, includeExistingGroups: semanticIncludeGroupNames };
}

/**
 * Cosmetic normalisation, applied after sanitisation and redaction.
 *
 * Rank stability tracks document-text changes almost exactly: a page that only
 * changes letter case or gains a trailing slash still produces different document
 * text, and so a different vector and score. Letter case and a trailing slash
 * carry no meaning for tab search, so removing them here means a cosmetic page
 * edit no longer changes the document text, the vector, the document hash, or the
 * score.
 *
 * `toLowerCase` is deliberate rather than `toLocaleLowerCase`: the output is
 * hashed and persisted, and locale-dependent case folding (Turkish dotless i, for
 * example) would make the same tab hash differently on different machines.
 */
function normalizeSemanticText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** `/a/b/` and `/a//b` address the same resource as `/a/b`. */
function normalizeSemanticPath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

export interface SemanticDocumentSource {
  mappingKey: string;
  target: SemanticIndexTarget;
  title: string;
  url: string;
  groupName: string | null;
}

export type SemanticDocumentResult =
  | { status: "ready"; mappingKey: string; target: SemanticIndexTarget; document: string }
  | { status: "excluded"; mappingKey: string; target: SemanticIndexTarget; errorCode: string };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function computeSemanticDocumentHash(document: string): Promise<string> {
  return sha256(document);
}

export function buildSemanticDocument(
  tab: SemanticDocumentSource,
  privacy: PrivacySettings,
): SemanticDocumentResult {
  try {
    const location = sanitizePublicLocation(tab.url, privacy.level, privacy);
    const exclusion = getPrivacyExclusionReason(location.hostname, location.domain, privacy);
    if (exclusion) return { status: "excluded", mappingKey: tab.mappingKey, target: tab.target, errorCode: "privacy_rule" };
    const safeTitleLocation = privacy.level === 1
      ? location.domain
      : `${location.hostname}${location.path ?? ""}`;
    const lines = [
      `Title: ${normalizeSemanticText(sanitizeTabTitleForProvider(tab.title, safeTitleLocation))}`,
      `Host: ${normalizeSemanticText(privacy.level === 1 ? location.domain : location.hostname)}`,
      ...(location.path
        ? [`Path: ${normalizeSemanticPath(normalizeSemanticText(location.path))}`]
        : []),
    ];
    const group = privacy.includeExistingGroups && tab.groupName
      ? normalizeSemanticText(sanitizeGroupTitleForProvider(tab.groupName, LIMITS.MAX_SEARCH_GROUP_TITLE_CHARS))
      : "";
    if (group) lines.push(`Group: ${group}`);
    return { status: "ready", mappingKey: tab.mappingKey, target: tab.target, document: lines.join("\n") };
  } catch {
    return { status: "excluded", mappingKey: tab.mappingKey, target: tab.target, errorCode: "unsupported_location" };
  }
}

export async function computeSemanticCompatibilityKey(
  config: EmbeddingConfig,
  privacy: PrivacySettings,
  resolvedDimensions: number | null = config.dimensions,
): Promise<string> {
  return sha256(JSON.stringify(stableValue({
    provider: {
      origin: config.origin,
      endpointPath: config.endpointPath,
      model: config.model,
      dimensions: resolvedDimensions,
      customHeaders: Object.fromEntries(Object.entries(config.customHeaders)
        .map(([name, value]) => [name.toLocaleLowerCase().trim(), value] as const)
        .sort(([left], [right]) => left.localeCompare(right))),
      extraBody: config.extraBody,
      openRouter: config.openRouter ?? null,
    },
    privacy: {
      level: privacy.level,
      includeExistingGroups: privacy.includeExistingGroups,
      allowLocalNetworkTabs: privacy.allowLocalNetworkTabs,
      allowFileTabs: privacy.allowFileTabs,
      allowlist: normalizeDomainRules(privacy.allowlist),
      denylist: normalizeDomainRules(privacy.denylist),
    },
    sanitizerVersion: SEMANTIC_SANITIZER_VERSION,
    documentFormatVersion: SEMANTIC_DOCUMENT_FORMAT_VERSION,
    modelProfileVersion: EMBEDDING_MODEL_PROFILE_VERSION,
    // Only an explicit profile belongs in the key. Under `auto` the request shape
    // is whatever `modelProfileVersion` describes, so an unchanged version means
    // an unchanged request, and no user is charged a rebuild for upgrading to a
    // build that can merely express an override.
    ...(config.modelProfile === "auto" ? {} : { modelProfile: config.modelProfile }),
  })));
}

export async function computeSemanticEmbeddingKey(
  compatibilityKey: string,
  document: string,
): Promise<string> {
  return sha256(`${compatibilityKey}\n${document}`);
}
