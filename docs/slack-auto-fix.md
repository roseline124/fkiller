# Slack 버그 리포트 → AI 자동 수정 PR (slack-auto-fix)

GitHub Actions `workflow_dispatch`로 버그 리포트(제목·에러·재현 단계 등)를 받아, **Context Routing**으로 기준 브랜치와 후보 코드를 고른 뒤, OpenAI 또는 Anthropic API로 **unified diff만** 생성·검증·적용하고, 린트/테스트를 돌린 뒤 변경이 있으면 PR을 생성합니다. **자동 머지는 하지 않습니다.**

---

## 아키텍처

```
Supabase Edge Function / 내부 서비스
        │  GitHub API: POST .../actions/workflows/.../dispatches
        ▼
GitHub Actions (ubuntu, checkout fetch-depth 0)
        │  GITHUB_WORKSPACE = 소비 레포 루트
        ▼
재사용 Action: dist/index.js (Node 20)
  1) action 입력 + github_token / API 키 → 환경변수
  2) context-dictionary: context_dictionary_json > 파일(context_dictionary_path) > 빈 객체
  3) 정규화 + 차단 glob 병합
  4) resolve-base-branch.ts → PR base 브랜치
  5) git fetch/checkout → fix/slack-${{ github.run_id }} 생성
  6) retrieve-context.ts + score-candidates.ts → 상위 후보 파일
  7) generate-patch.ts (fetch만 사용, 공식 SDK 없음) → diff
  8) git apply --check / git apply (diff 외 명령·AI 명령 미실행)
  9) package.json 에 lint/test 있으면 해당 PM으로 실행 (실패해도 PR 시도 가능)
 10) 변경 있으면 commit → push → gh pr create (--base 선택된 base)
 11) slack-auto-fix-report.json + outputs.pull_request_url + Job summary(실패 시)
```

외부 명령은 **고정 허용 목록** 안에서만 사용합니다(`git` 하위 명령, `rg`/`git grep`, `pnpm`/`npm`/`yarn` 스크립트, `gh` PR 생성 등). AI 출력에서 추출한 셸 명령은 **실행하지 않습니다**.

---

## Context Routing

### `context_dictionary_json` / `context_dictionary_path` (action 입력)

| 필드 | 설명 |
|------|------|
| `branchRoutes[]` | `match.environmentUrl` 정확 일치 → 해당 `baseBranch`. 없으면 `match.environmentName` 일치 순. 매칭 없으면 **`main`**. |
| `keywordRoutes[]` | Slack 합본 텍스트 소문자에 `keywords[]` 하나라도 포함되면 해당 라우트 매칭. `symbols[]`로 ripgrep, `paths[]`로 glob 매칭 파일에 가점. |

우선순위:

1. **`context_dictionary_json`** (비어 있지 않으면 이 JSON만 사용, 잘못된 JSON이면 실패)
2. 소비 레포 루트 기준 **`context_dictionary_path`** 파일(기본 `.github/slack-auto-fix/context-dictionary.json`). 없으면 빈 설정
3. 빈 객체

예시 파일: [`examples/context-dictionary.example.json`](../examples/context-dictionary.example.json).

### 운영자가 사전에 갱신하는 방법

- 소비 레포의 `.github/slack-auto-fix/context-dictionary.json` 을 PR로 관리합니다.
- 일회성 실험이면 액션 입력 `context_dictionary_json` 에 전체 JSON을 넣습니다.

### 브랜치 매핑 예시

- `environment_url` = `https://agent.koreadeep.com` → `branchRoutes` 에서 `environmentUrl` 이 동일하면 `main`.
- `environment_name` = `staging` → `environmentName`: `staging` 인 항목이 있으면 `develop` 등 정의된 `baseBranch`.

### 키워드 → 심볼/경로 부스팅 예시

이슈: “템플릿 상세페이지에서 keyvalue 추출이 안돼요”

- 예시 라우트에 `keywords` 로 `템플릿 상세페이지`, `keyvalue` 등이 있으면 매칭.
- `symbols` 에 `OCRTemplateDetailScreen`, `useOcrKeyvalueStream` 이 있으면 추가 검색.
- `paths` 의 glob 에 걸린 추적 파일에 가점.

---

## `language` 입력

워크플로 `language`(선택)는 **BCP47 스타일** 태그입니다(예: `ko`, `en`, `ja-JP`). 비어 두면 스크립트 기본값 **`ko`** 입니다.

- **AI 패치**: diff 에 **새로 추가하는 인라인 주석**만 이 locale 에 맞추도록 시스템 프롬프트에 포함합니다(PR 본문 구조 문구는 기본 한국어 섹션을 유지합니다).
- **메타데이터**: `slack-auto-fix-report.json` 의 `slack.language` 및 PR 본문 «Slack 요약» 에 표시됩니다.

---

## workflow_dispatch 호출 예시

`ref` 는 **워크플로 파일을 읽어올 기본 ref**입니다. 실제 수정·PR 베이스는 Context Routing 결과(`selected_base_branch`)를 따릅니다.

전체 입력 예시 페이로드:

```json
{
  "ref": "main",
  "inputs": {
    "request_id": "req_123",
    "environment_url": "https://agent.koreadeep.com",
    "language": "ko",
    "title": "템플릿 상세페이지 keyvalue 추출 실패",
    "error_summary": "템플릿 상세페이지에서 keyvalue 추출이 안돼요",
    "reproduction_steps": "템플릿 상세페이지 접속 후 keyvalue 추출 실행",
    "expected_behavior": "keyvalue OCR 결과가 정상적으로 스트리밍되어야 함",
    "context_dictionary_json": "{\"branchRoutes\":[{\"match\":{\"environmentUrl\":\"https://agent.koreadeep.com\"},\"baseBranch\":\"main\"}],\"keywordRoutes\":[{\"keywords\":[\"템플릿 상세페이지\",\"keyvalue\"],\"symbols\":[\"OCRTemplateDetailScreen\",\"useOcrKeyvalueStream\"],\"paths\":[\"apps/**/src/**/OCRTemplateDetailScreen*\",\"apps/**/src/**/*ocr*template*\"]}]}"
  }
}
```

### GitHub CLI 예시

```bash
gh workflow run slack-auto-fix.yml \
  --ref main \
  -f request_id=req_123 \
  -f title='제목' \
  -f error_summary='요약'
```

REST API는 [`Create a workflow dispatch event`](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) 를 참고합니다.

---

## 필요한 Secrets

| Secret | 필요 여부 |
|--------|-----------|
| `OPENAI_API_KEY` 또는 `ANTHROPIC_API_KEY` | 둘 중 **하나** (둘 다 있으면 **Anthropic 우선**) |
| (기본) `GITHUB_TOKEN` | 워크플로에 자동 제공. PR/push 에 `permissions` 필요 |

조직 정책 등으로 기본 토큰으로 PR 생성이 막히면, 별도 PAT 를 `GH_TOKEN` 등으로 두고 `permissions` 에 맞는 스코프를 부여해야 합니다. **시크릿 값은 로그·리포트에 넣지 않도록** 코드에서 마스킹합니다.

환경변수로 모델을 바꿀 수 있습니다.

- `SLACK_AUTO_FIX_OPENAI_MODEL` (기본 `gpt-4o-mini`)
- `SLACK_AUTO_FIX_ANTHROPIC_MODEL` 또는 `CLAUDE_MODEL` (기본 `claude-3-5-haiku-20241022`)

---

## Slack / Supabase 연결 방식

1. Supabase Edge Function(또는 백엔드)에서 `fix_requests` row를 받은 뒤 GitHub REST API 로 위 워크플로를 디스패치합니다.
2. 워크플로 종료 후:
   - 아티팩트 `slack-auto-fix-report-${{ github.run_id }}` 에 `slack-auto-fix-report.json` 이 올라갑니다.
   - 또는 같은 run 의 Job 로그/`GITHUB_OUTPUT`(재구성 필요)으로 상태를 파싱할 수 있습니다.
3. 향후: Edge Function이 이 JSON 을 읽어 Slack 스레드에 회신하고, Supabase 에 `fix_requests.status` 를 갱신합니다. **현재 본 레포에서는 Slack 회신 코드를 넣지 않았습니다.**

---

## 운영 시 주의사항

- **diff만 적용**: AI 가 제안한 셸 명령은 실행하지 않습니다.
- **수정 허용 범위**: 기본 차단 glob + 사용자 `blocked_file_patterns`, 선택적 `allowed_file_patterns` 교집합. 패치 헤더 경로도 다시 검사합니다.
- **신규 파일 생성**: 패치에 `--- /dev/null` 기반 새 파일이 있으면 정책상 거부합니다.
- **비용**: 후보 파일·스니펫 길이에 따라 토큰 사용량이 큽니다. `max_context_files`(기본 12), `max_changed_files`(기본 5)로 조절하세요.
- **기준 브랜치 존재**: `fetch-depth: 0` 로 받아 `origin/<base>` 가 있어야 합니다.

---

## 실패 케이스

| 상황 | 동작 요약 |
|------|-----------|
| 후보 파일 0건 또는 API 키 없음 | AI 스킵, `status` 는 주로 `noop`, PR 없음 |
| AI 가 diff 형식 아님 / 정책 위반 경로 | `git apply` 전 단계에서 거부, PR 없음 |
| `git apply --check` 실패 | 패치 적용 안 함 |
| 린트/테스트 실패 | **패치가 적용·커밋된 경우** PR 은 만들 수 있음. 본문에 실패 로그 요약 포함 |
| `gh pr create` 실패 | 리포트·로그에 남김, 커밋은 이미 로컬/푸시 상태에 따라 다름 |

---

## 향후 개선

- 코드베이스 **AST 인덱스**로 후보 검색 정확도 향상
- **임베딩 인덱스**로 장문 이슈·로그 매칭
- Supabase 상태 필드 업데이트 + **Slack 스레드 회신**

---

## 로컬 실행 (디버깅)

### 단위 테스트

```bash
pnpm test
```

통과하면 Vitest 가 파일별 결과를 터미널에 출력합니다. 수정 중 검증에는 `pnpm test:watch`.

### E2E (서브프로세스)

로컬에 **pnpm**, **git**, **`rg`(ripgrep)** 필요. 미설치 시 해당 스위트는 `describe.skipIf` 로 스킵됩니다.

```bash
pnpm test:e2e
```

[`tests/e2e/slack-auto-fix.orchestrator.e2e.test.ts`](../tests/e2e/slack-auto-fix.orchestrator.e2e.test.ts): bare 원격 + 워킹 트리를 만들고 `GITHUB_WORKSPACE` 를 그 클론으로 둔 뒤 **`node dist/index.js`** 를 실행합니다.
서브프로세스에서는 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 를 비워 **패치 미적용 noop** 과 `slack-auto-fix-report.json`·후보 경로 검증까지 확인합니다.

### Slack 자동 수정 (로컬)

```bash
export INPUT_GITHUB_TOKEN='ghs_...'   # 또는 더미 (일부 경로만)
export INPUT_TITLE='예시'
export INPUT_ERROR_SUMMARY='예시 버그'
export INPUT_LANGUAGE='ko'
# 필요 시 기타 INPUT_* (actions 입력 이름 대문자화 규칙과 동일)
pnpm run slack-auto-fix
```

리포트는 워크스페이스 루트에 `slack-auto-fix-report.json` 으로 기록됩니다.
