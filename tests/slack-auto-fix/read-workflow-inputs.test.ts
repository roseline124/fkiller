import { afterEach, describe, expect, it } from "vitest";
import { readWorkflowInputsFromEnv } from "../../scripts/slack-auto-fix/read-workflow-inputs.ts";

describe("readWorkflowInputsFromEnv", () => {
  const OLD = process.env;

  afterEach(() => {
    process.env = { ...OLD };
  });

  it("LANGUAGE 비어 있으면 기본 ko", () => {
    process.env = { ...OLD, INPUT_LANGUAGE: "", INPUT_TITLE: "t", INPUT_ERROR_SUMMARY: "e" };
    expect(readWorkflowInputsFromEnv().language).toBe("ko");
  });

  it("LANGUAGE 허용 문자만 남기고 정규화", () => {
    process.env = {
      ...OLD,
      INPUT_LANGUAGE: " ja-JP ",
      INPUT_TITLE: "t",
      INPUT_ERROR_SUMMARY: "e",
    };
    expect(readWorkflowInputsFromEnv().language).toBe("ja-JP");
  });
});
