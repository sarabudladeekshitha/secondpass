import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/analyze.ts";
import { lookup, parseCobertura, parseCoverage, parseLcov } from "../src/risk/coverage.ts";
import { combine } from "../src/risk/score.ts";
import { diffOf } from "./helpers.ts";

const change = diffOf("src/billing/limits.ts", ["  if (attempts > 3) {"], ["  if (attempts >= 3) {"], { context: ["export function f(attempts) {"] });

describe("coverage", () => {
  it("parses lcov and matches absolute CI paths to repo paths", () => {
    const map = parseLcov("SF:/home/runner/work/app/app/src/x.ts\nDA:1,0\nDA:2,4\nend_of_record\n");
    const lines = lookup(map, "src/x.ts");
    assert.deepEqual([...lines!], [[1, 0], [2, 4]]);
    assert.equal(lookup(map, "x.ts")?.size, 2);
    assert.equal(lookup(map, "other/x.ts"), undefined);
  });

  it("parses Cobertura XML from coverage.py", () => {
    const xml = `<?xml version="1.0" ?><coverage><sources><source>/repo</source></sources><packages><package><classes>
      <class name="views.py" filename="app/views.py"><lines><line number="3" hits="0"/><line number="4" hits="2"/></lines></class>
    </classes></package></packages></coverage>`;
    const map = parseCobertura(xml);
    assert.deepEqual([...lookup(map, "app/views.py")!], [[3, 0], [4, 2]]);
    assert.equal(parseCoverage(xml).size, 1);
  });

  it("ranks the same change higher when tests never run it", () => {
    const covered = analyze(change, { coverage: parseLcov("SF:src/billing/limits.ts\nDA:2,5\nend_of_record\n") }).hunks[0]!;
    const uncovered = analyze(change, { coverage: parseLcov("SF:src/billing/limits.ts\nDA:2,0\nend_of_record\n") }).hunks[0]!;
    const none = analyze(change).hunks[0]!;
    assert.ok(uncovered.risk.score > none.risk.score, "uncovered > no data");
    assert.ok(none.risk.score > covered.risk.score, "no data > covered");
    assert.equal(uncovered.risk.coverage.status, "measured");
    assert.deepEqual(uncovered.risk.coverage.uncoveredLines, [2]);
    assert.ok(uncovered.risk.signals.some((s) => s.id === "coverage.uncovered"));
  });

  it("raises risk when coverage was provided but the file never loaded", () => {
    const r = analyze(change, { coverage: parseLcov("SF:src/other.ts\nDA:1,1\nend_of_record\n") }).hunks[0]!;
    assert.equal(r.risk.coverage.status, "file-missing");
    assert.ok(r.risk.score > analyze(change).hunks[0]!.risk.score);
  });

  it("doesn't penalise files that coverage tools never instrument", () => {
    const r = analyze(diffOf("db/migrations/1.sql", [], ["CREATE INDEX i ON t (c);"]), { coverage: new Map() }).hunks[0]!;
    assert.equal(r.risk.coverage.status, "not-executable");
  });
});

describe("scoring", () => {
  it("has diminishing returns so many weak signals can't beat one strong one", () => {
    const strong = combine([{ id: "a", category: "data", weight: 55, reason: "" }]);
    const weak = combine(Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, category: "size" as const, weight: 12, reason: "" })));
    assert.ok(strong > weak);
  });
});
