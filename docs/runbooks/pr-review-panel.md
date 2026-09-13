# Runbook: AI PR-Review Panel — Kiro cells

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Overview
Covers the non-transient ways the Kiro half of the lens×model review panel
(`scripts/pr-review/run-panel.sh`, `.github/workflows/pr-review.yml`) stops
contributing, and what to do about each. Each is surfaced by a banner at the top of
the PR review comment and an `::error::` line in the Actions log. The existing
coverage gate (`coverage-severe.flag`) forces `VERDICT: FAIL` whenever neither Kiro
model has any successful cell, so a dead Kiro half blocks the PR until fixed.

Signatures are interpreted only in **Kiro** stderr. Codex also echoes the reviewed
diff to stderr, so a diff that quotes a Kiro error string must not discard a valid
Codex review or suppress its retry.

The first stderr line of the panel step is `run-panel.sh: kiro-cli X.Y.Z`. All
behaviour below was verified against kiro-cli 2.11.1; when the runner image moves,
compare that line first.

## When to Use
- The review comment carries the `🚫 Kiro 월간 요청 한도 소진` banner, or the log shows
  `[quota] kiro-…` lines and `::error::Kiro monthly request quota exhausted`.
- The `⚠️ 커버리지 저하` banner names both `kiro-opus` and `kiro-gpt` with no clearer
  cause, and you need to distinguish quota from a flag/version regression.
- You are changing how Kiro cells are invoked (tool trust, engine, agent) and need
  the constraints that apply to this repo.

## Prerequisites
- Read access to the failed `AI Code Review` workflow run.
- For the quota fix: access to the Kiro account that owns `KIRO_API_KEY` and/or to
  Secrets Manager `/demo-platform/actions/AI-key` (AWS-Demo-Platform repo,
  ExternalSecret `ai-panel-keys`). Never print the key.

## Procedure

### 1. Symptom — `🚫 Kiro 월간 요청 한도 소진` (monthly quota)
Log: `::error::Kiro monthly request quota exhausted for KIRO_API_KEY — … The limits
reset on MM/DD`. Every Kiro cell is skipped without retry (`[quota] kiro-…`); only
`codex/L2..L5` respond and the gate is forced to FAIL.

Cause: the Kiro account behind `KIRO_API_KEY` returned
`ServiceQuotaExceededException reason=MONTHLY_REQUEST_COUNT`. On the v2 engine (the
one this panel uses) kiro-cli prints `Monthly request limit reached` / `The limits
reset on MM/DD` to stderr and exits **0 with empty stdout**, which the old retry loop
could not tell apart from an empty response. The key is shared by every repo whose
PR review runs on the `actions-runner-claude` image, so one busy month across all of
them exhausts it for all of them. It is not a headless-flag or auth problem; `--v3`
hits the same quota.

Fix (account-side only — nothing in this repo can lift it):
1. Enable overages on the Kiro account that owns the key, **or** issue a key from an
   account with remaining quota and update `KIRO_API_KEY` in
   `/demo-platform/actions/AI-key` (ESO refreshes the runner secret; new runner pods
   pick it up).
2. Re-run the failed `AI Code Review` workflow (or push to the PR). The banner
   disappears when Kiro cells respond again.
3. If nothing is done, the quota resets on the date printed in the banner.

Verify locally without spending CI minutes (never echo the key; export it inside a
subshell rather than placing it in `env … KEY=value` argv, which any same-host user can
read from `/proc/<pid>/cmdline`):
```bash
d=$(mktemp -d); ( cd "$d" \
  && export KIRO_API_KEY="$(aws secretsmanager get-secret-value --secret-id /demo-platform/actions/AI-key \
       --region ap-northeast-2 --query SecretString --output text | jq -r .KIRO_API_KEY)" \
  && HOME="$d" kiro-cli chat "Reply PONG." --model gpt-5.6-terra --no-interactive --wrap never )
# exhausted → stderr "Monthly request limit reached", empty stdout, exit 0
```

### 2. Symptom — both Kiro models degraded, no quota banner
Read the `--- [kiro-…] skipped; stderr` blocks at the end of the panel step (scrubbed
last 25 lines). Typical causes: model ID not provisioned for the account, expired
key (auth error), or a kiro-cli release that changed a flag. Check the
`run-panel.sh: kiro-cli X.Y.Z` line against 2.11.1 and re-verify the constraints in
step 3 before changing flags.

### 3. Constraints when changing Kiro invocation in this repo
This repo's Kiro cells are **tool-enabled on purpose**: the diff is passed as a file
path (`$DIFF`) and read with `read`/`fs_read` (avoids the 128 KiB `MAX_ARG_STRLEN`
argv cap that killed large diffs), and the lens prompts' BASE CONTEXT block requires
Kiro to open base-branch files before flagging a symbol as missing. Keep in mind:
- `--trust-tools=` with an **empty** value is silently ignored by kiro-cli 2.11.1
  (it warns `--trust-tools arg for custom tool  needs to be prepended with
  @{MCPSERVERNAME}/` and keeps the default agent's trust). It is not a no-tools
  switch. Sibling repos (aws-fsi-demo, ttobak, claude-code-usage-dashboard) moved to a
  `tools: []` agent via `--agent pr-review-notools` for that reason. This repo keeps
  an explicit, non-empty list (`--trust-tools=read,grep,fs_read`).
- Adopting the zero-tool agent here would leave every Kiro cell unable to read the
  diff, so it answers `NO_DIFF`-style text. `lib.sh::record_result` counts any
  non-empty response, so coverage would look healthy (12/12) while no Kiro review
  exists — worse than a forced FAIL, because the verdict then rests on the chair
  alone. Doing so requires changing the workflow's COMMON/BASE CONTEXT prompt and
  moving the diff to a capped argv embed in the same change — treat it as an
  ADR-level change, not a flag tweak.
- `--mode default` is a v3-only flag; do not add it. Do not switch to `--v3`: the v3
  engine ignores an agent's `tools: []` and its quota error shape differs
  (rc=1, message on stdout, JSON on stderr — both shapes are detected by
  `KIRO_QUOTA_RE`, but the panel is only validated on v2).
- If kiro-cli ever prints `Error: no agent with name X found. Falling back to user
  specified default`, it has silently substituted the default agent with rc=0. This
  repo does not pass `--agent`, so the string should never appear; if it does, treat
  the run as unverified.

## Verification
These are manual steps — `tests/run-all.sh` is not wired into any workflow
(`merge-verify.yml` and `pr-review.yml` do not run it).
- [ ] `bash tests/run-all.sh pr-review` passes — `tests/structure/test-pr-review-panel.sh`
  pins the quota signatures, the non-empty `--trust-tools` list, the absence of
  `--mode default`/`--v3`, the version log, and runs stub `kiro-cli`/`codex`
  scenarios (quota v2/v3 shapes, quota hit after tool chatter, healthy run, rc≠0
  retry and rc≠0 exhaustion, Codex quoting Kiro errors, scrubbed quota marker,
  synthesize banner).
- [ ] After an account-side fix, the next `AI Code Review` run shows
  `Panel responded (12 / 12 cells)` and no `🚫` banner.
- [ ] The panel step's first stderr line still reports kiro-cli 2.11.1 (or the new
  version has been re-verified against step 3).

## Rollback
The detection is additive: reverting `scripts/pr-review/run-panel.sh`,
`synthesize.sh`, the `scrub_secrets` boundary change in `lib.sh` **and**
`tests/structure/test-pr-review-panel.sh` (which pins the new behaviour and would
otherwise fail) restores the old retry-only behaviour (cells still die on quota, but
the banner names the wrong cause). No infrastructure or secret state is touched by
this repo.

## Notes
- The runner image and its kiro-cli version are managed in the AWS-Demo-Platform
  repository (`docker/actions-runner-claude/Dockerfile`); pinning or rebuilding that
  image is a separate change from this repository's review scripts.
- Related: AWS-Demo-Platform 저장소의 ADR-011 (`--v3` drop) and ADR-015 (kiro-glm
  roster removal) — cross-repo references, not this repo's ADR numbering.
- Last verified: 2026-09-13 (stub harness only; live kiro-cli 2.11.1 behaviour was
  verified in claude-code-usage-dashboard PR #33, not re-run here)

---

<a id="korean"></a>

# 한국어

## 개요
lens×model 리뷰 패널(`scripts/pr-review/run-panel.sh`,
`.github/workflows/pr-review.yml`)의 Kiro 절반이 non-transient 하게 죽는 경우와 각각의
대응을 다룹니다. 모두 PR 리뷰 코멘트 상단 배너와 Actions 로그의 `::error::` 줄로
드러납니다. 기존 커버리지 게이트(`coverage-severe.flag`)는 두 Kiro 모델 모두 성공 셀이
없으면 `VERDICT: FAIL` 을 강제하므로, Kiro 절반이 죽으면 해결 전까지 PR 이 차단됩니다.

시그니처는 **Kiro** stderr 에서만 해석합니다. Codex 는 리뷰 대상 diff 를 stderr 에도
그대로 출력하므로, diff 가 Kiro 오류 문구를 인용하더라도 정상 Codex 리뷰가 폐기되거나
재시도가 막히면 안 됩니다.

패널 스텝의 첫 stderr 줄은 `run-panel.sh: kiro-cli X.Y.Z` 입니다. 아래 동작은 모두
kiro-cli 2.11.1 기준으로 검증됐으니 러너 이미지가 바뀌면 이 줄부터 비교하세요.

## 사용 시점
- 리뷰 코멘트에 `🚫 Kiro 월간 요청 한도 소진` 배너가 있거나, 로그에 `[quota] kiro-…` 와
  `::error::Kiro monthly request quota exhausted` 가 보일 때.
- `⚠️ 커버리지 저하` 배너에 `kiro-opus`·`kiro-gpt` 가 모두 있고 원인이 불분명해 한도 소진과
  플래그/버전 회귀를 구분해야 할 때.
- Kiro 셀 호출 방식(툴 신뢰, 엔진, 에이전트)을 바꾸려 하며 이 repo 의 제약을 알아야 할 때.

## 사전 요구 사항
- 실패한 `AI Code Review` 워크플로 실행에 대한 읽기 권한.
- 한도 해소 시: `KIRO_API_KEY` 를 소유한 Kiro 계정 및/또는 Secrets Manager
  `/demo-platform/actions/AI-key`(AWS-Demo-Platform 저장소, ExternalSecret
  `ai-panel-keys`) 접근 권한. 키 값은 절대 출력하지 않습니다.

## 절차

### 1. 증상 — `🚫 Kiro 월간 요청 한도 소진`
로그: `::error::Kiro monthly request quota exhausted for KIRO_API_KEY — … The limits
reset on MM/DD`. 모든 Kiro 셀이 재시도 없이 건너뛰어지고(`[quota] kiro-…`) `codex/L2..L5`
만 응답하며 게이트는 FAIL 로 강제됩니다.

원인: `KIRO_API_KEY` 뒤의 Kiro 계정이 `ServiceQuotaExceededException
reason=MONTHLY_REQUEST_COUNT` 를 반환. v2 엔진(이 패널이 쓰는 엔진)에서 kiro-cli 는
`Monthly request limit reached` / `The limits reset on MM/DD` 를 stderr 에 찍고
**rc=0 + 빈 stdout** 으로 끝나, 옛 재시도 루프는 이를 빈 응답과 구분하지 못했습니다. 이
키는 `actions-runner-claude` 이미지로 PR 리뷰를 돌리는 모든 repo 가 공유하므로, 한 달에
어느 repo 든 많이 쓰면 전부 소진됩니다. headless 플래그나 인증 문제가 아니며 `--v3` 도
같은 한도에 걸립니다.

해결(계정 측에서만 가능 — 이 repo 에서 풀 수 있는 것은 없음):
1. 키를 소유한 Kiro 계정에서 overage 를 활성화하거나, **또는** 한도가 남은 계정의 키를
   발급해 `/demo-platform/actions/AI-key` 의 `KIRO_API_KEY` 를 교체(ESO 가 러너 시크릿을
   갱신하고 새 러너 파드가 반영).
2. 실패한 `AI Code Review` 워크플로를 재실행(또는 PR 에 push). Kiro 셀이 다시 응답하면
   배너가 사라집니다.
3. 아무 조치도 없으면 배너에 찍힌 날짜에 한도가 리셋됩니다.

CI 분을 쓰지 않고 로컬에서 확인(키를 절대 echo 하지 않을 것; `env … KEY=value` argv 에
넣으면 같은 호스트의 다른 사용자가 `/proc/<pid>/cmdline` 으로 읽을 수 있으니 서브셸에서
`export` 로 넘긴다):
```bash
d=$(mktemp -d); ( cd "$d" \
  && export KIRO_API_KEY="$(aws secretsmanager get-secret-value --secret-id /demo-platform/actions/AI-key \
       --region ap-northeast-2 --query SecretString --output text | jq -r .KIRO_API_KEY)" \
  && HOME="$d" kiro-cli chat "Reply PONG." --model gpt-5.6-terra --no-interactive --wrap never )
# 소진 시 → stderr "Monthly request limit reached", 빈 stdout, exit 0
```

### 2. 증상 — Kiro 두 모델 모두 degraded, 한도 배너 없음
패널 스텝 끝의 `--- [kiro-…] skipped; stderr` 블록(스크럽된 마지막 25줄)을 읽습니다.
전형적 원인: 계정에 프로비저닝되지 않은 모델 ID, 만료된 키(인증 오류), 플래그가 바뀐
kiro-cli 릴리스. `run-panel.sh: kiro-cli X.Y.Z` 줄을 2.11.1 과 비교하고 플래그를 바꾸기 전에
3번의 제약을 다시 확인하세요.

### 3. 이 repo 에서 Kiro 호출을 바꿀 때의 제약
이 repo 의 Kiro 셀은 **의도적으로 툴을 가집니다**: diff 는 파일 경로(`$DIFF`)로 넘겨
`read`/`fs_read` 로 읽게 하고(대형 diff 를 죽이던 128 KiB `MAX_ARG_STRLEN` argv 한도 회피),
lens 프롬프트의 BASE CONTEXT 블록은 심볼 "없음"을 지적하기 전에 base 브랜치 파일을 열어
확인하도록 요구합니다. 유의사항:
- **빈 값**의 `--trust-tools=` 는 kiro-cli 2.11.1 이 조용히 무시합니다(`--trust-tools arg
  for custom tool  needs to be prepended with @{MCPSERVERNAME}/` 경고만 찍고 기본
  에이전트의 신뢰를 유지). 무툴 스위치가 아닙니다. 시블링 repo(aws-fsi-demo, ttobak,
  claude-code-usage-dashboard)는 그래서 `tools: []` 에이전트(`--agent pr-review-notools`)로
  옮겼습니다. 이 repo 는 명시적·비어있지 않은 목록(`--trust-tools=read,grep,fs_read`)을
  유지합니다.
- 여기서 무툴 에이전트를 채택하면 모든 Kiro 셀이 diff 를 읽지 못해 `NO_DIFF` 류 텍스트로
  답합니다. `lib.sh::record_result` 는 비어있지 않은 응답을 모두 집계하므로 커버리지는
  정상(12/12)으로 보이면서 실제 Kiro 리뷰는 없는 상태가 됩니다 — 판정이 체어 혼자에게
  걸리므로 강제 FAIL 보다 위험합니다. 채택하려면 워크플로의 COMMON/BASE CONTEXT 프롬프트
  변경과 diff 의 캡 적용 argv 임베드 전환을 같은 변경에서 해야 합니다 — 플래그 조정이 아닌
  ADR 수준 변경으로 다룰 것.
- `--mode default` 는 v3 전용 플래그이므로 추가하지 마세요. `--v3` 로 바꾸지 마세요: v3
  엔진은 에이전트의 `tools: []` 를 무시하고 한도 오류 형태도 다릅니다(rc=1, 메시지는
  stdout, JSON 은 stderr — 두 형태 모두 `KIRO_QUOTA_RE` 가 잡지만 패널은 v2 에서만 검증됨).
- kiro-cli 가 `Error: no agent with name X found. Falling back to user specified default`
  를 찍으면 rc=0 으로 기본 에이전트를 조용히 대체한 것입니다. 이 repo 는 `--agent` 를 넘기지
  않으므로 이 문구가 나올 일이 없어야 하며, 나온다면 그 실행은 검증되지 않은 것으로 취급합니다.

## 검증
수동 절차입니다 — `tests/run-all.sh` 는 어떤 워크플로에도 연결돼 있지 않습니다
(`merge-verify.yml`·`pr-review.yml` 모두 실행하지 않음).
- [ ] `bash tests/run-all.sh pr-review` 통과 — `tests/structure/test-pr-review-panel.sh` 가
  한도 시그니처, 비어있지 않은 `--trust-tools` 목록, `--mode default`/`--v3` 부재, 버전
  로그를 핀하고 스텁 `kiro-cli`/`codex` 시나리오(한도 v2/v3 형태, 툴 chatter 뒤 한도, 정상
  실행, rc≠0 재시도와 rc≠0 소진, Codex 의 Kiro 오류 인용, 스크럽된 한도 마커, synthesize
  배너)를 실행합니다.
- [ ] 계정 측 조치 후 다음 `AI Code Review` 실행에서 `Panel responded (12 / 12 cells)` 와
  `🚫` 배너 부재를 확인합니다.
- [ ] 패널 스텝 첫 stderr 줄이 여전히 kiro-cli 2.11.1 을 보고하는지(또는 새 버전을 3번 기준으로
  재검증했는지) 확인합니다.

## 롤백
감지 로직은 additive 입니다: `scripts/pr-review/run-panel.sh`, `synthesize.sh`, `lib.sh` 의
`scrub_secrets` 경계 변경, **그리고** 새 동작을 핀하는(되돌리지 않으면 실패하는)
`tests/structure/test-pr-review-panel.sh` 를 함께 되돌리면 옛 재시도 전용 동작으로
복귀합니다(한도 소진 시 셀은 여전히 죽지만 배너가 원인을 잘못 말함). 이 repo 는 인프라나
시크릿 상태를 건드리지 않습니다.

## 참고
- 러너 이미지와 kiro-cli 버전은 AWS-Demo-Platform 저장소
  (`docker/actions-runner-claude/Dockerfile`)에서 관리합니다; 이미지 핀/리빌드는 이 repo 의
  리뷰 스크립트와 별개의 변경입니다.
- 관련: AWS-Demo-Platform 저장소의 ADR-011(`--v3` 드롭), ADR-015(kiro-glm 로스터 제외) —
  이 repo 의 ADR 번호가 아닌 cross-repo 참조입니다.
- 최종 검증일: 2026-09-13 (스텁 하네스만; 실제 kiro-cli 2.11.1 동작은
  claude-code-usage-dashboard PR #33 에서 검증, 여기서 재실행하지 않음)
