import type { CoverageStat, Signal, Tier } from "../types.ts";

/** Signals at or above this weight are never discounted by coverage. */
export const SEVERE = 50;

export const TIER_THRESHOLDS = { critical: 65, high: 40, medium: 18 } as const;

export function tierFor(score: number): Exclude<Tier, "trivial"> {
  if (score >= TIER_THRESHOLDS.critical) return "critical";
  if (score >= TIER_THRESHOLDS.high) return "high";
  if (score >= TIER_THRESHOLDS.medium) return "medium";
  return "low";
}

/**
 * Combine signal weights with diminishing returns: the strongest signal
 * counts in full, the next half, then a quarter, and so on. Ten weak signals
 * should not outrank one destructive migration.
 */
export function combine(signals: Signal[]): number {
  const weights = signals.map((s) => s.weight).filter((w) => w > 0).sort((a, b) => b - a);
  let total = 0;
  let factor = 1;
  for (const w of weights) {
    total += w * factor;
    factor /= 2;
  }
  return total;
}

export interface ScoreInput {
  signals: Signal[];
  coverage: CoverageStat;
  isTest: boolean;
  isDoc: boolean;
}

/**
 * Turn signals + coverage into a 0–100 score. Returns any extra signals the
 * scoring step itself contributes (coverage), so every point is explained.
 */
export function score({ signals, coverage, isTest, isDoc }: ScoreInput): { score: number; extra: Signal[] } {
  let raw = combine(signals);
  const extra: Signal[] = [];

  // Test and doc changes matter less, unless they weaken the test suite.
  const weakensTests = signals.some((s) => s.id.startsWith("test."));
  if (isDoc) raw *= 0.3;
  else if (isTest && !weakensTests) raw *= 0.5;

  // Coverage scales risk: an untested change to auth is worse than a tested one.
  if (coverage.status === "measured" && coverage.instrumented > 0) {
    const uncovered = coverage.instrumented - coverage.covered;
    const u = uncovered / coverage.instrumented;
    let multiplier = 0.8 + 0.6 * u; // 0.8× fully covered … 1.4× never run
    // Tests executing a line prove it runs, not that it is right. A severe
    // change (a dropped column, a removed auth check) is never discounted.
    if (signals.some((s) => s.weight >= SEVERE)) multiplier = Math.max(1, multiplier);
    const delta = raw * multiplier - raw;
    raw *= multiplier;
    if (Math.round(delta) !== 0) extra.push(
      uncovered > 0
        ? {
            id: "coverage.uncovered",
            category: "coverage",
            weight: Math.round(delta),
            reason: `${uncovered} of ${coverage.instrumented} changed executable line${coverage.instrumented === 1 ? "" : "s"} never run by tests`,
          }
        : {
            id: "coverage.covered",
            category: "coverage",
            weight: Math.round(delta),
            reason: `All ${coverage.instrumented} changed executable line${coverage.instrumented === 1 ? " is" : "s are"} run by tests`,
          },
    );
  } else if (coverage.status === "file-missing") {
    const delta = raw * 0.2;
    raw += delta;
    extra.push({
      id: "coverage.file-missing",
      category: "coverage",
      weight: Math.round(delta),
      reason: "File does not appear in the coverage report (no test loads it)",
    });
  }

  return { score: Math.min(100, Math.round(raw)), extra };
}
