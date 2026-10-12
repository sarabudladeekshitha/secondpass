import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { filePatchToDiff } from "../src/action/github.ts";
import { analyze } from "../src/analyze.ts";
import { parseDiff } from "../src/diff/parse.ts";
import { scriptSafeJson } from "../src/report/html.ts";
import { COMMENT_MARKER, githubAnchor, renderMarkdown, renderText } from "../src/report/markdown.ts";
import { parseCoverage } from "../src/risk/coverage.ts";

const read = (f: string) => readFileSync(new URL(`../examples/${f}`, import.meta.url), "utf8");
const report = analyze(read("sample.diff"), { coverage: parseCoverage(read("lcov.info")) });

describe("PR comment", () => {
  const md = renderMarkdown(report, { prUrl: "https://github.com/acme/shop/pull/482", model: "claude-haiku-5-5" });

  it("carries the sticky marker and a summary line", () => {
    assert.ok(md.startsWith(COMMENT_MARKER));
    assert.match(md, /3 critical/);
    assert.match(md, /5 collapsed/);
  });

  it("lists ranked hunks in a table and collapsed ones in <details>", () => {
    const table = md.split("\n").filter((l) => l.startsWith("| 🔴") || l.startsWith("| 🟠") || l.startsWith("| ⚪"));
    assert.equal(table.length, 7);
    assert.match(table[0]!, /partial_refunds\.sql/);
    assert.match(md, /<details><summary>5 collapsed hunks/);
    assert.match(md, /Rename only: `amt` → `totalCents`/);
  });

  it("links to the exact line in the PR's Files tab", () => {
    const sha = createHash("sha256").update("src/auth/routes.ts").digest("hex");
    assert.ok(md.includes(`https://github.com/acme/shop/pull/482/files#diff-${sha}R8`));
    assert.equal(githubAnchor("https://x/pull/1/", "a", "L", 3), `https://x/pull/1/files#diff-${createHash("sha256").update("a").digest("hex")}L3`);
  });

  it("says where the order comes from", () => {
    assert.match(md, /Order comes from the diff and test coverage only/);
    assert.match(md, /claude-haiku-5-5/);
  });

  it("escapes pipes in table cells and respects the row limit", () => {
    const short = renderMarkdown(report, { limit: 2 });
    assert.match(short, /…and 5 more lower-ranked hunks/);
    assert.ok(!/[^\\]\|\|/.test(short.split("\n").filter((l) => l.startsWith("| ")).join("\n")));
  });

  it("notes when coverage wasn't provided", () => {
    assert.match(renderMarkdown(analyze(read("sample.diff"))), /Coverage not provided/);
  });
});

describe("terminal output", () => {
  it("renders without colour codes when asked", () => {
    const text = renderText(report, false);
    assert.ok(!text.includes("\x1b["));
    assert.match(text.split("\n")[2]!, /^CRITICAL\s+77\s+db\/migrations/);
  });
});

describe("HTML embedding", () => {
  it("makes JSON safe inside a script tag", () => {
    const s = scriptSafeJson({ a: "</script><script>alert(1)</script>", b: " " });
    assert.ok(!s.includes("</script"));
    assert.ok(!s.includes(" "));
    assert.deepEqual(JSON.parse(s), { a: "</script><script>alert(1)</script>", b: " " });
  });
});

describe("files-API fallback for huge PRs", () => {
  it("rebuilds a parseable diff from per-file patches", () => {
    const diff = [
      filePatchToDiff({ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" }),
      filePatchToDiff({ filename: "new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+hello" }),
      filePatchToDiff({ filename: "b.ts", previous_filename: "old-b.ts", status: "renamed" }),
      filePatchToDiff({ filename: "img.png", status: "modified" }),
    ].join("");
    const files = parseDiff(diff);
    assert.deepEqual(
      files.map((f) => [f.status, f.newPath, f.hunks.length, f.binary]),
      [
        ["modified", "a.ts", 1, false],
        ["added", "new.ts", 1, false],
        ["renamed", "b.ts", 0, false],
        ["modified", "img.png", 0, true],
      ],
    );
  });
});
