import { describe, expect, it } from "vitest";
import {
  extractHasNewFiles,
  extractPositivePaths,
  stripDiffFences,
  validatePatchAgainstPolicy,
} from "../../scripts/slack-auto-fix/apply-patch.ts";
import { minimalBug } from "../fixtures/workflow-fixtures.ts";

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,1 @@
-const x = 1
+const x = 2
`;

describe("apply-patch helpers", () => {
  it("stripDiffFences 는 펜스 제거", () => {
    const raw = "```diff\n" + SAMPLE_DIFF.trim() + "\n```";
    expect(stripDiffFences(raw).includes("diff --git")).toBe(true);
    expect(stripDiffFences(raw).startsWith("```")).toBe(false);
  });

  it("+++ b/ 경로 추출", () => {
    expect(extractPositivePaths(SAMPLE_DIFF)).toEqual(["src/foo.ts"]);
  });

  it("신규 파일 diff 감지", () => {
    const neo = `
diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,1 @@
+ok
`;
    expect(extractHasNewFiles(neo)).toBe(true);
    expect(extractHasNewFiles(SAMPLE_DIFF)).toBe(false);
  });

  it("auth 경로는 정책 위반으로 거부", () => {
    const blockedDiff = `
diff --git a/packages/auth/session.ts b/packages/auth/session.ts
index aaa..bbb 100644
--- a/packages/auth/session.ts
+++ b/packages/auth/session.ts
@@ -1,1 +1,1 @@
-const secret = false
+const secret = true
`;
    const bug = minimalBug({
      mergedBlockedPatterns: ["**/auth/**"],
    });
    const v = validatePatchAgainstPolicy(blockedDiff, bug);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("blocked"))).toBe(true);
  });
});
