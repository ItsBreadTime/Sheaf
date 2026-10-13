import type { PrivacySettings } from "../shared/organizer-types";

function validHostname(hostname: string, wildcard: boolean): boolean {
  if (!hostname || hostname.length > 253) return false;
  if (hostname.startsWith("[") && hostname.endsWith("]")) return !wildcard;
  return hostname.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

export function normalizeDomainRule(input: string): string | null {
  const raw = input.trim().toLowerCase();
  const wildcard = raw.startsWith("*.");
  const trimmed = wildcard ? raw.slice(2) : raw;
  if (!trimmed || trimmed.includes("*")) return null;
  try {
    const asUrl = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    const hostname = asUrl.hostname.replace(/\.$/, "");
    if (!validHostname(hostname, wildcard)) return null;
    return wildcard ? `*.${hostname}` : hostname;
  } catch {
    return null;
  }
}

export function normalizeDomainRules(inputs: readonly string[]): string[] {
  return [...new Set(inputs.flatMap((input) => normalizeDomainRule(input) ?? []))].sort();
}

export interface DomainRuleConflict {
  allowRule: string;
  denyRule: string;
}

export function findDomainRuleConflicts(
  allowlist: readonly string[],
  denylist: readonly string[],
): DomainRuleConflict[] {
  const allows = normalizeDomainRules(allowlist);
  const denies = normalizeDomainRules(denylist);
  return allows.flatMap((allowRule) => denies.flatMap((denyRule) =>
    ruleBase(allowRule) === ruleBase(denyRule) ||
    ruleBase(allowRule).endsWith(`.${ruleBase(denyRule)}`) ||
    ruleBase(denyRule).endsWith(`.${ruleBase(allowRule)}`)
      ? [{ allowRule, denyRule }]
      : [],
  ));
}

function ruleBase(rule: string): string {
  return rule.startsWith("*.") ? rule.slice(2) : rule;
}

function matchesRule(hostname: string, domain: string, rule: string): boolean {
  if (rule.startsWith("*.")) {
    const base = ruleBase(rule);
    return hostname !== base && hostname.endsWith(`.${base}`);
  }
  return (
    hostname === rule ||
    hostname.endsWith(`.${rule}`) ||
    domain === rule ||
    domain.endsWith(`.${rule}`)
  );
}

export function getPrivacyExclusionReason(
  hostname: string,
  domain: string,
  settings: Pick<PrivacySettings, "allowlist" | "denylist">,
): string | null {
  const denylist = normalizeDomainRules(settings.denylist);
  if (denylist.some((rule) => matchesRule(hostname, domain, rule))) {
    return "Domain is excluded by the privacy denylist";
  }
  const allowlist = normalizeDomainRules(settings.allowlist);
  if (
    allowlist.length > 0 &&
    !allowlist.some((rule) => matchesRule(hostname, domain, rule))
  ) {
    return "Domain is not included in the privacy allowlist";
  }
  return null;
}
