import type { CoverageStat, Hunk } from "../types.ts";
import { extname } from "./lang.ts";

/** path -> (line -> hit count). Only executable lines appear. */
export type CoverageMap = Map<string, Map<number, number>>;

/** Parse an lcov tracefile (`coverage/lcov.info`). */
export function parseLcov(text: string): CoverageMap {
  const map: CoverageMap = new Map();
  let current: Map<number, number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const path = normalize(line.slice(3));
      current = map.get(path) ?? new Map();
      map.set(path, current);
    } else if (line.startsWith("DA:") && current) {
      const [ln, count] = line.slice(3).split(",");
      const n = Number(ln);
      const c = Number(count);
      if (Number.isFinite(n) && Number.isFinite(c)) current.set(n, Math.max(current.get(n) ?? 0, c));
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  return map;
}

/** Parse Cobertura XML (coverage.py `coverage xml`, JaCoCo via converters, Istanbul `cobertura`). */
export function parseCobertura(xml: string): CoverageMap {
  const map: CoverageMap = new Map();
  const sources = [...xml.matchAll(/<source>([^<]*)<\/source>/g)].map((m) => m[1]!.trim());
  for (const cls of xml.matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
    let path = decodeXml(cls[1]!);
    // Prefer a repo-relative path. If `<source>` is an absolute checkout path, keep the file relative.
    if (path.startsWith("/") && sources.length) {
      const src = sources.find((s) => path.startsWith(s));
      if (src) path = path.slice(src.length).replace(/^\/+/, "");
    }
    const key = normalize(path);
    const lines = map.get(key) ?? new Map<number, number>();
    for (const l of cls[2]!.matchAll(/<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g)) {
      const n = Number(l[1]);
      lines.set(n, Math.max(lines.get(n) ?? 0, Number(l[2])));
    }
    map.set(key, lines);
  }
  return map;
}

export function parseCoverage(text: string): CoverageMap {
  return /<coverage\b/.test(text.slice(0, 2000)) ? parseCobertura(text) : parseLcov(text);
}

export function mergeCoverage(maps: CoverageMap[]): CoverageMap {
  const out: CoverageMap = new Map();
  for (const m of maps) {
    for (const [path, lines] of m) {
      const target = out.get(path) ?? new Map<number, number>();
      for (const [n, c] of lines) target.set(n, Math.max(target.get(n) ?? 0, c));
      out.set(path, target);
    }
  }
  return out;
}

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function normalize(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Find the coverage entry for a repo-relative path. Coverage tools often
 * record absolute CI paths (`/home/runner/work/app/app/src/x.ts`), so match
 * the longest entry that ends with `/<path>`.
 */
export function lookup(map: CoverageMap, repoPath: string): Map<number, number> | undefined {
  const want = normalize(repoPath);
  const exact = map.get(want);
  if (exact) return exact;
  let best: Map<number, number> | undefined;
  let bestLen = -1;
  for (const [path, lines] of map) {
    if (path.endsWith("/" + want) && path.length > bestLen) {
      best = lines;
      bestLen = path.length;
    } else if (want.endsWith("/" + path) && path.length > bestLen) {
      // Coverage recorded relative to a package root inside a monorepo.
      best = lines;
      bestLen = path.length;
    }
  }
  return best;
}

const CODE_EXT = new Set([
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py", "rb", "go", "rs", "java", "kt", "kts",
  "scala", "cs", "php", "swift", "c", "cc", "cpp", "h", "hpp", "m", "ex", "exs", "erl", "clj", "dart", "vue", "svelte",
]);

export function isExecutableSource(path: string): boolean {
  return CODE_EXT.has(extname(path));
}

/** Coverage of the *added* lines of a hunk. */
export function hunkCoverage(h: Hunk, map: CoverageMap | undefined, opts: { isTest: boolean }): CoverageStat {
  const base: CoverageStat = { instrumented: 0, covered: 0, uncoveredLines: [], status: "none" };
  if (!map) return base;
  if (!isExecutableSource(h.path) || opts.isTest) return { ...base, status: "not-executable" };
  const lines = lookup(map, h.path);
  if (!lines) return { ...base, status: "file-missing" };
  const stat: CoverageStat = { ...base, status: "measured" };
  for (const l of h.lines) {
    if (l.kind !== "add" || l.newLine === undefined) continue;
    const hits = lines.get(l.newLine);
    if (hits === undefined) continue;
    stat.instrumented++;
    if (hits > 0) stat.covered++;
    else stat.uncoveredLines.push(l.newLine);
  }
  return stat;
}
