import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moneyIdentifiers } from "../src/risk/signals.ts";
import { ids, rank } from "./helpers.ts";

describe("risk signals", () => {
  describe("migrations and data", () => {
    it("treats DROP COLUMN as destructive and critical", () => {
      const h = rank("db/migrations/002.sql", [], ["ALTER TABLE users DROP COLUMN legacy_email;"]);
      assert.ok(ids(h).includes("schema.destructive"));
      assert.equal(h.risk.tier, "critical");
    });

    it("flags ORM-level destructive operations", () => {
      const h = rank("db/migrate/20260101_cleanup.rb", [], ["    remove_column :users, :ssn"]);
      assert.ok(ids(h).includes("schema.destructive"));
    });

    it("flags DELETE and UPDATE without WHERE", () => {
      assert.ok(ids(rank("scripts/fix.sql", [], ["DELETE FROM sessions;"])).includes("sql.no-where"));
      assert.ok(ids(rank("scripts/fix.sql", [], ["UPDATE accounts SET plan = 'free';"])).includes("sql.no-where"));
      assert.ok(!ids(rank("scripts/fix.sql", [], ["UPDATE accounts SET plan = 'free' WHERE id = 1;"])).includes("sql.no-where"));
    });

    it("flags NOT NULL columns added without a default", () => {
      const h = rank("migrations/003.sql", [], ["ALTER TABLE orders ADD COLUMN region TEXT NOT NULL;"]);
      assert.ok(ids(h).includes("schema.not-null-no-default"));
    });

    it("flags editing a migration that already exists", () => {
      const h = rank("migrations/001_init.sql", ["CREATE TABLE a (id INT);"], ["CREATE TABLE a (id BIGINT);"]);
      assert.ok(ids(h).includes("migration.edited"));
    });
  });

  describe("auth", () => {
    it("catches a guard removed from an edited line, not just a deleted one", () => {
      const h = rank(
        "src/routes.ts",
        ['router.post("/refunds", requireAuth, requireRole("billing"), refund);'],
        ['router.post("/refunds", requireAuth, refund);'],
      );
      assert.ok(ids(h).includes("auth.guard-removed"));
      assert.match(h.risk.signals.find((s) => s.id === "auth.guard-removed")!.reason, /requireRole/);
    });

    it("does not report a guard as removed when it was only moved", () => {
      const h = rank("src/routes.ts", ["  if (!isAdmin(user)) throw forbidden();", "  load();"], ["  load();", "  if (!isAdmin(user)) throw forbidden();"]);
      assert.ok(!ids(h).includes("auth.guard-removed"));
    });

    it("ranks an auth check removal critical even when tests run the line", async () => {
      const { analyze } = await import("../src/analyze.ts");
      const { parseLcov } = await import("../src/risk/coverage.ts");
      const { diffOf } = await import("./helpers.ts");
      const diff = diffOf("src/api/admin.ts", ["app.delete('/users/:id', requireAuth, isAdmin, del);"], ["app.delete('/users/:id', requireAuth, del);"]);
      const r = analyze(diff, { coverage: parseLcov("SF:src/api/admin.ts\nDA:1,9\nend_of_record\n") });
      assert.equal(r.hunks[0]!.risk.tier, "critical");
    });
  });

  describe("money", () => {
    it("recognises amount identifiers by their last word only", () => {
      assert.deepEqual(moneyIdentifiers("const refundAmountCents = total_price - discount;").sort(), ["discount", "refundAmountCents", "total_price"]);
      assert.deepEqual(moneyIdentifiers("paymentId, refundHandler, syntax, coffee", "amount"), []);
      assert.deepEqual(moneyIdentifiers('formatCents(x); log("price is")'), []);
    });

    it("flags arithmetic on money and floating-point conversion", () => {
      const h = rank("src/checkout/total.ts", ["  const feeCents = amountCents * 0.03;"], ["  const feeCents = Math.round(parseFloat(amount) * 0.029 * 100);"]);
      assert.ok(ids(h).includes("money.arithmetic"));
      assert.ok(ids(h).includes("money.float"));
    });

    it("ignores money arithmetic on a line whose edit didn't touch it", () => {
      const h = rank("src/jobs/sync.ts", ["    await ledger.post({ amountCents: -refund.amountCents });"], ["    ledger.post({ amountCents: -refund.amountCents });"]);
      assert.ok(!ids(h).includes("money.arithmetic"));
      assert.ok(ids(h).includes("concurrency.await-removed"));
    });
  });

  describe("behaviour", () => {
    it("reports boundary flips with the exact operators", () => {
      const h = rank("src/limits.ts", ["  if (age > MAX_DAYS) {"], ["  if (age >= MAX_DAYS) {"]);
      const s = h.risk.signals.find((x) => x.id === "behaviour.comparison");
      assert.ok(s);
      assert.match(s.reason, />.*>=/);
    });

    it("reports && ↔ || and negation changes", () => {
      assert.ok(ids(rank("src/a.ts", ["if (a && b) go();"], ["if (a || b) go();"])).includes("behaviour.logic"));
      assert.ok(ids(rank("src/a.ts", ["if (ready) go();"], ["if (!ready) go();"])).includes("behaviour.negation"));
    });

    it("distinguishes limits from other constants", () => {
      assert.ok(ids(rank("src/a.ts", ["const TIMEOUT_MS = 3000;"], ["const TIMEOUT_MS = 30000;"])).includes("behaviour.limit"));
      assert.ok(ids(rank("src/a.ts", ["const RATIO = 3;"], ["const RATIO = 4;"])).includes("behaviour.constant"));
    });

    it("reports removed early exits and new branches", () => {
      assert.ok(ids(rank("src/a.ts", ["  if (!user) return null;", "  work();"], ["  work();"])).includes("behaviour.guard-removed"));
      assert.ok(ids(rank("src/a.ts", [], ["  if (user.trial) {", "    skipBilling();", "  }"])).includes("behaviour.branch-added"));
    });
  });

  describe("errors and security", () => {
    it("flags swallowed errors in several languages", () => {
      assert.ok(ids(rank("src/a.ts", [], ["} catch (e) {}"])).includes("error.swallowed"));
      assert.ok(ids(rank("app/a.py", [], ["except Exception: pass"])).includes("error.swallowed"));
      assert.ok(ids(rank("src/a.ts", [], ["p.catch(() => {})"])).includes("error.swallowed"));
    });

    it("flags secrets, TLS bypass, SQL interpolation and shell execution", () => {
      assert.ok(ids(rank("src/a.ts", [], ['const API_KEY = "sk_live_abcdefghijklmnop";'])).includes("security.secret"));
      assert.ok(ids(rank("src/a.ts", [], ["const agent = new Agent({ rejectUnauthorized: false });"])).includes("security.tls-off"));
      assert.ok(ids(rank("src/a.ts", [], ["db.query(`SELECT * FROM users WHERE email = '${email}'`);"])).includes("security.sql-interp"));
      assert.ok(ids(rank("src/a.ts", [], ["execSync(`git checkout ${branch}`);"])).includes("security.exec"));
    });

    it("does not flag secrets read from the environment", () => {
      assert.ok(!ids(rank("src/a.ts", [], ["const API_KEY = process.env.API_KEY;"])).includes("security.secret"));
    });

    it("flags weakened tests: removed assertions and skipped tests", () => {
      assert.ok(ids(rank("test/a.test.ts", ["  expect(total).toBe(10);"], [])).includes("test.assertions-removed"));
      assert.ok(ids(rank("test/a.test.ts", [], ['it.skip("charges tax", () => {});'])).includes("test.skipped"));
    });
  });

  describe("context", () => {
    it("runs no code detectors on documentation", () => {
      const h = rank("docs/billing.md", ["Refunds are always full."], ["Refunds may be partial; DROP TABLE is never run."]);
      assert.deepEqual(ids(h), ["size"]);
      assert.equal(h.risk.tier, "low");
    });

    it("discounts test-file changes that don't weaken the suite", () => {
      const src = rank("src/pricing.ts", [], ["export function f(x) {", "  if (x > 3) return x * 2;", "  return x;", "}"]);
      const test = rank("test/pricing.test.ts", [], ["export function f(x) {", "  if (x > 3) return x * 2;", "  return x;", "}"]);
      assert.ok(test.risk.score < src.risk.score);
    });

    it("evidence indices point at the lines that triggered a signal", () => {
      const h = rank("src/a.ts", ["  if (a > b) {"], ["  if (a >= b) {"], ["function f(a, b) {"]);
      const s = h.risk.signals.find((x) => x.id === "behaviour.comparison")!;
      assert.deepEqual(s.at, [2]);
      assert.equal(h.hunk.lines[2]!.text, "  if (a >= b) {");
    });
  });
});
