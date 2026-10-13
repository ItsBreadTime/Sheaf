/**
 * True for a plain object. Every reader of an `unknown` value from storage, a
 * provider response, or a message needs this test before indexing into it;
 * arrays and `null` are not records.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
