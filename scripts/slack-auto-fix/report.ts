import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BranchRoute, BugReportNormalized, WorkflowInputs } from "./types.ts";
import type { ScoredCandidate } from "./types.ts";

export type ValidationSlice = {
  command: string;
  ok: boolean;
  exit_code: number | null;
  excerpt: string;
};

export type SlackAutoFixReport = {
  schema_version: 1;
  status: "success" | "partial" | "failed" | "noop";
  request_id: string;
  slack: Pick<WorkflowInputs, "slack_channel_id" | "slack_thread_ts" | "repo"> & {
    environment_url: string;
    environment_name: string;
  };
  routing: {
    selected_base_branch: string;
    matched_branch_route: BranchRoute | null;
    matched_keyword_route_keywords: readonly string[];
    candidate_paths: readonly string[];
    candidate_summaries?: readonly ScoredCandidate[];
  };
  policy: {
    blocked_file_patterns: readonly string[];
    allowed_file_patterns: readonly string[];
  };
  lint: ValidationSlice | null;
  test: ValidationSlice | null;
  ai: {
    provider: "anthropic" | "openai" | "none";
    patch_validation_errors: readonly string[];
    touched_paths: readonly string[];
  };
  pr: {
    url: string | null;
    head_branch: string;
    base_branch: string;
    title?: string | null;
  };
  diagnostics: readonly string[];
};

export function composePrBody(report: SlackAutoFixReport, bug: BugReportNormalized, opts: {
  patchSummary?: string;
  risks?: readonly string[];
}): string {
  const lines = [
    "## Slack 요약",
    `- 요청 제목: ${bug.inputs.title || "(미입력)"}`,
    `- 에러 요약: ${bug.inputs.error_summary || "(미입력)"}`,
    `- request_id (\`Supabase.fix_requests.id\`): \`${report.request_id || "unknown"}\``,
    "",
    "## Context Routing",
    `- Environment URL: \`${report.slack.environment_url || "(unset)"}\``,
    `- Environment Name: \`${report.slack.environment_name || "(unset)"}\``,
    `- Selected Base Branch: \`${report.routing.selected_base_branch}\``,
    `- Matched Branch Route: ${
      report.routing.matched_branch_route
        ? "`" + `${fmtBranchRoute(report.routing.matched_branch_route)}` + "` → base `" + `${report.routing.matched_branch_route.baseBranch}` + "`"
        : "`(none)`"
    }`,
    `- Matched Keyword Routes: ${
      report.routing.matched_keyword_route_keywords.length
        ? "`" + report.routing.matched_keyword_route_keywords.join(", ") + "`"
        : "`(none)`"
    }`,
    `- Candidate Files: \`${report.routing.candidate_paths.join(", ") || "(none)"}\``,
    `- Blocked Patterns: \`${truncateInline(report.policy.blocked_file_patterns.join(", "), 900)}\``,
    `- Allowed Patterns: ${
      report.policy.allowed_file_patterns.length
        ? "`" + truncateInline(report.policy.allowed_file_patterns.join(", "), 900) + "`"
        : "`(no allowlist)`"
    }`,
    "",
    "## 재현 단계",
    bug.inputs.reproduction_steps.trim() ? bug.inputs.reproduction_steps.trim() : "(미입력)",
    "",
    "## 기대 동작",
    bug.inputs.expected_behavior.trim() ? bug.inputs.expected_behavior.trim() : "(미입력)",
    "",
    "## 수정 내용 요약",
    opts.patchSummary?.trim() ? opts.patchSummary.trim() : "`(패치 적용 결과 없음 또는 요약 불가)`",
    "",
    "## 검증 결과",
    `- overall status: \`${report.status}\``,
    renderValidation("lint 스크립트", report.lint),
    renderValidation("test 스크립트", report.test),
    "",
    "## 리스크",
    opts.risks?.length
      ? opts.risks.map((r) => `- ${r}`).join("\n")
      : `- 자동 패치 신뢰도 한계, 회귀/보안 리뷰 필요.\n- AI hallucination 가능성.`,
    "",
    "## 메모",
    "자동 머지는 수행하지 않습니다.",
    "",
    "## Supabase",
    "`request_id=" + report.request_id + "`",
    "",
    "## 후보 선택 메타데이터",
    ...formatCandidateBullets(report.routing.candidate_summaries ?? []),
  ].join("\n");

  return lines;
}

function formatCandidateBullets(cands: readonly ScoredCandidate[]): string[] {
  if (!cands.length) return ["`(candidate metadata unavailable)`"];
  const out: string[] = [];
  let i = 1;
  for (const c of cands.slice(0, 20)) {
    out.push(`${i}. \`${c.path}\` — score=${c.score} — ${truncateInline(c.reasons.join("; "), 400)}`);
    i++;
  }
  return out;
}

function fmtBranchRoute(route: BranchRoute): string {
  const u = typeof route.match.environmentUrl === "string" ? route.match.environmentUrl : "none";
  const n = typeof route.match.environmentName === "string" ? route.match.environmentName : "none";
  return `url:${u}; name:${n}`;
}

function renderValidation(label: string, slice: ValidationSlice | null): string {
  if (!slice) return `- ${label}: \`(package.json 에 스크립트 없음 — 스킵)\``;
  const status = slice.ok ? "PASSED" : "FAILED";
  return [
    `- ${label}: exit_code=${slice.exit_code ?? "?"} status=${status}`,
    "```",
    slice.excerpt.trim() ? slice.excerpt.trim() : "(no excerpt)",
    "```",
  ].join("\n");
}

export function truncateInline(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export function writeReport(workspace: string, report: SlackAutoFixReport): void {
  writeFileSync(join(workspace, "slack-auto-fix-report.json"), JSON.stringify(report, null, 2), "utf8");
}
