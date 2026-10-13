import type {
  SessionUserProtections,
  UserProtectionRule,
  UserProtectionState,
} from "../shared/protection-types";
import { isRecord } from "../shared/guards";

const LOCAL_KEY = "userProtectionRules";
const SESSION_KEY = "sessionUserProtections";
const MAX_RULES = 100;
const MAX_IDS = 500;

function normalizeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (item): item is number => Number.isSafeInteger(item) && Number(item) >= 0,
  ))].slice(0, MAX_IDS);
}

export function normalizeProtectionRules(value: unknown): UserProtectionRule[] {
  if (!Array.isArray(value)) return [];
  const result: UserProtectionRule[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, MAX_RULES)) {
    if (!isRecord(item) || typeof item.id !== "string" || seen.has(item.id)) continue;
    if (item.kind !== "location" && item.kind !== "group_title") continue;
    if (typeof item.pattern !== "string" || !item.pattern.trim()) continue;
    const createdAt = typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
      ? item.createdAt
      : 0;
    const rule: UserProtectionRule = {
      id: item.id.slice(0, 100),
      kind: item.kind,
      pattern: item.pattern.trim().toLocaleLowerCase().slice(0, 300),
      createdAt,
    };
    seen.add(rule.id);
    result.push(rule);
  }
  return result;
}

export function normalizeSessionProtections(value: unknown): SessionUserProtections {
  if (!isRecord(value)) return { tabIds: [], groupIds: [] };
  return {
    tabIds: normalizeIds(value.tabIds),
    groupIds: normalizeIds(value.groupIds),
  };
}

export async function readUserProtectionState(): Promise<UserProtectionState> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(LOCAL_KEY),
    chrome.storage.session.get(SESSION_KEY),
  ]);
  return {
    permanentRules: normalizeProtectionRules(local[LOCAL_KEY]),
    session: normalizeSessionProtections(session[SESSION_KEY]),
  };
}

export async function writePermanentProtectionRules(
  rules: readonly UserProtectionRule[],
): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEY]: normalizeProtectionRules(rules) });
}

export async function writeSessionProtections(
  session: SessionUserProtections,
): Promise<void> {
  await chrome.storage.session.set({
    [SESSION_KEY]: normalizeSessionProtections(session),
  });
}
