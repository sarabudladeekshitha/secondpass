import { useState } from "react";
import type { RankedHunk, Signal } from "../types.ts";
import { DiffView } from "./DiffView.tsx";

interface Props {
  hunk: RankedHunk;
  reviewed: boolean;
  expanded: boolean;
  focused: boolean;
  onToggleReviewed: () => void;
  onToggleExpanded: () => void;
  onFocus: () => void;
}

export function lineLabel(h: RankedHunk): string {
  const added = h.hunk.lines.filter((l) => l.kind === "add" && l.newLine !== undefined).map((l) => l.newLine!);
  if (added.length === 0) {
    const end = h.hunk.oldStart + Math.max(0, h.hunk.oldLines - 1);
    return end === h.hunk.oldStart ? `L${h.hunk.oldStart} (removed)` : `L${h.hunk.oldStart}–${end} (removed)`;
  }
  const start = added[0]!;
  const end = added[added.length - 1]!;
  return start === end ? `L${start}` : `L${start}–${end}`;
}

/** Render `code` spans in reason text. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return <>{parts.map((p, i) => (p.length > 2 && p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p))}</>;
}

function visibleSignals(signals: Signal[]): Signal[] {
  return signals.filter((s) => s.category !== "size" || signals.length === 1);
}

export function HunkRow({ hunk, reviewed, expanded, focused, onToggleReviewed, onToggleExpanded, onFocus }: Props) {
  const [selected, setSelected] = useState<string | undefined>();
  const signals = visibleSignals(hunk.risk.signals);
  const active = signals.find((s) => s.id === selected);
  const highlight = new Set<number>(active ? active.at ?? [] : signals.flatMap((s) => s.at ?? []));
  const diffId = `diff-${hunk.hunk.id.replace(/[^\w-]/g, "_")}`;

  const pick = (s: Signal) => {
    setSelected((cur) => (cur === s.id ? undefined : s.id));
    if (!expanded && s.at?.length) onToggleExpanded();
  };

  return (
    <article
      id={`h-${hunk.hunk.id}`}
      className={`hunk tier-${hunk.risk.tier}${reviewed ? " is-reviewed" : ""}${focused ? " is-focused" : ""}`}
      aria-label={`${hunk.hunk.path} ${lineLabel(hunk)}, ${hunk.risk.tier} risk`}
      onFocus={onFocus}
      onClick={onFocus}
    >
      <div className="hunk-score" aria-hidden="true">
        <span className="score">{hunk.risk.score}</span>
        <span className="tier">{hunk.risk.tier}</span>
      </div>

      <div className="hunk-body">
        <h3 className="hunk-path">
          <span className="path">{hunk.hunk.path}</span> <span className="lines">{lineLabel(hunk)}</span>
          {hunk.file.status !== "modified" && <span className="status">{hunk.file.status}</span>}
        </h3>
        {hunk.summary && (
          <p className="summary" title={hunk.summarySource === "model" ? "Written by Claude from the diff; not used for ranking" : "Derived from the diff"}>
            {hunk.summary}
          </p>
        )}

        <ul className="reasons" aria-label="Why it's ranked here">
          {signals.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`reason cat-${s.category}${selected === s.id ? " is-active" : ""}${s.weight < 0 ? " is-relief" : ""}`}
                aria-pressed={selected === s.id}
                disabled={!s.at?.length}
                onClick={(e) => {
                  e.stopPropagation();
                  pick(s);
                }}
              >
                <span className="weight">{s.weight > 0 ? `+${s.weight}` : s.weight}</span>
                <span>
                  <Inline text={s.reason} />
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="hunk-actions">
          <button type="button" className="btn" aria-expanded={expanded} aria-controls={diffId} onClick={(e) => (e.stopPropagation(), onToggleExpanded())}>
            {expanded ? "Hide diff" : `Show diff (+${hunk.added} −${hunk.removed})`}
          </button>
          <button type="button" className={`btn btn-review${reviewed ? " is-on" : ""}`} aria-pressed={reviewed} onClick={(e) => (e.stopPropagation(), onToggleReviewed())}>
            {reviewed ? "Reviewed" : "Mark reviewed"}
          </button>
        </div>

        {expanded && (
          <div id={diffId}>
            <DiffView hunk={hunk} highlight={highlight} />
          </div>
        )}
      </div>
    </article>
  );
}
