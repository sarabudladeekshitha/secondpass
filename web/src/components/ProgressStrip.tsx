import type { RankedHunk } from "../types.ts";

interface Props {
  hunks: RankedHunk[];
  reviewed: Set<string>;
  onJump: (id: string) => void;
}

/**
 * One segment per ranked hunk, as wide as its score. Reviewing a critical
 * hunk fills more of the strip than reviewing a low one, because that is
 * where the reviewer's attention actually went.
 */
export function ProgressStrip({ hunks, reviewed, onJump }: Props) {
  const ranked = hunks.filter((h) => h.risk.tier !== "trivial");
  const weight = (h: RankedHunk) => Math.max(4, h.risk.score);
  const total = ranked.reduce((n, h) => n + weight(h), 0);
  const done = ranked.filter((h) => reviewed.has(h.hunk.id)).reduce((n, h) => n + weight(h), 0);
  const pct = total ? Math.round((done / total) * 100) : 100;
  const count = ranked.filter((h) => reviewed.has(h.hunk.id)).length;

  return (
    <section className="progress" aria-label="Review progress">
      <p className="progress-figure">
        <strong>{pct}%</strong> of the risk reviewed
        <span className="progress-sub">
          {count} of {ranked.length} ranked hunks
        </span>
      </p>
      <div className="strip" role="list">
        {ranked.map((h) => (
          <button
            key={h.hunk.id}
            role="listitem"
            className={`seg tier-${h.risk.tier}${reviewed.has(h.hunk.id) ? " is-done" : ""}`}
            style={{ flexGrow: weight(h) }}
            title={`${h.hunk.path} — ${h.risk.tier} ${h.risk.score}${reviewed.has(h.hunk.id) ? " (reviewed)" : ""}`}
            aria-label={`Go to ${h.hunk.path}, ${h.risk.tier} risk ${h.risk.score}${reviewed.has(h.hunk.id) ? ", reviewed" : ""}`}
            onClick={() => onJump(h.hunk.id)}
          />
        ))}
      </div>
    </section>
  );
}
