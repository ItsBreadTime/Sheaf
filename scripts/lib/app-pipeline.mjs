// Runs a raw organizer completion through the same local pipeline the extension
// applies before review: fence unwrap, strict parse, reduce-only normalization,
// validation, clutter enforcement, and site-bucket demotion. src/ uses extensionless imports for Vite, so resolve
// them to .ts here before loading those modules.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { parseNormalizeAndValidateOrganizerResponse } = await import("../../src/organizer/validate.ts");
const { demoteSiteBucketGroups } = await import("../../src/organizer/site-buckets.ts");
const { applyClutterRules } = await import("../../src/organizer/rules.ts");
// The exact request text the extension sends (requestFormat "lines" in the matrix).
export const { serializeOrganizationRequest } = await import("../../src/privacy/request-builder.ts");
export const { ORGANIZER_RESPONSE_JSON_SCHEMA } = await import("../../src/provider/protocol.ts");

/**
 * @returns {{ ok: true, content: string, demotedTitles: string[] } | { ok: false, error: string }}
 * content is the proposal the app would show, serialized in the response contract.
 */
export function applyAppPipeline(rawContent, request) {
  let value;
  try {
    value = JSON.parse(rawContent.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? rawContent);
  } catch {
    return { ok: false, error: "invalid JSON (would need repair)" };
  }
  try {
    const submittedIds = request.tabs.map((tab) => tab.id);
    const proposal = applyClutterRules(
      parseNormalizeAndValidateOrganizerResponse(value, submittedIds),
      request.tabs,
      request.organizerRules ?? [],
    );
    const { proposal: guarded, demotedTitles } = demoteSiteBucketGroups(
      proposal,
      request.tabs,
      request.organizerRules ?? [],
      request.preferredGroupNames ?? [],
    );
    const content = JSON.stringify({
      schemaVersion: 1,
      groups: guarded.groups.map((group) => ({
        temporaryId: group.temporaryId,
        title: group.title,
        color: group.color ?? null,
        tabIds: group.tabIds,
      })),
      untouchedTabIds: guarded.untouchedTabIds,
      ungroupTabIds: guarded.ungroupTabIds ?? [],
      lowValueTabIds: guarded.lowValueTabIds ?? [],
    });
    return { ok: true, content, demotedTitles };
  } catch (error) {
    return { ok: false, error: `${error instanceof Error ? error.message : String(error)} (would need repair)` };
  }
}
