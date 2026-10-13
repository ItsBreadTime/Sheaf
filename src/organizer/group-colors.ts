import { ORGANIZATION_TRANSACTION } from "../shared/constants";
import {
  isChromeGroupColor,
  type ChromeGroupColor,
} from "../shared/group-colors";

export function deterministicGroupColor(
  title: string,
): chrome.tabGroups.TabGroup["color"] {
  const normalized = title.normalize("NFKC").trim().toLocaleLowerCase();
  if (!normalized) return ORGANIZATION_TRANSACTION.DEFAULT_GROUP_COLOR;
  let hash = 2_166_136_261;
  for (const character of normalized) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return ORGANIZATION_TRANSACTION.GROUP_COLORS[hash % ORGANIZATION_TRANSACTION.GROUP_COLORS.length]
    ?? ORGANIZATION_TRANSACTION.DEFAULT_GROUP_COLOR;
}

export function effectiveProposedGroupColor(
  title: string,
  proposedColor: unknown,
  mode: "deterministic" | "ai" | undefined,
): { color: ChromeGroupColor; source: "ai" | "deterministic" } {
  if (mode === "ai" && isChromeGroupColor(proposedColor)) {
    return { color: proposedColor, source: "ai" };
  }
  return { color: deterministicGroupColor(title), source: "deterministic" };
}
