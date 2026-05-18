import { describe, expect, it } from "vitest";
import { matchKeywordRoutesFromText } from "../../src/retrieve-context.ts";
import { minimalDictionary } from "../fixtures/workflow-fixtures.ts";

describe("matchKeywordRoutesFromText", () => {
  it("합본 소문자 텍스트에 키워드 포함 시 라우트 매칭", () => {
    const kw = minimalDictionary().keywordRoutes;
    const merged = matchKeywordRoutesFromText("템플릿 페이지 keyvalue 실패".toLowerCase(), kw);
    expect(merged.length).toBeGreaterThanOrEqual(1);
    expect(merged[0]!.keywords).toContain("keyvalue");
  });
});
