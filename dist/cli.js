#!/usr/bin/env node

// src/cli.ts
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

// package.json
var package_default = {
  name: "secondpass",
  version: "0.1.0",
  description: "Make AI-written pull requests reviewable: rank every hunk by risk from the diff and test coverage, collapse the noise.",
  type: "module",
  license: "MIT",
  author: "Deekshitha Sarabudla",
  repository: {
    type: "git",
    url: "git+https://github.com/sarabudladeekshitha/secondpass.git"
  },
  bin: {
    secondpass: "dist/cli.js"
  },
  files: [
    "dist",
    "action.yml",
    "README.md"
  ],
  engines: {
    node: ">=22.18"
  },
  scripts: {
    build: "node scripts/build.ts",
    typecheck: "tsc -p tsconfig.json && tsc -p web/tsconfig.json",
    test: 'node --test --test-reporter=spec "test/**/*.test.ts"',
    demo: "node src/cli.ts --diff examples/sample.diff --coverage examples/lcov.info --html report.html --format text",
    check: "npm run typecheck && npm test && npm run build"
  },
  devDependencies: {
    "@types/node": "^24.0.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    esbuild: "0.28.2",
    react: "19.2.8",
    "react-dom": "19.2.8",
    typescript: "~6.0.3"
  },
  keywords: [
    "code-review",
    "pull-requests",
    "github-action",
    "risk",
    "diff",
    "ai",
    "claude"
  ]
};

// src/diff/parse.ts
var HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
function unquote(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i];
    if (next && /[0-7]/.test(next)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      const map = { n: "\n", t: "	", '"': '"', "\\": "\\" };
      bytes.push(...Buffer.from(map[next ?? ""] ?? next ?? "", "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
function stripPrefix(p) {
  const q = unquote(p.trim());
  if (q === "/dev/null") return q;
  return q.replace(/^[ab]\//, "");
}
function pathsFromGitHeader(rest) {
  if (rest.startsWith('"')) {
    const m2 = rest.match(/^("(?:[^"\\]|\\.)*")\s+(.*)$/);
    if (m2) return [stripPrefix(m2[1]), stripPrefix(m2[2])];
  }
  const parts = rest.split(" b/");
  for (let i = 1; i < parts.length; i++) {
    const a = parts.slice(0, i).join(" b/");
    const b = parts.slice(i).join(" b/");
    if (a.replace(/^a\//, "") === b) return [b, b];
  }
  const m = rest.match(/^a\/(.*?) b\/(.*)$/);
  return m ? [m[1], m[2]] : void 0;
}
function emptyFile() {
  return { oldPath: "", newPath: "", status: "modified", binary: false, hunks: [] };
}
function finalize(file) {
  if (file.oldPath === "/dev/null") {
    file.status = "added";
    file.oldPath = file.newPath;
  } else if (file.newPath === "/dev/null") {
    file.status = "deleted";
    file.newPath = file.oldPath;
  } else if (file.status === "modified" && file.oldPath && file.oldPath !== file.newPath) {
    file.status = "renamed";
  }
  const path = file.status === "deleted" ? file.oldPath : file.newPath;
  for (const h of file.hunks) {
    h.path = path;
    h.id = file.status === "deleted" ? `${path}:-${h.oldStart}` : `${path}:${h.newStart}`;
  }
  return file;
}
function parseDiff(input) {
  const files = [];
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  let file;
  let hunk;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const startFile = () => {
    if (file) files.push(finalize(file));
    file = emptyFile();
    hunk = void 0;
  };
  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const tag = line[0];
      const text = line.slice(1);
      if (tag === "+") {
        hunk.lines.push({ kind: "add", text, newLine: newNo++ });
        newLeft--;
        continue;
      }
      if (tag === "-") {
        hunk.lines.push({ kind: "del", text, oldLine: oldNo++ });
        oldLeft--;
        continue;
      }
      if (tag === " " || line === "") {
        hunk.lines.push({ kind: "ctx", text, oldLine: oldNo++, newLine: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (tag === "\\") continue;
      oldLeft = newLeft = 0;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("diff --git ")) {
      startFile();
      const paths = pathsFromGitHeader(line.slice("diff --git ".length));
      if (paths) [file.oldPath, file.newPath] = paths;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (!file || file.hunks.length > 0) startFile();
      file.oldPath = stripPrefix(line.slice(4).replace(/\t.*$/, ""));
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+++ ")) {
      file.newPath = stripPrefix(line.slice(4).replace(/\t.*$/, ""));
      continue;
    }
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.oldPath = unquote(line.slice(12));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      file.newPath = unquote(line.slice(10));
      file.status = "renamed";
    } else if (line.startsWith("similarity index ")) {
      file.similarity = parseInt(line.slice(17), 10);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
    const m = line.match(HUNK_HEADER);
    if (m) {
      const oldStart = Number(m[1]);
      const oldLines = m[2] === void 0 ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === void 0 ? 1 : Number(m[4]);
      hunk = {
        id: "",
        path: "",
        oldStart,
        oldLines,
        newStart,
        newLines,
        section: (m[5] ?? "").trim(),
        lines: []
      };
      file.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      oldLeft = oldLines;
      newLeft = newLines;
    }
  }
  if (file) files.push(finalize(file));
  return files.filter((f) => f.oldPath || f.newPath);
}
function hunkToText(h, maxLines = 400) {
  const head = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.section}`.trimEnd();
  const body = h.lines.slice(0, maxLines).map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
  if (h.lines.length > maxLines) body.push(`\u2026 ${h.lines.length - maxLines} more lines`);
  return [head, ...body].join("\n");
}

// src/risk/lang.ts
function extname(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
}
function indentationSignificant(path) {
  const ext = extname(path);
  return ["py", "pyi", "yaml", "yml", "makefile", "mk", "haml", "slim", "pug", "coffee", "nim"].includes(ext);
}
var HASH_COMMENT_EXT = /* @__PURE__ */ new Set([
  "py",
  "pyi",
  "rb",
  "sh",
  "bash",
  "zsh",
  "yaml",
  "yml",
  "toml",
  "r",
  "pl",
  "ex",
  "exs",
  "tf",
  "conf",
  "ini",
  "dockerfile",
  "makefile",
  "mk",
  "cfg",
  "gitignore",
  "env"
]);
var DASH_COMMENT_EXT = /* @__PURE__ */ new Set(["sql", "lua", "hs", "elm"]);
function isCommentLine(text, path) {
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
var TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\S/g;
function tokenize(text) {
  return text.match(TOKEN) ?? [];
}
function isIdentifier(tok) {
  return /^[A-Za-z_$][\w$]*$/.test(tok) && !KEYWORDS.has(tok);
}
var KEYWORDS = /* @__PURE__ */ new Set([
  "if",
  "else",
  "elif",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "yield",
  "throw",
  "raise",
  "try",
  "catch",
  "except",
  "finally",
  "with",
  "as",
  "async",
  "await",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "of",
  "is",
  "not",
  "and",
  "or",
  "true",
  "false",
  "True",
  "False",
  "null",
  "None",
  "nil",
  "undefined",
  "NaN",
  "Infinity",
  "const",
  "let",
  "var",
  "function",
  "def",
  "class",
  "fn",
  "func",
  "lambda",
  "static",
  "public",
  "private",
  "protected",
  "readonly",
  "final",
  "export",
  "import",
  "from",
  "extends",
  "implements",
  "void",
  "this",
  "self",
  "super",
  "pass",
  "go",
  "defer",
  "select",
  "unsafe",
  "mut",
  "ref",
  "move",
  "Some",
  "Ok",
  "Err",
  "any",
  "unknown",
  "never"
]);
function normalizeForFormatting(text) {
  return text.replace(/\s+/g, "").replace(/'/g, '"').replace(/;+$/g, "").replace(/;(?=[)}\]]|$)/g, "").replace(/,(?=[)}\]])/g, "");
}
var IMPORT_START = /^\s*(import\b|from\s+[\w.]+\s+import\b|export\s+\*\s+from\b|export\s+(type\s+)?\{|(const|let|var)\s+[^=]+=\s*require\(|use\s+[\w:{]|#include\s|using\s+[\w.]+\s*;|require\s*\(?\s*['"]|require_relative\s)/;
function isImportStart(text) {
  return IMPORT_START.test(text);
}
function importStatements(lines) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    if (depth === 0) {
      if (!isImportStart(raw)) return void 0;
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
  if (depth !== 0) return void 0;
  return out;
}
function normalizeImport(stmt) {
  const flat = stmt.replace(/\s+/g, " ").replace(/;\s*$/, "").replace(/'/g, '"').trim();
  return flat.replace(/\{([^}]*)\}/g, (_, inner) => {
    const names = inner.split(",").map((s) => s.trim()).filter(Boolean).sort();
    return `{${names.join(",")}}`;
  }).replace(/\s+/g, "");
}
function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  const counts = /* @__PURE__ */ new Map();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(t, c - 1);
    }
  }
  return 2 * shared / (ta.length + tb.length);
}

// src/risk/coverage.ts
function parseLcov(text) {
  const map = /* @__PURE__ */ new Map();
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const path = normalize(line.slice(3));
      current = map.get(path) ?? /* @__PURE__ */ new Map();
      map.set(path, current);
    } else if (line.startsWith("DA:") && current) {
      const [ln, count] = line.slice(3).split(",");
      const n = Number(ln);
      const c = Number(count);
      if (Number.isFinite(n) && Number.isFinite(c)) current.set(n, Math.max(current.get(n) ?? 0, c));
    } else if (line === "end_of_record") {
      current = void 0;
    }
  }
  return map;
}
function parseCobertura(xml) {
  const map = /* @__PURE__ */ new Map();
  const sources = [...xml.matchAll(/<source>([^<]*)<\/source>/g)].map((m) => m[1].trim());
  for (const cls of xml.matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
    let path = decodeXml(cls[1]);
    if (path.startsWith("/") && sources.length) {
      const src = sources.find((s) => path.startsWith(s));
      if (src) path = path.slice(src.length).replace(/^\/+/, "");
    }
    const key = normalize(path);
    const lines = map.get(key) ?? /* @__PURE__ */ new Map();
    for (const l of cls[2].matchAll(/<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g)) {
      const n = Number(l[1]);
      lines.set(n, Math.max(lines.get(n) ?? 0, Number(l[2])));
    }
    map.set(key, lines);
  }
  return map;
}
function parseCoverage(text) {
  return /<coverage\b/.test(text.slice(0, 2e3)) ? parseCobertura(text) : parseLcov(text);
}
function mergeCoverage(maps) {
  const out = /* @__PURE__ */ new Map();
  for (const m of maps) {
    for (const [path, lines] of m) {
      const target = out.get(path) ?? /* @__PURE__ */ new Map();
      for (const [n, c] of lines) target.set(n, Math.max(target.get(n) ?? 0, c));
      out.set(path, target);
    }
  }
  return out;
}
function decodeXml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function normalize(p) {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}
function lookup(map, repoPath) {
  const want = normalize(repoPath);
  const exact = map.get(want);
  if (exact) return exact;
  let best;
  let bestLen = -1;
  for (const [path, lines] of map) {
    if (path.endsWith("/" + want) && path.length > bestLen) {
      best = lines;
      bestLen = path.length;
    } else if (want.endsWith("/" + path) && path.length > bestLen) {
      best = lines;
      bestLen = path.length;
    }
  }
  return best;
}
var CODE_EXT = /* @__PURE__ */ new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "cs",
  "php",
  "swift",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "m",
  "ex",
  "exs",
  "erl",
  "clj",
  "dart",
  "vue",
  "svelte"
]);
function isExecutableSource(path) {
  return CODE_EXT.has(extname(path));
}
function hunkCoverage(h, map, opts) {
  const base = { instrumented: 0, covered: 0, uncoveredLines: [], status: "none" };
  if (!map) return base;
  if (!isExecutableSource(h.path) || opts.isTest) return { ...base, status: "not-executable" };
  const lines = lookup(map, h.path);
  if (!lines) return { ...base, status: "file-missing" };
  const stat = { ...base, status: "measured" };
  for (const l of h.lines) {
    if (l.kind !== "add" || l.newLine === void 0) continue;
    const hits2 = lines.get(l.newLine);
    if (hits2 === void 0) continue;
    stat.instrumented++;
    if (hits2 > 0) stat.covered++;
    else stat.uncoveredLines.push(l.newLine);
  }
  return stat;
}

// src/risk/score.ts
var SEVERE = 50;
var TIER_THRESHOLDS = { critical: 65, high: 40, medium: 18 };
function tierFor(score2) {
  if (score2 >= TIER_THRESHOLDS.critical) return "critical";
  if (score2 >= TIER_THRESHOLDS.high) return "high";
  if (score2 >= TIER_THRESHOLDS.medium) return "medium";
  return "low";
}
function combine(signals) {
  const weights = signals.map((s) => s.weight).filter((w) => w > 0).sort((a, b) => b - a);
  let total = 0;
  let factor = 1;
  for (const w of weights) {
    total += w * factor;
    factor /= 2;
  }
  return total;
}
function score({ signals, coverage, isTest, isDoc }) {
  let raw = combine(signals);
  const extra = [];
  const weakensTests = signals.some((s) => s.id.startsWith("test."));
  if (isDoc) raw *= 0.3;
  else if (isTest && !weakensTests) raw *= 0.5;
  if (coverage.status === "measured" && coverage.instrumented > 0) {
    const uncovered = coverage.instrumented - coverage.covered;
    const u = uncovered / coverage.instrumented;
    let multiplier = 0.8 + 0.6 * u;
    if (signals.some((s) => s.weight >= SEVERE)) multiplier = Math.max(1, multiplier);
    const delta = raw * multiplier - raw;
    raw *= multiplier;
    if (Math.round(delta) !== 0) extra.push(
      uncovered > 0 ? {
        id: "coverage.uncovered",
        category: "coverage",
        weight: Math.round(delta),
        reason: `${uncovered} of ${coverage.instrumented} changed executable line${coverage.instrumented === 1 ? "" : "s"} never run by tests`
      } : {
        id: "coverage.covered",
        category: "coverage",
        weight: Math.round(delta),
        reason: `All ${coverage.instrumented} changed executable line${coverage.instrumented === 1 ? " is" : "s are"} run by tests`
      }
    );
  } else if (coverage.status === "file-missing") {
    const delta = raw * 0.2;
    raw += delta;
    extra.push({
      id: "coverage.file-missing",
      category: "coverage",
      weight: Math.round(delta),
      reason: "File does not appear in the coverage report (no test loads it)"
    });
  }
  return { score: Math.min(100, Math.round(raw)), extra };
}

// src/risk/signals.ts
var MIGRATION_PATH = /(^|\/)(migrations?|migrate|alembic\/versions|db\/migrate|flyway|liquibase|changelog)\/|\.sql$|(^|\/)schema\.prisma$|(^|\/)structure\.sql$|(^|\/)schema\.rb$/i;
var AUTH_PATH = /(^|[\/_.-])(auth\w*|login|logout|sessions?|permissions?|rbac|acl|oauth\w*|jwt|passwords?|tokens?|guards?|policies|policy|sso|saml|iam|middleware\/auth\w*|security)([\/_.-]|$)/i;
var MONEY_PATH = /(^|[\/_.-])(payments?|billing|invoices?|checkout|ledger|wallets?|pricing|prices?|refunds?|subscriptions?|stripe|braintree|paypal|currenc(y|ies)|tax(es)?|payouts?|charges?|money|orders?)([\/_.-]|$)/i;
var CI_PATH = /(^|\/)(\.github\/workflows|\.gitlab-ci\.yml|\.circleci|Jenkinsfile|azure-pipelines|buildkite)|(^|\/)Dockerfile|\.tf$|(^|\/)(k8s|kubernetes|helm|charts|deploy|infra)\//i;
var SECRET_PATH = /(^|\/)\.env(\.|$)|secrets?\.(ya?ml|json)$|credentials/i;
var MANIFEST_PATH = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|setup\.py|Pipfile|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|composer\.json|\w+\.csproj)$/;
var TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs|e2e|testing|fixtures)\/|[._-](test|spec)\.\w+$|_test\.go$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$/i;
var DOC_EXT = /* @__PURE__ */ new Set(["md", "mdx", "rst", "txt", "adoc"]);
function isTestPath(p) {
  return TEST_PATH.test(p);
}
function isDocPath(p) {
  return DOC_EXT.has(extname(p)) || /(^|\/)(docs?|LICENSE|CHANGELOG)/.test(p);
}
var SQL_DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE|CONSTRAINT|TYPE|VIEW)|TRUNCATE(\s+TABLE)?)\b/i;
var SQL_DELETE_NO_WHERE = /\bDELETE\s+FROM\s+[\w."`]+\s*(;|$)/i;
var SQL_UPDATE_NO_WHERE = /\bUPDATE\s+[\w."`]+\s+SET\b(?![^;]*\bWHERE\b)[^;]*(;|$)/i;
var SQL_ALTER_COLUMN = /\b(ALTER\s+COLUMN|MODIFY\s+COLUMN|RENAME\s+COLUMN|RENAME\s+TO|CHANGE\s+COLUMN|TYPE\s+\w+\s+USING)\b/i;
var SQL_ADD_NOT_NULL = /\bADD\s+(COLUMN\s+)?[\w"`]+\s+[\w()]+[^;]*\bNOT\s+NULL\b(?![^;]*\bDEFAULT\b)/i;
var SQL_INDEX_LOCKING = /\bCREATE\s+(UNIQUE\s+)?INDEX\b(?![^;]*\bCONCURRENTLY\b)/i;
var ORM_DESTRUCTIVE = /\b(drop_table|remove_column|remove_index|dropColumn|dropTable|removeColumn|dropIndex|drop_column|op\.drop_\w+|DeleteModel|RemoveField|deleteColumn)\b/;
var ORM_ALTER = /\b(rename_column|renameColumn|change_column|changeColumn|alter_column|AlterField|RenameField|op\.alter_column|change_column_null)\b/;
var AUTH_GUARD = /\b(requireAuth\w*|require_auth\w*|login_required|permission_required|authorize\w*|authenticate\w*|isAuthenticated|is_authenticated|ensure(Auth|Logged|Admin)\w*|check_?[Pp]ermission\w*|has_?[Pp]ermission\w*|has_?[Rr]ole\w*|is_?[Aa]dmin|can[A-Z]\w*|verify(Token|Signature|Jwt|JWT|Password|Hmac|Webhook)\w*|requireRole\w*|@PreAuthorize|@Secured|@RolesAllowed|before_action\s+:authenticate\w*)\b/;
var AUTH_TERMS = /\b(jwt|bcrypt|argon2|scrypt|pbkdf2|csrf|xsrf|httpOnly|sameSite|allowedOrigins|Access-Control-Allow-\w+|cors|session\w*|cookie\w*|password\w*|tenant_?[Ii]d|owner_?[Ii]d|scopes?|roles?|permissions?|api_?[Kk]ey|bearer|oauth\w*|mfa|otp|totp)\b/i;
var AMOUNT_WORDS = [
  "amount",
  "price",
  "subtotal",
  "balance",
  "cents",
  "fee",
  "tax",
  "vat",
  "discount",
  "cost",
  "credit",
  "debit",
  "salary",
  "wage",
  "proration",
  "refunded",
  "charged",
  "paid",
  "owed",
  "money"
];
var ENTITY_WORDS = ["refund", "charge", "payment", "invoice", "payout", "ledger", "wallet", "currency", "coupon", "fx"];
var FLOAT_MONEY = /\b(parseFloat|toFixed|float\s*\(|Number\s*\(|as\s+f(32|64)|double\b|Float)\b/;
var EMPTY_CATCH = /\bcatch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*(\{\s*\}|null|undefined)\s*\)|\bexcept(\s+[\w.,\s()]+)?(\s+as\s+\w+)?\s*:\s*pass\b|\brescue\s*(=>\s*\w+)?\s*;?\s*(nil|end)\b|_\s*=\s*err\b/;
var ERROR_HANDLING = /\b(catch|except|rescue|finally|throw|raise|panic|recover|try)\b|\bif\s+err\s*!=\s*nil\b|\.catch\(/;
var SUPPRESSION = /(@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|# type:\s*ignore|#\s*noqa|nolint|@SuppressWarnings|# pragma: no cover|istanbul ignore|c8 ignore)/;
var EXEC = /\b(eval|execSync|exec|spawnSync|spawn|execFile|system|popen|Popen|check_output)\s*\(|new\s+Function\s*\(|child_process|shell\s*=\s*True|os\.system|Runtime\.getRuntime\(\)\.exec/;
var RAW_HTML = /\binnerHTML\b|\bouterHTML\b|dangerouslySetInnerHTML|\bv-html\b|\|\s*safe\b|\bmark_safe\b|\bhtml_safe\b|\braw\s*\(|\bdocument\.write\s*\(|\{\{\{/;
var SQL_INTERP = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;]*(\$\{|["'`]\s*\+\s*\w|\+\s*["'`]|%s|\{[a-z_]\w*\}|\.format\()|\bf["'](SELECT|INSERT|UPDATE|DELETE)\b/i;
var SECRET_ASSIGN = /\b[\w-]*(api[_-]?key|secret|passw(or)?d|private[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)[\w-]*["']?\s*[:=]\s*["'][^"'\s$<>{}]{8,}["']/i;
var SECRET_LITERAL = /AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk_live_[0-9a-zA-Z]{10,}|\bghp_[0-9A-Za-z]{30,}|\bxox[baprs]-[0-9A-Za-z-]{10,}/;
var TLS_OFF = /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED|CURLOPT_SSL_VERIFYPEER\s*,\s*(0|false)|ssl_verify\s*[:=]\s*false/i;
var WEAK_CRYPTO = /\b(md5|sha1|DES|RC4|Math\.random)\b/;
var CONCURRENCY = /\b(transaction|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|FOR\s+UPDATE|lock\w*|mutex|semaphore|atomic\w*|synchronized|Promise\.(all|race|allSettled)|setTimeout|setInterval|retry\w*|idempoten\w*|goroutine|go\s+func|async\s+with|threading|asyncio\.gather)\b/;
var LIMIT_WORDS = /(timeout|retries|retry|limit|max|min|ttl|expir|interval|threshold|rate|size|batch|window|duration|delay|backoff|attempts)/i;
var FLAG = /\b(feature_?[Ff]lag\w*|isEnabled|is_enabled|isFeatureEnabled|flags?\.\w+|launchdarkly|unleash|optimizely|growthbook|FEATURE_\w+)\b/;
var ROUTE = /\b(app|router|server|api|r)\.(get|post|put|patch|delete|all|use|route)\s*\(|@(app|router|bp|blueprint)\.(route|get|post|put|patch|delete)\b|@(Get|Post|Put|Patch|Delete|Request)Mapping\b|\bpath\s*\(\s*["']|\burl\s*\(\s*r?["']\^?/;
var EXPORTED = /^\s*(export\s+(default\s+)?(async\s+)?(function|class|const|let|interface|type|enum)\b|public\s+(static\s+)?[\w<>[\],\s]+\s+\w+\s*\(|def\s+[a-z]\w*\s*\(|func\s+[A-Z]\w*\s*\(|func\s+\([^)]*\)\s+[A-Z]\w*\s*\(|pub\s+(fn|struct|enum|trait)\b)/;
var COMPARISON = /* @__PURE__ */ new Set(["<", ">", "<=", ">=", "==", "!=", "===", "!==", "is", "in"]);
var LOGICAL = /* @__PURE__ */ new Set(["&&", "||", "and", "or", "??"]);
var INDEX = /* @__PURE__ */ new WeakMap();
var lineNo = (l) => INDEX.get(l) ?? -1;
function code(lines, path) {
  return lines.filter((l) => !isCommentLine(l.text, path));
}
function hits(lines, re) {
  return lines.filter((l) => re.test(l.text));
}
function snippet(s, max = 48) {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}
function opTokens(text) {
  const out = [];
  const re = /===|!==|==|!=|<=|>=|&&|\|\||\?\?|=>|[A-Za-z_$][\w$]*|\d[\w.]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\S/g;
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}
function tokenDelta(a, b) {
  const x = opTokens(a).slice(0, 200);
  const y = opTokens(b).slice(0, 200);
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i2 = x.length - 1; i2 >= 0; i2--) {
    for (let j2 = y.length - 1; j2 >= 0; j2--) {
      dp[i2][j2] = x[i2] === y[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
    }
  }
  const removed = [];
  const inserted = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(x[i++]);
    else inserted.push(y[j++]);
  }
  while (i < x.length) removed.push(x[i++]);
  while (j < y.length) inserted.push(y[j++]);
  return { removed, inserted };
}
function pairLines(removed, added) {
  const pairs = [];
  const used = /* @__PURE__ */ new Set();
  const pairedRemoved = /* @__PURE__ */ new Set();
  for (const r of removed) {
    if (r.text.trim() === "") continue;
    let best;
    let bestScore = 0.5;
    for (const a of added) {
      if (used.has(a)) continue;
      const s = similarity(r.text, a.text);
      if (s > bestScore) {
        best = a;
        bestScore = s;
      }
    }
    if (best) {
      used.add(best);
      pairedRemoved.add(r);
      pairs.push([r, best]);
    }
  }
  return {
    pairs,
    unpairedAdded: added.filter((a) => !used.has(a) && a.text.trim() !== ""),
    unpairedRemoved: removed.filter((r) => !pairedRemoved.has(r) && r.text.trim() !== "")
  };
}
var STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
var stripStrings = (t) => t.replace(STRING_LITERAL, '""');
function matchesWord(w, list) {
  return list.some((m) => w === m || w === m + "s" || w === m + "es" || m.length >= 6 && w.startsWith(m));
}
function moneyIdentifiers(text, kind = "any") {
  const list = kind === "amount" ? AMOUNT_WORDS : [...AMOUNT_WORDS, ...ENTITY_WORDS];
  const src = stripStrings(text);
  const out = /* @__PURE__ */ new Set();
  for (const m of src.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const id = m[0];
    const after = src.slice(m.index + id.length);
    if (/^\s*\(/.test(after) || /\b(function|def|func|fn)\s+$/.test(src.slice(0, m.index))) continue;
    const words = id.split(/_+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
    const last = words[words.length - 1];
    if (last && matchesWord(last, list)) out.add(id);
  }
  return [...out];
}
function moneyArithmetic(text, ids) {
  const src = stripStrings(text);
  return ids.some((id) => {
    const e = id.replace(/\$/g, "\\$");
    return new RegExp(
      `\\b${e}\\b\\s*([+\\-*/%](?![/*])|[+\\-*/%]?=(?![=>]))|([+\\-*/%]|[^=!<>]=)\\s*\\(?\\s*(\\w+\\.)*${e}\\b|\\b(round|floor|ceil|trunc|toFixed|parseFloat|parseInt|Number|float|int|Decimal|BigDecimal|BigInt|quantize)\\s*\\([^)]*\\b${e}\\b|\\b${e}\\b[\\w.]*\\.(toFixed|round|quantize)\\b`
    ).test(src);
  });
}
var pathSignals = ({ file, path, added, removed }) => {
  const out = [];
  if (MIGRATION_PATH.test(path)) {
    out.push({ id: "path.migration", category: "migration", weight: 30, reason: "Database migration or schema file" });
    if (file.status === "modified" && /(^|\/)(migrations?|migrate|alembic\/versions|db\/migrate)\//i.test(path) && removed.length > 0) {
      out.push({
        id: "migration.edited",
        category: "migration",
        weight: 30,
        reason: "Edits an existing migration that may already have run in production"
      });
    }
  }
  if (AUTH_PATH.test(path) && !isTestPath(path)) {
    out.push({ id: "path.auth", category: "auth", weight: 20, reason: "File is part of authentication / authorization" });
  }
  if (MONEY_PATH.test(path) && !isTestPath(path)) {
    out.push({ id: "path.money", category: "money", weight: 18, reason: "File handles payments, billing or orders" });
  }
  if (CI_PATH.test(path)) {
    out.push({ id: "path.ci", category: "config", weight: 14, reason: "CI, container or deployment configuration" });
  }
  if (SECRET_PATH.test(path)) {
    out.push({ id: "path.secrets", category: "security", weight: 20, reason: "Environment or credentials file" });
  }
  if (MANIFEST_PATH.test(path)) {
    const versionish = /["']?[\w@/.-]+["']?\s*[:=]{1,2}\s*["']?[~^<>=]*\s*v?\d+(\.\d+)*/;
    const changed = [...added, ...removed].filter((l) => versionish.test(l.text));
    if (changed.length > 0) {
      out.push({
        id: "dependency.versions",
        category: "dependency",
        weight: 12,
        reason: `Dependency versions changed (${changed.length} line${changed.length === 1 ? "" : "s"})`,
        at: changed.map(lineNo)
      });
    }
  }
  return out;
};
var schemaSignals = ({ path, added }) => {
  const out = [];
  const src = code(added, path);
  const destructive = [...hits(src, SQL_DESTRUCTIVE), ...hits(src, ORM_DESTRUCTIVE)];
  if (destructive.length) {
    const m = destructive[0].text.match(SQL_DESTRUCTIVE) ?? destructive[0].text.match(ORM_DESTRUCTIVE);
    out.push({
      id: "schema.destructive",
      category: "data",
      weight: 55,
      reason: `Destructive schema change: \`${snippet(m?.[0] ?? destructive[0].text, 32)}\` cannot be rolled back without data loss`,
      at: destructive.map(lineNo)
    });
  }
  const noWhere = [...hits(src, SQL_DELETE_NO_WHERE), ...hits(src, SQL_UPDATE_NO_WHERE)];
  if (noWhere.length) {
    out.push({
      id: "sql.no-where",
      category: "data",
      weight: 45,
      reason: "UPDATE / DELETE with no WHERE clause touches every row",
      at: noWhere.map(lineNo)
    });
  }
  const alter = [...hits(src, SQL_ALTER_COLUMN), ...hits(src, ORM_ALTER)];
  if (alter.length) {
    out.push({
      id: "schema.alter-column",
      category: "migration",
      weight: 32,
      reason: "Renames or retypes a column; running code may still expect the old shape",
      at: alter.map(lineNo)
    });
  }
  const notNull = hits(src, SQL_ADD_NOT_NULL);
  if (notNull.length) {
    out.push({
      id: "schema.not-null-no-default",
      category: "migration",
      weight: 30,
      reason: "Adds a NOT NULL column without a default; fails or rewrites existing rows",
      at: notNull.map(lineNo)
    });
  }
  const idx = hits(src, SQL_INDEX_LOCKING);
  if (idx.length && /\.sql$|migrat/i.test(path)) {
    out.push({
      id: "schema.locking-index",
      category: "migration",
      weight: 16,
      reason: "Index built without CONCURRENTLY can lock writes on large tables",
      at: idx.map(lineNo)
    });
  }
  return out;
};
var authSignals = ({ path, added, removed }) => {
  if (isTestPath(path)) return [];
  const out = [];
  const guardGlobal = new RegExp(AUTH_GUARD.source, "g");
  const count = (ls) => {
    const m = /* @__PURE__ */ new Map();
    for (const l of code(ls, path)) for (const g of l.text.matchAll(guardGlobal)) m.set(g[0], (m.get(g[0]) ?? 0) + 1);
    return m;
  };
  const before = count(removed);
  const after = count(added);
  const lostGuards = [...before].filter(([g, n]) => n > (after.get(g) ?? 0)).map(([g]) => g);
  if (lostGuards.length) {
    const lostLines = removed.filter((l) => lostGuards.some((g) => l.text.includes(g)));
    out.push({
      id: "auth.guard-removed",
      category: "auth",
      weight: 55,
      reason: `Authorization check removed: \`${lostGuards[0]}\` no longer runs on \`${snippet(lostLines[0]?.text ?? "", 40)}\``,
      at: lostLines.map(lineNo)
    });
  }
  const lost = lostGuards;
  const touched = code([...added, ...removed], path).filter((l) => AUTH_GUARD.test(l.text) || AUTH_TERMS.test(l.text));
  if (touched.length && !lost.length) {
    out.push({
      id: "auth.logic",
      category: "auth",
      weight: 24,
      reason: "Changes authentication, session or permission logic",
      at: touched.map(lineNo)
    });
  }
  return out;
};
var ARITH_TOKEN = /^([+\-*/%]=?|=|round|floor|ceil|trunc|toFixed|parseFloat|parseInt|Number|float|int|Decimal|BigDecimal|BigInt|quantize)$/;
var moneySignals = ({ path, added, removed, pairs }) => {
  if (isTestPath(path)) return [];
  const out = [];
  const changed = code([...added, ...removed], path);
  const withMoney = changed.filter((l) => moneyIdentifiers(l.text).length > 0);
  if (!withMoney.length) return out;
  const partner = /* @__PURE__ */ new Map();
  for (const [d, a] of pairs) {
    partner.set(d, a);
    partner.set(a, d);
  }
  const editTouchesMoney = (l) => {
    const other = partner.get(l);
    if (!other) return true;
    const [before, after] = l.kind === "del" ? [l.text, other.text] : [other.text, l.text];
    const { removed: r, inserted: i } = tokenDelta(before, after);
    const ids = /* @__PURE__ */ new Set([...moneyIdentifiers(before, "amount"), ...moneyIdentifiers(after, "amount")]);
    return [...r, ...i].some((t) => ids.has(t) || ARITH_TOKEN.test(t) || /^\d/.test(t));
  };
  const arithmetic = withMoney.filter((l) => moneyArithmetic(l.text, moneyIdentifiers(l.text, "amount")) && editTouchesMoney(l));
  const names = [
    ...new Set((arithmetic.length ? arithmetic : withMoney).flatMap((l) => moneyIdentifiers(l.text, arithmetic.length ? "amount" : "any")))
  ].slice(0, 3);
  if (arithmetic.length) {
    out.push({
      id: "money.arithmetic",
      category: "money",
      weight: 32,
      reason: `Arithmetic or rounding on money values (${names.map((n) => `\`${n}\``).join(", ")})`,
      at: arithmetic.map(lineNo)
    });
    const floats = code(added, path).filter((l) => moneyIdentifiers(l.text, "amount").length && FLOAT_MONEY.test(l.text));
    if (floats.length) {
      out.push({ id: "money.float", category: "money", weight: 14, reason: "Floating-point conversion on a money value", at: floats.map(lineNo) });
    }
  } else {
    out.push({
      id: "money.touched",
      category: "money",
      weight: 12,
      reason: `Touches money-related values (${names.map((n) => `\`${n}\``).join(", ")})`,
      at: withMoney.map(lineNo)
    });
  }
  return out;
};
var behaviourSignals = ({ path, pairs, unpairedRemoved, unpairedAdded }) => {
  const out = [];
  const push = (s) => {
    const existing = out.find((o) => o.id === s.id);
    if (existing) existing.at = [...existing.at ?? [], ...s.at ?? []];
    else out.push(s);
  };
  for (const [del, add] of pairs) {
    if (isCommentLine(del.text, path) || isCommentLine(add.text, path)) continue;
    const { removed, inserted } = tokenDelta(del.text, add.text);
    if (!removed.length && !inserted.length) continue;
    const at = [lineNo(add)];
    const cmpOld = removed.find((t) => COMPARISON.has(t));
    const cmpNew = inserted.find((t) => COMPARISON.has(t));
    if (cmpOld && cmpNew && cmpOld !== cmpNew) {
      push({ id: "behaviour.comparison", category: "behaviour", weight: 26, reason: `Boundary changed: \`${cmpOld}\` \u2192 \`${cmpNew}\``, at });
    }
    const logOld = removed.find((t) => LOGICAL.has(t));
    const logNew = inserted.find((t) => LOGICAL.has(t));
    if (logOld && logNew && logOld !== logNew) {
      push({ id: "behaviour.logic", category: "behaviour", weight: 26, reason: `Logic changed: \`${logOld}\` \u2192 \`${logNew}\``, at });
    }
    const negations = (ts) => ts.filter((t) => t === "!" || t === "not").length;
    if (negations(removed) !== negations(inserted)) {
      push({ id: "behaviour.negation", category: "behaviour", weight: 24, reason: "Condition negated or un-negated", at });
    }
    const numOld = removed.find((t) => /^\d/.test(t));
    const numNew = inserted.find((t) => /^\d/.test(t));
    if (numOld && numNew && numOld !== numNew) {
      const limit = LIMIT_WORDS.test(add.text);
      push({
        id: limit ? "behaviour.limit" : "behaviour.constant",
        category: "behaviour",
        weight: limit ? 18 : 12,
        reason: limit ? `Limit or timeout changed: ${numOld} \u2192 ${numNew}` : `Constant changed: ${numOld} \u2192 ${numNew}`,
        at
      });
    }
    const boolOld = removed.find((t) => /^(true|false|True|False)$/.test(t));
    const boolNew = inserted.find((t) => /^(true|false|True|False)$/.test(t));
    if (boolOld && boolNew && boolOld.toLowerCase() !== boolNew.toLowerCase()) {
      push({ id: "behaviour.boolean", category: "behaviour", weight: 20, reason: `Boolean flipped: \`${boolOld}\` \u2192 \`${boolNew}\``, at });
    }
    if (removed.includes("await") && !inserted.includes("await")) {
      push({ id: "concurrency.await-removed", category: "concurrency", weight: 26, reason: "`await` removed: the call is no longer waited for", at });
    }
    if (/^\s*return\b/.test(del.text) && /^\s*return\b/.test(add.text)) {
      push({ id: "behaviour.return", category: "behaviour", weight: 14, reason: "Return value changed", at });
    }
  }
  const exits = code(unpairedRemoved, path).filter(
    (l) => !/\b(throw|raise|panic)\b/.test(l.text) && (/^\s*(if\b.*)?\b(return|abort|continue|break)\b/.test(l.text) || /^\s*if\b/.test(l.text))
  );
  if (exits.length) {
    push({
      id: "behaviour.guard-removed",
      category: "behaviour",
      weight: 22,
      reason: `Condition or early exit removed: \`${snippet(exits[0].text)}\``,
      at: exits.map(lineNo)
    });
  }
  const newBranches = code(unpairedAdded, path).filter((l) => /^\s*(\}?\s*else\b|if\b|elif\b|case\b|switch\b|match\b|when\b|unless\b)/.test(l.text));
  if (newBranches.length) {
    push({
      id: "behaviour.branch-added",
      category: "behaviour",
      weight: 14,
      reason: `New branch: \`${snippet(newBranches[0].text)}\``,
      at: newBranches.map(lineNo)
    });
  }
  return out;
};
var errorSignals = ({ path, added, unpairedRemoved }) => {
  const out = [];
  const swallowed = hits(code(added, path), EMPTY_CATCH);
  if (swallowed.length) {
    out.push({ id: "error.swallowed", category: "error-handling", weight: 24, reason: "Error is caught and ignored", at: swallowed.map(lineNo) });
  }
  const lostHandling = hits(code(unpairedRemoved, path), ERROR_HANDLING);
  if (lostHandling.length) {
    out.push({
      id: "error.removed",
      category: "error-handling",
      weight: 20,
      reason: `Error handling removed: \`${snippet(lostHandling[0].text)}\``,
      at: lostHandling.map(lineNo)
    });
  }
  const suppressed = hits(added, SUPPRESSION);
  if (suppressed.length) {
    out.push({ id: "error.suppression", category: "error-handling", weight: 10, reason: "Adds a type-check, lint or coverage suppression", at: suppressed.map(lineNo) });
  }
  if (isTestPath(path)) {
    const assertion = /\b(expect|assert\w*|should|toBe|toEqual|toThrow|t\.(Error|Fatal)|require\.\w+)\b/;
    const before = hits(code(unpairedRemoved, path), assertion).length;
    const after = hits(code(added, path), assertion).length;
    if (before > after) {
      out.push({
        id: "test.assertions-removed",
        category: "behaviour",
        weight: 24,
        reason: `${before - after} test assertion${before - after === 1 ? "" : "s"} removed`,
        at: hits(unpairedRemoved, assertion).map(lineNo)
      });
    }
    const skipped = hits(added, /\b(it|test|describe)\.(skip|only)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|@unittest\.skip|t\.Skip\(/);
    if (skipped.length) {
      out.push({ id: "test.skipped", category: "behaviour", weight: 20, reason: "Test skipped or focused with .only", at: skipped.map(lineNo) });
    }
  }
  return out;
};
var securitySignals = ({ path, added }) => {
  const out = [];
  const src = code(added, path);
  const add = (id, weight, reason, ls) => {
    if (ls.length) out.push({ id, category: "security", weight, reason, at: ls.map(lineNo) });
  };
  add("security.secret", 45, "Possible hard-coded secret or key", [...hits(added, SECRET_LITERAL), ...hits(added, SECRET_ASSIGN)].filter((l, i, a) => a.indexOf(l) === i));
  add("security.tls-off", 35, "TLS certificate verification disabled", hits(src, TLS_OFF));
  add("security.sql-interp", 32, "SQL built by string interpolation", hits(src, SQL_INTERP));
  if (!isTestPath(path)) {
    add("security.exec", 30, "Executes shell commands or evaluates code", hits(src, EXEC));
    add("security.raw-html", 26, "Renders unescaped HTML", hits(src, RAW_HTML));
    add("security.weak-crypto", 12, "Weak hash or non-cryptographic randomness", hits(src, WEAK_CRYPTO));
  }
  return out;
};
var runtimeSignals = ({ path, added, removed, unpairedRemoved }) => {
  const out = [];
  if (isTestPath(path)) return out;
  const changed = code([...added, ...removed], path);
  const conc = hits(changed, CONCURRENCY);
  if (conc.length) {
    out.push({ id: "concurrency.semantics", category: "concurrency", weight: 16, reason: "Changes transactions, locking, retries or parallelism", at: conc.map(lineNo) });
  }
  const flags = hits(changed, FLAG);
  if (flags.length) {
    out.push({ id: "config.flag", category: "config", weight: 10, reason: "Changes a feature flag check", at: flags.map(lineNo) });
  }
  const routes = hits(changed, ROUTE);
  if (routes.length) {
    out.push({ id: "api.route", category: "api", weight: 18, reason: "Adds, removes or changes an HTTP route", at: routes.map(lineNo) });
  }
  const exported = hits(code(unpairedRemoved, path), EXPORTED);
  if (exported.length) {
    out.push({
      id: "api.exported-removed",
      category: "api",
      weight: 16,
      reason: `Public symbol removed or re-signed: \`${snippet(exported[0].text, 40)}\``,
      at: exported.map(lineNo)
    });
  }
  return out;
};
var sizeSignal = ({ added, removed, path }) => {
  const n = code(added, path).length + code(removed, path).length;
  if (n === 0) return [];
  const weight = Math.min(14, Math.round(3 + n / 5));
  return [{ id: "size", category: "size", weight, reason: `${n} changed line${n === 1 ? "" : "s"} of code` }];
};
var DETECTORS = [
  pathSignals,
  schemaSignals,
  authSignals,
  moneySignals,
  behaviourSignals,
  errorSignals,
  securitySignals,
  runtimeSignals,
  sizeSignal
];
function detectSignals(file, hunk) {
  const added = hunk.lines.filter((l) => l.kind === "add");
  const removed = hunk.lines.filter((l) => l.kind === "del");
  const { pairs, unpairedAdded, unpairedRemoved } = pairLines(removed, added);
  const ctx = { file, hunk, path: hunk.path, added, removed, pairs, unpairedAdded, unpairedRemoved };
  hunk.lines.forEach((l, i) => INDEX.set(l, i));
  const detectors = isDocPath(hunk.path) ? [sizeSignal] : DETECTORS;
  const signals = detectors.flatMap((d) => d(ctx));
  for (const s of signals) if (s.at) s.at = [...new Set(s.at.filter((i) => i >= 0))].sort((a, b) => a - b);
  return signals;
}

// src/risk/trivial.ts
var GENERATED = [
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
  /(^|\/)(__generated__|generated)\//
];
function isGeneratedPath(path) {
  return GENERATED.some((re) => re.test(path));
}
function flatten(lines) {
  return lines.map(normalizeForFormatting).join("").replace(/[,;]+(?=[)}\]])/g, "");
}
function renameMapping(h) {
  const removed = h.lines.filter((l) => l.kind === "del" && l.text.trim() !== "");
  const added = h.lines.filter((l) => l.kind === "add" && l.text.trim() !== "");
  if (removed.length === 0 || removed.length !== added.length) return void 0;
  const forward = /* @__PURE__ */ new Map();
  const backward = /* @__PURE__ */ new Map();
  for (let i = 0; i < removed.length; i++) {
    const a = tokenize(removed[i].text);
    const b = tokenize(added[i].text);
    if (a.length !== b.length) return void 0;
    for (let j = 0; j < a.length; j++) {
      const x = a[j];
      const y = b[j];
      if (x === y) continue;
      if (!isIdentifier(x) || !isIdentifier(y)) return void 0;
      if ((forward.get(x) ?? y) !== y || (backward.get(y) ?? x) !== x) return void 0;
      forward.set(x, y);
      backward.set(y, x);
    }
  }
  if (forward.size === 0) return void 0;
  const addedTokens = new Set(added.flatMap((l) => tokenize(l.text)));
  const removedTokens = new Set(removed.flatMap((l) => tokenize(l.text)));
  for (const [from, to] of forward) {
    if (addedTokens.has(from) || removedTokens.has(to)) return void 0;
  }
  return forward;
}
var DECLARATION = /\b(const|let|var|function|def|class|interface|type|enum|struct|fn|func|val)\s+([A-Za-z_$][\w$]*)/g;
function declares(h, name) {
  for (const l of h.lines) {
    if (l.kind !== "del") continue;
    for (const m of l.text.matchAll(DECLARATION)) if (m[2] === name) return true;
    const esc = name.replace(/\$/g, "\\$");
    if (new RegExp(`[(,]\\s*${esc}\\s*[:,)=?]`).test(l.text)) return true;
  }
  return false;
}
function classifyTrivial(file, h, renameSupport = /* @__PURE__ */ new Map()) {
  const path = h.path;
  if (isGeneratedPath(path)) {
    return { kind: "generated", reason: "Generated or lock file" };
  }
  const removed = h.lines.filter((l) => l.kind === "del").map((l) => l.text);
  const added = h.lines.filter((l) => l.kind === "add").map((l) => l.text);
  if (removed.length === 0 && added.length === 0) return void 0;
  if ([...removed, ...added].every((t) => isCommentLine(t, path))) {
    const allBlank = [...removed, ...added].every((t) => t.trim() === "");
    return allBlank ? { kind: "formatting", reason: "Blank lines only" } : { kind: "comments", reason: "Comments only" };
  }
  if (indentationSignificant(path)) {
    const r = removed.filter((t) => t.trim() !== "");
    const a = added.filter((t) => t.trim() !== "");
    const key = (t) => (t.match(/^\s*/)?.[0].length ?? 0) + "|" + normalizeForFormatting(t);
    if (r.length === a.length && r.every((t, i) => key(t) === key(a[i]))) {
      return { kind: "formatting", reason: "Whitespace and punctuation only" };
    }
  } else if (flatten(removed) === flatten(added)) {
    return { kind: "formatting", reason: "Whitespace, quotes or punctuation only" };
  }
  const before = importStatements(removed);
  const after = importStatements(added);
  if (before && after && before.length > 0) {
    const a = [...before].sort().join("\n");
    const b = [...after].sort().join("\n");
    if (a === b) return { kind: "imports", reason: "Imports reordered" };
  }
  const map = renameMapping(h);
  if (map) {
    const pairs = [...map].map(([from, to]) => `${from}->${to}`);
    const seenElsewhere = pairs.every((p) => (renameSupport.get(p) ?? 0) >= 2);
    const declared = [...map.keys()].every((from) => declares(h, from));
    if (seenElsewhere || declared) {
      const label = [...map].map(([from, to]) => `\`${from}\` \u2192 \`${to}\``).join(", ");
      return { kind: "rename", reason: `Rename only: ${label}` };
    }
  }
  return void 0;
}
function collectRenameSupport(files) {
  const support = /* @__PURE__ */ new Map();
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

// src/analyze.ts
var TIER_ORDER = { critical: 0, high: 1, medium: 2, low: 3, trivial: 4 };
function analyze(diff, opts = {}) {
  const files = (typeof diff === "string" ? parseDiff(diff) : diff).filter(
    (f) => !(opts.ignore ?? []).some((re) => re.test(f.newPath) || re.test(f.oldPath))
  );
  const renameSupport = collectRenameSupport(files);
  const hunks = [];
  const notes = [];
  for (const file of files) {
    if (file.binary) notes.push(`Binary file ${file.status}: ${file.newPath}`);
    else if (file.status === "renamed" && file.hunks.length === 0) {
      notes.push(`Renamed without changes: ${file.oldPath} \u2192 ${file.newPath}`);
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
    (a, b) => TIER_ORDER[a.risk.tier] - TIER_ORDER[b.risk.tier] || b.risk.score - a.risk.score || a.hunk.path.localeCompare(b.hunk.path) || a.hunk.newStart - b.hunk.newStart
  );
  const byTier = { critical: 0, high: 0, medium: 0, low: 0, trivial: 0 };
  for (const h of hunks) byTier[h.risk.tier]++;
  return {
    version: 1,
    generatedAt: (opts.now ?? /* @__PURE__ */ new Date()).toISOString(),
    source: opts.source,
    totals: {
      files: files.length,
      hunks: hunks.length,
      added: hunks.reduce((n, h) => n + h.added, 0),
      removed: hunks.reduce((n, h) => n + h.removed, 0),
      byTier,
      coverageProvided: opts.coverage !== void 0
    },
    hunks,
    notes
  };
}

// src/report/html.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function viewerAssets() {
  if (true) {
    return { js: '"use strict";(()=>{var F0=Object.create;var Iu=Object.defineProperty;var I0=Object.getOwnPropertyDescriptor;var P0=Object.getOwnPropertyNames;var tr=Object.getPrototypeOf,lr=Object.prototype.hasOwnProperty;var Gf=(t,l,e)=>()=>{if(e)throw e[0];try{return t&&(l=t(t=0)),l}catch(a){throw e=[a],a}};var ll=(t,l)=>()=>{try{return l||t((l={exports:{}}).exports,l),l.exports}catch(e){throw l=0,e}},er=(t,l)=>{for(var e in l)Iu(t,e,{get:l[e],enumerable:!0})},ar=(t,l,e,a)=>{if(l&&typeof l=="object"||typeof l=="function")for(let n of P0(l))!lr.call(t,n)&&n!==e&&Iu(t,n,{get:()=>l[n],enumerable:!(a=I0(l,n))||a.enumerable});return t};var Lt=(t,l,e)=>(e=t!=null?F0(tr(t)):{},ar(l||!t||!t.__esModule?Iu(e,"default",{value:t,enumerable:!0}):e,t));var $f=ll(W=>{"use strict";function ei(t,l){var e=t.length;t.push(l);t:for(;0<e;){var a=e-1>>>1,n=t[a];if(0<pn(n,l))t[a]=l,t[e]=n,e=a;else break t}}function el(t){return t.length===0?null:t[0]}function En(t){if(t.length===0)return null;var l=t[0],e=t.pop();if(e!==l){t[0]=e;t:for(var a=0,n=t.length,u=n>>>1;a<u;){var i=2*(a+1)-1,c=t[i],f=i+1,d=t[f];if(0>pn(c,e))f<n&&0>pn(d,c)?(t[a]=d,t[f]=e,a=f):(t[a]=c,t[i]=e,a=i);else if(f<n&&0>pn(d,e))t[a]=d,t[f]=e,a=f;else break t}}return l}function pn(t,l){var e=t.sortIndex-l.sortIndex;return e!==0?e:t.id-l.id}W.unstable_now=void 0;typeof performance=="object"&&typeof performance.now=="function"?(jf=performance,W.unstable_now=function(){return jf.now()}):(Pu=Date,Qf=Pu.now(),W.unstable_now=function(){return Pu.now()-Qf});var jf,Pu,Qf,dl=[],Dl=[],nr=1,Xt=null,gt=3,ai=!1,ha=!1,ga=!1,ni=!1,Vf=typeof setTimeout=="function"?setTimeout:null,Kf=typeof clearTimeout=="function"?clearTimeout:null,wf=typeof setImmediate<"u"?setImmediate:null;function bn(t){for(var l=el(Dl);l!==null;){if(l.callback===null)En(Dl);else if(l.startTime<=t)En(Dl),l.sortIndex=l.expirationTime,ei(dl,l);else break;l=el(Dl)}}function ui(t){if(ga=!1,bn(t),!ha)if(el(dl)!==null)ha=!0,_e||(_e=!0,Ae());else{var l=el(Dl);l!==null&&ii(ui,l.startTime-t)}}var _e=!1,Sa=-1,kf=5,Jf=-1;function Wf(){return ni?!0:!(W.unstable_now()-Jf<kf)}function ti(){if(ni=!1,_e){var t=W.unstable_now();Jf=t;var l=!0;try{t:{ha=!1,ga&&(ga=!1,Kf(Sa),Sa=-1),ai=!0;var e=gt;try{l:{for(bn(t),Xt=el(dl);Xt!==null&&!(Xt.expirationTime>t&&Wf());){var a=Xt.callback;if(typeof a=="function"){Xt.callback=null,gt=Xt.priorityLevel;var n=a(Xt.expirationTime<=t);if(t=W.unstable_now(),typeof n=="function"){Xt.callback=n,bn(t),l=!0;break l}Xt===el(dl)&&En(dl),bn(t)}else En(dl);Xt=el(dl)}if(Xt!==null)l=!0;else{var u=el(Dl);u!==null&&ii(ui,u.startTime-t),l=!1}}break t}finally{Xt=null,gt=e,ai=!1}l=void 0}}finally{l?Ae():_e=!1}}}var Ae;typeof wf=="function"?Ae=function(){wf(ti)}:typeof MessageChannel<"u"?(li=new MessageChannel,Zf=li.port2,li.port1.onmessage=ti,Ae=function(){Zf.postMessage(null)}):Ae=function(){Vf(ti,0)};var li,Zf;function ii(t,l){Sa=Vf(function(){t(W.unstable_now())},l)}W.unstable_IdlePriority=5;W.unstable_ImmediatePriority=1;W.unstable_LowPriority=4;W.unstable_NormalPriority=3;W.unstable_Profiling=null;W.unstable_UserBlockingPriority=2;W.unstable_cancelCallback=function(t){t.callback=null};W.unstable_forceFrameRate=function(t){0>t||125<t?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):kf=0<t?Math.floor(1e3/t):5};W.unstable_getCurrentPriorityLevel=function(){return gt};W.unstable_next=function(t){switch(gt){case 1:case 2:case 3:var l=3;break;default:l=gt}var e=gt;gt=l;try{return t()}finally{gt=e}};W.unstable_requestPaint=function(){ni=!0};W.unstable_runWithPriority=function(t,l){switch(t){case 1:case 2:case 3:case 4:case 5:break;default:t=3}var e=gt;gt=t;try{return l()}finally{gt=e}};W.unstable_scheduleCallback=function(t,l,e){var a=W.unstable_now();switch(typeof e=="object"&&e!==null?(e=e.delay,e=typeof e=="number"&&0<e?a+e:a):e=a,t){case 1:var n=-1;break;case 2:n=250;break;case 5:n=1073741823;break;case 4:n=1e4;break;default:n=5e3}return n=e+n,t={id:nr++,callback:l,priorityLevel:t,startTime:e,expirationTime:n,sortIndex:-1},e>a?(t.sortIndex=e,ei(Dl,t),el(dl)===null&&t===el(Dl)&&(ga?(Kf(Sa),Sa=-1):ga=!0,ii(ui,e-a))):(t.sortIndex=n,ei(dl,t),ha||ai||(ha=!0,_e||(_e=!0,Ae()))),t};W.unstable_shouldYield=Wf;W.unstable_wrapCallback=function(t){var l=gt;return function(){var e=gt;gt=l;try{return t.apply(this,arguments)}finally{gt=e}}}});var If=ll((iv,Ff)=>{"use strict";Ff.exports=$f()});var dd=ll(M=>{"use strict";var di=Symbol.for("react.transitional.element"),ur=Symbol.for("react.portal"),ir=Symbol.for("react.fragment"),cr=Symbol.for("react.strict_mode"),fr=Symbol.for("react.profiler"),dr=Symbol.for("react.consumer"),sr=Symbol.for("react.context"),or=Symbol.for("react.forward_ref"),mr=Symbol.for("react.suspense"),rr=Symbol.for("react.memo"),ad=Symbol.for("react.lazy"),yr=Symbol.for("react.activity"),Pf=Symbol.iterator;function vr(t){return t===null||typeof t!="object"?null:(t=Pf&&t[Pf]||t["@@iterator"],typeof t=="function"?t:null)}var nd={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},ud=Object.assign,id={};function Me(t,l,e){this.props=t,this.context=l,this.refs=id,this.updater=e||nd}Me.prototype.isReactComponent={};Me.prototype.setState=function(t,l){if(typeof t!="object"&&typeof t!="function"&&t!=null)throw Error("takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,t,l,"setState")};Me.prototype.forceUpdate=function(t){this.updater.enqueueForceUpdate(this,t,"forceUpdate")};function cd(){}cd.prototype=Me.prototype;function si(t,l,e){this.props=t,this.context=l,this.refs=id,this.updater=e||nd}var oi=si.prototype=new cd;oi.constructor=si;ud(oi,Me.prototype);oi.isPureReactComponent=!0;var td=Array.isArray;function fi(){}var V={H:null,A:null,T:null,S:null},fd=Object.prototype.hasOwnProperty;function mi(t,l,e){var a=e.ref;return{$$typeof:di,type:t,key:l,ref:a!==void 0?a:null,props:e}}function hr(t,l){return mi(t.type,l,t.props)}function ri(t){return typeof t=="object"&&t!==null&&t.$$typeof===di}function gr(t){var l={"=":"=0",":":"=2"};return"$"+t.replace(/[=:]/g,function(e){return l[e]})}var ld=/\\/+/g;function ci(t,l){return typeof t=="object"&&t!==null&&t.key!=null?gr(""+t.key):l.toString(36)}function Sr(t){switch(t.status){case"fulfilled":return t.value;case"rejected":throw t.reason;default:switch(typeof t.status=="string"?t.then(fi,fi):(t.status="pending",t.then(function(l){t.status==="pending"&&(t.status="fulfilled",t.value=l)},function(l){t.status==="pending"&&(t.status="rejected",t.reason=l)})),t.status){case"fulfilled":return t.value;case"rejected":throw t.reason}}throw t}function Oe(t,l,e,a,n){var u=typeof t;(u==="undefined"||u==="boolean")&&(t=null);var i=!1;if(t===null)i=!0;else switch(u){case"bigint":case"string":case"number":i=!0;break;case"object":switch(t.$$typeof){case di:case ur:i=!0;break;case ad:return i=t._init,Oe(i(t._payload),l,e,a,n)}}if(i)return n=n(t),i=a===""?"."+ci(t,0):a,td(n)?(e="",i!=null&&(e=i.replace(ld,"$&/")+"/"),Oe(n,l,e,"",function(d){return d})):n!=null&&(ri(n)&&(n=hr(n,e+(n.key==null||t&&t.key===n.key?"":(""+n.key).replace(ld,"$&/")+"/")+i)),l.push(n)),1;i=0;var c=a===""?".":a+":";if(td(t))for(var f=0;f<t.length;f++)a=t[f],u=c+ci(a,f),i+=Oe(a,l,e,u,n);else if(f=vr(t),typeof f=="function")for(t=f.call(t),f=0;!(a=t.next()).done;)a=a.value,u=c+ci(a,f++),i+=Oe(a,l,e,u,n);else if(u==="object"){if(typeof t.then=="function")return Oe(Sr(t),l,e,a,n);throw l=String(t),Error("Objects are not valid as a React child (found: "+(l==="[object Object]"?"object with keys {"+Object.keys(t).join(", ")+"}":l)+"). If you meant to render a collection of children, use an array instead.")}return i}function Tn(t,l,e){if(t==null)return t;var a=[],n=0;return Oe(t,a,"","",function(u){return l.call(e,u,n++)}),a}function pr(t){if(t._status===-1){var l=t._result;l=l(),l.then(function(e){(t._status===0||t._status===-1)&&(t._status=1,t._result=e)},function(e){(t._status===0||t._status===-1)&&(t._status=2,t._result=e)}),t._status===-1&&(t._status=0,t._result=l)}if(t._status===1)return t._result.default;throw t._result}var ed=typeof reportError=="function"?reportError:function(t){if(typeof window=="object"&&typeof window.ErrorEvent=="function"){var l=new window.ErrorEvent("error",{bubbles:!0,cancelable:!0,message:typeof t=="object"&&t!==null&&typeof t.message=="string"?String(t.message):String(t),error:t});if(!window.dispatchEvent(l))return}else if(typeof process=="object"&&typeof process.emit=="function"){process.emit("uncaughtException",t);return}console.error(t)},br={map:Tn,forEach:function(t,l,e){Tn(t,function(){l.apply(this,arguments)},e)},count:function(t){var l=0;return Tn(t,function(){l++}),l},toArray:function(t){return Tn(t,function(l){return l})||[]},only:function(t){if(!ri(t))throw Error("React.Children.only expected to receive a single React element child.");return t}};M.Activity=yr;M.Children=br;M.Component=Me;M.Fragment=ir;M.Profiler=fr;M.PureComponent=si;M.StrictMode=cr;M.Suspense=mr;M.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=V;M.__COMPILER_RUNTIME={__proto__:null,c:function(t){return V.H.useMemoCache(t)}};M.cache=function(t){return function(){return t.apply(null,arguments)}};M.cacheSignal=function(){return null};M.cloneElement=function(t,l,e){if(t==null)throw Error("The argument must be a React element, but you passed "+t+".");var a=ud({},t.props),n=t.key;if(l!=null)for(u in l.key!==void 0&&(n=""+l.key),l)!fd.call(l,u)||u==="key"||u==="__self"||u==="__source"||u==="ref"&&l.ref===void 0||(a[u]=l[u]);var u=arguments.length-2;if(u===1)a.children=e;else if(1<u){for(var i=Array(u),c=0;c<u;c++)i[c]=arguments[c+2];a.children=i}return mi(t.type,n,a)};M.createContext=function(t){return t={$$typeof:sr,_currentValue:t,_currentValue2:t,_threadCount:0,Provider:null,Consumer:null},t.Provider=t,t.Consumer={$$typeof:dr,_context:t},t};M.createElement=function(t,l,e){var a,n={},u=null;if(l!=null)for(a in l.key!==void 0&&(u=""+l.key),l)fd.call(l,a)&&a!=="key"&&a!=="__self"&&a!=="__source"&&(n[a]=l[a]);var i=arguments.length-2;if(i===1)n.children=e;else if(1<i){for(var c=Array(i),f=0;f<i;f++)c[f]=arguments[f+2];n.children=c}if(t&&t.defaultProps)for(a in i=t.defaultProps,i)n[a]===void 0&&(n[a]=i[a]);return mi(t,u,n)};M.createRef=function(){return{current:null}};M.forwardRef=function(t){return{$$typeof:or,render:t}};M.isValidElement=ri;M.lazy=function(t){return{$$typeof:ad,_payload:{_status:-1,_result:t},_init:pr}};M.memo=function(t,l){return{$$typeof:rr,type:t,compare:l===void 0?null:l}};M.startTransition=function(t){var l=V.T,e={};V.T=e;try{var a=t(),n=V.S;n!==null&&n(e,a),typeof a=="object"&&a!==null&&typeof a.then=="function"&&a.then(fi,ed)}catch(u){ed(u)}finally{l!==null&&e.types!==null&&(l.types=e.types),V.T=l}};M.unstable_useCacheRefresh=function(){return V.H.useCacheRefresh()};M.use=function(t){return V.H.use(t)};M.useActionState=function(t,l,e){return V.H.useActionState(t,l,e)};M.useCallback=function(t,l){return V.H.useCallback(t,l)};M.useContext=function(t){return V.H.useContext(t)};M.useDebugValue=function(){};M.useDeferredValue=function(t,l){return V.H.useDeferredValue(t,l)};M.useEffect=function(t,l){return V.H.useEffect(t,l)};M.useEffectEvent=function(t){return V.H.useEffectEvent(t)};M.useId=function(){return V.H.useId()};M.useImperativeHandle=function(t,l,e){return V.H.useImperativeHandle(t,l,e)};M.useInsertionEffect=function(t,l){return V.H.useInsertionEffect(t,l)};M.useLayoutEffect=function(t,l){return V.H.useLayoutEffect(t,l)};M.useMemo=function(t,l){return V.H.useMemo(t,l)};M.useOptimistic=function(t,l){return V.H.useOptimistic(t,l)};M.useReducer=function(t,l,e){return V.H.useReducer(t,l,e)};M.useRef=function(t){return V.H.useRef(t)};M.useState=function(t){return V.H.useState(t)};M.useSyncExternalStore=function(t,l,e){return V.H.useSyncExternalStore(t,l,e)};M.useTransition=function(){return V.H.useTransition()};M.version="19.2.8"});var pa=ll((fv,sd)=>{"use strict";sd.exports=dd()});var md=ll(pt=>{"use strict";var Er=pa();function od(t){var l="https://react.dev/errors/"+t;if(1<arguments.length){l+="?args[]="+encodeURIComponent(arguments[1]);for(var e=2;e<arguments.length;e++)l+="&args[]="+encodeURIComponent(arguments[e])}return"Minified React error #"+t+"; visit "+l+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function Nl(){}var St={d:{f:Nl,r:function(){throw Error(od(522))},D:Nl,C:Nl,L:Nl,m:Nl,X:Nl,S:Nl,M:Nl},p:0,findDOMNode:null},Tr=Symbol.for("react.portal");function zr(t,l,e){var a=3<arguments.length&&arguments[3]!==void 0?arguments[3]:null;return{$$typeof:Tr,key:a==null?null:""+a,children:t,containerInfo:l,implementation:e}}var ba=Er.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;function zn(t,l){if(t==="font")return"";if(typeof l=="string")return l==="use-credentials"?l:""}pt.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=St;pt.createPortal=function(t,l){var e=2<arguments.length&&arguments[2]!==void 0?arguments[2]:null;if(!l||l.nodeType!==1&&l.nodeType!==9&&l.nodeType!==11)throw Error(od(299));return zr(t,l,null,e)};pt.flushSync=function(t){var l=ba.T,e=St.p;try{if(ba.T=null,St.p=2,t)return t()}finally{ba.T=l,St.p=e,St.d.f()}};pt.preconnect=function(t,l){typeof t=="string"&&(l?(l=l.crossOrigin,l=typeof l=="string"?l==="use-credentials"?l:"":void 0):l=null,St.d.C(t,l))};pt.prefetchDNS=function(t){typeof t=="string"&&St.d.D(t)};pt.preinit=function(t,l){if(typeof t=="string"&&l&&typeof l.as=="string"){var e=l.as,a=zn(e,l.crossOrigin),n=typeof l.integrity=="string"?l.integrity:void 0,u=typeof l.fetchPriority=="string"?l.fetchPriority:void 0;e==="style"?St.d.S(t,typeof l.precedence=="string"?l.precedence:void 0,{crossOrigin:a,integrity:n,fetchPriority:u}):e==="script"&&St.d.X(t,{crossOrigin:a,integrity:n,fetchPriority:u,nonce:typeof l.nonce=="string"?l.nonce:void 0})}};pt.preinitModule=function(t,l){if(typeof t=="string")if(typeof l=="object"&&l!==null){if(l.as==null||l.as==="script"){var e=zn(l.as,l.crossOrigin);St.d.M(t,{crossOrigin:e,integrity:typeof l.integrity=="string"?l.integrity:void 0,nonce:typeof l.nonce=="string"?l.nonce:void 0})}}else l==null&&St.d.M(t)};pt.preload=function(t,l){if(typeof t=="string"&&typeof l=="object"&&l!==null&&typeof l.as=="string"){var e=l.as,a=zn(e,l.crossOrigin);St.d.L(t,e,{crossOrigin:a,integrity:typeof l.integrity=="string"?l.integrity:void 0,nonce:typeof l.nonce=="string"?l.nonce:void 0,type:typeof l.type=="string"?l.type:void 0,fetchPriority:typeof l.fetchPriority=="string"?l.fetchPriority:void 0,referrerPolicy:typeof l.referrerPolicy=="string"?l.referrerPolicy:void 0,imageSrcSet:typeof l.imageSrcSet=="string"?l.imageSrcSet:void 0,imageSizes:typeof l.imageSizes=="string"?l.imageSizes:void 0,media:typeof l.media=="string"?l.media:void 0})}};pt.preloadModule=function(t,l){if(typeof t=="string")if(l){var e=zn(l.as,l.crossOrigin);St.d.m(t,{as:typeof l.as=="string"&&l.as!=="script"?l.as:void 0,crossOrigin:e,integrity:typeof l.integrity=="string"?l.integrity:void 0})}else St.d.m(t)};pt.requestFormReset=function(t){St.d.r(t)};pt.unstable_batchedUpdates=function(t,l){return t(l)};pt.useFormState=function(t,l,e){return ba.H.useFormState(t,l,e)};pt.useFormStatus=function(){return ba.H.useHostTransitionStatus()};pt.version="19.2.8"});var vd=ll((sv,yd)=>{"use strict";function rd(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!="function"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(rd)}catch(t){console.error(t)}}rd(),yd.exports=md()});var L0=ll(Ju=>{"use strict";var ct=If(),js=pa(),Ar=vd();function S(t){var l="https://react.dev/errors/"+t;if(1<arguments.length){l+="?args[]="+encodeURIComponent(arguments[1]);for(var e=2;e<arguments.length;e++)l+="&args[]="+encodeURIComponent(arguments[e])}return"Minified React error #"+t+"; visit "+l+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function Qs(t){return!(!t||t.nodeType!==1&&t.nodeType!==9&&t.nodeType!==11)}function cn(t){var l=t,e=t;if(t.alternate)for(;l.return;)l=l.return;else{t=l;do l=t,(l.flags&4098)!==0&&(e=l.return),t=l.return;while(t)}return l.tag===3?e:null}function ws(t){if(t.tag===13){var l=t.memoizedState;if(l===null&&(t=t.alternate,t!==null&&(l=t.memoizedState)),l!==null)return l.dehydrated}return null}function Zs(t){if(t.tag===31){var l=t.memoizedState;if(l===null&&(t=t.alternate,t!==null&&(l=t.memoizedState)),l!==null)return l.dehydrated}return null}function hd(t){if(cn(t)!==t)throw Error(S(188))}function _r(t){var l=t.alternate;if(!l){if(l=cn(t),l===null)throw Error(S(188));return l!==t?null:t}for(var e=t,a=l;;){var n=e.return;if(n===null)break;var u=n.alternate;if(u===null){if(a=n.return,a!==null){e=a;continue}break}if(n.child===u.child){for(u=n.child;u;){if(u===e)return hd(n),t;if(u===a)return hd(n),l;u=u.sibling}throw Error(S(188))}if(e.return!==a.return)e=n,a=u;else{for(var i=!1,c=n.child;c;){if(c===e){i=!0,e=n,a=u;break}if(c===a){i=!0,a=n,e=u;break}c=c.sibling}if(!i){for(c=u.child;c;){if(c===e){i=!0,e=u,a=n;break}if(c===a){i=!0,a=u,e=n;break}c=c.sibling}if(!i)throw Error(S(189))}}if(e.alternate!==a)throw Error(S(190))}if(e.tag!==3)throw Error(S(188));return e.stateNode.current===e?t:l}function Vs(t){var l=t.tag;if(l===5||l===26||l===27||l===6)return t;for(t=t.child;t!==null;){if(l=Vs(t),l!==null)return l;t=t.sibling}return null}var J=Object.assign,Or=Symbol.for("react.element"),An=Symbol.for("react.transitional.element"),La=Symbol.for("react.portal"),Re=Symbol.for("react.fragment"),Ks=Symbol.for("react.strict_mode"),ki=Symbol.for("react.profiler"),ks=Symbol.for("react.consumer"),gl=Symbol.for("react.context"),Qc=Symbol.for("react.forward_ref"),Ji=Symbol.for("react.suspense"),Wi=Symbol.for("react.suspense_list"),wc=Symbol.for("react.memo"),xl=Symbol.for("react.lazy"),$i=Symbol.for("react.activity"),Mr=Symbol.for("react.memo_cache_sentinel"),gd=Symbol.iterator;function Ea(t){return t===null||typeof t!="object"?null:(t=gd&&t[gd]||t["@@iterator"],typeof t=="function"?t:null)}var Lr=Symbol.for("react.client.reference");function Fi(t){if(t==null)return null;if(typeof t=="function")return t.$$typeof===Lr?null:t.displayName||t.name||null;if(typeof t=="string")return t;switch(t){case Re:return"Fragment";case ki:return"Profiler";case Ks:return"StrictMode";case Ji:return"Suspense";case Wi:return"SuspenseList";case $i:return"Activity"}if(typeof t=="object")switch(t.$$typeof){case La:return"Portal";case gl:return t.displayName||"Context";case ks:return(t._context.displayName||"Context")+".Consumer";case Qc:var l=t.render;return t=t.displayName,t||(t=l.displayName||l.name||"",t=t!==""?"ForwardRef("+t+")":"ForwardRef"),t;case wc:return l=t.displayName||null,l!==null?l:Fi(t.type)||"Memo";case xl:l=t._payload,t=t._init;try{return Fi(t(l))}catch{}}return null}var Da=Array.isArray,O=js.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,B=Ar.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,de={pending:!1,data:null,method:null,action:null},Ii=[],He=-1;function cl(t){return{current:t}}function ot(t){0>He||(t.current=Ii[He],Ii[He]=null,He--)}function Z(t,l){He++,Ii[He]=t.current,t.current=l}var il=cl(null),Ka=cl(null),Ql=cl(null),au=cl(null);function nu(t,l){switch(Z(Ql,l),Z(Ka,t),Z(il,null),l.nodeType){case 9:case 11:t=(t=l.documentElement)&&(t=t.namespaceURI)?As(t):0;break;default:if(t=l.tagName,l=l.namespaceURI)l=As(l),t=y0(l,t);else switch(t){case"svg":t=1;break;case"math":t=2;break;default:t=0}}ot(il),Z(il,t)}function Ie(){ot(il),ot(Ka),ot(Ql)}function Pi(t){t.memoizedState!==null&&Z(au,t);var l=il.current,e=y0(l,t.type);l!==e&&(Z(Ka,t),Z(il,e))}function uu(t){Ka.current===t&&(ot(il),ot(Ka)),au.current===t&&(ot(au),an._currentValue=de)}var yi,Sd;function ue(t){if(yi===void 0)try{throw Error()}catch(e){var l=e.stack.trim().match(/\\n( *(at )?)/);yi=l&&l[1]||"",Sd=-1<e.stack.indexOf(`\n    at`)?" (<anonymous>)":-1<e.stack.indexOf("@")?"@unknown:0:0":""}return`\n`+yi+t+Sd}var vi=!1;function hi(t,l){if(!t||vi)return"";vi=!0;var e=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{var a={DetermineComponentFrameRoot:function(){try{if(l){var g=function(){throw Error()};if(Object.defineProperty(g.prototype,"props",{set:function(){throw Error()}}),typeof Reflect=="object"&&Reflect.construct){try{Reflect.construct(g,[])}catch(y){var r=y}Reflect.construct(t,[],g)}else{try{g.call()}catch(y){r=y}t.call(g.prototype)}}else{try{throw Error()}catch(y){r=y}(g=t())&&typeof g.catch=="function"&&g.catch(function(){})}}catch(y){if(y&&r&&typeof y.stack=="string")return[y.stack,r.stack]}return[null,null]}};a.DetermineComponentFrameRoot.displayName="DetermineComponentFrameRoot";var n=Object.getOwnPropertyDescriptor(a.DetermineComponentFrameRoot,"name");n&&n.configurable&&Object.defineProperty(a.DetermineComponentFrameRoot,"name",{value:"DetermineComponentFrameRoot"});var u=a.DetermineComponentFrameRoot(),i=u[0],c=u[1];if(i&&c){var f=i.split(`\n`),d=c.split(`\n`);for(n=a=0;a<f.length&&!f[a].includes("DetermineComponentFrameRoot");)a++;for(;n<d.length&&!d[n].includes("DetermineComponentFrameRoot");)n++;if(a===f.length||n===d.length)for(a=f.length-1,n=d.length-1;1<=a&&0<=n&&f[a]!==d[n];)n--;for(;1<=a&&0<=n;a--,n--)if(f[a]!==d[n]){if(a!==1||n!==1)do if(a--,n--,0>n||f[a]!==d[n]){var v=`\n`+f[a].replace(" at new "," at ");return t.displayName&&v.includes("<anonymous>")&&(v=v.replace("<anonymous>",t.displayName)),v}while(1<=a&&0<=n);break}}}finally{vi=!1,Error.prepareStackTrace=e}return(e=t?t.displayName||t.name:"")?ue(e):""}function Dr(t,l){switch(t.tag){case 26:case 27:case 5:return ue(t.type);case 16:return ue("Lazy");case 13:return t.child!==l&&l!==null?ue("Suspense Fallback"):ue("Suspense");case 19:return ue("SuspenseList");case 0:case 15:return hi(t.type,!1);case 11:return hi(t.type.render,!1);case 1:return hi(t.type,!0);case 31:return ue("Activity");default:return""}}function pd(t){try{var l="",e=null;do l+=Dr(t,e),e=t,t=t.return;while(t);return l}catch(a){return`\nError generating stack: `+a.message+`\n`+a.stack}}var tc=Object.prototype.hasOwnProperty,Zc=ct.unstable_scheduleCallback,gi=ct.unstable_cancelCallback,Nr=ct.unstable_shouldYield,xr=ct.unstable_requestPaint,Rt=ct.unstable_now,Ur=ct.unstable_getCurrentPriorityLevel,Js=ct.unstable_ImmediatePriority,Ws=ct.unstable_UserBlockingPriority,iu=ct.unstable_NormalPriority,Rr=ct.unstable_LowPriority,$s=ct.unstable_IdlePriority,Hr=ct.log,Cr=ct.unstable_setDisableYieldValue,fn=null,Ht=null;function Bl(t){if(typeof Hr=="function"&&Cr(t),Ht&&typeof Ht.setStrictMode=="function")try{Ht.setStrictMode(fn,t)}catch{}}var Ct=Math.clz32?Math.clz32:Yr,qr=Math.log,Br=Math.LN2;function Yr(t){return t>>>=0,t===0?32:31-(qr(t)/Br|0)|0}var _n=256,On=262144,Mn=4194304;function ie(t){var l=t&42;if(l!==0)return l;switch(t&-t){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:return 64;case 128:return 128;case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:return t&261888;case 262144:case 524288:case 1048576:case 2097152:return t&3932160;case 4194304:case 8388608:case 16777216:case 33554432:return t&62914560;case 67108864:return 67108864;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 0;default:return t}}function Uu(t,l,e){var a=t.pendingLanes;if(a===0)return 0;var n=0,u=t.suspendedLanes,i=t.pingedLanes;t=t.warmLanes;var c=a&134217727;return c!==0?(a=c&~u,a!==0?n=ie(a):(i&=c,i!==0?n=ie(i):e||(e=c&~t,e!==0&&(n=ie(e))))):(c=a&~u,c!==0?n=ie(c):i!==0?n=ie(i):e||(e=a&~t,e!==0&&(n=ie(e)))),n===0?0:l!==0&&l!==n&&(l&u)===0&&(u=n&-n,e=l&-l,u>=e||u===32&&(e&4194048)!==0)?l:n}function dn(t,l){return(t.pendingLanes&~(t.suspendedLanes&~t.pingedLanes)&l)===0}function Xr(t,l){switch(t){case 1:case 2:case 4:case 8:case 64:return l+250;case 16:case 32:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return l+5e3;case 4194304:case 8388608:case 16777216:case 33554432:return-1;case 67108864:case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function Fs(){var t=Mn;return Mn<<=1,(Mn&62914560)===0&&(Mn=4194304),t}function Si(t){for(var l=[],e=0;31>e;e++)l.push(t);return l}function sn(t,l){t.pendingLanes|=l,l!==268435456&&(t.suspendedLanes=0,t.pingedLanes=0,t.warmLanes=0)}function Gr(t,l,e,a,n,u){var i=t.pendingLanes;t.pendingLanes=e,t.suspendedLanes=0,t.pingedLanes=0,t.warmLanes=0,t.expiredLanes&=e,t.entangledLanes&=e,t.errorRecoveryDisabledLanes&=e,t.shellSuspendCounter=0;var c=t.entanglements,f=t.expirationTimes,d=t.hiddenUpdates;for(e=i&~e;0<e;){var v=31-Ct(e),g=1<<v;c[v]=0,f[v]=-1;var r=d[v];if(r!==null)for(d[v]=null,v=0;v<r.length;v++){var y=r[v];y!==null&&(y.lane&=-536870913)}e&=~g}a!==0&&Is(t,a,0),u!==0&&n===0&&t.tag!==0&&(t.suspendedLanes|=u&~(i&~l))}function Is(t,l,e){t.pendingLanes|=l,t.suspendedLanes&=~l;var a=31-Ct(l);t.entangledLanes|=l,t.entanglements[a]=t.entanglements[a]|1073741824|e&261930}function Ps(t,l){var e=t.entangledLanes|=l;for(t=t.entanglements;e;){var a=31-Ct(e),n=1<<a;n&l|t[a]&l&&(t[a]|=l),e&=~n}}function to(t,l){var e=l&-l;return e=(e&42)!==0?1:Vc(e),(e&(t.suspendedLanes|l))!==0?0:e}function Vc(t){switch(t){case 2:t=1;break;case 8:t=4;break;case 32:t=16;break;case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:t=128;break;case 268435456:t=134217728;break;default:t=0}return t}function Kc(t){return t&=-t,2<t?8<t?(t&134217727)!==0?32:268435456:8:2}function lo(){var t=B.p;return t!==0?t:(t=window.event,t===void 0?32:_0(t.type))}function bd(t,l){var e=B.p;try{return B.p=t,l()}finally{B.p=e}}var le=Math.random().toString(36).slice(2),rt="__reactFiber$"+le,Ot="__reactProps$"+le,da="__reactContainer$"+le,lc="__reactEvents$"+le,jr="__reactListeners$"+le,Qr="__reactHandles$"+le,Ed="__reactResources$"+le,on="__reactMarker$"+le;function kc(t){delete t[rt],delete t[Ot],delete t[lc],delete t[jr],delete t[Qr]}function Ce(t){var l=t[rt];if(l)return l;for(var e=t.parentNode;e;){if(l=e[da]||e[rt]){if(e=l.alternate,l.child!==null||e!==null&&e.child!==null)for(t=Ds(t);t!==null;){if(e=t[rt])return e;t=Ds(t)}return l}t=e,e=t.parentNode}return null}function sa(t){if(t=t[rt]||t[da]){var l=t.tag;if(l===5||l===6||l===13||l===31||l===26||l===27||l===3)return t}return null}function Na(t){var l=t.tag;if(l===5||l===26||l===27||l===6)return t.stateNode;throw Error(S(33))}function Ve(t){var l=t[Ed];return l||(l=t[Ed]={hoistableStyles:new Map,hoistableScripts:new Map}),l}function st(t){t[on]=!0}var eo=new Set,ao={};function pe(t,l){Pe(t,l),Pe(t+"Capture",l)}function Pe(t,l){for(ao[t]=l,t=0;t<l.length;t++)eo.add(l[t])}var wr=RegExp("^[:A-Z_a-z\\\\u00C0-\\\\u00D6\\\\u00D8-\\\\u00F6\\\\u00F8-\\\\u02FF\\\\u0370-\\\\u037D\\\\u037F-\\\\u1FFF\\\\u200C-\\\\u200D\\\\u2070-\\\\u218F\\\\u2C00-\\\\u2FEF\\\\u3001-\\\\uD7FF\\\\uF900-\\\\uFDCF\\\\uFDF0-\\\\uFFFD][:A-Z_a-z\\\\u00C0-\\\\u00D6\\\\u00D8-\\\\u00F6\\\\u00F8-\\\\u02FF\\\\u0370-\\\\u037D\\\\u037F-\\\\u1FFF\\\\u200C-\\\\u200D\\\\u2070-\\\\u218F\\\\u2C00-\\\\u2FEF\\\\u3001-\\\\uD7FF\\\\uF900-\\\\uFDCF\\\\uFDF0-\\\\uFFFD\\\\-.0-9\\\\u00B7\\\\u0300-\\\\u036F\\\\u203F-\\\\u2040]*$"),Td={},zd={};function Zr(t){return tc.call(zd,t)?!0:tc.call(Td,t)?!1:wr.test(t)?zd[t]=!0:(Td[t]=!0,!1)}function Qn(t,l,e){if(Zr(l))if(e===null)t.removeAttribute(l);else{switch(typeof e){case"undefined":case"function":case"symbol":t.removeAttribute(l);return;case"boolean":var a=l.toLowerCase().slice(0,5);if(a!=="data-"&&a!=="aria-"){t.removeAttribute(l);return}}t.setAttribute(l,""+e)}}function Ln(t,l,e){if(e===null)t.removeAttribute(l);else{switch(typeof e){case"undefined":case"function":case"symbol":case"boolean":t.removeAttribute(l);return}t.setAttribute(l,""+e)}}function sl(t,l,e,a){if(a===null)t.removeAttribute(e);else{switch(typeof a){case"undefined":case"function":case"symbol":case"boolean":t.removeAttribute(e);return}t.setAttributeNS(l,e,""+a)}}function jt(t){switch(typeof t){case"bigint":case"boolean":case"number":case"string":case"undefined":return t;case"object":return t;default:return""}}function no(t){var l=t.type;return(t=t.nodeName)&&t.toLowerCase()==="input"&&(l==="checkbox"||l==="radio")}function Vr(t,l,e){var a=Object.getOwnPropertyDescriptor(t.constructor.prototype,l);if(!t.hasOwnProperty(l)&&typeof a<"u"&&typeof a.get=="function"&&typeof a.set=="function"){var n=a.get,u=a.set;return Object.defineProperty(t,l,{configurable:!0,get:function(){return n.call(this)},set:function(i){e=""+i,u.call(this,i)}}),Object.defineProperty(t,l,{enumerable:a.enumerable}),{getValue:function(){return e},setValue:function(i){e=""+i},stopTracking:function(){t._valueTracker=null,delete t[l]}}}}function ec(t){if(!t._valueTracker){var l=no(t)?"checked":"value";t._valueTracker=Vr(t,l,""+t[l])}}function uo(t){if(!t)return!1;var l=t._valueTracker;if(!l)return!0;var e=l.getValue(),a="";return t&&(a=no(t)?t.checked?"true":"false":t.value),t=a,t!==e?(l.setValue(t),!0):!1}function cu(t){if(t=t||(typeof document<"u"?document:void 0),typeof t>"u")return null;try{return t.activeElement||t.body}catch{return t.body}}var Kr=/[\\n"\\\\]/g;function Zt(t){return t.replace(Kr,function(l){return"\\\\"+l.charCodeAt(0).toString(16)+" "})}function ac(t,l,e,a,n,u,i,c){t.name="",i!=null&&typeof i!="function"&&typeof i!="symbol"&&typeof i!="boolean"?t.type=i:t.removeAttribute("type"),l!=null?i==="number"?(l===0&&t.value===""||t.value!=l)&&(t.value=""+jt(l)):t.value!==""+jt(l)&&(t.value=""+jt(l)):i!=="submit"&&i!=="reset"||t.removeAttribute("value"),l!=null?nc(t,i,jt(l)):e!=null?nc(t,i,jt(e)):a!=null&&t.removeAttribute("value"),n==null&&u!=null&&(t.defaultChecked=!!u),n!=null&&(t.checked=n&&typeof n!="function"&&typeof n!="symbol"),c!=null&&typeof c!="function"&&typeof c!="symbol"&&typeof c!="boolean"?t.name=""+jt(c):t.removeAttribute("name")}function io(t,l,e,a,n,u,i,c){if(u!=null&&typeof u!="function"&&typeof u!="symbol"&&typeof u!="boolean"&&(t.type=u),l!=null||e!=null){if(!(u!=="submit"&&u!=="reset"||l!=null)){ec(t);return}e=e!=null?""+jt(e):"",l=l!=null?""+jt(l):e,c||l===t.value||(t.value=l),t.defaultValue=l}a=a??n,a=typeof a!="function"&&typeof a!="symbol"&&!!a,t.checked=c?t.checked:!!a,t.defaultChecked=!!a,i!=null&&typeof i!="function"&&typeof i!="symbol"&&typeof i!="boolean"&&(t.name=i),ec(t)}function nc(t,l,e){l==="number"&&cu(t.ownerDocument)===t||t.defaultValue===""+e||(t.defaultValue=""+e)}function Ke(t,l,e,a){if(t=t.options,l){l={};for(var n=0;n<e.length;n++)l["$"+e[n]]=!0;for(e=0;e<t.length;e++)n=l.hasOwnProperty("$"+t[e].value),t[e].selected!==n&&(t[e].selected=n),n&&a&&(t[e].defaultSelected=!0)}else{for(e=""+jt(e),l=null,n=0;n<t.length;n++){if(t[n].value===e){t[n].selected=!0,a&&(t[n].defaultSelected=!0);return}l!==null||t[n].disabled||(l=t[n])}l!==null&&(l.selected=!0)}}function co(t,l,e){if(l!=null&&(l=""+jt(l),l!==t.value&&(t.value=l),e==null)){t.defaultValue!==l&&(t.defaultValue=l);return}t.defaultValue=e!=null?""+jt(e):""}function fo(t,l,e,a){if(l==null){if(a!=null){if(e!=null)throw Error(S(92));if(Da(a)){if(1<a.length)throw Error(S(93));a=a[0]}e=a}e==null&&(e=""),l=e}e=jt(l),t.defaultValue=e,a=t.textContent,a===e&&a!==""&&a!==null&&(t.value=a),ec(t)}function ta(t,l){if(l){var e=t.firstChild;if(e&&e===t.lastChild&&e.nodeType===3){e.nodeValue=l;return}}t.textContent=l}var kr=new Set("animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(" "));function Ad(t,l,e){var a=l.indexOf("--")===0;e==null||typeof e=="boolean"||e===""?a?t.setProperty(l,""):l==="float"?t.cssFloat="":t[l]="":a?t.setProperty(l,e):typeof e!="number"||e===0||kr.has(l)?l==="float"?t.cssFloat=e:t[l]=(""+e).trim():t[l]=e+"px"}function so(t,l,e){if(l!=null&&typeof l!="object")throw Error(S(62));if(t=t.style,e!=null){for(var a in e)!e.hasOwnProperty(a)||l!=null&&l.hasOwnProperty(a)||(a.indexOf("--")===0?t.setProperty(a,""):a==="float"?t.cssFloat="":t[a]="");for(var n in l)a=l[n],l.hasOwnProperty(n)&&e[n]!==a&&Ad(t,n,a)}else for(var u in l)l.hasOwnProperty(u)&&Ad(t,u,l[u])}function Jc(t){if(t.indexOf("-")===-1)return!1;switch(t){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}var Jr=new Map([["acceptCharset","accept-charset"],["htmlFor","for"],["httpEquiv","http-equiv"],["crossOrigin","crossorigin"],["accentHeight","accent-height"],["alignmentBaseline","alignment-baseline"],["arabicForm","arabic-form"],["baselineShift","baseline-shift"],["capHeight","cap-height"],["clipPath","clip-path"],["clipRule","clip-rule"],["colorInterpolation","color-interpolation"],["colorInterpolationFilters","color-interpolation-filters"],["colorProfile","color-profile"],["colorRendering","color-rendering"],["dominantBaseline","dominant-baseline"],["enableBackground","enable-background"],["fillOpacity","fill-opacity"],["fillRule","fill-rule"],["floodColor","flood-color"],["floodOpacity","flood-opacity"],["fontFamily","font-family"],["fontSize","font-size"],["fontSizeAdjust","font-size-adjust"],["fontStretch","font-stretch"],["fontStyle","font-style"],["fontVariant","font-variant"],["fontWeight","font-weight"],["glyphName","glyph-name"],["glyphOrientationHorizontal","glyph-orientation-horizontal"],["glyphOrientationVertical","glyph-orientation-vertical"],["horizAdvX","horiz-adv-x"],["horizOriginX","horiz-origin-x"],["imageRendering","image-rendering"],["letterSpacing","letter-spacing"],["lightingColor","lighting-color"],["markerEnd","marker-end"],["markerMid","marker-mid"],["markerStart","marker-start"],["overlinePosition","overline-position"],["overlineThickness","overline-thickness"],["paintOrder","paint-order"],["panose-1","panose-1"],["pointerEvents","pointer-events"],["renderingIntent","rendering-intent"],["shapeRendering","shape-rendering"],["stopColor","stop-color"],["stopOpacity","stop-opacity"],["strikethroughPosition","strikethrough-position"],["strikethroughThickness","strikethrough-thickness"],["strokeDasharray","stroke-dasharray"],["strokeDashoffset","stroke-dashoffset"],["strokeLinecap","stroke-linecap"],["strokeLinejoin","stroke-linejoin"],["strokeMiterlimit","stroke-miterlimit"],["strokeOpacity","stroke-opacity"],["strokeWidth","stroke-width"],["textAnchor","text-anchor"],["textDecoration","text-decoration"],["textRendering","text-rendering"],["transformOrigin","transform-origin"],["underlinePosition","underline-position"],["underlineThickness","underline-thickness"],["unicodeBidi","unicode-bidi"],["unicodeRange","unicode-range"],["unitsPerEm","units-per-em"],["vAlphabetic","v-alphabetic"],["vHanging","v-hanging"],["vIdeographic","v-ideographic"],["vMathematical","v-mathematical"],["vectorEffect","vector-effect"],["vertAdvY","vert-adv-y"],["vertOriginX","vert-origin-x"],["vertOriginY","vert-origin-y"],["wordSpacing","word-spacing"],["writingMode","writing-mode"],["xmlnsXlink","xmlns:xlink"],["xHeight","x-height"]]),Wr=/^[\\u0000-\\u001F ]*j[\\r\\n\\t]*a[\\r\\n\\t]*v[\\r\\n\\t]*a[\\r\\n\\t]*s[\\r\\n\\t]*c[\\r\\n\\t]*r[\\r\\n\\t]*i[\\r\\n\\t]*p[\\r\\n\\t]*t[\\r\\n\\t]*:/i;function wn(t){return Wr.test(""+t)?"javascript:throw new Error(\'React has blocked a javascript: URL as a security precaution.\')":t}function Sl(){}var uc=null;function Wc(t){return t=t.target||t.srcElement||window,t.correspondingUseElement&&(t=t.correspondingUseElement),t.nodeType===3?t.parentNode:t}var qe=null,ke=null;function _d(t){var l=sa(t);if(l&&(t=l.stateNode)){var e=t[Ot]||null;t:switch(t=l.stateNode,l.type){case"input":if(ac(t,e.value,e.defaultValue,e.defaultValue,e.checked,e.defaultChecked,e.type,e.name),l=e.name,e.type==="radio"&&l!=null){for(e=t;e.parentNode;)e=e.parentNode;for(e=e.querySelectorAll(\'input[name="\'+Zt(""+l)+\'"][type="radio"]\'),l=0;l<e.length;l++){var a=e[l];if(a!==t&&a.form===t.form){var n=a[Ot]||null;if(!n)throw Error(S(90));ac(a,n.value,n.defaultValue,n.defaultValue,n.checked,n.defaultChecked,n.type,n.name)}}for(l=0;l<e.length;l++)a=e[l],a.form===t.form&&uo(a)}break t;case"textarea":co(t,e.value,e.defaultValue);break t;case"select":l=e.value,l!=null&&Ke(t,!!e.multiple,l,!1)}}}var pi=!1;function oo(t,l,e){if(pi)return t(l,e);pi=!0;try{var a=t(l);return a}finally{if(pi=!1,(qe!==null||ke!==null)&&(Zu(),qe&&(l=qe,t=ke,ke=qe=null,_d(l),t)))for(l=0;l<t.length;l++)_d(t[l])}}function ka(t,l){var e=t.stateNode;if(e===null)return null;var a=e[Ot]||null;if(a===null)return null;e=a[l];t:switch(l){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(a=!a.disabled)||(t=t.type,a=!(t==="button"||t==="input"||t==="select"||t==="textarea")),t=!a;break t;default:t=!1}if(t)return null;if(e&&typeof e!="function")throw Error(S(231,l,typeof e));return e}var zl=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),ic=!1;if(zl)try{Le={},Object.defineProperty(Le,"passive",{get:function(){ic=!0}}),window.addEventListener("test",Le,Le),window.removeEventListener("test",Le,Le)}catch{ic=!1}var Le,Yl=null,$c=null,Zn=null;function mo(){if(Zn)return Zn;var t,l=$c,e=l.length,a,n="value"in Yl?Yl.value:Yl.textContent,u=n.length;for(t=0;t<e&&l[t]===n[t];t++);var i=e-t;for(a=1;a<=i&&l[e-a]===n[u-a];a++);return Zn=n.slice(t,1<a?1-a:void 0)}function Vn(t){var l=t.keyCode;return"charCode"in t?(t=t.charCode,t===0&&l===13&&(t=13)):t=l,t===10&&(t=13),32<=t||t===13?t:0}function Dn(){return!0}function Od(){return!1}function Mt(t){function l(e,a,n,u,i){this._reactName=e,this._targetInst=n,this.type=a,this.nativeEvent=u,this.target=i,this.currentTarget=null;for(var c in t)t.hasOwnProperty(c)&&(e=t[c],this[c]=e?e(u):u[c]);return this.isDefaultPrevented=(u.defaultPrevented!=null?u.defaultPrevented:u.returnValue===!1)?Dn:Od,this.isPropagationStopped=Od,this}return J(l.prototype,{preventDefault:function(){this.defaultPrevented=!0;var e=this.nativeEvent;e&&(e.preventDefault?e.preventDefault():typeof e.returnValue!="unknown"&&(e.returnValue=!1),this.isDefaultPrevented=Dn)},stopPropagation:function(){var e=this.nativeEvent;e&&(e.stopPropagation?e.stopPropagation():typeof e.cancelBubble!="unknown"&&(e.cancelBubble=!0),this.isPropagationStopped=Dn)},persist:function(){},isPersistent:Dn}),l}var be={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(t){return t.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Ru=Mt(be),mn=J({},be,{view:0,detail:0}),$r=Mt(mn),bi,Ei,Ta,Hu=J({},mn,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:Fc,button:0,buttons:0,relatedTarget:function(t){return t.relatedTarget===void 0?t.fromElement===t.srcElement?t.toElement:t.fromElement:t.relatedTarget},movementX:function(t){return"movementX"in t?t.movementX:(t!==Ta&&(Ta&&t.type==="mousemove"?(bi=t.screenX-Ta.screenX,Ei=t.screenY-Ta.screenY):Ei=bi=0,Ta=t),bi)},movementY:function(t){return"movementY"in t?t.movementY:Ei}}),Md=Mt(Hu),Fr=J({},Hu,{dataTransfer:0}),Ir=Mt(Fr),Pr=J({},mn,{relatedTarget:0}),Ti=Mt(Pr),t1=J({},be,{animationName:0,elapsedTime:0,pseudoElement:0}),l1=Mt(t1),e1=J({},be,{clipboardData:function(t){return"clipboardData"in t?t.clipboardData:window.clipboardData}}),a1=Mt(e1),n1=J({},be,{data:0}),Ld=Mt(n1),u1={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},i1={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},c1={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};function f1(t){var l=this.nativeEvent;return l.getModifierState?l.getModifierState(t):(t=c1[t])?!!l[t]:!1}function Fc(){return f1}var d1=J({},mn,{key:function(t){if(t.key){var l=u1[t.key]||t.key;if(l!=="Unidentified")return l}return t.type==="keypress"?(t=Vn(t),t===13?"Enter":String.fromCharCode(t)):t.type==="keydown"||t.type==="keyup"?i1[t.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:Fc,charCode:function(t){return t.type==="keypress"?Vn(t):0},keyCode:function(t){return t.type==="keydown"||t.type==="keyup"?t.keyCode:0},which:function(t){return t.type==="keypress"?Vn(t):t.type==="keydown"||t.type==="keyup"?t.keyCode:0}}),s1=Mt(d1),o1=J({},Hu,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),Dd=Mt(o1),m1=J({},mn,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:Fc}),r1=Mt(m1),y1=J({},be,{propertyName:0,elapsedTime:0,pseudoElement:0}),v1=Mt(y1),h1=J({},Hu,{deltaX:function(t){return"deltaX"in t?t.deltaX:"wheelDeltaX"in t?-t.wheelDeltaX:0},deltaY:function(t){return"deltaY"in t?t.deltaY:"wheelDeltaY"in t?-t.wheelDeltaY:"wheelDelta"in t?-t.wheelDelta:0},deltaZ:0,deltaMode:0}),g1=Mt(h1),S1=J({},be,{newState:0,oldState:0}),p1=Mt(S1),b1=[9,13,27,32],Ic=zl&&"CompositionEvent"in window,Ra=null;zl&&"documentMode"in document&&(Ra=document.documentMode);var E1=zl&&"TextEvent"in window&&!Ra,ro=zl&&(!Ic||Ra&&8<Ra&&11>=Ra),Nd=" ",xd=!1;function yo(t,l){switch(t){case"keyup":return b1.indexOf(l.keyCode)!==-1;case"keydown":return l.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function vo(t){return t=t.detail,typeof t=="object"&&"data"in t?t.data:null}var Be=!1;function T1(t,l){switch(t){case"compositionend":return vo(l);case"keypress":return l.which!==32?null:(xd=!0,Nd);case"textInput":return t=l.data,t===Nd&&xd?null:t;default:return null}}function z1(t,l){if(Be)return t==="compositionend"||!Ic&&yo(t,l)?(t=mo(),Zn=$c=Yl=null,Be=!1,t):null;switch(t){case"paste":return null;case"keypress":if(!(l.ctrlKey||l.altKey||l.metaKey)||l.ctrlKey&&l.altKey){if(l.char&&1<l.char.length)return l.char;if(l.which)return String.fromCharCode(l.which)}return null;case"compositionend":return ro&&l.locale!=="ko"?null:l.data;default:return null}}var A1={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};function Ud(t){var l=t&&t.nodeName&&t.nodeName.toLowerCase();return l==="input"?!!A1[t.type]:l==="textarea"}function ho(t,l,e,a){qe?ke?ke.push(a):ke=[a]:qe=a,l=_u(l,"onChange"),0<l.length&&(e=new Ru("onChange","change",null,e,a),t.push({event:e,listeners:l}))}var Ha=null,Ja=null;function _1(t){o0(t,0)}function Cu(t){var l=Na(t);if(uo(l))return t}function Rd(t,l){if(t==="change")return l}var go=!1;zl&&(zl?(xn="oninput"in document,xn||(zi=document.createElement("div"),zi.setAttribute("oninput","return;"),xn=typeof zi.oninput=="function"),Nn=xn):Nn=!1,go=Nn&&(!document.documentMode||9<document.documentMode));var Nn,xn,zi;function Hd(){Ha&&(Ha.detachEvent("onpropertychange",So),Ja=Ha=null)}function So(t){if(t.propertyName==="value"&&Cu(Ja)){var l=[];ho(l,Ja,t,Wc(t)),oo(_1,l)}}function O1(t,l,e){t==="focusin"?(Hd(),Ha=l,Ja=e,Ha.attachEvent("onpropertychange",So)):t==="focusout"&&Hd()}function M1(t){if(t==="selectionchange"||t==="keyup"||t==="keydown")return Cu(Ja)}function L1(t,l){if(t==="click")return Cu(l)}function D1(t,l){if(t==="input"||t==="change")return Cu(l)}function N1(t,l){return t===l&&(t!==0||1/t===1/l)||t!==t&&l!==l}var Bt=typeof Object.is=="function"?Object.is:N1;function Wa(t,l){if(Bt(t,l))return!0;if(typeof t!="object"||t===null||typeof l!="object"||l===null)return!1;var e=Object.keys(t),a=Object.keys(l);if(e.length!==a.length)return!1;for(a=0;a<e.length;a++){var n=e[a];if(!tc.call(l,n)||!Bt(t[n],l[n]))return!1}return!0}function Cd(t){for(;t&&t.firstChild;)t=t.firstChild;return t}function qd(t,l){var e=Cd(t);t=0;for(var a;e;){if(e.nodeType===3){if(a=t+e.textContent.length,t<=l&&a>=l)return{node:e,offset:l-t};t=a}t:{for(;e;){if(e.nextSibling){e=e.nextSibling;break t}e=e.parentNode}e=void 0}e=Cd(e)}}function po(t,l){return t&&l?t===l?!0:t&&t.nodeType===3?!1:l&&l.nodeType===3?po(t,l.parentNode):"contains"in t?t.contains(l):t.compareDocumentPosition?!!(t.compareDocumentPosition(l)&16):!1:!1}function bo(t){t=t!=null&&t.ownerDocument!=null&&t.ownerDocument.defaultView!=null?t.ownerDocument.defaultView:window;for(var l=cu(t.document);l instanceof t.HTMLIFrameElement;){try{var e=typeof l.contentWindow.location.href=="string"}catch{e=!1}if(e)t=l.contentWindow;else break;l=cu(t.document)}return l}function Pc(t){var l=t&&t.nodeName&&t.nodeName.toLowerCase();return l&&(l==="input"&&(t.type==="text"||t.type==="search"||t.type==="tel"||t.type==="url"||t.type==="password")||l==="textarea"||t.contentEditable==="true")}var x1=zl&&"documentMode"in document&&11>=document.documentMode,Ye=null,cc=null,Ca=null,fc=!1;function Bd(t,l,e){var a=e.window===e?e.document:e.nodeType===9?e:e.ownerDocument;fc||Ye==null||Ye!==cu(a)||(a=Ye,"selectionStart"in a&&Pc(a)?a={start:a.selectionStart,end:a.selectionEnd}:(a=(a.ownerDocument&&a.ownerDocument.defaultView||window).getSelection(),a={anchorNode:a.anchorNode,anchorOffset:a.anchorOffset,focusNode:a.focusNode,focusOffset:a.focusOffset}),Ca&&Wa(Ca,a)||(Ca=a,a=_u(cc,"onSelect"),0<a.length&&(l=new Ru("onSelect","select",null,l,e),t.push({event:l,listeners:a}),l.target=Ye)))}function ne(t,l){var e={};return e[t.toLowerCase()]=l.toLowerCase(),e["Webkit"+t]="webkit"+l,e["Moz"+t]="moz"+l,e}var Xe={animationend:ne("Animation","AnimationEnd"),animationiteration:ne("Animation","AnimationIteration"),animationstart:ne("Animation","AnimationStart"),transitionrun:ne("Transition","TransitionRun"),transitionstart:ne("Transition","TransitionStart"),transitioncancel:ne("Transition","TransitionCancel"),transitionend:ne("Transition","TransitionEnd")},Ai={},Eo={};zl&&(Eo=document.createElement("div").style,"AnimationEvent"in window||(delete Xe.animationend.animation,delete Xe.animationiteration.animation,delete Xe.animationstart.animation),"TransitionEvent"in window||delete Xe.transitionend.transition);function Ee(t){if(Ai[t])return Ai[t];if(!Xe[t])return t;var l=Xe[t],e;for(e in l)if(l.hasOwnProperty(e)&&e in Eo)return Ai[t]=l[e];return t}var To=Ee("animationend"),zo=Ee("animationiteration"),Ao=Ee("animationstart"),U1=Ee("transitionrun"),R1=Ee("transitionstart"),H1=Ee("transitioncancel"),_o=Ee("transitionend"),Oo=new Map,dc="abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");dc.push("scrollEnd");function It(t,l){Oo.set(t,l),pe(l,[t])}var fu=typeof reportError=="function"?reportError:function(t){if(typeof window=="object"&&typeof window.ErrorEvent=="function"){var l=new window.ErrorEvent("error",{bubbles:!0,cancelable:!0,message:typeof t=="object"&&t!==null&&typeof t.message=="string"?String(t.message):String(t),error:t});if(!window.dispatchEvent(l))return}else if(typeof process=="object"&&typeof process.emit=="function"){process.emit("uncaughtException",t);return}console.error(t)},Gt=[],Ge=0,tf=0;function qu(){for(var t=Ge,l=tf=Ge=0;l<t;){var e=Gt[l];Gt[l++]=null;var a=Gt[l];Gt[l++]=null;var n=Gt[l];Gt[l++]=null;var u=Gt[l];if(Gt[l++]=null,a!==null&&n!==null){var i=a.pending;i===null?n.next=n:(n.next=i.next,i.next=n),a.pending=n}u!==0&&Mo(e,n,u)}}function Bu(t,l,e,a){Gt[Ge++]=t,Gt[Ge++]=l,Gt[Ge++]=e,Gt[Ge++]=a,tf|=a,t.lanes|=a,t=t.alternate,t!==null&&(t.lanes|=a)}function lf(t,l,e,a){return Bu(t,l,e,a),du(t)}function Te(t,l){return Bu(t,null,null,l),du(t)}function Mo(t,l,e){t.lanes|=e;var a=t.alternate;a!==null&&(a.lanes|=e);for(var n=!1,u=t.return;u!==null;)u.childLanes|=e,a=u.alternate,a!==null&&(a.childLanes|=e),u.tag===22&&(t=u.stateNode,t===null||t._visibility&1||(n=!0)),t=u,u=u.return;return t.tag===3?(u=t.stateNode,n&&l!==null&&(n=31-Ct(e),t=u.hiddenUpdates,a=t[n],a===null?t[n]=[l]:a.push(l),l.lane=e|536870912),u):null}function du(t){if(50<Za)throw Za=0,Nc=null,Error(S(185));for(var l=t.return;l!==null;)t=l,l=t.return;return t.tag===3?t.stateNode:null}var je={};function C1(t,l,e,a){this.tag=t,this.key=e,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.refCleanup=this.ref=null,this.pendingProps=l,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=a,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function xt(t,l,e,a){return new C1(t,l,e,a)}function ef(t){return t=t.prototype,!(!t||!t.isReactComponent)}function bl(t,l){var e=t.alternate;return e===null?(e=xt(t.tag,l,t.key,t.mode),e.elementType=t.elementType,e.type=t.type,e.stateNode=t.stateNode,e.alternate=t,t.alternate=e):(e.pendingProps=l,e.type=t.type,e.flags=0,e.subtreeFlags=0,e.deletions=null),e.flags=t.flags&65011712,e.childLanes=t.childLanes,e.lanes=t.lanes,e.child=t.child,e.memoizedProps=t.memoizedProps,e.memoizedState=t.memoizedState,e.updateQueue=t.updateQueue,l=t.dependencies,e.dependencies=l===null?null:{lanes:l.lanes,firstContext:l.firstContext},e.sibling=t.sibling,e.index=t.index,e.ref=t.ref,e.refCleanup=t.refCleanup,e}function Lo(t,l){t.flags&=65011714;var e=t.alternate;return e===null?(t.childLanes=0,t.lanes=l,t.child=null,t.subtreeFlags=0,t.memoizedProps=null,t.memoizedState=null,t.updateQueue=null,t.dependencies=null,t.stateNode=null):(t.childLanes=e.childLanes,t.lanes=e.lanes,t.child=e.child,t.subtreeFlags=0,t.deletions=null,t.memoizedProps=e.memoizedProps,t.memoizedState=e.memoizedState,t.updateQueue=e.updateQueue,t.type=e.type,l=e.dependencies,t.dependencies=l===null?null:{lanes:l.lanes,firstContext:l.firstContext}),t}function Kn(t,l,e,a,n,u){var i=0;if(a=t,typeof t=="function")ef(t)&&(i=1);else if(typeof t=="string")i=Yy(t,e,il.current)?26:t==="html"||t==="head"||t==="body"?27:5;else t:switch(t){case $i:return t=xt(31,e,l,n),t.elementType=$i,t.lanes=u,t;case Re:return se(e.children,n,u,l);case Ks:i=8,n|=24;break;case ki:return t=xt(12,e,l,n|2),t.elementType=ki,t.lanes=u,t;case Ji:return t=xt(13,e,l,n),t.elementType=Ji,t.lanes=u,t;case Wi:return t=xt(19,e,l,n),t.elementType=Wi,t.lanes=u,t;default:if(typeof t=="object"&&t!==null)switch(t.$$typeof){case gl:i=10;break t;case ks:i=9;break t;case Qc:i=11;break t;case wc:i=14;break t;case xl:i=16,a=null;break t}i=29,e=Error(S(130,t===null?"null":typeof t,"")),a=null}return l=xt(i,e,l,n),l.elementType=t,l.type=a,l.lanes=u,l}function se(t,l,e,a){return t=xt(7,t,a,l),t.lanes=e,t}function _i(t,l,e){return t=xt(6,t,null,l),t.lanes=e,t}function Do(t){var l=xt(18,null,null,0);return l.stateNode=t,l}function Oi(t,l,e){return l=xt(4,t.children!==null?t.children:[],t.key,l),l.lanes=e,l.stateNode={containerInfo:t.containerInfo,pendingChildren:null,implementation:t.implementation},l}var Yd=new WeakMap;function Vt(t,l){if(typeof t=="object"&&t!==null){var e=Yd.get(t);return e!==void 0?e:(l={value:t,source:l,stack:pd(l)},Yd.set(t,l),l)}return{value:t,source:l,stack:pd(l)}}var Qe=[],we=0,su=null,$a=0,Qt=[],wt=0,Fl=null,al=1,nl="";function vl(t,l){Qe[we++]=$a,Qe[we++]=su,su=t,$a=l}function No(t,l,e){Qt[wt++]=al,Qt[wt++]=nl,Qt[wt++]=Fl,Fl=t;var a=al;t=nl;var n=32-Ct(a)-1;a&=~(1<<n),e+=1;var u=32-Ct(l)+n;if(30<u){var i=n-n%5;u=(a&(1<<i)-1).toString(32),a>>=i,n-=i,al=1<<32-Ct(l)+n|e<<n|a,nl=u+t}else al=1<<u|e<<n|a,nl=t}function af(t){t.return!==null&&(vl(t,1),No(t,1,0))}function nf(t){for(;t===su;)su=Qe[--we],Qe[we]=null,$a=Qe[--we],Qe[we]=null;for(;t===Fl;)Fl=Qt[--wt],Qt[wt]=null,nl=Qt[--wt],Qt[wt]=null,al=Qt[--wt],Qt[wt]=null}function xo(t,l){Qt[wt++]=al,Qt[wt++]=nl,Qt[wt++]=Fl,al=l.id,nl=l.overflow,Fl=t}var yt=null,k=null,H=!1,wl=null,Kt=!1,sc=Error(S(519));function Il(t){var l=Error(S(418,1<arguments.length&&arguments[1]!==void 0&&arguments[1]?"text":"HTML",""));throw Fa(Vt(l,t)),sc}function Xd(t){var l=t.stateNode,e=t.type,a=t.memoizedProps;switch(l[rt]=t,l[Ot]=a,e){case"dialog":x("cancel",l),x("close",l);break;case"iframe":case"object":case"embed":x("load",l);break;case"video":case"audio":for(e=0;e<ln.length;e++)x(ln[e],l);break;case"source":x("error",l);break;case"img":case"image":case"link":x("error",l),x("load",l);break;case"details":x("toggle",l);break;case"input":x("invalid",l),io(l,a.value,a.defaultValue,a.checked,a.defaultChecked,a.type,a.name,!0);break;case"select":x("invalid",l);break;case"textarea":x("invalid",l),fo(l,a.value,a.defaultValue,a.children)}e=a.children,typeof e!="string"&&typeof e!="number"&&typeof e!="bigint"||l.textContent===""+e||a.suppressHydrationWarning===!0||r0(l.textContent,e)?(a.popover!=null&&(x("beforetoggle",l),x("toggle",l)),a.onScroll!=null&&x("scroll",l),a.onScrollEnd!=null&&x("scrollend",l),a.onClick!=null&&(l.onclick=Sl),l=!0):l=!1,l||Il(t,!0)}function Gd(t){for(yt=t.return;yt;)switch(yt.tag){case 5:case 31:case 13:Kt=!1;return;case 27:case 3:Kt=!0;return;default:yt=yt.return}}function De(t){if(t!==yt)return!1;if(!H)return Gd(t),H=!0,!1;var l=t.tag,e;if((e=l!==3&&l!==27)&&((e=l===5)&&(e=t.type,e=!(e!=="form"&&e!=="button")||Cc(t.type,t.memoizedProps)),e=!e),e&&k&&Il(t),Gd(t),l===13){if(t=t.memoizedState,t=t!==null?t.dehydrated:null,!t)throw Error(S(317));k=Ls(t)}else if(l===31){if(t=t.memoizedState,t=t!==null?t.dehydrated:null,!t)throw Error(S(317));k=Ls(t)}else l===27?(l=k,ee(t.type)?(t=Xc,Xc=null,k=t):k=l):k=yt?Jt(t.stateNode.nextSibling):null;return!0}function ye(){k=yt=null,H=!1}function Mi(){var t=wl;return t!==null&&(At===null?At=t:At.push.apply(At,t),wl=null),t}function Fa(t){wl===null?wl=[t]:wl.push(t)}var oc=cl(null),ze=null,pl=null;function Rl(t,l,e){Z(oc,l._currentValue),l._currentValue=e}function El(t){t._currentValue=oc.current,ot(oc)}function mc(t,l,e){for(;t!==null;){var a=t.alternate;if((t.childLanes&l)!==l?(t.childLanes|=l,a!==null&&(a.childLanes|=l)):a!==null&&(a.childLanes&l)!==l&&(a.childLanes|=l),t===e)break;t=t.return}}function rc(t,l,e,a){var n=t.child;for(n!==null&&(n.return=t);n!==null;){var u=n.dependencies;if(u!==null){var i=n.child;u=u.firstContext;t:for(;u!==null;){var c=u;u=n;for(var f=0;f<l.length;f++)if(c.context===l[f]){u.lanes|=e,c=u.alternate,c!==null&&(c.lanes|=e),mc(u.return,e,t),a||(i=null);break t}u=c.next}}else if(n.tag===18){if(i=n.return,i===null)throw Error(S(341));i.lanes|=e,u=i.alternate,u!==null&&(u.lanes|=e),mc(i,e,t),i=null}else i=n.child;if(i!==null)i.return=n;else for(i=n;i!==null;){if(i===t){i=null;break}if(n=i.sibling,n!==null){n.return=i.return,i=n;break}i=i.return}n=i}}function oa(t,l,e,a){t=null;for(var n=l,u=!1;n!==null;){if(!u){if((n.flags&524288)!==0)u=!0;else if((n.flags&262144)!==0)break}if(n.tag===10){var i=n.alternate;if(i===null)throw Error(S(387));if(i=i.memoizedProps,i!==null){var c=n.type;Bt(n.pendingProps.value,i.value)||(t!==null?t.push(c):t=[c])}}else if(n===au.current){if(i=n.alternate,i===null)throw Error(S(387));i.memoizedState.memoizedState!==n.memoizedState.memoizedState&&(t!==null?t.push(an):t=[an])}n=n.return}t!==null&&rc(l,t,e,a),l.flags|=262144}function ou(t){for(t=t.firstContext;t!==null;){if(!Bt(t.context._currentValue,t.memoizedValue))return!0;t=t.next}return!1}function ve(t){ze=t,pl=null,t=t.dependencies,t!==null&&(t.firstContext=null)}function vt(t){return Uo(ze,t)}function Un(t,l){return ze===null&&ve(t),Uo(t,l)}function Uo(t,l){var e=l._currentValue;if(l={context:l,memoizedValue:e,next:null},pl===null){if(t===null)throw Error(S(308));pl=l,t.dependencies={lanes:0,firstContext:l},t.flags|=524288}else pl=pl.next=l;return e}var q1=typeof AbortController<"u"?AbortController:function(){var t=[],l=this.signal={aborted:!1,addEventListener:function(e,a){t.push(a)}};this.abort=function(){l.aborted=!0,t.forEach(function(e){return e()})}},B1=ct.unstable_scheduleCallback,Y1=ct.unstable_NormalPriority,nt={$$typeof:gl,Consumer:null,Provider:null,_currentValue:null,_currentValue2:null,_threadCount:0};function uf(){return{controller:new q1,data:new Map,refCount:0}}function rn(t){t.refCount--,t.refCount===0&&B1(Y1,function(){t.controller.abort()})}var qa=null,yc=0,la=0,Je=null;function X1(t,l){if(qa===null){var e=qa=[];yc=0,la=xf(),Je={status:"pending",value:void 0,then:function(a){e.push(a)}}}return yc++,l.then(jd,jd),l}function jd(){if(--yc===0&&qa!==null){Je!==null&&(Je.status="fulfilled");var t=qa;qa=null,la=0,Je=null;for(var l=0;l<t.length;l++)(0,t[l])()}}function G1(t,l){var e=[],a={status:"pending",value:null,reason:null,then:function(n){e.push(n)}};return t.then(function(){a.status="fulfilled",a.value=l;for(var n=0;n<e.length;n++)(0,e[n])(l)},function(n){for(a.status="rejected",a.reason=n,n=0;n<e.length;n++)(0,e[n])(void 0)}),a}var Qd=O.S;O.S=function(t,l){Km=Rt(),typeof l=="object"&&l!==null&&typeof l.then=="function"&&X1(t,l),Qd!==null&&Qd(t,l)};var oe=cl(null);function cf(){var t=oe.current;return t!==null?t:Q.pooledCache}function kn(t,l){l===null?Z(oe,oe.current):Z(oe,l.pool)}function Ro(){var t=cf();return t===null?null:{parent:nt._currentValue,pool:t}}var ma=Error(S(460)),ff=Error(S(474)),Yu=Error(S(542)),mu={then:function(){}};function wd(t){return t=t.status,t==="fulfilled"||t==="rejected"}function Ho(t,l,e){switch(e=t[e],e===void 0?t.push(l):e!==l&&(l.then(Sl,Sl),l=e),l.status){case"fulfilled":return l.value;case"rejected":throw t=l.reason,Vd(t),t;default:if(typeof l.status=="string")l.then(Sl,Sl);else{if(t=Q,t!==null&&100<t.shellSuspendCounter)throw Error(S(482));t=l,t.status="pending",t.then(function(a){if(l.status==="pending"){var n=l;n.status="fulfilled",n.value=a}},function(a){if(l.status==="pending"){var n=l;n.status="rejected",n.reason=a}})}switch(l.status){case"fulfilled":return l.value;case"rejected":throw t=l.reason,Vd(t),t}throw me=l,ma}}function ce(t){try{var l=t._init;return l(t._payload)}catch(e){throw e!==null&&typeof e=="object"&&typeof e.then=="function"?(me=e,ma):e}}var me=null;function Zd(){if(me===null)throw Error(S(459));var t=me;return me=null,t}function Vd(t){if(t===ma||t===Yu)throw Error(S(483))}var We=null,Ia=0;function Rn(t){var l=Ia;return Ia+=1,We===null&&(We=[]),Ho(We,t,l)}function za(t,l){l=l.props.ref,t.ref=l!==void 0?l:null}function Hn(t,l){throw l.$$typeof===Or?Error(S(525)):(t=Object.prototype.toString.call(l),Error(S(31,t==="[object Object]"?"object with keys {"+Object.keys(l).join(", ")+"}":t)))}function Co(t){function l(o,s){if(t){var m=o.deletions;m===null?(o.deletions=[s],o.flags|=16):m.push(s)}}function e(o,s){if(!t)return null;for(;s!==null;)l(o,s),s=s.sibling;return null}function a(o){for(var s=new Map;o!==null;)o.key!==null?s.set(o.key,o):s.set(o.index,o),o=o.sibling;return s}function n(o,s){return o=bl(o,s),o.index=0,o.sibling=null,o}function u(o,s,m){return o.index=m,t?(m=o.alternate,m!==null?(m=m.index,m<s?(o.flags|=67108866,s):m):(o.flags|=67108866,s)):(o.flags|=1048576,s)}function i(o){return t&&o.alternate===null&&(o.flags|=67108866),o}function c(o,s,m,h){return s===null||s.tag!==6?(s=_i(m,o.mode,h),s.return=o,s):(s=n(s,m),s.return=o,s)}function f(o,s,m,h){var T=m.type;return T===Re?v(o,s,m.props.children,h,m.key):s!==null&&(s.elementType===T||typeof T=="object"&&T!==null&&T.$$typeof===xl&&ce(T)===s.type)?(s=n(s,m.props),za(s,m),s.return=o,s):(s=Kn(m.type,m.key,m.props,null,o.mode,h),za(s,m),s.return=o,s)}function d(o,s,m,h){return s===null||s.tag!==4||s.stateNode.containerInfo!==m.containerInfo||s.stateNode.implementation!==m.implementation?(s=Oi(m,o.mode,h),s.return=o,s):(s=n(s,m.children||[]),s.return=o,s)}function v(o,s,m,h,T){return s===null||s.tag!==7?(s=se(m,o.mode,h,T),s.return=o,s):(s=n(s,m),s.return=o,s)}function g(o,s,m){if(typeof s=="string"&&s!==""||typeof s=="number"||typeof s=="bigint")return s=_i(""+s,o.mode,m),s.return=o,s;if(typeof s=="object"&&s!==null){switch(s.$$typeof){case An:return m=Kn(s.type,s.key,s.props,null,o.mode,m),za(m,s),m.return=o,m;case La:return s=Oi(s,o.mode,m),s.return=o,s;case xl:return s=ce(s),g(o,s,m)}if(Da(s)||Ea(s))return s=se(s,o.mode,m,null),s.return=o,s;if(typeof s.then=="function")return g(o,Rn(s),m);if(s.$$typeof===gl)return g(o,Un(o,s),m);Hn(o,s)}return null}function r(o,s,m,h){var T=s!==null?s.key:null;if(typeof m=="string"&&m!==""||typeof m=="number"||typeof m=="bigint")return T!==null?null:c(o,s,""+m,h);if(typeof m=="object"&&m!==null){switch(m.$$typeof){case An:return m.key===T?f(o,s,m,h):null;case La:return m.key===T?d(o,s,m,h):null;case xl:return m=ce(m),r(o,s,m,h)}if(Da(m)||Ea(m))return T!==null?null:v(o,s,m,h,null);if(typeof m.then=="function")return r(o,s,Rn(m),h);if(m.$$typeof===gl)return r(o,s,Un(o,m),h);Hn(o,m)}return null}function y(o,s,m,h,T){if(typeof h=="string"&&h!==""||typeof h=="number"||typeof h=="bigint")return o=o.get(m)||null,c(s,o,""+h,T);if(typeof h=="object"&&h!==null){switch(h.$$typeof){case An:return o=o.get(h.key===null?m:h.key)||null,f(s,o,h,T);case La:return o=o.get(h.key===null?m:h.key)||null,d(s,o,h,T);case xl:return h=ce(h),y(o,s,m,h,T)}if(Da(h)||Ea(h))return o=o.get(m)||null,v(s,o,h,T,null);if(typeof h.then=="function")return y(o,s,m,Rn(h),T);if(h.$$typeof===gl)return y(o,s,m,Un(s,h),T);Hn(s,h)}return null}function p(o,s,m,h){for(var T=null,E=null,b=s,_=s=0,D=null;b!==null&&_<m.length;_++){b.index>_?(D=b,b=null):D=b.sibling;var N=r(o,b,m[_],h);if(N===null){b===null&&(b=D);break}t&&b&&N.alternate===null&&l(o,b),s=u(N,s,_),E===null?T=N:E.sibling=N,E=N,b=D}if(_===m.length)return e(o,b),H&&vl(o,_),T;if(b===null){for(;_<m.length;_++)b=g(o,m[_],h),b!==null&&(s=u(b,s,_),E===null?T=b:E.sibling=b,E=b);return H&&vl(o,_),T}for(b=a(b);_<m.length;_++)D=y(b,o,_,m[_],h),D!==null&&(t&&D.alternate!==null&&b.delete(D.key===null?_:D.key),s=u(D,s,_),E===null?T=D:E.sibling=D,E=D);return t&&b.forEach(function(ft){return l(o,ft)}),H&&vl(o,_),T}function A(o,s,m,h){if(m==null)throw Error(S(151));for(var T=null,E=null,b=s,_=s=0,D=null,N=m.next();b!==null&&!N.done;_++,N=m.next()){b.index>_?(D=b,b=null):D=b.sibling;var ft=r(o,b,N.value,h);if(ft===null){b===null&&(b=D);break}t&&b&&ft.alternate===null&&l(o,b),s=u(ft,s,_),E===null?T=ft:E.sibling=ft,E=ft,b=D}if(N.done)return e(o,b),H&&vl(o,_),T;if(b===null){for(;!N.done;_++,N=m.next())N=g(o,N.value,h),N!==null&&(s=u(N,s,_),E===null?T=N:E.sibling=N,E=N);return H&&vl(o,_),T}for(b=a(b);!N.done;_++,N=m.next())N=y(b,o,_,N.value,h),N!==null&&(t&&N.alternate!==null&&b.delete(N.key===null?_:N.key),s=u(N,s,_),E===null?T=N:E.sibling=N,E=N);return t&&b.forEach(function($0){return l(o,$0)}),H&&vl(o,_),T}function C(o,s,m,h){if(typeof m=="object"&&m!==null&&m.type===Re&&m.key===null&&(m=m.props.children),typeof m=="object"&&m!==null){switch(m.$$typeof){case An:t:{for(var T=m.key;s!==null;){if(s.key===T){if(T=m.type,T===Re){if(s.tag===7){e(o,s.sibling),h=n(s,m.props.children),h.return=o,o=h;break t}}else if(s.elementType===T||typeof T=="object"&&T!==null&&T.$$typeof===xl&&ce(T)===s.type){e(o,s.sibling),h=n(s,m.props),za(h,m),h.return=o,o=h;break t}e(o,s);break}else l(o,s);s=s.sibling}m.type===Re?(h=se(m.props.children,o.mode,h,m.key),h.return=o,o=h):(h=Kn(m.type,m.key,m.props,null,o.mode,h),za(h,m),h.return=o,o=h)}return i(o);case La:t:{for(T=m.key;s!==null;){if(s.key===T)if(s.tag===4&&s.stateNode.containerInfo===m.containerInfo&&s.stateNode.implementation===m.implementation){e(o,s.sibling),h=n(s,m.children||[]),h.return=o,o=h;break t}else{e(o,s);break}else l(o,s);s=s.sibling}h=Oi(m,o.mode,h),h.return=o,o=h}return i(o);case xl:return m=ce(m),C(o,s,m,h)}if(Da(m))return p(o,s,m,h);if(Ea(m)){if(T=Ea(m),typeof T!="function")throw Error(S(150));return m=T.call(m),A(o,s,m,h)}if(typeof m.then=="function")return C(o,s,Rn(m),h);if(m.$$typeof===gl)return C(o,s,Un(o,m),h);Hn(o,m)}return typeof m=="string"&&m!==""||typeof m=="number"||typeof m=="bigint"?(m=""+m,s!==null&&s.tag===6?(e(o,s.sibling),h=n(s,m),h.return=o,o=h):(e(o,s),h=_i(m,o.mode,h),h.return=o,o=h),i(o)):e(o,s)}return function(o,s,m,h){try{Ia=0;var T=C(o,s,m,h);return We=null,T}catch(b){if(b===ma||b===Yu)throw b;var E=xt(29,b,null,o.mode);return E.lanes=h,E.return=o,E}}}var he=Co(!0),qo=Co(!1),Ul=!1;function df(t){t.updateQueue={baseState:t.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,lanes:0,hiddenCallbacks:null},callbacks:null}}function vc(t,l){t=t.updateQueue,l.updateQueue===t&&(l.updateQueue={baseState:t.baseState,firstBaseUpdate:t.firstBaseUpdate,lastBaseUpdate:t.lastBaseUpdate,shared:t.shared,callbacks:null})}function Zl(t){return{lane:t,tag:0,payload:null,callback:null,next:null}}function Vl(t,l,e){var a=t.updateQueue;if(a===null)return null;if(a=a.shared,(q&2)!==0){var n=a.pending;return n===null?l.next=l:(l.next=n.next,n.next=l),a.pending=l,l=du(t),Mo(t,null,e),l}return Bu(t,a,l,e),du(t)}function Ba(t,l,e){if(l=l.updateQueue,l!==null&&(l=l.shared,(e&4194048)!==0)){var a=l.lanes;a&=t.pendingLanes,e|=a,l.lanes=e,Ps(t,e)}}function Li(t,l){var e=t.updateQueue,a=t.alternate;if(a!==null&&(a=a.updateQueue,e===a)){var n=null,u=null;if(e=e.firstBaseUpdate,e!==null){do{var i={lane:e.lane,tag:e.tag,payload:e.payload,callback:null,next:null};u===null?n=u=i:u=u.next=i,e=e.next}while(e!==null);u===null?n=u=l:u=u.next=l}else n=u=l;e={baseState:a.baseState,firstBaseUpdate:n,lastBaseUpdate:u,shared:a.shared,callbacks:a.callbacks},t.updateQueue=e;return}t=e.lastBaseUpdate,t===null?e.firstBaseUpdate=l:t.next=l,e.lastBaseUpdate=l}var hc=!1;function Ya(){if(hc){var t=Je;if(t!==null)throw t}}function Xa(t,l,e,a){hc=!1;var n=t.updateQueue;Ul=!1;var u=n.firstBaseUpdate,i=n.lastBaseUpdate,c=n.shared.pending;if(c!==null){n.shared.pending=null;var f=c,d=f.next;f.next=null,i===null?u=d:i.next=d,i=f;var v=t.alternate;v!==null&&(v=v.updateQueue,c=v.lastBaseUpdate,c!==i&&(c===null?v.firstBaseUpdate=d:c.next=d,v.lastBaseUpdate=f))}if(u!==null){var g=n.baseState;i=0,v=d=f=null,c=u;do{var r=c.lane&-536870913,y=r!==c.lane;if(y?(R&r)===r:(a&r)===r){r!==0&&r===la&&(hc=!0),v!==null&&(v=v.next={lane:0,tag:c.tag,payload:c.payload,callback:null,next:null});t:{var p=t,A=c;r=l;var C=e;switch(A.tag){case 1:if(p=A.payload,typeof p=="function"){g=p.call(C,g,r);break t}g=p;break t;case 3:p.flags=p.flags&-65537|128;case 0:if(p=A.payload,r=typeof p=="function"?p.call(C,g,r):p,r==null)break t;g=J({},g,r);break t;case 2:Ul=!0}}r=c.callback,r!==null&&(t.flags|=64,y&&(t.flags|=8192),y=n.callbacks,y===null?n.callbacks=[r]:y.push(r))}else y={lane:r,tag:c.tag,payload:c.payload,callback:c.callback,next:null},v===null?(d=v=y,f=g):v=v.next=y,i|=r;if(c=c.next,c===null){if(c=n.shared.pending,c===null)break;y=c,c=y.next,y.next=null,n.lastBaseUpdate=y,n.shared.pending=null}}while(!0);v===null&&(f=g),n.baseState=f,n.firstBaseUpdate=d,n.lastBaseUpdate=v,u===null&&(n.shared.lanes=0),te|=i,t.lanes=i,t.memoizedState=g}}function Bo(t,l){if(typeof t!="function")throw Error(S(191,t));t.call(l)}function Yo(t,l){var e=t.callbacks;if(e!==null)for(t.callbacks=null,t=0;t<e.length;t++)Bo(e[t],l)}var ea=cl(null),ru=cl(0);function Kd(t,l){t=Ml,Z(ru,t),Z(ea,l),Ml=t|l.baseLanes}function gc(){Z(ru,Ml),Z(ea,ea.current)}function sf(){Ml=ru.current,ot(ea),ot(ru)}var Yt=cl(null),kt=null;function Hl(t){var l=t.alternate;Z(tt,tt.current&1),Z(Yt,t),kt===null&&(l===null||ea.current!==null||l.memoizedState!==null)&&(kt=t)}function Sc(t){Z(tt,tt.current),Z(Yt,t),kt===null&&(kt=t)}function Xo(t){t.tag===22?(Z(tt,tt.current),Z(Yt,t),kt===null&&(kt=t)):Cl(t)}function Cl(){Z(tt,tt.current),Z(Yt,Yt.current)}function Nt(t){ot(Yt),kt===t&&(kt=null),ot(tt)}var tt=cl(0);function yu(t){for(var l=t;l!==null;){if(l.tag===13){var e=l.memoizedState;if(e!==null&&(e=e.dehydrated,e===null||Bc(e)||Yc(e)))return l}else if(l.tag===19&&(l.memoizedProps.revealOrder==="forwards"||l.memoizedProps.revealOrder==="backwards"||l.memoizedProps.revealOrder==="unstable_legacy-backwards"||l.memoizedProps.revealOrder==="together")){if((l.flags&128)!==0)return l}else if(l.child!==null){l.child.return=l,l=l.child;continue}if(l===t)break;for(;l.sibling===null;){if(l.return===null||l.return===t)return null;l=l.return}l.sibling.return=l.return,l=l.sibling}return null}var Al=0,L=null,j=null,et=null,vu=!1,$e=!1,ge=!1,hu=0,Pa=0,Fe=null,j1=0;function F(){throw Error(S(321))}function of(t,l){if(l===null)return!1;for(var e=0;e<l.length&&e<t.length;e++)if(!Bt(t[e],l[e]))return!1;return!0}function mf(t,l,e,a,n,u){return Al=u,L=l,l.memoizedState=null,l.updateQueue=null,l.lanes=0,O.H=t===null||t.memoizedState===null?hm:zf,ge=!1,u=e(a,n),ge=!1,$e&&(u=jo(l,e,a,n)),Go(t),u}function Go(t){O.H=tn;var l=j!==null&&j.next!==null;if(Al=0,et=j=L=null,vu=!1,Pa=0,Fe=null,l)throw Error(S(300));t===null||ut||(t=t.dependencies,t!==null&&ou(t)&&(ut=!0))}function jo(t,l,e,a){L=t;var n=0;do{if($e&&(Fe=null),Pa=0,$e=!1,25<=n)throw Error(S(301));if(n+=1,et=j=null,t.updateQueue!=null){var u=t.updateQueue;u.lastEffect=null,u.events=null,u.stores=null,u.memoCache!=null&&(u.memoCache.index=0)}O.H=gm,u=l(e,a)}while($e);return u}function Q1(){var t=O.H,l=t.useState()[0];return l=typeof l.then=="function"?yn(l):l,t=t.useState()[0],(j!==null?j.memoizedState:null)!==t&&(L.flags|=1024),l}function rf(){var t=hu!==0;return hu=0,t}function yf(t,l,e){l.updateQueue=t.updateQueue,l.flags&=-2053,t.lanes&=~e}function vf(t){if(vu){for(t=t.memoizedState;t!==null;){var l=t.queue;l!==null&&(l.pending=null),t=t.next}vu=!1}Al=0,et=j=L=null,$e=!1,Pa=hu=0,Fe=null}function bt(){var t={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return et===null?L.memoizedState=et=t:et=et.next=t,et}function lt(){if(j===null){var t=L.alternate;t=t!==null?t.memoizedState:null}else t=j.next;var l=et===null?L.memoizedState:et.next;if(l!==null)et=l,j=t;else{if(t===null)throw L.alternate===null?Error(S(467)):Error(S(310));j=t,t={memoizedState:j.memoizedState,baseState:j.baseState,baseQueue:j.baseQueue,queue:j.queue,next:null},et===null?L.memoizedState=et=t:et=et.next=t}return et}function Xu(){return{lastEffect:null,events:null,stores:null,memoCache:null}}function yn(t){var l=Pa;return Pa+=1,Fe===null&&(Fe=[]),t=Ho(Fe,t,l),l=L,(et===null?l.memoizedState:et.next)===null&&(l=l.alternate,O.H=l===null||l.memoizedState===null?hm:zf),t}function Gu(t){if(t!==null&&typeof t=="object"){if(typeof t.then=="function")return yn(t);if(t.$$typeof===gl)return vt(t)}throw Error(S(438,String(t)))}function hf(t){var l=null,e=L.updateQueue;if(e!==null&&(l=e.memoCache),l==null){var a=L.alternate;a!==null&&(a=a.updateQueue,a!==null&&(a=a.memoCache,a!=null&&(l={data:a.data.map(function(n){return n.slice()}),index:0})))}if(l==null&&(l={data:[],index:0}),e===null&&(e=Xu(),L.updateQueue=e),e.memoCache=l,e=l.data[l.index],e===void 0)for(e=l.data[l.index]=Array(t),a=0;a<t;a++)e[a]=Mr;return l.index++,e}function _l(t,l){return typeof l=="function"?l(t):l}function Jn(t){var l=lt();return gf(l,j,t)}function gf(t,l,e){var a=t.queue;if(a===null)throw Error(S(311));a.lastRenderedReducer=e;var n=t.baseQueue,u=a.pending;if(u!==null){if(n!==null){var i=n.next;n.next=u.next,u.next=i}l.baseQueue=n=u,a.pending=null}if(u=t.baseState,n===null)t.memoizedState=u;else{l=n.next;var c=i=null,f=null,d=l,v=!1;do{var g=d.lane&-536870913;if(g!==d.lane?(R&g)===g:(Al&g)===g){var r=d.revertLane;if(r===0)f!==null&&(f=f.next={lane:0,revertLane:0,gesture:null,action:d.action,hasEagerState:d.hasEagerState,eagerState:d.eagerState,next:null}),g===la&&(v=!0);else if((Al&r)===r){d=d.next,r===la&&(v=!0);continue}else g={lane:0,revertLane:d.revertLane,gesture:null,action:d.action,hasEagerState:d.hasEagerState,eagerState:d.eagerState,next:null},f===null?(c=f=g,i=u):f=f.next=g,L.lanes|=r,te|=r;g=d.action,ge&&e(u,g),u=d.hasEagerState?d.eagerState:e(u,g)}else r={lane:g,revertLane:d.revertLane,gesture:d.gesture,action:d.action,hasEagerState:d.hasEagerState,eagerState:d.eagerState,next:null},f===null?(c=f=r,i=u):f=f.next=r,L.lanes|=g,te|=g;d=d.next}while(d!==null&&d!==l);if(f===null?i=u:f.next=c,!Bt(u,t.memoizedState)&&(ut=!0,v&&(e=Je,e!==null)))throw e;t.memoizedState=u,t.baseState=i,t.baseQueue=f,a.lastRenderedState=u}return n===null&&(a.lanes=0),[t.memoizedState,a.dispatch]}function Di(t){var l=lt(),e=l.queue;if(e===null)throw Error(S(311));e.lastRenderedReducer=t;var a=e.dispatch,n=e.pending,u=l.memoizedState;if(n!==null){e.pending=null;var i=n=n.next;do u=t(u,i.action),i=i.next;while(i!==n);Bt(u,l.memoizedState)||(ut=!0),l.memoizedState=u,l.baseQueue===null&&(l.baseState=u),e.lastRenderedState=u}return[u,a]}function Qo(t,l,e){var a=L,n=lt(),u=H;if(u){if(e===void 0)throw Error(S(407));e=e()}else e=l();var i=!Bt((j||n).memoizedState,e);if(i&&(n.memoizedState=e,ut=!0),n=n.queue,Sf(Vo.bind(null,a,n,t),[t]),n.getSnapshot!==l||i||et!==null&&et.memoizedState.tag&1){if(a.flags|=2048,aa(9,{destroy:void 0},Zo.bind(null,a,n,e,l),null),Q===null)throw Error(S(349));u||(Al&127)!==0||wo(a,l,e)}return e}function wo(t,l,e){t.flags|=16384,t={getSnapshot:l,value:e},l=L.updateQueue,l===null?(l=Xu(),L.updateQueue=l,l.stores=[t]):(e=l.stores,e===null?l.stores=[t]:e.push(t))}function Zo(t,l,e,a){l.value=e,l.getSnapshot=a,Ko(l)&&ko(t)}function Vo(t,l,e){return e(function(){Ko(l)&&ko(t)})}function Ko(t){var l=t.getSnapshot;t=t.value;try{var e=l();return!Bt(t,e)}catch{return!0}}function ko(t){var l=Te(t,2);l!==null&&_t(l,t,2)}function pc(t){var l=bt();if(typeof t=="function"){var e=t;if(t=e(),ge){Bl(!0);try{e()}finally{Bl(!1)}}}return l.memoizedState=l.baseState=t,l.queue={pending:null,lanes:0,dispatch:null,lastRenderedReducer:_l,lastRenderedState:t},l}function Jo(t,l,e,a){return t.baseState=e,gf(t,j,typeof a=="function"?a:_l)}function w1(t,l,e,a,n){if(Qu(t))throw Error(S(485));if(t=l.action,t!==null){var u={payload:n,action:t,next:null,isTransition:!0,status:"pending",value:null,reason:null,listeners:[],then:function(i){u.listeners.push(i)}};O.T!==null?e(!0):u.isTransition=!1,a(u),e=l.pending,e===null?(u.next=l.pending=u,Wo(l,u)):(u.next=e.next,l.pending=e.next=u)}}function Wo(t,l){var e=l.action,a=l.payload,n=t.state;if(l.isTransition){var u=O.T,i={};O.T=i;try{var c=e(n,a),f=O.S;f!==null&&f(i,c),kd(t,l,c)}catch(d){bc(t,l,d)}finally{u!==null&&i.types!==null&&(u.types=i.types),O.T=u}}else try{u=e(n,a),kd(t,l,u)}catch(d){bc(t,l,d)}}function kd(t,l,e){e!==null&&typeof e=="object"&&typeof e.then=="function"?e.then(function(a){Jd(t,l,a)},function(a){return bc(t,l,a)}):Jd(t,l,e)}function Jd(t,l,e){l.status="fulfilled",l.value=e,$o(l),t.state=e,l=t.pending,l!==null&&(e=l.next,e===l?t.pending=null:(e=e.next,l.next=e,Wo(t,e)))}function bc(t,l,e){var a=t.pending;if(t.pending=null,a!==null){a=a.next;do l.status="rejected",l.reason=e,$o(l),l=l.next;while(l!==a)}t.action=null}function $o(t){t=t.listeners;for(var l=0;l<t.length;l++)(0,t[l])()}function Fo(t,l){return l}function Wd(t,l){if(H){var e=Q.formState;if(e!==null){t:{var a=L;if(H){if(k){l:{for(var n=k,u=Kt;n.nodeType!==8;){if(!u){n=null;break l}if(n=Jt(n.nextSibling),n===null){n=null;break l}}u=n.data,n=u==="F!"||u==="F"?n:null}if(n){k=Jt(n.nextSibling),a=n.data==="F!";break t}}Il(a)}a=!1}a&&(l=e[0])}}return e=bt(),e.memoizedState=e.baseState=l,a={pending:null,lanes:0,dispatch:null,lastRenderedReducer:Fo,lastRenderedState:l},e.queue=a,e=rm.bind(null,L,a),a.dispatch=e,a=pc(!1),u=Tf.bind(null,L,!1,a.queue),a=bt(),n={state:l,dispatch:null,action:t,pending:null},a.queue=n,e=w1.bind(null,L,n,u,e),n.dispatch=e,a.memoizedState=t,[l,e,!1]}function $d(t){var l=lt();return Io(l,j,t)}function Io(t,l,e){if(l=gf(t,l,Fo)[0],t=Jn(_l)[0],typeof l=="object"&&l!==null&&typeof l.then=="function")try{var a=yn(l)}catch(i){throw i===ma?Yu:i}else a=l;l=lt();var n=l.queue,u=n.dispatch;return e!==l.memoizedState&&(L.flags|=2048,aa(9,{destroy:void 0},Z1.bind(null,n,e),null)),[a,u,t]}function Z1(t,l){t.action=l}function Fd(t){var l=lt(),e=j;if(e!==null)return Io(l,e,t);lt(),l=l.memoizedState,e=lt();var a=e.queue.dispatch;return e.memoizedState=t,[l,a,!1]}function aa(t,l,e,a){return t={tag:t,create:e,deps:a,inst:l,next:null},l=L.updateQueue,l===null&&(l=Xu(),L.updateQueue=l),e=l.lastEffect,e===null?l.lastEffect=t.next=t:(a=e.next,e.next=t,t.next=a,l.lastEffect=t),t}function Po(){return lt().memoizedState}function Wn(t,l,e,a){var n=bt();L.flags|=t,n.memoizedState=aa(1|l,{destroy:void 0},e,a===void 0?null:a)}function ju(t,l,e,a){var n=lt();a=a===void 0?null:a;var u=n.memoizedState.inst;j!==null&&a!==null&&of(a,j.memoizedState.deps)?n.memoizedState=aa(l,u,e,a):(L.flags|=t,n.memoizedState=aa(1|l,u,e,a))}function Id(t,l){Wn(8390656,8,t,l)}function Sf(t,l){ju(2048,8,t,l)}function V1(t){L.flags|=4;var l=L.updateQueue;if(l===null)l=Xu(),L.updateQueue=l,l.events=[t];else{var e=l.events;e===null?l.events=[t]:e.push(t)}}function tm(t){var l=lt().memoizedState;return V1({ref:l,nextImpl:t}),function(){if((q&2)!==0)throw Error(S(440));return l.impl.apply(void 0,arguments)}}function lm(t,l){return ju(4,2,t,l)}function em(t,l){return ju(4,4,t,l)}function am(t,l){if(typeof l=="function"){t=t();var e=l(t);return function(){typeof e=="function"?e():l(null)}}if(l!=null)return t=t(),l.current=t,function(){l.current=null}}function nm(t,l,e){e=e!=null?e.concat([t]):null,ju(4,4,am.bind(null,l,t),e)}function pf(){}function um(t,l){var e=lt();l=l===void 0?null:l;var a=e.memoizedState;return l!==null&&of(l,a[1])?a[0]:(e.memoizedState=[t,l],t)}function im(t,l){var e=lt();l=l===void 0?null:l;var a=e.memoizedState;if(l!==null&&of(l,a[1]))return a[0];if(a=t(),ge){Bl(!0);try{t()}finally{Bl(!1)}}return e.memoizedState=[a,l],a}function bf(t,l,e){return e===void 0||(Al&1073741824)!==0&&(R&261930)===0?t.memoizedState=l:(t.memoizedState=e,t=Jm(),L.lanes|=t,te|=t,e)}function cm(t,l,e,a){return Bt(e,l)?e:ea.current!==null?(t=bf(t,e,a),Bt(t,l)||(ut=!0),t):(Al&42)===0||(Al&1073741824)!==0&&(R&261930)===0?(ut=!0,t.memoizedState=e):(t=Jm(),L.lanes|=t,te|=t,l)}function fm(t,l,e,a,n){var u=B.p;B.p=u!==0&&8>u?u:8;var i=O.T,c={};O.T=c,Tf(t,!1,l,e);try{var f=n(),d=O.S;if(d!==null&&d(c,f),f!==null&&typeof f=="object"&&typeof f.then=="function"){var v=G1(f,a);Ga(t,l,v,qt(t))}else Ga(t,l,a,qt(t))}catch(g){Ga(t,l,{then:function(){},status:"rejected",reason:g},qt())}finally{B.p=u,i!==null&&c.types!==null&&(i.types=c.types),O.T=i}}function K1(){}function Ec(t,l,e,a){if(t.tag!==5)throw Error(S(476));var n=dm(t).queue;fm(t,n,l,de,e===null?K1:function(){return sm(t),e(a)})}function dm(t){var l=t.memoizedState;if(l!==null)return l;l={memoizedState:de,baseState:de,baseQueue:null,queue:{pending:null,lanes:0,dispatch:null,lastRenderedReducer:_l,lastRenderedState:de},next:null};var e={};return l.next={memoizedState:e,baseState:e,baseQueue:null,queue:{pending:null,lanes:0,dispatch:null,lastRenderedReducer:_l,lastRenderedState:e},next:null},t.memoizedState=l,t=t.alternate,t!==null&&(t.memoizedState=l),l}function sm(t){var l=dm(t);l.next===null&&(l=t.alternate.memoizedState),Ga(t,l.next.queue,{},qt())}function Ef(){return vt(an)}function om(){return lt().memoizedState}function mm(){return lt().memoizedState}function k1(t){for(var l=t.return;l!==null;){switch(l.tag){case 24:case 3:var e=qt();t=Zl(e);var a=Vl(l,t,e);a!==null&&(_t(a,l,e),Ba(a,l,e)),l={cache:uf()},t.payload=l;return}l=l.return}}function J1(t,l,e){var a=qt();e={lane:a,revertLane:0,gesture:null,action:e,hasEagerState:!1,eagerState:null,next:null},Qu(t)?ym(l,e):(e=lf(t,l,e,a),e!==null&&(_t(e,t,a),vm(e,l,a)))}function rm(t,l,e){var a=qt();Ga(t,l,e,a)}function Ga(t,l,e,a){var n={lane:a,revertLane:0,gesture:null,action:e,hasEagerState:!1,eagerState:null,next:null};if(Qu(t))ym(l,n);else{var u=t.alternate;if(t.lanes===0&&(u===null||u.lanes===0)&&(u=l.lastRenderedReducer,u!==null))try{var i=l.lastRenderedState,c=u(i,e);if(n.hasEagerState=!0,n.eagerState=c,Bt(c,i))return Bu(t,l,n,0),Q===null&&qu(),!1}catch{}if(e=lf(t,l,n,a),e!==null)return _t(e,t,a),vm(e,l,a),!0}return!1}function Tf(t,l,e,a){if(a={lane:2,revertLane:xf(),gesture:null,action:a,hasEagerState:!1,eagerState:null,next:null},Qu(t)){if(l)throw Error(S(479))}else l=lf(t,e,a,2),l!==null&&_t(l,t,2)}function Qu(t){var l=t.alternate;return t===L||l!==null&&l===L}function ym(t,l){$e=vu=!0;var e=t.pending;e===null?l.next=l:(l.next=e.next,e.next=l),t.pending=l}function vm(t,l,e){if((e&4194048)!==0){var a=l.lanes;a&=t.pendingLanes,e|=a,l.lanes=e,Ps(t,e)}}var tn={readContext:vt,use:Gu,useCallback:F,useContext:F,useEffect:F,useImperativeHandle:F,useLayoutEffect:F,useInsertionEffect:F,useMemo:F,useReducer:F,useRef:F,useState:F,useDebugValue:F,useDeferredValue:F,useTransition:F,useSyncExternalStore:F,useId:F,useHostTransitionStatus:F,useFormState:F,useActionState:F,useOptimistic:F,useMemoCache:F,useCacheRefresh:F};tn.useEffectEvent=F;var hm={readContext:vt,use:Gu,useCallback:function(t,l){return bt().memoizedState=[t,l===void 0?null:l],t},useContext:vt,useEffect:Id,useImperativeHandle:function(t,l,e){e=e!=null?e.concat([t]):null,Wn(4194308,4,am.bind(null,l,t),e)},useLayoutEffect:function(t,l){return Wn(4194308,4,t,l)},useInsertionEffect:function(t,l){Wn(4,2,t,l)},useMemo:function(t,l){var e=bt();l=l===void 0?null:l;var a=t();if(ge){Bl(!0);try{t()}finally{Bl(!1)}}return e.memoizedState=[a,l],a},useReducer:function(t,l,e){var a=bt();if(e!==void 0){var n=e(l);if(ge){Bl(!0);try{e(l)}finally{Bl(!1)}}}else n=l;return a.memoizedState=a.baseState=n,t={pending:null,lanes:0,dispatch:null,lastRenderedReducer:t,lastRenderedState:n},a.queue=t,t=t.dispatch=J1.bind(null,L,t),[a.memoizedState,t]},useRef:function(t){var l=bt();return t={current:t},l.memoizedState=t},useState:function(t){t=pc(t);var l=t.queue,e=rm.bind(null,L,l);return l.dispatch=e,[t.memoizedState,e]},useDebugValue:pf,useDeferredValue:function(t,l){var e=bt();return bf(e,t,l)},useTransition:function(){var t=pc(!1);return t=fm.bind(null,L,t.queue,!0,!1),bt().memoizedState=t,[!1,t]},useSyncExternalStore:function(t,l,e){var a=L,n=bt();if(H){if(e===void 0)throw Error(S(407));e=e()}else{if(e=l(),Q===null)throw Error(S(349));(R&127)!==0||wo(a,l,e)}n.memoizedState=e;var u={value:e,getSnapshot:l};return n.queue=u,Id(Vo.bind(null,a,u,t),[t]),a.flags|=2048,aa(9,{destroy:void 0},Zo.bind(null,a,u,e,l),null),e},useId:function(){var t=bt(),l=Q.identifierPrefix;if(H){var e=nl,a=al;e=(a&~(1<<32-Ct(a)-1)).toString(32)+e,l="_"+l+"R_"+e,e=hu++,0<e&&(l+="H"+e.toString(32)),l+="_"}else e=j1++,l="_"+l+"r_"+e.toString(32)+"_";return t.memoizedState=l},useHostTransitionStatus:Ef,useFormState:Wd,useActionState:Wd,useOptimistic:function(t){var l=bt();l.memoizedState=l.baseState=t;var e={pending:null,lanes:0,dispatch:null,lastRenderedReducer:null,lastRenderedState:null};return l.queue=e,l=Tf.bind(null,L,!0,e),e.dispatch=l,[t,l]},useMemoCache:hf,useCacheRefresh:function(){return bt().memoizedState=k1.bind(null,L)},useEffectEvent:function(t){var l=bt(),e={impl:t};return l.memoizedState=e,function(){if((q&2)!==0)throw Error(S(440));return e.impl.apply(void 0,arguments)}}},zf={readContext:vt,use:Gu,useCallback:um,useContext:vt,useEffect:Sf,useImperativeHandle:nm,useInsertionEffect:lm,useLayoutEffect:em,useMemo:im,useReducer:Jn,useRef:Po,useState:function(){return Jn(_l)},useDebugValue:pf,useDeferredValue:function(t,l){var e=lt();return cm(e,j.memoizedState,t,l)},useTransition:function(){var t=Jn(_l)[0],l=lt().memoizedState;return[typeof t=="boolean"?t:yn(t),l]},useSyncExternalStore:Qo,useId:om,useHostTransitionStatus:Ef,useFormState:$d,useActionState:$d,useOptimistic:function(t,l){var e=lt();return Jo(e,j,t,l)},useMemoCache:hf,useCacheRefresh:mm};zf.useEffectEvent=tm;var gm={readContext:vt,use:Gu,useCallback:um,useContext:vt,useEffect:Sf,useImperativeHandle:nm,useInsertionEffect:lm,useLayoutEffect:em,useMemo:im,useReducer:Di,useRef:Po,useState:function(){return Di(_l)},useDebugValue:pf,useDeferredValue:function(t,l){var e=lt();return j===null?bf(e,t,l):cm(e,j.memoizedState,t,l)},useTransition:function(){var t=Di(_l)[0],l=lt().memoizedState;return[typeof t=="boolean"?t:yn(t),l]},useSyncExternalStore:Qo,useId:om,useHostTransitionStatus:Ef,useFormState:Fd,useActionState:Fd,useOptimistic:function(t,l){var e=lt();return j!==null?Jo(e,j,t,l):(e.baseState=t,[t,e.queue.dispatch])},useMemoCache:hf,useCacheRefresh:mm};gm.useEffectEvent=tm;function Ni(t,l,e,a){l=t.memoizedState,e=e(a,l),e=e==null?l:J({},l,e),t.memoizedState=e,t.lanes===0&&(t.updateQueue.baseState=e)}var Tc={enqueueSetState:function(t,l,e){t=t._reactInternals;var a=qt(),n=Zl(a);n.payload=l,e!=null&&(n.callback=e),l=Vl(t,n,a),l!==null&&(_t(l,t,a),Ba(l,t,a))},enqueueReplaceState:function(t,l,e){t=t._reactInternals;var a=qt(),n=Zl(a);n.tag=1,n.payload=l,e!=null&&(n.callback=e),l=Vl(t,n,a),l!==null&&(_t(l,t,a),Ba(l,t,a))},enqueueForceUpdate:function(t,l){t=t._reactInternals;var e=qt(),a=Zl(e);a.tag=2,l!=null&&(a.callback=l),l=Vl(t,a,e),l!==null&&(_t(l,t,e),Ba(l,t,e))}};function Pd(t,l,e,a,n,u,i){return t=t.stateNode,typeof t.shouldComponentUpdate=="function"?t.shouldComponentUpdate(a,u,i):l.prototype&&l.prototype.isPureReactComponent?!Wa(e,a)||!Wa(n,u):!0}function ts(t,l,e,a){t=l.state,typeof l.componentWillReceiveProps=="function"&&l.componentWillReceiveProps(e,a),typeof l.UNSAFE_componentWillReceiveProps=="function"&&l.UNSAFE_componentWillReceiveProps(e,a),l.state!==t&&Tc.enqueueReplaceState(l,l.state,null)}function Se(t,l){var e=l;if("ref"in l){e={};for(var a in l)a!=="ref"&&(e[a]=l[a])}if(t=t.defaultProps){e===l&&(e=J({},e));for(var n in t)e[n]===void 0&&(e[n]=t[n])}return e}function Sm(t){fu(t)}function pm(t){console.error(t)}function bm(t){fu(t)}function gu(t,l){try{var e=t.onUncaughtError;e(l.value,{componentStack:l.stack})}catch(a){setTimeout(function(){throw a})}}function ls(t,l,e){try{var a=t.onCaughtError;a(e.value,{componentStack:e.stack,errorBoundary:l.tag===1?l.stateNode:null})}catch(n){setTimeout(function(){throw n})}}function zc(t,l,e){return e=Zl(e),e.tag=3,e.payload={element:null},e.callback=function(){gu(t,l)},e}function Em(t){return t=Zl(t),t.tag=3,t}function Tm(t,l,e,a){var n=e.type.getDerivedStateFromError;if(typeof n=="function"){var u=a.value;t.payload=function(){return n(u)},t.callback=function(){ls(l,e,a)}}var i=e.stateNode;i!==null&&typeof i.componentDidCatch=="function"&&(t.callback=function(){ls(l,e,a),typeof n!="function"&&(Kl===null?Kl=new Set([this]):Kl.add(this));var c=a.stack;this.componentDidCatch(a.value,{componentStack:c!==null?c:""})})}function W1(t,l,e,a,n){if(e.flags|=32768,a!==null&&typeof a=="object"&&typeof a.then=="function"){if(l=e.alternate,l!==null&&oa(l,e,n,!0),e=Yt.current,e!==null){switch(e.tag){case 31:case 13:return kt===null?Tu():e.alternate===null&&I===0&&(I=3),e.flags&=-257,e.flags|=65536,e.lanes=n,a===mu?e.flags|=16384:(l=e.updateQueue,l===null?e.updateQueue=new Set([a]):l.add(a),ji(t,a,n)),!1;case 22:return e.flags|=65536,a===mu?e.flags|=16384:(l=e.updateQueue,l===null?(l={transitions:null,markerInstances:null,retryQueue:new Set([a])},e.updateQueue=l):(e=l.retryQueue,e===null?l.retryQueue=new Set([a]):e.add(a)),ji(t,a,n)),!1}throw Error(S(435,e.tag))}return ji(t,a,n),Tu(),!1}if(H)return l=Yt.current,l!==null?((l.flags&65536)===0&&(l.flags|=256),l.flags|=65536,l.lanes=n,a!==sc&&(t=Error(S(422),{cause:a}),Fa(Vt(t,e)))):(a!==sc&&(l=Error(S(423),{cause:a}),Fa(Vt(l,e))),t=t.current.alternate,t.flags|=65536,n&=-n,t.lanes|=n,a=Vt(a,e),n=zc(t.stateNode,a,n),Li(t,n),I!==4&&(I=2)),!1;var u=Error(S(520),{cause:a});if(u=Vt(u,e),wa===null?wa=[u]:wa.push(u),I!==4&&(I=2),l===null)return!0;a=Vt(a,e),e=l;do{switch(e.tag){case 3:return e.flags|=65536,t=n&-n,e.lanes|=t,t=zc(e.stateNode,a,t),Li(e,t),!1;case 1:if(l=e.type,u=e.stateNode,(e.flags&128)===0&&(typeof l.getDerivedStateFromError=="function"||u!==null&&typeof u.componentDidCatch=="function"&&(Kl===null||!Kl.has(u))))return e.flags|=65536,n&=-n,e.lanes|=n,n=Em(n),Tm(n,t,e,a),Li(e,n),!1}e=e.return}while(e!==null);return!1}var Af=Error(S(461)),ut=!1;function mt(t,l,e,a){l.child=t===null?qo(l,null,e,a):he(l,t.child,e,a)}function es(t,l,e,a,n){e=e.render;var u=l.ref;if("ref"in a){var i={};for(var c in a)c!=="ref"&&(i[c]=a[c])}else i=a;return ve(l),a=mf(t,l,e,i,u,n),c=rf(),t!==null&&!ut?(yf(t,l,n),Ol(t,l,n)):(H&&c&&af(l),l.flags|=1,mt(t,l,a,n),l.child)}function as(t,l,e,a,n){if(t===null){var u=e.type;return typeof u=="function"&&!ef(u)&&u.defaultProps===void 0&&e.compare===null?(l.tag=15,l.type=u,zm(t,l,u,a,n)):(t=Kn(e.type,null,a,l,l.mode,n),t.ref=l.ref,t.return=l,l.child=t)}if(u=t.child,!_f(t,n)){var i=u.memoizedProps;if(e=e.compare,e=e!==null?e:Wa,e(i,a)&&t.ref===l.ref)return Ol(t,l,n)}return l.flags|=1,t=bl(u,a),t.ref=l.ref,t.return=l,l.child=t}function zm(t,l,e,a,n){if(t!==null){var u=t.memoizedProps;if(Wa(u,a)&&t.ref===l.ref)if(ut=!1,l.pendingProps=a=u,_f(t,n))(t.flags&131072)!==0&&(ut=!0);else return l.lanes=t.lanes,Ol(t,l,n)}return Ac(t,l,e,a,n)}function Am(t,l,e,a){var n=a.children,u=t!==null?t.memoizedState:null;if(t===null&&l.stateNode===null&&(l.stateNode={_visibility:1,_pendingMarkers:null,_retryCache:null,_transitions:null}),a.mode==="hidden"){if((l.flags&128)!==0){if(u=u!==null?u.baseLanes|e:e,t!==null){for(a=l.child=t.child,n=0;a!==null;)n=n|a.lanes|a.childLanes,a=a.sibling;a=n&~u}else a=0,l.child=null;return ns(t,l,u,e,a)}if((e&536870912)!==0)l.memoizedState={baseLanes:0,cachePool:null},t!==null&&kn(l,u!==null?u.cachePool:null),u!==null?Kd(l,u):gc(),Xo(l);else return a=l.lanes=536870912,ns(t,l,u!==null?u.baseLanes|e:e,e,a)}else u!==null?(kn(l,u.cachePool),Kd(l,u),Cl(l),l.memoizedState=null):(t!==null&&kn(l,null),gc(),Cl(l));return mt(t,l,n,e),l.child}function xa(t,l){return t!==null&&t.tag===22||l.stateNode!==null||(l.stateNode={_visibility:1,_pendingMarkers:null,_retryCache:null,_transitions:null}),l.sibling}function ns(t,l,e,a,n){var u=cf();return u=u===null?null:{parent:nt._currentValue,pool:u},l.memoizedState={baseLanes:e,cachePool:u},t!==null&&kn(l,null),gc(),Xo(l),t!==null&&oa(t,l,a,!0),l.childLanes=n,null}function $n(t,l){return l=Su({mode:l.mode,children:l.children},t.mode),l.ref=t.ref,t.child=l,l.return=t,l}function us(t,l,e){return he(l,t.child,null,e),t=$n(l,l.pendingProps),t.flags|=2,Nt(l),l.memoizedState=null,t}function $1(t,l,e){var a=l.pendingProps,n=(l.flags&128)!==0;if(l.flags&=-129,t===null){if(H){if(a.mode==="hidden")return t=$n(l,a),l.lanes=536870912,xa(null,t);if(Sc(l),(t=k)?(t=h0(t,Kt),t=t!==null&&t.data==="&"?t:null,t!==null&&(l.memoizedState={dehydrated:t,treeContext:Fl!==null?{id:al,overflow:nl}:null,retryLane:536870912,hydrationErrors:null},e=Do(t),e.return=l,l.child=e,yt=l,k=null)):t=null,t===null)throw Il(l);return l.lanes=536870912,null}return $n(l,a)}var u=t.memoizedState;if(u!==null){var i=u.dehydrated;if(Sc(l),n)if(l.flags&256)l.flags&=-257,l=us(t,l,e);else if(l.memoizedState!==null)l.child=t.child,l.flags|=128,l=null;else throw Error(S(558));else if(ut||oa(t,l,e,!1),n=(e&t.childLanes)!==0,ut||n){if(a=Q,a!==null&&(i=to(a,e),i!==0&&i!==u.retryLane))throw u.retryLane=i,Te(t,i),_t(a,t,i),Af;Tu(),l=us(t,l,e)}else t=u.treeContext,k=Jt(i.nextSibling),yt=l,H=!0,wl=null,Kt=!1,t!==null&&xo(l,t),l=$n(l,a),l.flags|=4096;return l}return t=bl(t.child,{mode:a.mode,children:a.children}),t.ref=l.ref,l.child=t,t.return=l,t}function Fn(t,l){var e=l.ref;if(e===null)t!==null&&t.ref!==null&&(l.flags|=4194816);else{if(typeof e!="function"&&typeof e!="object")throw Error(S(284));(t===null||t.ref!==e)&&(l.flags|=4194816)}}function Ac(t,l,e,a,n){return ve(l),e=mf(t,l,e,a,void 0,n),a=rf(),t!==null&&!ut?(yf(t,l,n),Ol(t,l,n)):(H&&a&&af(l),l.flags|=1,mt(t,l,e,n),l.child)}function is(t,l,e,a,n,u){return ve(l),l.updateQueue=null,e=jo(l,a,e,n),Go(t),a=rf(),t!==null&&!ut?(yf(t,l,u),Ol(t,l,u)):(H&&a&&af(l),l.flags|=1,mt(t,l,e,u),l.child)}function cs(t,l,e,a,n){if(ve(l),l.stateNode===null){var u=je,i=e.contextType;typeof i=="object"&&i!==null&&(u=vt(i)),u=new e(a,u),l.memoizedState=u.state!==null&&u.state!==void 0?u.state:null,u.updater=Tc,l.stateNode=u,u._reactInternals=l,u=l.stateNode,u.props=a,u.state=l.memoizedState,u.refs={},df(l),i=e.contextType,u.context=typeof i=="object"&&i!==null?vt(i):je,u.state=l.memoizedState,i=e.getDerivedStateFromProps,typeof i=="function"&&(Ni(l,e,i,a),u.state=l.memoizedState),typeof e.getDerivedStateFromProps=="function"||typeof u.getSnapshotBeforeUpdate=="function"||typeof u.UNSAFE_componentWillMount!="function"&&typeof u.componentWillMount!="function"||(i=u.state,typeof u.componentWillMount=="function"&&u.componentWillMount(),typeof u.UNSAFE_componentWillMount=="function"&&u.UNSAFE_componentWillMount(),i!==u.state&&Tc.enqueueReplaceState(u,u.state,null),Xa(l,a,u,n),Ya(),u.state=l.memoizedState),typeof u.componentDidMount=="function"&&(l.flags|=4194308),a=!0}else if(t===null){u=l.stateNode;var c=l.memoizedProps,f=Se(e,c);u.props=f;var d=u.context,v=e.contextType;i=je,typeof v=="object"&&v!==null&&(i=vt(v));var g=e.getDerivedStateFromProps;v=typeof g=="function"||typeof u.getSnapshotBeforeUpdate=="function",c=l.pendingProps!==c,v||typeof u.UNSAFE_componentWillReceiveProps!="function"&&typeof u.componentWillReceiveProps!="function"||(c||d!==i)&&ts(l,u,a,i),Ul=!1;var r=l.memoizedState;u.state=r,Xa(l,a,u,n),Ya(),d=l.memoizedState,c||r!==d||Ul?(typeof g=="function"&&(Ni(l,e,g,a),d=l.memoizedState),(f=Ul||Pd(l,e,f,a,r,d,i))?(v||typeof u.UNSAFE_componentWillMount!="function"&&typeof u.componentWillMount!="function"||(typeof u.componentWillMount=="function"&&u.componentWillMount(),typeof u.UNSAFE_componentWillMount=="function"&&u.UNSAFE_componentWillMount()),typeof u.componentDidMount=="function"&&(l.flags|=4194308)):(typeof u.componentDidMount=="function"&&(l.flags|=4194308),l.memoizedProps=a,l.memoizedState=d),u.props=a,u.state=d,u.context=i,a=f):(typeof u.componentDidMount=="function"&&(l.flags|=4194308),a=!1)}else{u=l.stateNode,vc(t,l),i=l.memoizedProps,v=Se(e,i),u.props=v,g=l.pendingProps,r=u.context,d=e.contextType,f=je,typeof d=="object"&&d!==null&&(f=vt(d)),c=e.getDerivedStateFromProps,(d=typeof c=="function"||typeof u.getSnapshotBeforeUpdate=="function")||typeof u.UNSAFE_componentWillReceiveProps!="function"&&typeof u.componentWillReceiveProps!="function"||(i!==g||r!==f)&&ts(l,u,a,f),Ul=!1,r=l.memoizedState,u.state=r,Xa(l,a,u,n),Ya();var y=l.memoizedState;i!==g||r!==y||Ul||t!==null&&t.dependencies!==null&&ou(t.dependencies)?(typeof c=="function"&&(Ni(l,e,c,a),y=l.memoizedState),(v=Ul||Pd(l,e,v,a,r,y,f)||t!==null&&t.dependencies!==null&&ou(t.dependencies))?(d||typeof u.UNSAFE_componentWillUpdate!="function"&&typeof u.componentWillUpdate!="function"||(typeof u.componentWillUpdate=="function"&&u.componentWillUpdate(a,y,f),typeof u.UNSAFE_componentWillUpdate=="function"&&u.UNSAFE_componentWillUpdate(a,y,f)),typeof u.componentDidUpdate=="function"&&(l.flags|=4),typeof u.getSnapshotBeforeUpdate=="function"&&(l.flags|=1024)):(typeof u.componentDidUpdate!="function"||i===t.memoizedProps&&r===t.memoizedState||(l.flags|=4),typeof u.getSnapshotBeforeUpdate!="function"||i===t.memoizedProps&&r===t.memoizedState||(l.flags|=1024),l.memoizedProps=a,l.memoizedState=y),u.props=a,u.state=y,u.context=f,a=v):(typeof u.componentDidUpdate!="function"||i===t.memoizedProps&&r===t.memoizedState||(l.flags|=4),typeof u.getSnapshotBeforeUpdate!="function"||i===t.memoizedProps&&r===t.memoizedState||(l.flags|=1024),a=!1)}return u=a,Fn(t,l),a=(l.flags&128)!==0,u||a?(u=l.stateNode,e=a&&typeof e.getDerivedStateFromError!="function"?null:u.render(),l.flags|=1,t!==null&&a?(l.child=he(l,t.child,null,n),l.child=he(l,null,e,n)):mt(t,l,e,n),l.memoizedState=u.state,t=l.child):t=Ol(t,l,n),t}function fs(t,l,e,a){return ye(),l.flags|=256,mt(t,l,e,a),l.child}var xi={dehydrated:null,treeContext:null,retryLane:0,hydrationErrors:null};function Ui(t){return{baseLanes:t,cachePool:Ro()}}function Ri(t,l,e){return t=t!==null?t.childLanes&~e:0,l&&(t|=Ut),t}function _m(t,l,e){var a=l.pendingProps,n=!1,u=(l.flags&128)!==0,i;if((i=u)||(i=t!==null&&t.memoizedState===null?!1:(tt.current&2)!==0),i&&(n=!0,l.flags&=-129),i=(l.flags&32)!==0,l.flags&=-33,t===null){if(H){if(n?Hl(l):Cl(l),(t=k)?(t=h0(t,Kt),t=t!==null&&t.data!=="&"?t:null,t!==null&&(l.memoizedState={dehydrated:t,treeContext:Fl!==null?{id:al,overflow:nl}:null,retryLane:536870912,hydrationErrors:null},e=Do(t),e.return=l,l.child=e,yt=l,k=null)):t=null,t===null)throw Il(l);return Yc(t)?l.lanes=32:l.lanes=536870912,null}var c=a.children;return a=a.fallback,n?(Cl(l),n=l.mode,c=Su({mode:"hidden",children:c},n),a=se(a,n,e,null),c.return=l,a.return=l,c.sibling=a,l.child=c,a=l.child,a.memoizedState=Ui(e),a.childLanes=Ri(t,i,e),l.memoizedState=xi,xa(null,a)):(Hl(l),_c(l,c))}var f=t.memoizedState;if(f!==null&&(c=f.dehydrated,c!==null)){if(u)l.flags&256?(Hl(l),l.flags&=-257,l=Hi(t,l,e)):l.memoizedState!==null?(Cl(l),l.child=t.child,l.flags|=128,l=null):(Cl(l),c=a.fallback,n=l.mode,a=Su({mode:"visible",children:a.children},n),c=se(c,n,e,null),c.flags|=2,a.return=l,c.return=l,a.sibling=c,l.child=a,he(l,t.child,null,e),a=l.child,a.memoizedState=Ui(e),a.childLanes=Ri(t,i,e),l.memoizedState=xi,l=xa(null,a));else if(Hl(l),Yc(c)){if(i=c.nextSibling&&c.nextSibling.dataset,i)var d=i.dgst;i=d,a=Error(S(419)),a.stack="",a.digest=i,Fa({value:a,source:null,stack:null}),l=Hi(t,l,e)}else if(ut||oa(t,l,e,!1),i=(e&t.childLanes)!==0,ut||i){if(i=Q,i!==null&&(a=to(i,e),a!==0&&a!==f.retryLane))throw f.retryLane=a,Te(t,a),_t(i,t,a),Af;Bc(c)||Tu(),l=Hi(t,l,e)}else Bc(c)?(l.flags|=192,l.child=t.child,l=null):(t=f.treeContext,k=Jt(c.nextSibling),yt=l,H=!0,wl=null,Kt=!1,t!==null&&xo(l,t),l=_c(l,a.children),l.flags|=4096);return l}return n?(Cl(l),c=a.fallback,n=l.mode,f=t.child,d=f.sibling,a=bl(f,{mode:"hidden",children:a.children}),a.subtreeFlags=f.subtreeFlags&65011712,d!==null?c=bl(d,c):(c=se(c,n,e,null),c.flags|=2),c.return=l,a.return=l,a.sibling=c,l.child=a,xa(null,a),a=l.child,c=t.child.memoizedState,c===null?c=Ui(e):(n=c.cachePool,n!==null?(f=nt._currentValue,n=n.parent!==f?{parent:f,pool:f}:n):n=Ro(),c={baseLanes:c.baseLanes|e,cachePool:n}),a.memoizedState=c,a.childLanes=Ri(t,i,e),l.memoizedState=xi,xa(t.child,a)):(Hl(l),e=t.child,t=e.sibling,e=bl(e,{mode:"visible",children:a.children}),e.return=l,e.sibling=null,t!==null&&(i=l.deletions,i===null?(l.deletions=[t],l.flags|=16):i.push(t)),l.child=e,l.memoizedState=null,e)}function _c(t,l){return l=Su({mode:"visible",children:l},t.mode),l.return=t,t.child=l}function Su(t,l){return t=xt(22,t,null,l),t.lanes=0,t}function Hi(t,l,e){return he(l,t.child,null,e),t=_c(l,l.pendingProps.children),t.flags|=2,l.memoizedState=null,t}function ds(t,l,e){t.lanes|=l;var a=t.alternate;a!==null&&(a.lanes|=l),mc(t.return,l,e)}function Ci(t,l,e,a,n,u){var i=t.memoizedState;i===null?t.memoizedState={isBackwards:l,rendering:null,renderingStartTime:0,last:a,tail:e,tailMode:n,treeForkCount:u}:(i.isBackwards=l,i.rendering=null,i.renderingStartTime=0,i.last=a,i.tail=e,i.tailMode=n,i.treeForkCount=u)}function Om(t,l,e){var a=l.pendingProps,n=a.revealOrder,u=a.tail;a=a.children;var i=tt.current,c=(i&2)!==0;if(c?(i=i&1|2,l.flags|=128):i&=1,Z(tt,i),mt(t,l,a,e),a=H?$a:0,!c&&t!==null&&(t.flags&128)!==0)t:for(t=l.child;t!==null;){if(t.tag===13)t.memoizedState!==null&&ds(t,e,l);else if(t.tag===19)ds(t,e,l);else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===l)break t;for(;t.sibling===null;){if(t.return===null||t.return===l)break t;t=t.return}t.sibling.return=t.return,t=t.sibling}switch(n){case"forwards":for(e=l.child,n=null;e!==null;)t=e.alternate,t!==null&&yu(t)===null&&(n=e),e=e.sibling;e=n,e===null?(n=l.child,l.child=null):(n=e.sibling,e.sibling=null),Ci(l,!1,n,e,u,a);break;case"backwards":case"unstable_legacy-backwards":for(e=null,n=l.child,l.child=null;n!==null;){if(t=n.alternate,t!==null&&yu(t)===null){l.child=n;break}t=n.sibling,n.sibling=e,e=n,n=t}Ci(l,!0,e,null,u,a);break;case"together":Ci(l,!1,null,null,void 0,a);break;default:l.memoizedState=null}return l.child}function Ol(t,l,e){if(t!==null&&(l.dependencies=t.dependencies),te|=l.lanes,(e&l.childLanes)===0)if(t!==null){if(oa(t,l,e,!1),(e&l.childLanes)===0)return null}else return null;if(t!==null&&l.child!==t.child)throw Error(S(153));if(l.child!==null){for(t=l.child,e=bl(t,t.pendingProps),l.child=e,e.return=l;t.sibling!==null;)t=t.sibling,e=e.sibling=bl(t,t.pendingProps),e.return=l;e.sibling=null}return l.child}function _f(t,l){return(t.lanes&l)!==0?!0:(t=t.dependencies,!!(t!==null&&ou(t)))}function F1(t,l,e){switch(l.tag){case 3:nu(l,l.stateNode.containerInfo),Rl(l,nt,t.memoizedState.cache),ye();break;case 27:case 5:Pi(l);break;case 4:nu(l,l.stateNode.containerInfo);break;case 10:Rl(l,l.type,l.memoizedProps.value);break;case 31:if(l.memoizedState!==null)return l.flags|=128,Sc(l),null;break;case 13:var a=l.memoizedState;if(a!==null)return a.dehydrated!==null?(Hl(l),l.flags|=128,null):(e&l.child.childLanes)!==0?_m(t,l,e):(Hl(l),t=Ol(t,l,e),t!==null?t.sibling:null);Hl(l);break;case 19:var n=(t.flags&128)!==0;if(a=(e&l.childLanes)!==0,a||(oa(t,l,e,!1),a=(e&l.childLanes)!==0),n){if(a)return Om(t,l,e);l.flags|=128}if(n=l.memoizedState,n!==null&&(n.rendering=null,n.tail=null,n.lastEffect=null),Z(tt,tt.current),a)break;return null;case 22:return l.lanes=0,Am(t,l,e,l.pendingProps);case 24:Rl(l,nt,t.memoizedState.cache)}return Ol(t,l,e)}function Mm(t,l,e){if(t!==null)if(t.memoizedProps!==l.pendingProps)ut=!0;else{if(!_f(t,e)&&(l.flags&128)===0)return ut=!1,F1(t,l,e);ut=(t.flags&131072)!==0}else ut=!1,H&&(l.flags&1048576)!==0&&No(l,$a,l.index);switch(l.lanes=0,l.tag){case 16:t:{var a=l.pendingProps;if(t=ce(l.elementType),l.type=t,typeof t=="function")ef(t)?(a=Se(t,a),l.tag=1,l=cs(null,l,t,a,e)):(l.tag=0,l=Ac(null,l,t,a,e));else{if(t!=null){var n=t.$$typeof;if(n===Qc){l.tag=11,l=es(null,l,t,a,e);break t}else if(n===wc){l.tag=14,l=as(null,l,t,a,e);break t}}throw l=Fi(t)||t,Error(S(306,l,""))}}return l;case 0:return Ac(t,l,l.type,l.pendingProps,e);case 1:return a=l.type,n=Se(a,l.pendingProps),cs(t,l,a,n,e);case 3:t:{if(nu(l,l.stateNode.containerInfo),t===null)throw Error(S(387));a=l.pendingProps;var u=l.memoizedState;n=u.element,vc(t,l),Xa(l,a,null,e);var i=l.memoizedState;if(a=i.cache,Rl(l,nt,a),a!==u.cache&&rc(l,[nt],e,!0),Ya(),a=i.element,u.isDehydrated)if(u={element:a,isDehydrated:!1,cache:i.cache},l.updateQueue.baseState=u,l.memoizedState=u,l.flags&256){l=fs(t,l,a,e);break t}else if(a!==n){n=Vt(Error(S(424)),l),Fa(n),l=fs(t,l,a,e);break t}else for(t=l.stateNode.containerInfo,t.nodeType===9?t=t.body:t=t.nodeName==="HTML"?t.ownerDocument.body:t,k=Jt(t.firstChild),yt=l,H=!0,wl=null,Kt=!0,e=qo(l,null,a,e),l.child=e;e;)e.flags=e.flags&-3|4096,e=e.sibling;else{if(ye(),a===n){l=Ol(t,l,e);break t}mt(t,l,a,e)}l=l.child}return l;case 26:return Fn(t,l),t===null?(e=xs(l.type,null,l.pendingProps,null))?l.memoizedState=e:H||(e=l.type,t=l.pendingProps,a=Ou(Ql.current).createElement(e),a[rt]=l,a[Ot]=t,ht(a,e,t),st(a),l.stateNode=a):l.memoizedState=xs(l.type,t.memoizedProps,l.pendingProps,t.memoizedState),null;case 27:return Pi(l),t===null&&H&&(a=l.stateNode=g0(l.type,l.pendingProps,Ql.current),yt=l,Kt=!0,n=k,ee(l.type)?(Xc=n,k=Jt(a.firstChild)):k=n),mt(t,l,l.pendingProps.children,e),Fn(t,l),t===null&&(l.flags|=4194304),l.child;case 5:return t===null&&H&&((n=a=k)&&(a=_y(a,l.type,l.pendingProps,Kt),a!==null?(l.stateNode=a,yt=l,k=Jt(a.firstChild),Kt=!1,n=!0):n=!1),n||Il(l)),Pi(l),n=l.type,u=l.pendingProps,i=t!==null?t.memoizedProps:null,a=u.children,Cc(n,u)?a=null:i!==null&&Cc(n,i)&&(l.flags|=32),l.memoizedState!==null&&(n=mf(t,l,Q1,null,null,e),an._currentValue=n),Fn(t,l),mt(t,l,a,e),l.child;case 6:return t===null&&H&&((t=e=k)&&(e=Oy(e,l.pendingProps,Kt),e!==null?(l.stateNode=e,yt=l,k=null,t=!0):t=!1),t||Il(l)),null;case 13:return _m(t,l,e);case 4:return nu(l,l.stateNode.containerInfo),a=l.pendingProps,t===null?l.child=he(l,null,a,e):mt(t,l,a,e),l.child;case 11:return es(t,l,l.type,l.pendingProps,e);case 7:return mt(t,l,l.pendingProps,e),l.child;case 8:return mt(t,l,l.pendingProps.children,e),l.child;case 12:return mt(t,l,l.pendingProps.children,e),l.child;case 10:return a=l.pendingProps,Rl(l,l.type,a.value),mt(t,l,a.children,e),l.child;case 9:return n=l.type._context,a=l.pendingProps.children,ve(l),n=vt(n),a=a(n),l.flags|=1,mt(t,l,a,e),l.child;case 14:return as(t,l,l.type,l.pendingProps,e);case 15:return zm(t,l,l.type,l.pendingProps,e);case 19:return Om(t,l,e);case 31:return $1(t,l,e);case 22:return Am(t,l,e,l.pendingProps);case 24:return ve(l),a=vt(nt),t===null?(n=cf(),n===null&&(n=Q,u=uf(),n.pooledCache=u,u.refCount++,u!==null&&(n.pooledCacheLanes|=e),n=u),l.memoizedState={parent:a,cache:n},df(l),Rl(l,nt,n)):((t.lanes&e)!==0&&(vc(t,l),Xa(l,null,null,e),Ya()),n=t.memoizedState,u=l.memoizedState,n.parent!==a?(n={parent:a,cache:a},l.memoizedState=n,l.lanes===0&&(l.memoizedState=l.updateQueue.baseState=n),Rl(l,nt,a)):(a=u.cache,Rl(l,nt,a),a!==n.cache&&rc(l,[nt],e,!0))),mt(t,l,l.pendingProps.children,e),l.child;case 29:throw l.pendingProps}throw Error(S(156,l.tag))}function ol(t){t.flags|=4}function qi(t,l,e,a,n){if((l=(t.mode&32)!==0)&&(l=!1),l){if(t.flags|=16777216,(n&335544128)===n)if(t.stateNode.complete)t.flags|=8192;else if(Fm())t.flags|=8192;else throw me=mu,ff}else t.flags&=-16777217}function ss(t,l){if(l.type!=="stylesheet"||(l.state.loading&4)!==0)t.flags&=-16777217;else if(t.flags|=16777216,!b0(l))if(Fm())t.flags|=8192;else throw me=mu,ff}function Cn(t,l){l!==null&&(t.flags|=4),t.flags&16384&&(l=t.tag!==22?Fs():536870912,t.lanes|=l,na|=l)}function Aa(t,l){if(!H)switch(t.tailMode){case"hidden":l=t.tail;for(var e=null;l!==null;)l.alternate!==null&&(e=l),l=l.sibling;e===null?t.tail=null:e.sibling=null;break;case"collapsed":e=t.tail;for(var a=null;e!==null;)e.alternate!==null&&(a=e),e=e.sibling;a===null?l||t.tail===null?t.tail=null:t.tail.sibling=null:a.sibling=null}}function K(t){var l=t.alternate!==null&&t.alternate.child===t.child,e=0,a=0;if(l)for(var n=t.child;n!==null;)e|=n.lanes|n.childLanes,a|=n.subtreeFlags&65011712,a|=n.flags&65011712,n.return=t,n=n.sibling;else for(n=t.child;n!==null;)e|=n.lanes|n.childLanes,a|=n.subtreeFlags,a|=n.flags,n.return=t,n=n.sibling;return t.subtreeFlags|=a,t.childLanes=e,l}function I1(t,l,e){var a=l.pendingProps;switch(nf(l),l.tag){case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return K(l),null;case 1:return K(l),null;case 3:return e=l.stateNode,a=null,t!==null&&(a=t.memoizedState.cache),l.memoizedState.cache!==a&&(l.flags|=2048),El(nt),Ie(),e.pendingContext&&(e.context=e.pendingContext,e.pendingContext=null),(t===null||t.child===null)&&(De(l)?ol(l):t===null||t.memoizedState.isDehydrated&&(l.flags&256)===0||(l.flags|=1024,Mi())),K(l),null;case 26:var n=l.type,u=l.memoizedState;return t===null?(ol(l),u!==null?(K(l),ss(l,u)):(K(l),qi(l,n,null,a,e))):u?u!==t.memoizedState?(ol(l),K(l),ss(l,u)):(K(l),l.flags&=-16777217):(t=t.memoizedProps,t!==a&&ol(l),K(l),qi(l,n,t,a,e)),null;case 27:if(uu(l),e=Ql.current,n=l.type,t!==null&&l.stateNode!=null)t.memoizedProps!==a&&ol(l);else{if(!a){if(l.stateNode===null)throw Error(S(166));return K(l),null}t=il.current,De(l)?Xd(l,t):(t=g0(n,a,e),l.stateNode=t,ol(l))}return K(l),null;case 5:if(uu(l),n=l.type,t!==null&&l.stateNode!=null)t.memoizedProps!==a&&ol(l);else{if(!a){if(l.stateNode===null)throw Error(S(166));return K(l),null}if(u=il.current,De(l))Xd(l,u);else{var i=Ou(Ql.current);switch(u){case 1:u=i.createElementNS("http://www.w3.org/2000/svg",n);break;case 2:u=i.createElementNS("http://www.w3.org/1998/Math/MathML",n);break;default:switch(n){case"svg":u=i.createElementNS("http://www.w3.org/2000/svg",n);break;case"math":u=i.createElementNS("http://www.w3.org/1998/Math/MathML",n);break;case"script":u=i.createElement("div"),u.innerHTML="<script><\\/script>",u=u.removeChild(u.firstChild);break;case"select":u=typeof a.is=="string"?i.createElement("select",{is:a.is}):i.createElement("select"),a.multiple?u.multiple=!0:a.size&&(u.size=a.size);break;default:u=typeof a.is=="string"?i.createElement(n,{is:a.is}):i.createElement(n)}}u[rt]=l,u[Ot]=a;t:for(i=l.child;i!==null;){if(i.tag===5||i.tag===6)u.appendChild(i.stateNode);else if(i.tag!==4&&i.tag!==27&&i.child!==null){i.child.return=i,i=i.child;continue}if(i===l)break t;for(;i.sibling===null;){if(i.return===null||i.return===l)break t;i=i.return}i.sibling.return=i.return,i=i.sibling}l.stateNode=u;t:switch(ht(u,n,a),n){case"button":case"input":case"select":case"textarea":a=!!a.autoFocus;break t;case"img":a=!0;break t;default:a=!1}a&&ol(l)}}return K(l),qi(l,l.type,t===null?null:t.memoizedProps,l.pendingProps,e),null;case 6:if(t&&l.stateNode!=null)t.memoizedProps!==a&&ol(l);else{if(typeof a!="string"&&l.stateNode===null)throw Error(S(166));if(t=Ql.current,De(l)){if(t=l.stateNode,e=l.memoizedProps,a=null,n=yt,n!==null)switch(n.tag){case 27:case 5:a=n.memoizedProps}t[rt]=l,t=!!(t.nodeValue===e||a!==null&&a.suppressHydrationWarning===!0||r0(t.nodeValue,e)),t||Il(l,!0)}else t=Ou(t).createTextNode(a),t[rt]=l,l.stateNode=t}return K(l),null;case 31:if(e=l.memoizedState,t===null||t.memoizedState!==null){if(a=De(l),e!==null){if(t===null){if(!a)throw Error(S(318));if(t=l.memoizedState,t=t!==null?t.dehydrated:null,!t)throw Error(S(557));t[rt]=l}else ye(),(l.flags&128)===0&&(l.memoizedState=null),l.flags|=4;K(l),t=!1}else e=Mi(),t!==null&&t.memoizedState!==null&&(t.memoizedState.hydrationErrors=e),t=!0;if(!t)return l.flags&256?(Nt(l),l):(Nt(l),null);if((l.flags&128)!==0)throw Error(S(558))}return K(l),null;case 13:if(a=l.memoizedState,t===null||t.memoizedState!==null&&t.memoizedState.dehydrated!==null){if(n=De(l),a!==null&&a.dehydrated!==null){if(t===null){if(!n)throw Error(S(318));if(n=l.memoizedState,n=n!==null?n.dehydrated:null,!n)throw Error(S(317));n[rt]=l}else ye(),(l.flags&128)===0&&(l.memoizedState=null),l.flags|=4;K(l),n=!1}else n=Mi(),t!==null&&t.memoizedState!==null&&(t.memoizedState.hydrationErrors=n),n=!0;if(!n)return l.flags&256?(Nt(l),l):(Nt(l),null)}return Nt(l),(l.flags&128)!==0?(l.lanes=e,l):(e=a!==null,t=t!==null&&t.memoizedState!==null,e&&(a=l.child,n=null,a.alternate!==null&&a.alternate.memoizedState!==null&&a.alternate.memoizedState.cachePool!==null&&(n=a.alternate.memoizedState.cachePool.pool),u=null,a.memoizedState!==null&&a.memoizedState.cachePool!==null&&(u=a.memoizedState.cachePool.pool),u!==n&&(a.flags|=2048)),e!==t&&e&&(l.child.flags|=8192),Cn(l,l.updateQueue),K(l),null);case 4:return Ie(),t===null&&Uf(l.stateNode.containerInfo),K(l),null;case 10:return El(l.type),K(l),null;case 19:if(ot(tt),a=l.memoizedState,a===null)return K(l),null;if(n=(l.flags&128)!==0,u=a.rendering,u===null)if(n)Aa(a,!1);else{if(I!==0||t!==null&&(t.flags&128)!==0)for(t=l.child;t!==null;){if(u=yu(t),u!==null){for(l.flags|=128,Aa(a,!1),t=u.updateQueue,l.updateQueue=t,Cn(l,t),l.subtreeFlags=0,t=e,e=l.child;e!==null;)Lo(e,t),e=e.sibling;return Z(tt,tt.current&1|2),H&&vl(l,a.treeForkCount),l.child}t=t.sibling}a.tail!==null&&Rt()>bu&&(l.flags|=128,n=!0,Aa(a,!1),l.lanes=4194304)}else{if(!n)if(t=yu(u),t!==null){if(l.flags|=128,n=!0,t=t.updateQueue,l.updateQueue=t,Cn(l,t),Aa(a,!0),a.tail===null&&a.tailMode==="hidden"&&!u.alternate&&!H)return K(l),null}else 2*Rt()-a.renderingStartTime>bu&&e!==536870912&&(l.flags|=128,n=!0,Aa(a,!1),l.lanes=4194304);a.isBackwards?(u.sibling=l.child,l.child=u):(t=a.last,t!==null?t.sibling=u:l.child=u,a.last=u)}return a.tail!==null?(t=a.tail,a.rendering=t,a.tail=t.sibling,a.renderingStartTime=Rt(),t.sibling=null,e=tt.current,Z(tt,n?e&1|2:e&1),H&&vl(l,a.treeForkCount),t):(K(l),null);case 22:case 23:return Nt(l),sf(),a=l.memoizedState!==null,t!==null?t.memoizedState!==null!==a&&(l.flags|=8192):a&&(l.flags|=8192),a?(e&536870912)!==0&&(l.flags&128)===0&&(K(l),l.subtreeFlags&6&&(l.flags|=8192)):K(l),e=l.updateQueue,e!==null&&Cn(l,e.retryQueue),e=null,t!==null&&t.memoizedState!==null&&t.memoizedState.cachePool!==null&&(e=t.memoizedState.cachePool.pool),a=null,l.memoizedState!==null&&l.memoizedState.cachePool!==null&&(a=l.memoizedState.cachePool.pool),a!==e&&(l.flags|=2048),t!==null&&ot(oe),null;case 24:return e=null,t!==null&&(e=t.memoizedState.cache),l.memoizedState.cache!==e&&(l.flags|=2048),El(nt),K(l),null;case 25:return null;case 30:return null}throw Error(S(156,l.tag))}function P1(t,l){switch(nf(l),l.tag){case 1:return t=l.flags,t&65536?(l.flags=t&-65537|128,l):null;case 3:return El(nt),Ie(),t=l.flags,(t&65536)!==0&&(t&128)===0?(l.flags=t&-65537|128,l):null;case 26:case 27:case 5:return uu(l),null;case 31:if(l.memoizedState!==null){if(Nt(l),l.alternate===null)throw Error(S(340));ye()}return t=l.flags,t&65536?(l.flags=t&-65537|128,l):null;case 13:if(Nt(l),t=l.memoizedState,t!==null&&t.dehydrated!==null){if(l.alternate===null)throw Error(S(340));ye()}return t=l.flags,t&65536?(l.flags=t&-65537|128,l):null;case 19:return ot(tt),null;case 4:return Ie(),null;case 10:return El(l.type),null;case 22:case 23:return Nt(l),sf(),t!==null&&ot(oe),t=l.flags,t&65536?(l.flags=t&-65537|128,l):null;case 24:return El(nt),null;case 25:return null;default:return null}}function Lm(t,l){switch(nf(l),l.tag){case 3:El(nt),Ie();break;case 26:case 27:case 5:uu(l);break;case 4:Ie();break;case 31:l.memoizedState!==null&&Nt(l);break;case 13:Nt(l);break;case 19:ot(tt);break;case 10:El(l.type);break;case 22:case 23:Nt(l),sf(),t!==null&&ot(oe);break;case 24:El(nt)}}function vn(t,l){try{var e=l.updateQueue,a=e!==null?e.lastEffect:null;if(a!==null){var n=a.next;e=n;do{if((e.tag&t)===t){a=void 0;var u=e.create,i=e.inst;a=u(),i.destroy=a}e=e.next}while(e!==n)}}catch(c){X(l,l.return,c)}}function Pl(t,l,e){try{var a=l.updateQueue,n=a!==null?a.lastEffect:null;if(n!==null){var u=n.next;a=u;do{if((a.tag&t)===t){var i=a.inst,c=i.destroy;if(c!==void 0){i.destroy=void 0,n=l;var f=e,d=c;try{d()}catch(v){X(n,f,v)}}}a=a.next}while(a!==u)}}catch(v){X(l,l.return,v)}}function Dm(t){var l=t.updateQueue;if(l!==null){var e=t.stateNode;try{Yo(l,e)}catch(a){X(t,t.return,a)}}}function Nm(t,l,e){e.props=Se(t.type,t.memoizedProps),e.state=t.memoizedState;try{e.componentWillUnmount()}catch(a){X(t,l,a)}}function ja(t,l){try{var e=t.ref;if(e!==null){switch(t.tag){case 26:case 27:case 5:var a=t.stateNode;break;case 30:a=t.stateNode;break;default:a=t.stateNode}typeof e=="function"?t.refCleanup=e(a):e.current=a}}catch(n){X(t,l,n)}}function ul(t,l){var e=t.ref,a=t.refCleanup;if(e!==null)if(typeof a=="function")try{a()}catch(n){X(t,l,n)}finally{t.refCleanup=null,t=t.alternate,t!=null&&(t.refCleanup=null)}else if(typeof e=="function")try{e(null)}catch(n){X(t,l,n)}else e.current=null}function xm(t){var l=t.type,e=t.memoizedProps,a=t.stateNode;try{t:switch(l){case"button":case"input":case"select":case"textarea":e.autoFocus&&a.focus();break t;case"img":e.src?a.src=e.src:e.srcSet&&(a.srcset=e.srcSet)}}catch(n){X(t,t.return,n)}}function Bi(t,l,e){try{var a=t.stateNode;py(a,t.type,e,l),a[Ot]=l}catch(n){X(t,t.return,n)}}function Um(t){return t.tag===5||t.tag===3||t.tag===26||t.tag===27&&ee(t.type)||t.tag===4}function Yi(t){t:for(;;){for(;t.sibling===null;){if(t.return===null||Um(t.return))return null;t=t.return}for(t.sibling.return=t.return,t=t.sibling;t.tag!==5&&t.tag!==6&&t.tag!==18;){if(t.tag===27&&ee(t.type)||t.flags&2||t.child===null||t.tag===4)continue t;t.child.return=t,t=t.child}if(!(t.flags&2))return t.stateNode}}function Oc(t,l,e){var a=t.tag;if(a===5||a===6)t=t.stateNode,l?(e.nodeType===9?e.body:e.nodeName==="HTML"?e.ownerDocument.body:e).insertBefore(t,l):(l=e.nodeType===9?e.body:e.nodeName==="HTML"?e.ownerDocument.body:e,l.appendChild(t),e=e._reactRootContainer,e!=null||l.onclick!==null||(l.onclick=Sl));else if(a!==4&&(a===27&&ee(t.type)&&(e=t.stateNode,l=null),t=t.child,t!==null))for(Oc(t,l,e),t=t.sibling;t!==null;)Oc(t,l,e),t=t.sibling}function pu(t,l,e){var a=t.tag;if(a===5||a===6)t=t.stateNode,l?e.insertBefore(t,l):e.appendChild(t);else if(a!==4&&(a===27&&ee(t.type)&&(e=t.stateNode),t=t.child,t!==null))for(pu(t,l,e),t=t.sibling;t!==null;)pu(t,l,e),t=t.sibling}function Rm(t){var l=t.stateNode,e=t.memoizedProps;try{for(var a=t.type,n=l.attributes;n.length;)l.removeAttributeNode(n[0]);ht(l,a,e),l[rt]=t,l[Ot]=e}catch(u){X(t,t.return,u)}}var hl=!1,at=!1,Xi=!1,os=typeof WeakSet=="function"?WeakSet:Set,dt=null;function ty(t,l){if(t=t.containerInfo,Rc=Nu,t=bo(t),Pc(t)){if("selectionStart"in t)var e={start:t.selectionStart,end:t.selectionEnd};else t:{e=(e=t.ownerDocument)&&e.defaultView||window;var a=e.getSelection&&e.getSelection();if(a&&a.rangeCount!==0){e=a.anchorNode;var n=a.anchorOffset,u=a.focusNode;a=a.focusOffset;try{e.nodeType,u.nodeType}catch{e=null;break t}var i=0,c=-1,f=-1,d=0,v=0,g=t,r=null;l:for(;;){for(var y;g!==e||n!==0&&g.nodeType!==3||(c=i+n),g!==u||a!==0&&g.nodeType!==3||(f=i+a),g.nodeType===3&&(i+=g.nodeValue.length),(y=g.firstChild)!==null;)r=g,g=y;for(;;){if(g===t)break l;if(r===e&&++d===n&&(c=i),r===u&&++v===a&&(f=i),(y=g.nextSibling)!==null)break;g=r,r=g.parentNode}g=y}e=c===-1||f===-1?null:{start:c,end:f}}else e=null}e=e||{start:0,end:0}}else e=null;for(Hc={focusedElem:t,selectionRange:e},Nu=!1,dt=l;dt!==null;)if(l=dt,t=l.child,(l.subtreeFlags&1028)!==0&&t!==null)t.return=l,dt=t;else for(;dt!==null;){switch(l=dt,u=l.alternate,t=l.flags,l.tag){case 0:if((t&4)!==0&&(t=l.updateQueue,t=t!==null?t.events:null,t!==null))for(e=0;e<t.length;e++)n=t[e],n.ref.impl=n.nextImpl;break;case 11:case 15:break;case 1:if((t&1024)!==0&&u!==null){t=void 0,e=l,n=u.memoizedProps,u=u.memoizedState,a=e.stateNode;try{var p=Se(e.type,n);t=a.getSnapshotBeforeUpdate(p,u),a.__reactInternalSnapshotBeforeUpdate=t}catch(A){X(e,e.return,A)}}break;case 3:if((t&1024)!==0){if(t=l.stateNode.containerInfo,e=t.nodeType,e===9)qc(t);else if(e===1)switch(t.nodeName){case"HEAD":case"HTML":case"BODY":qc(t);break;default:t.textContent=""}}break;case 5:case 26:case 27:case 6:case 4:case 17:break;default:if((t&1024)!==0)throw Error(S(163))}if(t=l.sibling,t!==null){t.return=l.return,dt=t;break}dt=l.return}}function Hm(t,l,e){var a=e.flags;switch(e.tag){case 0:case 11:case 15:rl(t,e),a&4&&vn(5,e);break;case 1:if(rl(t,e),a&4)if(t=e.stateNode,l===null)try{t.componentDidMount()}catch(i){X(e,e.return,i)}else{var n=Se(e.type,l.memoizedProps);l=l.memoizedState;try{t.componentDidUpdate(n,l,t.__reactInternalSnapshotBeforeUpdate)}catch(i){X(e,e.return,i)}}a&64&&Dm(e),a&512&&ja(e,e.return);break;case 3:if(rl(t,e),a&64&&(t=e.updateQueue,t!==null)){if(l=null,e.child!==null)switch(e.child.tag){case 27:case 5:l=e.child.stateNode;break;case 1:l=e.child.stateNode}try{Yo(t,l)}catch(i){X(e,e.return,i)}}break;case 27:l===null&&a&4&&Rm(e);case 26:case 5:rl(t,e),l===null&&a&4&&xm(e),a&512&&ja(e,e.return);break;case 12:rl(t,e);break;case 31:rl(t,e),a&4&&Bm(t,e);break;case 13:rl(t,e),a&4&&Ym(t,e),a&64&&(t=e.memoizedState,t!==null&&(t=t.dehydrated,t!==null&&(e=dy.bind(null,e),My(t,e))));break;case 22:if(a=e.memoizedState!==null||hl,!a){l=l!==null&&l.memoizedState!==null||at,n=hl;var u=at;hl=a,(at=l)&&!u?yl(t,e,(e.subtreeFlags&8772)!==0):rl(t,e),hl=n,at=u}break;case 30:break;default:rl(t,e)}}function Cm(t){var l=t.alternate;l!==null&&(t.alternate=null,Cm(l)),t.child=null,t.deletions=null,t.sibling=null,t.tag===5&&(l=t.stateNode,l!==null&&kc(l)),t.stateNode=null,t.return=null,t.dependencies=null,t.memoizedProps=null,t.memoizedState=null,t.pendingProps=null,t.stateNode=null,t.updateQueue=null}var $=null,zt=!1;function ml(t,l,e){for(e=e.child;e!==null;)qm(t,l,e),e=e.sibling}function qm(t,l,e){if(Ht&&typeof Ht.onCommitFiberUnmount=="function")try{Ht.onCommitFiberUnmount(fn,e)}catch{}switch(e.tag){case 26:at||ul(e,l),ml(t,l,e),e.memoizedState?e.memoizedState.count--:e.stateNode&&(e=e.stateNode,e.parentNode.removeChild(e));break;case 27:at||ul(e,l);var a=$,n=zt;ee(e.type)&&($=e.stateNode,zt=!1),ml(t,l,e),Va(e.stateNode),$=a,zt=n;break;case 5:at||ul(e,l);case 6:if(a=$,n=zt,$=null,ml(t,l,e),$=a,zt=n,$!==null)if(zt)try{($.nodeType===9?$.body:$.nodeName==="HTML"?$.ownerDocument.body:$).removeChild(e.stateNode)}catch(u){X(e,l,u)}else try{$.removeChild(e.stateNode)}catch(u){X(e,l,u)}break;case 18:$!==null&&(zt?(t=$,Os(t.nodeType===9?t.body:t.nodeName==="HTML"?t.ownerDocument.body:t,e.stateNode),fa(t)):Os($,e.stateNode));break;case 4:a=$,n=zt,$=e.stateNode.containerInfo,zt=!0,ml(t,l,e),$=a,zt=n;break;case 0:case 11:case 14:case 15:Pl(2,e,l),at||Pl(4,e,l),ml(t,l,e);break;case 1:at||(ul(e,l),a=e.stateNode,typeof a.componentWillUnmount=="function"&&Nm(e,l,a)),ml(t,l,e);break;case 21:ml(t,l,e);break;case 22:at=(a=at)||e.memoizedState!==null,ml(t,l,e),at=a;break;default:ml(t,l,e)}}function Bm(t,l){if(l.memoizedState===null&&(t=l.alternate,t!==null&&(t=t.memoizedState,t!==null))){t=t.dehydrated;try{fa(t)}catch(e){X(l,l.return,e)}}}function Ym(t,l){if(l.memoizedState===null&&(t=l.alternate,t!==null&&(t=t.memoizedState,t!==null&&(t=t.dehydrated,t!==null))))try{fa(t)}catch(e){X(l,l.return,e)}}function ly(t){switch(t.tag){case 31:case 13:case 19:var l=t.stateNode;return l===null&&(l=t.stateNode=new os),l;case 22:return t=t.stateNode,l=t._retryCache,l===null&&(l=t._retryCache=new os),l;default:throw Error(S(435,t.tag))}}function qn(t,l){var e=ly(t);l.forEach(function(a){if(!e.has(a)){e.add(a);var n=sy.bind(null,t,a);a.then(n,n)}})}function Et(t,l){var e=l.deletions;if(e!==null)for(var a=0;a<e.length;a++){var n=e[a],u=t,i=l,c=i;t:for(;c!==null;){switch(c.tag){case 27:if(ee(c.type)){$=c.stateNode,zt=!1;break t}break;case 5:$=c.stateNode,zt=!1;break t;case 3:case 4:$=c.stateNode.containerInfo,zt=!0;break t}c=c.return}if($===null)throw Error(S(160));qm(u,i,n),$=null,zt=!1,u=n.alternate,u!==null&&(u.return=null),n.return=null}if(l.subtreeFlags&13886)for(l=l.child;l!==null;)Xm(l,t),l=l.sibling}var Ft=null;function Xm(t,l){var e=t.alternate,a=t.flags;switch(t.tag){case 0:case 11:case 14:case 15:Et(l,t),Tt(t),a&4&&(Pl(3,t,t.return),vn(3,t),Pl(5,t,t.return));break;case 1:Et(l,t),Tt(t),a&512&&(at||e===null||ul(e,e.return)),a&64&&hl&&(t=t.updateQueue,t!==null&&(a=t.callbacks,a!==null&&(e=t.shared.hiddenCallbacks,t.shared.hiddenCallbacks=e===null?a:e.concat(a))));break;case 26:var n=Ft;if(Et(l,t),Tt(t),a&512&&(at||e===null||ul(e,e.return)),a&4){var u=e!==null?e.memoizedState:null;if(a=t.memoizedState,e===null)if(a===null)if(t.stateNode===null){t:{a=t.type,e=t.memoizedProps,n=n.ownerDocument||n;l:switch(a){case"title":u=n.getElementsByTagName("title")[0],(!u||u[on]||u[rt]||u.namespaceURI==="http://www.w3.org/2000/svg"||u.hasAttribute("itemprop"))&&(u=n.createElement(a),n.head.insertBefore(u,n.querySelector("head > title"))),ht(u,a,e),u[rt]=t,st(u),a=u;break t;case"link":var i=Rs("link","href",n).get(a+(e.href||""));if(i){for(var c=0;c<i.length;c++)if(u=i[c],u.getAttribute("href")===(e.href==null||e.href===""?null:e.href)&&u.getAttribute("rel")===(e.rel==null?null:e.rel)&&u.getAttribute("title")===(e.title==null?null:e.title)&&u.getAttribute("crossorigin")===(e.crossOrigin==null?null:e.crossOrigin)){i.splice(c,1);break l}}u=n.createElement(a),ht(u,a,e),n.head.appendChild(u);break;case"meta":if(i=Rs("meta","content",n).get(a+(e.content||""))){for(c=0;c<i.length;c++)if(u=i[c],u.getAttribute("content")===(e.content==null?null:""+e.content)&&u.getAttribute("name")===(e.name==null?null:e.name)&&u.getAttribute("property")===(e.property==null?null:e.property)&&u.getAttribute("http-equiv")===(e.httpEquiv==null?null:e.httpEquiv)&&u.getAttribute("charset")===(e.charSet==null?null:e.charSet)){i.splice(c,1);break l}}u=n.createElement(a),ht(u,a,e),n.head.appendChild(u);break;default:throw Error(S(468,a))}u[rt]=t,st(u),a=u}t.stateNode=a}else Hs(n,t.type,t.stateNode);else t.stateNode=Us(n,a,t.memoizedProps);else u!==a?(u===null?e.stateNode!==null&&(e=e.stateNode,e.parentNode.removeChild(e)):u.count--,a===null?Hs(n,t.type,t.stateNode):Us(n,a,t.memoizedProps)):a===null&&t.stateNode!==null&&Bi(t,t.memoizedProps,e.memoizedProps)}break;case 27:Et(l,t),Tt(t),a&512&&(at||e===null||ul(e,e.return)),e!==null&&a&4&&Bi(t,t.memoizedProps,e.memoizedProps);break;case 5:if(Et(l,t),Tt(t),a&512&&(at||e===null||ul(e,e.return)),t.flags&32){n=t.stateNode;try{ta(n,"")}catch(p){X(t,t.return,p)}}a&4&&t.stateNode!=null&&(n=t.memoizedProps,Bi(t,n,e!==null?e.memoizedProps:n)),a&1024&&(Xi=!0);break;case 6:if(Et(l,t),Tt(t),a&4){if(t.stateNode===null)throw Error(S(162));a=t.memoizedProps,e=t.stateNode;try{e.nodeValue=a}catch(p){X(t,t.return,p)}}break;case 3:if(tu=null,n=Ft,Ft=Mu(l.containerInfo),Et(l,t),Ft=n,Tt(t),a&4&&e!==null&&e.memoizedState.isDehydrated)try{fa(l.containerInfo)}catch(p){X(t,t.return,p)}Xi&&(Xi=!1,Gm(t));break;case 4:a=Ft,Ft=Mu(t.stateNode.containerInfo),Et(l,t),Tt(t),Ft=a;break;case 12:Et(l,t),Tt(t);break;case 31:Et(l,t),Tt(t),a&4&&(a=t.updateQueue,a!==null&&(t.updateQueue=null,qn(t,a)));break;case 13:Et(l,t),Tt(t),t.child.flags&8192&&t.memoizedState!==null!=(e!==null&&e.memoizedState!==null)&&(wu=Rt()),a&4&&(a=t.updateQueue,a!==null&&(t.updateQueue=null,qn(t,a)));break;case 22:n=t.memoizedState!==null;var f=e!==null&&e.memoizedState!==null,d=hl,v=at;if(hl=d||n,at=v||f,Et(l,t),at=v,hl=d,Tt(t),a&8192)t:for(l=t.stateNode,l._visibility=n?l._visibility&-2:l._visibility|1,n&&(e===null||f||hl||at||fe(t)),e=null,l=t;;){if(l.tag===5||l.tag===26){if(e===null){f=e=l;try{if(u=f.stateNode,n)i=u.style,typeof i.setProperty=="function"?i.setProperty("display","none","important"):i.display="none";else{c=f.stateNode;var g=f.memoizedProps.style,r=g!=null&&g.hasOwnProperty("display")?g.display:null;c.style.display=r==null||typeof r=="boolean"?"":(""+r).trim()}}catch(p){X(f,f.return,p)}}}else if(l.tag===6){if(e===null){f=l;try{f.stateNode.nodeValue=n?"":f.memoizedProps}catch(p){X(f,f.return,p)}}}else if(l.tag===18){if(e===null){f=l;try{var y=f.stateNode;n?Ms(y,!0):Ms(f.stateNode,!1)}catch(p){X(f,f.return,p)}}}else if((l.tag!==22&&l.tag!==23||l.memoizedState===null||l===t)&&l.child!==null){l.child.return=l,l=l.child;continue}if(l===t)break t;for(;l.sibling===null;){if(l.return===null||l.return===t)break t;e===l&&(e=null),l=l.return}e===l&&(e=null),l.sibling.return=l.return,l=l.sibling}a&4&&(a=t.updateQueue,a!==null&&(e=a.retryQueue,e!==null&&(a.retryQueue=null,qn(t,e))));break;case 19:Et(l,t),Tt(t),a&4&&(a=t.updateQueue,a!==null&&(t.updateQueue=null,qn(t,a)));break;case 30:break;case 21:break;default:Et(l,t),Tt(t)}}function Tt(t){var l=t.flags;if(l&2){try{for(var e,a=t.return;a!==null;){if(Um(a)){e=a;break}a=a.return}if(e==null)throw Error(S(160));switch(e.tag){case 27:var n=e.stateNode,u=Yi(t);pu(t,u,n);break;case 5:var i=e.stateNode;e.flags&32&&(ta(i,""),e.flags&=-33);var c=Yi(t);pu(t,c,i);break;case 3:case 4:var f=e.stateNode.containerInfo,d=Yi(t);Oc(t,d,f);break;default:throw Error(S(161))}}catch(v){X(t,t.return,v)}t.flags&=-3}l&4096&&(t.flags&=-4097)}function Gm(t){if(t.subtreeFlags&1024)for(t=t.child;t!==null;){var l=t;Gm(l),l.tag===5&&l.flags&1024&&l.stateNode.reset(),t=t.sibling}}function rl(t,l){if(l.subtreeFlags&8772)for(l=l.child;l!==null;)Hm(t,l.alternate,l),l=l.sibling}function fe(t){for(t=t.child;t!==null;){var l=t;switch(l.tag){case 0:case 11:case 14:case 15:Pl(4,l,l.return),fe(l);break;case 1:ul(l,l.return);var e=l.stateNode;typeof e.componentWillUnmount=="function"&&Nm(l,l.return,e),fe(l);break;case 27:Va(l.stateNode);case 26:case 5:ul(l,l.return),fe(l);break;case 22:l.memoizedState===null&&fe(l);break;case 30:fe(l);break;default:fe(l)}t=t.sibling}}function yl(t,l,e){for(e=e&&(l.subtreeFlags&8772)!==0,l=l.child;l!==null;){var a=l.alternate,n=t,u=l,i=u.flags;switch(u.tag){case 0:case 11:case 15:yl(n,u,e),vn(4,u);break;case 1:if(yl(n,u,e),a=u,n=a.stateNode,typeof n.componentDidMount=="function")try{n.componentDidMount()}catch(d){X(a,a.return,d)}if(a=u,n=a.updateQueue,n!==null){var c=a.stateNode;try{var f=n.shared.hiddenCallbacks;if(f!==null)for(n.shared.hiddenCallbacks=null,n=0;n<f.length;n++)Bo(f[n],c)}catch(d){X(a,a.return,d)}}e&&i&64&&Dm(u),ja(u,u.return);break;case 27:Rm(u);case 26:case 5:yl(n,u,e),e&&a===null&&i&4&&xm(u),ja(u,u.return);break;case 12:yl(n,u,e);break;case 31:yl(n,u,e),e&&i&4&&Bm(n,u);break;case 13:yl(n,u,e),e&&i&4&&Ym(n,u);break;case 22:u.memoizedState===null&&yl(n,u,e),ja(u,u.return);break;case 30:break;default:yl(n,u,e)}l=l.sibling}}function Of(t,l){var e=null;t!==null&&t.memoizedState!==null&&t.memoizedState.cachePool!==null&&(e=t.memoizedState.cachePool.pool),t=null,l.memoizedState!==null&&l.memoizedState.cachePool!==null&&(t=l.memoizedState.cachePool.pool),t!==e&&(t!=null&&t.refCount++,e!=null&&rn(e))}function Mf(t,l){t=null,l.alternate!==null&&(t=l.alternate.memoizedState.cache),l=l.memoizedState.cache,l!==t&&(l.refCount++,t!=null&&rn(t))}function $t(t,l,e,a){if(l.subtreeFlags&10256)for(l=l.child;l!==null;)jm(t,l,e,a),l=l.sibling}function jm(t,l,e,a){var n=l.flags;switch(l.tag){case 0:case 11:case 15:$t(t,l,e,a),n&2048&&vn(9,l);break;case 1:$t(t,l,e,a);break;case 3:$t(t,l,e,a),n&2048&&(t=null,l.alternate!==null&&(t=l.alternate.memoizedState.cache),l=l.memoizedState.cache,l!==t&&(l.refCount++,t!=null&&rn(t)));break;case 12:if(n&2048){$t(t,l,e,a),t=l.stateNode;try{var u=l.memoizedProps,i=u.id,c=u.onPostCommit;typeof c=="function"&&c(i,l.alternate===null?"mount":"update",t.passiveEffectDuration,-0)}catch(f){X(l,l.return,f)}}else $t(t,l,e,a);break;case 31:$t(t,l,e,a);break;case 13:$t(t,l,e,a);break;case 23:break;case 22:u=l.stateNode,i=l.alternate,l.memoizedState!==null?u._visibility&2?$t(t,l,e,a):Qa(t,l):u._visibility&2?$t(t,l,e,a):(u._visibility|=2,xe(t,l,e,a,(l.subtreeFlags&10256)!==0||!1)),n&2048&&Of(i,l);break;case 24:$t(t,l,e,a),n&2048&&Mf(l.alternate,l);break;default:$t(t,l,e,a)}}function xe(t,l,e,a,n){for(n=n&&((l.subtreeFlags&10256)!==0||!1),l=l.child;l!==null;){var u=t,i=l,c=e,f=a,d=i.flags;switch(i.tag){case 0:case 11:case 15:xe(u,i,c,f,n),vn(8,i);break;case 23:break;case 22:var v=i.stateNode;i.memoizedState!==null?v._visibility&2?xe(u,i,c,f,n):Qa(u,i):(v._visibility|=2,xe(u,i,c,f,n)),n&&d&2048&&Of(i.alternate,i);break;case 24:xe(u,i,c,f,n),n&&d&2048&&Mf(i.alternate,i);break;default:xe(u,i,c,f,n)}l=l.sibling}}function Qa(t,l){if(l.subtreeFlags&10256)for(l=l.child;l!==null;){var e=t,a=l,n=a.flags;switch(a.tag){case 22:Qa(e,a),n&2048&&Of(a.alternate,a);break;case 24:Qa(e,a),n&2048&&Mf(a.alternate,a);break;default:Qa(e,a)}l=l.sibling}}var Ua=8192;function Ne(t,l,e){if(t.subtreeFlags&Ua)for(t=t.child;t!==null;)Qm(t,l,e),t=t.sibling}function Qm(t,l,e){switch(t.tag){case 26:Ne(t,l,e),t.flags&Ua&&t.memoizedState!==null&&Xy(e,Ft,t.memoizedState,t.memoizedProps);break;case 5:Ne(t,l,e);break;case 3:case 4:var a=Ft;Ft=Mu(t.stateNode.containerInfo),Ne(t,l,e),Ft=a;break;case 22:t.memoizedState===null&&(a=t.alternate,a!==null&&a.memoizedState!==null?(a=Ua,Ua=16777216,Ne(t,l,e),Ua=a):Ne(t,l,e));break;default:Ne(t,l,e)}}function wm(t){var l=t.alternate;if(l!==null&&(t=l.child,t!==null)){l.child=null;do l=t.sibling,t.sibling=null,t=l;while(t!==null)}}function _a(t){var l=t.deletions;if((t.flags&16)!==0){if(l!==null)for(var e=0;e<l.length;e++){var a=l[e];dt=a,Vm(a,t)}wm(t)}if(t.subtreeFlags&10256)for(t=t.child;t!==null;)Zm(t),t=t.sibling}function Zm(t){switch(t.tag){case 0:case 11:case 15:_a(t),t.flags&2048&&Pl(9,t,t.return);break;case 3:_a(t);break;case 12:_a(t);break;case 22:var l=t.stateNode;t.memoizedState!==null&&l._visibility&2&&(t.return===null||t.return.tag!==13)?(l._visibility&=-3,In(t)):_a(t);break;default:_a(t)}}function In(t){var l=t.deletions;if((t.flags&16)!==0){if(l!==null)for(var e=0;e<l.length;e++){var a=l[e];dt=a,Vm(a,t)}wm(t)}for(t=t.child;t!==null;){switch(l=t,l.tag){case 0:case 11:case 15:Pl(8,l,l.return),In(l);break;case 22:e=l.stateNode,e._visibility&2&&(e._visibility&=-3,In(l));break;default:In(l)}t=t.sibling}}function Vm(t,l){for(;dt!==null;){var e=dt;switch(e.tag){case 0:case 11:case 15:Pl(8,e,l);break;case 23:case 22:if(e.memoizedState!==null&&e.memoizedState.cachePool!==null){var a=e.memoizedState.cachePool.pool;a!=null&&a.refCount++}break;case 24:rn(e.memoizedState.cache)}if(a=e.child,a!==null)a.return=e,dt=a;else t:for(e=t;dt!==null;){a=dt;var n=a.sibling,u=a.return;if(Cm(a),a===e){dt=null;break t}if(n!==null){n.return=u,dt=n;break t}dt=u}}}var ey={getCacheForType:function(t){var l=vt(nt),e=l.data.get(t);return e===void 0&&(e=t(),l.data.set(t,e)),e},cacheSignal:function(){return vt(nt).controller.signal}},ay=typeof WeakMap=="function"?WeakMap:Map,q=0,Q=null,U=null,R=0,Y=0,Dt=null,Xl=!1,ra=!1,Lf=!1,Ml=0,I=0,te=0,re=0,Df=0,Ut=0,na=0,wa=null,At=null,Mc=!1,wu=0,Km=0,bu=1/0,Eu=null,Kl=null,it=0,kl=null,ua=null,Tl=0,Lc=0,Dc=null,km=null,Za=0,Nc=null;function qt(){return(q&2)!==0&&R!==0?R&-R:O.T!==null?xf():lo()}function Jm(){if(Ut===0)if((R&536870912)===0||H){var t=On;On<<=1,(On&3932160)===0&&(On=262144),Ut=t}else Ut=536870912;return t=Yt.current,t!==null&&(t.flags|=32),Ut}function _t(t,l,e){(t===Q&&(Y===2||Y===9)||t.cancelPendingCommit!==null)&&(ia(t,0),Gl(t,R,Ut,!1)),sn(t,e),((q&2)===0||t!==Q)&&(t===Q&&((q&2)===0&&(re|=e),I===4&&Gl(t,R,Ut,!1)),fl(t))}function Wm(t,l,e){if((q&6)!==0)throw Error(S(327));var a=!e&&(l&127)===0&&(l&t.expiredLanes)===0||dn(t,l),n=a?iy(t,l):Gi(t,l,!0),u=a;do{if(n===0){ra&&!a&&Gl(t,l,0,!1);break}else{if(e=t.current.alternate,u&&!ny(e)){n=Gi(t,l,!1),u=!1;continue}if(n===2){if(u=l,t.errorRecoveryDisabledLanes&u)var i=0;else i=t.pendingLanes&-536870913,i=i!==0?i:i&536870912?536870912:0;if(i!==0){l=i;t:{var c=t;n=wa;var f=c.current.memoizedState.isDehydrated;if(f&&(ia(c,i).flags|=256),i=Gi(c,i,!1),i!==2){if(Lf&&!f){c.errorRecoveryDisabledLanes|=u,re|=u,n=4;break t}u=At,At=n,u!==null&&(At===null?At=u:At.push.apply(At,u))}n=i}if(u=!1,n!==2)continue}}if(n===1){ia(t,0),Gl(t,l,0,!0);break}t:{switch(a=t,u=n,u){case 0:case 1:throw Error(S(345));case 4:if((l&4194048)!==l)break;case 6:Gl(a,l,Ut,!Xl);break t;case 2:At=null;break;case 3:case 5:break;default:throw Error(S(329))}if((l&62914560)===l&&(n=wu+300-Rt(),10<n)){if(Gl(a,l,Ut,!Xl),Uu(a,0,!0)!==0)break t;Tl=l,a.timeoutHandle=v0(ms.bind(null,a,e,At,Eu,Mc,l,Ut,re,na,Xl,u,"Throttled",-0,0),n);break t}ms(a,e,At,Eu,Mc,l,Ut,re,na,Xl,u,null,-0,0)}}break}while(!0);fl(t)}function ms(t,l,e,a,n,u,i,c,f,d,v,g,r,y){if(t.timeoutHandle=-1,g=l.subtreeFlags,g&8192||(g&16785408)===16785408){g={stylesheets:null,count:0,imgCount:0,imgBytes:0,suspenseyImages:[],waitingForImages:!0,waitingForViewTransition:!1,unsuspend:Sl},Qm(l,u,g);var p=(u&62914560)===u?wu-Rt():(u&4194048)===u?Km-Rt():0;if(p=Gy(g,p),p!==null){Tl=u,t.cancelPendingCommit=p(ys.bind(null,t,l,u,e,a,n,i,c,f,v,g,null,r,y)),Gl(t,u,i,!d);return}}ys(t,l,u,e,a,n,i,c,f)}function ny(t){for(var l=t;;){var e=l.tag;if((e===0||e===11||e===15)&&l.flags&16384&&(e=l.updateQueue,e!==null&&(e=e.stores,e!==null)))for(var a=0;a<e.length;a++){var n=e[a],u=n.getSnapshot;n=n.value;try{if(!Bt(u(),n))return!1}catch{return!1}}if(e=l.child,l.subtreeFlags&16384&&e!==null)e.return=l,l=e;else{if(l===t)break;for(;l.sibling===null;){if(l.return===null||l.return===t)return!0;l=l.return}l.sibling.return=l.return,l=l.sibling}}return!0}function Gl(t,l,e,a){l&=~Df,l&=~re,t.suspendedLanes|=l,t.pingedLanes&=~l,a&&(t.warmLanes|=l),a=t.expirationTimes;for(var n=l;0<n;){var u=31-Ct(n),i=1<<u;a[u]=-1,n&=~i}e!==0&&Is(t,e,l)}function Zu(){return(q&6)===0?(hn(0,!1),!1):!0}function Nf(){if(U!==null){if(Y===0)var t=U.return;else t=U,pl=ze=null,vf(t),We=null,Ia=0,t=U;for(;t!==null;)Lm(t.alternate,t),t=t.return;U=null}}function ia(t,l){var e=t.timeoutHandle;e!==-1&&(t.timeoutHandle=-1,Ty(e)),e=t.cancelPendingCommit,e!==null&&(t.cancelPendingCommit=null,e()),Tl=0,Nf(),Q=t,U=e=bl(t.current,null),R=l,Y=0,Dt=null,Xl=!1,ra=dn(t,l),Lf=!1,na=Ut=Df=re=te=I=0,At=wa=null,Mc=!1,(l&8)!==0&&(l|=l&32);var a=t.entangledLanes;if(a!==0)for(t=t.entanglements,a&=l;0<a;){var n=31-Ct(a),u=1<<n;l|=t[n],a&=~u}return Ml=l,qu(),e}function $m(t,l){L=null,O.H=tn,l===ma||l===Yu?(l=Zd(),Y=3):l===ff?(l=Zd(),Y=4):Y=l===Af?8:l!==null&&typeof l=="object"&&typeof l.then=="function"?6:1,Dt=l,U===null&&(I=1,gu(t,Vt(l,t.current)))}function Fm(){var t=Yt.current;return t===null?!0:(R&4194048)===R?kt===null:(R&62914560)===R||(R&536870912)!==0?t===kt:!1}function Im(){var t=O.H;return O.H=tn,t===null?tn:t}function Pm(){var t=O.A;return O.A=ey,t}function Tu(){I=4,Xl||(R&4194048)!==R&&Yt.current!==null||(ra=!0),(te&134217727)===0&&(re&134217727)===0||Q===null||Gl(Q,R,Ut,!1)}function Gi(t,l,e){var a=q;q|=2;var n=Im(),u=Pm();(Q!==t||R!==l)&&(Eu=null,ia(t,l)),l=!1;var i=I;t:do try{if(Y!==0&&U!==null){var c=U,f=Dt;switch(Y){case 8:Nf(),i=6;break t;case 3:case 2:case 9:case 6:Yt.current===null&&(l=!0);var d=Y;if(Y=0,Dt=null,Ze(t,c,f,d),e&&ra){i=0;break t}break;default:d=Y,Y=0,Dt=null,Ze(t,c,f,d)}}uy(),i=I;break}catch(v){$m(t,v)}while(!0);return l&&t.shellSuspendCounter++,pl=ze=null,q=a,O.H=n,O.A=u,U===null&&(Q=null,R=0,qu()),i}function uy(){for(;U!==null;)t0(U)}function iy(t,l){var e=q;q|=2;var a=Im(),n=Pm();Q!==t||R!==l?(Eu=null,bu=Rt()+500,ia(t,l)):ra=dn(t,l);t:do try{if(Y!==0&&U!==null){l=U;var u=Dt;l:switch(Y){case 1:Y=0,Dt=null,Ze(t,l,u,1);break;case 2:case 9:if(wd(u)){Y=0,Dt=null,rs(l);break}l=function(){Y!==2&&Y!==9||Q!==t||(Y=7),fl(t)},u.then(l,l);break t;case 3:Y=7;break t;case 4:Y=5;break t;case 7:wd(u)?(Y=0,Dt=null,rs(l)):(Y=0,Dt=null,Ze(t,l,u,7));break;case 5:var i=null;switch(U.tag){case 26:i=U.memoizedState;case 5:case 27:var c=U;if(i?b0(i):c.stateNode.complete){Y=0,Dt=null;var f=c.sibling;if(f!==null)U=f;else{var d=c.return;d!==null?(U=d,Vu(d)):U=null}break l}}Y=0,Dt=null,Ze(t,l,u,5);break;case 6:Y=0,Dt=null,Ze(t,l,u,6);break;case 8:Nf(),I=6;break t;default:throw Error(S(462))}}cy();break}catch(v){$m(t,v)}while(!0);return pl=ze=null,O.H=a,O.A=n,q=e,U!==null?0:(Q=null,R=0,qu(),I)}function cy(){for(;U!==null&&!Nr();)t0(U)}function t0(t){var l=Mm(t.alternate,t,Ml);t.memoizedProps=t.pendingProps,l===null?Vu(t):U=l}function rs(t){var l=t,e=l.alternate;switch(l.tag){case 15:case 0:l=is(e,l,l.pendingProps,l.type,void 0,R);break;case 11:l=is(e,l,l.pendingProps,l.type.render,l.ref,R);break;case 5:vf(l);default:Lm(e,l),l=U=Lo(l,Ml),l=Mm(e,l,Ml)}t.memoizedProps=t.pendingProps,l===null?Vu(t):U=l}function Ze(t,l,e,a){pl=ze=null,vf(l),We=null,Ia=0;var n=l.return;try{if(W1(t,n,l,e,R)){I=1,gu(t,Vt(e,t.current)),U=null;return}}catch(u){if(n!==null)throw U=n,u;I=1,gu(t,Vt(e,t.current)),U=null;return}l.flags&32768?(H||a===1?t=!0:ra||(R&536870912)!==0?t=!1:(Xl=t=!0,(a===2||a===9||a===3||a===6)&&(a=Yt.current,a!==null&&a.tag===13&&(a.flags|=16384))),l0(l,t)):Vu(l)}function Vu(t){var l=t;do{if((l.flags&32768)!==0){l0(l,Xl);return}t=l.return;var e=I1(l.alternate,l,Ml);if(e!==null){U=e;return}if(l=l.sibling,l!==null){U=l;return}U=l=t}while(l!==null);I===0&&(I=5)}function l0(t,l){do{var e=P1(t.alternate,t);if(e!==null){e.flags&=32767,U=e;return}if(e=t.return,e!==null&&(e.flags|=32768,e.subtreeFlags=0,e.deletions=null),!l&&(t=t.sibling,t!==null)){U=t;return}U=t=e}while(t!==null);I=6,U=null}function ys(t,l,e,a,n,u,i,c,f){t.cancelPendingCommit=null;do Ku();while(it!==0);if((q&6)!==0)throw Error(S(327));if(l!==null){if(l===t.current)throw Error(S(177));if(u=l.lanes|l.childLanes,u|=tf,Gr(t,e,u,i,c,f),t===Q&&(U=Q=null,R=0),ua=l,kl=t,Tl=e,Lc=u,Dc=n,km=a,(l.subtreeFlags&10256)!==0||(l.flags&10256)!==0?(t.callbackNode=null,t.callbackPriority=0,oy(iu,function(){return i0(),null})):(t.callbackNode=null,t.callbackPriority=0),a=(l.flags&13878)!==0,(l.subtreeFlags&13878)!==0||a){a=O.T,O.T=null,n=B.p,B.p=2,i=q,q|=4;try{ty(t,l,e)}finally{q=i,B.p=n,O.T=a}}it=1,e0(),a0(),n0()}}function e0(){if(it===1){it=0;var t=kl,l=ua,e=(l.flags&13878)!==0;if((l.subtreeFlags&13878)!==0||e){e=O.T,O.T=null;var a=B.p;B.p=2;var n=q;q|=4;try{Xm(l,t);var u=Hc,i=bo(t.containerInfo),c=u.focusedElem,f=u.selectionRange;if(i!==c&&c&&c.ownerDocument&&po(c.ownerDocument.documentElement,c)){if(f!==null&&Pc(c)){var d=f.start,v=f.end;if(v===void 0&&(v=d),"selectionStart"in c)c.selectionStart=d,c.selectionEnd=Math.min(v,c.value.length);else{var g=c.ownerDocument||document,r=g&&g.defaultView||window;if(r.getSelection){var y=r.getSelection(),p=c.textContent.length,A=Math.min(f.start,p),C=f.end===void 0?A:Math.min(f.end,p);!y.extend&&A>C&&(i=C,C=A,A=i);var o=qd(c,A),s=qd(c,C);if(o&&s&&(y.rangeCount!==1||y.anchorNode!==o.node||y.anchorOffset!==o.offset||y.focusNode!==s.node||y.focusOffset!==s.offset)){var m=g.createRange();m.setStart(o.node,o.offset),y.removeAllRanges(),A>C?(y.addRange(m),y.extend(s.node,s.offset)):(m.setEnd(s.node,s.offset),y.addRange(m))}}}}for(g=[],y=c;y=y.parentNode;)y.nodeType===1&&g.push({element:y,left:y.scrollLeft,top:y.scrollTop});for(typeof c.focus=="function"&&c.focus(),c=0;c<g.length;c++){var h=g[c];h.element.scrollLeft=h.left,h.element.scrollTop=h.top}}Nu=!!Rc,Hc=Rc=null}finally{q=n,B.p=a,O.T=e}}t.current=l,it=2}}function a0(){if(it===2){it=0;var t=kl,l=ua,e=(l.flags&8772)!==0;if((l.subtreeFlags&8772)!==0||e){e=O.T,O.T=null;var a=B.p;B.p=2;var n=q;q|=4;try{Hm(t,l.alternate,l)}finally{q=n,B.p=a,O.T=e}}it=3}}function n0(){if(it===4||it===3){it=0,xr();var t=kl,l=ua,e=Tl,a=km;(l.subtreeFlags&10256)!==0||(l.flags&10256)!==0?it=5:(it=0,ua=kl=null,u0(t,t.pendingLanes));var n=t.pendingLanes;if(n===0&&(Kl=null),Kc(e),l=l.stateNode,Ht&&typeof Ht.onCommitFiberRoot=="function")try{Ht.onCommitFiberRoot(fn,l,void 0,(l.current.flags&128)===128)}catch{}if(a!==null){l=O.T,n=B.p,B.p=2,O.T=null;try{for(var u=t.onRecoverableError,i=0;i<a.length;i++){var c=a[i];u(c.value,{componentStack:c.stack})}}finally{O.T=l,B.p=n}}(Tl&3)!==0&&Ku(),fl(t),n=t.pendingLanes,(e&261930)!==0&&(n&42)!==0?t===Nc?Za++:(Za=0,Nc=t):Za=0,hn(0,!1)}}function u0(t,l){(t.pooledCacheLanes&=l)===0&&(l=t.pooledCache,l!=null&&(t.pooledCache=null,rn(l)))}function Ku(){return e0(),a0(),n0(),i0()}function i0(){if(it!==5)return!1;var t=kl,l=Lc;Lc=0;var e=Kc(Tl),a=O.T,n=B.p;try{B.p=32>e?32:e,O.T=null,e=Dc,Dc=null;var u=kl,i=Tl;if(it=0,ua=kl=null,Tl=0,(q&6)!==0)throw Error(S(331));var c=q;if(q|=4,Zm(u.current),jm(u,u.current,i,e),q=c,hn(0,!1),Ht&&typeof Ht.onPostCommitFiberRoot=="function")try{Ht.onPostCommitFiberRoot(fn,u)}catch{}return!0}finally{B.p=n,O.T=a,u0(t,l)}}function vs(t,l,e){l=Vt(e,l),l=zc(t.stateNode,l,2),t=Vl(t,l,2),t!==null&&(sn(t,2),fl(t))}function X(t,l,e){if(t.tag===3)vs(t,t,e);else for(;l!==null;){if(l.tag===3){vs(l,t,e);break}else if(l.tag===1){var a=l.stateNode;if(typeof l.type.getDerivedStateFromError=="function"||typeof a.componentDidCatch=="function"&&(Kl===null||!Kl.has(a))){t=Vt(e,t),e=Em(2),a=Vl(l,e,2),a!==null&&(Tm(e,a,l,t),sn(a,2),fl(a));break}}l=l.return}}function ji(t,l,e){var a=t.pingCache;if(a===null){a=t.pingCache=new ay;var n=new Set;a.set(l,n)}else n=a.get(l),n===void 0&&(n=new Set,a.set(l,n));n.has(e)||(Lf=!0,n.add(e),t=fy.bind(null,t,l,e),l.then(t,t))}function fy(t,l,e){var a=t.pingCache;a!==null&&a.delete(l),t.pingedLanes|=t.suspendedLanes&e,t.warmLanes&=~e,Q===t&&(R&e)===e&&(I===4||I===3&&(R&62914560)===R&&300>Rt()-wu?(q&2)===0&&ia(t,0):Df|=e,na===R&&(na=0)),fl(t)}function c0(t,l){l===0&&(l=Fs()),t=Te(t,l),t!==null&&(sn(t,l),fl(t))}function dy(t){var l=t.memoizedState,e=0;l!==null&&(e=l.retryLane),c0(t,e)}function sy(t,l){var e=0;switch(t.tag){case 31:case 13:var a=t.stateNode,n=t.memoizedState;n!==null&&(e=n.retryLane);break;case 19:a=t.stateNode;break;case 22:a=t.stateNode._retryCache;break;default:throw Error(S(314))}a!==null&&a.delete(l),c0(t,e)}function oy(t,l){return Zc(t,l)}var zu=null,Ue=null,xc=!1,Au=!1,Qi=!1,jl=0;function fl(t){t!==Ue&&t.next===null&&(Ue===null?zu=Ue=t:Ue=Ue.next=t),Au=!0,xc||(xc=!0,ry())}function hn(t,l){if(!Qi&&Au){Qi=!0;do for(var e=!1,a=zu;a!==null;){if(!l)if(t!==0){var n=a.pendingLanes;if(n===0)var u=0;else{var i=a.suspendedLanes,c=a.pingedLanes;u=(1<<31-Ct(42|t)+1)-1,u&=n&~(i&~c),u=u&201326741?u&201326741|1:u?u|2:0}u!==0&&(e=!0,hs(a,u))}else u=R,u=Uu(a,a===Q?u:0,a.cancelPendingCommit!==null||a.timeoutHandle!==-1),(u&3)===0||dn(a,u)||(e=!0,hs(a,u));a=a.next}while(e);Qi=!1}}function my(){f0()}function f0(){Au=xc=!1;var t=0;jl!==0&&Ey()&&(t=jl);for(var l=Rt(),e=null,a=zu;a!==null;){var n=a.next,u=d0(a,l);u===0?(a.next=null,e===null?zu=n:e.next=n,n===null&&(Ue=e)):(e=a,(t!==0||(u&3)!==0)&&(Au=!0)),a=n}it!==0&&it!==5||hn(t,!1),jl!==0&&(jl=0)}function d0(t,l){for(var e=t.suspendedLanes,a=t.pingedLanes,n=t.expirationTimes,u=t.pendingLanes&-62914561;0<u;){var i=31-Ct(u),c=1<<i,f=n[i];f===-1?((c&e)===0||(c&a)!==0)&&(n[i]=Xr(c,l)):f<=l&&(t.expiredLanes|=c),u&=~c}if(l=Q,e=R,e=Uu(t,t===l?e:0,t.cancelPendingCommit!==null||t.timeoutHandle!==-1),a=t.callbackNode,e===0||t===l&&(Y===2||Y===9)||t.cancelPendingCommit!==null)return a!==null&&a!==null&&gi(a),t.callbackNode=null,t.callbackPriority=0;if((e&3)===0||dn(t,e)){if(l=e&-e,l===t.callbackPriority)return l;switch(a!==null&&gi(a),Kc(e)){case 2:case 8:e=Ws;break;case 32:e=iu;break;case 268435456:e=$s;break;default:e=iu}return a=s0.bind(null,t),e=Zc(e,a),t.callbackPriority=l,t.callbackNode=e,l}return a!==null&&a!==null&&gi(a),t.callbackPriority=2,t.callbackNode=null,2}function s0(t,l){if(it!==0&&it!==5)return t.callbackNode=null,t.callbackPriority=0,null;var e=t.callbackNode;if(Ku()&&t.callbackNode!==e)return null;var a=R;return a=Uu(t,t===Q?a:0,t.cancelPendingCommit!==null||t.timeoutHandle!==-1),a===0?null:(Wm(t,a,l),d0(t,Rt()),t.callbackNode!=null&&t.callbackNode===e?s0.bind(null,t):null)}function hs(t,l){if(Ku())return null;Wm(t,l,!0)}function ry(){zy(function(){(q&6)!==0?Zc(Js,my):f0()})}function xf(){if(jl===0){var t=la;t===0&&(t=_n,_n<<=1,(_n&261888)===0&&(_n=256)),jl=t}return jl}function gs(t){return t==null||typeof t=="symbol"||typeof t=="boolean"?null:typeof t=="function"?t:wn(""+t)}function Ss(t,l){var e=l.ownerDocument.createElement("input");return e.name=l.name,e.value=l.value,t.id&&e.setAttribute("form",t.id),l.parentNode.insertBefore(e,l),t=new FormData(t),e.parentNode.removeChild(e),t}function yy(t,l,e,a,n){if(l==="submit"&&e&&e.stateNode===n){var u=gs((n[Ot]||null).action),i=a.submitter;i&&(l=(l=i[Ot]||null)?gs(l.formAction):i.getAttribute("formAction"),l!==null&&(u=l,i=null));var c=new Ru("action","action",null,a,n);t.push({event:c,listeners:[{instance:null,listener:function(){if(a.defaultPrevented){if(jl!==0){var f=i?Ss(n,i):new FormData(n);Ec(e,{pending:!0,data:f,method:n.method,action:u},null,f)}}else typeof u=="function"&&(c.preventDefault(),f=i?Ss(n,i):new FormData(n),Ec(e,{pending:!0,data:f,method:n.method,action:u},u,f))},currentTarget:n}]})}}for(Bn=0;Bn<dc.length;Bn++)Yn=dc[Bn],ps=Yn.toLowerCase(),bs=Yn[0].toUpperCase()+Yn.slice(1),It(ps,"on"+bs);var Yn,ps,bs,Bn;It(To,"onAnimationEnd");It(zo,"onAnimationIteration");It(Ao,"onAnimationStart");It("dblclick","onDoubleClick");It("focusin","onFocus");It("focusout","onBlur");It(U1,"onTransitionRun");It(R1,"onTransitionStart");It(H1,"onTransitionCancel");It(_o,"onTransitionEnd");Pe("onMouseEnter",["mouseout","mouseover"]);Pe("onMouseLeave",["mouseout","mouseover"]);Pe("onPointerEnter",["pointerout","pointerover"]);Pe("onPointerLeave",["pointerout","pointerover"]);pe("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));pe("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));pe("onBeforeInput",["compositionend","keypress","textInput","paste"]);pe("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));pe("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));pe("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));var ln="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),vy=new Set("beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(ln));function o0(t,l){l=(l&4)!==0;for(var e=0;e<t.length;e++){var a=t[e],n=a.event;a=a.listeners;t:{var u=void 0;if(l)for(var i=a.length-1;0<=i;i--){var c=a[i],f=c.instance,d=c.currentTarget;if(c=c.listener,f!==u&&n.isPropagationStopped())break t;u=c,n.currentTarget=d;try{u(n)}catch(v){fu(v)}n.currentTarget=null,u=f}else for(i=0;i<a.length;i++){if(c=a[i],f=c.instance,d=c.currentTarget,c=c.listener,f!==u&&n.isPropagationStopped())break t;u=c,n.currentTarget=d;try{u(n)}catch(v){fu(v)}n.currentTarget=null,u=f}}}}function x(t,l){var e=l[lc];e===void 0&&(e=l[lc]=new Set);var a=t+"__bubble";e.has(a)||(m0(l,t,2,!1),e.add(a))}function wi(t,l,e){var a=0;l&&(a|=4),m0(e,t,a,l)}var Xn="_reactListening"+Math.random().toString(36).slice(2);function Uf(t){if(!t[Xn]){t[Xn]=!0,eo.forEach(function(e){e!=="selectionchange"&&(vy.has(e)||wi(e,!1,t),wi(e,!0,t))});var l=t.nodeType===9?t:t.ownerDocument;l===null||l[Xn]||(l[Xn]=!0,wi("selectionchange",!1,l))}}function m0(t,l,e,a){switch(_0(l)){case 2:var n=wy;break;case 8:n=Zy;break;default:n=qf}e=n.bind(null,l,e,t),n=void 0,!ic||l!=="touchstart"&&l!=="touchmove"&&l!=="wheel"||(n=!0),a?n!==void 0?t.addEventListener(l,e,{capture:!0,passive:n}):t.addEventListener(l,e,!0):n!==void 0?t.addEventListener(l,e,{passive:n}):t.addEventListener(l,e,!1)}function Zi(t,l,e,a,n){var u=a;if((l&1)===0&&(l&2)===0&&a!==null)t:for(;;){if(a===null)return;var i=a.tag;if(i===3||i===4){var c=a.stateNode.containerInfo;if(c===n)break;if(i===4)for(i=a.return;i!==null;){var f=i.tag;if((f===3||f===4)&&i.stateNode.containerInfo===n)return;i=i.return}for(;c!==null;){if(i=Ce(c),i===null)return;if(f=i.tag,f===5||f===6||f===26||f===27){a=u=i;continue t}c=c.parentNode}}a=a.return}oo(function(){var d=u,v=Wc(e),g=[];t:{var r=Oo.get(t);if(r!==void 0){var y=Ru,p=t;switch(t){case"keypress":if(Vn(e)===0)break t;case"keydown":case"keyup":y=s1;break;case"focusin":p="focus",y=Ti;break;case"focusout":p="blur",y=Ti;break;case"beforeblur":case"afterblur":y=Ti;break;case"click":if(e.button===2)break t;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":y=Md;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":y=Ir;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":y=r1;break;case To:case zo:case Ao:y=l1;break;case _o:y=v1;break;case"scroll":case"scrollend":y=$r;break;case"wheel":y=g1;break;case"copy":case"cut":case"paste":y=a1;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":y=Dd;break;case"toggle":case"beforetoggle":y=p1}var A=(l&4)!==0,C=!A&&(t==="scroll"||t==="scrollend"),o=A?r!==null?r+"Capture":null:r;A=[];for(var s=d,m;s!==null;){var h=s;if(m=h.stateNode,h=h.tag,h!==5&&h!==26&&h!==27||m===null||o===null||(h=ka(s,o),h!=null&&A.push(en(s,h,m))),C)break;s=s.return}0<A.length&&(r=new y(r,p,null,e,v),g.push({event:r,listeners:A}))}}if((l&7)===0){t:{if(r=t==="mouseover"||t==="pointerover",y=t==="mouseout"||t==="pointerout",r&&e!==uc&&(p=e.relatedTarget||e.fromElement)&&(Ce(p)||p[da]))break t;if((y||r)&&(r=v.window===v?v:(r=v.ownerDocument)?r.defaultView||r.parentWindow:window,y?(p=e.relatedTarget||e.toElement,y=d,p=p?Ce(p):null,p!==null&&(C=cn(p),A=p.tag,p!==C||A!==5&&A!==27&&A!==6)&&(p=null)):(y=null,p=d),y!==p)){if(A=Md,h="onMouseLeave",o="onMouseEnter",s="mouse",(t==="pointerout"||t==="pointerover")&&(A=Dd,h="onPointerLeave",o="onPointerEnter",s="pointer"),C=y==null?r:Na(y),m=p==null?r:Na(p),r=new A(h,s+"leave",y,e,v),r.target=C,r.relatedTarget=m,h=null,Ce(v)===d&&(A=new A(o,s+"enter",p,e,v),A.target=m,A.relatedTarget=C,h=A),C=h,y&&p)l:{for(A=hy,o=y,s=p,m=0,h=o;h;h=A(h))m++;h=0;for(var T=s;T;T=A(T))h++;for(;0<m-h;)o=A(o),m--;for(;0<h-m;)s=A(s),h--;for(;m--;){if(o===s||s!==null&&o===s.alternate){A=o;break l}o=A(o),s=A(s)}A=null}else A=null;y!==null&&Es(g,r,y,A,!1),p!==null&&C!==null&&Es(g,C,p,A,!0)}}t:{if(r=d?Na(d):window,y=r.nodeName&&r.nodeName.toLowerCase(),y==="select"||y==="input"&&r.type==="file")var E=Rd;else if(Ud(r))if(go)E=D1;else{E=M1;var b=O1}else y=r.nodeName,!y||y.toLowerCase()!=="input"||r.type!=="checkbox"&&r.type!=="radio"?d&&Jc(d.elementType)&&(E=Rd):E=L1;if(E&&(E=E(t,d))){ho(g,E,e,v);break t}b&&b(t,r,d),t==="focusout"&&d&&r.type==="number"&&d.memoizedProps.value!=null&&nc(r,"number",r.value)}switch(b=d?Na(d):window,t){case"focusin":(Ud(b)||b.contentEditable==="true")&&(Ye=b,cc=d,Ca=null);break;case"focusout":Ca=cc=Ye=null;break;case"mousedown":fc=!0;break;case"contextmenu":case"mouseup":case"dragend":fc=!1,Bd(g,e,v);break;case"selectionchange":if(x1)break;case"keydown":case"keyup":Bd(g,e,v)}var _;if(Ic)t:{switch(t){case"compositionstart":var D="onCompositionStart";break t;case"compositionend":D="onCompositionEnd";break t;case"compositionupdate":D="onCompositionUpdate";break t}D=void 0}else Be?yo(t,e)&&(D="onCompositionEnd"):t==="keydown"&&e.keyCode===229&&(D="onCompositionStart");D&&(ro&&e.locale!=="ko"&&(Be||D!=="onCompositionStart"?D==="onCompositionEnd"&&Be&&(_=mo()):(Yl=v,$c="value"in Yl?Yl.value:Yl.textContent,Be=!0)),b=_u(d,D),0<b.length&&(D=new Ld(D,t,null,e,v),g.push({event:D,listeners:b}),_?D.data=_:(_=vo(e),_!==null&&(D.data=_)))),(_=E1?T1(t,e):z1(t,e))&&(D=_u(d,"onBeforeInput"),0<D.length&&(b=new Ld("onBeforeInput","beforeinput",null,e,v),g.push({event:b,listeners:D}),b.data=_)),yy(g,t,d,e,v)}o0(g,l)})}function en(t,l,e){return{instance:t,listener:l,currentTarget:e}}function _u(t,l){for(var e=l+"Capture",a=[];t!==null;){var n=t,u=n.stateNode;if(n=n.tag,n!==5&&n!==26&&n!==27||u===null||(n=ka(t,e),n!=null&&a.unshift(en(t,n,u)),n=ka(t,l),n!=null&&a.push(en(t,n,u))),t.tag===3)return a;t=t.return}return[]}function hy(t){if(t===null)return null;do t=t.return;while(t&&t.tag!==5&&t.tag!==27);return t||null}function Es(t,l,e,a,n){for(var u=l._reactName,i=[];e!==null&&e!==a;){var c=e,f=c.alternate,d=c.stateNode;if(c=c.tag,f!==null&&f===a)break;c!==5&&c!==26&&c!==27||d===null||(f=d,n?(d=ka(e,u),d!=null&&i.unshift(en(e,d,f))):n||(d=ka(e,u),d!=null&&i.push(en(e,d,f)))),e=e.return}i.length!==0&&t.push({event:l,listeners:i})}var gy=/\\r\\n?/g,Sy=/\\u0000|\\uFFFD/g;function Ts(t){return(typeof t=="string"?t:""+t).replace(gy,`\n`).replace(Sy,"")}function r0(t,l){return l=Ts(l),Ts(t)===l}function G(t,l,e,a,n,u){switch(e){case"children":typeof a=="string"?l==="body"||l==="textarea"&&a===""||ta(t,a):(typeof a=="number"||typeof a=="bigint")&&l!=="body"&&ta(t,""+a);break;case"className":Ln(t,"class",a);break;case"tabIndex":Ln(t,"tabindex",a);break;case"dir":case"role":case"viewBox":case"width":case"height":Ln(t,e,a);break;case"style":so(t,a,u);break;case"data":if(l!=="object"){Ln(t,"data",a);break}case"src":case"href":if(a===""&&(l!=="a"||e!=="href")){t.removeAttribute(e);break}if(a==null||typeof a=="function"||typeof a=="symbol"||typeof a=="boolean"){t.removeAttribute(e);break}a=wn(""+a),t.setAttribute(e,a);break;case"action":case"formAction":if(typeof a=="function"){t.setAttribute(e,"javascript:throw new Error(\'A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\\\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().\')");break}else typeof u=="function"&&(e==="formAction"?(l!=="input"&&G(t,l,"name",n.name,n,null),G(t,l,"formEncType",n.formEncType,n,null),G(t,l,"formMethod",n.formMethod,n,null),G(t,l,"formTarget",n.formTarget,n,null)):(G(t,l,"encType",n.encType,n,null),G(t,l,"method",n.method,n,null),G(t,l,"target",n.target,n,null)));if(a==null||typeof a=="symbol"||typeof a=="boolean"){t.removeAttribute(e);break}a=wn(""+a),t.setAttribute(e,a);break;case"onClick":a!=null&&(t.onclick=Sl);break;case"onScroll":a!=null&&x("scroll",t);break;case"onScrollEnd":a!=null&&x("scrollend",t);break;case"dangerouslySetInnerHTML":if(a!=null){if(typeof a!="object"||!("__html"in a))throw Error(S(61));if(e=a.__html,e!=null){if(n.children!=null)throw Error(S(60));t.innerHTML=e}}break;case"multiple":t.multiple=a&&typeof a!="function"&&typeof a!="symbol";break;case"muted":t.muted=a&&typeof a!="function"&&typeof a!="symbol";break;case"suppressContentEditableWarning":case"suppressHydrationWarning":case"defaultValue":case"defaultChecked":case"innerHTML":case"ref":break;case"autoFocus":break;case"xlinkHref":if(a==null||typeof a=="function"||typeof a=="boolean"||typeof a=="symbol"){t.removeAttribute("xlink:href");break}e=wn(""+a),t.setAttributeNS("http://www.w3.org/1999/xlink","xlink:href",e);break;case"contentEditable":case"spellCheck":case"draggable":case"value":case"autoReverse":case"externalResourcesRequired":case"focusable":case"preserveAlpha":a!=null&&typeof a!="function"&&typeof a!="symbol"?t.setAttribute(e,""+a):t.removeAttribute(e);break;case"inert":case"allowFullScreen":case"async":case"autoPlay":case"controls":case"default":case"defer":case"disabled":case"disablePictureInPicture":case"disableRemotePlayback":case"formNoValidate":case"hidden":case"loop":case"noModule":case"noValidate":case"open":case"playsInline":case"readOnly":case"required":case"reversed":case"scoped":case"seamless":case"itemScope":a&&typeof a!="function"&&typeof a!="symbol"?t.setAttribute(e,""):t.removeAttribute(e);break;case"capture":case"download":a===!0?t.setAttribute(e,""):a!==!1&&a!=null&&typeof a!="function"&&typeof a!="symbol"?t.setAttribute(e,a):t.removeAttribute(e);break;case"cols":case"rows":case"size":case"span":a!=null&&typeof a!="function"&&typeof a!="symbol"&&!isNaN(a)&&1<=a?t.setAttribute(e,a):t.removeAttribute(e);break;case"rowSpan":case"start":a==null||typeof a=="function"||typeof a=="symbol"||isNaN(a)?t.removeAttribute(e):t.setAttribute(e,a);break;case"popover":x("beforetoggle",t),x("toggle",t),Qn(t,"popover",a);break;case"xlinkActuate":sl(t,"http://www.w3.org/1999/xlink","xlink:actuate",a);break;case"xlinkArcrole":sl(t,"http://www.w3.org/1999/xlink","xlink:arcrole",a);break;case"xlinkRole":sl(t,"http://www.w3.org/1999/xlink","xlink:role",a);break;case"xlinkShow":sl(t,"http://www.w3.org/1999/xlink","xlink:show",a);break;case"xlinkTitle":sl(t,"http://www.w3.org/1999/xlink","xlink:title",a);break;case"xlinkType":sl(t,"http://www.w3.org/1999/xlink","xlink:type",a);break;case"xmlBase":sl(t,"http://www.w3.org/XML/1998/namespace","xml:base",a);break;case"xmlLang":sl(t,"http://www.w3.org/XML/1998/namespace","xml:lang",a);break;case"xmlSpace":sl(t,"http://www.w3.org/XML/1998/namespace","xml:space",a);break;case"is":Qn(t,"is",a);break;case"innerText":case"textContent":break;default:(!(2<e.length)||e[0]!=="o"&&e[0]!=="O"||e[1]!=="n"&&e[1]!=="N")&&(e=Jr.get(e)||e,Qn(t,e,a))}}function Uc(t,l,e,a,n,u){switch(e){case"style":so(t,a,u);break;case"dangerouslySetInnerHTML":if(a!=null){if(typeof a!="object"||!("__html"in a))throw Error(S(61));if(e=a.__html,e!=null){if(n.children!=null)throw Error(S(60));t.innerHTML=e}}break;case"children":typeof a=="string"?ta(t,a):(typeof a=="number"||typeof a=="bigint")&&ta(t,""+a);break;case"onScroll":a!=null&&x("scroll",t);break;case"onScrollEnd":a!=null&&x("scrollend",t);break;case"onClick":a!=null&&(t.onclick=Sl);break;case"suppressContentEditableWarning":case"suppressHydrationWarning":case"innerHTML":case"ref":break;case"innerText":case"textContent":break;default:if(!ao.hasOwnProperty(e))t:{if(e[0]==="o"&&e[1]==="n"&&(n=e.endsWith("Capture"),l=e.slice(2,n?e.length-7:void 0),u=t[Ot]||null,u=u!=null?u[e]:null,typeof u=="function"&&t.removeEventListener(l,u,n),typeof a=="function")){typeof u!="function"&&u!==null&&(e in t?t[e]=null:t.hasAttribute(e)&&t.removeAttribute(e)),t.addEventListener(l,a,n);break t}e in t?t[e]=a:a===!0?t.setAttribute(e,""):Qn(t,e,a)}}}function ht(t,l,e){switch(l){case"div":case"span":case"svg":case"path":case"a":case"g":case"p":case"li":break;case"img":x("error",t),x("load",t);var a=!1,n=!1,u;for(u in e)if(e.hasOwnProperty(u)){var i=e[u];if(i!=null)switch(u){case"src":a=!0;break;case"srcSet":n=!0;break;case"children":case"dangerouslySetInnerHTML":throw Error(S(137,l));default:G(t,l,u,i,e,null)}}n&&G(t,l,"srcSet",e.srcSet,e,null),a&&G(t,l,"src",e.src,e,null);return;case"input":x("invalid",t);var c=u=i=n=null,f=null,d=null;for(a in e)if(e.hasOwnProperty(a)){var v=e[a];if(v!=null)switch(a){case"name":n=v;break;case"type":i=v;break;case"checked":f=v;break;case"defaultChecked":d=v;break;case"value":u=v;break;case"defaultValue":c=v;break;case"children":case"dangerouslySetInnerHTML":if(v!=null)throw Error(S(137,l));break;default:G(t,l,a,v,e,null)}}io(t,u,c,f,d,i,n,!1);return;case"select":x("invalid",t),a=i=u=null;for(n in e)if(e.hasOwnProperty(n)&&(c=e[n],c!=null))switch(n){case"value":u=c;break;case"defaultValue":i=c;break;case"multiple":a=c;default:G(t,l,n,c,e,null)}l=u,e=i,t.multiple=!!a,l!=null?Ke(t,!!a,l,!1):e!=null&&Ke(t,!!a,e,!0);return;case"textarea":x("invalid",t),u=n=a=null;for(i in e)if(e.hasOwnProperty(i)&&(c=e[i],c!=null))switch(i){case"value":a=c;break;case"defaultValue":n=c;break;case"children":u=c;break;case"dangerouslySetInnerHTML":if(c!=null)throw Error(S(91));break;default:G(t,l,i,c,e,null)}fo(t,a,n,u);return;case"option":for(f in e)e.hasOwnProperty(f)&&(a=e[f],a!=null)&&(f==="selected"?t.selected=a&&typeof a!="function"&&typeof a!="symbol":G(t,l,f,a,e,null));return;case"dialog":x("beforetoggle",t),x("toggle",t),x("cancel",t),x("close",t);break;case"iframe":case"object":x("load",t);break;case"video":case"audio":for(a=0;a<ln.length;a++)x(ln[a],t);break;case"image":x("error",t),x("load",t);break;case"details":x("toggle",t);break;case"embed":case"source":case"link":x("error",t),x("load",t);case"area":case"base":case"br":case"col":case"hr":case"keygen":case"meta":case"param":case"track":case"wbr":case"menuitem":for(d in e)if(e.hasOwnProperty(d)&&(a=e[d],a!=null))switch(d){case"children":case"dangerouslySetInnerHTML":throw Error(S(137,l));default:G(t,l,d,a,e,null)}return;default:if(Jc(l)){for(v in e)e.hasOwnProperty(v)&&(a=e[v],a!==void 0&&Uc(t,l,v,a,e,void 0));return}}for(c in e)e.hasOwnProperty(c)&&(a=e[c],a!=null&&G(t,l,c,a,e,null))}function py(t,l,e,a){switch(l){case"div":case"span":case"svg":case"path":case"a":case"g":case"p":case"li":break;case"input":var n=null,u=null,i=null,c=null,f=null,d=null,v=null;for(y in e){var g=e[y];if(e.hasOwnProperty(y)&&g!=null)switch(y){case"checked":break;case"value":break;case"defaultValue":f=g;default:a.hasOwnProperty(y)||G(t,l,y,null,a,g)}}for(var r in a){var y=a[r];if(g=e[r],a.hasOwnProperty(r)&&(y!=null||g!=null))switch(r){case"type":u=y;break;case"name":n=y;break;case"checked":d=y;break;case"defaultChecked":v=y;break;case"value":i=y;break;case"defaultValue":c=y;break;case"children":case"dangerouslySetInnerHTML":if(y!=null)throw Error(S(137,l));break;default:y!==g&&G(t,l,r,y,a,g)}}ac(t,i,c,f,d,v,u,n);return;case"select":y=i=c=r=null;for(u in e)if(f=e[u],e.hasOwnProperty(u)&&f!=null)switch(u){case"value":break;case"multiple":y=f;default:a.hasOwnProperty(u)||G(t,l,u,null,a,f)}for(n in a)if(u=a[n],f=e[n],a.hasOwnProperty(n)&&(u!=null||f!=null))switch(n){case"value":r=u;break;case"defaultValue":c=u;break;case"multiple":i=u;default:u!==f&&G(t,l,n,u,a,f)}l=c,e=i,a=y,r!=null?Ke(t,!!e,r,!1):!!a!=!!e&&(l!=null?Ke(t,!!e,l,!0):Ke(t,!!e,e?[]:"",!1));return;case"textarea":y=r=null;for(c in e)if(n=e[c],e.hasOwnProperty(c)&&n!=null&&!a.hasOwnProperty(c))switch(c){case"value":break;case"children":break;default:G(t,l,c,null,a,n)}for(i in a)if(n=a[i],u=e[i],a.hasOwnProperty(i)&&(n!=null||u!=null))switch(i){case"value":r=n;break;case"defaultValue":y=n;break;case"children":break;case"dangerouslySetInnerHTML":if(n!=null)throw Error(S(91));break;default:n!==u&&G(t,l,i,n,a,u)}co(t,r,y);return;case"option":for(var p in e)r=e[p],e.hasOwnProperty(p)&&r!=null&&!a.hasOwnProperty(p)&&(p==="selected"?t.selected=!1:G(t,l,p,null,a,r));for(f in a)r=a[f],y=e[f],a.hasOwnProperty(f)&&r!==y&&(r!=null||y!=null)&&(f==="selected"?t.selected=r&&typeof r!="function"&&typeof r!="symbol":G(t,l,f,r,a,y));return;case"img":case"link":case"area":case"base":case"br":case"col":case"embed":case"hr":case"keygen":case"meta":case"param":case"source":case"track":case"wbr":case"menuitem":for(var A in e)r=e[A],e.hasOwnProperty(A)&&r!=null&&!a.hasOwnProperty(A)&&G(t,l,A,null,a,r);for(d in a)if(r=a[d],y=e[d],a.hasOwnProperty(d)&&r!==y&&(r!=null||y!=null))switch(d){case"children":case"dangerouslySetInnerHTML":if(r!=null)throw Error(S(137,l));break;default:G(t,l,d,r,a,y)}return;default:if(Jc(l)){for(var C in e)r=e[C],e.hasOwnProperty(C)&&r!==void 0&&!a.hasOwnProperty(C)&&Uc(t,l,C,void 0,a,r);for(v in a)r=a[v],y=e[v],!a.hasOwnProperty(v)||r===y||r===void 0&&y===void 0||Uc(t,l,v,r,a,y);return}}for(var o in e)r=e[o],e.hasOwnProperty(o)&&r!=null&&!a.hasOwnProperty(o)&&G(t,l,o,null,a,r);for(g in a)r=a[g],y=e[g],!a.hasOwnProperty(g)||r===y||r==null&&y==null||G(t,l,g,r,a,y)}function zs(t){switch(t){case"css":case"script":case"font":case"img":case"image":case"input":case"link":return!0;default:return!1}}function by(){if(typeof performance.getEntriesByType=="function"){for(var t=0,l=0,e=performance.getEntriesByType("resource"),a=0;a<e.length;a++){var n=e[a],u=n.transferSize,i=n.initiatorType,c=n.duration;if(u&&c&&zs(i)){for(i=0,c=n.responseEnd,a+=1;a<e.length;a++){var f=e[a],d=f.startTime;if(d>c)break;var v=f.transferSize,g=f.initiatorType;v&&zs(g)&&(f=f.responseEnd,i+=v*(f<c?1:(c-d)/(f-d)))}if(--a,l+=8*(u+i)/(n.duration/1e3),t++,10<t)break}}if(0<t)return l/t/1e6}return navigator.connection&&(t=navigator.connection.downlink,typeof t=="number")?t:5}var Rc=null,Hc=null;function Ou(t){return t.nodeType===9?t:t.ownerDocument}function As(t){switch(t){case"http://www.w3.org/2000/svg":return 1;case"http://www.w3.org/1998/Math/MathML":return 2;default:return 0}}function y0(t,l){if(t===0)switch(l){case"svg":return 1;case"math":return 2;default:return 0}return t===1&&l==="foreignObject"?0:t}function Cc(t,l){return t==="textarea"||t==="noscript"||typeof l.children=="string"||typeof l.children=="number"||typeof l.children=="bigint"||typeof l.dangerouslySetInnerHTML=="object"&&l.dangerouslySetInnerHTML!==null&&l.dangerouslySetInnerHTML.__html!=null}var Vi=null;function Ey(){var t=window.event;return t&&t.type==="popstate"?t===Vi?!1:(Vi=t,!0):(Vi=null,!1)}var v0=typeof setTimeout=="function"?setTimeout:void 0,Ty=typeof clearTimeout=="function"?clearTimeout:void 0,_s=typeof Promise=="function"?Promise:void 0,zy=typeof queueMicrotask=="function"?queueMicrotask:typeof _s<"u"?function(t){return _s.resolve(null).then(t).catch(Ay)}:v0;function Ay(t){setTimeout(function(){throw t})}function ee(t){return t==="head"}function Os(t,l){var e=l,a=0;do{var n=e.nextSibling;if(t.removeChild(e),n&&n.nodeType===8)if(e=n.data,e==="/$"||e==="/&"){if(a===0){t.removeChild(n),fa(l);return}a--}else if(e==="$"||e==="$?"||e==="$~"||e==="$!"||e==="&")a++;else if(e==="html")Va(t.ownerDocument.documentElement);else if(e==="head"){e=t.ownerDocument.head,Va(e);for(var u=e.firstChild;u;){var i=u.nextSibling,c=u.nodeName;u[on]||c==="SCRIPT"||c==="STYLE"||c==="LINK"&&u.rel.toLowerCase()==="stylesheet"||e.removeChild(u),u=i}}else e==="body"&&Va(t.ownerDocument.body);e=n}while(e);fa(l)}function Ms(t,l){var e=t;t=0;do{var a=e.nextSibling;if(e.nodeType===1?l?(e._stashedDisplay=e.style.display,e.style.display="none"):(e.style.display=e._stashedDisplay||"",e.getAttribute("style")===""&&e.removeAttribute("style")):e.nodeType===3&&(l?(e._stashedText=e.nodeValue,e.nodeValue=""):e.nodeValue=e._stashedText||""),a&&a.nodeType===8)if(e=a.data,e==="/$"){if(t===0)break;t--}else e!=="$"&&e!=="$?"&&e!=="$~"&&e!=="$!"||t++;e=a}while(e)}function qc(t){var l=t.firstChild;for(l&&l.nodeType===10&&(l=l.nextSibling);l;){var e=l;switch(l=l.nextSibling,e.nodeName){case"HTML":case"HEAD":case"BODY":qc(e),kc(e);continue;case"SCRIPT":case"STYLE":continue;case"LINK":if(e.rel.toLowerCase()==="stylesheet")continue}t.removeChild(e)}}function _y(t,l,e,a){for(;t.nodeType===1;){var n=e;if(t.nodeName.toLowerCase()!==l.toLowerCase()){if(!a&&(t.nodeName!=="INPUT"||t.type!=="hidden"))break}else if(a){if(!t[on])switch(l){case"meta":if(!t.hasAttribute("itemprop"))break;return t;case"link":if(u=t.getAttribute("rel"),u==="stylesheet"&&t.hasAttribute("data-precedence"))break;if(u!==n.rel||t.getAttribute("href")!==(n.href==null||n.href===""?null:n.href)||t.getAttribute("crossorigin")!==(n.crossOrigin==null?null:n.crossOrigin)||t.getAttribute("title")!==(n.title==null?null:n.title))break;return t;case"style":if(t.hasAttribute("data-precedence"))break;return t;case"script":if(u=t.getAttribute("src"),(u!==(n.src==null?null:n.src)||t.getAttribute("type")!==(n.type==null?null:n.type)||t.getAttribute("crossorigin")!==(n.crossOrigin==null?null:n.crossOrigin))&&u&&t.hasAttribute("async")&&!t.hasAttribute("itemprop"))break;return t;default:return t}}else if(l==="input"&&t.type==="hidden"){var u=n.name==null?null:""+n.name;if(n.type==="hidden"&&t.getAttribute("name")===u)return t}else return t;if(t=Jt(t.nextSibling),t===null)break}return null}function Oy(t,l,e){if(l==="")return null;for(;t.nodeType!==3;)if((t.nodeType!==1||t.nodeName!=="INPUT"||t.type!=="hidden")&&!e||(t=Jt(t.nextSibling),t===null))return null;return t}function h0(t,l){for(;t.nodeType!==8;)if((t.nodeType!==1||t.nodeName!=="INPUT"||t.type!=="hidden")&&!l||(t=Jt(t.nextSibling),t===null))return null;return t}function Bc(t){return t.data==="$?"||t.data==="$~"}function Yc(t){return t.data==="$!"||t.data==="$?"&&t.ownerDocument.readyState!=="loading"}function My(t,l){var e=t.ownerDocument;if(t.data==="$~")t._reactRetry=l;else if(t.data!=="$?"||e.readyState!=="loading")l();else{var a=function(){l(),e.removeEventListener("DOMContentLoaded",a)};e.addEventListener("DOMContentLoaded",a),t._reactRetry=a}}function Jt(t){for(;t!=null;t=t.nextSibling){var l=t.nodeType;if(l===1||l===3)break;if(l===8){if(l=t.data,l==="$"||l==="$!"||l==="$?"||l==="$~"||l==="&"||l==="F!"||l==="F")break;if(l==="/$"||l==="/&")return null}}return t}var Xc=null;function Ls(t){t=t.nextSibling;for(var l=0;t;){if(t.nodeType===8){var e=t.data;if(e==="/$"||e==="/&"){if(l===0)return Jt(t.nextSibling);l--}else e!=="$"&&e!=="$!"&&e!=="$?"&&e!=="$~"&&e!=="&"||l++}t=t.nextSibling}return null}function Ds(t){t=t.previousSibling;for(var l=0;t;){if(t.nodeType===8){var e=t.data;if(e==="$"||e==="$!"||e==="$?"||e==="$~"||e==="&"){if(l===0)return t;l--}else e!=="/$"&&e!=="/&"||l++}t=t.previousSibling}return null}function g0(t,l,e){switch(l=Ou(e),t){case"html":if(t=l.documentElement,!t)throw Error(S(452));return t;case"head":if(t=l.head,!t)throw Error(S(453));return t;case"body":if(t=l.body,!t)throw Error(S(454));return t;default:throw Error(S(451))}}function Va(t){for(var l=t.attributes;l.length;)t.removeAttributeNode(l[0]);kc(t)}var Wt=new Map,Ns=new Set;function Mu(t){return typeof t.getRootNode=="function"?t.getRootNode():t.nodeType===9?t:t.ownerDocument}var Ll=B.d;B.d={f:Ly,r:Dy,D:Ny,C:xy,L:Uy,m:Ry,X:Cy,S:Hy,M:qy};function Ly(){var t=Ll.f(),l=Zu();return t||l}function Dy(t){var l=sa(t);l!==null&&l.tag===5&&l.type==="form"?sm(l):Ll.r(t)}var ya=typeof document>"u"?null:document;function S0(t,l,e){var a=ya;if(a&&typeof l=="string"&&l){var n=Zt(l);n=\'link[rel="\'+t+\'"][href="\'+n+\'"]\',typeof e=="string"&&(n+=\'[crossorigin="\'+e+\'"]\'),Ns.has(n)||(Ns.add(n),t={rel:t,crossOrigin:e,href:l},a.querySelector(n)===null&&(l=a.createElement("link"),ht(l,"link",t),st(l),a.head.appendChild(l)))}}function Ny(t){Ll.D(t),S0("dns-prefetch",t,null)}function xy(t,l){Ll.C(t,l),S0("preconnect",t,l)}function Uy(t,l,e){Ll.L(t,l,e);var a=ya;if(a&&t&&l){var n=\'link[rel="preload"][as="\'+Zt(l)+\'"]\';l==="image"&&e&&e.imageSrcSet?(n+=\'[imagesrcset="\'+Zt(e.imageSrcSet)+\'"]\',typeof e.imageSizes=="string"&&(n+=\'[imagesizes="\'+Zt(e.imageSizes)+\'"]\')):n+=\'[href="\'+Zt(t)+\'"]\';var u=n;switch(l){case"style":u=ca(t);break;case"script":u=va(t)}Wt.has(u)||(t=J({rel:"preload",href:l==="image"&&e&&e.imageSrcSet?void 0:t,as:l},e),Wt.set(u,t),a.querySelector(n)!==null||l==="style"&&a.querySelector(gn(u))||l==="script"&&a.querySelector(Sn(u))||(l=a.createElement("link"),ht(l,"link",t),st(l),a.head.appendChild(l)))}}function Ry(t,l){Ll.m(t,l);var e=ya;if(e&&t){var a=l&&typeof l.as=="string"?l.as:"script",n=\'link[rel="modulepreload"][as="\'+Zt(a)+\'"][href="\'+Zt(t)+\'"]\',u=n;switch(a){case"audioworklet":case"paintworklet":case"serviceworker":case"sharedworker":case"worker":case"script":u=va(t)}if(!Wt.has(u)&&(t=J({rel:"modulepreload",href:t},l),Wt.set(u,t),e.querySelector(n)===null)){switch(a){case"audioworklet":case"paintworklet":case"serviceworker":case"sharedworker":case"worker":case"script":if(e.querySelector(Sn(u)))return}a=e.createElement("link"),ht(a,"link",t),st(a),e.head.appendChild(a)}}}function Hy(t,l,e){Ll.S(t,l,e);var a=ya;if(a&&t){var n=Ve(a).hoistableStyles,u=ca(t);l=l||"default";var i=n.get(u);if(!i){var c={loading:0,preload:null};if(i=a.querySelector(gn(u)))c.loading=5;else{t=J({rel:"stylesheet",href:t,"data-precedence":l},e),(e=Wt.get(u))&&Rf(t,e);var f=i=a.createElement("link");st(f),ht(f,"link",t),f._p=new Promise(function(d,v){f.onload=d,f.onerror=v}),f.addEventListener("load",function(){c.loading|=1}),f.addEventListener("error",function(){c.loading|=2}),c.loading|=4,Pn(i,l,a)}i={type:"stylesheet",instance:i,count:1,state:c},n.set(u,i)}}}function Cy(t,l){Ll.X(t,l);var e=ya;if(e&&t){var a=Ve(e).hoistableScripts,n=va(t),u=a.get(n);u||(u=e.querySelector(Sn(n)),u||(t=J({src:t,async:!0},l),(l=Wt.get(n))&&Hf(t,l),u=e.createElement("script"),st(u),ht(u,"link",t),e.head.appendChild(u)),u={type:"script",instance:u,count:1,state:null},a.set(n,u))}}function qy(t,l){Ll.M(t,l);var e=ya;if(e&&t){var a=Ve(e).hoistableScripts,n=va(t),u=a.get(n);u||(u=e.querySelector(Sn(n)),u||(t=J({src:t,async:!0,type:"module"},l),(l=Wt.get(n))&&Hf(t,l),u=e.createElement("script"),st(u),ht(u,"link",t),e.head.appendChild(u)),u={type:"script",instance:u,count:1,state:null},a.set(n,u))}}function xs(t,l,e,a){var n=(n=Ql.current)?Mu(n):null;if(!n)throw Error(S(446));switch(t){case"meta":case"title":return null;case"style":return typeof e.precedence=="string"&&typeof e.href=="string"?(l=ca(e.href),e=Ve(n).hoistableStyles,a=e.get(l),a||(a={type:"style",instance:null,count:0,state:null},e.set(l,a)),a):{type:"void",instance:null,count:0,state:null};case"link":if(e.rel==="stylesheet"&&typeof e.href=="string"&&typeof e.precedence=="string"){t=ca(e.href);var u=Ve(n).hoistableStyles,i=u.get(t);if(i||(n=n.ownerDocument||n,i={type:"stylesheet",instance:null,count:0,state:{loading:0,preload:null}},u.set(t,i),(u=n.querySelector(gn(t)))&&!u._p&&(i.instance=u,i.state.loading=5),Wt.has(t)||(e={rel:"preload",as:"style",href:e.href,crossOrigin:e.crossOrigin,integrity:e.integrity,media:e.media,hrefLang:e.hrefLang,referrerPolicy:e.referrerPolicy},Wt.set(t,e),u||By(n,t,e,i.state))),l&&a===null)throw Error(S(528,""));return i}if(l&&a!==null)throw Error(S(529,""));return null;case"script":return l=e.async,e=e.src,typeof e=="string"&&l&&typeof l!="function"&&typeof l!="symbol"?(l=va(e),e=Ve(n).hoistableScripts,a=e.get(l),a||(a={type:"script",instance:null,count:0,state:null},e.set(l,a)),a):{type:"void",instance:null,count:0,state:null};default:throw Error(S(444,t))}}function ca(t){return\'href="\'+Zt(t)+\'"\'}function gn(t){return\'link[rel="stylesheet"][\'+t+"]"}function p0(t){return J({},t,{"data-precedence":t.precedence,precedence:null})}function By(t,l,e,a){t.querySelector(\'link[rel="preload"][as="style"][\'+l+"]")?a.loading=1:(l=t.createElement("link"),a.preload=l,l.addEventListener("load",function(){return a.loading|=1}),l.addEventListener("error",function(){return a.loading|=2}),ht(l,"link",e),st(l),t.head.appendChild(l))}function va(t){return\'[src="\'+Zt(t)+\'"]\'}function Sn(t){return"script[async]"+t}function Us(t,l,e){if(l.count++,l.instance===null)switch(l.type){case"style":var a=t.querySelector(\'style[data-href~="\'+Zt(e.href)+\'"]\');if(a)return l.instance=a,st(a),a;var n=J({},e,{"data-href":e.href,"data-precedence":e.precedence,href:null,precedence:null});return a=(t.ownerDocument||t).createElement("style"),st(a),ht(a,"style",n),Pn(a,e.precedence,t),l.instance=a;case"stylesheet":n=ca(e.href);var u=t.querySelector(gn(n));if(u)return l.state.loading|=4,l.instance=u,st(u),u;a=p0(e),(n=Wt.get(n))&&Rf(a,n),u=(t.ownerDocument||t).createElement("link"),st(u);var i=u;return i._p=new Promise(function(c,f){i.onload=c,i.onerror=f}),ht(u,"link",a),l.state.loading|=4,Pn(u,e.precedence,t),l.instance=u;case"script":return u=va(e.src),(n=t.querySelector(Sn(u)))?(l.instance=n,st(n),n):(a=e,(n=Wt.get(u))&&(a=J({},e),Hf(a,n)),t=t.ownerDocument||t,n=t.createElement("script"),st(n),ht(n,"link",a),t.head.appendChild(n),l.instance=n);case"void":return null;default:throw Error(S(443,l.type))}else l.type==="stylesheet"&&(l.state.loading&4)===0&&(a=l.instance,l.state.loading|=4,Pn(a,e.precedence,t));return l.instance}function Pn(t,l,e){for(var a=e.querySelectorAll(\'link[rel="stylesheet"][data-precedence],style[data-precedence]\'),n=a.length?a[a.length-1]:null,u=n,i=0;i<a.length;i++){var c=a[i];if(c.dataset.precedence===l)u=c;else if(u!==n)break}u?u.parentNode.insertBefore(t,u.nextSibling):(l=e.nodeType===9?e.head:e,l.insertBefore(t,l.firstChild))}function Rf(t,l){t.crossOrigin==null&&(t.crossOrigin=l.crossOrigin),t.referrerPolicy==null&&(t.referrerPolicy=l.referrerPolicy),t.title==null&&(t.title=l.title)}function Hf(t,l){t.crossOrigin==null&&(t.crossOrigin=l.crossOrigin),t.referrerPolicy==null&&(t.referrerPolicy=l.referrerPolicy),t.integrity==null&&(t.integrity=l.integrity)}var tu=null;function Rs(t,l,e){if(tu===null){var a=new Map,n=tu=new Map;n.set(e,a)}else n=tu,a=n.get(e),a||(a=new Map,n.set(e,a));if(a.has(t))return a;for(a.set(t,null),e=e.getElementsByTagName(t),n=0;n<e.length;n++){var u=e[n];if(!(u[on]||u[rt]||t==="link"&&u.getAttribute("rel")==="stylesheet")&&u.namespaceURI!=="http://www.w3.org/2000/svg"){var i=u.getAttribute(l)||"";i=t+i;var c=a.get(i);c?c.push(u):a.set(i,[u])}}return a}function Hs(t,l,e){t=t.ownerDocument||t,t.head.insertBefore(e,l==="title"?t.querySelector("head > title"):null)}function Yy(t,l,e){if(e===1||l.itemProp!=null)return!1;switch(t){case"meta":case"title":return!0;case"style":if(typeof l.precedence!="string"||typeof l.href!="string"||l.href==="")break;return!0;case"link":if(typeof l.rel!="string"||typeof l.href!="string"||l.href===""||l.onLoad||l.onError)break;return l.rel==="stylesheet"?(t=l.disabled,typeof l.precedence=="string"&&t==null):!0;case"script":if(l.async&&typeof l.async!="function"&&typeof l.async!="symbol"&&!l.onLoad&&!l.onError&&l.src&&typeof l.src=="string")return!0}return!1}function b0(t){return!(t.type==="stylesheet"&&(t.state.loading&3)===0)}function Xy(t,l,e,a){if(e.type==="stylesheet"&&(typeof a.media!="string"||matchMedia(a.media).matches!==!1)&&(e.state.loading&4)===0){if(e.instance===null){var n=ca(a.href),u=l.querySelector(gn(n));if(u){l=u._p,l!==null&&typeof l=="object"&&typeof l.then=="function"&&(t.count++,t=Lu.bind(t),l.then(t,t)),e.state.loading|=4,e.instance=u,st(u);return}u=l.ownerDocument||l,a=p0(a),(n=Wt.get(n))&&Rf(a,n),u=u.createElement("link"),st(u);var i=u;i._p=new Promise(function(c,f){i.onload=c,i.onerror=f}),ht(u,"link",a),e.instance=u}t.stylesheets===null&&(t.stylesheets=new Map),t.stylesheets.set(e,l),(l=e.state.preload)&&(e.state.loading&3)===0&&(t.count++,e=Lu.bind(t),l.addEventListener("load",e),l.addEventListener("error",e))}}var Ki=0;function Gy(t,l){return t.stylesheets&&t.count===0&&lu(t,t.stylesheets),0<t.count||0<t.imgCount?function(e){var a=setTimeout(function(){if(t.stylesheets&&lu(t,t.stylesheets),t.unsuspend){var u=t.unsuspend;t.unsuspend=null,u()}},6e4+l);0<t.imgBytes&&Ki===0&&(Ki=62500*by());var n=setTimeout(function(){if(t.waitingForImages=!1,t.count===0&&(t.stylesheets&&lu(t,t.stylesheets),t.unsuspend)){var u=t.unsuspend;t.unsuspend=null,u()}},(t.imgBytes>Ki?50:800)+l);return t.unsuspend=e,function(){t.unsuspend=null,clearTimeout(a),clearTimeout(n)}}:null}function Lu(){if(this.count--,this.count===0&&(this.imgCount===0||!this.waitingForImages)){if(this.stylesheets)lu(this,this.stylesheets);else if(this.unsuspend){var t=this.unsuspend;this.unsuspend=null,t()}}}var Du=null;function lu(t,l){t.stylesheets=null,t.unsuspend!==null&&(t.count++,Du=new Map,l.forEach(jy,t),Du=null,Lu.call(t))}function jy(t,l){if(!(l.state.loading&4)){var e=Du.get(t);if(e)var a=e.get(null);else{e=new Map,Du.set(t,e);for(var n=t.querySelectorAll("link[data-precedence],style[data-precedence]"),u=0;u<n.length;u++){var i=n[u];(i.nodeName==="LINK"||i.getAttribute("media")!=="not all")&&(e.set(i.dataset.precedence,i),a=i)}a&&e.set(null,a)}n=l.instance,i=n.getAttribute("data-precedence"),u=e.get(i)||a,u===a&&e.set(null,n),e.set(i,n),this.count++,a=Lu.bind(this),n.addEventListener("load",a),n.addEventListener("error",a),u?u.parentNode.insertBefore(n,u.nextSibling):(t=t.nodeType===9?t.head:t,t.insertBefore(n,t.firstChild)),l.state.loading|=4}}var an={$$typeof:gl,Provider:null,Consumer:null,_currentValue:de,_currentValue2:de,_threadCount:0};function Qy(t,l,e,a,n,u,i,c,f){this.tag=1,this.containerInfo=t,this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.next=this.pendingContext=this.context=this.cancelPendingCommit=null,this.callbackPriority=0,this.expirationTimes=Si(-1),this.entangledLanes=this.shellSuspendCounter=this.errorRecoveryDisabledLanes=this.expiredLanes=this.warmLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=Si(0),this.hiddenUpdates=Si(null),this.identifierPrefix=a,this.onUncaughtError=n,this.onCaughtError=u,this.onRecoverableError=i,this.pooledCache=null,this.pooledCacheLanes=0,this.formState=f,this.incompleteTransitions=new Map}function E0(t,l,e,a,n,u,i,c,f,d,v,g){return t=new Qy(t,l,e,i,f,d,v,g,c),l=1,u===!0&&(l|=24),u=xt(3,null,null,l),t.current=u,u.stateNode=t,l=uf(),l.refCount++,t.pooledCache=l,l.refCount++,u.memoizedState={element:a,isDehydrated:e,cache:l},df(u),t}function T0(t){return t?(t=je,t):je}function z0(t,l,e,a,n,u){n=T0(n),a.context===null?a.context=n:a.pendingContext=n,a=Zl(l),a.payload={element:e},u=u===void 0?null:u,u!==null&&(a.callback=u),e=Vl(t,a,l),e!==null&&(_t(e,t,l),Ba(e,t,l))}function Cs(t,l){if(t=t.memoizedState,t!==null&&t.dehydrated!==null){var e=t.retryLane;t.retryLane=e!==0&&e<l?e:l}}function Cf(t,l){Cs(t,l),(t=t.alternate)&&Cs(t,l)}function A0(t){if(t.tag===13||t.tag===31){var l=Te(t,67108864);l!==null&&_t(l,t,67108864),Cf(t,67108864)}}function qs(t){if(t.tag===13||t.tag===31){var l=qt();l=Vc(l);var e=Te(t,l);e!==null&&_t(e,t,l),Cf(t,l)}}var Nu=!0;function wy(t,l,e,a){var n=O.T;O.T=null;var u=B.p;try{B.p=2,qf(t,l,e,a)}finally{B.p=u,O.T=n}}function Zy(t,l,e,a){var n=O.T;O.T=null;var u=B.p;try{B.p=8,qf(t,l,e,a)}finally{B.p=u,O.T=n}}function qf(t,l,e,a){if(Nu){var n=Gc(a);if(n===null)Zi(t,l,a,xu,e),Bs(t,a);else if(Ky(n,t,l,e,a))a.stopPropagation();else if(Bs(t,a),l&4&&-1<Vy.indexOf(t)){for(;n!==null;){var u=sa(n);if(u!==null)switch(u.tag){case 3:if(u=u.stateNode,u.current.memoizedState.isDehydrated){var i=ie(u.pendingLanes);if(i!==0){var c=u;for(c.pendingLanes|=2,c.entangledLanes|=2;i;){var f=1<<31-Ct(i);c.entanglements[1]|=f,i&=~f}fl(u),(q&6)===0&&(bu=Rt()+500,hn(0,!1))}}break;case 31:case 13:c=Te(u,2),c!==null&&_t(c,u,2),Zu(),Cf(u,2)}if(u=Gc(a),u===null&&Zi(t,l,a,xu,e),u===n)break;n=u}n!==null&&a.stopPropagation()}else Zi(t,l,a,null,e)}}function Gc(t){return t=Wc(t),Bf(t)}var xu=null;function Bf(t){if(xu=null,t=Ce(t),t!==null){var l=cn(t);if(l===null)t=null;else{var e=l.tag;if(e===13){if(t=ws(l),t!==null)return t;t=null}else if(e===31){if(t=Zs(l),t!==null)return t;t=null}else if(e===3){if(l.stateNode.current.memoizedState.isDehydrated)return l.tag===3?l.stateNode.containerInfo:null;t=null}else l!==t&&(t=null)}}return xu=t,null}function _0(t){switch(t){case"beforetoggle":case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"toggle":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 2;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 8;case"message":switch(Ur()){case Js:return 2;case Ws:return 8;case iu:case Rr:return 32;case $s:return 268435456;default:return 32}default:return 32}}var jc=!1,Jl=null,Wl=null,$l=null,nn=new Map,un=new Map,ql=[],Vy="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(" ");function Bs(t,l){switch(t){case"focusin":case"focusout":Jl=null;break;case"dragenter":case"dragleave":Wl=null;break;case"mouseover":case"mouseout":$l=null;break;case"pointerover":case"pointerout":nn.delete(l.pointerId);break;case"gotpointercapture":case"lostpointercapture":un.delete(l.pointerId)}}function Oa(t,l,e,a,n,u){return t===null||t.nativeEvent!==u?(t={blockedOn:l,domEventName:e,eventSystemFlags:a,nativeEvent:u,targetContainers:[n]},l!==null&&(l=sa(l),l!==null&&A0(l)),t):(t.eventSystemFlags|=a,l=t.targetContainers,n!==null&&l.indexOf(n)===-1&&l.push(n),t)}function Ky(t,l,e,a,n){switch(l){case"focusin":return Jl=Oa(Jl,t,l,e,a,n),!0;case"dragenter":return Wl=Oa(Wl,t,l,e,a,n),!0;case"mouseover":return $l=Oa($l,t,l,e,a,n),!0;case"pointerover":var u=n.pointerId;return nn.set(u,Oa(nn.get(u)||null,t,l,e,a,n)),!0;case"gotpointercapture":return u=n.pointerId,un.set(u,Oa(un.get(u)||null,t,l,e,a,n)),!0}return!1}function O0(t){var l=Ce(t.target);if(l!==null){var e=cn(l);if(e!==null){if(l=e.tag,l===13){if(l=ws(e),l!==null){t.blockedOn=l,bd(t.priority,function(){qs(e)});return}}else if(l===31){if(l=Zs(e),l!==null){t.blockedOn=l,bd(t.priority,function(){qs(e)});return}}else if(l===3&&e.stateNode.current.memoizedState.isDehydrated){t.blockedOn=e.tag===3?e.stateNode.containerInfo:null;return}}}t.blockedOn=null}function eu(t){if(t.blockedOn!==null)return!1;for(var l=t.targetContainers;0<l.length;){var e=Gc(t.nativeEvent);if(e===null){e=t.nativeEvent;var a=new e.constructor(e.type,e);uc=a,e.target.dispatchEvent(a),uc=null}else return l=sa(e),l!==null&&A0(l),t.blockedOn=e,!1;l.shift()}return!0}function Ys(t,l,e){eu(t)&&e.delete(l)}function ky(){jc=!1,Jl!==null&&eu(Jl)&&(Jl=null),Wl!==null&&eu(Wl)&&(Wl=null),$l!==null&&eu($l)&&($l=null),nn.forEach(Ys),un.forEach(Ys)}function Gn(t,l){t.blockedOn===l&&(t.blockedOn=null,jc||(jc=!0,ct.unstable_scheduleCallback(ct.unstable_NormalPriority,ky)))}var jn=null;function Xs(t){jn!==t&&(jn=t,ct.unstable_scheduleCallback(ct.unstable_NormalPriority,function(){jn===t&&(jn=null);for(var l=0;l<t.length;l+=3){var e=t[l],a=t[l+1],n=t[l+2];if(typeof a!="function"){if(Bf(a||e)===null)continue;break}var u=sa(e);u!==null&&(t.splice(l,3),l-=3,Ec(u,{pending:!0,data:n,method:e.method,action:a},a,n))}}))}function fa(t){function l(f){return Gn(f,t)}Jl!==null&&Gn(Jl,t),Wl!==null&&Gn(Wl,t),$l!==null&&Gn($l,t),nn.forEach(l),un.forEach(l);for(var e=0;e<ql.length;e++){var a=ql[e];a.blockedOn===t&&(a.blockedOn=null)}for(;0<ql.length&&(e=ql[0],e.blockedOn===null);)O0(e),e.blockedOn===null&&ql.shift();if(e=(t.ownerDocument||t).$$reactFormReplay,e!=null)for(a=0;a<e.length;a+=3){var n=e[a],u=e[a+1],i=n[Ot]||null;if(typeof u=="function")i||Xs(e);else if(i){var c=null;if(u&&u.hasAttribute("formAction")){if(n=u,i=u[Ot]||null)c=i.formAction;else if(Bf(n)!==null)continue}else c=i.action;typeof c=="function"?e[a+1]=c:(e.splice(a,3),a-=3),Xs(e)}}}function M0(){function t(u){u.canIntercept&&u.info==="react-transition"&&u.intercept({handler:function(){return new Promise(function(i){return n=i})},focusReset:"manual",scroll:"manual"})}function l(){n!==null&&(n(),n=null),a||setTimeout(e,20)}function e(){if(!a&&!navigation.transition){var u=navigation.currentEntry;u&&u.url!=null&&navigation.navigate(u.url,{state:u.getState(),info:"react-transition",history:"replace"})}}if(typeof navigation=="object"){var a=!1,n=null;return navigation.addEventListener("navigate",t),navigation.addEventListener("navigatesuccess",l),navigation.addEventListener("navigateerror",l),setTimeout(e,100),function(){a=!0,navigation.removeEventListener("navigate",t),navigation.removeEventListener("navigatesuccess",l),navigation.removeEventListener("navigateerror",l),n!==null&&(n(),n=null)}}}function Yf(t){this._internalRoot=t}ku.prototype.render=Yf.prototype.render=function(t){var l=this._internalRoot;if(l===null)throw Error(S(409));var e=l.current,a=qt();z0(e,a,t,l,null,null)};ku.prototype.unmount=Yf.prototype.unmount=function(){var t=this._internalRoot;if(t!==null){this._internalRoot=null;var l=t.containerInfo;z0(t.current,2,null,t,null,null),Zu(),l[da]=null}};function ku(t){this._internalRoot=t}ku.prototype.unstable_scheduleHydration=function(t){if(t){var l=lo();t={blockedOn:null,target:t,priority:l};for(var e=0;e<ql.length&&l!==0&&l<ql[e].priority;e++);ql.splice(e,0,t),e===0&&O0(t)}};var Gs=js.version;if(Gs!=="19.2.8")throw Error(S(527,Gs,"19.2.8"));B.findDOMNode=function(t){var l=t._reactInternals;if(l===void 0)throw typeof t.render=="function"?Error(S(188)):(t=Object.keys(t).join(","),Error(S(268,t)));return t=_r(l),t=t!==null?Vs(t):null,t=t===null?null:t.stateNode,t};var Jy={bundleType:0,version:"19.2.8",rendererPackageName:"react-dom",currentDispatcherRef:O,reconcilerVersion:"19.2.8"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"&&(Ma=__REACT_DEVTOOLS_GLOBAL_HOOK__,!Ma.isDisabled&&Ma.supportsFiber))try{fn=Ma.inject(Jy),Ht=Ma}catch{}var Ma;Ju.createRoot=function(t,l){if(!Qs(t))throw Error(S(299));var e=!1,a="",n=Sm,u=pm,i=bm;return l!=null&&(l.unstable_strictMode===!0&&(e=!0),l.identifierPrefix!==void 0&&(a=l.identifierPrefix),l.onUncaughtError!==void 0&&(n=l.onUncaughtError),l.onCaughtError!==void 0&&(u=l.onCaughtError),l.onRecoverableError!==void 0&&(i=l.onRecoverableError)),l=E0(t,1,!1,null,null,e,a,null,n,u,i,M0),t[da]=l.current,Uf(t),new Yf(l)};Ju.hydrateRoot=function(t,l,e){if(!Qs(t))throw Error(S(299));var a=!1,n="",u=Sm,i=pm,c=bm,f=null;return e!=null&&(e.unstable_strictMode===!0&&(a=!0),e.identifierPrefix!==void 0&&(n=e.identifierPrefix),e.onUncaughtError!==void 0&&(u=e.onUncaughtError),e.onCaughtError!==void 0&&(i=e.onCaughtError),e.onRecoverableError!==void 0&&(c=e.onRecoverableError),e.formState!==void 0&&(f=e.formState)),l=E0(t,1,!0,l,e??null,a,n,f,u,i,c,M0),l.context=T0(null),e=l.current,a=qt(),a=Vc(a),n=Zl(a),n.callback=null,Vl(e,n,a),e=a,l.current.lanes=e,sn(l,e),fl(l),t[da]=l.current,Uf(t),new ku(l)};Ju.version="19.2.8"});var x0=ll((mv,N0)=>{"use strict";function D0(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!="function"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(D0)}catch(t){console.error(t)}}D0(),N0.exports=L0()});var R0=ll(Wu=>{"use strict";var Wy=Symbol.for("react.transitional.element"),$y=Symbol.for("react.fragment");function U0(t,l,e){var a=null;if(e!==void 0&&(a=""+e),l.key!==void 0&&(a=""+l.key),"key"in l){e={};for(var n in l)n!=="key"&&(e[n]=l[n])}else e=l;return l=e.ref,{$$typeof:Wy,type:t,key:a,ref:l!==void 0?l:null,props:e}}Wu.Fragment=$y;Wu.jsx=U0;Wu.jsxs=U0});var Pt=ll((yv,H0)=>{"use strict";H0.exports=R0()});var Q0,j0=Gf(()=>{Q0={version:1,generatedAt:"2026-10-12T12:00:00.000Z",source:{repo:"acme/shop",pr:482,title:"Add partial refunds",url:"https://github.com/acme/shop/pull/482"},totals:{files:12,hunks:12,added:52,removed:25,byTier:{critical:3,high:1,medium:0,low:3,trivial:5},coverageProvided:!0},hunks:[{hunk:{id:"db/migrations/20261005_partial_refunds.sql:1",path:"db/migrations/20261005_partial_refunds.sql",oldStart:0,oldLines:0,newStart:1,newLines:9,section:"",lines:[{kind:"add",text:"CREATE TABLE refunds (",newLine:1},{kind:"add",text:"  id TEXT PRIMARY KEY,",newLine:2},{kind:"add",text:"  payment_id TEXT NOT NULL REFERENCES payments(id),",newLine:3},{kind:"add",text:"  amount_cents INTEGER NOT NULL,",newLine:4},{kind:"add",text:"  actor_id TEXT NOT NULL,",newLine:5},{kind:"add",text:"  created_at TIMESTAMPTZ NOT NULL DEFAULT now()",newLine:6},{kind:"add",text:");",newLine:7},{kind:"add",text:"CREATE INDEX idx_refunds_payment_id ON refunds (payment_id);",newLine:8},{kind:"add",text:"ALTER TABLE payments DROP COLUMN legacy_status;",newLine:9}]},file:{oldPath:"db/migrations/20261005_partial_refunds.sql",newPath:"db/migrations/20261005_partial_refunds.sql",status:"added"},added:9,removed:0,risk:{score:77,tier:"critical",signals:[{id:"schema.destructive",category:"data",weight:55,reason:"Destructive schema change: `DROP COLUMN` cannot be rolled back without data loss",at:[8]},{id:"path.migration",category:"migration",weight:30,reason:"Database migration or schema file"},{id:"path.money",category:"money",weight:18,reason:"File handles payments, billing or orders"},{id:"schema.locking-index",category:"migration",weight:16,reason:"Index built without CONCURRENTLY can lock writes on large tables",at:[7]},{id:"money.touched",category:"money",weight:12,reason:"Touches money-related values (`amount_cents`, `payments`)",at:[3,8]},{id:"size",category:"size",weight:5,reason:"9 changed lines of code"}],coverage:{instrumented:0,covered:0,uncoveredLines:[],status:"not-executable"}},summary:"Creates the refunds table, indexes payment_id and drops payments.legacy_status",summarySource:"model"},{hunk:{id:"src/auth/routes.ts:5",path:"src/auth/routes.ts",oldStart:5,oldLines:4,newStart:5,newLines:4,section:\'import { refundHandler, listRefundsHandler } from "../payments/handlers";\',lines:[{kind:"ctx",text:"export const router = Router();",oldLine:5,newLine:5},{kind:"ctx",text:"",oldLine:6,newLine:6},{kind:"ctx",text:\'router.get("/refunds", requireAuth, requireRole("billing"), listRefundsHandler);\',oldLine:7,newLine:7},{kind:"del",text:\'router.post("/refunds/:paymentId", requireAuth, requireRole("billing"), refundHandler);\',oldLine:8},{kind:"add",text:\'router.post("/refunds/:paymentId", requireAuth, refundHandler);\',newLine:8}]},file:{oldPath:"src/auth/routes.ts",newPath:"src/auth/routes.ts",status:"modified"},added:1,removed:1,risk:{score:70,tier:"critical",signals:[{id:"auth.guard-removed",category:"auth",weight:55,reason:\'Authorization check removed: `requireRole` no longer runs on `router.post("/refunds/:paymentId", requ\\u2026`\',at:[3]},{id:"path.auth",category:"auth",weight:20,reason:"File is part of authentication / authorization"},{id:"api.route",category:"api",weight:18,reason:"Adds, removes or changes an HTTP route",at:[3,4]},{id:"size",category:"size",weight:3,reason:"2 changed lines of code"}],coverage:{instrumented:1,covered:1,uncoveredLines:[],status:"measured"}},summary:\'Removes requireRole("billing") from POST /refunds/:paymentId; requireAuth stays\',summarySource:"model"},{hunk:{id:"src/jobs/sync.ts:1",path:"src/jobs/sync.ts",oldStart:1,oldLines:18,newStart:1,newLines:15,section:"",lines:[{kind:"ctx",text:\'import { ledger } from "../ledger";\',oldLine:1,newLine:1},{kind:"ctx",text:\'import { logger } from "../utils/logger";\',oldLine:2,newLine:2},{kind:"ctx",text:"",oldLine:3,newLine:3},{kind:"del",text:"const MAX_ATTEMPTS = 3;",oldLine:4},{kind:"add",text:"const MAX_ATTEMPTS = 5;",newLine:4},{kind:"ctx",text:"",oldLine:5,newLine:5},{kind:"ctx",text:"export async function syncRefundsToLedger(refunds: { id: string; amountCents: number }[]) {",oldLine:6,newLine:6},{kind:"ctx",text:"  for (const refund of refunds) {",oldLine:7,newLine:7},{kind:"ctx",text:"    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {",oldLine:8,newLine:8},{kind:"ctx",text:"      try {",oldLine:9,newLine:9},{kind:"del",text:\'        await ledger.post({ type: "refund", ref: refund.id, amountCents: -refund.amountCents });\',oldLine:10},{kind:"add",text:\'        ledger.post({ type: "refund", ref: refund.id, amountCents: -refund.amountCents });\',newLine:10},{kind:"ctx",text:"        break;",oldLine:11,newLine:11},{kind:"del",text:"      } catch (err) {",oldLine:12},{kind:"del",text:\'        logger.warn("ledger post failed", { refund: refund.id, attempt, err });\',oldLine:13},{kind:"del",text:"        if (attempt === MAX_ATTEMPTS) throw err;",oldLine:14},{kind:"del",text:"      }",oldLine:15},{kind:"add",text:"      } catch (err) {}",newLine:12},{kind:"ctx",text:"    }",oldLine:16,newLine:13},{kind:"ctx",text:"  }",oldLine:17,newLine:14},{kind:"ctx",text:"}",oldLine:18,newLine:15}]},file:{oldPath:"src/jobs/sync.ts",newPath:"src/jobs/sync.ts",status:"modified"},added:3,removed:6,risk:{score:65,tier:"critical",signals:[{id:"concurrency.await-removed",category:"concurrency",weight:26,reason:"`await` removed: the call is no longer waited for",at:[11]},{id:"error.swallowed",category:"error-handling",weight:24,reason:"Error is caught and ignored",at:[17]},{id:"error.removed",category:"error-handling",weight:20,reason:"Error handling removed: `if (attempt === MAX_ATTEMPTS) throw err;`",at:[15]},{id:"behaviour.limit",category:"behaviour",weight:18,reason:"Limit or timeout changed: 3 \\u2192 5",at:[4]},{id:"coverage.uncovered",category:"coverage",weight:18,reason:"2 of 2 changed executable lines never run by tests"},{id:"money.touched",category:"money",weight:12,reason:"Touches money-related values (`ledger`, `refund`, `amountCents`)",at:[10,11,14]},{id:"size",category:"size",weight:5,reason:"9 changed lines of code"}],coverage:{instrumented:2,covered:0,uncoveredLines:[4,10],status:"measured"}},summary:"Raises ledger retries from 3 to 5, stops awaiting ledger.post and drops the final rethrow",summarySource:"model"},{hunk:{id:"src/payments/refunds.ts:3",path:"src/payments/refunds.ts",oldStart:3,oldLines:16,newStart:3,newLines:24,section:\'import type { Payment } from "./types";\',lines:[{kind:"ctx",text:"",oldLine:3,newLine:3},{kind:"ctx",text:"export const MAX_REFUND_WINDOW_DAYS = 30;",oldLine:4,newLine:4},{kind:"ctx",text:"",oldLine:5,newLine:5},{kind:"del",text:"export async function refundPayment(paymentId: string, actorId: string) {",oldLine:6},{kind:"add",text:"export async function refundPayment(paymentId: string, actorId: string, requestedAmount?: string) {",newLine:6},{kind:"ctx",text:"  const payment: Payment = await db.payments.find(paymentId);",oldLine:7,newLine:7},{kind:"ctx",text:\'  if (!payment) throw new Error("payment not found");\',oldLine:8,newLine:8},{kind:"del",text:\'  if (payment.status !== "captured") {\',oldLine:9},{kind:"add",text:\'  if (payment.status !== "captured" && payment.status !== "partially_refunded") {\',newLine:9},{kind:"ctx",text:\'    throw new Error("only captured payments can be refunded");\',oldLine:10,newLine:10},{kind:"ctx",text:"  }",oldLine:11,newLine:11},{kind:"ctx",text:"  const ageDays = (Date.now() - payment.capturedAt.getTime()) / 86_400_000;",oldLine:12,newLine:12},{kind:"del",text:"  if (ageDays > MAX_REFUND_WINDOW_DAYS) {",oldLine:13},{kind:"add",text:"  if (ageDays >= MAX_REFUND_WINDOW_DAYS) {",newLine:13},{kind:"ctx",text:\'    throw new Error("refund window has closed");\',oldLine:14,newLine:14},{kind:"ctx",text:"  }",oldLine:15,newLine:15},{kind:"del",text:"  await db.refunds.insert({ paymentId, amountCents: payment.amountCents, actorId });",oldLine:16},{kind:"del",text:\'  await db.payments.update(paymentId, { status: "refunded" });\',oldLine:17},{kind:"add",text:"  const alreadyRefunded = await db.refunds.sumForPayment(paymentId);",newLine:16},{kind:"add",text:"  const refundAmountCents = requestedAmount",newLine:17},{kind:"add",text:"    ? Math.round(parseFloat(requestedAmount) * 100)",newLine:18},{kind:"add",text:"    : payment.amountCents - alreadyRefunded;",newLine:19},{kind:"add",text:"  if (refundAmountCents > payment.amountCents - alreadyRefunded) {",newLine:20},{kind:"add",text:\'    throw new Error("refund exceeds remaining balance");\',newLine:21},{kind:"add",text:"  }",newLine:22},{kind:"add",text:"  await db.refunds.insert({ paymentId, amountCents: refundAmountCents, actorId });",newLine:23},{kind:"add",text:"  const fullyRefunded = alreadyRefunded + refundAmountCents === payment.amountCents;",newLine:24},{kind:"add",text:\'  await db.payments.update(paymentId, { status: fullyRefunded ? "refunded" : "partially_refunded" });\',newLine:25},{kind:"ctx",text:"}",oldLine:18,newLine:26}]},file:{oldPath:"src/payments/refunds.ts",newPath:"src/payments/refunds.ts",status:"modified"},added:13,removed:5,risk:{score:42,tier:"high",signals:[{id:"money.arithmetic",category:"money",weight:32,reason:"Arithmetic or rounding on money values (`alreadyRefunded`, `refundAmountCents`, `requestedAmount`)",at:[18,19,20,21,22,26]},{id:"behaviour.comparison",category:"behaviour",weight:26,reason:"Boundary changed: `>` \\u2192 `>=`",at:[13]},{id:"path.money",category:"money",weight:18,reason:"File handles payments, billing or orders"},{id:"money.float",category:"money",weight:14,reason:"Floating-point conversion on a money value",at:[20]},{id:"behaviour.branch-added",category:"behaviour",weight:14,reason:"New branch: `if (refundAmountCents > payment.amountCents - a\\u2026`",at:[22]},{id:"size",category:"size",weight:7,reason:"18 changed lines of code"},{id:"coverage.covered",category:"coverage",weight:-10,reason:"All 12 changed executable lines are run by tests"}],coverage:{instrumented:12,covered:12,uncoveredLines:[],status:"measured"}},summary:"Adds an optional partial amount, tracks the remaining balance and now rejects refunds made exactly 30 days after capture (> becomes >=)",summarySource:"model"},{hunk:{id:"package.json:1",path:"package.json",oldStart:1,oldLines:6,newStart:1,newLines:6,section:"",lines:[{kind:"ctx",text:"{",oldLine:1,newLine:1},{kind:"ctx",text:\'  "name": "shop",\',oldLine:2,newLine:2},{kind:"ctx",text:\'  "dependencies": {\',oldLine:3,newLine:3},{kind:"del",text:\'    "express": "^4.19.2"\',oldLine:4},{kind:"add",text:\'    "express": "^4.21.2"\',newLine:4},{kind:"ctx",text:"  }",oldLine:5,newLine:5},{kind:"ctx",text:"}",oldLine:6,newLine:6}]},file:{oldPath:"package.json",newPath:"package.json",status:"modified"},added:1,removed:1,risk:{score:14,tier:"low",signals:[{id:"dependency.versions",category:"dependency",weight:12,reason:"Dependency versions changed (2 lines)",at:[3,4]},{id:"size",category:"size",weight:3,reason:"2 changed lines of code"}],coverage:{instrumented:0,covered:0,uncoveredLines:[],status:"not-executable"}},summary:"Bumps express from ^4.19.2 to ^4.21.2",summarySource:"model"},{hunk:{id:"test/refunds.test.ts:1",path:"test/refunds.test.ts",oldStart:0,oldLines:0,newStart:1,newLines:12,section:"",lines:[{kind:"add",text:\'import { describe, it, expect } from "vitest";\',newLine:1},{kind:"add",text:\'import { refundPayment } from "../src/payments/refunds";\',newLine:2},{kind:"add",text:"",newLine:3},{kind:"add",text:\'describe("refundPayment", () => {\',newLine:4},{kind:"add",text:\'  it("refunds the remaining balance by default", async () => {\',newLine:5},{kind:"add",text:\'    await expect(refundPayment("pay_1", "user_1")).resolves.toBeUndefined();\',newLine:6},{kind:"add",text:"  });",newLine:7},{kind:"add",text:"",newLine:8},{kind:"add",text:\'  it("rejects refunds larger than the remaining balance", async () => {\',newLine:9},{kind:"add",text:\'    await expect(refundPayment("pay_1", "user_1", "999.00")).rejects.toThrow("exceeds");\',newLine:10},{kind:"add",text:"  });",newLine:11},{kind:"add",text:"});",newLine:12}]},file:{oldPath:"test/refunds.test.ts",newPath:"test/refunds.test.ts",status:"added"},added:12,removed:0,risk:{score:3,tier:"low",signals:[{id:"size",category:"size",weight:5,reason:"10 changed lines of code"}],coverage:{instrumented:0,covered:0,uncoveredLines:[],status:"not-executable"}},summary:"Adds tests for full refunds and for refunds over the remaining balance",summarySource:"model"},{hunk:{id:"README.md:1",path:"README.md",oldStart:1,oldLines:3,newStart:1,newLines:3,section:"",lines:[{kind:"ctx",text:"# Shop",oldLine:1,newLine:1},{kind:"ctx",text:"",oldLine:2,newLine:2},{kind:"del",text:"Payments service.",oldLine:3},{kind:"add",text:"Payments service. Supports full and partial refunds.",newLine:3}]},file:{oldPath:"README.md",newPath:"README.md",status:"modified"},added:1,removed:1,risk:{score:1,tier:"low",signals:[{id:"size",category:"size",weight:3,reason:"2 changed lines of code"}],coverage:{instrumented:0,covered:0,uncoveredLines:[],status:"not-executable"}},summary:"Mentions partial refund support in the README",summarySource:"model"},{hunk:{id:"package-lock.json:3",path:"package-lock.json",oldStart:3,oldLines:7,newStart:3,newLines:7,section:"",lines:[{kind:"ctx",text:\'  "lockfileVersion": 3,\',oldLine:3,newLine:3},{kind:"ctx",text:\'  "packages": {\',oldLine:4,newLine:4},{kind:"ctx",text:\'    "node_modules/express": {\',oldLine:5,newLine:5},{kind:"del",text:\'      "version": "4.19.2"\',oldLine:6},{kind:"add",text:\'      "version": "4.21.2"\',newLine:6},{kind:"ctx",text:"    }",oldLine:7,newLine:7},{kind:"ctx",text:"  }",oldLine:8,newLine:8},{kind:"ctx",text:"}",oldLine:9,newLine:9}]},file:{oldPath:"package-lock.json",newPath:"package-lock.json",status:"modified"},added:1,removed:1,risk:{score:0,tier:"trivial",signals:[],coverage:{instrumented:0,covered:0,uncoveredLines:[],status:"not-executable"},trivial:{kind:"generated",reason:"Generated or lock file"}},summary:"Generated or lock file",summarySource:"heuristic"},{hunk:{id:"src/api/client.ts:1",path:"src/api/client.ts",oldStart:1,oldLines:7,newStart:1,newLines:7,section:"",lines:[{kind:"del",text:\'import { retry } from "../utils/retry";\',oldLine:1},{kind:"del",text:\'import { logger } from "../utils/logger";\',oldLine:2},{kind:"ctx",text:\'import { config } from "../config";\',oldLine:3,newLine:1},{kind:"ctx",text:\'import type { Payment, Refund } from "../payments/types";\',oldLine:4,newLine:2},{kind:"add",text:\'import { logger } from "../utils/logger";\',newLine:3},{kind:"add",text:\'import { retry } from "../utils/retry";\',newLine:4},{kind:"ctx",text:"",oldLine:5,newLine:5},{kind:"ctx",text:"export async function fetchPayment(id: string): Promise<Payment> {",oldLine:6,newLine:6},{kind:"ctx",text:"  return retry(() => http.get(`${config.apiBase}/payments/${id}`));",oldLine:7,newLine:7}]},file:{oldPath:"src/api/client.ts",newPath:"src/api/client.ts",status:"modified"},added:2,removed:2,risk:{score:0,tier:"trivial",signals:[],coverage:{instrumented:0,covered:0,uncoveredLines:[],status:"measured"},trivial:{kind:"imports",reason:"Imports reordered"}},summary:"Imports reordered",summarySource:"heuristic"},{hunk:{id:"src/notifications/email.ts:1",path:"src/notifications/email.ts",oldStart:1,oldLines:4,newStart:1,newLines:5,section:"",lines:[{kind:"del",text:"// Sends refund receipts.",oldLine:1},{kind:"add",text:"// Sends refund receipts to the customer who placed the order.",newLine:1},{kind:"add",text:"// Partial refunds use the same subject line.",newLine:2},{kind:"ctx",text:"export function refundReceiptSubject(orderId: string) {",oldLine:2,newLine:3},{kind:"ctx",text:"  return `Your refund for order ${orderId}`;",oldLine:3,newLine:4},{kind:"ctx",text:"}",oldLine:4,newLine:5}]},file:{oldPath:"src/notifications/email.ts",newPath:"src/notifications/email.ts",status:"modified"},added:2,removed:1,risk:{score:0,tier:"trivial",signals:[],coverage:{instrumented:0,covered:0,uncoveredLines:[],status:"file-missing"},trivial:{kind:"comments",reason:"Comments only"}},summary:"Comments only",summarySource:"heuristic"},{hunk:{id:"src/orders/service.ts:1",path:"src/orders/service.ts",oldStart:1,oldLines:9,newStart:1,newLines:9,section:"",lines:[{kind:"ctx",text:"export function orderTotal(items: { priceCents: number; qty: number }[]) {",oldLine:1,newLine:1},{kind:"del",text:"  let amt = 0;",oldLine:2},{kind:"add",text:"  let totalCents = 0;",newLine:2},{kind:"ctx",text:"  for (const item of items) {",oldLine:3,newLine:3},{kind:"del",text:"    amt += item.priceCents * item.qty;",oldLine:4},{kind:"add",text:"    totalCents += item.priceCents * item.qty;",newLine:4},{kind:"ctx",text:"  }",oldLine:5,newLine:5},{kind:"del",text:"  return amt;",oldLine:6},{kind:"add",text:"  return totalCents;",newLine:6},{kind:"ctx",text:"}",oldLine:7,newLine:7},{kind:"ctx",text:"",oldLine:8,newLine:8},{kind:"ctx",text:"export function describeOrder(id: string, itemCount: number) {",oldLine:9,newLine:9}]},file:{oldPath:"src/orders/service.ts",newPath:"src/orders/service.ts",status:"modified"},added:3,removed:3,risk:{score:0,tier:"trivial",signals:[],coverage:{instrumented:3,covered:3,uncoveredLines:[],status:"measured"},trivial:{kind:"rename",reason:"Rename only: `amt` \\u2192 `totalCents`"}},summary:"Rename only: `amt` \\u2192 `totalCents`",summarySource:"heuristic"},{hunk:{id:"src/utils/format.ts:1",path:"src/utils/format.ts",oldStart:1,oldLines:6,newStart:1,newLines:6,section:"",lines:[{kind:"del",text:"export function formatCents(cents: number, currency = \'USD\') {",oldLine:1},{kind:"del",text:"  const value = (cents / 100).toFixed(2)",oldLine:2},{kind:"del",text:"  return currency === \'USD\' ? \'$\' + value : value + \' \' + currency",oldLine:3},{kind:"add",text:\'export function formatCents(cents: number, currency = "USD") {\',newLine:1},{kind:"add",text:"  const value = (cents / 100).toFixed(2);",newLine:2},{kind:"add",text:\'  return currency === "USD" ? "$" + value : value + " " + currency;\',newLine:3},{kind:"ctx",text:"}",oldLine:4,newLine:4},{kind:"ctx",text:"",oldLine:5,newLine:5},{kind:"del",text:"export const pad = (s: string, n: number) => s.padStart(n, \' \')",oldLine:6},{kind:"add",text:\'export const pad = (s: string, n: number) => s.padStart(n, " ");\',newLine:6}]},file:{oldPath:"src/utils/format.ts",newPath:"src/utils/format.ts",status:"modified"},added:4,removed:4,risk:{score:0,tier:"trivial",signals:[],coverage:{instrumented:4,covered:4,uncoveredLines:[],status:"measured"},trivial:{kind:"formatting",reason:"Whitespace, quotes or punctuation only"}},summary:"Whitespace, quotes or punctuation only",summarySource:"heuristic"}],notes:[]}});var w0={};er(w0,{sample:()=>Py});var Py,Z0=Gf(()=>{"use strict";j0();Py=Q0});var J0=Lt(x0(),1);var P=Lt(pa(),1);var q0=Lt(pa(),1);var tl=Lt(Pt(),1);function C0({hunk:t,highlight:l}){let e=new Set(t.risk.coverage.uncoveredLines),{hunk:a}=t;return(0,tl.jsxs)("div",{className:"diff",role:"table","aria-label":`Diff for ${a.path}`,children:[(0,tl.jsx)("div",{className:"diff-head",role:"row",children:(0,tl.jsxs)("span",{role:"cell",children:["@@ \\u2212",a.oldStart,",",a.oldLines," +",a.newStart,",",a.newLines," @@ ",a.section]})}),a.lines.map((n,u)=>{let i=n.kind==="add"&&n.newLine!==void 0&&e.has(n.newLine),c=["dl",`dl-${n.kind}`,l.has(u)?"is-hit":"",i?"not-run":""].filter(Boolean).join(" ");return(0,tl.jsxs)("div",{className:c,role:"row",children:[(0,tl.jsx)("span",{className:"ln",role:"cell",children:n.oldLine??""}),(0,tl.jsx)("span",{className:"ln",role:"cell",children:n.newLine??""}),(0,tl.jsx)("span",{className:"cov",role:"cell",title:i?"Never run by tests":void 0,children:i?"\\u25CF":""}),(0,tl.jsxs)("span",{className:"code",role:"cell",children:[(0,tl.jsx)("span",{className:"sign","aria-hidden":"true",children:n.kind==="add"?"+":n.kind==="del"?"\\u2212":" "}),n.text||" "]})]},u)})]})}var w=Lt(Pt(),1);function $u(t){let l=t.hunk.lines.filter(n=>n.kind==="add"&&n.newLine!==void 0).map(n=>n.newLine);if(l.length===0){let n=t.hunk.oldStart+Math.max(0,t.hunk.oldLines-1);return n===t.hunk.oldStart?`L${t.hunk.oldStart} (removed)`:`L${t.hunk.oldStart}\\u2013${n} (removed)`}let e=l[0],a=l[l.length-1];return e===a?`L${e}`:`L${e}\\u2013${a}`}function Xf({text:t}){let l=t.split(/(`[^`]+`)/g);return(0,w.jsx)(w.Fragment,{children:l.map((e,a)=>e.length>2&&e.startsWith("`")&&e.endsWith("`")?(0,w.jsx)("code",{children:e.slice(1,-1)},a):e)})}function Fy(t){return t.filter(l=>l.category!=="size"||t.length===1)}function B0({hunk:t,reviewed:l,expanded:e,focused:a,onToggleReviewed:n,onToggleExpanded:u,onFocus:i}){let[c,f]=(0,q0.useState)(),d=Fy(t.risk.signals),v=d.find(p=>p.id===c),g=new Set(v?v.at??[]:d.flatMap(p=>p.at??[])),r=`diff-${t.hunk.id.replace(/[^\\w-]/g,"_")}`,y=p=>{f(A=>A===p.id?void 0:p.id),!e&&p.at?.length&&u()};return(0,w.jsxs)("article",{id:`h-${t.hunk.id}`,className:`hunk tier-${t.risk.tier}${l?" is-reviewed":""}${a?" is-focused":""}`,"aria-label":`${t.hunk.path} ${$u(t)}, ${t.risk.tier} risk`,onFocus:i,onClick:i,children:[(0,w.jsxs)("div",{className:"hunk-score","aria-hidden":"true",children:[(0,w.jsx)("span",{className:"score",children:t.risk.score}),(0,w.jsx)("span",{className:"tier",children:t.risk.tier})]}),(0,w.jsxs)("div",{className:"hunk-body",children:[(0,w.jsxs)("h3",{className:"hunk-path",children:[(0,w.jsx)("span",{className:"path",children:t.hunk.path})," ",(0,w.jsx)("span",{className:"lines",children:$u(t)}),t.file.status!=="modified"&&(0,w.jsx)("span",{className:"status",children:t.file.status})]}),t.summary&&(0,w.jsx)("p",{className:"summary",title:t.summarySource==="model"?"Written by Claude from the diff; not used for ranking":"Derived from the diff",children:t.summary}),(0,w.jsx)("ul",{className:"reasons","aria-label":"Why it\'s ranked here",children:d.map(p=>(0,w.jsx)("li",{children:(0,w.jsxs)("button",{type:"button",className:`reason cat-${p.category}${c===p.id?" is-active":""}${p.weight<0?" is-relief":""}`,"aria-pressed":c===p.id,disabled:!p.at?.length,onClick:A=>{A.stopPropagation(),y(p)},children:[(0,w.jsx)("span",{className:"weight",children:p.weight>0?`+${p.weight}`:p.weight}),(0,w.jsx)("span",{children:(0,w.jsx)(Xf,{text:p.reason})})]})},p.id))}),(0,w.jsxs)("div",{className:"hunk-actions",children:[(0,w.jsx)("button",{type:"button",className:"btn","aria-expanded":e,"aria-controls":r,onClick:p=>(p.stopPropagation(),u()),children:e?"Hide diff":`Show diff (+${t.added} \\u2212${t.removed})`}),(0,w.jsx)("button",{type:"button",className:`btn btn-review${l?" is-on":""}`,"aria-pressed":l,onClick:p=>(p.stopPropagation(),n()),children:l?"Reviewed":"Mark reviewed"})]}),e&&(0,w.jsx)("div",{id:r,children:(0,w.jsx)(C0,{hunk:t,highlight:g})})]})]})}var ae=Lt(Pt(),1);function Y0({hunks:t,reviewed:l,onJump:e}){let a=t.filter(d=>d.risk.tier!=="trivial"),n=d=>Math.max(4,d.risk.score),u=a.reduce((d,v)=>d+n(v),0),i=a.filter(d=>l.has(d.hunk.id)).reduce((d,v)=>d+n(v),0),c=u?Math.round(i/u*100):100,f=a.filter(d=>l.has(d.hunk.id)).length;return(0,ae.jsxs)("section",{className:"progress","aria-label":"Review progress",children:[(0,ae.jsxs)("p",{className:"progress-figure",children:[(0,ae.jsxs)("strong",{children:[c,"%"]})," of the risk reviewed",(0,ae.jsxs)("span",{className:"progress-sub",children:[f," of ",a.length," ranked hunks"]})]}),(0,ae.jsx)("div",{className:"strip",role:"list",children:a.map(d=>(0,ae.jsx)("button",{role:"listitem",className:`seg tier-${d.risk.tier}${l.has(d.hunk.id)?" is-done":""}`,style:{flexGrow:n(d)},title:`${d.hunk.path} \\u2014 ${d.risk.tier} ${d.risk.score}${l.has(d.hunk.id)?" (reviewed)":""}`,"aria-label":`Go to ${d.hunk.path}, ${d.risk.tier} risk ${d.risk.score}${l.has(d.hunk.id)?", reviewed":""}`,onClick:()=>e(d.hunk.id)},d.hunk.id))})]})}function X0(t){try{let l=window.localStorage.getItem(t),e=l?JSON.parse(l):[];return new Set(Array.isArray(e)?e.filter(a=>typeof a=="string"):[])}catch{return new Set}}function G0(t,l){try{window.localStorage.setItem(t,JSON.stringify([...l]))}catch{}}var z=Lt(Pt(),1),tv=["critical","high","medium","low"];function Fu(t){return!!t&&typeof t=="object"&&t.version===1&&Array.isArray(t.hunks)}function lv(t){let l=t.source;return`secondpass:reviewed:${l?.repo??"local"}#${l?.pr??""}@${l?.headSha??t.generatedAt}`}function V0({initial:t}){let[l,e]=(0,P.useState)(t),[a,n]=(0,P.useState)(),[u,i]=(0,P.useState)(!1);(0,P.useEffect)(()=>{if(l)return;let f=new URLSearchParams(window.location.search).get("report");f&&(i(!0),fetch(f).then(d=>d.ok?d.json():Promise.reject(new Error(`${d.status} ${d.statusText}`))).then(d=>Fu(d)?e(d):n("That URL didn\'t return a SecondPass report.")).catch(d=>n(`Couldn\'t load the report from ${f}: ${d instanceof Error?d.message:String(d)}`)).finally(()=>i(!1)))},[l]);let c=(0,P.useCallback)(f=>{f.text().then(d=>{let v=JSON.parse(d);if(!Fu(v))throw new Error("not a report");n(void 0),e(v)}).catch(()=>n(`${f.name} isn\'t a SecondPass JSON report. Create one with \\`secondpass --json report.json\\`.`))},[]);return(0,P.useEffect)(()=>{let f=v=>v.preventDefault(),d=v=>{v.preventDefault();let g=v.dataTransfer?.files[0];g&&c(g)};return window.addEventListener("dragover",f),window.addEventListener("drop",d),()=>{window.removeEventListener("dragover",f),window.removeEventListener("drop",d)}},[c]),l?(0,z.jsx)(av,{report:l,onClose:()=>e(void 0)}):(0,z.jsx)(ev,{error:a,loading:u,onFile:c,onSample:()=>Promise.resolve().then(()=>(Z0(),w0)).then(f=>e(f.sample))})}function ev({error:t,loading:l,onFile:e,onSample:a}){return(0,z.jsxs)("main",{className:"empty",children:[(0,z.jsx)("h1",{className:"brand",children:"SecondPass"}),(0,z.jsx)("p",{className:"lede",children:"Read a pull request in the order that matters: migrations, auth, money and behaviour changes first; renames and formatting folded away."}),l?(0,z.jsx)("p",{className:"muted",children:"Loading report\\u2026"}):(0,z.jsxs)("div",{className:"empty-actions",children:[(0,z.jsxs)("label",{className:"btn btn-primary",children:["Open a report file",(0,z.jsx)("input",{type:"file",accept:".json,application/json",className:"visually-hidden",onChange:n=>n.target.files?.[0]&&e(n.target.files[0])})]}),(0,z.jsx)("button",{type:"button",className:"btn",onClick:a,children:"Open the sample pull request"})]}),t&&(0,z.jsx)("p",{className:"error",role:"alert",children:t}),(0,z.jsxs)("p",{className:"muted small",children:["Or drop a ",(0,z.jsx)("code",{children:"report.json"})," here. Make one with ",(0,z.jsx)("code",{children:"npx secondpass --base origin/main --json report.json"}),"."]})]})}function av({report:t,onClose:l}){let e=lv(t),[a,n]=(0,P.useState)(()=>X0(e)),[u,i]=(0,P.useState)(()=>new Set(t.hunks.slice(0,1).map(E=>E.hunk.id))),[c,f]=(0,P.useState)("all"),[d,v]=(0,P.useState)(""),[g,r]=(0,P.useState)(!1),[y,p]=(0,P.useState)(t.hunks[0]?.hunk.id);(0,P.useEffect)(()=>G0(e,a),[e,a]);let A=(0,P.useMemo)(()=>t.hunks.filter(E=>E.risk.tier!=="trivial"),[t]),C=(0,P.useMemo)(()=>t.hunks.filter(E=>E.risk.tier==="trivial"),[t]),o=(0,P.useMemo)(()=>{let E=d.trim().toLowerCase();return A.filter(b=>(c==="all"||b.risk.tier===c)&&(!g||!a.has(b.hunk.id))&&(!E||b.hunk.path.toLowerCase().includes(E)||(b.summary??"").toLowerCase().includes(E)))},[A,c,d,g,a]),s=(E,b)=>{let _=new Set(E);return _.has(b)?_.delete(b):_.add(b),_},m=(0,P.useCallback)(E=>{p(E),i(b=>new Set(b).add(E)),requestAnimationFrame(()=>document.getElementById(`h-${E}`)?.scrollIntoView({block:"start",behavior:"smooth"}))},[]);(0,P.useEffect)(()=>{let E=b=>{let _=b.target;if(_&&(_.tagName==="INPUT"||_.tagName==="TEXTAREA"||_.isContentEditable)||b.metaKey||b.ctrlKey||b.altKey)return;let D=Math.max(0,o.findIndex(ft=>ft.hunk.id===y)),N=o[D];if(b.key==="j"||b.key==="k"){let ft=o[Math.min(o.length-1,Math.max(0,D+(b.key==="j"?1:-1)))];ft&&(p(ft.hunk.id),document.getElementById(`h-${ft.hunk.id}`)?.scrollIntoView({block:"nearest"}))}else if(b.key==="x"&&N)n(ft=>s(ft,N.hunk.id));else if(b.key==="o"&&N)i(ft=>s(ft,N.hunk.id));else return;b.preventDefault()};return window.addEventListener("keydown",E),()=>window.removeEventListener("keydown",E)},[o,y]);let h=t.source,T=t.totals;return(0,z.jsxs)("div",{className:"page",children:[(0,z.jsxs)("header",{className:"masthead",children:[(0,z.jsxs)("div",{className:"masthead-row",children:[(0,z.jsx)("span",{className:"brand",children:"SecondPass"}),(0,z.jsx)("button",{type:"button",className:"link",onClick:l,children:"Open another report"})]}),(0,z.jsx)("h1",{className:"pr-title",children:h?.url?(0,z.jsx)("a",{href:h.url,children:h.title??`${h.repo}#${h.pr}`}):h?.title??"Local diff"}),(0,z.jsxs)("p",{className:"pr-meta",children:[h?.repo&&(0,z.jsxs)("span",{children:[h.repo,h.pr?` #${h.pr}`:""]}),(0,z.jsxs)("span",{children:[T.hunks," hunks in ",T.files," files"]}),(0,z.jsxs)("span",{className:"diffstat",children:[(0,z.jsxs)("span",{className:"plus",children:["+",T.added]})," ",(0,z.jsxs)("span",{className:"minus",children:["\\u2212",T.removed]})]}),(0,z.jsx)("span",{children:T.coverageProvided?"Coverage included":"No coverage data"})]})]}),(0,z.jsx)(Y0,{hunks:t.hunks,reviewed:a,onJump:m}),(0,z.jsxs)("nav",{className:"toolbar","aria-label":"Filter hunks",children:[(0,z.jsxs)("div",{className:"tiers",role:"group","aria-label":"Risk tier",children:[(0,z.jsxs)("button",{type:"button",className:`chip${c==="all"?" is-on":""}`,"aria-pressed":c==="all",onClick:()=>f("all"),children:["All ",(0,z.jsx)("span",{className:"n",children:A.length})]}),tv.map(E=>(0,z.jsxs)("button",{type:"button",className:`chip tier-${E}${c===E?" is-on":""}`,"aria-pressed":c===E,disabled:T.byTier[E]===0,onClick:()=>f(E),children:[(0,z.jsx)("span",{className:"dot","aria-hidden":"true"}),E[0].toUpperCase()+E.slice(1)," ",(0,z.jsx)("span",{className:"n",children:T.byTier[E]})]},E))]}),(0,z.jsxs)("div",{className:"toolbar-right",children:[(0,z.jsxs)("label",{className:"check",children:[(0,z.jsx)("input",{type:"checkbox",checked:g,onChange:E=>r(E.target.checked)})," Hide reviewed"]}),(0,z.jsx)("input",{className:"search",type:"search",placeholder:"Filter by path or description","aria-label":"Filter by path or description",value:d,onChange:E=>v(E.target.value)})]})]}),(0,z.jsxs)("main",{className:"hunks",children:[o.length===0&&(0,z.jsx)("p",{className:"muted empty-list",children:A.length===0?"Nothing to rank: every change is a rename, formatting, import, comment or generated file.":"No hunks match these filters."}),o.map(E=>(0,z.jsx)(B0,{hunk:E,reviewed:a.has(E.hunk.id),expanded:u.has(E.hunk.id),focused:y===E.hunk.id,onFocus:()=>p(E.hunk.id),onToggleReviewed:()=>n(b=>s(b,E.hunk.id)),onToggleExpanded:()=>i(b=>s(b,E.hunk.id))},E.hunk.id)),C.length>0&&(0,z.jsxs)("details",{className:"collapsed",children:[(0,z.jsxs)("summary",{children:[C.length," collapsed ",C.length===1?"hunk":"hunks",": renames, formatting, imports, comments and generated files"]}),(0,z.jsx)("ul",{children:C.map(E=>(0,z.jsxs)("li",{children:[(0,z.jsx)("span",{className:"path",children:E.hunk.path})," ",(0,z.jsx)("span",{className:"lines",children:$u(E)}),(0,z.jsx)("span",{className:"why",children:(0,z.jsx)(Xf,{text:E.risk.trivial?.reason??""})})]},E.hunk.id))})]}),t.notes.length>0&&(0,z.jsxs)("details",{className:"collapsed",children:[(0,z.jsxs)("summary",{children:[t.notes.length," not ranked"]}),(0,z.jsx)("ul",{children:t.notes.map(E=>(0,z.jsx)("li",{children:E},E))})]})]}),(0,z.jsx)("footer",{className:"foot",children:(0,z.jsxs)("p",{children:["Order comes from the diff and test coverage, never from the model. Descriptions say what a hunk does, not whether it\'s fine. Keys: ",(0,z.jsx)("kbd",{children:"j"})," ",(0,z.jsx)("kbd",{children:"k"})," move,"," ",(0,z.jsx)("kbd",{children:"o"})," diff, ",(0,z.jsx)("kbd",{children:"x"})," reviewed."]})})]})}var W0=Lt(Pt(),1),K0=window.__SECONDPASS_REPORT__,k0=document.getElementById("root");k0&&(0,J0.createRoot)(k0).render((0,W0.jsx)(V0,{initial:Fu(K0)?K0:void 0}));})();\n', css: ':root{--paper: #f2f4f6;--surface: #ffffff;--ink: #1b2330;--ink-2: #4a5566;--ink-3: #7a8796;--rule: #d9dee5;--accent: #2f5bd3;--accent-ink: #ffffff;--critical: #c2352b;--high: #c77700;--medium: #8a7d00;--low: #7a8796;--trivial: #b4bdc8;--add-bg: #e7f4ea;--add-ink: #1d6b35;--del-bg: #fbe9e7;--del-ink: #9b2c22;--hit: #fff1b8;--hit-edge: #d6a700;--sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;--mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;color-scheme:light}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--paper: #12161c;--surface: #1a2029;--ink: #e3e8ef;--ink-2: #b2bccb;--ink-3: #8592a3;--rule: #2a323e;--accent: #7c9cf0;--accent-ink: #0f1520;--critical: #f0695e;--high: #f0a43a;--medium: #d4c443;--low: #8f9cad;--trivial: #556070;--add-bg: #15291c;--add-ink: #8fd6a2;--del-bg: #33191a;--del-ink: #f2a39b;--hit: #3a3313;--hit-edge: #c9a227;color-scheme:dark}}:root[data-theme=dark]{--paper: #12161c;--surface: #1a2029;--ink: #e3e8ef;--ink-2: #b2bccb;--ink-3: #8592a3;--rule: #2a323e;--accent: #7c9cf0;--accent-ink: #0f1520;--critical: #f0695e;--high: #f0a43a;--medium: #d4c443;--low: #8f9cad;--trivial: #556070;--add-bg: #15291c;--add-ink: #8fd6a2;--del-bg: #33191a;--del-ink: #f2a39b;--hit: #3a3313;--hit-edge: #c9a227;color-scheme:dark}*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--paper);color:var(--ink);font:400 15px/1.55 var(--sans)}a{color:inherit;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:3px}a:hover{text-decoration-color:currentColor}code,kbd{font-family:var(--mono);font-size:.88em}kbd{border:1px solid var(--rule);border-bottom-width:2px;border-radius:4px;padding:0 5px;background:var(--surface)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.muted{color:var(--ink-3)}.small{font-size:13px}.tier-critical{--tier: var(--critical)}.tier-high{--tier: var(--high)}.tier-medium{--tier: var(--medium)}.tier-low{--tier: var(--low)}.tier-trivial{--tier: var(--trivial)}.page{max-width:1040px;margin:0 auto;padding:32px 24px 64px}@media(max-width:640px){.page{padding:20px 16px 48px}}.brand{font-weight:600;letter-spacing:-.01em;font-size:15px}.masthead-row{display:flex;justify-content:space-between;align-items:baseline;gap:16px}.pr-title{font-size:clamp(22px,3.2vw,30px);line-height:1.2;font-weight:600;letter-spacing:-.02em;margin:18px 0 6px;max-width:30ch}.pr-title a{text-decoration:none}.pr-title a:hover{text-decoration:underline}.pr-meta{display:flex;flex-wrap:wrap;gap:4px 18px;margin:0;color:var(--ink-2);font-size:14px}.diffstat .plus{color:var(--add-ink)}.diffstat .minus{color:var(--del-ink)}.progress{margin:28px 0 20px}.progress-figure{margin:0 0 10px;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;font-size:15px;color:var(--ink-2)}.progress-figure strong{font-size:40px;line-height:1;font-weight:600;letter-spacing:-.03em;color:var(--ink);font-variant-numeric:tabular-nums}.progress-sub{color:var(--ink-3);font-size:14px}.strip{display:flex;gap:3px;height:22px}.seg{flex-basis:0;min-width:6px;border:0;padding:0;cursor:pointer;border-radius:2px;background:color-mix(in srgb,var(--tier) 22%,var(--paper));box-shadow:inset 0 -3px 0 var(--tier);transition:background-color .18s ease}.seg.is-done{background:var(--tier)}.seg:hover{background:color-mix(in srgb,var(--tier) 55%,var(--paper))}.toolbar{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);position:sticky;top:0;background:var(--paper);z-index:2}.tiers{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.toolbar-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap;min-width:0}.chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:14px;color:var(--ink-2);background:transparent;border:1px solid var(--rule);border-radius:999px;padding:3px 11px;cursor:pointer}.chip .n{color:var(--ink-3);font-variant-numeric:tabular-nums}.chip .dot{width:8px;height:8px;border-radius:50%;background:var(--tier)}.chip.is-on{background:var(--ink);border-color:var(--ink);color:var(--paper)}.chip.is-on .n{color:inherit;opacity:.7}.chip:disabled{opacity:.4;cursor:default}.check{display:inline-flex;gap:6px;align-items:center;font-size:14px;color:var(--ink-2);cursor:pointer}.search{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:5px 10px;width:min(280px,100%)}.hunks{margin-top:4px}.hunk{display:grid;grid-template-columns:64px minmax(0,1fr);gap:0 18px;padding:22px 0 22px 14px;border-bottom:1px solid var(--rule);position:relative;scroll-margin-top:64px}.hunk:before{content:"";position:absolute;left:0;top:22px;bottom:22px;width:4px;border-radius:2px;background:var(--tier)}.hunk.is-focused:after{content:"";position:absolute;inset:6px -10px;border-radius:8px;background:color-mix(in srgb,var(--accent) 6%,transparent);z-index:-1}.hunk.is-reviewed .hunk-score,.hunk.is-reviewed .hunk-path,.hunk.is-reviewed .summary{opacity:.55}.hunk-score{display:flex;flex-direction:column;align-items:flex-start}.hunk-score .score{font-size:28px;line-height:1;font-weight:600;letter-spacing:-.02em;color:var(--tier);font-variant-numeric:tabular-nums}.hunk-score .tier{font-size:13px;color:var(--ink-3);margin-top:4px}.hunk-path{margin:0;font-size:15px;font-weight:500;line-height:1.4;overflow-wrap:anywhere}.hunk-path .path{font-family:var(--mono);font-size:14px}.hunk-path .lines{color:var(--ink-3);font-weight:400;font-size:13px}.hunk-path .status{margin-left:8px;font-size:12px;font-weight:500;color:var(--ink-2);border:1px solid var(--rule);border-radius:4px;padding:0 6px}.summary{margin:6px 0 0;font-size:17px;line-height:1.45;max-width:70ch}.reasons{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-direction:column;gap:2px}.reason{display:flex;gap:10px;align-items:baseline;text-align:left;font:inherit;font-size:14px;color:var(--ink-2);background:none;border:0;padding:3px 8px 3px 0;border-radius:4px;cursor:pointer;max-width:100%}.reason:disabled{cursor:default}.reason:not(:disabled):hover{color:var(--ink)}.reason .weight{font-family:var(--mono);font-size:12px;color:var(--ink-3);min-width:3.2ch;text-align:right;font-variant-numeric:tabular-nums}.reason.is-active{color:var(--ink);background:var(--hit);padding-left:6px}.reason.is-relief .weight{color:var(--add-ink)}.reason code{overflow-wrap:anywhere;background:color-mix(in srgb,var(--ink) 7%,transparent);padding:0 3px;border-radius:3px}.hunk-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}.btn{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:5px 12px;cursor:pointer;display:inline-flex;align-items:center}.btn:hover{border-color:var(--ink-3)}.btn-review.is-on{background:var(--ink);color:var(--paper);border-color:var(--ink)}.btn-primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}.link{font:inherit;font-size:14px;color:var(--ink-2);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}.diff{margin-top:14px;border:1px solid var(--rule);border-radius:6px;overflow-x:auto;background:var(--surface);font:12.5px/1.6 var(--mono)}.diff-head{padding:4px 12px;color:var(--ink-3);border-bottom:1px solid var(--rule);white-space:pre}.dl{display:grid;grid-template-columns:4ch 4ch 2ch auto;min-width:max-content}.dl .ln{color:var(--ink-3);text-align:right;padding-right:8px;user-select:none}.dl .cov{color:var(--critical);text-align:center;font-size:9px;line-height:20px;user-select:none}.dl .code{white-space:pre;padding-right:16px}.dl .sign{display:inline-block;width:2ch;color:var(--ink-3);user-select:none}.dl-add{background:var(--add-bg)}.dl-add .sign{color:var(--add-ink)}.dl-del{background:var(--del-bg)}.dl-del .sign{color:var(--del-ink)}.dl.is-hit{background:var(--hit);box-shadow:inset 3px 0 0 var(--hit-edge)}.collapsed{margin-top:24px;color:var(--ink-2)}.collapsed summary{cursor:pointer;font-size:14px;padding:6px 0}.collapsed ul{list-style:none;margin:6px 0 0;padding:0}.collapsed li{display:flex;flex-wrap:wrap;gap:4px 12px;padding:7px 0;border-top:1px solid var(--rule);font-size:14px}.collapsed .path{font-family:var(--mono);font-size:13px;color:var(--ink)}.collapsed .lines{color:var(--ink-3);font-size:13px}.collapsed .why{color:var(--ink-2)}.foot{margin-top:40px;color:var(--ink-3);font-size:13px;max-width:70ch}.empty-list{padding:32px 0}.empty{max-width:620px;margin:0 auto;padding:18vh 24px 48px}.empty .brand{font-size:34px;letter-spacing:-.03em;margin:0}.lede{font-size:19px;line-height:1.5;color:var(--ink-2);margin:10px 0 28px}.empty-actions{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}.empty-actions .btn{padding:8px 16px;font-size:15px}.error{color:var(--critical)}@media(max-width:640px){.hunk{grid-template-columns:minmax(0,1fr);gap:6px}.toolbar-right,.search{width:100%}.hunk-score{flex-direction:row;align-items:baseline;gap:8px}.toolbar{position:static}.progress-figure strong{font-size:32px}}@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}.hunk-body{min-width:0}\n' };
  }
  const dist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const js = join(dist, "viewer.js");
  const css = join(dist, "viewer.css");
  if (!existsSync(js)) throw new Error("Viewer not built. Run `npm run build` first.");
  return { js: readFileSync(js, "utf8"), css: existsSync(css) ? readFileSync(css, "utf8") : "" };
}
function scriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");
}
function renderHtml(report) {
  const { js, css } = viewerAssets();
  const title = report.source?.title ? `SecondPass \xB7 ${report.source.title}` : "SecondPass report";
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>window.__SECONDPASS_REPORT__ = ${scriptSafeJson(report)};</script>
<script>${js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
}

// src/report/markdown.ts
import { createHash } from "node:crypto";
var COMMENT_MARKER = "<!-- secondpass:report -->";
var ICON = { critical: "\u{1F534}", high: "\u{1F7E0}", medium: "\u{1F7E1}", low: "\u26AA", trivial: "\u25AB\uFE0F" };
var MAX_COMMENT = 6e4;
var cell = (s) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
function lineRange(h) {
  const deleted = h.file.status === "deleted" || h.added === 0;
  if (deleted) {
    return { side: "L", start: h.hunk.oldStart, end: h.hunk.oldStart + Math.max(0, h.hunk.oldLines - 1) };
  }
  const added = h.hunk.lines.filter((l) => l.kind === "add" && l.newLine !== void 0).map((l) => l.newLine);
  return { side: "R", start: added[0] ?? h.hunk.newStart, end: added[added.length - 1] ?? h.hunk.newStart };
}
function githubAnchor(prUrl, path, side, line) {
  const digest = createHash("sha256").update(path).digest("hex");
  return `${prUrl.replace(/\/$/, "")}/files#diff-${digest}${side}${line}`;
}
function location(h, prUrl) {
  const { side, start, end } = lineRange(h);
  const label = `\`${h.hunk.path}\` ${start === end ? `L${start}` : `L${start}\u2013${end}`}`;
  return prUrl ? `[${label}](${githubAnchor(prUrl, h.hunk.path, side, start)})` : label;
}
function headlineReasons(signals, n = 2) {
  const main2 = signals.filter((s) => s.weight > 0 && s.category !== "size" && s.category !== "coverage");
  const cov = signals.find((s) => s.id === "coverage.uncovered" || s.id === "coverage.file-missing");
  const out = main2.slice(0, n).map((s) => s.reason);
  if (cov) out.push(cov.reason);
  if (!out.length) out.push(signals.find((s) => s.category === "size")?.reason ?? "Small change");
  return out;
}
function renderMarkdown(report, opts = {}) {
  const { totals } = report;
  const t = totals.byTier;
  const reviewable = report.hunks.filter((h) => h.risk.tier !== "trivial");
  const collapsed = report.hunks.filter((h) => h.risk.tier === "trivial");
  const limit = opts.limit ?? 25;
  const lines = [COMMENT_MARKER, "### SecondPass \xB7 where to look first", ""];
  lines.push(
    `**${totals.hunks} hunk${totals.hunks === 1 ? "" : "s"}** in ${totals.files} file${totals.files === 1 ? "" : "s"} (+${totals.added} \u2212${totals.removed}) \xB7 ${ICON.critical} ${t.critical} critical \xB7 ${ICON.high} ${t.high} high \xB7 ${ICON.medium} ${t.medium} medium \xB7 ${ICON.low} ${t.low} low \xB7 ${t.trivial} collapsed`
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
        `| ${ICON[h.risk.tier]} ${h.risk.score} | ${location(h, opts.prUrl)} | ${cell(h.summary ?? "")} | ${cell(headlineReasons(h.risk.signals).join(" \xB7 "))} |`
      );
    }
    if (reviewable.length > limit) {
      lines.push("", `\u2026and ${reviewable.length - limit} more lower-ranked hunk${reviewable.length - limit === 1 ? "" : "s"}${opts.reportUrl ? ` in the [full report](${opts.reportUrl})` : ""}.`);
    }
    lines.push("");
  }
  if (collapsed.length) {
    lines.push(`<details><summary>${collapsed.length} collapsed hunk${collapsed.length === 1 ? "" : "s"}: renames, formatting, imports, comments, generated files</summary>`, "");
    for (const h of collapsed) lines.push(`- ${location(h, opts.prUrl)} \u2014 ${h.risk.trivial?.reason ?? ""}`);
    lines.push("", "</details>", "");
  }
  if (report.notes.length) {
    lines.push("<details><summary>Not ranked</summary>", "", ...report.notes.map((n) => `- ${n}`), "", "</details>", "");
  }
  const modelLine = opts.model ? `One-line descriptions are written by \`${opts.model}\`; they never affect the order.` : "Descriptions are generated from the diff.";
  lines.push(
    `<sub>Order comes from the diff and test coverage only. ${modelLine}${opts.reportUrl ? ` \xB7 [Full report](${opts.reportUrl})` : ""}</sub>`
  );
  let md = lines.join("\n");
  if (md.length > MAX_COMMENT) {
    md = md.slice(0, MAX_COMMENT - 200).replace(/\n[^\n]*$/, "") + "\n\n_Truncated: the PR is too large for one comment. See the full report._";
  }
  return md;
}
var ANSI = { critical: "\x1B[31m", high: "\x1B[33m", medium: "\x1B[93m", low: "\x1B[37m", trivial: "\x1B[90m" };
function renderText(report, color = true) {
  const c = (code2, s) => color ? `${code2}${s}\x1B[0m` : s;
  const out = [];
  const t = report.totals.byTier;
  out.push(
    c("\x1B[1m", "SecondPass") + `  ${report.totals.hunks} hunks \xB7 ${t.critical} critical \xB7 ${t.high} high \xB7 ${t.medium} medium \xB7 ${t.low} low \xB7 ${t.trivial} collapsed`,
    ""
  );
  for (const h of report.hunks) {
    if (h.risk.tier === "trivial") continue;
    const { start, end } = lineRange(h);
    const loc = `${h.hunk.path}:${start}${end !== start ? `-${end}` : ""}`;
    out.push(`${c(ANSI[h.risk.tier], `${h.risk.tier.toUpperCase().padEnd(8)} ${String(h.risk.score).padStart(3)}`)}  ${c("\x1B[1m", loc)}`);
    if (h.summary) out.push(`              ${h.summary}`);
    for (const r of headlineReasons(h.risk.signals, 3)) out.push(c("\x1B[90m", `              \xB7 ${r}`));
    out.push("");
  }
  const collapsed = report.hunks.filter((h) => h.risk.tier === "trivial");
  if (collapsed.length) {
    out.push(c("\x1B[90m", `${collapsed.length} collapsed:`));
    for (const h of collapsed) out.push(c("\x1B[90m", `  ${h.hunk.path}:${lineRange(h).start}  ${h.risk.trivial?.reason}`));
  }
  return out.join("\n");
}

// src/summarize/anthropic.ts
var DEFAULT_MODEL = "claude-haiku-5-5";
var SYSTEM = `You describe code changes for a pull-request reviewer.

For each hunk you get a file path and a unified diff. Write ONE line, at most 110 characters, that says what the change does: present tense, starting with a verb, naming the concrete thing that changed (the function, field, condition, value or route).

You are a describer, not a reviewer. Another system has already decided how much attention each hunk needs, using the diff and test coverage. Do not judge the change. Never say whether it is safe, risky, correct, minor, important, cosmetic or tested. Never recommend or warn. Never use the words "safely", "just", "only", "simply", "should", "must", "potential" or "properly".

Good: "Rejects refunds made exactly 30 days after capture (> becomes >=)"
Good: "Stops awaiting ledger.post and drops the retry-exhausted rethrow"
Bad: "Minor refactor, safe to skip"
Bad: "Potentially dangerous change to auth"

Reply with JSON only: an object mapping each hunk key to its line, e.g. {"h1": "...", "h2": "..."}.`;
function parseSummaryJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function batches(items, maxChars, maxItems) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const it of items) {
    const len = it.diff.length + it.path.length + 40;
    if (cur.length && (size + len > maxChars || cur.length >= maxItems)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
function anthropicSummarizer(opts) {
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
  const model = opts.model ?? DEFAULT_MODEL;
  async function call(batch) {
    const keyed = batch.map((item, i) => ({ key: `h${i + 1}`, item }));
    const user = keyed.map(({ key, item }) => `<hunk key="${key}" path="${item.path}"${item.section ? ` context="${item.section.replace(/"/g, "'")}"` : ""}>
${item.diff}
</hunk>`).join("\n\n");
    const body = JSON.stringify({
      model,
      max_tokens: Math.min(4096, 120 + batch.length * 60),
      system: SYSTEM,
      messages: [{ role: "user", content: user }]
    });
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 6e4)
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const wait = Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
        await new Promise((r) => setTimeout(r, Math.min(wait, 20) * 1e3));
        continue;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${json.error?.message ?? res.statusText}`);
      const text = (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const parsed = parseSummaryJson(text);
      const out = /* @__PURE__ */ new Map();
      for (const { key, item } of keyed) {
        const v = parsed[key];
        if (typeof v === "string") out.set(item.id, v);
      }
      return out;
    }
  }
  return {
    async summarize(items) {
      const groups = batches(items, opts.batchChars ?? 4e4, opts.batchSize ?? 15);
      const results = await mapLimit(
        groups,
        opts.concurrency ?? 3,
        (g) => call(g).catch((err) => {
          process.emitWarning(`secondpass: summary batch failed: ${err instanceof Error ? err.message : String(err)}`);
          return /* @__PURE__ */ new Map();
        })
      );
      return new Map(results.flatMap((m) => [...m]));
    }
  };
}

// src/summarize/summarize.ts
var VERDICT = /\b(safe(ly)?|unsafe|risk(y|s)?|dangerous|harmless|innocuous|critical|severe|minor|trivial|benign|lgtm|looks\s+good|should|must|recommend\w*|consider|careful|concern\w*|potential(ly)?|bug(s|gy)?|vulnerab\w*|correct(ly)?|incorrect(ly)?|properly|improperly|well[- ]tested|untested|no\s+(functional|behaviou?r(al)?)\s+change|just|simply|merely|only\s+(a|cosmetic)|cosmetic|clean(s|ed)?\s*up|best\s+practice)\b/i;
function sanitizeSummary(raw) {
  if (typeof raw !== "string") return void 0;
  let s = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[-*•]\s*/, "").replace(/^["'`]|["'`]$/g, "").trim();
  if (!s || s.length < 6) return void 0;
  if (VERDICT.test(s)) return void 0;
  if (s.length > 140) s = s.slice(0, 139).replace(/\s+\S*$/, "") + "\u2026";
  return s.replace(/\.$/, "");
}
function heuristicSummary(h) {
  if (h.risk.trivial) return h.risk.trivial.reason;
  const section = h.hunk.section.replace(/\s*[{:]\s*$/, "").trim();
  const definition = /^(?!import\b|from\b|export\s*\{|#include|use\s|require)/.test(section) && /\(|\bclass\b|\bdef\b|\bfn\b|\bfunc\b|=>/.test(section);
  const where = definition ? ` in \`${section.length > 60 ? section.slice(0, 59) + "\u2026" : section}\`` : "";
  if (h.file.status === "added") return `New file: ${h.added} line${h.added === 1 ? "" : "s"}`;
  if (h.file.status === "deleted") return `Deletes file: ${h.removed} line${h.removed === 1 ? "" : "s"}`;
  if (h.removed === 0) return `Adds ${h.added} line${h.added === 1 ? "" : "s"}${where}`;
  if (h.added === 0) return `Removes ${h.removed} line${h.removed === 1 ? "" : "s"}${where}`;
  return `Changes ${h.removed} \u2192 ${h.added} lines${where}`;
}
async function attachSummaries(report, summarizer, opts = {}) {
  const fingerprint = rankingFingerprint(report);
  const candidates = report.hunks.filter((h) => !h.risk.trivial).slice(0, opts.maxHunks ?? 60);
  let fromModel = /* @__PURE__ */ new Map();
  if (summarizer && candidates.length) {
    try {
      fromModel = await summarizer.summarize(
        candidates.map((h) => ({ id: h.hunk.id, path: h.hunk.path, section: h.hunk.section, diff: hunkToText(h.hunk, 300) }))
      );
    } catch (err) {
      opts.onError?.(err);
    }
  }
  const hunks = report.hunks.map((h) => {
    const model = sanitizeSummary(fromModel.get(h.hunk.id));
    return model ? { ...h, summary: model, summarySource: "model" } : { ...h, summary: heuristicSummary(h), summarySource: "heuristic" };
  });
  const out = { ...report, hunks };
  if (rankingFingerprint(out) !== fingerprint) {
    throw new Error("internal: summaries changed the ranking");
  }
  return out;
}
function rankingFingerprint(report) {
  return report.hunks.map((h) => `${h.hunk.id}|${h.risk.score}|${h.risk.tier}`).join("\n");
}

// src/cli.ts
var HELP = `secondpass ${package_default.version}
Rank the hunks of a diff by risk so reviewers read the dangerous parts first.

Usage
  git diff origin/main...HEAD | secondpass
  secondpass --base origin/main --coverage coverage/lcov.info
  secondpass --diff pr.diff --summaries --html report.html

Input
  --diff <file|->        Unified diff to rank (default: stdin)
  --base <ref>           Run \`git diff <ref>...HEAD\` instead of reading a diff
  --coverage <file>      lcov.info or Cobertura XML for the head commit (repeatable)
  --ignore <regex>       Skip files whose path matches (repeatable)

Descriptions
  --summaries            One-line descriptions from Claude (needs ANTHROPIC_API_KEY).
                         They are added after ranking and never change it.
  --model <id>           Model for descriptions (default ${DEFAULT_MODEL})

Output
  --format <f>           text (default), markdown or json, printed to stdout
  --json <file>          Also write the JSON report
  --html <file>          Also write a self-contained HTML report
  --markdown <file>      Also write the PR-comment markdown
  --fail-on <tier>       Exit 2 if any hunk is at or above critical|high|medium
  --no-color             Plain text output
  -h, --help             Show this help
  -v, --version          Show version
`;
var RANK = { critical: 3, high: 2, medium: 1, low: 0, trivial: -1 };
function readStdin() {
  try {
    return readFileSync2(0, "utf8");
  } catch {
    return "";
  }
}
async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      diff: { type: "string" },
      base: { type: "string" },
      coverage: { type: "string", multiple: true },
      ignore: { type: "string", multiple: true },
      summaries: { type: "boolean", default: false },
      model: { type: "string" },
      format: { type: "string", default: "text" },
      json: { type: "string" },
      html: { type: "string" },
      markdown: { type: "string" },
      "fail-on": { type: "string" },
      "no-color": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false }
    },
    allowPositionals: false
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${package_default.version}
`);
    return 0;
  }
  let diff;
  if (values.base) {
    diff = execFileSync("git", ["diff", "--no-color", "--no-ext-diff", "-M", `${values.base}...HEAD`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024
    });
  } else if (values.diff && values.diff !== "-") {
    diff = readFileSync2(values.diff, "utf8");
  } else if (!process.stdin.isTTY) {
    diff = readStdin();
  } else {
    process.stderr.write(HELP);
    return 1;
  }
  const coverage = values.coverage?.length ? mergeCoverage(values.coverage.map((f) => parseCoverage(readFileSync2(f, "utf8")))) : void 0;
  const ignore = (values.ignore ?? []).map((r) => new RegExp(r));
  let report = analyze(diff, { coverage, ignore });
  const model = values.model ?? DEFAULT_MODEL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (values.summaries && !apiKey) {
    process.stderr.write("secondpass: --summaries needs ANTHROPIC_API_KEY; using diff-based descriptions.\n");
  }
  report = await attachSummaries(report, values.summaries && apiKey ? anthropicSummarizer({ apiKey, model }) : void 0, {
    onError: (e) => process.stderr.write(`secondpass: descriptions unavailable (${e instanceof Error ? e.message : String(e)})
`)
  });
  const usedModel = report.hunks.some((h) => h.summarySource === "model") ? model : void 0;
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2));
  if (values.html) writeFileSync(values.html, renderHtml(report));
  if (values.markdown) writeFileSync(values.markdown, renderMarkdown(report, { model: usedModel }));
  switch (values.format) {
    case "json":
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      break;
    case "markdown":
    case "md":
      process.stdout.write(renderMarkdown(report, { model: usedModel }) + "\n");
      break;
    case "text":
      process.stdout.write(renderText(report, !values["no-color"] && process.stdout.isTTY === true && !process.env.NO_COLOR) + "\n");
      break;
    default:
      process.stderr.write(`secondpass: unknown --format ${values.format}
`);
      return 1;
  }
  const failOn = values["fail-on"];
  if (failOn) {
    if (!(failOn in RANK) || failOn === "trivial" || failOn === "low") {
      process.stderr.write(`secondpass: --fail-on must be critical, high or medium
`);
      return 1;
    }
    if (report.hunks.some((h) => RANK[h.risk.tier] >= RANK[failOn])) return 2;
  }
  return 0;
}
main(process.argv.slice(2)).then(
  (code2) => process.exit(code2),
  (err) => {
    process.stderr.write(`secondpass: ${err instanceof Error ? err.message : String(err)}
`);
    process.exit(1);
  }
);
