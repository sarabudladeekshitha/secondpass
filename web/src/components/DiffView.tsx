import type { RankedHunk } from "../types.ts";

interface Props {
  hunk: RankedHunk;
  /** Line indices to emphasise (evidence for the selected reason, or all). */
  highlight: Set<number>;
}

export function DiffView({ hunk, highlight }: Props) {
  const uncovered = new Set(hunk.risk.coverage.uncoveredLines);
  const { hunk: h } = hunk;
  return (
    <div className="diff" role="table" aria-label={`Diff for ${h.path}`}>
      <div className="diff-head" role="row">
        <span role="cell">
          @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@ {h.section}
        </span>
      </div>
      {h.lines.map((l, i) => {
        const notRun = l.kind === "add" && l.newLine !== undefined && uncovered.has(l.newLine);
        const cls = ["dl", `dl-${l.kind}`, highlight.has(i) ? "is-hit" : "", notRun ? "not-run" : ""].filter(Boolean).join(" ");
        return (
          <div className={cls} role="row" key={i}>
            <span className="ln" role="cell">{l.oldLine ?? ""}</span>
            <span className="ln" role="cell">{l.newLine ?? ""}</span>
            <span className="cov" role="cell" title={notRun ? "Never run by tests" : undefined}>
              {notRun ? "●" : ""}
            </span>
            <span className="code" role="cell">
              <span className="sign" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              {l.text || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}
