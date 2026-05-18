import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyDictionary, loadContextDictionary } from "../../src/context-dictionary.ts";

describe("loadContextDictionary", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("inline JSON가 path보다 우선", async () => {
    dir = mkdtempSync(join(os.tmpdir(), "safx-ctx-"));
    writeFileSync(
      join(dir, "bad.json"),
      JSON.stringify({ branchRoutes: [{ match: {}, baseBranch: "from-file" }] }),
      "utf8",
    );
    const warn: string[] = [];
    const d = await loadContextDictionary(
      {
        inlineJson: JSON.stringify({ branchRoutes: [], keywordRoutes: [] }),
        fileRelativePath: "bad.json",
      },
      dir,
      (m) => warn.push(m),
    );
    expect(d.branchRoutes).toEqual([]);
    expect(warn).toHaveLength(0);
  });

  it("inline 비어 있으면 path 파일 사용", async () => {
    dir = mkdtempSync(join(os.tmpdir(), "safx-ctx-"));
    const rel = ".github/slack-auto-fix/context-dictionary.json";
    mkdirSync(join(dir, ".github/slack-auto-fix"), { recursive: true });
    writeFileSync(
      join(dir, rel),
      JSON.stringify({ branchRoutes: [{ match: {}, baseBranch: "develop" }], keywordRoutes: [] }),
      "utf8",
    );
    const d = await loadContextDictionary(
      { inlineJson: " ", fileRelativePath: rel },
      dir,
    );
    expect(d.branchRoutes).toHaveLength(1);
    expect(d.branchRoutes[0]!.baseBranch).toBe("develop");
  });

  it("파일 없으면 빈 dictionary + 경고", async () => {
    dir = mkdtempSync(join(os.tmpdir(), "safx-ctx-"));
    const warn: string[] = [];
    const d = await loadContextDictionary(
      { inlineJson: "", fileRelativePath: "missing.json" },
      dir,
      (m) => warn.push(m),
    );
    expect(d).toEqual(emptyDictionary());
    expect(warn.some((w) => w.includes("missing"))).toBe(true);
  });

  it("invalid inline JSON는 throw", async () => {
    dir = mkdtempSync(join(os.tmpdir(), "safx-ctx-"));
    await expect(
      loadContextDictionary({ inlineJson: "{not json", fileRelativePath: "x.json" }, dir),
    ).rejects.toThrow(/invalid JSON/);
  });
});
