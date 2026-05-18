import { describe, expect, it } from "vitest";
import { resolveBaseBranch } from "../../src/resolve-base-branch.ts";
import { minimalDictionary } from "../fixtures/workflow-fixtures.ts";

describe("resolveBaseBranch", () => {
  const dict = minimalDictionary();

  it("URL 정확 일치 시 해당 baseBranch 선택", () => {
    const r = resolveBaseBranch({
      environment_url: "https://agent.example",
      branchRoutes: dict.branchRoutes,
    });
    expect(r.selectedBaseBranch).toBe("main");
    expect(r.matchedBranchRoute?.baseBranch).toBe("main");
  });

  it("URL 미매칭 후 environment 이름으로 매칭", () => {
    const r = resolveBaseBranch({
      environment_url: "https://other",
      environment_name: "staging",
      branchRoutes: dict.branchRoutes,
    });
    expect(r.selectedBaseBranch).toBe("develop");
    expect(r.matchedBranchRoute?.match.environmentName).toBe("staging");
  });

  it("매칭 없으면 main", () => {
    expect(
      resolveBaseBranch({
        environment_url: "https://unknown",
        environment_name: "prod",
        branchRoutes: [],
      }).selectedBaseBranch,
    ).toBe("main");
  });
});
