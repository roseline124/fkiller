import type { BugReportNormalized, ContextDictionary, WorkflowInputs } from "../../src/types.ts";

export function baseWorkflowInputs(overrides: Partial<WorkflowInputs> = {}): WorkflowInputs {
  return {
    request_id: "test-req",
    repo: "org/repo",
    slack_channel_id: "C0123",
    slack_thread_ts: "1234.5678",
    title: "예시 버그",
    error_summary: "Something failed",
    reproduction_steps: "Click A",
    expected_behavior: "Works",
    language: "ko",
    allowed_file_patterns: [],
    blocked_file_patterns: [],
    environment_url: "",
    environment_name: "",
    max_context_files: 12,
    max_patch_files: 5,
    ...overrides,
  };
}

export function minimalDictionary(): ContextDictionary {
  return {
    branchRoutes: [
      { match: { environmentUrl: "https://agent.example" }, baseBranch: "main" },
      { match: { environmentName: "staging" }, baseBranch: "develop" },
    ],
    keywordRoutes: [
      {
        keywords: ["keyvalue", "키밸류"],
        symbols: ["useOcrKeyvalueStream"],
        paths: ["apps/**/Foo*"],
      },
    ],
  };
}

export function mergedTextFromInputs(inputs: WorkflowInputs): string {
  return [
    inputs.title,
    inputs.error_summary,
    inputs.reproduction_steps,
    inputs.expected_behavior,
  ]
    .join("\n")
    .toLowerCase();
}

export type MinimalBugOverrides = Partial<Omit<BugReportNormalized, "inputs" | "contextDictionary">> & {
  inputs?: Partial<WorkflowInputs>;
  contextDictionary?: ContextDictionary;
};

export function minimalBug(overrides: MinimalBugOverrides = {}): BugReportNormalized {
  const inputs = baseWorkflowInputs(overrides.inputs ?? {});
  const dictionary = overrides.contextDictionary ?? minimalDictionary();
  const mergedTextLower =
    overrides.mergedTextLower ?? mergedTextFromInputs(inputs);
  const mergedBlocked =
    overrides.mergedBlockedPatterns ?? ["**/auth/**", "**/node_modules/**"];

  return {
    inputs,
    contextDictionary: dictionary,
    mergedTextLower,
    mergedBlockedPatterns: mergedBlocked,
    effectiveAllowedPatterns: overrides.effectiveAllowedPatterns ?? null,
  };
}
