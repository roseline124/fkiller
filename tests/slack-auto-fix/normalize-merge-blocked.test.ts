import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCKED_GLOBS, normalizeBugReport } from "../../scripts/slack-auto-fix/normalize.ts";
import { baseWorkflowInputs, minimalDictionary } from "../fixtures/workflow-fixtures.ts";

describe("normalizeBugReport", () => {
  it("blocked 패턴 기본 목록과 입력 병합", () => {
    const inputs = baseWorkflowInputs({
      blocked_file_patterns: ["**/internal/**"],
    });
    const dict = minimalDictionary();
    const bug = normalizeBugReport(inputs, dict);

    expect(bug.mergedBlockedPatterns).toContain("**/payment/**");
    expect(bug.mergedBlockedPatterns).toContain("**/internal/**");

    /** 중복 무관 — 기본 패턴 존재만 확인 */
    expect(DEFAULT_BLOCKED_GLOBS.every((p) => bug.mergedBlockedPatterns.includes(p))).toBe(true);
  });

  it("language 필드가 입력에 포함됨", () => {
    const inputs = baseWorkflowInputs({ language: "en-US" });
    expect(normalizeBugReport(inputs, minimalDictionary()).inputs.language).toBe("en-US");
  });
});
