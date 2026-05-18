# fkiller

Slack 등에서 넘어온 버그 리포트를 받아 **AI가 unified diff만 생성**하고, 검증 후 브랜치에 적용·커밋·**PR까지 여는** 재사용 **GitHub Action**(`action.yml`)입니다. Node 20 JavaScript Action으로, 실행 시 **`GITHUB_WORKSPACE`(소비 레포 루트)** 만 수정합니다. 셸 명령 실행은 하지 않으며, 자동 머지는 하지 않습니다.

## 다른 레포에서 쓰기

소비 레포에는 **워크플로 YAML**과 (선택) **`.github/slack-auto-fix/context-dictionary.json`** 만 두면 됩니다. 스크립트 복사나 `picomatch`/`tsx` 설치는 필요 없습니다.

### 1. GitHub Actions 워크플로 예시

`OWNER/REPO` 와 버전 태그(`v1` 등)는 실제 배포에 맞게 바꿉니다.

```yaml
name: Slack bug auto-fix (AI PR)

permissions:
  contents: write
  pull-requests: write

on:
  workflow_dispatch:
    inputs:
      title:
        description: 버그 제목
        required: true
      error_summary:
        description: 에러 요약 또는 스택
        required: true
      reproduction_steps:
        required: false
      expected_behavior:
        required: false
      environment_url:
        required: false
      environment_name:
        required: false
      allowed_file_patterns:
        required: false
      blocked_file_patterns:
        required: false

jobs:
  auto_fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: true

      - uses: OWNER/slack-auto-fix-action@v1
        with:
          title: ${{ github.event.inputs.title }}
          error_summary: ${{ github.event.inputs.error_summary }}
          reproduction_steps: ${{ github.event.inputs.reproduction_steps }}
          expected_behavior: ${{ github.event.inputs.expected_behavior }}
          environment_url: ${{ github.event.inputs.environment_url }}
          environment_name: ${{ github.event.inputs.environment_name }}
          allowed_file_patterns: ${{ github.event.inputs.allowed_file_patterns }}
          blocked_file_patterns: ${{ github.event.inputs.blocked_file_patterns }}
          context_dictionary_path: .github/slack-auto-fix/context-dictionary.json
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ github.token }}
```

#### 액션 입력 (`uses: …` 의 `with`)

| `with` 키                 | 필수 | 설명                                                                                         |
| ------------------------- | :--: | -------------------------------------------------------------------------------------------- |
| `title`                   |  ✅  | 커밋·PR 제목에 쓰는 버그 제목                                                                |
| `error_summary`           |  ✅  | 에러 요약 또는 스택 트레이스                                                                 |
| `github_token`            |  ✅  | `git push`·`gh pr create`용 토큰. 보통 `${{ github.token }}`                                 |
| `reproduction_steps`      |      | 재현 단계                                                                                    |
| `expected_behavior`       |      | 기대 동작                                                                                    |
| `environment_url`         |      | 배포 URL — 컨텍스트 딕셔너리로 베이스 브랜치 라우팅                                          |
| `environment_name`        |      | 환경 이름 — 동일 목적                                                                        |
| `allowed_file_patterns`   |      | 허용 glob의 JSON 배열 문자열. 비어 있으면 allow-list 없음 (기본 `[]`)                        |
| `blocked_file_patterns`   |      | 기본 차단 목록에 **추가**하는 glob JSON 배열 (기본 `[]`)                                     |
| `max_changed_files`       |      | 패치가 수정할 수 있는 최대 파일 수 (기본 `5`)                                                |
| `context_dictionary_path` |      | 소비 레포 루트 기준 라우팅 JSON 경로 (기본 `.github/slack-auto-fix/context-dictionary.json`) |
| `context_dictionary_json` |      | 인라인 라우팅 JSON. 비어 있지 않으면 **파일보다 우선**                                       |
| `openai_api_key`          |  △   | OpenAI 키. `anthropic_api_key` 와 **둘 중 하나는 필수**                                      |
| `anthropic_api_key`       |  △   | Anthropic 키. **둘 다 있으면 Anthropic 우선**                                                |
| `request_id`              |      | 외부 요청 ID 등 리포트 메타 (예: Supabase row id)                                            |
| `repo`                    |      | 리포 식별자 메타                                                                             |
| `slack_channel_id`        |      | Slack 채널 ID 메타                                                                           |
| `slack_thread_ts`         |      | Slack 스레드 ts 메타                                                                         |
| `language`                |      | 생성 패치 내 **새** 인라인 주석용 BCP47 태그 (비우면 기본 `ko`)                              |
| `max_context_files`       |      | 모델에 넘길 후보 파일 수 상한 `5`–`20` (기본 `12`)                                           |

△ = OpenAI·Anthropic 중 하나만 있으면 됨.

#### Secrets 및 토큰

| 이름                               | 필수 | 설명                                                                                                                                                      |
| ---------------------------------- | :--: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                   |  △   | OpenAI API 키. **Organization/Repo Secrets**에 등록 후 `secrets.OPENAI_API_KEY` 로 전달                                                                   |
| `ANTHROPIC_API_KEY`                |  △   | Anthropic API 키. 동일하게 `secrets.ANTHROPIC_API_KEY`                                                                                                    |
| `github.token` (기본 GITHUB_TOKEN) |  ✅  | 워크플로에 자동 부여. `pull-requests: write`, `contents: write` 가 있어야 push·PR 생성 가능. 정책상 부족하면 PAT를 시크릿으로 두고 `github_token` 에 넣음 |

시크릿은 소비 레포 **Settings → Secrets and variables → Actions** 에서 등록합니다.

- **`fetch-depth: 0`** 은 액션 내부 `git fetch` / 베이스 브랜치 checkout 에 필요합니다.
- **`outputs.pull_request_url`**: 워크플로에서 `${{ steps.fix.outputs.pull_request_url }}` 형태로 쓰려면 위 액션 스텝에 `id: fix` 를 달면 됩니다.
- 인라인 라우팅이 필요하면 `context_dictionary_json` 을 넘기면 되고, **우선순위는** `context_dictionary_json` → `context_dictionary_path` 파일 → 빈 dictionary입니다.

### 2. Context routing 파일 (선택)

기본 경로: `.github/slack-auto-fix/context-dictionary.json`  
예시는 이 레포의 [examples/context-dictionary.example.json](./examples/context-dictionary.example.json) 을 참고하면 됩니다.

### 3. 배포 산출물

액션 진입점은 루트 `action.yml` 의 `runs.main: dist/index.js` 입니다. `dist/index.js` 는 **번들 결과물로 커밋**하는 것을 전제로 합니다. 루트 `package.json` 이 `"type": "module"` 이라도 **`dist/package.json`** 에 `"type": "commonjs"` 를 두어 번들이 CJS로 실행됩니다.

---

## 이 레포에서 개발하기

```bash
pnpm install
pnpm run build    # dist/index.js 갱신
pnpm test
pnpm test:e2e
pnpm slack-auto-fix   # 로컬: INPUT_GITHUB_TOKEN 등 환경변수 필요
```

자세한 동작·디버깅: [docs/slack-auto-fix.md](./docs/slack-auto-fix.md)
