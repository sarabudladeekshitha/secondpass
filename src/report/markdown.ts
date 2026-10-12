import { createHash } from "node:crypto";
import type { RankedHunk, Report, Signal, Tier } from "../types.ts";

export const COMMENT_MARKER = "<!-- secondpass:report -->";

const ICON: Record<Tier, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪", trivial: "▫️" };
const MAX_COMMENT = 60_000;

export interface MarkdownOptions {
  /** PR web URL, e.g. https://github.com/o/r/pull/12 — enables line links. */
  prUrl?: string;
  /** How many non-trivial hunks to list in the table. */
  limit?: number;
  model?: string;
  /** Link to a full HTML report (workflow artifact). */
  reportUrl?: string;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function lineRange(h: RankedHunk): { side: "L" | "R"; start: number; end: number } {
  const deleted = h.file.status === "deleted" || h.added === 0;
  if (deleted) {
    return { side: "L", start: h.hunk.oldStart, end: h.hunk.oldStart + Math.max(0, h.hunk.oldLines - 1) };
  }
  const added = h.hunk.lines.filter((l) => l.kind === "add" && l.newLine !== undefined).map((l) => l.newLine!);
  return { side: "R", start: added[0] ?? h.hunk.newStart, end: added[added.length - 1] ?? h.hunk.newStart };
}

export function githubAnchor(prUrl: string, path: string, side: "L" | "R", line: number): string {
  const digest = createHash("sha256").update(path).digest("hex");
  return `${prUrl.replace(/\/$/, "")}/files#diff-${digest}${side}${line}`;
}

function location(h: RankedHunk, prUrl?: string): string {
  const { side, start, end } = lineRange(h);
  const label = `\`${h.hunk.path}\` ${start === end ? `L${start}` : `L${start}–${end}`}`;
  return prUrl ? `[${label}](${githubAnchor(prUrl, h.hunk.path, side, start)})` : label;
}

/** The reasons worth a reviewer's eye: strongest first, size and positive coverage last. */
export function headlineReasons(signals: Signal[], n = 2): string[] {
  const main = signals.filter((s) => s.weight > 0 && s.category !== "size" && s.category !== "coverage");
  const cov = signals.find((s) => s.id === "coverage.uncovered" || s.id === "coverage.file-missing");
  const out = main.slice(0, n).map((s) => s.reason);
  if (cov) out.push(cov.reason);
  if (!out.length) out.push(signals.find((s) => s.category === "size")?.reason ?? "Small change");
  return out;
}

export function renderMarkdown(report: Report, opts: MarkdownOptions = {}): string {
  const { totals } = report;
  const t = totals.byTier;
  const reviewable = report.hunks.filter((h) => h.risk.tier !== "trivial");
  const collapsed = report.hunks.filter((h) => h.risk.tier === "trivial");
  const limit = opts.limit ?? 25;

  const lines: string[] = [COMMENT_MARKER, "### SecondPass · where to look first", ""];
  lines.push(
    `**${totals.hunks} hunk${totals.hunks === 1 ? "" : "s"}** in ${totals.files} file${totals.files === 1 ? "" : "s"} (+${totals.added} −${totals.removed}) · ` +
      `${ICON.critical} ${t.critical} critical · ${ICON.high} ${t.high} high · ${ICON.medium} ${t.medium} medium · ${ICON.low} ${t.low} low · ${t.trivial} collapsed`,
  );
  lines.push("");
  if (!totals.coverageProvided) {
    lines.push("> Coverage not provided, so the ranking uses the diff alone. Pass `coverage-file` to rank untested changes higher.", "");
  }

  if (reviewable.length === 0) {
    lines.push("Nothing to rank: every hunk is a rename, formatting, import, comment or generated-file change.", "");
  } else {
    lines.push("| Risk | Where | What it does | Why it's ranked here |", "|---|---|---|---|");
    for (const h of reviewable.slice(0, limit)) {
      lines.push(
        `| ${ICON[h.risk.tier]} ${h.risk.score} | ${location(h, opts.prUrl)} | ${cell(h.summary ?? "")} | ${cell(headlineReasons(h.risk.signals).join(" · "))} |`,
      );
    }
    if (reviewable.length > limit) {
      lines.push("", `…and ${reviewable.length - limit} more lower-ranked hunk${reviewable.length - limit === 1 ? "" : "s"}${opts.reportUrl ? ` in the [full report](${opts.reportUrl})` : ""}.`);
    }
    lines.push("");
  }

  if (collapsed.length) {
    lines.push(`<details><summary>${collapsed.length} collapsed hunk${collapsed.length === 1 ? "" : "s"}: renames, formatting, imports, comments, generated files</summary>`, "");
    for (const h of collapsed) lines.push(`- ${location(h, opts.prUrl)} — ${h.risk.trivial?.reason ?? ""}`);
    lines.push("", "</details>", "");
  }
  if (report.notes.length) {
    lines.push("<details><summary>Not ranked</summary>", "", ...report.notes.map((n) => `- ${n}`), "", "</details>", "");
  }

  const modelLine = opts.model
    ? `One-line descriptions are written by \`${opts.model}\`; they never affect the order.`
    : "Descriptions are generated from the diff.";
  lines.push(
    `<sub>Order comes from the diff and test coverage only. ${modelLine}${opts.reportUrl ? ` · [Full report](${opts.reportUrl})` : ""}</sub>`,
  );

  let md = lines.join("\n");
  if (md.length > MAX_COMMENT) {
    md = md.slice(0, MAX_COMMENT - 200).replace(/\n[^\n]*$/, "") + "\n\n_Truncated: the PR is too large for one comment. See the full report._";
  }
  return md;
}

/* ------------------------------------------------------------- terminal */

const ANSI: Record<Tier, string> = { critical: "\x1b[31m", high: "\x1b[33m", medium: "\x1b[93m", low: "\x1b[37m", trivial: "\x1b[90m" };

export function renderText(report: Report, color = true): string {
  const c = (code: string, s: string) => (color ? `${code}${s}\x1b[0m` : s);
  const out: string[] = [];
  const t = report.totals.byTier;
  out.push(
    c("\x1b[1m", "SecondPass") +
      `  ${report.totals.hunks} hunks · ${t.critical} critical · ${t.high} high · ${t.medium} medium · ${t.low} low · ${t.trivial} collapsed`,
    "",
  );
  for (const h of report.hunks) {
    if (h.risk.tier === "trivial") continue;
    const { start, end } = lineRange(h);
    const loc = `${h.hunk.path}:${start}${end !== start ? `-${end}` : ""}`;
    out.push(`${c(ANSI[h.risk.tier], `${h.risk.tier.toUpperCase().padEnd(8)} ${String(h.risk.score).padStart(3)}`)}  ${c("\x1b[1m", loc)}`);
    if (h.summary) out.push(`              ${h.summary}`);
    for (const r of headlineReasons(h.risk.signals, 3)) out.push(c("\x1b[90m", `              · ${r}`));
    out.push("");
  }
  const collapsed = report.hunks.filter((h) => h.risk.tier === "trivial");
  if (collapsed.length) {
    out.push(c("\x1b[90m", `${collapsed.length} collapsed:`));
    for (const h of collapsed) out.push(c("\x1b[90m", `  ${h.hunk.path}:${lineRange(h).start}  ${h.risk.trivial?.reason}`));
  }
  return out.join("\n");
}
