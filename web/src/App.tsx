import { useCallback, useEffect, useMemo, useState } from "react";
import { HunkRow, Inline, lineLabel } from "./components/HunkRow.tsx";
import { ProgressStrip } from "./components/ProgressStrip.tsx";
import { loadReviewed, saveReviewed } from "./storage.ts";
import type { RankedHunk, Report, Tier } from "./types.ts";

declare global {
  interface Window {
    __SECONDPASS_REPORT__?: unknown;
  }
}

const TIERS: Array<Exclude<Tier, "trivial">> = ["critical", "high", "medium", "low"];

export function isReport(x: unknown): x is Report {
  return !!x && typeof x === "object" && (x as Report).version === 1 && Array.isArray((x as Report).hunks);
}

function storageKey(r: Report): string {
  const src = r.source;
  return `secondpass:reviewed:${src?.repo ?? "local"}#${src?.pr ?? ""}@${src?.headSha ?? r.generatedAt}`;
}

export function App({ initial }: { initial?: Report }) {
  const [report, setReport] = useState<Report | undefined>(initial);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  // ?report=<url> loads a JSON report from anywhere CORS allows.
  useEffect(() => {
    if (report) return;
    const url = new URLSearchParams(window.location.search).get("report");
    if (!url) return;
    setLoading(true);
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((data: unknown) => (isReport(data) ? setReport(data) : setError("That URL didn't return a SecondPass report.")))
      .catch((e: unknown) => setError(`Couldn't load the report from ${url}: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setLoading(false));
  }, [report]);

  const openFile = useCallback((file: File) => {
    file
      .text()
      .then((text) => {
        const data: unknown = JSON.parse(text);
        if (!isReport(data)) throw new Error("not a report");
        setError(undefined);
        setReport(data);
      })
      .catch(() => setError(`${file.name} isn't a SecondPass JSON report. Create one with \`secondpass --json report.json\`.`));
  }, []);

  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files[0];
      if (f) openFile(f);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [openFile]);

  if (!report) return <Empty error={error} loading={loading} onFile={openFile} onSample={() => import("./sample.ts").then((m) => setReport(m.sample))} />;
  return <Review report={report} onClose={() => setReport(undefined)} />;
}

function Empty({ error, loading, onFile, onSample }: { error?: string; loading: boolean; onFile: (f: File) => void; onSample: () => void }) {
  return (
    <main className="empty">
      <h1 className="brand">SecondPass</h1>
      <p className="lede">Read a pull request in the order that matters: migrations, auth, money and behaviour changes first; renames and formatting folded away.</p>
      {loading ? (
        <p className="muted">Loading report…</p>
      ) : (
        <div className="empty-actions">
          <label className="btn btn-primary">
            Open a report file
            <input type="file" accept=".json,application/json" className="visually-hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </label>
          <button type="button" className="btn" onClick={onSample}>
            Open the sample pull request
          </button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted small">
        Or drop a <code>report.json</code> here. Make one with <code>npx secondpass --base origin/main --json report.json</code>.
      </p>
    </main>
  );
}

function Review({ report, onClose }: { report: Report; onClose: () => void }) {
  const key = storageKey(report);
  const [reviewed, setReviewed] = useState<Set<string>>(() => loadReviewed(key));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(report.hunks.slice(0, 1).map((h) => h.hunk.id)));
  const [tier, setTier] = useState<Tier | "all">("all");
  const [query, setQuery] = useState("");
  const [hideReviewed, setHideReviewed] = useState(false);
  const [focus, setFocus] = useState<string | undefined>(report.hunks[0]?.hunk.id);

  useEffect(() => saveReviewed(key, reviewed), [key, reviewed]);

  const ranked = useMemo(() => report.hunks.filter((h) => h.risk.tier !== "trivial"), [report]);
  const collapsed = useMemo(() => report.hunks.filter((h) => h.risk.tier === "trivial"), [report]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ranked.filter(
      (h) =>
        (tier === "all" || h.risk.tier === tier) &&
        (!hideReviewed || !reviewed.has(h.hunk.id)) &&
        (!q || h.hunk.path.toLowerCase().includes(q) || (h.summary ?? "").toLowerCase().includes(q)),
    );
  }, [ranked, tier, query, hideReviewed, reviewed]);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const jump = useCallback((id: string) => {
    setFocus(id);
    setExpanded((s) => new Set(s).add(id));
    requestAnimationFrame(() => document.getElementById(`h-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, []);

  // j / k to move, x to mark reviewed, o to open the diff.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = Math.max(0, visible.findIndex((h) => h.hunk.id === focus));
      const cur = visible[i];
      if (e.key === "j" || e.key === "k") {
        const next = visible[Math.min(visible.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))];
        if (next) {
          setFocus(next.hunk.id);
          document.getElementById(`h-${next.hunk.id}`)?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "x" && cur) setReviewed((s) => toggle(s, cur.hunk.id));
      else if (e.key === "o" && cur) setExpanded((s) => toggle(s, cur.hunk.id));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, focus]);

  const src = report.source;
  const t = report.totals;

  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-row">
          <span className="brand">SecondPass</span>
          <button type="button" className="link" onClick={onClose}>
            Open another report
          </button>
        </div>
        <h1 className="pr-title">
          {src?.url ? <a href={src.url}>{src.title ?? `${src.repo}#${src.pr}`}</a> : (src?.title ?? "Local diff")}
        </h1>
        <p className="pr-meta">
          {src?.repo && <span>{src.repo}{src.pr ? ` #${src.pr}` : ""}</span>}
          <span>
            {t.hunks} hunks in {t.files} files
          </span>
          <span className="diffstat">
            <span className="plus">+{t.added}</span> <span className="minus">−{t.removed}</span>
          </span>
          <span>{t.coverageProvided ? "Coverage included" : "No coverage data"}</span>
        </p>
      </header>

      <ProgressStrip hunks={report.hunks} reviewed={reviewed} onJump={jump} />

      <nav className="toolbar" aria-label="Filter hunks">
        <div className="tiers" role="group" aria-label="Risk tier">
          <button type="button" className={`chip${tier === "all" ? " is-on" : ""}`} aria-pressed={tier === "all"} onClick={() => setTier("all")}>
            All <span className="n">{ranked.length}</span>
          </button>
          {TIERS.map((k) => (
            <button
              key={k}
              type="button"
              className={`chip tier-${k}${tier === k ? " is-on" : ""}`}
              aria-pressed={tier === k}
              disabled={t.byTier[k] === 0}
              onClick={() => setTier(k)}
            >
              <span className="dot" aria-hidden="true" />
              {k[0]!.toUpperCase() + k.slice(1)} <span className="n">{t.byTier[k]}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <label className="check">
            <input type="checkbox" checked={hideReviewed} onChange={(e) => setHideReviewed(e.target.checked)} /> Hide reviewed
          </label>
          <input className="search" type="search" placeholder="Filter by path or description" aria-label="Filter by path or description" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </nav>

      <main className="hunks">
        {visible.length === 0 && (
          <p className="muted empty-list">
            {ranked.length === 0 ? "Nothing to rank: every change is a rename, formatting, import, comment or generated file." : "No hunks match these filters."}
          </p>
        )}
        {visible.map((h: RankedHunk) => (
          <HunkRow
            key={h.hunk.id}
            hunk={h}
            reviewed={reviewed.has(h.hunk.id)}
            expanded={expanded.has(h.hunk.id)}
            focused={focus === h.hunk.id}
            onFocus={() => setFocus(h.hunk.id)}
            onToggleReviewed={() => setReviewed((s) => toggle(s, h.hunk.id))}
            onToggleExpanded={() => setExpanded((s) => toggle(s, h.hunk.id))}
          />
        ))}

        {collapsed.length > 0 && (
          <details className="collapsed">
            <summary>
              {collapsed.length} collapsed {collapsed.length === 1 ? "hunk" : "hunks"}: renames, formatting, imports, comments and generated files
            </summary>
            <ul>
              {collapsed.map((h) => (
                <li key={h.hunk.id}>
                  <span className="path">{h.hunk.path}</span> <span className="lines">{lineLabel(h)}</span>
                  <span className="why">
                    <Inline text={h.risk.trivial?.reason ?? ""} />
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {report.notes.length > 0 && (
          <details className="collapsed">
            <summary>{report.notes.length} not ranked</summary>
            <ul>
              {report.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        )}
      </main>

      <footer className="foot">
        <p>
          Order comes from the diff and test coverage, never from the model. Descriptions say what a hunk does, not whether it's fine. Keys: <kbd>j</kbd> <kbd>k</kbd> move,{" "}
          <kbd>o</kbd> diff, <kbd>x</kbd> reviewed.
        </p>
      </footer>
    </div>
  );
}
