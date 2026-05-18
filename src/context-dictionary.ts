import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BranchRouteMatch, ContextDictionary } from "./types.ts";

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

export function emptyDictionary(): ContextDictionary {
  return { branchRoutes: [], keywordRoutes: [] };
}

/**
 * Priority: non-empty inline JSON → file at `fileRelativePath` under workspace → empty.
 */
export async function loadContextDictionary(
  opts: { inlineJson: string; fileRelativePath: string },
  workspaceRoot: string,
  onWarn?: (message: string) => void,
): Promise<ContextDictionary> {
  const inline = (opts.inlineJson ?? "").trim();
  if (inline.length > 0) {
    try {
      return normalizeDictionary(JSON.parse(inline) as unknown);
    } catch (e) {
      throw new Error(
        `context_dictionary_json is invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const rel = (opts.fileRelativePath ?? "").trim() || ".github/slack-auto-fix/context-dictionary.json";
  const abs = resolve(workspaceRoot, rel);

  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? (e as NodeJS.ErrnoException).code : "";
    if (code === "ENOENT") {
      onWarn?.(`context dictionary not found at ${rel}; using empty routing.`);
      return emptyDictionary();
    }
    throw e;
  }

  try {
    return normalizeDictionary(JSON.parse(text) as unknown);
  } catch (e) {
    throw new Error(
      `context dictionary file at ${rel} is invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
