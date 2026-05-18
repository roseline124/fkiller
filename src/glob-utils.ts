import pm from "picomatch";

const pmOpts = { dot: true, posix: true } as const;

export function posixPath(rel: string): string {
  return rel.replace(/\\/g, "/");
}

export function matchesGlob(filePathRel: string, pattern: string): boolean {
  return pm(pattern, pmOpts)(posixPath(filePathRel));
}

/** Matches any supplied glob pattern. */
export function matchesAnyGlob(relPath: string, patterns: readonly string[]): boolean {
  const p = posixPath(relPath);
  return patterns.some((pat) => pm(pat, pmOpts)(p));
}
