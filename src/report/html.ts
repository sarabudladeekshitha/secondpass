import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "../types.ts";

// Replaced with the built viewer at bundle time (see scripts/build.ts).
declare const __VIEWER_JS__: string | undefined;
declare const __VIEWER_CSS__: string | undefined;

function viewerAssets(): { js: string; css: string } {
  if (typeof __VIEWER_JS__ === "string" && typeof __VIEWER_CSS__ === "string") {
    return { js: __VIEWER_JS__, css: __VIEWER_CSS__ };
  }
  // Running from source: use the last `npm run build` output.
  const dist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const js = join(dist, "viewer.js");
  const css = join(dist, "viewer.css");
  if (!existsSync(js)) throw new Error("Viewer not built. Run `npm run build` first.");
  return { js: readFileSync(js, "utf8"), css: existsSync(css) ? readFileSync(css, "utf8") : "" };
}

/** Escape so a JSON payload can live inside a <script> tag. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}

/** A single self-contained HTML file: viewer + report, no network needed. */
export function renderHtml(report: Report): string {
  const { js, css } = viewerAssets();
  const title = report.source?.title ? `SecondPass · ${report.source.title}` : "SecondPass report";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>window.__SECONDPASS_REPORT__ = ${scriptSafeJson(report)};</script>
<script>${js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
}
