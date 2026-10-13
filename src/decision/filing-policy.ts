import { NONE_OPTION, STAY_OPTION } from "./filing-state";

/**
 * The filing policy. Tiers only report distributions; this code decides whether
 * a tab moves. Anything below the bar abstains: a miss costs one ungrouped tab,
 * while a wrong move costs the user a tab they can't find.
 */

export interface FilingThresholds {
  /** Minimum p(top) for an ungrouped tab. */
  apply: number;
  /** Minimum p(top) − p(second). */
  margin: number;
  /** Minimum `fits` probability, when the tier asks the gate question. */
  fit: number | null;
  /** Minimum p(top) for a grouped tab that navigated to another site. */
  applyGrouped: number;
  /** Maximum p(stay) for a grouped tab to move at all. */
  stay: number;
}

export type FilingVerdict =
  | { action: "file"; target: string; confidence: number }
  | { action: "move"; target: string; confidence: number }
  | { action: "ungroup"; confidence: number }
  | { action: "abstain"; reason: "none" | "stay" | "low_confidence" | "low_margin" | "low_fit" };

export interface FilingEvidence {
  probabilities: Record<string, number>;
  /** True when the tab is in a group and navigated to another site. */
  grouped: boolean;
  fits?: number | null;
}

function ranked(probabilities: Record<string, number>): Array<[string, number]> {
  return Object.entries(probabilities).sort((left, right) => right[1] - left[1]);
}

export function decideFiling(evidence: FilingEvidence, thresholds: FilingThresholds): FilingVerdict {
  const [top, second] = ranked(evidence.probabilities);
  if (!top) return { action: "abstain", reason: "low_confidence" };
  const [option, probability] = top;
  const margin = probability - (second?.[1] ?? 0);
  if (evidence.grouped) {
    if ((evidence.probabilities[STAY_OPTION] ?? 0) > thresholds.stay || option === STAY_OPTION) {
      return { action: "abstain", reason: "stay" };
    }
    if (probability < thresholds.applyGrouped) return { action: "abstain", reason: "low_confidence" };
    if (margin < thresholds.margin) return { action: "abstain", reason: "low_margin" };
    return option === NONE_OPTION
      ? { action: "ungroup", confidence: probability }
      : { action: "move", target: option, confidence: probability };
  }
  if (option === NONE_OPTION) return { action: "abstain", reason: "none" };
  if (probability < thresholds.apply) return { action: "abstain", reason: "low_confidence" };
  if (margin < thresholds.margin) return { action: "abstain", reason: "low_margin" };
  if (thresholds.fit !== null && evidence.fits !== undefined && evidence.fits !== null && evidence.fits < thresholds.fit) {
    return { action: "abstain", reason: "low_fit" };
  }
  return { action: "file", target: option, confidence: probability };
}

export type ConfidencePreset = "conservative" | "balanced" | "eager";

/** Placeholder defaults from the plan; the filing benchmark replaces them per model. */
export const DEFAULT_FILING_THRESHOLDS: Record<ConfidencePreset, FilingThresholds> = {
  conservative: { apply: 0.92, margin: 0.4, fit: 0.7, applyGrouped: 0.95, stay: 0.05 },
  balanced: { apply: 0.85, margin: 0.3, fit: 0.5, applyGrouped: 0.9, stay: 0.1 },
  eager: { apply: 0.75, margin: 0.2, fit: 0.4, applyGrouped: 0.85, stay: 0.15 },
};

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * The thresholds for one preset. A calibration from the filing benchmark is the
 * Balanced preset for its own (protocol, model) pair; Conservative and Eager
 * move every bar the same distance as the defaults do. Without a calibration a
 * model gets Conservative whatever the preset, because probabilities aren't
 * comparable across models.
 */
export function presetThresholds(
  preset: ConfidencePreset,
  calibration: FilingThresholds | null,
): FilingThresholds {
  if (!calibration) return DEFAULT_FILING_THRESHOLDS.conservative;
  if (preset === "balanced") return calibration;
  const sign = preset === "conservative" ? 1 : -1;
  const base = DEFAULT_FILING_THRESHOLDS.balanced;
  const shifted = DEFAULT_FILING_THRESHOLDS[preset];
  const fitShift = (shifted.fit ?? 0) - (base.fit ?? 0);
  return {
    apply: clamp(calibration.apply + (shifted.apply - base.apply), 0.5, 0.995),
    margin: clamp(calibration.margin + (shifted.margin - base.margin), 0, 0.9),
    fit: calibration.fit === null ? null : clamp(calibration.fit + fitShift, 0, 0.99),
    applyGrouped: clamp(calibration.applyGrouped + (shifted.applyGrouped - base.applyGrouped), 0.5, 0.995),
    // A smaller stay ceiling is stricter: it moves opposite to the others.
    stay: clamp(calibration.stay - sign * Math.abs(shifted.stay - base.stay), 0.01, 0.5),
  };
}

/**
 * A group in another window wins only with an extra margin: its own bar is
 * raised by 0.05, and it must beat the best same-window group by `margin`.
 */
const CROSS_WINDOW_APPLY_BONUS = 0.05;

export function crossWindowAllowed(
  probabilities: Record<string, number>,
  target: string,
  sameWindowKeys: ReadonlySet<string>,
  thresholds: FilingThresholds,
  grouped: boolean,
): boolean {
  const probability = probabilities[target] ?? 0;
  const bar = (grouped ? thresholds.applyGrouped : thresholds.apply) + CROSS_WINDOW_APPLY_BONUS;
  if (probability < bar) return false;
  const bestSameWindow = Math.max(0, ...Object.entries(probabilities)
    .filter(([key]) => sameWindowKeys.has(key) || key === STAY_OPTION)
    .map(([, value]) => value));
  return probability - bestSameWindow >= thresholds.margin;
}

export function normalizeFilingThresholds(value: unknown): FilingThresholds | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const unit = (item: unknown): number | null =>
    typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1 ? item : null;
  const apply = unit(record.apply);
  const margin = unit(record.margin);
  const applyGrouped = unit(record.applyGrouped);
  const stay = unit(record.stay);
  if (apply === null || margin === null || applyGrouped === null || stay === null) return null;
  // The benchmark never recommends a bar under 0.5; anything lower is a typo, not a calibration.
  if (apply < 0.5 || applyGrouped < 0.5) return null;
  return { apply, margin, fit: record.fit === null ? null : unit(record.fit), applyGrouped, stay };
}
