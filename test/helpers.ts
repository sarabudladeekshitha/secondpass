import { analyze } from "../src/analyze.ts";
import type { RankedHunk, Report } from "../src/types.ts";

/** Build a one-file git diff from before/after line arrays (single hunk). */
export function diffOf(path: string, removed: string[], added: string[], opts: { context?: string[]; start?: number } = {}): string {
  const ctx = opts.context ?? [];
  const start = opts.start ?? 1;
  const body = [...ctx.map((l) => " " + l), ...removed.map((l) => "-" + l), ...added.map((l) => "+" + l)];
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${ctx.length + removed.length} +${start},${ctx.length + added.length} @@`,
    ...body,
    "",
  ].join("\n");
}

export function only(report: Report): RankedHunk {
  if (report.hunks.length !== 1) throw new Error(`expected 1 hunk, got ${report.hunks.length}`);
  return report.hunks[0]!;
}

export function rank(path: string, removed: string[], added: string[], context?: string[]): RankedHunk {
  return only(analyze(diffOf(path, removed, added, { context })));
}

export const ids = (h: RankedHunk) => h.risk.signals.map((s) => s.id);
