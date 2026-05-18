import { readFileSync } from "node:fs";
import { posixPath } from "./glob-utils.ts";
import type { BugReportNormalized, KeywordRoute, RawCandidateEvidence } from "./types.ts";
import { spawnProcess } from "./spawn.ts";
import pm from "picomatch";

const pmOpts = { dot: true, posix: true } as const;

const MAX_TERMS_FROM_SLACK = 24;
const MAX_RG_CALLS = 18;

function parseLines(stdout: string): string[] {
  const parts = stdout.split(/\0/).length > 1 ? stdout.split(/\0/) : stdout.split("\n");
  return [...new Set(parts.map((x) => x.trim()).filter(Boolean))];
}

function sanitizeRgTerm(term: string): string {
  const t = term.trim();
  if (!t || t.length > 240) return "";
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t)) return "";
  return t;
}

export async function rgOrGitGrep(workspace: string, term: string): Promise<string[]> {
  const sanitized = sanitizeRgTerm(term);
  if (!sanitized) return [];

  try {
    const rg = await spawnProcess(
      "rg",
      ["--files-with-matches", "--no-messages", "-l", "-i", "--fixed-strings", sanitized, "."],
      { cwd: workspace },
    );
    if (rg.code === 0) return normalizeStdoutPaths(rg.stdout);
    if (rg.code === 1) return [];
  } catch {
    /* rg unavailable */
  }

  const gg = await spawnProcess(
    "git",
    ["-c", "core.quotepath=off", "grep", "-Il", sanitized, "."],
    { cwd: workspace },
  );
  if (gg.code === 0) return normalizeStdoutPaths(gg.stdout);
  if (gg.code === 1) return [];
  throw new Error(`git grep failed: ${gg.stderr || gg.stdout}`);
}

function normalizeStdoutPaths(stdout: string): string[] {
  return [...new Set(parseLines(stdout).map((p) => posixPath(p.replace(/^\.\//, ""))).filter(Boolean))];
}

export async function gitLsFiles(workspace: string): Promise<string[]> {
  const res = await spawnProcess("git", ["ls-files", "-z"], { cwd: workspace });
  if (res.code !== 0) {
    throw new Error(`git ls-files failed (code=${res.code}): ${res.stderr}`);
  }
  return res.stdout
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => posixPath(p.replace(/^\.\//, "")));
}

async function gitRecentFiles(workspace: string, depth = 50): Promise<string[]> {
  const res = await spawnProcess(
    "git",
    ["log", `--max-count=${depth}`, "--name-only", "--pretty=format:", "HEAD"],
    { cwd: workspace },
  );
  if (res.code !== 0) return [];
  return [...new Set(parseLines(res.stdout).filter(Boolean).map((p) => posixPath(p)))];
}

/** Keyword routes matched by substring containment (keywords lowercased). */
export function matchKeywordRoutesFromText(textLower: string, routes: readonly KeywordRoute[]): KeywordRoute[] {
  return routes.filter((route) =>
    route.keywords.some((kw) => {
      const k = kw.toLowerCase().trim();
      return k.length > 0 && textLower.includes(k);
    }),
  );
}

/** Extract stack / path-like snippets from slack error text. */
export function extractLikelyRepoPaths(workspaceRelHint: string, errorText: string, trackedFiles: Set<string>): string[] {
  const found = new Set<string>();
  const re = /\b([\w\-./]+\.(?:tsx?|jsx?|mjs|cjs))(?::(\d+(?:-\d+)?))?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(errorText)) !== null) {
    const fp = posixPath(m[1]!).replace(/^(\.\/)*/, "");
    if (trackedFiles.has(fp)) found.add(fp);
  }
  void workspaceRelHint;
  return [...found];
}

/** Heuristic Slack-derived search terms (preserve symbol casing where useful). */
export function slackDerivedSearchTerms(mergedOriginalCase: string): string[] {
  const terms = new Set<string>();

  for (const m of mergedOriginalCase.matchAll(/\buse[A-Za-z][A-Za-z0-9]+\b/g)) {
    terms.add(m[0]!);
  }
  for (const m of mergedOriginalCase.matchAll(/\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g)) {
    if (m[0]!.length >= 6) terms.add(m[0]!);
  }
  for (const m of mergedOriginalCase.matchAll(/\/?[a-z0-9][a-z0-9_/\-]+\/[a-z0-9_/\-]+\b/gi)) {
    const s = m[0]!;
    if (s.length <= 240) terms.add(s);
  }
  for (const m of mergedOriginalCase.matchAll(/\bHTTP\s+[1-5]\d\d\b\b|\b\d{3}\s+(?:invalid|internal|failed)\b|\b\d{3}\b/gi)) {
    terms.add(m[0]!);
  }

  mergedOriginalCase.split(/[^\p{L}\p{N}_-]/u).forEach((w) => {
    const ww = w.trim();
    if (ww.length >= 5 && ww.length <= 48) terms.add(ww);
  });

  return [...terms].slice(0, MAX_TERMS_FROM_SLACK);
}

function trackedFilterPolicy(
  rel: string,
  blocked: readonly string[],
  allowed: readonly string[] | null,
): boolean {
  if (blocked.some((pat) => pm(pat, pmOpts)(posixPath(rel)))) return false;
  if (allowed !== null && !allowed.some((pat) => pm(pat, pmOpts)(posixPath(rel)))) return false;
  return true;
}

function upsertEvidence(
  map: Map<string, RawCandidateEvidence>,
  path: string,
  mutator: (e: RawCandidateEvidence) => void,
) {
  const p = posixPath(path);
  if (!map.has(p)) map.set(p, { path: p, reasons: [] });
  mutator(map.get(p)!);
}

export async function retrieveContextCandidates(
  workspace: string,
  bug: BugReportNormalized,
): Promise<{
  matchedKeywordRoutes: KeywordRoute[];
  evidences: Map<string, RawCandidateEvidence>;
}> {
  const evidences = new Map<string, RawCandidateEvidence>();

  const trackedRaw = await gitLsFiles(workspace);
  const trackedFiltered = trackedRaw.filter((f) =>
    trackedFilterPolicy(f, bug.mergedBlockedPatterns, bug.effectiveAllowedPatterns),
  );

  const trackedSet = new Set(trackedFiltered);
  const originalMergedText = [
    bug.inputs.title,
    bug.inputs.error_summary,
    bug.inputs.reproduction_steps,
    bug.inputs.expected_behavior,
  ].join("\n");

  /** A. Stack trace style paths directly into repo relative paths when possible */
  extractLikelyRepoPaths("", bug.inputs.error_summary, trackedSet).forEach((p) => {
    upsertEvidence(evidences, p, (e) => {
      e.reasons.push("slack stack trace mentions file path");
      e.fromStackTrace = true;
    });
  });

  const matchedKeywordRoutes = matchKeywordRoutesFromText(bug.mergedTextLower, bug.contextDictionary.keywordRoutes);

  /** C. Paths from keyword routes matched */
  const routePathPatterns = [...new Set(matchedKeywordRoutes.flatMap((r) => r.paths ?? []))];
  routePathPatterns.forEach((globPat) => {
    for (const f of trackedFiltered) {
      if (pm(globPat, pmOpts)(posixPath(f))) {
        upsertEvidence(evidences, f, (e) => {
          e.reasons.push(`dictionary path glob '${globPat}' matched`);
          e.fromGlobPath = true;
        });
      }
    }
  });

  /** B. Symbols from matched routes */
  const symbols = [...new Set(matchedKeywordRoutes.flatMap((r) => r.symbols ?? []))];
  await Promise.all(
    symbols.map(async (sym) => {
      const paths = await rgOrGitGrep(workspace, sym);
      paths
        .filter((p) => trackedSet.has(p))
        .forEach((p) =>
          upsertEvidence(evidences, p, (e) => {
            e.reasons.push(`dictionary symbol '${sym}' search hit`);
            e.fromSymbolSearch = true;
          }),
        );
    }),
  );

  /** A continued: rg slack-derived terms */
  let rgCalls = 0;
  for (const term of slackDerivedSearchTerms(originalMergedText)) {
    if (rgCalls >= MAX_RG_CALLS) break;
    rgCalls++;
    const paths = await rgOrGitGrep(workspace, term);
    paths
      .filter((p) => trackedSet.has(p))
      .forEach((p) =>
        upsertEvidence(evidences, p, (e) => {
          e.reasons.push(`slack-derived term rg hit: '${term.slice(0, 80)}'`);
        }),
      );
  }

  /** D. Recent git churn - low baseline signal */
  const recentFiles = await gitRecentFiles(workspace);
  const recentTracked = recentFiles.filter((p) => trackedSet.has(p));
  for (const p of recentTracked.slice(0, 80)) {
    upsertEvidence(evidences, p, (e) => {
      e.reasons.push("recent commit touched path (git log)");
      e.fromRecentGit = true;
    });
  }

  return { matchedKeywordRoutes, evidences };
}

export function snippetForAi(localPathAbsOrRel: string, maxChars: number): string {
  try {
    const buf = readFileSync(localPathAbsOrRel, "utf8");
    if (buf.length <= maxChars) return buf;
    return `${buf.slice(0, Math.floor(maxChars * 0.55))}\n\n/* --- truncated --- */\n\n${buf.slice(-Math.floor(maxChars * 0.4))}`;
  } catch {
    return "";
  }
}
