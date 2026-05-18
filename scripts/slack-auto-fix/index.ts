import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SlackAutoFixReport, ValidationSlice } from "./report.ts";
import { composePrBody, writeReport } from "./report.ts";
import { loadContextDictionary } from "./context-dictionary.ts";
import { normalizeBugReport } from "./normalize.ts";
import { readWorkflowInputsFromEnv } from "./read-workflow-inputs.ts";
import { resolveBaseBranch } from "./resolve-base-branch.ts";
import { retrieveContextCandidates, snippetForAi } from "./retrieve-context.ts";
import { scoreCandidateFiles } from "./score-candidates.ts";
import type { CandidateFilePrompt } from "./generate-patch.ts";
import { generateUnifiedDiffViaAi, redactPotentialSecrets } from "./generate-patch.ts";
import { gitApplyCheckAndApply, stripDiffFences, validatePatchAgainstPolicy } from "./apply-patch.ts";
import { checkoutBaseAndCreate, commitWorkspaceChanges, ghPrCreate, pushBranch, workspaceRoot } from "./git-ops.ts";
import { resolvePackageManager, runPackageScriptIfPresent } from "./package-runner.ts";

const SNIPPET_CHAR_BUDGET = 28_000;

function diagnosticsPush(list: string[], msg: string) {
  list.push(msg);
  console.warn(`slack-auto-fix: ${msg}`);
}

function emitKv(key: string, value: string) {
  const p = process.env.GITHUB_OUTPUT;
  if (!p) return;
  appendFileSync(p, `${key}=${escapeOutput(value)}\n`, { encoding: "utf8" });
}

function escapeOutput(val: string): string {
  return val.replace(/\r?\n/g, " ").slice(0, 8_000);
}

async function main(): Promise<void> {
  const diagnostics: string[] = [];
  const workspace = await workspaceRoot();
  const inputs = readWorkflowInputsFromEnv();
  if (!inputs.request_id.trim()) diagnosticsPush(diagnostics, "request_id was empty");

  try {
    const dictionary = await loadContextDictionary(inputs.context_dictionary_raw.trim());
    const bug = normalizeBugReport(inputs, dictionary);
    const base = resolveBaseBranch({
      environment_url: inputs.environment_url,
      environment_name: inputs.environment_name,
      branchRoutes: dictionary.branchRoutes,
    });

    const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
    const workBranch = `fix/slack-${runId}`;
    emitKv("selected_base_branch", base.selectedBaseBranch);
    emitKv("work_branch", workBranch);

    await checkoutBaseAndCreate(workspace, base.selectedBaseBranch, workBranch);

    const { evidences, matchedKeywordRoutes } = await retrieveContextCandidates(workspace, bug);
    const ranked = scoreCandidateFiles(workspace, bug, evidences);
    diagnosticsPush(diagnostics, `ranked_candidates=${ranked.length}`);

    const candidatePrompts: CandidateFilePrompt[] = ranked.map((c) => ({
      path: c.path,
      score: c.score,
      rationale: [...c.reasons],
      snippet: snippetForAi(join(workspace, c.path), SNIPPET_CHAR_BUDGET),
    }));

    let lintSlice: ValidationSlice | null = null;
    let testSlice: ValidationSlice | null = null;

    let patchValidated = false;
    let touchedPathsFromPatch: readonly string[] = [];
    let patchErrors: readonly string[] = [];

    const aiProvider: SlackAutoFixReport["ai"]["provider"] = process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : process.env.OPENAI_API_KEY
        ? "openai"
        : "none";

    if (!candidatePrompts.length || aiProvider === "none") {
      diagnosticsPush(diagnostics, "Skipping AI patch (missing keys or empty candidate search).");
      patchErrors =
        aiProvider === "none" ? ["AI keys missing — cannot generate patch"] : ["candidate list empty"];
    } else {
      const aiText = await generateUnifiedDiffViaAi({
        bug,
        base,
        matchedKeywordRoutes,
        candidates: candidatePrompts,
      });
      const cleaned = stripDiffFences(aiText);
      const validation = validatePatchAgainstPolicy(cleaned, bug);
      patchValidated = validation.ok;
      patchErrors = [...validation.errors];
      touchedPathsFromPatch = validation.paths;

      if (patchValidated) {
        await gitApplyCheckAndApply(workspace, cleaned);
      } else {
        diagnosticsPush(diagnostics, `Patch validation rejected: ${patchErrors.join("; ")}`);
      }
    }

    const mgr = await resolvePackageManager(workspace);
    const lint = await runPackageScriptIfPresent(workspace, mgr, "lint");
    if (!lint.skipped) {
      lintSlice = {
        command: lint.command,
        exit_code: lint.exit_code,
        ok: lint.ok,
        excerpt: lint.excerpt,
      };
    }

    const test = await runPackageScriptIfPresent(workspace, mgr, "test");
    if (!test.skipped) {
      testSlice = {
        command: test.command,
        exit_code: test.exit_code,
        ok: test.ok,
        excerpt: test.excerpt,
      };
    }

    const keywordMatchedLabels = matchedKeywordRoutes.flatMap((r) => r.keywords);

    let status: SlackAutoFixReport["status"];
    if (patchValidated) {
      const lintIssue = lintSlice && !lintSlice.ok;
      const testIssue = testSlice && !testSlice.ok;
      status = lintIssue || testIssue ? "partial" : "success";
    } else {
      const headline = patchErrors[0]?.toLowerCase() ?? "";
      if (headline.includes("candidate") || headline.includes("keys missing")) status = "noop";
      else status = "failed";
    }

    const patchSummaryPieces: string[] = [];
    if (touchedPathsFromPatch.length) patchSummaryPieces.push(`touched=${touchedPathsFromPatch.join(", ")}`);
    if (!patchValidated) patchSummaryPieces.push(`reject=${patchErrors.join("; ")}`);
    else patchSummaryPieces.push("git_apply=yes");

    const report: SlackAutoFixReport = {
      schema_version: 1,
      status,
      request_id: inputs.request_id,
      slack: {
        slack_channel_id: inputs.slack_channel_id,
        slack_thread_ts: inputs.slack_thread_ts,
        repo: inputs.repo,
        language: inputs.language,
        environment_url: inputs.environment_url,
        environment_name: inputs.environment_name,
      },
      routing: {
        selected_base_branch: base.selectedBaseBranch,
        matched_branch_route: base.matchedBranchRoute,
        matched_keyword_route_keywords: [...new Set(keywordMatchedLabels)].slice(0, 120),
        candidate_paths: candidatePrompts.map((c) => c.path),
        candidate_summaries: ranked,
      },
      policy: {
        blocked_file_patterns: [...bug.mergedBlockedPatterns],
        allowed_file_patterns: bug.effectiveAllowedPatterns ?? [],
      },
      lint: lintSlice,
      test: testSlice,
      ai: {
        provider: aiProvider,
        patch_validation_errors: [...patchErrors],
        touched_paths: [...touchedPathsFromPatch],
      },
      pr: {
        url: null,
        head_branch: workBranch,
        base_branch: base.selectedBaseBranch,
      },
      diagnostics,
    };

    const risks: string[] = [];
    if (lintSlice && !lintSlice.ok) risks.push("lint failed — see PR body/logs");
    if (testSlice && !testSlice.ok) risks.push("tests failed — see PR body/logs");
    if (!patchValidated) risks.push("AI patch not applied");

    risks.push(...diagnostics.slice(0, 10));

    const bodyMarkdown = composePrBody(report, bug, {
      patchSummary: patchSummaryPieces.join(" | ") || "(no_patch_summary)",
      risks,
    });

    let prUrl: string | null = null;
    if (patchValidated) {
      try {
        const didCommit = await commitWorkspaceChanges(
          workspace,
          `[slack-auto-fix] ${inputs.title.trim() || "automated Slack fix PR"}`,
        );
        if (!didCommit) {
          diagnosticsPush(diagnostics, "No git changes detected after applying patch — skipping push/PR");
          report.status = "noop";
        } else {
          await pushBranch(workspace, workBranch);

          const tmpBody = join(workspace, ".slack-auto-fix.pr-body.tmp.md");
          writeFileSync(tmpBody, `${bodyMarkdown}\n`, "utf8");

          try {
            const gh = await ghPrCreate(
              workspace,
              base.selectedBaseBranch,
              workBranch,
              sanitizeTitle(inputs.title || `slack-auto-fix:${inputs.request_id || runId}`),
              tmpBody,
            );
            prUrl = gh.url ?? null;
          } finally {
            try {
              unlinkSync(tmpBody);
            } catch {
              /* ignore */
            }
          }

          report.pr.url = prUrl ?? null;
          emitKv("pr_url", prUrl ?? "");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        diagnosticsPush(diagnostics, `PR staging failed: ${msg}`);
        report.status = report.status === "success" ? "partial" : "failed";
      }
    } else {
      diagnosticsPush(diagnostics, "Skipping push/PR because patch was not validated/applied.");
    }

    emitKv("status", report.status);
    emitKv("request_id", report.request_id || "unknown");

    console.log(redactPotentialSecrets(JSON.stringify(report, null, 2)));
    writeReport(workspace, report);
    process.exit(0);
  } catch (fatal) {
    const msg = fatal instanceof Error ? fatal.message : String(fatal);
    diagnosticsPush(diagnostics, `fatal=${msg}`);
    emitKv("status", "failed");
    emitKv("diag", escapeOutput(msg));

    const fallbackReport: SlackAutoFixReport = {
      schema_version: 1,
      status: "failed",
      request_id: inputs.request_id || "unknown",
      slack: {
        slack_channel_id: inputs.slack_channel_id,
        slack_thread_ts: inputs.slack_thread_ts,
        repo: inputs.repo,
        language: inputs.language,
        environment_url: inputs.environment_url,
        environment_name: inputs.environment_name,
      },
      routing: {
        selected_base_branch: "main",
        matched_branch_route: null,
        matched_keyword_route_keywords: [],
        candidate_paths: [],
      },
      policy: { blocked_file_patterns: [], allowed_file_patterns: [] },
      lint: null,
      test: null,
      ai: {
        provider: "none",
        patch_validation_errors: [],
        touched_paths: [],
      },
      pr: {
        url: null,
        head_branch: `fix/slack-${process.env.GITHUB_RUN_ID ?? "local"}`,
        base_branch: "main",
      },
      diagnostics,
    };

    console.error(redactPotentialSecrets(JSON.stringify(fallbackReport, null, 2)));
    writeReport(workspace, fallbackReport);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(redactPotentialSecrets(`slack-auto-fix: unhandled rejection ${String(e)}`));
  process.exit(1);
});

function sanitizeTitle(t: string): string {
  const s = t.replace(/\r?\n/g, " ").trim();
  return s.slice(0, 240) || "[slack-auto-fix] automated Slack fix";
}
