import { describe, expect, it } from "vitest";
import { composePrBody } from "../../src/report.ts";
import { minimalBug } from "../fixtures/workflow-fixtures.ts";
import type { SlackAutoFixReport } from "../../src/report.ts";

function stubReport(overrides: Partial<SlackAutoFixReport> = {}): SlackAutoFixReport {
  return {
    schema_version: 1,
    status: "noop",
    request_id: "rid",
    slack: {
      slack_channel_id: "C",
      slack_thread_ts: "t",
      repo: "r",
      language: "ja",
      environment_url: "https://x",
      environment_name: "",
    },
    routing: {
      selected_base_branch: "main",
      matched_branch_route: null,
      matched_keyword_route_keywords: [],
      candidate_paths: ["a.ts"],
    },
    policy: {
      blocked_file_patterns: [],
      allowed_file_patterns: [],
    },
    lint: null,
    test: null,
    ai: {
      provider: "none",
      patch_validation_errors: [],
      touched_paths: [],
    },
    pr: {
      url: null,
      head_branch: "fix/test",
      base_branch: "main",
    },
    diagnostics: [],
    ...overrides,
  };
}

describe("composePrBody", () => {
  it("PR 본문에 language 행 포함", () => {
    const bug = minimalBug({ inputs: { language: "ja" } });
    const body = composePrBody(stubReport(), bug, { patchSummary: "noop" });

    /** 눈으로 확인하기 좋도록 한 줄이 실제 존재하는지 검증 */
    expect(body).toMatch(/Language.*`ja`/);
    expect(body).toMatch(/Context Routing/u);
    expect(body).toMatch(/Slack 요약/u);
  });
});
