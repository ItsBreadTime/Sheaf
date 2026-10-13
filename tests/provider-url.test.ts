import { describe, expect, it } from "vitest";
import { displayProviderUrl, joinProviderUrl, providerRoute, splitProviderUrl } from "../src/provider/request-policy";

const CHAT = "/v1/chat/completions";
const EMBEDDINGS = "/v1/embeddings";
const CHAT_ROUTE = "/chat/completions";
const split = (url: string, defaultPath = CHAT, route = providerRoute(defaultPath)) =>
  splitProviderUrl(url, route, defaultPath);

describe("API URL and route fields", () => {
  it("derives the usual route from the default path", () => {
    expect(providerRoute(CHAT)).toBe(CHAT_ROUTE);
    expect(providerRoute(EMBEDDINGS)).toBe("/embeddings");
    expect(providerRoute("/v1/systemone")).toBe("/systemone");
  });

  it("keeps a full endpoint URL that already ends with the route", () => {
    expect(split("https://api.openai.com/v1/chat/completions")).toEqual({
      origin: "https://api.openai.com",
      endpointPath: "/v1/chat/completions",
    });
    expect(split("https://openrouter.ai/api/v1/embeddings", EMBEDDINGS)).toEqual({
      origin: "https://openrouter.ai",
      endpointPath: "/api/v1/embeddings",
    });
  });

  it("uses the whole default path for a bare origin", () => {
    expect(split("https://api.openai.com").endpointPath).toBe(CHAT);
    expect(split("http://localhost:11434/", EMBEDDINGS)).toEqual({
      origin: "http://localhost:11434",
      endpointPath: EMBEDDINGS,
    });
  });

  it("appends the route to a base URL", () => {
    expect(split("https://api.openai.com/v1").endpointPath).toBe(CHAT);
    expect(split("https://openrouter.ai/api/v1/").endpointPath).toBe("/api/v1/chat/completions");
    expect(split("https://generativelanguage.googleapis.com/v1beta/openai").endpointPath)
      .toBe("/v1beta/openai/chat/completions");
    expect(split("https://decisions.example.com/v1", "/v1/systemone").endpointPath).toBe("/v1/systemone");
  });

  it("appends a custom route instead of the usual one", () => {
    expect(splitProviderUrl("https://llm.example.com/v1", "/completions", CHAT).endpointPath).toBe("/v1/completions");
    expect(splitProviderUrl("http://localhost:8080", "score", CHAT).endpointPath).toBe("/score");
    expect(splitProviderUrl("https://llm.example.com/v2/", "/generate/", CHAT).endpointPath).toBe("/v2/generate");
  });

  it("uses the URL exactly as typed when the route is empty", () => {
    expect(splitProviderUrl("https://llm.example.com/api/infer", "", CHAT).endpointPath).toBe("/api/infer");
    expect(splitProviderUrl("http://localhost:8080", " ", CHAT).endpointPath).toBe("/");
  });

  it("explains malformed input", () => {
    expect(() => split("")).toThrow(/Enter the API URL/);
    expect(() => split("api.openai.com/v1")).toThrow(/isn't a full URL/);
    expect(() => split("https://api.openai.com/v1?x=1")).toThrow(/query/);
    expect(() => splitProviderUrl("https://api.openai.com/v1", "/chat?x=1", CHAT)).toThrow(/route must be a path/);
    expect(() => splitProviderUrl("https://api.openai.com/v1", "https://x/y", CHAT)).toThrow(/route must be a path/);
  });

  it("shows a stored connection as a base URL plus route, and round-trips it", () => {
    for (const [origin, endpointPath] of [
      ["https://api.openai.com", CHAT],
      ["https://openrouter.ai", "/api/v1/chat/completions"],
      ["https://llm.example.com", "/api/infer"],
    ] as const) {
      const shown = displayProviderUrl(origin, endpointPath, CHAT);
      expect(splitProviderUrl(shown.url, shown.route, CHAT)).toEqual({ origin, endpointPath });
    }
    expect(displayProviderUrl("https://api.openai.com", CHAT, CHAT)).toEqual({
      url: "https://api.openai.com/v1",
      route: CHAT_ROUTE,
    });
    expect(displayProviderUrl("https://llm.example.com", "/api/infer", CHAT)).toEqual({
      url: "https://llm.example.com/api/infer",
      route: "",
    });
    expect(joinProviderUrl("https://api.openai.com/", CHAT)).toBe("https://api.openai.com/v1/chat/completions");
  });
});
