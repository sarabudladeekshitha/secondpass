/**
 * Build everything with esbuild (no Vite/Webpack):
 *   1. examples/sample-report.json  — deterministic demo report
 *   2. web/dist/viewer.{js,css}     — React review UI
 *   3. web/dist/index.html          — standalone viewer page
 *   4. dist/cli.js, dist/action.js  — Node bundles with the viewer inlined
 *   5. examples/sample-report.html  — self-contained demo report
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/analyze.ts";
import { renderHtml } from "../src/report/html.ts";
import { parseCoverage } from "../src/risk/coverage.ts";
import { attachSummaries, type Summarizer } from "../src/summarize/summarize.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts: string[]) => join(root, ...parts);

// 1. Sample report. Its descriptions are hand-written to show the format a
//    model produces; they go through the same sanitiser as real ones.
const exampleSummaries = JSON.parse(readFileSync(p("examples/sample-summaries.json"), "utf8")) as Record<string, string>;
const fixture: Summarizer = {
  async summarize(items) {
    return new Map(items.flatMap((i) => (exampleSummaries[i.id] ? [[i.id, exampleSummaries[i.id]!] as [string, string]] : [])));
  },
};
let sample = analyze(readFileSync(p("examples/sample.diff"), "utf8"), {
  coverage: parseCoverage(readFileSync(p("examples/lcov.info"), "utf8")),
  source: { repo: "acme/shop", pr: 482, title: "Add partial refunds", url: "https://github.com/acme/shop/pull/482" },
  now: new Date("2026-10-12T12:00:00Z"),
});
sample = await attachSummaries(sample, fixture);
writeFileSync(p("examples/sample-report.json"), JSON.stringify(sample, null, 2) + "\n");

// 2. Viewer.
mkdirSync(p("web/dist"), { recursive: true });
await build({
  entryPoints: [p("web/src/main.tsx")],
  outfile: p("web/dist/viewer.js"),
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});
await build({
  entryPoints: [p("web/src/styles.css")],
  outfile: p("web/dist/viewer.css"),
  bundle: true,
  minify: true,
  logLevel: "warning",
});
const viewerJs = readFileSync(p("web/dist/viewer.js"), "utf8");
const viewerCss = readFileSync(p("web/dist/viewer.css"), "utf8");

// 3. Standalone viewer page (open a report.json, or ?report=<url>).
writeFileSync(
  p("web/dist/index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SecondPass</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="viewer.css">
</head>
<body>
<div id="root"></div>
<script src="viewer.js"></script>
</body>
</html>
`,
);

// 4. Node bundles. Zero runtime dependencies: everything is inlined.
const nodeCommon = {
  bundle: true,
  platform: "node" as const,
  target: ["node22"],
  format: "esm" as const,
  legalComments: "none" as const,
  logLevel: "warning" as const,
  define: { __VIEWER_JS__: JSON.stringify(viewerJs), __VIEWER_CSS__: JSON.stringify(viewerCss) },
};
await build({ ...nodeCommon, entryPoints: [p("src/cli.ts")], outfile: p("dist/cli.js") });
await build({ ...nodeCommon, entryPoints: [p("src/action/main.ts")], outfile: p("dist/action.js") });

// 5. Demo HTML report.
writeFileSync(p("examples/sample-report.html"), renderHtml(sample));

const kb = (f: string) => `${(readFileSync(p(f)).length / 1024).toFixed(0)} kB`;
console.log(
  `built: dist/cli.js ${kb("dist/cli.js")} · dist/action.js ${kb("dist/action.js")} · web/dist/viewer.js ${kb("web/dist/viewer.js")} · examples/sample-report.html`,
);
