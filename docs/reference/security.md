# Security / 보안 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
Defense in depth: CloudFront is the only public entry (ALB ingress limited to CloudFront origin-facing IPs + `x-origin-verify` shared secret), users authenticate via Cognito Hosted UI (PKCE) with a session cookie enforced by Next.js middleware, and server-to-gateway calls are SigV4-signed (AWS_IAM). One route breaks this pattern deliberately: `/api/mcp` (ADR-012/013) is a machine-to-machine data-source egress with no Cognito session — it stays behind origin-verify but swaps the Cognito gate for one of two schemes: SigV4/STS `GetCallerIdentity` forwarding for same-account server-to-server callers (ADR-013 — nfm-dashboard and its known consumers, e.g. awsops, share an AWS account), or a static bearer token for clients that can't sign a request (Claude Code CLI). SigV4 is tried first and never falls through to the bearer check on failure.

> **Auth toggle (ADR-005):** the Cognito session gate can be temporarily disabled via the `authDisabled` CDK context (`infra/cdk.json`) → task env `AUTH_DISABLED=1`; the `x-origin-verify` perimeter and all Cognito resources stay active either way. **Currently the toggle is OFF — login is enforced.**

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Auth middleware | `app/src/middleware.ts` | Session-cookie gate on all non-public routes; constant-time `x-origin-verify` check (always enforced, runs before the bypass); `AUTH_DISABLED=1` skips ONLY the session gate — in production it is set exclusively by the `authDisabled` CDK context (ADR-005); `/api/mcp` gets its own two-scheme branch instead of the session gate: SigV4/STS first (ADR-013), constant-time bearer-token fallback (ADR-012) |
| Auth library | `app/src/lib/auth.ts` | Cognito ID-token verification, `SESSION_COOKIE_NAME`, `safeEqual` (also reused for the MCP bearer-token compare) |
| MCP SigV4 verifier | `app/src/lib/sigv4-verify.ts` | `verifyStsCallerIdentity` — STS `GetCallerIdentity` forwarding (SSRF-guarded, host-pinned to `sts*.amazonaws.com`); `isAllowedMcpCaller` — same-account + role/ARN allowlist check (ADR-013) |
| Auth routes | `app/src/app/api/auth/{login,callback,logout}/route.ts` | Hosted UI + PKCE login/callback/logout |
| SigV4 MCP client | `app/src/lib/mcp-client.ts` | Signs AgentCore gateway requests (service `bedrock-agentcore`); unsigned requests get 401 — this is the INGRESS/consumer side |
| MCP egress server | `app/src/lib/mcp-server.ts`, `app/src/app/api/mcp/route.ts` | Read-only JSON-RPC MCP server for EXTERNAL cross-account consumers; bearer-token gated (`MCP_BEARER_TOKEN`, ADR-012) — the EGRESS/provider side |
| Network perimeter | `infra/lib/app-stack.ts` | ALB SG allows only the CloudFront origin-facing managed prefix list; origin-verify secret + MCP bearer-token secret generated into Secrets Manager |
| Admin secret script | `scripts/save-cognito-secret.sh` | Stores Cognito admin credentials in Secrets Manager |

### 3. Key Decisions
<!-- TODO: list 3-5 decisions or link to docs/decisions/ADR-*.md -->

### 4. Code Pointers
<!-- TODO: 3-7 entries; paths must be valid (checked by /sync-docs) -->
- `app/src/middleware.ts` — public paths: `/login`, `/api/health`, `/favicon.ico`, `/api/auth/*`, `/_next/*`, static assets (never for `/api/*`); origin-verify compare is digest-based to avoid timing leaks
- `app/src/app/api/auth/callback/route.ts` — transient/CSRF failures (state/pkce/nonce/code) auto-restart the login once (via `nfm_auth_retry` marker) so a concurrent `/api/auth/login` clobbering the one-shot cookies (stale tabs / double-click) doesn't surface a spurious error; token-exchange / id_token-verification failures are not retried. The failing step is logged (step name only, no secret values)
- `app/src/lib/auth.ts` — token verification consumed by middleware and auth routes
- `app/src/lib/mcp-client.ts` — SigV4 signing with `@smithy/signature-v4` + `defaultProvider` credentials
- `app/src/lib/mcp-server.ts` — MCP egress dispatcher; every tool wraps an existing read-only lib/lens call, bounded response rows (`bound()`), 24h `range` cap (ADR-008) beyond which callers must use `nfm_history`
- `app/src/middleware.ts` (`/api/mcp` branch) — fail-closed: `MCP_BEARER_TOKEN` unset → 404, not a pass-through; checked before Cognito but after origin-verify

### 5. Cross-references
<!-- TODO -->
- Related modules: `app/CLAUDE.md`, `infra/CLAUDE.md`
- Related ADRs: `docs/decisions/ADR-004-cloudfront-alb-cognito-ordering.md`, `docs/decisions/ADR-005-temporary-auth-disable-toggle.md`, `docs/decisions/ADR-012-mcp-data-source-egress.md`, `docs/decisions/ADR-013-sigv4-server-to-server-mcp-auth.md`
- Related runbooks: `docs/runbooks/deploy.md`, `docs/runbooks/incident-response.md`

<a id="korean"></a>
## 한국어

### 1. 개요
심층 방어: 공개 진입점은 CloudFront뿐이며(ALB 인그레스는 CloudFront origin-facing IP + `x-origin-verify` 공유 시크릿으로 제한), 사용자는 Cognito Hosted UI(PKCE)로 인증하고 Next.js 미들웨어가 세션 쿠키를 강제한다. 서버→게이트웨이 호출은 SigV4 서명(AWS_IAM)으로 보호된다. 한 라우트는 이 패턴을 의도적으로 벗어난다: `/api/mcp`(ADR-012/013)는 Cognito 세션이 없는 기계-대-기계 데이터소스 egress로, origin-verify는 유지하지만 Cognito 게이트를 둘 중 하나로 대체한다: 같은 계정 서버 간 호출자를 위한 SigV4/STS `GetCallerIdentity` forwarding(ADR-013 — nfm-dashboard와 그 알려진 소비자(예: awsops)는 같은 AWS 계정을 씀), 또는 요청에 서명할 수 없는 클라이언트(Claude Code CLI)를 위한 정적 bearer 토큰. SigV4를 먼저 시도하고, 실패해도 bearer 검사로 넘어가지 않는다.

> **인증 토글 (ADR-005):** Cognito 세션 게이트는 `authDisabled` CDK 컨텍스트(`infra/cdk.json`) → 태스크 env `AUTH_DISABLED=1`로 임시 비활성화할 수 있다(`x-origin-verify` 경계와 Cognito 리소스는 어느 경우든 유지). **현재 토글은 OFF — 로그인 강제 상태.**

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 인증 미들웨어 | `app/src/middleware.ts` | 비공개 전 경로 세션 쿠키 게이트; 상수 시간 `x-origin-verify` 검증(항상 강제, 바이패스보다 먼저 실행); `AUTH_DISABLED=1`은 세션 게이트만 스킵 — 프로덕션에서는 `authDisabled` CDK 컨텍스트로만 설정(ADR-005); `/api/mcp`는 세션 게이트 대신 2단계 분기를 가짐: SigV4/STS 먼저(ADR-013), 상수시간 bearer 토큰 폴백(ADR-012) |
| 인증 라이브러리 | `app/src/lib/auth.ts` | Cognito ID 토큰 검증, `SESSION_COOKIE_NAME`, `safeEqual`(MCP bearer 토큰 비교에도 재사용) |
| MCP SigV4 검증기 | `app/src/lib/sigv4-verify.ts` | `verifyStsCallerIdentity` — STS `GetCallerIdentity` forwarding(SSRF 가드, 호스트를 `sts*.amazonaws.com`으로 고정); `isAllowedMcpCaller` — 동일 계정 + role/ARN allowlist 검사(ADR-013) |
| 인증 라우트 | `app/src/app/api/auth/{login,callback,logout}/route.ts` | Hosted UI + PKCE 로그인/콜백/로그아웃 |
| SigV4 MCP 클라이언트 | `app/src/lib/mcp-client.ts` | AgentCore 게이트웨이 요청 서명(서비스 `bedrock-agentcore`); 미서명 요청은 401 — INGRESS/소비자 측 |
| MCP egress 서버 | `app/src/lib/mcp-server.ts`, `app/src/app/api/mcp/route.ts` | 외부 크로스 계정 소비자를 위한 읽기 전용 JSON-RPC MCP 서버; bearer 토큰 게이트(`MCP_BEARER_TOKEN`, ADR-012) — EGRESS/제공자 측 |
| 네트워크 경계 | `infra/lib/app-stack.ts` | ALB SG는 CloudFront origin-facing 관리형 prefix list만 허용; origin-verify 시크릿 + MCP bearer 토큰 시크릿은 Secrets Manager 생성 |
| 관리자 시크릿 스크립트 | `scripts/save-cognito-secret.sh` | Cognito 관리자 자격증명을 Secrets Manager에 저장 |

### 3. 주요 결정
<!-- TODO: 3-5개 결정 나열 또는 docs/decisions/ADR-*.md 링크 -->

### 4. 코드 포인터
<!-- TODO: 3-7개 항목; 경로는 실재해야 함 (/sync-docs가 점검) -->
- `app/src/middleware.ts` — 공개 경로: `/login`, `/api/health`, `/favicon.ico`, `/api/auth/*`, `/_next/*`, 정적 자산(`/api/*`에는 미적용); origin-verify 비교는 타이밍 누출 방지를 위해 다이제스트 기반
- `app/src/app/api/auth/callback/route.ts` — transient/CSRF 실패(state/pkce/nonce/code)는 로그인을 1회 자동 재시작(`nfm_auth_retry` 마커)하여, 동시 `/api/auth/login`이 1회성 쿠키를 덮어써도(stale 탭·중복 클릭) 잘못된 에러가 표시되지 않게 한다; 토큰 교환·id_token 검증 실패는 재시도하지 않는다. 실패 단계는 로그로 남긴다(단계명만, 시크릿 값 없음)
- `app/src/lib/auth.ts` — 미들웨어·인증 라우트가 사용하는 토큰 검증
- `app/src/lib/mcp-client.ts` — `@smithy/signature-v4` + `defaultProvider` 자격증명으로 SigV4 서명
- `app/src/lib/mcp-server.ts` — MCP egress 디스패처; 모든 툴은 기존 읽기 전용 lib/렌즈 호출을 감쌈, 응답 행 상한(`bound()`), 24h `range` 상한(ADR-008) 초과 시 호출자는 `nfm_history`를 써야 함
- `app/src/middleware.ts`(`/api/mcp` 분기) — fail-closed: `MCP_BEARER_TOKEN` 미설정 → 통과가 아니라 404; Cognito보다 먼저지만 origin-verify보다는 나중에 검사

### 5. 상호 참조
<!-- TODO -->
- 관련 모듈: `app/CLAUDE.md`, `infra/CLAUDE.md`
- 관련 ADR: `docs/decisions/ADR-004-cloudfront-alb-cognito-ordering.md`, `docs/decisions/ADR-005-temporary-auth-disable-toggle.md`, `docs/decisions/ADR-012-mcp-data-source-egress.md`, `docs/decisions/ADR-013-sigv4-server-to-server-mcp-auth.md`
- 관련 런북: `docs/runbooks/deploy.md`, `docs/runbooks/incident-response.md`
