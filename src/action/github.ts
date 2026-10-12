/** Minimal GitHub REST client on top of fetch: just what the Action needs. */

export interface GitHubOptions {
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface PullFile {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  patch?: string;
}

interface IssueComment {
  id: number;
  body?: string;
  user?: { type?: string; login?: string };
}

export function createGitHub(opts: GitHubOptions) {
  const base = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;

  async function request(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: init.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "secondpass-action",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text;
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        /* not JSON */
      }
      throw new GitHubError(res.status, `GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${msg}`.trim());
    }
    return res;
  }

  async function paginate<T>(path: string, maxPages = 30): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const res = await request(`${path}${sep}per_page=100&page=${page}`);
      const items = (await res.json()) as T[];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  return {
    /** The PR's unified diff. Falls back to per-file patches for very large PRs. */
    async pullDiff(repo: string, pr: number): Promise<string> {
      try {
        const res = await request(`/repos/${repo}/pulls/${pr}`, { accept: "application/vnd.github.diff" });
        return await res.text();
      } catch (err) {
        // 406: "diff exceeded the maximum number of lines/files".
        if (!(err instanceof GitHubError) || (err.status !== 406 && err.status !== 422)) throw err;
      }
      const files = await paginate<PullFile>(`/repos/${repo}/pulls/${pr}/files`);
      return files.map(filePatchToDiff).join("");
    },

    async upsertComment(repo: string, issue: number, marker: string, body: string): Promise<"created" | "updated"> {
      const comments = await paginate<IssueComment>(`/repos/${repo}/issues/${issue}/comments`, 20);
      const mine = comments.find((c) => c.body?.includes(marker));
      if (mine) {
        await request(`/repos/${repo}/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
        return "updated";
      }
      await request(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      return "created";
    },
  };
}

/** Rebuild a `git diff` section from the files API (which omits headers). */
export function filePatchToDiff(f: PullFile): string {
  const oldPath = f.previous_filename ?? f.filename;
  const head = [`diff --git a/${oldPath} b/${f.filename}`];
  if (f.status === "added") head.push("new file mode 100644");
  if (f.status === "removed") head.push("deleted file mode 100644");
  if (f.status === "renamed") head.push(`rename from ${oldPath}`, `rename to ${f.filename}`);
  if (!f.patch) {
    if (f.status !== "renamed") head.push(`Binary files a/${oldPath} and b/${f.filename} differ`);
    return head.join("\n") + "\n";
  }
  head.push(`--- ${f.status === "added" ? "/dev/null" : `a/${oldPath}`}`);
  head.push(`+++ ${f.status === "removed" ? "/dev/null" : `b/${f.filename}`}`);
  return head.join("\n") + "\n" + f.patch.replace(/\n?$/, "\n");
}
