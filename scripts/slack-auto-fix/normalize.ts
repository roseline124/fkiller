import type {
  BugReportNormalized,
  ContextDictionary,
  WorkflowInputs,
} from "./types.ts";

export const DEFAULT_BLOCKED_GLOBS: readonly string[] = [
  "**/auth/**",
  "**/payment/**",
  "**/migration/**",
  "**/.env*",
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/coverage/**",
];

export function normalizeBugReport(
  inputs: WorkflowInputs,
  contextDictionary: ContextDictionary,
): BugReportNormalized {
  const allowed = inputs.allowed_file_patterns.length > 0 ? inputs.allowed_file_patterns : null;
  const mergedBlocked = [...DEFAULT_BLOCKED_GLOBS, ...inputs.blocked_file_patterns];

  const mergedText = [
    inputs.title,
    inputs.error_summary,
    inputs.reproduction_steps,
    inputs.expected_behavior,
  ]
    .map((x) => x.trim())
    .filter(Boolean)
    .join("\n");

  return {
    inputs,
    mergedBlockedPatterns: mergedBlocked,
    effectiveAllowedPatterns: allowed,
    mergedTextLower: mergedText.toLowerCase(),
    contextDictionary,
  };
}
