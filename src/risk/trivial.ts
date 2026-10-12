import type { FileDiff, Hunk, Triviality } from "../types.ts";
import {
  importStatements,
  indentationSignificant,
  isCommentLine,
  isIdentifier,
  normalizeForFormatting,
  tokenize,
} from "./lang.ts";

const GENERATED: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)flake\.lock$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
  /\.pb\.go$/,
  /_pb2(_grpc)?\.pyi?$/,
  /\.generated\.\w+$/,
  /(^|\/)(__generated__|generated)\//,
];

export function isGeneratedPath(path: string): boolean {
  return GENERATED.some((re) => re.test(path));
}

/** Normalise each line, then join and drop separators a re-wrap can add (`c,\n)`). */
function flatten(lines: string[]): string {
  return lines.map(normalizeForFormatting).join("").replace(/[,;]+(?=[)}\]])/g, "");
}

/** A consistent identifier substitution found in a hunk, e.g. `amt -> amount`. */
export type RenameMap = Map<string, string>;

/**
 * If every removed line pairs with an added line that differs only by a
 * consistent, one-to-one identifier substitution, return that substitution.
 */
export function renameMapping(h: Hunk): RenameMap | undefined {
  const removed = h.lines.filter((l) => l.kind === "del" && l.text.trim() !== "");
  const added = h.lines.filter((l) => l.kind === "add" && l.text.trim() !== "");
  if (removed.length === 0 || removed.length !== added.length) return undefined;

  const forward: RenameMap = new Map();
  const backward = new Map<string, string>();
  for (let i = 0; i < removed.length; i++) {
    const a = tokenize(removed[i]!.text);
    const b = tokenize(added[i]!.text);
    if (a.length !== b.length) return undefined;
    for (let j = 0; j < a.length; j++) {
      const x = a[j]!;
      const y = b[j]!;
      if (x === y) continue;
      if (!isIdentifier(x) || !isIdentifier(y)) return undefined;
      if ((forward.get(x) ?? y) !== y || (backward.get(y) ?? x) !== x) return undefined;
      forward.set(x, y);
      backward.set(y, x);
    }
  }
  if (forward.size === 0) return undefined;

  // A rename is complete: the old name must not survive in the new lines,
  // and the new name must not already be in use on the old lines.
  const addedTokens = new Set(added.flatMap((l) => tokenize(l.text)));
  const removedTokens = new Set(removed.flatMap((l) => tokenize(l.text)));
  for (const [from, to] of forward) {
    if (addedTokens.has(from) || removedTokens.has(to)) return undefined;
  }
  return forward;
}

const DECLARATION = /\b(const|let|var|function|def|class|interface|type|enum|struct|fn|func|val)\s+([A-Za-z_$][\w$]*)/g;

function declares(h: Hunk, name: string): boolean {
  for (const l of h.lines) {
    if (l.kind !== "del") continue;
    for (const m of l.text.matchAll(DECLARATION)) if (m[2] === name) return true;
    // Function parameters: `(amount, currency)` / `def f(amount):`
    const esc = name.replace(/\$/g, "\\$");
    if (new RegExp(`[(,]\\s*${esc}\\s*[:,)=?]`).test(l.text)) return true;
  }
  return false;
}

/**
 * Decide whether a hunk can be collapsed. Every rule errs towards *not*
 * collapsing: hiding a real change is worse than showing a boring one.
 *
 * @param renameSupport how many hunks in the whole PR share each rename,
 *   keyed `from->to`. A substitution seen once, of a name not declared in the
 *   hunk, might be `b` replaced with an existing `c`, which is a behaviour
 *   change, so it is only collapsed when the evidence is stronger.
 */
export function classifyTrivial(
  file: FileDiff,
  h: Hunk,
  renameSupport: Map<string, number> = new Map(),
): Triviality | undefined {
  const path = h.path;
  if (isGeneratedPath(path)) {
    return { kind: "generated", reason: "Generated or lock file" };
  }

  const removed = h.lines.filter((l) => l.kind === "del").map((l) => l.text);
  const added = h.lines.filter((l) => l.kind === "add").map((l) => l.text);
  if (removed.length === 0 && added.length === 0) return undefined;

  // Comment-only: every changed line is a comment or blank.
  if ([...removed, ...added].every((t) => isCommentLine(t, path))) {
    const allBlank = [...removed, ...added].every((t) => t.trim() === "");
    return allBlank
      ? { kind: "formatting", reason: "Blank lines only" }
      : { kind: "comments", reason: "Comments only" };
  }

  // Formatting-only. In indentation-significant languages, leading
  // whitespace is meaning, so lines must pair up with indentation intact.
  if (indentationSignificant(path)) {
    const r = removed.filter((t) => t.trim() !== "");
    const a = added.filter((t) => t.trim() !== "");
    const key = (t: string) => (t.match(/^\s*/)?.[0].length ?? 0) + "|" + normalizeForFormatting(t);
    if (r.length === a.length && r.every((t, i) => key(t) === key(a[i]!))) {
      return { kind: "formatting", reason: "Whitespace and punctuation only" };
    }
  } else if (flatten(removed) === flatten(added)) {
    return { kind: "formatting", reason: "Whitespace, quotes or punctuation only" };
  }

  // Import reordering: the same set of import statements, in another order.
  const before = importStatements(removed);
  const after = importStatements(added);
  if (before && after && before.length > 0) {
    const a = [...before].sort().join("\n");
    const b = [...after].sort().join("\n");
    if (a === b) return { kind: "imports", reason: "Imports reordered" };
  }

  // Identifier rename.
  const map = renameMapping(h);
  if (map) {
    const pairs = [...map].map(([from, to]) => `${from}->${to}`);
    const seenElsewhere = pairs.every((p) => (renameSupport.get(p) ?? 0) >= 2);
    const declared = [...map.keys()].every((from) => declares(h, from));
    // Note: substituting a name many times is *not* evidence on its own —
    // `if (a < b) return b` → `if (a < c) return c` uses a different variable.
    if (seenElsewhere || declared) {
      const label = [...map].map(([from, to]) => `\`${from}\` → \`${to}\``).join(", ");
      return { kind: "rename", reason: `Rename only: ${label}` };
    }
  }

  return undefined;
}

/** Count, across all hunks, how often each rename pair appears. */
export function collectRenameSupport(files: FileDiff[]): Map<string, number> {
  const support = new Map<string, number>();
  for (const f of files) {
    for (const h of f.hunks) {
      const map = renameMapping(h);
      if (!map) continue;
      for (const [from, to] of map) {
        const k = `${from}->${to}`;
        support.set(k, (support.get(k) ?? 0) + 1);
      }
    }
  }
  return support;
}
