# ADR-012: MCP Data-Source Egress (`/api/mcp`)

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Status

Accepted — 2026-07-29.

## Context

nfm-dashboard already consumes MCP as a client (`mcp-client.ts` → the `nfm-gateway` AgentCore gateway, SigV4/AWS_IAM, same-account only). A separate project, `awsops` — a broader cross-cloud ops dashboard in a **different AWS account** — wants nfm-dashboard's pod-to-pod flow analytics as one of its data sources, registered as a curated `mcpServer` target on its own AgentCore gateway (its ADR-017 pattern).

Two things rule out reusing the existing `nfm-gateway`:
1. It is reachable only by nfm-dashboard's own ECS task role (`bedrock-agentcore:InvokeGateway` scoped to this account's gateways) — no cross-account IAM path exists, and awsops's gateway target provisioner only implements two `mcpServer` credential modes: `none` (its own IAM role) and a single-header `api_key`. Neither can carry SigV4 for a foreign account.
2. Its 27 tools are the wrong shape for this: `network_mcp.py`'s 16 VPC/TGW/reachability tools already exist near-verbatim as an awsops Lambda (pure duplication + non-deterministic tool-name dedup on the consumer side), and `analyze_reachability` mutates (creates a Network Insights path) — awsops has a standing autonomy freeze on AWS-resource mutation.

So this is a new, narrower surface: the web app's analysis lenses (cost/latency/reliability/anomalies/alerts) plus Athena history — capability that exists *only* inside the Next.js app today, reachable by nothing outside it.

## Decision

1. **New MCP server, not a gateway target.** `app/src/lib/mcp-server.ts` implements JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`) by hand — the `@modelcontextprotocol/sdk` streamable-HTTP server transport doesn't fit a stateless Next.js route handler, and the surface needed is three cases. `app/src/app/api/mcp/route.ts` is a thin `POST` wrapper.
2. **10 tools, all thin wrappers over existing code** — `nfm_schema`, `nfm_topology`, `nfm_top_talkers`, `nfm_pod_flows`, `nfm_cost_lens`, `nfm_latency_lens`, `nfm_reliability_lens`, `nfm_anomalies`, `nfm_alerts`, `nfm_history`. Every handler calls an existing `lib/ddb.ts` read or `lib/analytics/*` lens; zero new analysis logic. All `nfm_`-prefixed (the consumer's tool-name dedup is non-deterministic on collision). All read-only.
3. **Bearer token, not SigV4.** The consumer is in a different AWS account with no assumable role into this one; a public HTTPS endpoint + a single `Authorization: Bearer` header is the only shape the consumer's gateway provisioner supports for a foreign `mcpServer` target, and it matches the consumer's `api_key` credential-provider mode (exactly one header slot). Token lives in a dedicated Secrets Manager secret (`nfm-dashboard/mcp-token`, mirroring the `origin-verify` secret's shape — stable across deploys, no synth-time randomness) and is checked in `middleware.ts` via the existing `safeEqual` constant-time compare, **before** the Cognito session gate (the consumer holds no Cognito session) but **after** origin-verify (CloudFront remains the only public entry point).
4. **Fail closed.** If `MCP_BEARER_TOKEN` is unset, `/api/mcp` returns 404 rather than falling through — an unconfigured token can never mean "no auth required."
5. **Bounded responses.** Every list-shaped result goes through `bound()` (cap default 30, `nfm_history` capped at 500 rows even though the web `/api/history` allows 5000) and reports `truncated: true` rather than silently dropping rows — the consumer is an LLM agent with a finite context window, not a paginating UI.
6. **24h cap reused, not reinvented.** `range` (minutes) clamps to the existing ADR-008 24h interactive-lens ceiling; anything longer must use `nfm_history` (the Athena archive), matching how the web app itself routes long ranges.

## Consequences

- New public (bearer-gated) surface on an app that was previously entirely behind Cognito. Mitigated by: origin-verify still required (no bypassing CloudFront), fail-closed on missing token, constant-time comparison, and the tool set is exhaustively read-only.
- The consumer's gateway caches this server's tool schema (`listingMode: DEFAULT`) — a tool rename/signature change on this side requires the consumer to re-provision (`make agentcore` in awsops) to pick it up. Not automatically synchronized.
- Token rotation is a manual two-step: rotate the Secrets Manager value + redeploy `NfmDash-App` here, then update the credential on the awsops side and re-provision there. No automated coordination between the two projects (they are separate repos/accounts by design).
- This endpoint duplicates read paths the web app's own API routes already expose (e.g. `nfm_cost_lens` ≈ `/api/analytics/cost`) under a different auth model. Accepted: the two surfaces serve different consumers (browser session vs. cross-account agent) and diverging them would be worse than the duplication.

---

<a id="korean"></a>

# 한국어

## Status

승인됨 — 2026-07-29.

## Context

nfm-dashboard는 이미 MCP 클라이언트(`mcp-client.ts` → `nfm-gateway` AgentCore 게이트웨이, SigV4/AWS_IAM, 동일 계정 전용)로 동작합니다. 별도 프로젝트인 `awsops`(다른 AWS 계정의 더 넓은 클라우드 운영 대시보드)는 nfm-dashboard의 pod-to-pod 플로우 분석을 자신의 AgentCore 게이트웨이에 curated `mcpServer` 타깃(ADR-017 패턴)으로 등록해 데이터소스로 쓰고 싶어합니다.

기존 `nfm-gateway` 재사용을 막는 두 가지 이유:
1. 이 게이트웨이는 nfm-dashboard 자신의 ECS task role만 호출 가능(`bedrock-agentcore:InvokeGateway`가 이 계정의 게이트웨이로 스코프)하고, 크로스 계정 IAM 경로가 없습니다. awsops의 게이트웨이 타깃 프로비저너도 `mcpServer` 크리덴셜 모드로 `none`(자체 IAM role)과 단일 헤더 `api_key` 두 가지만 구현하며, 어느 쪽도 타 계정 SigV4를 실어 나를 수 없습니다.
2. 27개 툴은 이 목적에 맞는 형태가 아닙니다: `network_mcp.py`의 VPC/TGW/reachability 16툴은 awsops Lambda에 거의 동일한 형태로 이미 존재(순수 중복 + 소비자 측 툴 이름 dedup 비결정성)하고, `analyze_reachability`는 mutating(Network Insights path 생성)이라 awsops의 AWS 리소스 mutation 자율성 동결에 저촉됩니다.

즉 이건 새로운, 더 좁은 표면입니다 — 웹앱의 분석 렌즈(cost/latency/reliability/anomalies/alerts) + Athena 히스토리. 오늘날 Next.js 앱 안에만 존재하고, 앱 밖에서는 아무도 접근할 수 없는 기능입니다.

## Decision

1. **새 MCP 서버, 게이트웨이 타깃이 아님.** `app/src/lib/mcp-server.ts`가 JSON-RPC 2.0(`initialize`, `tools/list`, `tools/call`)을 직접 처리합니다 — `@modelcontextprotocol/sdk`의 streamable-HTTP 서버 트랜스포트는 무상태 Next.js route handler와 궁합이 나쁘고, 필요한 표면은 3가지 케이스뿐입니다. `app/src/app/api/mcp/route.ts`는 얇은 `POST` 래퍼입니다.
2. **10개 툴, 전부 기존 코드의 얇은 래퍼** — `nfm_schema`, `nfm_topology`, `nfm_top_talkers`, `nfm_pod_flows`, `nfm_cost_lens`, `nfm_latency_lens`, `nfm_reliability_lens`, `nfm_anomalies`, `nfm_alerts`, `nfm_history`. 모든 핸들러가 기존 `lib/ddb.ts` 읽기 또는 `lib/analytics/*` 렌즈를 호출 — 신규 분석 로직 0. 전부 `nfm_` 접두사(소비자 측 툴 이름 dedup이 충돌 시 비결정적). 전부 읽기 전용.
3. **Bearer 토큰, SigV4가 아님.** 소비자는 이 계정으로 assume할 수 있는 role이 없는 다른 AWS 계정입니다. 공개 HTTPS + 단일 `Authorization: Bearer` 헤더가 소비자 측 게이트웨이 프로비저너가 외부 `mcpServer` 타깃에 지원하는 유일한 형태이며, 소비자의 `api_key` 크리덴셜 프로바이더 모드(헤더 슬롯 정확히 1개)와 정확히 일치합니다. 토큰은 전용 Secrets Manager 시크릿(`nfm-dashboard/mcp-token`, `origin-verify` 시크릿과 동일한 형태 — 배포 간 안정적, synth 시점 랜덤성 없음)에 저장되고, `middleware.ts`에서 기존 `safeEqual` 상수시간 비교로 검사합니다 — Cognito 세션 게이트 **전**(소비자는 Cognito 세션이 없음)이지만 origin-verify **후**(CloudFront가 여전히 유일한 공개 진입점).
4. **Fail closed.** `MCP_BEARER_TOKEN`이 설정되지 않으면 `/api/mcp`는 통과가 아니라 404를 반환합니다 — 설정되지 않은 토큰이 "인증 불필요"를 의미할 수 없습니다.
5. **응답 경계 처리.** 리스트 형태 결과는 모두 `bound()`를 통과(기본 상한 30, `nfm_history`는 웹 `/api/history`의 5000행 허용과 달리 500행 상한)하고, 조용히 잘라내지 않고 `truncated: true`를 보고합니다 — 소비자는 페이지네이션 UI가 아니라 컨텍스트 창이 유한한 LLM 에이전트입니다.
6. **24h 상한 재사용, 재발명 안 함.** `range`(분)는 기존 ADR-008 24h 인터랙티브 렌즈 상한에 클램프됩니다. 그 이상은 `nfm_history`(Athena 아카이브)를 써야 하며, 이는 웹앱 자신이 장기 범위를 라우팅하는 방식과 일치합니다.

## Consequences

- 이전에는 전부 Cognito 뒤에 있던 앱에 새로운 공개(bearer로 게이트된) 표면이 생깁니다. 완화: origin-verify가 여전히 필요(CloudFront 우회 불가), 토큰 미설정 시 fail-closed, 상수시간 비교, 툴셋이 예외 없이 읽기 전용.
- 소비자 측 게이트웨이가 이 서버의 툴 스키마를 캐시합니다(`listingMode: DEFAULT`) — 이쪽에서 툴 이름/시그니처를 바꾸면 소비자가 재프로비저닝(awsops의 `make agentcore`)해야 반영됩니다. 자동 동기화되지 않습니다.
- 토큰 로테이션은 수동 2단계입니다: 여기서 Secrets Manager 값 로테이션 + `NfmDash-App` 재배포, 그다음 awsops 쪽 크리덴셜 갱신 + 재프로비저닝. 두 프로젝트(설계상 별도 저장소·계정) 간 자동 조율은 없습니다.
- 이 엔드포인트는 웹앱 자신의 API 라우트가 이미 노출하는 읽기 경로를 다른 인증 모델로 중복 노출합니다(예: `nfm_cost_lens` ≈ `/api/analytics/cost`). 수용: 두 표면은 서로 다른 소비자(브라우저 세션 vs. 크로스 계정 에이전트)를 서비스하며, 이를 합치는 것이 중복보다 더 나쁩니다.
