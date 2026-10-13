/**
 * Deterministic, offline stand-in for an OpenAI-compatible embeddings endpoint,
 * shared by the tests that need provider behaviour without a network.
 *
 * It is a `fetch` implementation rather than an HTTP server because every
 * production caller reaches the provider through `OpenAICompatibleEmbeddingClient`,
 * which takes `fetch` as its injection point. The browser-level smoke script keeps
 * its own local HTTP server, since it drives a real extension page over a real
 * socket and cannot import this module.
 */

export interface FakeEmbeddingRequest {
  url: string;
  model: string;
  inputs: string[];
  authorization: string | null;
  /** Body fields the client sent alongside the inputs, for adapter assertions. */
  body: Record<string, unknown>;
}

export type FakeEmbeddingFailureKind =
  | "http_status"
  | "malformed_json"
  | "wrong_dimension"
  | "all_zero"
  | "reordered_indices"
  | "missing_index"
  | "non_finite"
  | "truncated_body"
  | "network_error"
  | "timeout"
  | "redirect";

export interface FakeEmbeddingFailure {
  kind: FakeEmbeddingFailureKind;
  /** Restrict the failure to requests containing this input substring. */
  matchInput?: string;
  /** HTTP status for `http_status` (defaults to 500). */
  status?: number;
  /** `Retry-After` header value for `http_status`. */
  retryAfter?: string;
  /** How many matching requests to fail. Defaults to every matching request. */
  times?: number | "always";
}

export interface FakeEmbeddingProvider {
  fetchImpl: typeof fetch;
  requests: FakeEmbeddingRequest[];
  /** Inputs received across all requests, in order. */
  inputs(): string[];
  /** Inputs received that look like indexed documents rather than queries. */
  documentInputs(): string[];
  /** Requests still counted against each failure's `times` budget. */
  remainingFailures(): number;
}

const DEFAULT_DIMENSIONS = 8;

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A stable pseudo-random unit vector per input. Distinct inputs get distinct
 * directions and the same input always gets the same vector, so orchestration
 * assertions are reproducible without depending on a real model.
 */
export function deterministicVector(input: string, dimensions = DEFAULT_DIMENSIONS): Float32Array {
  let state = hashString(input) || 1;
  const components = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    components[index] = state / 0xffffffff * 2 - 1;
  }
  let squaredMagnitude = 0;
  for (const component of components) squaredMagnitude += component * component;
  const magnitude = Math.sqrt(squaredMagnitude) || 1;
  // Keep every component in a realistic range and never return a zero vector.
  for (let index = 0; index < dimensions; index += 1) {
    components[index] = (components[index]! / magnitude) + (index === 0 ? 0.01 : 0);
  }
  return components;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function createFakeEmbeddingProvider(options: {
  dimensions?: number;
  failures?: FakeEmbeddingFailure[];
} = {}): FakeEmbeddingProvider {
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  const requests: FakeEmbeddingRequest[] = [];
  const failureBudget = new Map<FakeEmbeddingFailure, number>();
  for (const failure of options.failures ?? []) {
    failureBudget.set(failure, failure.times === undefined || failure.times === "always"
      ? Number.POSITIVE_INFINITY
      : failure.times);
  }

  const matchingFailure = (inputs: readonly string[]): FakeEmbeddingFailure | null => {
    for (const [failure, remaining] of failureBudget) {
      if (remaining <= 0) continue;
      if (failure.matchInput !== undefined && !inputs.some((input) => input.includes(failure.matchInput!))) continue;
      failureBudget.set(failure, remaining - 1);
      return failure;
    }
    return null;
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const inputs = (Array.isArray(body.input) ? body.input : [body.input]).map((value) => String(value));
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      model: String(body.model ?? ""),
      inputs,
      authorization: headers.get("authorization"),
      body,
    });

    const failure = matchingFailure(inputs);
    if (failure) {
      switch (failure.kind) {
        case "http_status": {
          const status = failure.status ?? 500;
          return jsonResponse(status, { error: { message: "synthetic failure" } },
            failure.retryAfter === undefined ? {} : { "retry-after": failure.retryAfter });
        }
        case "malformed_json":
          return new Response("{ not json", { status: 200, headers: { "content-type": "application/json" } });
        case "truncated_body": {
          const truncated = new Response("", { status: 200, headers: { "content-type": "application/json" } });
          return truncated;
        }
        case "network_error":
          throw new TypeError("fetch failed");
        case "redirect":
          // A provider that 301s to a canonical host. The client asks for
          // redirect: "manual", so it sees the status and names it instead of
          // following the redirect with the API key attached.
          return new Response(null, {
            status: 302,
            headers: { location: "https://canonical.example/v1/embeddings" },
          });
        case "timeout":
          // Never settles on its own; the client's own timeout must abort it.
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            const onAbort = (): void => reject(signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError"));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        default:
          break;
      }
    }

    const vectorFor = (value: string): number[] => {
      const base = [...deterministicVector(value, dimensions)].map((component) => component + 0.5);
      switch (failure?.kind) {
        case "wrong_dimension":
          return [...base, 1];
        case "all_zero":
          return base.map(() => 0);
        case "non_finite":
          return [...base.slice(0, -1), Number.NaN];
        default:
          return base;
      }
    };
    const items = inputs.map((value, index) => ({ object: "embedding", index, embedding: vectorFor(value) }));
    if (failure?.kind === "reordered_indices") items.reverse();
    if (failure?.kind === "missing_index") items.pop();
    return jsonResponse(200, { object: "list", data: items, model: body.model });
  }) as typeof fetch;

  return {
    fetchImpl,
    requests,
    inputs: () => requests.flatMap((request) => request.inputs),
    documentInputs: () => requests.flatMap((request) => request.inputs.filter((input) => input.includes("Title:"))),
    remainingFailures: () => [...failureBudget.values()].filter((remaining) => Number.isFinite(remaining)).length,
  };
}
