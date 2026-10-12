import type { SummaryRequest, Summarizer } from "./summarize.ts";

export const DEFAULT_MODEL = "claude-haiku-5-5";

const SYSTEM = `You describe code changes for a pull-request reviewer.

For each hunk you get a file path and a unified diff. Write ONE line, at most 110 characters, that says what the change does: present tense, starting with a verb, naming the concrete thing that changed (the function, field, condition, value or route).

You are a describer, not a reviewer. Another system has already decided how much attention each hunk needs, using the diff and test coverage. Do not judge the change. Never say whether it is safe, risky, correct, minor, important, cosmetic or tested. Never recommend or warn. Never use the words "safely", "just", "only", "simply", "should", "must", "potential" or "properly".

Good: "Rejects refunds made exactly 30 days after capture (> becomes >=)"
Good: "Stops awaiting ledger.post and drops the retry-exhausted rethrow"
Bad: "Minor refactor, safe to skip"
Bad: "Potentially dangerous change to auth"

Reply with JSON only: an object mapping each hunk key to its line, e.g. {"h1": "...", "h2": "..."}.`;

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  /** Override for tests or proxies. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Max characters of diff per request. */
  batchChars?: number;
  batchSize?: number;
  concurrency?: number;
  timeoutMs?: number;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

/** Pull the first JSON object out of a model reply, tolerating code fences. */
export function parseSummaryJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function batches(items: SummaryRequest[], maxChars: number, maxItems: number): SummaryRequest[][] {
  const out: SummaryRequest[][] = [];
  let cur: SummaryRequest[] = [];
  let size = 0;
  for (const it of items) {
    const len = it.diff.length + it.path.length + 40;
    if (cur.length && (size + len > maxChars || cur.length >= maxItems)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Summarizer backed by the Anthropic Messages API, using plain `fetch`. */
export function anthropicSummarizer(opts: AnthropicOptions): Summarizer {
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
  const model = opts.model ?? DEFAULT_MODEL;

  async function call(batch: SummaryRequest[]): Promise<Map<string, string>> {
    const keyed = batch.map((item, i) => ({ key: `h${i + 1}`, item }));
    const user = keyed
      .map(({ key, item }) => `<hunk key="${key}" path="${item.path}"${item.section ? ` context="${item.section.replace(/"/g, "'")}"` : ""}>\n${item.diff}\n</hunk>`)
      .join("\n\n");
    const body = JSON.stringify({
      model,
      max_tokens: Math.min(4096, 120 + batch.length * 60),
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });

    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const wait = Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
        await new Promise((r) => setTimeout(r, Math.min(wait, 20) * 1000));
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as MessagesResponse;
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${json.error?.message ?? res.statusText}`);
      const text = (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const parsed = parseSummaryJson(text);
      const out = new Map<string, string>();
      for (const { key, item } of keyed) {
        const v = parsed[key];
        if (typeof v === "string") out.set(item.id, v);
      }
      return out;
    }
  }

  return {
    async summarize(items) {
      const groups = batches(items, opts.batchChars ?? 40_000, opts.batchSize ?? 15);
      const results = await mapLimit(groups, opts.concurrency ?? 3, (g) =>
        call(g).catch((err: unknown) => {
          // One failed batch shouldn't cost every other summary.
          process.emitWarning(`secondpass: summary batch failed: ${err instanceof Error ? err.message : String(err)}`);
          return new Map<string, string>();
        }),
      );
      return new Map(results.flatMap((m) => [...m]));
    },
  };
}
