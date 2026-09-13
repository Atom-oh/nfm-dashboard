#!/bin/bash
# scripts/pr-review/run-panel.sh 의 Kiro 셀 fail-closed 계약을 핀한다.
# Sourced by tests/run-all.sh from the project root.
#
# (1) Kiro 월간 요청 한도(MONTHLY_REQUEST_COUNT) 소진은 kiro-cli 2.11.1 v2 엔진에서 rc=0 + 빈
#     stdout + stderr 메시지로 끝나 "빈 응답"과 구분이 안 되고, 옛 로직은 재시도만 태웠다 —
#     stderr 시그니처 감지가 있어야 원인이 코멘트/로그에 드러난다.
# (2) 이 repo 의 Kiro 셀은 시블링 repo 들과 달리 *툴을 가진다*(diff 파일 + BASE 체크아웃을
#     읽어야 하는 설계). 시블링에서 "무툴"로 쓰던 `--trust-tools=`(빈 값)은 kiro-cli 가
#     무시하므로, 여기서는 명시적 툴 이름 목록만 허용하고 빈 값·`--mode default`(v3 전용)·
#     `--v3` 가 슬쩍 들어오는 회귀를 막는다.
PANEL="scripts/pr-review/run-panel.sh"
SYNTH="scripts/pr-review/synthesize.sh"

assert_bash_syntax "run-panel.sh valid bash" "$PANEL"
assert_bash_syntax "synthesize.sh valid bash" "$SYNTH"
assert_bash_syntax "lib.sh valid bash" "scripts/pr-review/lib.sh"

PANEL_SRC=$(grep -v '^\s*#' "$PANEL")
SYNTH_SRC=$(grep -v '^\s*#' "$SYNTH")
assert_grep_match "run-panel.sh keeps an explicit (non-empty) --trust-tools list for Kiro" \
    '\-{2}trust-tools=read,grep,fs_read' "$PANEL_SRC"
assert_grep_no_match "run-panel.sh never uses empty --trust-tools= (ignored by kiro-cli 2.11.1)" \
    '\-{2}trust-tools=(\s|$|")' "$PANEL_SRC"
assert_grep_no_match "run-panel.sh does not pass the v3-only --mode default flag" \
    '\-{2}mode default' "$PANEL_SRC"
assert_grep_no_match "run-panel.sh does not use the --v3 engine" \
    'kiro-cli -{2}v3|-{2}agent-engine' "$PANEL_SRC"
assert_grep_match "run-panel.sh logs kiro-cli --version first" \
    'kiro-cli -{2}version' "$PANEL_SRC"

assert_grep_match "run-panel.sh detects the Kiro monthly quota signature (v2 stderr)" \
    'Monthly request limit reached' "$PANEL_SRC"
assert_grep_match "run-panel.sh detects the Kiro monthly quota signature (v3/JSON)" \
    'MONTHLY_REQUEST_COUNT' "$PANEL_SRC"
assert_grep_match "run-panel.sh resets kiro-quota.flag at start" \
    'rm -f .*kiro-quota\.flag' "$PANEL_SRC"
assert_grep_match "run-panel.sh writes kiro-quota.flag for synthesize.sh" \
    'kiro-quota\.flag' "$PANEL_SRC"
assert_grep_match "synthesize.sh renders the Kiro quota banner" \
    'kiro-quota\.flag' "$SYNTH_SRC"
assert_file_exists "runbook for the panel failure modes exists" "docs/runbooks/pr-review-panel.md"

# 동작 테스트: kiro-cli 스텁이 2.11.1 v2 엔진의 한도 소진 시그니처(rc=0, 빈 stdout, stderr
# 메시지)를 재현하면 재시도 없이 즉시 중단하고 quota 플래그를 남겨야 한다.
if command -v timeout >/dev/null 2>&1; then
    T_STUB=$(mktemp -d)
    cat > "$T_STUB/kiro-cli" <<'EOF'
#!/bin/bash
[ "${1:-}" = "--version" ] && { echo "kiro-cli test"; exit 0; }
printf 'Monthly request limit reached\nThe limits reset on 10/01.\n' >&2
exit 0
EOF
    cat > "$T_STUB/codex" <<'EOF'
#!/bin/bash
cat > /dev/null; echo "no findings"
EOF
    chmod +x "$T_STUB/kiro-cli" "$T_STUB/codex"
    mkdir -p "$T_STUB/lenses" && echo "lens" > "$T_STUB/lenses/L2.txt"
    printf 'diff --git a/x b/x\n+x\n' > "$T_STUB/diff.txt"
    PANEL_OUT=$(PATH="$T_STUB:$PATH" PANEL_TIMEOUT=30 PANEL_RETRIES=3 \
        bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true)
    assert_grep_match "kiro-cli version is the first stderr line" '^run-panel.sh: kiro-cli test' "$(echo "$PANEL_OUT" | head -1)"
    assert_grep_no_match "quota exhaustion is not retried" '\[retry ' "$PANEL_OUT"
    assert_grep_match "quota exhaustion is logged per cell" '\[quota\] kiro-opus-L2' "$PANEL_OUT"
    assert_grep_match "quota exhaustion is reported as ::error:: with the reset date" \
        '::error::Kiro monthly request quota exhausted.*reset on 10/01' "$PANEL_OUT"
    assert_file_exists "quota exhaustion leaves kiro-quota.flag" "$T_STUB/work/kiro-quota.flag"
    assert_file_exists "quota exhaustion still forces coverage-severe (fail-closed kept)" "$T_STUB/work/coverage-severe.flag"
    QUOTA_MARKERS_LEFT=$(find "$T_STUB/work/slot" -name '*.quota' | wc -l | tr -d ' ')
    assert_eq "quota markers are consumed into the flag" "0" "$QUOTA_MARKERS_LEFT"

    # `--v3` 엔진 형태(rc=1, 메시지는 stdout, JSON 은 stderr) 도 stderr 만으로 잡혀야 한다.
    cat > "$T_STUB/kiro-cli" <<'EOF2'
#!/bin/bash
[ "${1:-}" = "--version" ] && { echo "kiro-cli test"; exit 0; }
echo "You've reached your monthly usage limit."
echo '[ERROR] [KRS] HTTP 400 body={"__type":"...ServiceQuotaExceededException","reason":"MONTHLY_REQUEST_COUNT"}' >&2
exit 1
EOF2
    PANEL_OUT=$(PATH="$T_STUB:$PATH" PANEL_TIMEOUT=30 PANEL_RETRIES=3 \
        bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true)
    assert_grep_no_match "v3-style quota error is not retried" '\[retry ' "$PANEL_OUT"
    assert_grep_match "v3-style quota error is reported" '::error::Kiro monthly request quota exhausted' "$PANEL_OUT"
    KIRO_SLOT_BYTES=$(cat "$T_STUB"/work/slot/kiro-*.md 2>/dev/null | wc -c | tr -d ' ')
    assert_eq "v3-style quota stdout message is not counted as a response" "0" "$KIRO_SLOT_BYTES"

    # 정상 응답 경로: 아무 플래그도 남지 않아야 한다(감지 로직의 오탐 가드). 이전 실행의
    # quota 플래그가 리셋되는지도 함께 확인(같은 $WORK 재사용).
    cat > "$T_STUB/kiro-cli" <<'EOF2'
#!/bin/bash
[ "${1:-}" = "--version" ] && { echo "kiro-cli test"; exit 0; }
echo "> no findings"
EOF2
    PANEL_OUT=$(PATH="$T_STUB:$PATH" PANEL_TIMEOUT=30 PANEL_RETRIES=3 \
        bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true)
    assert_grep_match "healthy kiro cells are counted" 'Panel responded \(3 / 3 cells\)' "$PANEL_OUT"
    # run-all.sh 는 set -euo pipefail 로 source 하므로 매치 없는 ls 가 스위트를 죽인다 — find 로 센다.
    HEALTHY_FLAGS=$(find "$T_STUB/work" -maxdepth 1 -name '*.flag' | wc -l | tr -d ' ')
    assert_eq "healthy run leaves no flags (stale quota flag reset)" "0" "$HEALTHY_FLAGS"

    # rc≠0 이지만 stdout 이 있는 부분 응답(timeout 에 잘린 스트림 등)은 성공으로 세지 않고
    # 재시도해야 한다 — 옛 로직은 non-empty 슬롯만 보고 성공 처리했다.
    cat > "$T_STUB/kiro-cli" <<'EOF2'
#!/bin/bash
[ "${1:-}" = "--version" ] && { echo "kiro-cli test"; exit 0; }
printf 'attempt\n' >> "$0.attempts"
if [ "$(wc -l < "$0.attempts")" -le 2 ]; then
    echo "> partial"; exit 124
fi
echo "> no findings"
EOF2
    PANEL_OUT=$(PATH="$T_STUB:$PATH" PANEL_TIMEOUT=30 PANEL_RETRIES=3 \
        bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true)
    assert_grep_match "non-zero exit with partial stdout is retried" '\[retry 1/3\] kiro-' "$PANEL_OUT"
    assert_grep_match "retry can recover a transient Kiro failure" 'Panel responded \(3 / 3 cells\)' "$PANEL_OUT"
    rm -f "$T_STUB/kiro-cli.attempts"

    # Codex 는 입력 diff 를 stderr 에도 출력한다. Kiro 오류 문자열을 인용하는 정상 리뷰가
    # 한도 소진으로 폐기되면 안 된다(시그니처는 Kiro 프로세스에만 적용).
    cat > "$T_STUB/codex" <<'EOF2'
#!/bin/bash
cat >&2
echo "no findings"
EOF2
    cat > "$T_STUB/kiro-cli" <<'EOF2'
#!/bin/bash
[ "${1:-}" = "--version" ] && { echo "kiro-cli test"; exit 0; }
echo "> no findings"
EOF2
    printf 'diff --git a/x b/x\n+Monthly request limit reached\n+MONTHLY_REQUEST_COUNT\n' > "$T_STUB/diff.txt"
    PANEL_OUT=$(PATH="$T_STUB:$PATH" PANEL_TIMEOUT=30 PANEL_RETRIES=3 \
        bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true)
    assert_grep_match "Codex quoting Kiro errors remains a successful response" \
        'Panel responded \(3 / 3 cells\)' "$PANEL_OUT"
    QUOTED_FLAGS=$(find "$T_STUB/work" -maxdepth 1 -name '*.flag' | wc -l | tr -d ' ')
    assert_eq "quoted Kiro errors in Codex stderr leave no flags" "0" "$QUOTED_FLAGS"

    cat > "$T_STUB/codex" <<'EOF2'
#!/bin/bash
cat >/dev/null
printf 'attempt\n' >> "$0.attempts"
if [ "$(wc -l < "$0.attempts")" -eq 1 ]; then
    echo "Reviewed code quotes: Monthly request limit reached" >&2
    exit 1
fi
echo "no findings"
EOF2
    PANEL_OUT=$(PATH="$T_STUB:$PATH" PANEL_TIMEOUT=30 PANEL_RETRIES=3 \
        bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true)
    CODEX_ATTEMPTS=$(wc -l < "$T_STUB/codex.attempts" | tr -d ' ')
    assert_eq "Codex retries its own transient failure despite a quoted Kiro quota" "2" "$CODEX_ATTEMPTS"
    assert_grep_match "Codex retry can restore full coverage" 'Panel responded \(3 / 3 cells\)' "$PANEL_OUT"
    RETRY_FLAGS=$(find "$T_STUB/work" -maxdepth 1 -name '*.flag' | wc -l | tr -d ' ')
    assert_eq "a recovered Codex retry leaves no Kiro failure flags" "0" "$RETRY_FLAGS"

    # synthesize.sh 배너: kiro-quota.flag 가 있으면 리뷰 상단에 원인 배너가 붙고, severe 플래그로
    # VERDICT 가 강제 FAIL 된다. 체어(claude)는 스텁으로 대체.
    cat > "$T_STUB/claude" <<'EOF2'
#!/bin/bash
cat > /dev/null
printf 'ok review\n\nVERDICT: PASS\n'
EOF2
    chmod +x "$T_STUB/claude"
    mkdir -p "$T_STUB/swork/slot"
    echo "codex/L2" > "$T_STUB/swork/responded.txt"
    printf 'kiro-opus\nkiro-gpt\n' > "$T_STUB/swork/degraded-models.txt"
    : > "$T_STUB/swork/degraded-lenses.txt"
    : > "$T_STUB/swork/coverage-severe.flag"
    echo "Monthly request limit reached The limits reset on 10/01." > "$T_STUB/swork/kiro-quota.flag"
    echo "no findings" > "$T_STUB/swork/slot/codex-L2.md"
    SYNTH_OUT=$(PATH="$T_STUB:$PATH" CHAIR_TIMEOUT=30 \
        bash "$SYNTH" "$T_STUB/diff.txt" "$T_STUB/swork" 1 "t" "$T_STUB/review.md" 2>&1 || true)
    REVIEW=$(cat "$T_STUB/review.md" 2>/dev/null || true)
    assert_grep_match "synthesize.sh prepends the quota banner" 'Kiro 월간 요청 한도 소진.*reset on 10/01' "$REVIEW"
    assert_grep_match "synthesize.sh quota banner points at the runbook" 'docs/runbooks/pr-review-panel.md' "$REVIEW"
    assert_eq "quota + coverage-severe still forces VERDICT: FAIL" "VERDICT: FAIL" "$(awk 'NF{last=$0} END{print last}' "$T_STUB/review.md")"
    rm -f "$T_STUB/swork/kiro-quota.flag"
    SYNTH_OUT=$(PATH="$T_STUB:$PATH" CHAIR_TIMEOUT=30 \
        bash "$SYNTH" "$T_STUB/diff.txt" "$T_STUB/swork" 1 "t" "$T_STUB/review.md" 2>&1 || true)
    assert_grep_no_match "no quota banner without kiro-quota.flag" 'Kiro 월간 요청 한도 소진' "$(cat "$T_STUB/review.md" 2>/dev/null || true)"
    rm -rf "$T_STUB"
else
    skip "run-panel.sh quota stub behaviour" "timeout(1) not available"
fi
