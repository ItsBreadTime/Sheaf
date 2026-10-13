import { describe, expect, it } from "vitest";
import {
  normalizeSearchPicks,
  openSearchPickKey,
  recordSearchPick,
  searchPickBoosts,
  SEARCH_PICKS_LIMIT,
  stashSearchPickKey,
} from "../src/search/search-picks";

describe("search picks", () => {
  it("counts repeated picks under the normalized query", () => {
    let picks = recordSearchPick([], "  GitHub ", openSearchPickKey(4), 1);
    picks = recordSearchPick(picks, "github", openSearchPickKey(4), 2);
    expect(picks).toEqual([{ query: "github", key: "open:4", count: 2, lastAt: 2 }]);
    expect(recordSearchPick(picks, "   ", "open:5", 3)).toEqual(picks);
  });

  it("boosts exact queries most, then queries being typed towards or past", () => {
    const picks = [
      ...recordSearchPick([], "gh pulls", openSearchPickKey(1), 1),
      ...recordSearchPick([], "docs", stashSearchPickKey("s", "source:2"), 1),
    ];
    expect(searchPickBoosts(picks, "gh pulls").get("open:1")).toBe(2);
    expect(searchPickBoosts(picks, "gh").get("open:1")).toBe(1);
    expect(searchPickBoosts(picks, "docs api").get("stash:s:source:2")).toBe(1);
    expect(searchPickBoosts(picks, "api").size).toBe(0);
    expect(searchPickBoosts(picks, "").size).toBe(0);
  });

  it("does not let a very short remembered query claim longer ones", () => {
    const picks = recordSearchPick([], "g", openSearchPickKey(1), 1);
    expect(searchPickBoosts(picks, "github").size).toBe(0);
  });

  it("keeps the most recent picks within the limit and drops malformed records", () => {
    let picks = recordSearchPick([], "q0", "open:0", 0);
    for (let index = 1; index <= SEARCH_PICKS_LIMIT; index += 1) {
      picks = recordSearchPick(picks, `q${index}`, `open:${index}`, index);
    }
    expect(picks).toHaveLength(SEARCH_PICKS_LIMIT);
    expect(picks.some((pick) => pick.query === "q0")).toBe(false);
    expect(normalizeSearchPicks([{ query: "a", key: "open:1", count: 1, lastAt: 1 }, { query: "", key: "x", count: 1, lastAt: 1 }, null, "x"]))
      .toEqual([{ query: "a", key: "open:1", count: 1, lastAt: 1 }]);
    expect(normalizeSearchPicks(undefined)).toEqual([]);
  });
});
