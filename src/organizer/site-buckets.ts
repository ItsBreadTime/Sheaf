import type {
  SanitizedOrganizerRule,
  SanitizedTabRecord,
  ValidatedProposal,
} from "../shared/organizer-types";

// Product names that differ from any label of the hostname serving them.
const SITE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "mail.google.com": ["gmail"],
  "x.com": ["twitter"],
  "twitter.com": ["x"],
  "news.ycombinator.com": ["hackernews", "hn"],
  "web.whatsapp.com": ["whatsapp"],
  "outlook.office.com": ["outlook"],
  "teams.microsoft.com": ["msteams"],
};

// Words that describe what a site holds rather than what the user is doing.
const CONTAINER_WORDS = new Set([
  "app", "apps", "article", "articles", "board", "boards", "chat", "chats",
  "design", "designs", "doc", "docs", "document", "documents", "email", "emails",
  "feed", "file", "files", "inbox", "issue", "issues", "link", "links", "mail",
  "message", "messages", "page", "pages", "post", "posts", "pr", "prs", "pull",
  "pulls", "repo", "repos", "sheet", "sheets", "site", "tab", "tabs", "thread",
  "threads", "video", "videos",
]);

const CATCH_ALL_TITLES = new Set([
  "browsing", "general", "misc", "miscellaneous", "other", "others",
  "uncategorized", "various", "web", "websites",
]);

const IGNORED_HOST_LABELS = new Set(["www", "m", "app", "com", "org", "net", "io", "co"]);

function words(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function compact(value: string): string {
  return words(value).join("");
}

function siteNames(tab: SanitizedTabRecord): Set<string> {
  const names = new Set<string>();
  for (const host of [tab.domain, tab.hostname ?? ""]) {
    if (!host) continue;
    const labels = host.split(".").filter((label) => !IGNORED_HOST_LABELS.has(label));
    labels.forEach((label) => names.add(compact(label)));
    (SITE_ALIASES[host] ?? []).forEach((alias) => names.add(alias));
  }
  names.delete("");
  return names;
}

/** True when a title names only the site(s) its members share, or nothing at all. */
export function isSiteBucketTitle(
  title: string,
  members: readonly SanitizedTabRecord[],
): boolean {
  const titleWords = words(title);
  if (titleWords.length === 0) return false;
  if (CATCH_ALL_TITLES.has(titleWords.join(" "))) return true;
  if (members.length === 0) return false;
  const shared = members
    .map(siteNames)
    .reduce((left, right) => new Set([...left].filter((name) => right.has(name))));
  if (shared.size === 0) return false;
  // "Google Docs" → google, docs; "Hacker News" → hackernews. Try the whole title
  // as one name before checking word by word.
  if (shared.has(titleWords.join(""))) return true;
  let namesSite = false;
  for (const word of titleWords) {
    if (shared.has(word)) namesSite = true;
    else if (!CONTAINER_WORDS.has(word)) return false;
  }
  return namesSite;
}

function explicitlyRequestedTitles(
  rules: readonly SanitizedOrganizerRule[],
  preferredGroupNames: readonly string[],
): Set<string> {
  const titles = new Set(preferredGroupNames.map(compact));
  for (const rule of rules) {
    if (rule.kind === "assign_location") titles.add(compact(rule.groupName));
    if (rule.kind === "rename_group") titles.add(compact(rule.toName));
  }
  return titles;
}

/**
 * Demotes groups whose only shared trait is the website or app ("Reddit",
 * "Figma Files", "Google Docs") and pure catch-alls ("Misc") to untouched. Chrome
 * already shows the site in each tab's favicon, so such a group adds noise rather
 * than organization; the loose-tab arrangement still keeps those tabs adjacent.
 * Titles the user asked for through rules or preferred names are kept.
 */
export function demoteSiteBucketGroups(
  proposal: ValidatedProposal,
  tabs: readonly SanitizedTabRecord[],
  rules: readonly SanitizedOrganizerRule[] = [],
  preferredGroupNames: readonly string[] = [],
): { proposal: ValidatedProposal; demotedTitles: string[] } {
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const requested = explicitlyRequestedTitles(rules, preferredGroupNames);
  const demotedTitles: string[] = [];
  const demotedTabIds: number[] = [];
  const groups = proposal.groups.filter((group) => {
    if (requested.has(compact(group.title))) return true;
    const members = group.tabIds.flatMap((id) => tabsById.get(id) ?? []);
    if (members.length !== group.tabIds.length) return true;
    if (!isSiteBucketTitle(group.title, members)) return true;
    demotedTitles.push(group.title);
    demotedTabIds.push(...group.tabIds);
    return false;
  });
  if (demotedTitles.length === 0) return { proposal: structuredClone(proposal), demotedTitles };
  return {
    proposal: {
      ...structuredClone(proposal),
      groups: structuredClone(groups),
      untouchedTabIds: [...proposal.untouchedTabIds, ...demotedTabIds],
    },
    demotedTitles,
  };
}
