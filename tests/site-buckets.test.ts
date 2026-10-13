import { describe, expect, it } from "vitest";
import { demoteSiteBucketGroups, isSiteBucketTitle } from "../src/organizer/site-buckets";
import type { SanitizedTabRecord, ValidatedProposal } from "../src/shared/organizer-types";

function tab(id: number, hostname: string, domain = hostname, title = `Tab ${id}`): SanitizedTabRecord {
  return {
    id,
    title,
    domain,
    hostname,
    isCurrentlyGrouped: false,
    recencyBucket: "1_to_6_hours",
    isActive: false,
    isAudible: false,
  };
}

describe("site bucket detection", () => {
  it.each([
    ["Reddit", [tab(1, "www.reddit.com", "reddit.com"), tab(2, "old.reddit.com", "reddit.com")]],
    ["Figma Files", [tab(1, "www.figma.com", "figma.com"), tab(2, "www.figma.com", "figma.com")]],
    ["Gmail", [tab(1, "mail.google.com", "google.com"), tab(2, "mail.google.com", "google.com")]],
    ["Google Docs", [tab(1, "docs.google.com", "google.com"), tab(2, "docs.google.com", "google.com")]],
    ["GitHub PRs", [tab(1, "github.com"), tab(2, "github.com")]],
    ["YouTube", [tab(1, "www.youtube.com", "youtube.com"), tab(2, "m.youtube.com", "youtube.com")]],
    ["Hacker News", [tab(1, "news.ycombinator.com", "ycombinator.com"), tab(2, "news.ycombinator.com", "ycombinator.com")]],
    ["Misc", [tab(1, "a.com"), tab(2, "b.com")]],
  ])("flags %s", (title, members) => {
    expect(isSiteBucketTitle(title, members)).toBe(true);
  });

  it.each([
    ["Checkout Redesign", [tab(1, "www.figma.com", "figma.com"), tab(2, "www.figma.com", "figma.com")]],
    ["Sheaf PRs", [tab(1, "github.com"), tab(2, "github.com")]],
    // Mixed sites share no site name, so only the model's judgment applies.
    ["Google", [tab(1, "docs.google.com", "google.com"), tab(2, "www.youtube.com", "youtube.com")]],
    ["Keyboard Switches", [tab(1, "www.reddit.com", "reddit.com"), tab(2, "www.youtube.com", "youtube.com")]],
  ])("keeps %s", (title, members) => {
    expect(isSiteBucketTitle(title, members)).toBe(false);
  });
});

describe("demoteSiteBucketGroups", () => {
  const tabs = [
    tab(1, "www.reddit.com", "reddit.com"),
    tab(2, "www.reddit.com", "reddit.com"),
    tab(3, "www.figma.com", "figma.com"),
    tab(4, "linear.app"),
    tab(5, "news.example"),
  ];
  const proposal: ValidatedProposal = {
    schemaVersion: 1,
    groups: [
      { temporaryId: "group-1", title: "Reddit", tabIds: [1, 2] },
      { temporaryId: "group-2", title: "Checkout Redesign", tabIds: [3, 4] },
    ],
    untouchedTabIds: [5],
    lowValueTabIds: [],
  };

  it("demotes site-only groups to adjacent untouched tabs", () => {
    const result = demoteSiteBucketGroups(proposal, tabs);
    expect(result.demotedTitles).toEqual(["Reddit"]);
    expect(result.proposal.groups.map((group) => group.title)).toEqual(["Checkout Redesign"]);
    expect(result.proposal.untouchedTabIds).toEqual([5, 1, 2]);
  });

  it("keeps a site-named group the user asked for", () => {
    expect(demoteSiteBucketGroups(proposal, tabs, [], ["Reddit"]).demotedTitles).toEqual([]);
    expect(demoteSiteBucketGroups(proposal, tabs, [
      { kind: "assign_location", locationPattern: "reddit.com", groupName: "reddit" },
    ]).demotedTitles).toEqual([]);
  });
});
