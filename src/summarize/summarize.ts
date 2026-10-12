import { hunkToText } from "../diff/parse.ts";
import type { RankedHunk, Report } from "../types.ts";

export interface SummaryRequest {
  id: string;
  path: string;
  section: string;
  diff: string;
}

/** Anything that can describe hunks. It receives the diff and nothing else. */
export interface Summarizer {
  summarize(items: SummaryRequest[]): Promise<Map<string, string>>;
}

/**
 * Words that turn a description into a verdict. The model is asked not to
 * use them; if it does anyway, the summary is discarded. A reviewer who sees
 * "safely refactors" learns to skip, and the one time it's wrong is the
 * time that matters.
 */
const VERDICT =
  /\b(safe(ly)?|unsafe|risk(y|s)?|dangerous|harmless|innocuous|critical|severe|minor|trivial|benign|lgtm|looks\s+good|should|must|recommend\w*|consider|careful|concern\w*|potential(ly)?|bug(s|gy)?|vulnerab\w*|correct(ly)?|incorrect(ly)?|properly|improperly|well[- ]tested|untested|no\s+(functional|behaviou?r(al)?)\s+change|just|simply|merely|only\s+(a|cosmetic)|cosmetic|clean(s|ed)?\s*up|best\s+practice)\b/i;

export function sanitizeSummary(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[-*•]\s*/, "").replace(/^["'`]|["'`]$/g, "").trim();
  if (!s || s.length < 6) return undefined;
  if (VERDICT.test(s)) return undefined;
  if (s.length > 140) s = s.slice(0, 139).replace(/\s+\S*$/, "") + "…";
  return s.replace(/\.$/, "");
}

/** Deterministic fallback when no model is configured or it declined. */
export function heuristicSummary(h: RankedHunk): string {
  if (h.risk.trivial) return h.risk.trivial.reason;
  // Git's hunk context is a guess; only trust it when it looks like a definition.
  const section = h.hunk.section.replace(/\s*[{:]\s*$/, "").trim();
  const definition = /^(?!import\b|from\b|export\s*\{|#include|use\s|require)/.test(section) && /\(|\bclass\b|\bdef\b|\bfn\b|\bfunc\b|=>/.test(section);
  const where = definition ? ` in \`${section.length > 60 ? section.slice(0, 59) + "…" : section}\`` : "";
  if (h.file.status === "added") return `New file: ${h.added} line${h.added === 1 ? "" : "s"}`;
  if (h.file.status === "deleted") return `Deletes file: ${h.removed} line${h.removed === 1 ? "" : "s"}`;
  if (h.removed === 0) return `Adds ${h.added} line${h.added === 1 ? "" : "s"}${where}`;
  if (h.added === 0) return `Removes ${h.removed} line${h.removed === 1 ? "" : "s"}${where}`;
  return `Changes ${h.removed} → ${h.added} lines${where}`;
}

export interface AttachOptions {
  /** Only the top N non-trivial hunks are sent to the model. */
  maxHunks?: number;
  onError?: (err: unknown) => void;
}

/**
 * Add summaries to a finished report. The ranking is frozen before this runs
 * and is checked afterwards: if anything about order, score or tier differs,
 * that is a bug and we throw rather than publish a model-influenced ranking.
 */
export async function attachSummaries(report: Report, summarizer: Summarizer | undefined, opts: AttachOptions = {}): Promise<Report> {
  const fingerprint = rankingFingerprint(report);
  const candidates = report.hunks.filter((h) => !h.risk.trivial).slice(0, opts.maxHunks ?? 60);

  let fromModel = new Map<string, string>();
  if (summarizer && candidates.length) {
    try {
      fromModel = await summarizer.summarize(
        candidates.map((h) => ({ id: h.hunk.id, path: h.hunk.path, section: h.hunk.section, diff: hunkToText(h.hunk, 300) })),
      );
    } catch (err) {
      opts.onError?.(err);
    }
  }

  const hunks = report.hunks.map((h): RankedHunk => {
    const model = sanitizeSummary(fromModel.get(h.hunk.id));
    return model
      ? { ...h, summary: model, summarySource: "model" }
      : { ...h, summary: heuristicSummary(h), summarySource: "heuristic" };
  });
  const out: Report = { ...report, hunks };
  if (rankingFingerprint(out) !== fingerprint) {
    throw new Error("internal: summaries changed the ranking");
  }
  return out;
}

export function rankingFingerprint(report: Report): string {
  return report.hunks.map((h) => `${h.hunk.id}|${h.risk.score}|${h.risk.tier}`).join("\n");
}
