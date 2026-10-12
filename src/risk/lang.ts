/** Small, language-agnostic helpers for reading changed lines. */

export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
}

/** Languages where leading whitespace changes meaning. */
export function indentationSignificant(path: string): boolean {
  const ext = extname(path);
  return ["py", "pyi", "yaml", "yml", "makefile", "mk", "haml", "slim", "pug", "coffee", "nim"].includes(ext);
}

const HASH_COMMENT_EXT = new Set([
  "py", "pyi", "rb", "sh", "bash", "zsh", "yaml", "yml", "toml", "r", "pl", "ex", "exs",
  "tf", "conf", "ini", "dockerfile", "makefile", "mk", "cfg", "gitignore", "env",
]);
const DASH_COMMENT_EXT = new Set(["sql", "lua", "hs", "elm"]);

/** True if a whole line is a comment (or part of a block comment). */
export function isCommentLine(text: string, path: string): boolean {
  const t = text.trim();
  if (t === "") return true;
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/")) return true;
  if (t.startsWith("<!--") || t.endsWith("-->")) return true;
  const ext = extname(path);
  if (t.startsWith("#") && (HASH_COMMENT_EXT.has(ext) || path.endsWith("Dockerfile")) && !t.startsWith("#!")) {
    return true;
  }
  if (t.startsWith("--") && DASH_COMMENT_EXT.has(ext)) return true;
  if (/^("""|''')/.test(t) && (ext === "py" || ext === "pyi")) return true;
  return false;
}

const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\S/g;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

export function isIdentifier(tok: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(tok) && !KEYWORDS.has(tok);
}

/** Tokens whose substitution is never a "rename". */
export const KEYWORDS = new Set([
  "if", "else", "elif", "for", "while", "do", "switch", "case", "default", "break", "continue",
  "return", "yield", "throw", "raise", "try", "catch", "except", "finally", "with", "as",
  "async", "await", "new", "delete", "typeof", "instanceof", "in", "of", "is", "not", "and", "or",
  "true", "false", "True", "False", "null", "None", "nil", "undefined", "NaN", "Infinity",
  "const", "let", "var", "function", "def", "class", "fn", "func", "lambda", "static", "public",
  "private", "protected", "readonly", "final", "export", "import", "from", "extends", "implements",
  "void", "this", "self", "super", "pass", "go", "defer", "select", "unsafe", "mut", "ref", "move",
  "Some", "Ok", "Err", "any", "unknown", "never",
]);

/** Remove whitespace and cosmetic punctuation so formatting changes compare equal. */
export function normalizeForFormatting(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/;+$/g, "")
    .replace(/;(?=[)}\]]|$)/g, "")
    .replace(/,(?=[)}\]])/g, "");
}

const IMPORT_START =
  /^\s*(import\b|from\s+[\w.]+\s+import\b|export\s+\*\s+from\b|export\s+(type\s+)?\{|(const|let|var)\s+[^=]+=\s*require\(|use\s+[\w:{]|#include\s|using\s+[\w.]+\s*;|require\s*\(?\s*['"]|require_relative\s)/;

export function isImportStart(text: string): boolean {
  return IMPORT_START.test(text);
}

/**
 * Group consecutive lines into import statements. Returns undefined if any
 * line is not part of an import, so callers can tell "only imports changed".
 */
export function importStatements(lines: string[]): string[] | undefined {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    if (depth === 0) {
      if (!isImportStart(raw)) return undefined;
      buf = raw;
    } else {
      buf += " " + raw;
    }
    for (const ch of raw) {
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") depth--;
    }
    if (depth <= 0) {
      depth = 0;
      out.push(normalizeImport(buf));
      buf = "";
    }
  }
  if (depth !== 0) return undefined;
  return out;
}

function normalizeImport(stmt: string): string {
  const flat = stmt.replace(/\s+/g, " ").replace(/;\s*$/, "").replace(/'/g, '"').trim();
  // Sort named specifiers so `{ b, a }` equals `{ a, b }`.
  return flat.replace(/\{([^}]*)\}/g, (_, inner: string) => {
    const names = inner.split(",").map((s) => s.trim()).filter(Boolean).sort();
    return `{${names.join(",")}}`;
  }).replace(/\s+/g, "");
}

/** Similarity of two strings on a 0..1 scale (token Dice coefficient). */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(t, c - 1);
    }
  }
  return (2 * shared) / (ta.length + tb.length);
}
