import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { hunkToText, parseDiff } from "../src/diff/parse.ts";

const sample = readFileSync(new URL("../examples/sample.diff", import.meta.url), "utf8");

describe("parseDiff", () => {
  it("parses every file in a real git diff", () => {
    const files = parseDiff(sample);
    assert.equal(files.length, 12);
    const migration = files.find((f) => f.newPath.endsWith("partial_refunds.sql"))!;
    assert.equal(migration.status, "added");
    assert.equal(migration.oldPath, migration.newPath);
    assert.equal(migration.hunks[0]!.lines.filter((l) => l.kind === "add").length, 9);
  });

  it("tracks old and new line numbers through context, adds and deletes", () => {
    const [f] = parseDiff(
      ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -10,4 +10,4 @@ function f() {", " a", "-b", "+B", " c", " d", ""].join("\n"),
    );
    const h = f!.hunks[0]!;
    assert.equal(h.section, "function f() {");
    assert.deepEqual(
      h.lines.map((l) => [l.kind, l.oldLine, l.newLine]),
      [
        ["ctx", 10, 10],
        ["del", 11, undefined],
        ["add", undefined, 11],
        ["ctx", 12, 12],
        ["ctx", 13, 13],
      ],
    );
    assert.equal(h.id, "x.ts:10");
  });

  it("handles deleted files, renames, binaries and missing trailing newlines", () => {
    const files = parseDiff(
      [
        "diff --git a/old.ts b/old.ts",
        "deleted file mode 100644",
        "--- a/old.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
        "\\ No newline at end of file",
        "diff --git a/a.ts b/b.ts",
        "similarity index 100%",
        "rename from a.ts",
        "rename to b.ts",
        "diff --git a/logo.png b/logo.png",
        "Binary files a/logo.png and b/logo.png differ",
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      files.map((f) => [f.status, f.oldPath, f.newPath, f.binary]),
      [
        ["deleted", "old.ts", "old.ts", false],
        ["renamed", "a.ts", "b.ts", false],
        ["modified", "logo.png", "logo.png", true],
      ],
    );
    assert.equal(files[0]!.hunks[0]!.id, "old.ts:-1");
    assert.equal(files[1]!.similarity, 100);
  });

  it("does not mistake a removed line starting with '--' for a file header", () => {
    const [f] = parseDiff(["diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,1 @@", "--- a comment", " SELECT 1;", ""].join("\n"));
    assert.equal(f!.hunks.length, 1);
    assert.deepEqual(f!.hunks[0]!.lines.map((l) => l.kind), ["del", "ctx"]);
    assert.equal(f!.hunks[0]!.lines[0]!.text, "-- a comment");
  });

  it("parses plain unified diffs without git headers", () => {
    const files = parseDiff(["--- a/one.txt", "+++ b/one.txt", "@@ -1 +1 @@", "-x", "+y", "--- a/two.txt", "+++ b/two.txt", "@@ -1 +1 @@", "-p", "+q", ""].join("\n"));
    assert.deepEqual(files.map((f) => f.newPath), ["one.txt", "two.txt"]);
  });

  it("supports paths with spaces and quoted paths", () => {
    const files = parseDiff(
      ['diff --git a/my dir/a b.ts b/my dir/a b.ts', "--- a/my dir/a b.ts", "+++ b/my dir/a b.ts", "@@ -1 +1 @@", "-x", "+y", ""].join("\n"),
    );
    assert.equal(files[0]!.newPath, "my dir/a b.ts");
    const quoted = parseDiff(['diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"', '--- "a/caf\\303\\251.ts"', '+++ "b/caf\\303\\251.ts"', "@@ -1 +1 @@", "-x", "+y", ""].join("\n"));
    assert.equal(quoted[0]!.newPath, "café.ts");
  });

  it("renders a hunk back to diff text", () => {
    const [f] = parseDiff(["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@ fn()", " a", "-b", "+c", ""].join("\n"));
    assert.equal(hunkToText(f!.hunks[0]!), "@@ -1,2 +1,2 @@ fn()\n a\n-b\n+c");
  });
});
