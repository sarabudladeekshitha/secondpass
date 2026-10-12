import { parseDiff } from "./diff/parse.ts";
import { hunkCoverage, type CoverageMap } from "./risk/coverage.ts";
import { score, tierFor } from "./risk/score.ts";
import { detectSignals, isDocPath, isTestPath } from "./risk/signals.ts";
import { classifyTrivial, collectRenameSupport } from "./risk/trivial.ts";
import type { FileDiff, RankedHunk, Report, Tier } from "./types.ts";

export interface AnalyzeOptions {
  coverage?: CoverageMap;
  source?: Report["source"];
  /** Glob-free path prefixes / regexes to ignore entirely. */
  ignore?: RegExp[];
  now?: Date;
}

const TIER_ORDER: Record<Tier, number> = { critical: 0, high: 1, medium: 2, low: 3, trivial: 4 };

/**
 * Rank every hunk in a diff. Deterministic and model-free: the same diff and
 * coverage always produce the same order. Summaries are attached later by
 * `attachSummaries`, which cannot change anything computed here.
 */
export function analyze(diff: string | FileDiff[], opts: AnalyzeOptions = {}): Report {
  const files = (typeof diff === "string" ? parseDiff(diff) : diff).filter(
    (f) => !(opts.ignore ?? []).some((re) => re.test(f.newPath) || re.test(f.oldPath)),
  );
  const renameSupport = collectRenameSupport(files);
  const hunks: RankedHunk[] = [];
  const notes: string[] = [];

  for (const file of files) {
    if (file.binary) notes.push(`Binary file ${file.status}: ${file.newPath}`);
    else if (file.status === "renamed" && file.hunks.length === 0) {
      notes.push(`Renamed without changes: ${file.oldPath} → ${file.newPath}`);
    } else if (file.hunks.length === 0) notes.push(`${file.status === "added" ? "Empty file added" : "Mode or metadata change"}: ${file.newPath}`);

    for (const hunk of file.hunks) {
      const added = hunk.lines.filter((l) => l.kind === "add").length;
      const removed = hunk.lines.filter((l) => l.kind === "del").length;
      const isTest = isTestPath(hunk.path);
      const isDoc = isDocPath(hunk.path);
      const coverage = hunkCoverage(hunk, opts.coverage, { isTest });
      const trivial = classifyTrivial(file, hunk, renameSupport);
      const fileRef = { oldPath: file.oldPath, newPath: file.newPath, status: file.status };

      if (trivial) {
        hunks.push({ hunk, file: fileRef, added, removed, risk: { score: 0, tier: "trivial", signals: [], coverage, trivial } });
        continue;
      }
      const signals = detectSignals(file, hunk);
      const { score: s, extra } = score({ signals, coverage, isTest, isDoc });
      const all = [...signals, ...extra].sort((a, b) => b.weight - a.weight);
      hunks.push({ hunk, file: fileRef, added, removed, risk: { score: s, tier: tierFor(s), signals: all, coverage } });
    }
  }

  hunks.sort(
    (a, b) =>
      TIER_ORDER[a.risk.tier] - TIER_ORDER[b.risk.tier] ||
      b.risk.score - a.risk.score ||
      a.hunk.path.localeCompare(b.hunk.path) ||
      a.hunk.newStart - b.hunk.newStart,
  );

  const byTier: Record<Tier, number> = { critical: 0, high: 0, medium: 0, low: 0, trivial: 0 };
  for (const h of hunks) byTier[h.risk.tier]++;

  return {
    version: 1,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    source: opts.source,
    totals: {
      files: files.length,
      hunks: hunks.length,
      added: hunks.reduce((n, h) => n + h.added, 0),
      removed: hunks.reduce((n, h) => n + h.removed, 0),
      byTier,
      coverageProvided: opts.coverage !== undefined,
    },
    hunks,
    notes,
  };
}
