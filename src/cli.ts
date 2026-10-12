#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { analyze } from "./analyze.ts";
import { renderHtml } from "./report/html.ts";
import { renderMarkdown, renderText } from "./report/markdown.ts";
import { mergeCoverage, parseCoverage } from "./risk/coverage.ts";
import { anthropicSummarizer, DEFAULT_MODEL } from "./summarize/anthropic.ts";
import { attachSummaries } from "./summarize/summarize.ts";
import type { Tier } from "./types.ts";

const HELP = `secondpass ${pkg.version}
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

const RANK: Record<Tier, number> = { critical: 3, high: 2, medium: 1, low: 0, trivial: -1 };

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main(argv: string[]): Promise<number> {
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
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  let diff: string;
  if (values.base) {
    diff = execFileSync("git", ["diff", "--no-color", "--no-ext-diff", "-M", `${values.base}...HEAD`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } else if (values.diff && values.diff !== "-") {
    diff = readFileSync(values.diff, "utf8");
  } else if (!process.stdin.isTTY) {
    diff = readStdin();
  } else {
    process.stderr.write(HELP);
    return 1;
  }

  const coverage = values.coverage?.length
    ? mergeCoverage(values.coverage.map((f) => parseCoverage(readFileSync(f, "utf8"))))
    : undefined;
  const ignore = (values.ignore ?? []).map((r) => new RegExp(r));

  let report = analyze(diff, { coverage, ignore });

  const model = values.model ?? DEFAULT_MODEL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (values.summaries && !apiKey) {
    process.stderr.write("secondpass: --summaries needs ANTHROPIC_API_KEY; using diff-based descriptions.\n");
  }
  report = await attachSummaries(report, values.summaries && apiKey ? anthropicSummarizer({ apiKey, model }) : undefined, {
    onError: (e) => process.stderr.write(`secondpass: descriptions unavailable (${e instanceof Error ? e.message : String(e)})\n`),
  });

  const usedModel = report.hunks.some((h) => h.summarySource === "model") ? model : undefined;
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
      process.stderr.write(`secondpass: unknown --format ${values.format}\n`);
      return 1;
  }

  const failOn = values["fail-on"] as Tier | undefined;
  if (failOn) {
    if (!(failOn in RANK) || failOn === "trivial" || failOn === "low") {
      process.stderr.write(`secondpass: --fail-on must be critical, high or medium\n`);
      return 1;
    }
    if (report.hunks.some((h) => RANK[h.risk.tier] >= RANK[failOn])) return 2;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`secondpass: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
