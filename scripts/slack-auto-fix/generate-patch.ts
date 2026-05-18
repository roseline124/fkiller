import type { BugReportNormalized, ResolvedBaseBranch, KeywordRoute } from "./types.ts";

export type CandidateFilePrompt = {
  path: string;
  score: number;
  rationale: readonly string[];
  snippet: string;
};

export async function generateUnifiedDiffViaAi(opts: {
  bug: BugReportNormalized;
  base: ResolvedBaseBranch;
  matchedKeywordRoutes: KeywordRoute[];
  candidates: CandidateFilePrompt[];
}): Promise<string> {
  const apiKeyAnthropic = process.env.ANTHROPIC_API_KEY;
  const apiKeyOpenAI = process.env.OPENAI_API_KEY;
  const useAnthropic = Boolean(apiKeyAnthropic);
  if (!useAnthropic && !apiKeyOpenAI) {
    throw new Error("Missing OPENAI_API_KEY or ANTHROPIC_API_KEY in environment.");
  }

  const language = (opts.bug.inputs.language ?? "ko").trim() || "ko";

  const systemPrompt = [
    "You are an automated codebase repair assistant running in CI.",
    "Return ONLY valid unified diff text (git-compatible) that modifies existing tracked files.",
    "No markdown fences, no prose, no shell commands.",
    `Touch at most ${opts.bug.inputs.max_patch_files} files.`,
    "Do NOT create brand new paths (avoid `--- /dev/null`).",
    "Only change files permitted by blocked/allowed rules provided.",
    `If you add any NEW inline comments inside the edited code, write them using language/locale tag "${language}". Do not translate existing comments unnecessarily.`,
  ].join(" ");

  const userText = stringifyPayload(buildEnvelope(opts));

  if (useAnthropic) return callAnthropic(apiKeyAnthropic!, systemPrompt, userText);
  return callOpenAI(apiKeyOpenAI!, systemPrompt, userText);
}

function buildEnvelope(opts: {
  bug: BugReportNormalized;
  base: ResolvedBaseBranch;
  matchedKeywordRoutes: KeywordRoute[];
  candidates: CandidateFilePrompt[];
}) {
  return {
    task: {
      title: opts.bug.inputs.title,
      error_summary: opts.bug.inputs.error_summary,
      reproduction_steps: opts.bug.inputs.reproduction_steps,
      expected_behavior: opts.bug.inputs.expected_behavior,
    },
    slack_meta: {
      request_id: opts.bug.inputs.request_id,
      channel_id: opts.bug.inputs.slack_channel_id,
      thread_ts: opts.bug.inputs.slack_thread_ts,
      repo: opts.bug.inputs.repo,
      environment_url: opts.bug.inputs.environment_url,
      environment_name: opts.bug.inputs.environment_name,
      language: opts.bug.inputs.language,
    },
    routing: {
      selectedBaseBranch: opts.base.selectedBaseBranch,
      matchedBranchRoute: opts.base.matchedBranchRoute,
      matchedKeywordRoutes: opts.matchedKeywordRoutes.map((kr) => ({
        keywords: kr.keywords,
        symbols: kr.symbols ?? [],
        paths: kr.paths ?? [],
      })),
      candidateSelections: opts.candidates.map((c) => ({
        path: c.path,
        score: c.score,
        reasons: [...c.rationale],
        excerpt: redactPotentialSecrets(truncateSnippet(c.snippet)),
      })),
    },
    policy: {
      blocked_file_patterns: opts.bug.mergedBlockedPatterns,
      allowed_file_patterns: opts.bug.effectiveAllowedPatterns ?? [],
      max_patch_files: opts.bug.inputs.max_patch_files,
    },
    directives: [
      "Under the routing candidate list and globs ONLY, propose the smallest corrective diff.",
      "Prefer targeted logic fixes over sweeping refactors.",
    ],
  };
}

function stringifyPayload(payload: unknown): string {
  return redactPotentialSecrets(JSON.stringify(limitPayload(payload), null, 2));
}

function limitPayload(payload: unknown, depth = 0): unknown {
  if (typeof payload === "string") return redactPotentialSecrets(payload).slice(0, depth > 4 ? 4_096 : 200_000);
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.slice(0, 64).map((v) => limitPayload(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>).slice(0, 160)) {
    out[k] = limitPayload(v, depth + 1);
  }
  return out;
}

async function callOpenAI(apiKey: string, system: string, userText: string): Promise<string> {
  const model = process.env.SLACK_AUTO_FIX_OPENAI_MODEL ?? "gpt-4o-mini";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: truncate(userText, 200_000) },
      ],
    }),
  });
  const bodyText = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${truncate(redactPotentialSecrets(bodyText))}`);
  const json = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("OpenAI returned empty assistant message.");
  return text;
}

async function callAnthropic(apiKey: string, system: string, userText: string): Promise<string> {
  const model =
    process.env.SLACK_AUTO_FIX_ANTHROPIC_MODEL ??
    process.env.CLAUDE_MODEL ??
    "claude-3-5-haiku-20241022";
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: truncate(userText, 200_000) }],
    }),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}: ${truncate(redactPotentialSecrets(raw))}`);
  const json = JSON.parse(raw) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  let out = "";
  for (const block of json.content ?? []) if (block.type === "text" && block.text) out += block.text;
  out = out.trim();
  if (!out) throw new Error("Anthropic returned empty assistant payload.");
  return out;
}

function truncateSnippet(snippet: string, maxChars = 24_000): string {
  if (snippet.length <= maxChars) return snippet;
  return `${snippet.slice(0, Math.floor(maxChars * 0.62))}\n\n/* --- truncated excerpt --- */\n\n${snippet.slice(-Math.floor(maxChars * 0.34))}`;
}

export function truncate(t: string, max = 4_096): string {
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\u2026`;
}

export function redactPotentialSecrets(input: string): string {
  return input
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[^\s]+\b/gi, "[REDACTED]")
    .replace(/\bghp_[^\s]+\b/g, "[REDACTED]")
    .replace(/\bAIza[^\s]+\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "Bearer [REDACTED]")
    .replace(/\b(openai|anthropic)[-_]?api[-_]?key\s*[=:]\s*\S+/gi, "$1-api-key=[REDACTED]");
}
