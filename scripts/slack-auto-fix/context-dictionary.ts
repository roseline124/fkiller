import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BranchRouteMatch, ContextDictionary } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_JSON_PATH = resolve(__dirname, "context-dictionary.json");
const CONTEXT_EXAMPLE_PATH = resolve(__dirname, "context-dictionary.example.json");

export function normalizeDictionary(raw: unknown): ContextDictionary {
  if (!raw || typeof raw !== "object") {
    return emptyDictionary();
  }
  const branchRoutesRaw: unknown[] = Array.isArray((raw as { branchRoutes?: unknown }).branchRoutes)
    ? ((raw as { branchRoutes?: unknown }).branchRoutes as unknown[])
    : [];

  const keywordRoutesRaw: unknown[] = Array.isArray((raw as { keywordRoutes?: unknown }).keywordRoutes)
    ? ((raw as { keywordRoutes?: unknown }).keywordRoutes as unknown[])
    : [];

  return {
    branchRoutes: branchRoutesRaw
      .map((route) =>
        typeof route === "object" &&
        route !== null &&
        typeof (route as { baseBranch?: unknown }).baseBranch === "string"
          ? {
              match:
                (((route as { match?: BranchRouteMatch }).match ?? {}) as BranchRouteMatch),
              baseBranch: (route as { baseBranch: string }).baseBranch,
            }
          : null,
      )
      .filter((x): x is NonNullable<typeof x> => x !== null),
    keywordRoutes: keywordRoutesRaw
      .map((kr) =>
        typeof kr === "object" && kr !== null && Array.isArray((kr as { keywords?: unknown }).keywords)
          ? {
              keywords: (kr as { keywords: unknown[] }).keywords
                .map((x) => (typeof x === "string" ? x : ""))
                .filter(Boolean),
              symbols:
                typeof (kr as { symbols?: unknown }).symbols !== "undefined" &&
                Array.isArray((kr as { symbols?: unknown }).symbols)
                  ? ((kr as { symbols: unknown[] }).symbols as unknown[])
                      .map((s) => (typeof s === "string" ? s : ""))
                      .filter(Boolean)
                  : undefined,
              paths:
                typeof (kr as { paths?: unknown }).paths !== "undefined" &&
                Array.isArray((kr as { paths?: unknown }).paths)
                  ? ((kr as { paths: unknown[] }).paths as unknown[])
                      .map((p) => (typeof p === "string" ? p : ""))
                      .filter(Boolean)
                  : undefined,
            }
          : null,
      )
      .filter((x): x is NonNullable<typeof x> => x !== null),
  };
}

function emptyDictionary(): ContextDictionary {
  return { branchRoutes: [], keywordRoutes: [] };
}

export async function loadContextDictionary(workflowInlineJson?: string): Promise<ContextDictionary> {
  const inline = (workflowInlineJson ?? "").trim();
  if (inline.length > 0) {
    try {
      return normalizeDictionary(JSON.parse(inline) as unknown);
    } catch (e) {
      throw new Error(`context_dictionary input is invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    const json = JSON.parse(await readFile(CONTEXT_JSON_PATH, "utf8")) as unknown;
    return normalizeDictionary(json);
  } catch {
    // fallback
  }

  try {
    const example = JSON.parse(await readFile(CONTEXT_EXAMPLE_PATH, "utf8")) as unknown;
    return normalizeDictionary(example);
  } catch {
    return emptyDictionary();
  }
}
