# MiniCode

[English](README.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

MiniCode는 여러분의 저장소 안에서 직접 작동하도록 설계된 코딩 에이전트입니다. 실패하는 테스트 수정, 모듈 리팩토링, 버그 원인 추적 같은 소프트웨어 작업을 MiniCode에 맡기면, 코드를 살펴보고 변경을 가하고, 명령을 실행하며, 결과를 스스로 검증합니다. 이 모든 과정은 터미널에서 실시간으로 확인할 수 있고, 언제든 방향을 지시할 수 있습니다.

MiniCode는 의도적으로 집중도를 높였습니다. 범용 AI 어시스턴트가 아니라, 소프트웨어 엔지니어링 작업을 실제로 수행하기 위한 도구입니다.

## 무엇을 할 수 있나요?

MiniCode에 작업을 맡기면 다음이 가능합니다.

- 낯선 저장소 탐색 — 파일과 코드 목록 조회, 검색, 내용 확인
- 줄 번호와 페이징이 있는 파일 읽기, diff로 검토 가능한 안전한 편집
- 새 파일 생성과 셸 명령 실행 (테스트, 빌드, git 등 무엇이든)
- 실패하는 테스트와 깨진 빌드에 대응 — 실패는 정보이며, MiniCode는 수복과 재검증을 반복합니다
- 작업이 끝나거나 도움이 필요해질 때까지 독자적으로 여러 번의 이터레이션을 진행
- 진행 중인 모든 작업을 터미널에 실시간으로 표시

전형적인 작업 흐름은 다음과 같습니다.

```text
당신:  이 저장소에서 실패하는 테스트를 수정해 줘.

MiniCode:
  ▸ read src/math.ts
  ✓ read src/math.ts
  ▸ bash bun test math.test.ts
  ✓ bash bun test math.test.ts      ← 실패를 확인
  ▸ edit src/math.ts                ← 코드를 수복
  ✓ edit src/math.ts
  ▸ bash bun test math.test.ts
  ✓ bash bun test math.test.ts      ← 검증: 모든 테스트 통과

  add() 함수를 수정했습니다... 모든 테스트가 통과했습니다.
```

주도권은 항상 사용자에게 있습니다. 언제든 중단할 수 있고, 작업 중에 메시지를 입력해 에이전트의 방향을 바꿀 수도 있습니다.

## 왜 MiniCode인가?

코딩 에이전트는 코드를 한 줄 바꾸기도 전에 탐색과 실행 — 파일 읽기, 검색, 재독립, 재시도 — 에 많은 노력을 소모합니다. MiniCode는 이 루프가 잘 작동하도록 만들어졌습니다.

- 에이전트는 저장소의 "설명"이 아니라 실제 저장소 상태를 대상으로 반복 작업을 수행합니다
- 코딩 루프는 보이고 조종할 수 있습니다 — 에이전트가 하는 일을 보고, 작업 중에도 방향을 바꿀 수 있습니다
- 검증은 워크플로의 일부입니다. 성공을 주장하는 대신 테스트를 실행해 변경을 증명해야 합니다
- 컨텍스트는 의도적으로 관리되어, 긴 세션도 조용히 넘쳐흐르지 않고 요약됩니다

MiniCode는 소프트웨어 개발에 집중합니다. 범용 AI 어시스턴트가 되려 하지 않습니다.

## 빠른 시작

설치 방법은 두 가지이며, 어느 쪽이든 동일한 에이전트가 실행됩니다.

### 독립 실행 바이너리 (Linux x86_64)

[릴리스 페이지](https://github.com/oliverxu1996/minicode/releases)에서 `minicode-linux-x64`를 내려받습니다:

```sh
chmod +x minicode-linux-x64
cd ~/my-project
/path/to/minicode-linux-x64
```

이 바이너리는 자체 완결형이라 Bun이나 Node를 설치할 필요가 없습니다. 현재 사전 빌드된 바이너리를 제공하는 플랫폼은 Linux x86_64뿐입니다.

### npm

**전제 조건:** [Bun](https://bun.sh)이 설치되어 PATH에서 사용 가능해야 합니다.

```sh
npm install -g @minicode/cli
cd ~/my-project
minicode
```

첫 실행 시 모델이 설정되어 있지 않으면 `/model`로 설정한 후 작업을 입력합니다.

### 소스에서 실행

MiniCode 자체를 개발하려면 체크아웃에서 실행합니다:

```sh
git clone https://github.com/oliverxu1996/minicode.git
cd minicode
bun install

# 프로젝트에서 MiniCode 시작
bun ./packages/cli/src/main.ts /path/to/your/project
```

첫 실행 시에는 설정된 모델이 없습니다. `/model`로 설정하세요 — 프로토콜(`openai` 또는 `anthropic`), 엔드포인트, 프로바이더 모델 이름, API 키를 차례로 물어봅니다. 컨텍스트 창과 최대 출력 토큰에는 적절한 기본값이 적용되며, 필요할 때만 선택적인 "Configure limits…" 단계에서 변경할 수 있습니다. 설정은 로컬에 저장되며, 이후 `/model`이나 Ctrl+P로 모델을 전환할 수 있습니다.

이제 작업을 입력하고 Enter를 누르면 에이전트가 움직이기 시작합니다.

## 모델 설정

MiniCode는 두 가지 프로토콜을 지원합니다. 공식 API와 호환 가능한 모든 엔드포인트에서 동작합니다.

| 프로토콜 | 주요 용도 |
| --- | --- |
| `anthropic` | Anthropic API 및 Anthropic 프로토콜 호환 엔드포인트 |
| `openai` | OpenAI API 및 OpenAI 프로토콜 호환 엔드포인트 |

모델 관련 명령:

| 명령 | 용도 |
| --- | --- |
| `/model` | 사용할 모델 선택, 또는 `Configure models…`에서 추가·편집·제거 |
| `/model add` | 새 모델 설정(프로토콜, 엔드포인트, 모델, API 키, 상한은 선택) |
| `/model edit <id>` | 설정된 모델 편집 |
| `/model remove <id>` | 설정된 모델 제거 |
| Ctrl+P | 설정된 모델 순환 전환 |

설정은 로컬 설정 디렉터리에 저장됩니다
(`~/.minicode/models.json`). 이 파일을 직접 편집할 수도 있습니다.

## 에이전트와 함께 작업하기

작업이 실행되는 동안 모든 것이 보입니다. 현재 이터레이션, 출력 미리보기가 있는 각 도구 호출, 스트리밍되는 어시스턴트 응답.

- **스티어(Steer)**: 작업 중에 메시지를 입력하고 Enter를 누르면 — 현재 방향을 중단하고 새 지시를 따릅니다.
- **큐(Queue)**: Alt+Enter로 후속 작업을 예약하면 현재 작업이 끝난 후 실행됩니다.
- **중단**: Esc로 실행 중인 작업을 중단할 수 있습니다. 큐에 남은 메시지는 편집기로 되돌아와 손실되지 않습니다.
- **펼치기**: Ctrl+O로 도구 출력 전체를 표시하거나 간단한 미리보기로 되돌립니다.

### 세션

작업 내용은 자동으로 저장됩니다. 종료했다가 나중에 돌아와도 — `--continue`로 워크스페이스의 최근 세션을 이어가고, `--resume <id>`로 특정 세션을 복원하고, TUI 안의 `/resume`로 목록에서 선택할 수 있습니다. 세션에는 이름을 붙이고(`/name`), 정보를 확인하고(`/session`), 이전 메시지에서 분기(`/fork`)하거나 복제(`/clone`)하고, 분기 사이를 이동(`/tree`)할 수 있습니다.

작업 중에 MiniCode가 중단되면, 다음 시작 시 중단된 작업을 자동으로 조정합니다. 완료된 단계는 유지되고, 완료되지 않은 단계는 있는 그대로 보고되며, 멈춘 지점에서 계속할 수 있습니다.

### 슬래시 명령

| 명령 | 용도 |
| --- | --- |
| `/help` | 모든 명령 나열 |
| `/compact` | 컨텍스트를 수동으로 요약 |
| `/copy` | 마지막 응답을 클립보드에 복사 |
| `/export [path]` | 세션을 JSONL로 내보내기 |
| `/import <path>` | JSONL 파일에서 세션 가져오기 |
| `/name <title>` | 현재 세션 이름 지정 |
| `/session` | 세션 정보와 통계 표시 |
| `/new` · `/resume` · `/fork` · `/clone` · `/tree` | 세션 수명 주기와 탐색 |
| `/model` | 모델 선택 및 설정 |
| `/trust` · `/reload` | 프로젝트 리소스 |
| `/hotkeys` | 모든 단축키 표시 |
| `/quit` | 종료 |

## 프로젝트 지침

MiniCode는 저장소 루트의 지시 파일을 읽어 작업 시작 전에 프로젝트의 규칙을 파악합니다.

- `AGENTS.override.md` — 있으면 최우선 적용
- `AGENTS.md`
- `CLAUDE.md`

가장 먼저 발견된 파일이 에이전트의 시스템 프롬프트에 로드되므로, 첫 메시지부터 프로젝트의 규칙을 따릅니다.

프로젝트 로컬 **프롬프트 템플릿**(`.minicode/prompts/*.md`)과 **스킬**(`.minicode/skills/<name>/SKILL.md`)을 추가할 수도 있습니다. 이 파일들은 에이전트의 동작을 이끌 수 있기 때문에, MiniCode는 프로젝트 로컬 리소스를 불러오기 전에 `/trust`로 신뢰 결정을 요청합니다. 전역 설정은 `~/.minicode/settings.json`에 있으며 프로젝트의 `.minicode/settings.json`으로 재정의할 수 있습니다.

## 스크립트와 자동화

비대화형 용도 — 스크립트, CI, 코드 리뷰 파이프라인입니다.

```sh
# 작업 하나를 실행하고 최종 응답 출력
minicode -p "이 프로젝트가 하는 일을 설명해 줘" /path/to/project

# 모든 런타임 이벤트를 JSON 라인으로 출력 (도구 연동용)
minicode --mode json -p "모든 TODO 주석을 찾아 줘" /path/to/project

# 이 워크스페이스의 최근 세션 계속하기
minicode -c -p "발견한 문제를 수정해 줘" /path/to/project
```

## 현재 상태

**상태: 초기 실험적 개발 단계.** MiniCode는 현재 활발히 개발 중입니다. 현재 버전은 v0.1.0입니다. 포함된 내용은 [CHANGELOG.md](CHANGELOG.md)에서 확인하세요.

## 라이선스

Apache License 2.0 — [LICENSE](LICENSE)를 참고하세요.
