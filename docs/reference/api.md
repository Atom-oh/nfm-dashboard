# API / API 구성 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
The API layer is a set of Next.js App Router route handlers under `app/src/app/api/` — 32 `route.ts` files serving dashboard data, analytics, auth, health, the SSE AI chat, the Athena-backed flow archive query, and a read-only MCP egress server for external consumers. All routes except `/api/health`, `/api/auth/*`, and `/api/mcp` are gated by `app/src/middleware.ts`'s Cognito session check (`/api/mcp` has its own bearer-token gate, ADR-012).

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| AI chat (SSE) | `app/src/app/api/ai/route.ts` | Bedrock Converse streaming + MCP tool loop; SSE events, `maxDuration = 300` |
| Auth flow | `app/src/app/api/auth/{login,callback,logout}/route.ts` | Cognito Hosted UI + PKCE session flow |
| Flow data | `app/src/app/api/{flows,topology,paths,workload,overview}/route.ts` | DynamoDB-backed dashboard data via `app/src/lib/ddb.ts` |
| Analytics | `app/src/app/api/analytics/{latency,reliability,cost,dns,dependencies,efficiency,scorecard,movers}/route.ts` | Aggregations via `app/src/lib/analytics/*`; the `dns` route also returns per-source stats (`bySource`: CoreDNS vs Route53 Resolver) for the resolver-compare panel (G3) |
| Monitors | `app/src/app/api/monitors/route.ts`, `app/src/app/api/monitors/[name]/route.ts` | NFM monitor list/detail (CloudWatch) |
| Ops & diagnostics | `app/src/app/api/{health,insights,diagnose,agents}/route.ts`, `app/src/app/api/nfm/refresh/route.ts` | Healthcheck, workload insights, diagnose context, agent/coverage status, manual refresh |
| New menus (Phase 8) | `app/src/app/api/{alerts,search,anomalies,cost-explorer,reports,network}/route.ts` | Alerts (CloudWatch alarms + derived event feed + G5 composite-condition view via `app/src/lib/analytics/composite-conditions.ts`), unified entity search, baseline anomaly detection, cost explorer, report data, network (source→dest matrix gains a `port` dest-scope — G1 port/service traffic mix) |
| Flow history (Phase 13) | `app/src/app/api/history/route.ts` | Athena query over the S3/Parquet flow archive (`nfm_dashboard.flows_archive`) via `app/src/lib/athena.ts`; `?from=&to=&monitor=&namespace=&metric=&limit=`, defaults to the last 7 days, injection-safe SQL builder (`buildHistorySql`) |
| MCP data-source egress (ADR-012) | `app/src/app/api/mcp/route.ts` | JSON-RPC 2.0 MCP server (`app/src/lib/mcp-server.ts`) exposing 10 `nfm_*` read-only tools (schema/topology/top-talkers/pod-flows + cost/latency/reliability/anomalies/alerts lenses + history) for external cross-account MCP consumers (e.g. awsops); `MCP_BEARER_TOKEN`-gated, not Cognito |

### 3. Key Decisions
- The 8 pure flow-lens routes (analytics cost/dependencies/efficiency/latency/movers, anomalies, network, cost-explorer) wrap their compute in `cachedLens(lensCacheKey(route, req.url), …)` — responses are cached in-process until the collector writes a new cycle or the 5-min grid rolls, and shared across users (ADR-007). Routes mixing CloudWatch alarms/metrics or user-specific data (reliability, scorecard, alerts, overview, reports, search) are never response-cached.
- Interactive lens ranges cover 15m–7d: `parseLensParams` clamps `?buckets` to [1, 2016]; requests over 36 buckets (>3h) are hour-quantized — served from closed-hour HFLOW rollups plus a live 5-minute tail instead of a raw fan-out (ADR-009, superseding ADR-008's 24h cap). Beyond-7-day / arbitrary-date-range analysis is served by the Athena-backed `/api/history`.

### 4. Code Pointers
<!-- TODO: 3-7 entries; paths must be valid (checked by /sync-docs) -->
- `app/src/app/api/ai/route.ts` — SSE stream with 15s keepalive `status` events; language pick order: body `lang` → `Accept-Language` → `'ko'`
- `app/src/lib/sse.ts` — `sseEvent()` helper used by streaming routes
- `app/src/middleware.ts` — public paths (`/login`, `/api/health`, `/api/auth/*`), origin-verify enforcement for everything else, and a dedicated bearer-token branch for `/api/mcp` (ADR-012)

### 5. Cross-references
<!-- TODO -->
- Related modules: `app/src/app/api/CLAUDE.md`, `app/src/lib/CLAUDE.md`
- Related ADRs:
- Related runbooks:

<a id="korean"></a>
## 한국어

### 1. 개요
API 계층은 `app/src/app/api/` 아래 Next.js App Router route handler 모음이다 — 32개의 `route.ts`가 대시보드 데이터, 분석, 인증, 헬스체크, SSE AI 채팅, Athena 기반 flow 아카이브 조회, 그리고 외부 소비자를 위한 읽기 전용 MCP egress 서버를 제공한다. `/api/health`, `/api/auth/*`, `/api/mcp`를 제외한 모든 라우트는 `app/src/middleware.ts`의 Cognito 세션 검사가 보호한다(`/api/mcp`는 별도 bearer 토큰 게이트, ADR-012).

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| AI 채팅(SSE) | `app/src/app/api/ai/route.ts` | Bedrock Converse 스트리밍 + MCP 툴 루프; SSE 이벤트, `maxDuration = 300` |
| 인증 플로우 | `app/src/app/api/auth/{login,callback,logout}/route.ts` | Cognito Hosted UI + PKCE 세션 플로우 |
| Flow 데이터 | `app/src/app/api/{flows,topology,paths,workload,overview}/route.ts` | `app/src/lib/ddb.ts` 기반 DynamoDB 대시보드 데이터 |
| 분석 | `app/src/app/api/analytics/{latency,reliability,cost,dns,dependencies,efficiency,scorecard,movers}/route.ts` | `app/src/lib/analytics/*` 기반 집계; `dns` 라우트는 resolver 비교 패널(G3)을 위해 소스별 통계(`bySource`: CoreDNS vs Route53 Resolver)도 반환 |
| 모니터 | `app/src/app/api/monitors/route.ts`, `app/src/app/api/monitors/[name]/route.ts` | NFM 모니터 목록/상세(CloudWatch) |
| 운영·진단 | `app/src/app/api/{health,insights,diagnose,agents}/route.ts`, `app/src/app/api/nfm/refresh/route.ts` | 헬스체크, workload insights, 진단 컨텍스트, 에이전트/커버리지 상태, 수동 갱신 |
| 신규 메뉴 (Phase 8) | `app/src/app/api/{alerts,search,anomalies,cost-explorer,reports,network}/route.ts` | 알림(CloudWatch 알람 + 파생 이벤트 피드 + `app/src/lib/analytics/composite-conditions.ts` 기반 G5 복합 조건 뷰), 통합 엔티티 검색, baseline 이상 탐지, 비용 탐색, 리포트 데이터, network(source→dest 매트릭스에 `port` 목적지 스코프 추가 — G1 포트/서비스 트래픽 믹스) |
| Flow 히스토리 (Phase 13) | `app/src/app/api/history/route.ts` | `app/src/lib/athena.ts`를 통해 S3/Parquet flow 아카이브(`nfm_dashboard.flows_archive`)를 Athena로 조회; `?from=&to=&monitor=&namespace=&metric=&limit=`, 기본값은 최근 7일, SQL 인젝션 방어 빌더(`buildHistorySql`) |
| MCP 데이터소스 egress (ADR-012) | `app/src/app/api/mcp/route.ts` | JSON-RPC 2.0 MCP 서버(`app/src/lib/mcp-server.ts`) — schema/topology/top-talkers/pod-flows + cost/latency/reliability/anomalies/alerts 렌즈 + history를 아우르는 10개의 읽기 전용 `nfm_*` 툴을 외부 크로스 계정 MCP 소비자(예: awsops)에게 노출; Cognito가 아닌 `MCP_BEARER_TOKEN`으로 게이트 |

### 3. 주요 결정
- 순수 flow-lens 라우트 8개(analytics cost/dependencies/efficiency/latency/movers, anomalies, network, cost-explorer)는 계산을 `cachedLens(lensCacheKey(route, req.url), …)`로 감쌉니다 — 응답은 수집기가 새 사이클을 기록하거나 5분 그리드가 넘어갈 때까지 인프로세스에 캐시되며 사용자 간 공유됩니다(ADR-007). CloudWatch 알람/메트릭 또는 사용자별 데이터가 섞인 라우트(reliability, scorecard, alerts, overview, reports, search)는 응답 캐시 대상에서 제외합니다.
- 인터랙티브 lens 범위는 15m–7d: `parseLensParams`가 `?buckets`를 [1, 2016]으로 클램프; 36버킷(3시간) 초과 요청은 시간 단위로 양자화되어 — 원시 fan-out 대신 마감된 시간 HFLOW rollup + 실시간 5분 tail로 서빙됩니다(ADR-009, ADR-008의 24h 상한을 대체). 7일 초과/임의 날짜 범위 분석은 Athena 기반 `/api/history`가 담당합니다.

### 4. 코드 포인터
<!-- TODO: 3-7개 항목; 경로는 실재해야 함 (/sync-docs가 점검) -->
- `app/src/app/api/ai/route.ts` — 15초 keepalive `status` 이벤트를 포함한 SSE 스트림; 언어 결정 순서: body `lang` → `Accept-Language` → `'ko'`
- `app/src/lib/sse.ts` — 스트리밍 라우트가 쓰는 `sseEvent()` 헬퍼
- `app/src/middleware.ts` — 공개 경로(`/login`, `/api/health`, `/api/auth/*`), 그 외 전 경로의 origin-verify 강제, `/api/mcp` 전용 bearer 토큰 분기(ADR-012)

### 5. 상호 참조
<!-- TODO -->
- 관련 모듈: `app/src/app/api/CLAUDE.md`, `app/src/lib/CLAUDE.md`
- 관련 ADR:
- 관련 런북:
