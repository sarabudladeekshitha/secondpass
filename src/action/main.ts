import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../analyze.ts";
import { renderHtml } from "../report/html.ts";
import { COMMENT_MARKER, renderMarkdown } from "../report/markdown.ts";
import { mergeCoverage, parseCoverage } from "../risk/coverage.ts";
import { anthropicSummarizer, DEFAULT_MODEL } from "../summarize/anthropic.ts";
import { attachSummaries } from "../summarize/summarize.ts";
import type { Tier } from "../types.ts";
import { createGitHub, GitHubError } from "./github.ts";

/* Tiny stand-ins for @actions/core, so the Action has no dependencies. */
export function getInput(name: string, env = process.env): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
const log = (m: string) => process.stdout.write(m + "\n");
const warn = (m: string) => process.stdout.write(`::warning::${m.replace(/\r?\n/g, "%0A")}\n`);
const fail = (m: string) => {
  process.stdout.write(`::error::${m.replace(/\r?\n/g, "%0A")}\n`);
  process.exitCode = 1;
};
function setOutput(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}<<__SP_EOF__\n${value}\n__SP_EOF__\n`);
}

interface PullRequestEvent {
  pull_request?: {
    number: number;
    html_url: string;
    title: string;
    base: { sha: string };
    head: { sha: string };
  };
}

const RANK: Record<Tier, number> = { critical: 3, high: 2, medium: 1, low: 0, trivial: -1 };

export async function run(): Promise<void> {
  const token = getInput("github-token") || process.env.GITHUB_TOKEN || "";
  const apiKey = getInput("anthropic-api-key");
  const model = getInput("model") || DEFAULT_MODEL;
  const coverageInputs = getInput("coverage-file").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const ignore = getInput("ignore").split(/\n/).map((s) => s.trim()).filter(Boolean).map((r) => new RegExp(r));
  const shouldComment = getInput("comment") !== "false";
  const maxRows = Number(getInput("max-rows") || 25);
  const failOn = getInput("fail-on") as Tier | "";
  if (apiKey) log(`::add-mask::${apiKey}`);

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY;
  const event = eventPath && existsSync(eventPath) ? (JSON.parse(readFileSync(eventPath, "utf8")) as PullRequestEvent) : {};
  const pr = event.pull_request;
  if (!pr || !repo) {
    warn("SecondPass runs on pull_request events; nothing to do here.");
    return;
  }
  if (!token) return fail("github-token is required");

  const gh = createGitHub({ token, apiUrl: process.env.GITHUB_API_URL });
  log(`Fetching diff for ${repo}#${pr.number}…`);
  const diff = await gh.pullDiff(repo, pr.number);

  const coverageFiles = coverageInputs.filter((f) => {
    if (existsSync(f)) return true;
    warn(`Coverage file not found: ${f} (ranking continues without it)`);
    return false;
  });
  const coverage = coverageFiles.length ? mergeCoverage(coverageFiles.map((f) => parseCoverage(readFileSync(f, "utf8")))) : undefined;

  let report = analyze(diff, {
    coverage,
    ignore,
    source: { repo, pr: pr.number, title: pr.title, url: pr.html_url, baseSha: pr.base.sha, headSha: pr.head.sha },
  });
  report = await attachSummaries(report, apiKey ? anthropicSummarizer({ apiKey, model }) : undefined, {
    onError: (e) => warn(`Descriptions unavailable, using diff-based ones: ${e instanceof Error ? e.message : String(e)}`),
  });
  const usedModel = report.hunks.some((h) => h.summarySource === "model") ? model : undefined;

  const outDir = join(process.env.RUNNER_TEMP ?? ".", "secondpass");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "secondpass-report.json");
  const htmlPath = join(outDir, "secondpass-report.html");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(htmlPath, renderHtml(report));

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
  const md = renderMarkdown(report, { prUrl: pr.html_url, limit: maxRows, model: usedModel, reportUrl: runUrl });

  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  if (shouldComment) {
    try {
      const how = await gh.upsertComment(repo, pr.number, COMMENT_MARKER, md);
      log(`PR comment ${how}.`);
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) {
        warn("Could not comment on the PR (fork PRs get a read-only token). The ranking is in the job summary.");
      } else throw err;
    }
  }

  const t = report.totals.byTier;
  const top = (["critical", "high", "medium", "low"] as const).find((k) => t[k] > 0) ?? "trivial";
  setOutput("report-json", jsonPath);
  setOutput("report-html", htmlPath);
  setOutput("critical", String(t.critical));
  setOutput("high", String(t.high));
  setOutput("top-tier", top);
  log(`Ranked ${report.totals.hunks} hunks: ${t.critical} critical, ${t.high} high, ${t.medium} medium, ${t.low} low, ${t.trivial} collapsed.`);

  if (failOn) {
    if (!["critical", "high", "medium"].includes(failOn)) return fail(`fail-on must be critical, high or medium (got "${failOn}")`);
    if (RANK[top] >= RANK[failOn]) fail(`SecondPass found ${top} risk hunks (fail-on: ${failOn}). This is a flag for a careful review, not a verdict on the code.`);
  }
}

run().catch((err: unknown) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
