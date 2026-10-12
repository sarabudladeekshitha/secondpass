import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anthropicSummarizer, parseSummaryJson } from "../src/summarize/anthropic.ts";
import { sanitizeSummary } from "../src/summarize/summarize.ts";

describe("sanitizeSummary", () => {
  it("keeps plain descriptions", () => {
    assert.equal(sanitizeSummary("Stops awaiting ledger.post."), "Stops awaiting ledger.post");
  });

  it("rejects verdicts, reassurance and advice", () => {
    for (const s of [
      "Safely renames a variable",
      "Minor refactor of the refund flow",
      "Looks good: adds a test",
      "This should be reviewed carefully",
      "Potential bug in rounding",
      "Just reorders imports",
      "No functional change",
      "Cosmetic cleanup",
    ]) {
      assert.equal(sanitizeSummary(s), undefined, s);
    }
  });

  it("flattens to one line, strips bullets and quotes, and caps length", () => {
    assert.equal(sanitizeSummary('- "Adds a refunds table\nwith an index"'), "Adds a refunds table with an index");
    const long = sanitizeSummary("Adds " + "a very long description ".repeat(10));
    assert.ok(long && long.length <= 140 && long.endsWith("…"));
    assert.equal(sanitizeSummary(42), undefined);
  });
});

describe("Anthropic summarizer", () => {
  it("parses JSON replies, with or without fences", () => {
    assert.deepEqual(parseSummaryJson('```json\n{"h1": "Adds x"}\n```'), { h1: "Adds x" });
    assert.deepEqual(parseSummaryJson('Here you go: {"h1": "Adds x"}'), { h1: "Adds x" });
    assert.deepEqual(parseSummaryJson("no json"), {});
    assert.deepEqual(parseSummaryJson("[1,2]"), {});
  });

  it("batches hunks, sends the API headers and maps keys back to hunk ids", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: { model: string; messages: Array<{ content: string }>; system: string } }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, headers: init.headers as Record<string, string>, body });
      const keys = [...String(body.messages[0].content).matchAll(/key="(h\d+)"/g)].map((m) => m[1]);
      const text = JSON.stringify(Object.fromEntries(keys.map((k) => [k, `Describes ${k}`])));
      return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const s = anthropicSummarizer({ apiKey: "sk-test", model: "claude-test", fetch: fakeFetch, batchSize: 2 });
    const items = ["a", "b", "c"].map((x) => ({ id: `${x}.ts:1`, path: `${x}.ts`, section: "", diff: `@@ -1 +1 @@\n-${x}\n+${x}${x}` }));
    const out = await s.summarize(items);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0]!.headers["x-api-key"], "sk-test");
    assert.equal(calls[0]!.headers["anthropic-version"], "2023-06-01");
    assert.equal(calls[0]!.body.model, "claude-test");
    assert.match(calls[0]!.body.system, /not a reviewer/);
    assert.deepEqual([...out], [
      ["a.ts:1", "Describes h1"],
      ["b.ts:1", "Describes h2"],
      ["c.ts:1", "Describes h1"],
    ]);
  });

  it("drops a failed batch without losing the others", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"h1":"Adds c"}' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = anthropicSummarizer({ apiKey: "k", fetch: flaky, batchSize: 2, concurrency: 1 });
    const items = ["a", "b", "c"].map((x) => ({ id: x, path: x, section: "", diff: "+x" }));
    const prev = process.emitWarning;
    process.emitWarning = () => {};
    try {
      const out = await s.summarize(items);
      assert.deepEqual([...out], [["c", "Adds c"]]);
    } finally {
      process.emitWarning = prev;
    }
  });
});
