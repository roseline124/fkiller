import { describe, expect, it } from "vitest";
import { matchesAnyGlob } from "../../scripts/slack-auto-fix/glob-utils.ts";
import { parseGlobPatternsJson } from "../../scripts/slack-auto-fix/parse-patterns-json.ts";

describe("glob-utils", () => {
  it("**/auth/** 는 auth 경로를 차단", () => {
    expect(matchesAnyGlob("src/features/auth/signIn.ts", ["**/auth/**"])).toBe(true);
    expect(matchesAnyGlob("packages/ui/Button.tsx", ["**/auth/**"])).toBe(false);
  });
});

describe("parseGlobPatternsJson", () => {
  it("빈 문자열은 빈 배열", () => {
    expect(parseGlobPatternsJson("", "x")).toEqual([]);
  });

  it("JSON 배열 파싱", () => {
    expect(parseGlobPatternsJson(' ["apps/**", "libs/** "] ', "a")).toEqual(["apps/**", "libs/**"]);
  });
});
