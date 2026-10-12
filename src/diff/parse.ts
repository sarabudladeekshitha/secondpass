import type { DiffLine, FileDiff, Hunk } from "../types.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Undo git's C-style quoting of unusual paths: "a/caf\303\251.txt". */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i];
    if (next && /[0-7]/.test(next)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
      bytes.push(...Buffer.from(map[next ?? ""] ?? next ?? "", "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string): string {
  const q = unquote(p.trim());
  if (q === "/dev/null") return q;
  return q.replace(/^[ab]\//, "");
}

/** Best effort for `diff --git a/x b/x` when paths contain spaces. */
function pathsFromGitHeader(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*")\s+(.*)$/);
    if (m) return [stripPrefix(m[1]!), stripPrefix(m[2]!)];
  }
  // Unrenamed files: "a/<p> b/<p>" — find the split where both halves agree.
  const parts = rest.split(" b/");
  for (let i = 1; i < parts.length; i++) {
    const a = parts.slice(0, i).join(" b/");
    const b = parts.slice(i).join(" b/");
    if (a.replace(/^a\//, "") === b) return [b, b];
  }
  const m = rest.match(/^a\/(.*?) b\/(.*)$/);
  return m ? [m[1]!, m[2]!] : undefined;
}

function emptyFile(): FileDiff {
  return { oldPath: "", newPath: "", status: "modified", binary: false, hunks: [] };
}

function finalize(file: FileDiff): FileDiff {
  if (file.oldPath === "/dev/null") {
    file.status = "added";
    file.oldPath = file.newPath;
  } else if (file.newPath === "/dev/null") {
    file.status = "deleted";
    file.newPath = file.oldPath;
  } else if (file.status === "modified" && file.oldPath && file.oldPath !== file.newPath) {
    file.status = "renamed";
  }
  const path = file.status === "deleted" ? file.oldPath : file.newPath;
  for (const h of file.hunks) {
    h.path = path;
    h.id = file.status === "deleted" ? `${path}:-${h.oldStart}` : `${path}:${h.newStart}`;
  }
  return file;
}

/**
 * Parse a unified diff (as produced by `git diff` or the GitHub
 * `application/vnd.github.diff` media type) into files and hunks.
 */
export function parseDiff(input: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = input.replace(/\r\n/g, "\n").split("\n");

  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const startFile = () => {
    if (file) files.push(finalize(file));
    file = emptyFile();
    hunk = undefined;
  };

  for (const line of lines) {
    // Inside a hunk, consume body lines until its declared length runs out.
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const tag = line[0];
      const text = line.slice(1);
      if (tag === "+") {
        hunk.lines.push({ kind: "add", text, newLine: newNo++ });
        newLeft--;
        continue;
      }
      if (tag === "-") {
        hunk.lines.push({ kind: "del", text, oldLine: oldNo++ });
        oldLeft--;
        continue;
      }
      if (tag === " " || line === "") {
        hunk.lines.push({ kind: "ctx", text, oldLine: oldNo++, newLine: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (tag === "\\") continue; // "\ No newline at end of file"
      // Malformed counts: fall through and treat as a header line.
      oldLeft = newLeft = 0;
    }
    if (line.startsWith("\\")) continue;

    if (line.startsWith("diff --git ")) {
      startFile();
      const paths = pathsFromGitHeader(line.slice("diff --git ".length));
      if (paths) [file!.oldPath, file!.newPath] = paths;
      continue;
    }
    if (line.startsWith("--- ")) {
      // Hunk bodies were consumed above, so this is a header. A plain
      // (non-git) diff has no `diff --git` line, so start a new file here.
      if (!file || file.hunks.length > 0) startFile();
      file!.oldPath = stripPrefix(line.slice(4).replace(/\t.*$/, ""));
      continue;
    }
    if (!file) continue;

    if (line.startsWith("+++ ")) {
      file.newPath = stripPrefix(line.slice(4).replace(/\t.*$/, ""));
      continue;
    }
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.oldPath = unquote(line.slice(12));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      file.newPath = unquote(line.slice(10));
      file.status = "renamed";
    } else if (line.startsWith("similarity index ")) {
      file.similarity = parseInt(line.slice(17), 10);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }

    const m = line.match(HUNK_HEADER);
    if (m) {
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      hunk = {
        id: "",
        path: "",
        oldStart,
        oldLines,
        newStart,
        newLines,
        section: (m[5] ?? "").trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      oldLeft = oldLines;
      newLeft = newLines;
    }
  }
  if (file) files.push(finalize(file));

  // Fix status for files whose header said added/deleted but used /dev/null paths.
  return files.filter((f) => f.oldPath || f.newPath);
}

export function changedLines(h: Hunk): { added: DiffLine[]; removed: DiffLine[] } {
  return {
    added: h.lines.filter((l) => l.kind === "add"),
    removed: h.lines.filter((l) => l.kind === "del"),
  };
}

/** Render a hunk back to unified-diff text (used for model prompts). */
export function hunkToText(h: Hunk, maxLines = 400): string {
  const head = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.section}`.trimEnd();
  const body = h.lines.slice(0, maxLines).map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
  if (h.lines.length > maxLines) body.push(`… ${h.lines.length - maxLines} more lines`);
  return [head, ...body].join("\n");
}
