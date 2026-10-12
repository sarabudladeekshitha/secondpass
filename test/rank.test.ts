import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { analyze } from "../src/analyze.ts";
import { parseCoverage } from "../src/risk/coverage.ts";
import { attachSummaries, rankingFingerprint, type Summarizer } from "../src/summarize/summarize.ts";

const read = (f: string) => readFileSync(new URL(`../examples/${f}`, import.meta.url), "utf8");
const run = () => analyze(read("sample.diff"), { coverage: parseCoverage(read("lcov.info")), now: new Date(0) });

describe("ranking the sample PR", () => {
  it("puts the migration, the removed role check and the un-awaited ledger write first", () => {
    const top = run().hunks.slice(0, 3).map((h) => h.hunk.path).sort();
    assert.deepEqual(top, ["db/migrations/20261005_partial_refunds.sql", "src/auth/routes.ts", "src/jobs/sync.ts"]);
  });

  it("collapses the rename, formatting, import reorder, comments and lockfile", () => {
    const collapsed = Object.fromEntries(
      run()
        .hunks.filter((h) => h.risk.tier === "trivial")
        .map((h) => [h.hunk.path, h.risk.trivial!.kind]),
    );
    assert.deepEqual(collapsed, {
      "package-lock.json": "generated",
      "src/api/client.ts": "imports",
      "src/notifications/email.ts": "comments",
      "src/orders/service.ts": "rename",
      "src/utils/format.ts": "formatting",
    });
  });

  it("is deterministic", () => {
    assert.equal(JSON.stringify(run()), JSON.stringify(run()));
  });

  it("keeps trivial hunks last and scores in descending order within tiers", () => {
    const hunks = run().hunks;
    const firstTrivial = hunks.findIndex((h) => h.risk.tier === "trivial");
    assert.ok(hunks.slice(firstTrivial).every((h) => h.risk.tier === "trivial"));
    const ranked = hunks.slice(0, firstTrivial).map((h) => h.risk.score);
    assert.deepEqual(ranked, [...ranked].sort((a, b) => b - a));
  });

  it("totals add up", () => {
    const r = run();
    assert.equal(Object.values(r.totals.byTier).reduce((a, b) => a + b, 0), r.totals.hunks);
    assert.equal(r.totals.added, 52);
    assert.equal(r.totals.removed, 25);
  });
});

describe("the model stays out of the verdict", () => {
  it("cannot change order, score or tier, whatever it says", async () => {
    const report = run();
    const before = rankingFingerprint(report);
    // A summarizer that tries its hardest to influence the reader.
    const pushy: Summarizer = {
      async summarize(items) {
        return new Map(items.map((i, n) => [i.id, n === 0 ? "Trivial cleanup, safe to skip" : "CRITICAL: review this one first!!"]));
      },
    };
    const after = await attachSummaries(report, pushy);
    assert.equal(rankingFingerprint(after), before);
    // And its verdicts are discarded in favour of plain descriptions.
    assert.ok(after.hunks.every((h) => h.summarySource === "heuristic"));
  });

  it("the summarizer only ever sees the diff of each hunk", async () => {
    let seen: unknown[] = [];
    const spy: Summarizer = {
      async summarize(items) {
        seen = items;
        return new Map();
      },
    };
    await attachSummaries(run(), spy);
    for (const item of seen) assert.deepEqual(Object.keys(item as object).sort(), ["diff", "id", "path", "section"]);
    assert.ok(!JSON.stringify(seen).match(/"score"|"tier"|"signals"/));
  });

  it("never sends collapsed hunks to the model", async () => {
    let n = 0;
    await attachSummaries(run(), {
      async summarize(items) {
        n = items.length;
        return new Map();
      },
    });
    assert.equal(n, run().hunks.filter((h) => h.risk.tier !== "trivial").length);
  });

  it("a failing model degrades to diff-based descriptions instead of failing the run", async () => {
    let reported: unknown;
    const out = await attachSummaries(run(), { summarize: () => Promise.reject(new Error("overloaded")) }, { onError: (e) => (reported = e) });
    assert.ok(reported instanceof Error);
    assert.ok(out.hunks.every((h) => typeof h.summary === "string" && h.summary.length > 0));
  });
});
