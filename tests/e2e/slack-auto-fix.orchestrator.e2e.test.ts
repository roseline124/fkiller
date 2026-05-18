/**
 * 블랙박스 E2E: 임시 로컬 git 저장소(origin bare) 안에서 오케스트레이션을 subprocess 로 실행합니다.
 * AI 키를 비워 두면 패치 단계가 스킵되고 종료 코드 0(noop)·리포트 JSON 검증까지 확인합니다.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "../..");

function git(cwd: string, args: string[]) {
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasRipgrep(): boolean {
  try {
    execFileSync("rg", ["--version"], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function hasPnpm(): boolean {
  try {
    execFileSync("pnpm", ["--version"], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** bare origin + 클라이언트 클론; main 에 추적 가능한 코드 파일 1개 */
function scaffoldGitWorkspace(): string {
  const root = mkdtempSync(join(os.tmpdir(), "slack-auto-fix-e2e-"));
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(bare, { recursive: true });
  git(bare, ["init", "--bare"]);

  git(root, ["clone", bare, work]);
  const srcDir = join(work, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "OCRSampleWidget.tsx"),
    `export function OCRTemplateDetailScreen() {
  const useOcrKeyvalueStream = () => ({ data: [] });
  void useOcrKeyvalueStream;
  return <div />;
}
`,
    "utf8",
  );
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2), "utf8");

  git(work, ["config", "user.email", "e2e@example.com"]);
  git(work, ["config", "user.name", "e2e bot"]);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "init"]);
  git(work, ["branch", "-M", "main"]);
  git(work, ["push", "-u", "origin", "main"]);

  return work;
}

function runOrchestratorSubprocess(fixtureRoot: string, runId: string) {
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: fixtureRoot,
    /** 서브프로세스에서는 호스트 환경에 키가 있어도 무력화 */
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GITHUB_RUN_ID: runId,
    INPUT_REQUEST_ID: "e2e_req",
    INPUT_REPO: "fixture/repo",
    INPUT_SLACK_CHANNEL_ID: "C_DUMMY",
    INPUT_SLACK_THREAD_TS: "9999.8888",
    INPUT_TITLE: "OCRTemplateDetailScreen 레이아웃 틀어짐",
    INPUT_ERROR_SUMMARY: "키밸류 스트림 useOcrKeyvalueStream 과 OCRTemplateDetailScreen 연동 실패",
    INPUT_REPRODUCTION_STEPS: "상세 접속 후 keyvalue 활성화",
    INPUT_EXPECTED_BEHAVIOR: "스트림 노출되어야 함",
    INPUT_LANGUAGE: "ko",
    INPUT_ALLOWED_FILE_PATTERNS: "",
    INPUT_BLOCKED_FILE_PATTERNS: "",
    INPUT_ENVIRONMENT_URL: "",
    INPUT_ENVIRONMENT_NAME: "",
    INPUT_CONTEXT_DICTIONARY: '{"branchRoutes":[],"keywordRoutes":[]}',
    INPUT_MAX_CONTEXT_FILES: "12",
    INPUT_MAX_PATCH_FILES: "5",
    GIT_TERMINAL_PROMPT: "0",
  };

  execFileSync("pnpm", ["exec", "tsx", "scripts/slack-auto-fix/index.ts"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe.skipIf(!hasRipgrep() || !hasPnpm())("slack-auto-fix subprocess e2e", () => {
  test(
    "git 픽스처에서 오케스트레이션 완료·리포트·후보 포함",
    { timeout: 60_000 },
    () => {
      const rootWithWork = scaffoldGitWorkspace();
      const stagingRoot = join(rootWithWork, "..");
      const runId = `e2e-${process.pid}-${Date.now()}`;
      try {
        runOrchestratorSubprocess(rootWithWork, runId);

        const reportPath = join(rootWithWork, "slack-auto-fix-report.json");
        const raw = JSON.parse(readFileSync(reportPath, "utf8")) as {
          status: string;
          routing?: { candidate_paths?: string[]; selected_base_branch?: string };
          slack?: { language?: string };
        };

        expect(raw.status).toBe("noop");
        expect(raw.routing?.selected_base_branch).toBe("main");

        /** rg 가 심볼 문자열 후보를 채워야 통과 */
        expect(raw.routing?.candidate_paths ?? []).toContain("src/OCRSampleWidget.tsx");
        expect(raw.slack?.language).toBe("ko");
      } finally {
        rmSync(stagingRoot, { recursive: true, force: true });
      }
    },
  );
});
