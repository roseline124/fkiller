import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "@actions/core";

import type { SlackAutoFixReport, ValidationSlice } from "./report.ts";
import { composePrBody, writeReport } from "./report.ts";
import { loadContextDictionary } from "./context-dictionary.ts";
import { normalizeBugReport } from "./normalize.ts";
import { readActionInputs } from "./read-workflow-inputs.ts";
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
  core.warning(`slack-auto-fix: ${msg}`);
}

function applySecretsFromInputs(): void {
  const gh = core.getInput("github_token", { required: true });
  core.setSecret(gh);
  process.env.GITHUB_TOKEN = gh;
  process.env.GH_TOKEN = gh;

  const oai = core.getInput("openai_api_key");
  if (oai) {
    core.setSecret(oai);
    process.env.OPENAI_API_KEY = oai;
  } else {
    delete process.env.OPENAI_API_KEY;
  }

  const ant = core.getInput("anthropic_api_key");
  if (ant) {
    core.setSecret(ant);
    process.env.ANTHROPIC_API_KEY = ant;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
}

async function writeFailureSummary(message: string, diagnostics: string[]): Promise<void> {
  await core.summary
    .addHeading("slack-auto-fix failed")
    .addRaw(`${message}\n\n`)
    .addHeading("Diagnostics", 3)
    .addCodeBlock(diagnostics.join("\n") || "(none)", "text")
    .write();
}

async function main(): Promise<void> {
  applySecretsFromInputs();

  const diagnostics: string[] = [];
  const workspace = await workspaceRoot();
  const bundle = readActionInputs(core);
  const inputs = bundle.workflow;

  try {
    const dictionary = await loadContextDictionary(
      {
        inlineJson: bundle.contextDictionaryJson,
        fileRelativePath: bundle.contextDictionaryPath,
      },
      workspace,
      (m) => diagnosticsPush(diagnostics, m),
    );
    const bug = normalizeBugReport(inputs, dictionary);
    const base = resolveBaseBranch({
      environment_url: inputs.environment_url,
      environment_name: inputs.environment_name,
      branchRoutes: dictionary.branchRoutes,
    });

    const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
    const workBranch = `fix/slack-${runId}`;

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
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        diagnosticsPush(diagnostics, `PR staging failed: ${msg}`);
        report.status = report.status === "success" ? "partial" : "failed";
      }
    } else {
      diagnosticsPush(diagnostics, "Skipping push/PR because patch was not validated/applied.");
    }

    core.setOutput("pull_request_url", prUrl ?? "");
    core.info(redactPotentialSecrets(JSON.stringify(report, null, 2)));
    writeReport(workspace, report);

    if (report.status === "failed") {
      await writeFailureSummary("Run ended with status failed — see report JSON and diagnostics.", diagnostics);
      core.setFailed("slack-auto-fix: patch or validation failed (see summary and logs).");
    }
  } catch (fatal) {
    const msg = fatal instanceof Error ? fatal.message : String(fatal);
    diagnosticsPush(diagnostics, `fatal=${msg}`);

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

    core.setOutput("pull_request_url", "");
    core.error(redactPotentialSecrets(JSON.stringify(fallbackReport, null, 2)));
    writeReport(workspace, fallbackReport);
    await writeFailureSummary(msg, diagnostics);
    core.setFailed(msg);
  }
}

main().catch(async (e) => {
  const msg = redactPotentialSecrets(`slack-auto-fix: unhandled rejection ${String(e)}`);
  core.error(msg);
  await writeFailureSummary(msg, [msg]);
  core.setFailed(msg);
});

function sanitizeTitle(t: string): string {
  const s = t.replace(/\r?\n/g, " ").trim();
  return s.slice(0, 240) || "[slack-auto-fix] automated Slack fix";
}
