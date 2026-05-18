import { describe, expect, it } from "vitest";
import { normalizeDictionary } from "../../src/context-dictionary.ts";

describe("normalizeDictionary", () => {
  it("유효한 branchRoutes/keywordRoutes 정규화", () => {
    const dict = normalizeDictionary({
      branchRoutes: [
        { match: { environmentUrl: "https://a" }, baseBranch: "b1" },
        { match: {}, baseBranch: "skip-no-url-or-name-route" },
      ],
      keywordRoutes: [{ keywords: ["x"], symbols: ["S"], paths: ["p/**"] }],
    });
    expect(dict.branchRoutes).toHaveLength(2);
    expect(dict.keywordRoutes[0]!.symbols).toEqual(["S"]);
  });

  it("무효/비객체 입력은 빈 딕셔너리", () => {
    expect(normalizeDictionary(null).branchRoutes).toEqual([]);
    expect(normalizeDictionary(undefined).keywordRoutes).toEqual([]);
  });
});
