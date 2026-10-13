// Behavior scoring for the benchmark CLI (scripts/benchmark-cli.mjs) and its
// analyze scripts. Pure TypeScript with no src/ or runtime dependencies, so it
// lives beside the scripts that consume it rather than in the shipped source.

export interface BehaviorTitleRule {
  preferred?: string[];
  requiredAll?: string[];
  requiredAny?: string[];
  forbidden?: string[];
}

export interface BehaviorColorRule {
  preferred?: string[];
  allowed?: string[];
}

export interface BehaviorExpectedGroup {
  tabIds: number[];
  title: BehaviorTitleRule;
  color?: BehaviorColorRule;
}

export interface BehaviorCaseSpec {
  groups: BehaviorExpectedGroup[];
  untouchedTabIds: number[];
  lowValueTabIds: number[];
  colorMode: "deterministic" | "ai";
  /** Related untouched tabs that should sit next to each other in untouchedTabIds. */
  looseClusters?: number[][];
  /** Untouched, currently grouped tabs expected to leave their group. */
  ungroupTabIds?: number[];
}

export interface BehaviorQualityScore {
  totalScore: number;
  contractValid: boolean;
  groupingScore: number;
  pairPrecision: number;
  pairRecall: number;
  untouchedScore: number;
  namingScore: number;
  clutterScore: number;
  colorScore: number;
  overmergedGroups: number;
  genericNames: number;
  /** null when the case defines no arrangement expectations. */
  arrangementScore: number | null;
  reasons: string[];
}

interface CandidateGroup {
  title: string;
  color: unknown;
  tabIds: number[];
}

interface CandidateValue {
  groups: CandidateGroup[];
  untouchedTabIds: number[];
  ungroupTabIds: number[];
  lowValueTabIds: number[];
}

const ALLOWED_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

const GENERIC_NAMES = new Set([
  "browsing",
  "general",
  "misc",
  "miscellaneous",
  "other",
  "research",
  "resources",
  "tabs",
  "tools",
  "web",
  "websites",
  "work",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseCandidate(output: string, submittedIds: readonly number[]): {
  value: CandidateValue | null;
  contractValid: boolean;
  reason?: string;
} {
  let parsed: unknown;
  let contractValid = true;
  try {
    parsed = JSON.parse(output);
  } catch {
    const fenced = output.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
    if (!fenced) return { value: null, contractValid: false, reason: "invalid JSON" };
    contractValid = false;
    try {
      parsed = JSON.parse(fenced);
    } catch {
      return { value: null, contractValid: false, reason: "invalid fenced JSON" };
    }
  }
  const value = record(parsed);
  if (!value) return { value: null, contractValid: false, reason: "response is not an object" };
  const keys = Object.keys(value).filter((key) => key !== "ungroupTabIds").sort();
  if (!sameStrings(keys, ["groups", "lowValueTabIds", "schemaVersion", "untouchedTabIds"])) {
    contractValid = false;
  }
  const ungroupTabIds = Array.isArray(value.ungroupTabIds) &&
      value.ungroupTabIds.every(Number.isSafeInteger)
    ? value.ungroupTabIds as number[]
    : [];
  if (value.ungroupTabIds !== undefined && ungroupTabIds.length !== (value.ungroupTabIds as unknown[]).length) {
    contractValid = false;
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.groups) ||
      !Array.isArray(value.untouchedTabIds) || !Array.isArray(value.lowValueTabIds)) {
    return { value: null, contractValid: false, reason: "missing required fields" };
  }
  const groups: CandidateGroup[] = [];
  const assigned: number[] = [];
  value.groups.forEach((rawGroup, index) => {
    const group = record(rawGroup);
    if (!group || !sameStrings(
      Object.keys(group).sort(),
      ["color", "tabIds", "temporaryId", "title"],
    )) {
      contractValid = false;
      return;
    }
    if (group.temporaryId !== `group-${index + 1}` || typeof group.title !== "string" ||
        !Array.isArray(group.tabIds) || group.tabIds.length < 2 ||
        !group.tabIds.every(Number.isSafeInteger)) {
      contractValid = false;
      return;
    }
    const tabIds = group.tabIds as number[];
    groups.push({ title: group.title, color: group.color, tabIds });
    assigned.push(...tabIds);
  });
  const untouchedTabIds = value.untouchedTabIds.every(Number.isSafeInteger)
    ? value.untouchedTabIds as number[]
    : [];
  const lowValueTabIds = value.lowValueTabIds.every(Number.isSafeInteger)
    ? value.lowValueTabIds as number[]
    : [];
  if (untouchedTabIds.length !== value.untouchedTabIds.length ||
      lowValueTabIds.length !== value.lowValueTabIds.length) contractValid = false;
  assigned.push(...untouchedTabIds);
  const submitted = [...submittedIds].sort((a, b) => a - b);
  const actual = [...assigned].sort((a, b) => a - b);
  if (submitted.length !== actual.length ||
      submitted.some((id, index) => id !== actual[index])) contractValid = false;
  if (new Set(lowValueTabIds).size !== lowValueTabIds.length ||
      lowValueTabIds.some((id) => !submitted.includes(id))) contractValid = false;
  return {
    value: { groups, untouchedTabIds, ungroupTabIds, lowValueTabIds },
    contractValid,
  };
}

function pairs(groups: readonly { tabIds: readonly number[] }[]): Set<string> {
  const result = new Set<string>();
  groups.forEach((group) => {
    for (let left = 0; left < group.tabIds.length; left += 1) {
      for (let right = left + 1; right < group.tabIds.length; right += 1) {
        const ids = [group.tabIds[left]!, group.tabIds[right]!].sort((a, b) => a - b);
        result.add(`${ids[0]}:${ids[1]}`);
      }
    }
  });
  return result;
}

function normalizedTitle(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function groupSignature(tabIds: readonly number[]): string {
  return [...tabIds].sort((left, right) => left - right).join(",");
}

function titleScore(title: string, rule: BehaviorTitleRule): { score: number; generic: boolean } {
  const normalized = normalizedTitle(title);
  const words = normalized.split(/\s+/).filter(Boolean);
  const preferred = (rule.preferred ?? []).map(normalizedTitle);
  const forbidden = (rule.forbidden ?? []).map(normalizedTitle);
  const generic = GENERIC_NAMES.has(normalized) ||
    forbidden.some((term) => normalized === term || normalized.includes(term));
  if (generic) return { score: 0, generic: true };
  if (preferred.includes(normalized)) return { score: 100, generic: false };
  let score = 85;
  if ((rule.requiredAll ?? []).some((term) => !normalized.includes(normalizedTitle(term)))) {
    score = 25;
  } else if ((rule.requiredAny?.length ?? 0) > 0 &&
      !(rule.requiredAny ?? []).some((term) => normalized.includes(normalizedTitle(term)))) {
    score = 45;
  }
  if (Array.from(title).length > 24 || words.length > 4 || words.length === 0) {
    score = Math.min(score, 50);
  }
  return { score, generic: false };
}

function setAccuracy(
  actual: readonly number[],
  expected: readonly number[],
  submittedIds: readonly number[],
): number {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const correct = submittedIds.filter((id) => actualSet.has(id) === expectedSet.has(id)).length;
  return submittedIds.length === 0 ? 1 : correct / submittedIds.length;
}

export function scoreBehaviorResponse(
  output: string,
  submittedIds: readonly number[],
  spec: BehaviorCaseSpec,
): BehaviorQualityScore {
  const parsed = parseCandidate(output, submittedIds);
  if (!parsed.value) {
    return {
      totalScore: 0,
      contractValid: false,
      groupingScore: 0,
      pairPrecision: 0,
      pairRecall: 0,
      untouchedScore: 0,
      namingScore: 0,
      clutterScore: 0,
      colorScore: 0,
      overmergedGroups: 0,
      genericNames: 0,
      arrangementScore: null,
      reasons: [parsed.reason ?? "unusable response"],
    };
  }
  const actualPairs = pairs(parsed.value.groups);
  const expectedPairs = pairs(spec.groups);
  const truePositivePairs = [...actualPairs].filter((pair) => expectedPairs.has(pair)).length;
  const pairPrecision = actualPairs.size === 0
    ? (expectedPairs.size === 0 ? 1 : 0)
    : truePositivePairs / actualPairs.size;
  const pairRecall = expectedPairs.size === 0 ? 1 : truePositivePairs / expectedPairs.size;
  const groupingScore = 100 * (0.7 * pairPrecision + 0.3 * pairRecall);
  const untouchedScore = 100 * setAccuracy(
    parsed.value.untouchedTabIds,
    spec.untouchedTabIds,
    submittedIds,
  );
  const clutterScore = 100 * setAccuracy(
    parsed.value.lowValueTabIds,
    spec.lowValueTabIds,
    submittedIds,
  );

  let genericNames = 0;
  const namingScores = spec.groups.map((expectedGroup) => {
    const signature = [...expectedGroup.tabIds].sort((a, b) => a - b).join(",");
    const actualGroup = parsed.value!.groups.find((group) =>
      [...group.tabIds].sort((a, b) => a - b).join(",") === signature);
    if (!actualGroup) return 0;
    const result = titleScore(actualGroup.title, expectedGroup.title);
    if (result.generic) genericNames += 1;
    return result.score;
  });
  const namingScore = namingScores.length === 0
    ? parsed.value.groups.length === 0 ? 100 : 0
    : namingScores.reduce((sum, score) => sum + score, 0) / namingScores.length;

  const expectedLabel = new Map<number, string>();
  spec.groups.forEach((group, index) => {
    group.tabIds.forEach((id) => expectedLabel.set(id, `group-${index}`));
  });
  spec.untouchedTabIds.forEach((id) => expectedLabel.set(id, `untouched-${id}`));
  const overmergedGroups = parsed.value.groups.filter((group) =>
    new Set(group.tabIds.map((id) => expectedLabel.get(id) ?? `unknown-${id}`)).size > 1).length;

  const colorScores = parsed.value.groups.map((group) => {
    if (spec.colorMode !== "ai") return group.color === null ? 100 : 0;
    const color = String(group.color);
    if (!ALLOWED_COLORS.has(color)) return 0;
    const expected = spec.groups.find((candidate) =>
      groupSignature(candidate.tabIds) === groupSignature(group.tabIds));
    const rule = expected?.color;
    if (!rule) return 100;
    const allowed = rule.allowed ?? rule.preferred ?? [];
    if (allowed.length > 0 && !allowed.includes(color)) return 0;
    return rule.preferred?.includes(color) ? 100 : 75;
  });
  const colorScore = colorScores.length === 0
    ? 100
    : colorScores.reduce<number>((sum, score) => sum + score, 0) / colorScores.length;
  const arrangementParts: number[] = [];
  if (spec.looseClusters?.length) {
    const position = new Map(parsed.value.untouchedTabIds.map((id, index) => [id, index]));
    spec.looseClusters.forEach((cluster) => {
      const positions = cluster.map((id) => position.get(id));
      const placed = positions.filter((value): value is number => value !== undefined);
      const contiguous = placed.length === cluster.length &&
        Math.max(...placed) - Math.min(...placed) + 1 === cluster.length;
      arrangementParts.push(contiguous ? 100 : 0);
    });
  }
  if (spec.ungroupTabIds) {
    arrangementParts.push(100 * setAccuracy(parsed.value.ungroupTabIds, spec.ungroupTabIds, submittedIds));
  }
  const arrangementScore = arrangementParts.length === 0
    ? null
    : arrangementParts.reduce((sum, score) => sum + score, 0) / arrangementParts.length;

  const reasons: string[] = [];
  if (!parsed.contractValid) reasons.push("strict output contract failed");
  if (arrangementScore !== null && arrangementScore < 100) reasons.push("loose-tab arrangement or ungrouping was off");
  if (pairPrecision < 1) reasons.push("unrelated tabs were grouped");
  if (pairRecall < 1) reasons.push("coherent tab pairs were missed");
  if (genericNames > 0) reasons.push("generic or forbidden group names were used");
  if (overmergedGroups > 0) reasons.push(`${overmergedGroups} group(s) crossed expected topics`);
  if (clutterScore < 100) reasons.push("clutter decisions were unsafe or incomplete");
  if (colorScore < 100) reasons.push("colors were invalid or semantically mismatched");

  const weighted =
    groupingScore * 0.4 +
    untouchedScore * 0.15 +
    namingScore * 0.2 +
    clutterScore * 0.1 +
    colorScore * 0.05 +
    (parsed.contractValid ? 100 : 0) * 0.1;
  // Arrangement is a secondary quality: it takes 10% only when a case defines it,
  // so scores of cases without arrangement expectations stay comparable.
  const withArrangement = arrangementScore === null
    ? weighted
    : weighted * 0.9 + arrangementScore * 0.1;
  const uncappedScore = Math.max(
    0,
    Math.min(100, withArrangement - overmergedGroups * 15 - genericNames * 6),
  );
  const totalScore = parsed.contractValid ? uncappedScore : Math.min(49, uncappedScore);
  return {
    totalScore,
    contractValid: parsed.contractValid,
    groupingScore,
    pairPrecision,
    pairRecall,
    untouchedScore,
    namingScore,
    clutterScore,
    colorScore,
    overmergedGroups,
    genericNames,
    arrangementScore,
    reasons,
  };
}
