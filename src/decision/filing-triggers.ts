import { getDomain } from "tldts";

/**
 * When a tab event asks for a filing decision (docs/auto-filing-plan.md,
 * Triggering and scheduling). Pure, so the rules are unit-tested apart from
 * the listeners.
 */

/** The registrable domain of an http(s) page, or null for anything else. */
export function siteOf(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
  } catch {
    return null;
  }
}

export interface TabSiteState {
  /** The tab's site as last seen. */
  site: string | null;
  /** The site the last decision was made for; a tab is never asked twice about one site. */
  decidedSite: string | null;
  /** Set while a tab sits in a group Chrome put it in (a link opened from a grouped tab). */
  openerSite: string | null;
}

export const emptyTabSiteState = (): TabSiteState => ({ site: null, decidedSite: null, openerSite: null });

export type FilingTrigger = "ungrouped" | "regroup" | null;

/**
 * - An ungrouped tab is decided once per site it lands on.
 * - A grouped tab is re-evaluated only when its site changes; navigating within
 *   a site, or a title change alone, never asks again.
 * - A tab Chrome grouped with its opener counts as "grouped, site changed" as
 *   soon as its site differs from the opener's.
 */
export function triggerFor(state: TabSiteState, grouped: boolean, nextSite: string | null): FilingTrigger {
  if (!nextSite || nextSite === state.decidedSite) return null;
  if (!grouped) return "ungrouped";
  if (state.openerSite !== null) return nextSite !== state.openerSite ? "regroup" : null;
  return state.site !== null && state.site !== nextSite ? "regroup" : null;
}

/** Filings allowed in the next minute, given recent filing times. */
export function underRateLimit(times: readonly number[], now: number, perMinute: number): boolean {
  return times.filter((time) => now - time < 60_000).length < perMinute;
}
