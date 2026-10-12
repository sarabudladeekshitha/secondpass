import type { DiffLine, FileDiff, Hunk, Signal } from "../types.ts";
import { extname, isCommentLine, similarity, tokenize } from "./lang.ts";

/* ------------------------------------------------------------------ paths */

export const MIGRATION_PATH =
  /(^|\/)(migrations?|migrate|alembic\/versions|db\/migrate|flyway|liquibase|changelog)\/|\.sql$|(^|\/)schema\.prisma$|(^|\/)structure\.sql$|(^|\/)schema\.rb$/i;
export const AUTH_PATH =
  /(^|[\/_.-])(auth\w*|login|logout|sessions?|permissions?|rbac|acl|oauth\w*|jwt|passwords?|tokens?|guards?|policies|policy|sso|saml|iam|middleware\/auth\w*|security)([\/_.-]|$)/i;
export const MONEY_PATH =
  /(^|[\/_.-])(payments?|billing|invoices?|checkout|ledger|wallets?|pricing|prices?|refunds?|subscriptions?|stripe|braintree|paypal|currenc(y|ies)|tax(es)?|payouts?|charges?|money|orders?)([\/_.-]|$)/i;
const CI_PATH = /(^|\/)(\.github\/workflows|\.gitlab-ci\.yml|\.circleci|Jenkinsfile|azure-pipelines|buildkite)|(^|\/)Dockerfile|\.tf$|(^|\/)(k8s|kubernetes|helm|charts|deploy|infra)\//i;
const SECRET_PATH = /(^|\/)\.env(\.|$)|secrets?\.(ya?ml|json)$|credentials/i;
const MANIFEST_PATH =
  /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|setup\.py|Pipfile|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|composer\.json|\w+\.csproj)$/;
export const TEST_PATH =
  /(^|\/)(__tests__|tests?|spec|specs|e2e|testing|fixtures)\/|[._-](test|spec)\.\w+$|_test\.go$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$/i;
const DOC_EXT = new Set(["md", "mdx", "rst", "txt", "adoc"]);

export function isTestPath(p: string): boolean {
  return TEST_PATH.test(p);
}
export function isDocPath(p: string): boolean {
  return DOC_EXT.has(extname(p)) || /(^|\/)(docs?|LICENSE|CHANGELOG)/.test(p);
}

/* -------------------------------------------------------------- patterns */

const SQL_DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE|CONSTRAINT|TYPE|VIEW)|TRUNCATE(\s+TABLE)?)\b/i;
const SQL_DELETE_NO_WHERE = /\bDELETE\s+FROM\s+[\w."`]+\s*(;|$)/i;
const SQL_UPDATE_NO_WHERE = /\bUPDATE\s+[\w."`]+\s+SET\b(?![^;]*\bWHERE\b)[^;]*(;|$)/i;
const SQL_ALTER_COLUMN = /\b(ALTER\s+COLUMN|MODIFY\s+COLUMN|RENAME\s+COLUMN|RENAME\s+TO|CHANGE\s+COLUMN|TYPE\s+\w+\s+USING)\b/i;
const SQL_ADD_NOT_NULL = /\bADD\s+(COLUMN\s+)?[\w"`]+\s+[\w()]+[^;]*\bNOT\s+NULL\b(?![^;]*\bDEFAULT\b)/i;
const SQL_INDEX_LOCKING = /\bCREATE\s+(UNIQUE\s+)?INDEX\b(?![^;]*\bCONCURRENTLY\b)/i;
const ORM_DESTRUCTIVE =
  /\b(drop_table|remove_column|remove_index|dropColumn|dropTable|removeColumn|dropIndex|drop_column|op\.drop_\w+|DeleteModel|RemoveField|deleteColumn)\b/;
const ORM_ALTER = /\b(rename_column|renameColumn|change_column|changeColumn|alter_column|AlterField|RenameField|op\.alter_column|change_column_null)\b/;

const AUTH_GUARD =
  /\b(requireAuth\w*|require_auth\w*|login_required|permission_required|authorize\w*|authenticate\w*|isAuthenticated|is_authenticated|ensure(Auth|Logged|Admin)\w*|check_?[Pp]ermission\w*|has_?[Pp]ermission\w*|has_?[Rr]ole\w*|is_?[Aa]dmin|can[A-Z]\w*|verify(Token|Signature|Jwt|JWT|Password|Hmac|Webhook)\w*|requireRole\w*|@PreAuthorize|@Secured|@RolesAllowed|before_action\s+:authenticate\w*)\b/;
const AUTH_TERMS =
  /\b(jwt|bcrypt|argon2|scrypt|pbkdf2|csrf|xsrf|httpOnly|sameSite|allowedOrigins|Access-Control-Allow-\w+|cors|session\w*|cookie\w*|password\w*|tenant_?[Ii]d|owner_?[Ii]d|scopes?|roles?|permissions?|api_?[Kk]ey|bearer|oauth\w*|mfa|otp|totp)\b/i;

/** Words naming an amount of money. Arithmetic on these is what matters. */
const AMOUNT_WORDS = [
  "amount", "price", "subtotal", "balance", "cents", "fee", "tax", "vat", "discount", "cost",
  "credit", "debit", "salary", "wage", "proration", "refunded", "charged", "paid", "owed", "money",
];
/** Words naming money-handling things (a refund, the ledger). */
const ENTITY_WORDS = ["refund", "charge", "payment", "invoice", "payout", "ledger", "wallet", "currency", "coupon", "fx"];
const FLOAT_MONEY = /\b(parseFloat|toFixed|float\s*\(|Number\s*\(|as\s+f(32|64)|double\b|Float)\b/;

const EMPTY_CATCH =
  /\bcatch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*(\{\s*\}|null|undefined)\s*\)|\bexcept(\s+[\w.,\s()]+)?(\s+as\s+\w+)?\s*:\s*pass\b|\brescue\s*(=>\s*\w+)?\s*;?\s*(nil|end)\b|_\s*=\s*err\b/;
const ERROR_HANDLING = /\b(catch|except|rescue|finally|throw|raise|panic|recover|try)\b|\bif\s+err\s*!=\s*nil\b|\.catch\(/;
const SUPPRESSION = /(@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|# type:\s*ignore|#\s*noqa|nolint|@SuppressWarnings|# pragma: no cover|istanbul ignore|c8 ignore)/;

const EXEC = /\b(eval|execSync|exec|spawnSync|spawn|execFile|system|popen|Popen|check_output)\s*\(|new\s+Function\s*\(|child_process|shell\s*=\s*True|os\.system|Runtime\.getRuntime\(\)\.exec/;
const RAW_HTML = /\binnerHTML\b|\bouterHTML\b|dangerouslySetInnerHTML|\bv-html\b|\|\s*safe\b|\bmark_safe\b|\bhtml_safe\b|\braw\s*\(|\bdocument\.write\s*\(|\{\{\{/;
const SQL_INTERP =
  /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;]*(\$\{|["'`]\s*\+\s*\w|\+\s*["'`]|%s|\{[a-z_]\w*\}|\.format\()|\bf["'](SELECT|INSERT|UPDATE|DELETE)\b/i;
const SECRET_ASSIGN =
  /\b[\w-]*(api[_-]?key|secret|passw(or)?d|private[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)[\w-]*["']?\s*[:=]\s*["'][^"'\s$<>{}]{8,}["']/i;
const SECRET_LITERAL = /AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk_live_[0-9a-zA-Z]{10,}|\bghp_[0-9A-Za-z]{30,}|\bxox[baprs]-[0-9A-Za-z-]{10,}/;
const TLS_OFF = /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED|CURLOPT_SSL_VERIFYPEER\s*,\s*(0|false)|ssl_verify\s*[:=]\s*false/i;
const WEAK_CRYPTO = /\b(md5|sha1|DES|RC4|Math\.random)\b/;

const CONCURRENCY =
  /\b(transaction|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|FOR\s+UPDATE|lock\w*|mutex|semaphore|atomic\w*|synchronized|Promise\.(all|race|allSettled)|setTimeout|setInterval|retry\w*|idempoten\w*|goroutine|go\s+func|async\s+with|threading|asyncio\.gather)\b/;
const LIMIT_WORDS = /(timeout|retries|retry|limit|max|min|ttl|expir|interval|threshold|rate|size|batch|window|duration|delay|backoff|attempts)/i;
const FLAG = /\b(feature_?[Ff]lag\w*|isEnabled|is_enabled|isFeatureEnabled|flags?\.\w+|launchdarkly|unleash|optimizely|growthbook|FEATURE_\w+)\b/;

const ROUTE =
  /\b(app|router|server|api|r)\.(get|post|put|patch|delete|all|use|route)\s*\(|@(app|router|bp|blueprint)\.(route|get|post|put|patch|delete)\b|@(Get|Post|Put|Patch|Delete|Request)Mapping\b|\bpath\s*\(\s*["']|\burl\s*\(\s*r?["']\^?/;
const EXPORTED =
  /^\s*(export\s+(default\s+)?(async\s+)?(function|class|const|let|interface|type|enum)\b|public\s+(static\s+)?[\w<>[\],\s]+\s+\w+\s*\(|def\s+[a-z]\w*\s*\(|func\s+[A-Z]\w*\s*\(|func\s+\([^)]*\)\s+[A-Z]\w*\s*\(|pub\s+(fn|struct|enum|trait)\b)/;

const COMPARISON = new Set(["<", ">", "<=", ">=", "==", "!=", "===", "!==", "is", "in"]);
const LOGICAL = new Set(["&&", "||", "and", "or", "??"]);

/* ---------------------------------------------------------------- helpers */

interface Ctx {
  file: FileDiff;
  hunk: Hunk;
  path: string;
  added: DiffLine[];
  removed: DiffLine[];
  /** Removed lines paired with their most similar added line. */
  pairs: Array<[DiffLine, DiffLine]>;
  unpairedAdded: DiffLine[];
  unpairedRemoved: DiffLine[];
}

/** Index of each line within its hunk, filled per `detectSignals` call. */
const INDEX = new WeakMap<DiffLine, number>();
const lineNo = (l: DiffLine): number => INDEX.get(l) ?? -1;

function code(lines: DiffLine[], path: string): DiffLine[] {
  return lines.filter((l) => !isCommentLine(l.text, path));
}

function hits(lines: DiffLine[], re: RegExp): DiffLine[] {
  return lines.filter((l) => re.test(l.text));
}

function snippet(s: string, max = 48): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Multi-character operators are joined so `<=` is one token. */
function opTokens(text: string): string[] {
  const out: string[] = [];
  const re = /===|!==|==|!=|<=|>=|&&|\|\||\?\?|=>|[A-Za-z_$][\w$]*|\d[\w.]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\S/g;
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

/** Tokens removed from `a` and inserted in `b`, via LCS on tokens. */
export function tokenDelta(a: string, b: string): { removed: string[]; inserted: string[] } {
  const x = opTokens(a).slice(0, 200);
  const y = opTokens(b).slice(0, 200);
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const removed: string[] = [];
  const inserted: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) removed.push(x[i++]!);
    else inserted.push(y[j++]!);
  }
  while (i < x.length) removed.push(x[i++]!);
  while (j < y.length) inserted.push(y[j++]!);
  return { removed, inserted };
}

function pairLines(removed: DiffLine[], added: DiffLine[]) {
  const pairs: Array<[DiffLine, DiffLine]> = [];
  const used = new Set<DiffLine>();
  const pairedRemoved = new Set<DiffLine>();
  for (const r of removed) {
    if (r.text.trim() === "") continue;
    let best: DiffLine | undefined;
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
    unpairedRemoved: removed.filter((r) => !pairedRemoved.has(r) && r.text.trim() !== ""),
  };
}

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const stripStrings = (t: string) => t.replace(STRING_LITERAL, '""');

function matchesWord(w: string, list: string[]): boolean {
  return list.some((m) => w === m || w === m + "s" || w === m + "es" || (m.length >= 6 && w.startsWith(m)));
}

/**
 * Value identifiers that name an amount of money: the *last* camelCase /
 * snake_case word must be a money term (`refundAmountCents`, `total_price`),
 * so `paymentId` or `refundHandler` don't count. Function names are skipped.
 */
export function moneyIdentifiers(text: string, kind: "amount" | "any" = "any"): string[] {
  const list = kind === "amount" ? AMOUNT_WORDS : [...AMOUNT_WORDS, ...ENTITY_WORDS];
  const src = stripStrings(text);
  const out = new Set<string>();
  for (const m of src.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const id = m[0];
    const after = src.slice(m.index! + id.length);
    if (/^\s*\(/.test(after) || /\b(function|def|func|fn)\s+$/.test(src.slice(0, m.index))) continue;
    const words = id.split(/_+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
    const last = words[words.length - 1];
    if (last && matchesWord(last, list)) out.add(id);
  }
  return [...out];
}

/** True if a money identifier is an operand of arithmetic, rounding or conversion. */
function moneyArithmetic(text: string, ids: string[]): boolean {
  const src = stripStrings(text);
  return ids.some((id) => {
    const e = id.replace(/\$/g, "\\$");
    return new RegExp(
      `\\b${e}\\b\\s*([+\\-*/%](?![/*])|[+\\-*/%]?=(?![=>]))` + // amount * 2, amount += x, amount = …
        `|([+\\-*/%]|[^=!<>]=)\\s*\\(?\\s*(\\w+\\.)*${e}\\b` + // x - amount, total = amount
        `|\\b(round|floor|ceil|trunc|toFixed|parseFloat|parseInt|Number|float|int|Decimal|BigDecimal|BigInt|quantize)\\s*\\([^)]*\\b${e}\\b` +
        `|\\b${e}\\b[\\w.]*\\.(toFixed|round|quantize)\\b`,
    ).test(src);
  });
}

/* -------------------------------------------------------------- detectors */

type Detector = (c: Ctx) => Signal[];

const pathSignals: Detector = ({ file, path, added, removed }) => {
  const out: Signal[] = [];
  if (MIGRATION_PATH.test(path)) {
    out.push({ id: "path.migration", category: "migration", weight: 30, reason: "Database migration or schema file" });
    if (file.status === "modified" && /(^|\/)(migrations?|migrate|alembic\/versions|db\/migrate)\//i.test(path) && removed.length > 0) {
      out.push({
        id: "migration.edited",
        category: "migration",
        weight: 30,
        reason: "Edits an existing migration that may already have run in production",
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
        at: changed.map(lineNo),
      });
    }
  }
  return out;
};

const schemaSignals: Detector = ({ path, added }) => {
  const out: Signal[] = [];
  const src = code(added, path);
  const destructive = [...hits(src, SQL_DESTRUCTIVE), ...hits(src, ORM_DESTRUCTIVE)];
  if (destructive.length) {
    const m = destructive[0]!.text.match(SQL_DESTRUCTIVE) ?? destructive[0]!.text.match(ORM_DESTRUCTIVE);
    out.push({
      id: "schema.destructive",
      category: "data",
      weight: 55,
      reason: `Destructive schema change: \`${snippet(m?.[0] ?? destructive[0]!.text, 32)}\` cannot be rolled back without data loss`,
      at: destructive.map(lineNo),
    });
  }
  const noWhere = [...hits(src, SQL_DELETE_NO_WHERE), ...hits(src, SQL_UPDATE_NO_WHERE)];
  if (noWhere.length) {
    out.push({
      id: "sql.no-where",
      category: "data",
      weight: 45,
      reason: "UPDATE / DELETE with no WHERE clause touches every row",
      at: noWhere.map(lineNo),
    });
  }
  const alter = [...hits(src, SQL_ALTER_COLUMN), ...hits(src, ORM_ALTER)];
  if (alter.length) {
    out.push({
      id: "schema.alter-column",
      category: "migration",
      weight: 32,
      reason: "Renames or retypes a column; running code may still expect the old shape",
      at: alter.map(lineNo),
    });
  }
  const notNull = hits(src, SQL_ADD_NOT_NULL);
  if (notNull.length) {
    out.push({
      id: "schema.not-null-no-default",
      category: "migration",
      weight: 30,
      reason: "Adds a NOT NULL column without a default; fails or rewrites existing rows",
      at: notNull.map(lineNo),
    });
  }
  const idx = hits(src, SQL_INDEX_LOCKING);
  if (idx.length && /\.sql$|migrat/i.test(path)) {
    out.push({
      id: "schema.locking-index",
      category: "migration",
      weight: 16,
      reason: "Index built without CONCURRENTLY can lock writes on large tables",
      at: idx.map(lineNo),
    });
  }
  return out;
};

const authSignals: Detector = ({ path, added, removed }) => {
  if (isTestPath(path)) return [];
  const out: Signal[] = [];
  // Count guard calls on each side. A removed line is often *edited* rather
  // than deleted (`requireAuth, requireRole("x"), h` → `requireAuth, h`), so
  // compare occurrences instead of looking only at deleted lines.
  const guardGlobal = new RegExp(AUTH_GUARD.source, "g");
  const count = (ls: DiffLine[]) => {
    const m = new Map<string, number>();
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
      at: lostLines.map(lineNo),
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
      at: touched.map(lineNo),
    });
  }
  return out;
};

const ARITH_TOKEN = /^([+\-*/%]=?|=|round|floor|ceil|trunc|toFixed|parseFloat|parseInt|Number|float|int|Decimal|BigDecimal|BigInt|quantize)$/;

const moneySignals: Detector = ({ path, added, removed, pairs }) => {
  if (isTestPath(path)) return [];
  const out: Signal[] = [];
  const changed = code([...added, ...removed], path);
  const withMoney = changed.filter((l) => moneyIdentifiers(l.text).length > 0);
  if (!withMoney.length) return out;

  // An edited line only counts as money arithmetic if the edit itself touches
  // the money expression. Dropping `await` from `post({ amount: -x })` does not.
  const partner = new Map<DiffLine, DiffLine>();
  for (const [d, a] of pairs) {
    partner.set(d, a);
    partner.set(a, d);
  }
  const editTouchesMoney = (l: DiffLine) => {
    const other = partner.get(l);
    if (!other) return true;
    const [before, after] = l.kind === "del" ? [l.text, other.text] : [other.text, l.text];
    const { removed: r, inserted: i } = tokenDelta(before, after);
    const ids = new Set([...moneyIdentifiers(before, "amount"), ...moneyIdentifiers(after, "amount")]);
    return [...r, ...i].some((t) => ids.has(t) || ARITH_TOKEN.test(t) || /^\d/.test(t));
  };
  const arithmetic = withMoney.filter((l) => moneyArithmetic(l.text, moneyIdentifiers(l.text, "amount")) && editTouchesMoney(l));
  const names = [
    ...new Set((arithmetic.length ? arithmetic : withMoney).flatMap((l) => moneyIdentifiers(l.text, arithmetic.length ? "amount" : "any"))),
  ].slice(0, 3);
  if (arithmetic.length) {
    out.push({
      id: "money.arithmetic",
      category: "money",
      weight: 32,
      reason: `Arithmetic or rounding on money values (${names.map((n) => `\`${n}\``).join(", ")})`,
      at: arithmetic.map(lineNo),
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
      at: withMoney.map(lineNo),
    });
  }
  return out;
};

const behaviourSignals: Detector = ({ path, pairs, unpairedRemoved, unpairedAdded }) => {
  const out: Signal[] = [];
  const push = (s: Signal) => {
    const existing = out.find((o) => o.id === s.id);
    if (existing) existing.at = [...(existing.at ?? []), ...(s.at ?? [])];
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
      push({ id: "behaviour.comparison", category: "behaviour", weight: 26, reason: `Boundary changed: \`${cmpOld}\` → \`${cmpNew}\``, at: at });
    }
    const logOld = removed.find((t) => LOGICAL.has(t));
    const logNew = inserted.find((t) => LOGICAL.has(t));
    if (logOld && logNew && logOld !== logNew) {
      push({ id: "behaviour.logic", category: "behaviour", weight: 26, reason: `Logic changed: \`${logOld}\` → \`${logNew}\``, at: at });
    }
    const negations = (ts: string[]) => ts.filter((t) => t === "!" || t === "not").length;
    if (negations(removed) !== negations(inserted)) {
      push({ id: "behaviour.negation", category: "behaviour", weight: 24, reason: "Condition negated or un-negated", at: at });
    }
    const numOld = removed.find((t) => /^\d/.test(t));
    const numNew = inserted.find((t) => /^\d/.test(t));
    if (numOld && numNew && numOld !== numNew) {
      const limit = LIMIT_WORDS.test(add.text);
      push({
        id: limit ? "behaviour.limit" : "behaviour.constant",
        category: "behaviour",
        weight: limit ? 18 : 12,
        reason: limit ? `Limit or timeout changed: ${numOld} → ${numNew}` : `Constant changed: ${numOld} → ${numNew}`,
        at: at,
      });
    }
    const boolOld = removed.find((t) => /^(true|false|True|False)$/.test(t));
    const boolNew = inserted.find((t) => /^(true|false|True|False)$/.test(t));
    if (boolOld && boolNew && boolOld.toLowerCase() !== boolNew.toLowerCase()) {
      push({ id: "behaviour.boolean", category: "behaviour", weight: 20, reason: `Boolean flipped: \`${boolOld}\` → \`${boolNew}\``, at: at });
    }
    if (removed.includes("await") && !inserted.includes("await")) {
      push({ id: "concurrency.await-removed", category: "concurrency", weight: 26, reason: "`await` removed: the call is no longer waited for", at: at });
    }
    if (/^\s*return\b/.test(del.text) && /^\s*return\b/.test(add.text)) {
      push({ id: "behaviour.return", category: "behaviour", weight: 14, reason: "Return value changed", at: at });
    }
  }

  // Lost throws/raises are reported by the error-handling detector instead.
  const exits = code(unpairedRemoved, path).filter(
    (l) => !/\b(throw|raise|panic)\b/.test(l.text) && (/^\s*(if\b.*)?\b(return|abort|continue|break)\b/.test(l.text) || /^\s*if\b/.test(l.text)),
  );
  if (exits.length) {
    push({
      id: "behaviour.guard-removed",
      category: "behaviour",
      weight: 22,
      reason: `Condition or early exit removed: \`${snippet(exits[0]!.text)}\``,
      at: exits.map(lineNo),
    });
  }
  const newBranches = code(unpairedAdded, path).filter((l) => /^\s*(\}?\s*else\b|if\b|elif\b|case\b|switch\b|match\b|when\b|unless\b)/.test(l.text));
  if (newBranches.length) {
    push({
      id: "behaviour.branch-added",
      category: "behaviour",
      weight: 14,
      reason: `New branch: \`${snippet(newBranches[0]!.text)}\``,
      at: newBranches.map(lineNo),
    });
  }
  return out;
};

const errorSignals: Detector = ({ path, added, unpairedRemoved }) => {
  const out: Signal[] = [];
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
      reason: `Error handling removed: \`${snippet(lostHandling[0]!.text)}\``,
      at: lostHandling.map(lineNo),
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
        at: hits(unpairedRemoved, assertion).map(lineNo),
      });
    }
    const skipped = hits(added, /\b(it|test|describe)\.(skip|only)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|@unittest\.skip|t\.Skip\(/);
    if (skipped.length) {
      out.push({ id: "test.skipped", category: "behaviour", weight: 20, reason: "Test skipped or focused with .only", at: skipped.map(lineNo) });
    }
  }
  return out;
};

const securitySignals: Detector = ({ path, added }) => {
  const out: Signal[] = [];
  const src = code(added, path);
  const add = (id: string, weight: number, reason: string, ls: DiffLine[]) => {
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

const runtimeSignals: Detector = ({ path, added, removed, unpairedRemoved }) => {
  const out: Signal[] = [];
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
      reason: `Public symbol removed or re-signed: \`${snippet(exported[0]!.text, 40)}\``,
      at: exported.map(lineNo),
    });
  }
  return out;
};

const sizeSignal: Detector = ({ added, removed, path }) => {
  const n = code(added, path).length + code(removed, path).length;
  if (n === 0) return [];
  const weight = Math.min(14, Math.round(3 + n / 5));
  return [{ id: "size", category: "size", weight, reason: `${n} changed line${n === 1 ? "" : "s"} of code` }];
};

const DETECTORS: Detector[] = [
  pathSignals,
  schemaSignals,
  authSignals,
  moneySignals,
  behaviourSignals,
  errorSignals,
  securitySignals,
  runtimeSignals,
  sizeSignal,
];

/** Run every detector against one hunk. Pure: depends only on the diff. */
export function detectSignals(file: FileDiff, hunk: Hunk): Signal[] {
  const added = hunk.lines.filter((l) => l.kind === "add");
  const removed = hunk.lines.filter((l) => l.kind === "del");
  const { pairs, unpairedAdded, unpairedRemoved } = pairLines(removed, added);
  const ctx: Ctx = { file, hunk, path: hunk.path, added, removed, pairs, unpairedAdded, unpairedRemoved };
  hunk.lines.forEach((l, i) => INDEX.set(l, i));
  const detectors = isDocPath(hunk.path) ? [sizeSignal] : DETECTORS;
  const signals = detectors.flatMap((d) => d(ctx));
  for (const s of signals) if (s.at) s.at = [...new Set(s.at.filter((i) => i >= 0))].sort((a, b) => a - b);
  return signals;
}
