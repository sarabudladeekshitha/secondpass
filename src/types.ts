/**
 * Core data model.
 *
 * The important boundary in this file: `RankedHunk.risk` is computed from the
 * diff and coverage only. `RankedHunk.summary` is written by a language model
 * *after* ranking is final, and nothing downstream reads it to make a decision.
 */

export type LineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: LineKind;
  text: string;
  /** Line number in the old file (del + ctx lines). */
  oldLine?: number;
  /** Line number in the new file (add + ctx lines). */
  newLine?: number;
}

export interface Hunk {
  /** Stable id: `<path>:<newStart>` (or old path/start for deletions). */
  id: string;
  /** Path the reviewer sees (new path, or old path if the file was deleted). */
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@`, usually the enclosing function. */
  section: string;
  lines: DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface FileDiff {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  /** `similarity index` for renames, 0–100. */
  similarity?: number;
  binary: boolean;
  hunks: Hunk[];
}

export type Category =
  | "migration"
  | "auth"
  | "money"
  | "behaviour"
  | "security"
  | "data"
  | "error-handling"
  | "concurrency"
  | "api"
  | "config"
  | "dependency"
  | "coverage"
  | "size";

export interface Signal {
  /** Machine-readable id, e.g. `sql.drop-column`. */
  id: string;
  category: Category;
  /** Points contributed before diminishing returns. */
  weight: number;
  /** Human-readable reason shown to the reviewer. */
  reason: string;
  /** Indices into `hunk.lines` of the lines that triggered it (evidence). */
  at?: number[];
}

export type TrivialKind =
  | "formatting"
  | "rename"
  | "comments"
  | "imports"
  | "generated"
  | "pure-rename";

export interface Triviality {
  kind: TrivialKind;
  reason: string;
}

export type Tier = "critical" | "high" | "medium" | "low" | "trivial";

export interface CoverageStat {
  /** Changed (added) lines the coverage report knows are executable. */
  instrumented: number;
  /** Of those, how many were executed at least once. */
  covered: number;
  /** Added line numbers that are instrumented but never executed. */
  uncoveredLines: number[];
  /** `none` = no lcov given; `file-missing` = lcov given but file absent. */
  status: "measured" | "none" | "file-missing" | "not-executable";
}

export interface Risk {
  score: number;
  tier: Tier;
  signals: Signal[];
  coverage: CoverageStat;
  trivial?: Triviality;
}

export interface RankedHunk {
  hunk: Hunk;
  file: Pick<FileDiff, "oldPath" | "newPath" | "status">;
  risk: Risk;
  /** One-line description of what the hunk does. Never used for ranking. */
  summary?: string;
  summarySource?: "model" | "heuristic";
  added: number;
  removed: number;
}

export interface Report {
  version: 1;
  generatedAt: string;
  source?: {
    repo?: string;
    pr?: number;
    title?: string;
    baseSha?: string;
    headSha?: string;
    url?: string;
  };
  totals: {
    files: number;
    hunks: number;
    added: number;
    removed: number;
    byTier: Record<Tier, number>;
    coverageProvided: boolean;
  };
  /** Ranked, highest risk first. Trivial hunks are last. */
  hunks: RankedHunk[];
  /** Files with no reviewable hunks (binary, pure renames, mode changes). */
  notes: string[];
}
