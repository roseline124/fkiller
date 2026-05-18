import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesAnyGlob, posixPath } from "./glob-utils.ts";
import type { BugReportNormalized, RawCandidateEvidence, ScoredCandidate } from "./types.ts";

const MAX_READ_FOR_CONTENT_HIT = 48_000;

function uniqueTokens(lowerText: string, minLen = 5, maxTokens = 16): string[] {
  const out = new Set<string>();
  lowerText.split(/[^\p{L}\p{N}_-]/u).forEach((w) => {
    const t = w.toLowerCase().trim();
    if (t.length >= minLen) out.add(t);
  });
  return [...out].slice(0, maxTokens);
}

function baseNameStem(filePathPosix: string): string {
  const base = posixPath(filePathPosix).split("/").pop() ?? filePathPosix;
  return base.replace(/\.[^.]+$/, "").toLowerCase();
}

function filenameOverlapScore(pathPosix: string, tokens: readonly string[]): number {
  const stem = baseNameStem(pathPosix);
  if (!stem.length) return 0;
  for (const tok of tokens) {
    const t = tok.toLowerCase();
    if (!t.length) continue;
    if (stem.includes(t) || t.includes(stem)) return 20;
  }
  return 0;
}

function contentOverlapScore(workspace: string, relPath: string, tokens: readonly string[]): number {
  if (!tokens.length) return 0;
  let hay: string;
  try {
    hay = readFileSync(join(workspace, relPath), "utf8").slice(0, MAX_READ_FOR_CONTENT_HIT).toLowerCase();
  } catch {
    return 0;
  }

  let hits = 0;
  for (const tok of tokens) {
    if (tok.length >= 5 && hay.includes(tok)) hits++;
  }
  if (hits >= 2) return 30;
  if (hits === 1) return 18;
  return 0;
}

function passesPolicy(
  relPath: string,
  mergedBlockedPatterns: readonly string[],
  allowed: readonly string[] | null,
): boolean {
  if (matchesAnyGlob(relPath, mergedBlockedPatterns)) return false;
  if (allowed !== null && allowed.length > 0 && !matchesAnyGlob(relPath, allowed)) return false;
  return true;
}

export function scoreCandidateFiles(
  workspace: string,
  bug: BugReportNormalized,
  evidences: ReadonlyMap<string, RawCandidateEvidence>,
): ScoredCandidate[] {
  const tokens = uniqueTokens(bug.mergedTextLower, 6, 18);

  const scored = [...evidences.values()]
    .map((ev) => {
      const p = posixPath(ev.path);
      if (!passesPolicy(p, bug.mergedBlockedPatterns, bug.effectiveAllowedPatterns)) return null;

      let score = 0;
      const reasons = [...ev.reasons];

      if (ev.fromStackTrace) score += 100;
      if (ev.fromSymbolSearch) score += 80;
      if (ev.fromGlobPath) score += 50;
      if (ev.reasons.some((r) => r.includes("slack-derived"))) score += 30;
      if (ev.fromRecentGit) score += 10;

      const fname = filenameOverlapScore(p, tokens);
      if (fname) {
        score += fname;
        reasons.push("filename heuristic overlap with Slack tokens");
      }

      const content = contentOverlapScore(workspace, p, tokens);
      if (content) {
        score += content;
        reasons.push("slack token appears in early file excerpt");
      }

      return { path: p, score, reasons } satisfies ScoredCandidate;
    })
    .filter((x): x is ScoredCandidate => x !== null);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  return scored.slice(0, bug.inputs.max_context_files);
}
