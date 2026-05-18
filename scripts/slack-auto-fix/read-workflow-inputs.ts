import { parseGlobPatternsJson } from "./parse-patterns-json.ts";
import type { WorkflowInputs } from "./types.ts";

function sanitizeInt(raw: string, fallback: number, min: number, max: number, label: string): number {
  const t = raw.trim();
  if (!t.length) return fallback;
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be an integer`);
  }
  if (n < min || n > max) {
    throw new Error(`${label} must be between ${min} and ${max} inclusive`);
  }
  return n;
}

/** Reads INPUT_* forwarded from GitHub Actions (non-secret fields only). */
export function readWorkflowInputsFromEnv(environ = process.env): WorkflowInputs {
  const raw = (k: string): string => {
    const v = environ[`INPUT_${k}`];
    return typeof v === "string" ? v.trim() : "";
  };

  const allowed_patterns = raw("ALLOWED_FILE_PATTERNS");
  const blocked_patterns = raw("BLOCKED_FILE_PATTERNS");

  return {
    request_id: raw("REQUEST_ID"),
    repo: raw("REPO"),
    slack_channel_id: raw("SLACK_CHANNEL_ID"),
    slack_thread_ts: raw("SLACK_THREAD_TS"),
    title: raw("TITLE"),
    error_summary: raw("ERROR_SUMMARY"),
    reproduction_steps: raw("REPRODUCTION_STEPS"),
    expected_behavior: raw("EXPECTED_BEHAVIOR"),
    allowed_file_patterns: parseGlobPatternsJson(allowed_patterns, "allowed_file_patterns"),
    blocked_file_patterns: parseGlobPatternsJson(blocked_patterns, "blocked_file_patterns"),
    environment_url: raw("ENVIRONMENT_URL"),
    environment_name: raw("ENVIRONMENT_NAME"),
    context_dictionary_raw: raw("CONTEXT_DICTIONARY"),
    max_context_files: sanitizeInt(
      raw("MAX_CONTEXT_FILES"),
      12,
      5,
      20,
      "max_context_files",
    ),
    max_patch_files: sanitizeInt(
      raw("MAX_PATCH_FILES"),
      5,
      1,
      20,
      "max_patch_files",
    ),
  };
}
