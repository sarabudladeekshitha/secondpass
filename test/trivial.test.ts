import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/analyze.ts";
import { diffOf, rank } from "./helpers.ts";

describe("collapsing trivial hunks", () => {
  it("collapses quote, semicolon and whitespace changes", () => {
    const h = rank("src/a.ts", ["const x = 'a'", "foo( x,y )"], ['const x = "a";', "foo(x, y);"]);
    assert.equal(h.risk.trivial?.kind, "formatting");
  });

  it("collapses a formatter re-wrapping one call over several lines", () => {
    const h = rank("src/a.ts", ["call(a, b, c);"], ["call(", "  a,", "  b,", "  c,", ");"]);
    assert.equal(h.risk.trivial?.kind, "formatting");
  });

  it("does NOT collapse re-indentation in Python, where indentation is meaning", () => {
    const h = rank("app/views.py", ["    return charge(order)"], ["return charge(order)"]);
    assert.equal(h.risk.trivial, undefined);
  });

  it("collapses comment-only changes", () => {
    const h = rank("src/a.ts", ["// old note"], ["// new note", "/* more */"]);
    assert.equal(h.risk.trivial?.kind, "comments");
  });

  it("collapses reordered imports, including reordered named specifiers", () => {
    const h = rank(
      "src/a.ts",
      ['import { b, a } from "./x";', 'import z from "z";'],
      ['import z from "z";', "import {", "  a,", "  b,", '} from "./x";'],
    );
    assert.equal(h.risk.trivial?.kind, "imports");
  });

  it("does NOT collapse imports that swap which module a name comes from", () => {
    const h = rank("src/a.ts", ['import { a } from "./x";', 'import { b } from "./y";'], ['import { b } from "./x";', 'import { a } from "./y";']);
    assert.equal(h.risk.trivial, undefined);
  });

  it("collapses a rename when the old name is declared in the hunk", () => {
    const h = rank("src/a.ts", ["let amt = 0;", "amt += x;", "return amt;"], ["let totalCents = 0;", "totalCents += x;", "return totalCents;"]);
    assert.equal(h.risk.trivial?.kind, "rename");
    assert.match(h.risk.trivial!.reason, /amt.*totalCents/);
  });

  it("does NOT collapse swapping one variable for another (b → c) with no declaration", () => {
    const h = rank("src/a.ts", ["if (a < b) return b;"], ["if (a < c) return c;"]);
    assert.equal(h.risk.trivial, undefined);
  });

  it("collapses an undeclared rename when the same rename appears across hunks", () => {
    const one = diffOf("src/a.ts", ["use(oldName);"], ["use(newName);"]);
    const two = diffOf("src/b.ts", ["return oldName + 1;"], ["return newName + 1;"]);
    const report = analyze(one + two);
    assert.deepEqual(report.hunks.map((h) => h.risk.trivial?.kind), ["rename", "rename"]);
  });

  it("does NOT collapse an inconsistent substitution", () => {
    const h = rank("src/a.ts", ["let a = 1;", "f(a, b);"], ["let x = 1;", "f(a, b);".replace("a", "y")]);
    assert.equal(h.risk.trivial, undefined);
  });

  it("does NOT treat keyword changes as renames", () => {
    const h = rank("src/a.ts", ["const flag = true;"], ["const flag = false;"]);
    assert.equal(h.risk.trivial, undefined);
  });

  it("collapses lockfiles and generated files", () => {
    assert.equal(rank("package-lock.json", ['"version": "1.0.0"'], ['"version": "1.0.1"']).risk.trivial?.kind, "generated");
    assert.equal(rank("api/__generated__/types.ts", ["a"], ["b"]).risk.trivial?.kind, "generated");
  });
});
