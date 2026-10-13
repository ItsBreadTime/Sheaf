import { ProviderHttpError, readBodyWithLimit } from "../provider/openai-chat-completions";
import { isOpenRouterOrigin, normalizeProviderEndpoint, openRouterProviderBody } from "../provider/request-policy";
import { startUsageMeter } from "../provider/usage-meter";
import { LIMITS } from "../shared/limits";
import type { EmbeddingConfig, EmbeddingTestResult } from "../shared/search-types";
import { MAX_EMBEDDING_DIMENSIONS, normalizeEmbeddingConfig } from "./embedding-config";
import { EmbeddingRedirectError } from "./embedding-errors";
import { embeddingModelProfile, type EmbeddingTaskMode } from "./model-profiles";

interface EmbeddingResponseItem { index: number; embedding: number[] }

export class EmbeddingRequestError extends Error {
  constructor(readonly code: "cancelled" | "timeout", message: string) {
    super(message);
    this.name = "EmbeddingRequestError";
  }
}

function requestSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Embedding request timed out.", "TimeoutError")), timeoutMs);
  const forward = (): void => controller.abort(external?.reason);
  external?.addEventListener("abort", forward, { once: true });
  if (external?.aborted) forward();
  return { signal: controller.signal, cleanup: () => { clearTimeout(timeout); external?.removeEventListener("abort", forward); } };
}

function parseVectors(value: unknown, count: number, expectedDimensions: number | null): Float32Array[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) {
    throw new Error("Embedding response does not contain a data array.");
  }
  const data = (value as { data: unknown[] }).data;
  if (data.length !== count) throw new Error(`Embedding response returned ${data.length} vectors for ${count} inputs.`);
  const indexed = new Map<number, Float32Array>();
  data.forEach((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Embedding response contains an invalid item.");
    const item = raw as EmbeddingResponseItem;
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= count || indexed.has(item.index)) {
      throw new Error("Embedding response indices are invalid or duplicated.");
    }
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) throw new Error("Embedding vector is empty.");
    if (item.embedding.length > MAX_EMBEDDING_DIMENSIONS) {
      throw new Error(`Embedding vector exceeds the ${MAX_EMBEDDING_DIMENSIONS}-dimension limit.`);
    }
    if (expectedDimensions !== null && item.embedding.length !== expectedDimensions) {
      throw new Error(`Embedding dimension mismatch: expected ${expectedDimensions}, received ${item.embedding.length}.`);
    }
    if (item.embedding.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
      throw new Error("Embedding vector contains a non-finite value.");
    }
    if (item.embedding.every((component) => component === 0)) throw new Error("Embedding vector is entirely zero.");
    const vector = Float32Array.from(item.embedding);
    if ([...vector].some((component) => !Number.isFinite(component))) {
      throw new Error("Embedding vector overflows finite Float32 storage.");
    }
    if ([...vector].every((component) => component === 0)) {
      throw new Error("Embedding vector becomes entirely zero in Float32 storage.");
    }
    indexed.set(item.index, vector);
  });
  const vectors = Array.from({ length: count }, (_, index) => indexed.get(index));
  if (vectors.some((vector) => !vector)) throw new Error("Embedding response omitted an input index.");
  const dimensions = vectors[0]!.length;
  if (vectors.some((vector) => vector!.length !== dimensions)) throw new Error("Embedding vectors have inconsistent dimensions.");
  return vectors as Float32Array[];
}

export class OpenAICompatibleEmbeddingClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async embed(
    inputs: string[],
    configInput: EmbeddingConfig,
    apiKey: string,
    signal: AbortSignal | undefined,
    mode: EmbeddingTaskMode,
    /** Index builds and queries are search; the connection test is not. */
    usageTask: "search" | null = "search",
  ): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    if (inputs.length > LIMITS.MAX_EMBEDDING_INPUTS_PER_REQUEST) {
      throw new Error(`Embedding requests support at most ${LIMITS.MAX_EMBEDDING_INPUTS_PER_REQUEST} inputs per batch.`);
    }
    const encoder = new TextEncoder();
    for (const input of inputs) {
      if (input.length > LIMITS.MAX_EMBEDDING_INPUT_CHARS) {
        throw new Error(`Each embedding input supports at most ${LIMITS.MAX_EMBEDDING_INPUT_CHARS} characters.`);
      }
      if (encoder.encode(input).byteLength > LIMITS.MAX_EMBEDDING_INPUT_BYTES) {
        throw new Error(`Each embedding input supports at most ${LIMITS.MAX_EMBEDDING_INPUT_BYTES} UTF-8 bytes.`);
      }
    }
    const config = normalizeEmbeddingConfig(configInput);
    const endpoint = normalizeProviderEndpoint(config.origin, config.endpointPath);
    const headers = new Headers(config.customHeaders);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    if (apiKey.trim()) headers.set("authorization", `Bearer ${apiKey.trim()}`);
    const openRouterProvider = isOpenRouterOrigin(config.origin)
      ? openRouterProviderBody(config.openRouter)
      : undefined;
    // Profile task fields come first so that a legacy `extraBody` copy of the same
    // key cannot override the per-mode value this call computed.
    const taskFields = embeddingModelProfile(config.model, config.modelProfile).taskFields?.(mode) ?? {};
    const body = JSON.stringify({
      ...taskFields,
      ...config.extraBody,
      model: config.model,
      input: inputs,
      encoding_format: "float",
      ...(config.dimensions === null ? {} : { dimensions: config.dimensions }),
      ...(openRouterProvider === undefined ? {} : { provider: openRouterProvider }),
    });
    if (encoder.encode(body).byteLength > LIMITS.MAX_EMBEDDING_REQUEST_BYTES) {
      throw new Error(`Embedding request exceeded the ${LIMITS.MAX_EMBEDDING_REQUEST_BYTES}-byte limit.`);
    }
    const request = requestSignal(config.timeoutMs, signal);
    const meter = startUsageMeter("embedding", { task: usageTask });
    let answered = false;
    let cancelled = false;
    try {
      const fetchImpl = this.fetchImpl;
      // `redirect: "manual"` rather than `"error"`: a provider that 301s to a
      // canonical host must not be followed with the API key attached, but the
      // user still deserves to be told a redirect happened instead of seeing a
      // generic network failure.
      const response = await fetchImpl(endpoint.url, { method: "POST", headers, body, redirect: "manual", signal: request.signal });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new EmbeddingRedirectError(response.status, response.headers.get("location"));
      }
      const text = await readBodyWithLimit(response, LIMITS.MAX_EMBEDDING_RESPONSE_BYTES, false);
      if (!response.ok) {
        throw new ProviderHttpError(
          response.status,
          `Embedding provider returned HTTP ${response.status}.`,
          response.headers.get("retry-after"),
        );
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error("Embedding provider returned malformed JSON."); }
      meter.observe(parsed);
      answered = true;
      return parseVectors(parsed, inputs.length, config.dimensions);
    } catch (error) {
      if (request.signal.aborted) {
        const timedOut = request.signal.reason instanceof DOMException && request.signal.reason.name === "TimeoutError";
        cancelled = !timedOut;
        throw new EmbeddingRequestError(timedOut ? "timeout" : "cancelled", timedOut
          ? "Embedding request timed out."
          : "Embedding request was cancelled.");
      }
      throw error;
    } finally {
      request.cleanup();
      meter.finish(answered, cancelled);
    }
  }

  async embedDocuments(documents: string[], config: EmbeddingConfig, apiKey: string, signal?: AbortSignal): Promise<Float32Array[]> {
    const profile = embeddingModelProfile(config.model, config.modelProfile);
    return this.embed(documents.map(profile.formatDocument), config, apiKey, signal, "document");
  }

  async embedQuery(query: string, config: EmbeddingConfig, apiKey: string, signal?: AbortSignal): Promise<Float32Array> {
    const profile = embeddingModelProfile(config.model, config.modelProfile);
    return (await this.embed([profile.formatQuery(query)], config, apiKey, signal, "query"))[0]!;
  }

  async test(config: EmbeddingConfig, apiKey: string, signal?: AbortSignal): Promise<EmbeddingTestResult> {
    const startedAt = performance.now();
    const profile = embeddingModelProfile(config.model, config.modelProfile);
    // The test's job is to find out what the provider does, so it deliberately does
    // not enforce the requested dimension here: a provider that ignores `dimensions`
    // should be reported as `dimensionsHonored: false`, not fail with a mismatch
    // error that says nothing about the cause.
    const probeConfig: EmbeddingConfig = { ...config, dimensions: null };
    const documentVectors = await this.embed([
      profile.formatDocument("Tab search provider test one"),
      profile.formatDocument("Tab search provider test two"),
    ], probeConfig, apiKey, signal, "document", null);
    const [query] = await this.embed(
      [profile.formatQuery("tab search provider test")],
      probeConfig,
      apiKey,
      signal,
      "query",
      null,
    );
    if (documentVectors.some((vector) => vector.length !== query!.length)) {
      throw new Error("Query and document vectors have different dimensions.");
    }
    const normalizedConfig = normalizeEmbeddingConfig(config);
    const magnitude = Math.sqrt(query!.reduce((sum, component) => sum + component * component, 0));
    return {
      testedAt: Date.now(),
      model: normalizedConfig.model,
      dimensions: query!.length,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      batchInputSupported: true,
      queryDocumentCompatible: true,
      retentionStatus: "not_verified",
      // A provider that silently ignores `dimensions` produces an index whose
      // vectors will not match a later request that does honour them, so the test
      // reports it before a large build rather than after.
      dimensionsHonored: normalizedConfig.dimensions === null || query!.length === normalizedConfig.dimensions,
      normalized: Number.isFinite(magnitude) && Math.abs(magnitude - 1) <= 0.001,
    };
  }
}
