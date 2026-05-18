/**
 * Parses JSON array globs passed from workflow_dispatch (optional).
 */
export function parseGlobPatternsJson(raw: string, label: string): string[] {
  const t = raw.trim();
  if (!t.length) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch (e) {
    throw new Error(`${label}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label}: must be a JSON array of strings`);
  }
  const out = parsed.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  return [...new Set(out)];
}
