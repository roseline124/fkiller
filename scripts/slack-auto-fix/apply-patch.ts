import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { matchesAnyGlob, posixPath } from "./glob-utils.ts";
import type { BugReportNormalized } from "./types.ts";
import { spawnProcess } from "./spawn.ts";

/** Normalizes assistant output to plausible unified diff. */
export function stripDiffFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:diff)?\s*\n/, "");
    t = t.replace(/\n```\s*$/, "");
  }
  return t.trim();
}

/** Paths modified on the '+' side of unified diff (existing files only). */
export function extractPositivePaths(diffText: string): string[] {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  const out = new Set<string>();
  for (const ln of lines) {
    const m = ln.match(/^\+\+\+ b\/(.+)$/);
    if (!m) continue;
    const p = posixPath(m[1]!).replace(/^(\.\/)*/, "").trim();
    if (!p.length || p === "/dev/null") continue;
    out.add(p);
  }
  return [...out];
}

export function extractHasNewFiles(diffText: string): boolean {
  let sawFromNull = false;
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  for (const ln of lines) {
    if (ln.startsWith("diff --git")) {
      sawFromNull = false;
    }
    if (ln.startsWith("--- ") && ln.includes("/dev/null")) sawFromNull = true;
    if (sawFromNull && ln.startsWith("+++ b/")) {
      if (!ln.includes("/dev/null")) return true;
    }
  }
  return false;
}

export function validatePatchAgainstPolicy(diffText: string, bug: BugReportNormalized): {
  ok: boolean;
  errors: string[];
  paths: string[];
} {
  const errors: string[] = [];

  const hasDiffHeader =
    /\bdiff\s+--git\b/.exec(diffText) !== null ||
    (/^\*{3}\s+/.exec(diffText) !== null && /^\-{3}\s/.exec(diffText) !== null);

  const pathsRaw = extractPositivePaths(diffText);
  const uniquePaths = [...new Set(pathsRaw)];

  if (!stripDiffFences(diffText).length) {
    errors.push("patch text was empty after normalization");
    return { ok: false, errors, paths: uniquePaths };
  }

  if (!hasDiffHeader && uniquePaths.length === 0) {
    errors.push("AI response did not resemble a unified diff");
    return { ok: false, errors, paths: uniquePaths };
  }

  if (extractHasNewFiles(diffText)) {
    errors.push("diff adds new files; only modifying existing tracked files is allowed");
  }

  const maxPatch = bug.inputs.max_patch_files;
  if (uniquePaths.length > maxPatch) {
    errors.push(`diff touches ${uniquePaths.length} files; max permitted is ${maxPatch}`);
  }

  for (const p of uniquePaths) {
    const rel = posixPath(p);
    if (matchesAnyGlob(rel, bug.mergedBlockedPatterns)) {
      errors.push(`blocked glob matched modified path '${rel}'`);
    }
    if (
      bug.effectiveAllowedPatterns !== null &&
      bug.effectiveAllowedPatterns.length > 0 &&
      !matchesAnyGlob(rel, bug.effectiveAllowedPatterns)
    ) {
      errors.push(`path '${rel}' outside allowed globs`);
    }
  }

  return { ok: errors.length === 0, errors, paths: uniquePaths };
}

export async function gitApplyCheckAndApply(workspace: string, unifiedDiffText: string): Promise<void> {
  const sanitized = stripDiffFences(unifiedDiffText).replace(/\r\n/g, "\n");
  const tmpDir = mkdtempSync(join(os.tmpdir(), "slack-auto-fix-"));
  const filePath = join(tmpDir, "patch.diff");
  writeFileSync(filePath, sanitized, "utf8");
  try {
    const chk = await spawnProcess("git", ["apply", "--check", "--whitespace=nowarn", filePath], {
      cwd: workspace,
    });
    if (chk.code !== 0) {
      throw new Error(`git apply --check failed: ${truncate(redactSecrets(chk.stderr || chk.stdout))}`);
    }
    const applied = await spawnProcess("git", ["apply", "--whitespace=nowarn", filePath], {
      cwd: workspace,
    });
    if (applied.code !== 0) {
      throw new Error(`git apply failed: ${truncate(redactSecrets(applied.stderr || applied.stdout))}`);
    }
  } finally {
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}


export function truncate(t: string, max = 8_000): string {
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function redactSecrets(s: string): string {
  return s
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[^\s]+\b/gi, "[REDACTED]")
    .replace(/\bghp_[^\s]+\b/g, "[REDACTED]")
    .replace(/\bAIza[^\s]+\b/g, "[REDACTED]");
}
