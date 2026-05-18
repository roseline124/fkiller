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

function sanitizeLanguage(raw: string): string {
  const s = raw.trim().replace(/[^\w.-]/g, "");
  const t = s.slice(0, 40);
  return t.length > 0 ? t : "ko";
}

/** Minimal surface compatible with `@actions/core` `getInput`. */
export type CoreInputs = {
  getInput(name: string, options?: { required?: boolean }): string;
};

/** Builds a CoreInputs adapter from `INPUT_*` (Vitest / local runs). */
export function coreFromEnv(environ: NodeJS.ProcessEnv = process.env): CoreInputs {
  return {
    getInput(name: string) {
      const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
      const v = environ[key];
      return typeof v === "string" ? v : "";
    },
  };
}

export type ActionInputsBundle = {
  workflow: WorkflowInputs;
  contextDictionaryJson: string;
  contextDictionaryPath: string;
};

/** Reads reusable action inputs (`action.yml`). */
export function readActionInputs(core: CoreInputs): ActionInputsBundle {
  const allowed_patterns = core.getInput("allowed_file_patterns").trim() || "[]";
  const blocked_patterns = core.getInput("blocked_file_patterns").trim() || "[]";

  return {
    contextDictionaryJson: core.getInput("context_dictionary_json"),
    contextDictionaryPath: core.getInput("context_dictionary_path").trim() || ".github/slack-auto-fix/context-dictionary.json",
    workflow: {
      request_id: core.getInput("request_id"),
      repo: core.getInput("repo"),
      slack_channel_id: core.getInput("slack_channel_id"),
      slack_thread_ts: core.getInput("slack_thread_ts"),
      title: core.getInput("title"),
      error_summary: core.getInput("error_summary"),
      reproduction_steps: core.getInput("reproduction_steps"),
      expected_behavior: core.getInput("expected_behavior"),
      language: sanitizeLanguage(core.getInput("language")),
      allowed_file_patterns: parseGlobPatternsJson(allowed_patterns, "allowed_file_patterns"),
      blocked_file_patterns: parseGlobPatternsJson(blocked_patterns, "blocked_file_patterns"),
      environment_url: core.getInput("environment_url"),
      environment_name: core.getInput("environment_name"),
      max_context_files: sanitizeInt(
        core.getInput("max_context_files"),
        12,
        5,
        20,
        "max_context_files",
      ),
      max_patch_files: sanitizeInt(
        core.getInput("max_changed_files"),
        5,
        1,
        20,
        "max_changed_files",
      ),
    },
  };
}

/** @deprecated Prefer `readActionInputs(coreFromEnv())`; kept for older tests. */
export function readWorkflowInputsFromEnv(environ = process.env): WorkflowInputs {
  return readActionInputs(coreFromEnv(environ)).workflow;
}
