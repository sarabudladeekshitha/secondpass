// Reviewed-state is a per-reader convenience, so browser storage is enough.
// Every access is guarded: storage can be missing or throw (private mode, file://).

export function loadReviewed(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveReviewed(key: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable: state lives for this page view only */
  }
}
