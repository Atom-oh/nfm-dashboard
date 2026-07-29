# app/src/app/api — API Module

## Role
Next.js route handlers — the dashboard's entire API surface. All routes are protected by `app/src/middleware.ts` (Cognito session cookie + CloudFront origin-verify) except `/api/health` and `/api/auth/*`. The session-cookie half can be temporarily disabled via `AUTH_DISABLED=1` (infra `authDisabled` context, ADR-005); origin-verify always applies. `/api/mcp` is a third case — bearer-token gated instead of Cognito (ADR-012), for external cross-account MCP consumers.

## Endpoints
- `ai/route.ts` — AI chat: SSE stream, Bedrock Converse loop with AgentCore MCP tools (`maxDuration = 300`)
- `auth/{login,callback,logout}/route.ts` — Cognito Hosted UI + PKCE session flow
- `flows`, `topology`, `paths`, `workload` — DynamoDB-backed dashboard data (via `app/src/lib/ddb.ts`)
- `overview/route.ts` — landing payload: fleet KPIs (CloudWatch) + an additive `summary` block composing the scorecard/efficiency/concentration/dns lenses over ONE shared flows window
- `analytics/{latency,reliability,cost,dns,dependencies,efficiency,movers,scorecard}` — flow-lens aggregations (via `app/src/lib/analytics/*`)
- `cost-explorer`, `network`, `anomalies` — cost-explorer / network-analytics (source→dest) / anomaly-detection lenses over the flows window
- `alerts/route.ts` — derived alert-event feed (CW alarms + reliability breaches + collector failures + window-over-window spikes) + G5 composite-condition view (entities breaching >=2 signals at once, via `app/src/lib/analytics/composite-conditions.ts`) — a dashboard signal, not a CloudWatch alarm
- `reports/route.ts` — `ReportData` for the /reports export page (KPIs + top talkers + breaches + anomalies from one shared window)
- `search/route.ts` — unified entity search across topology / recent flows / monitors / DNS
- `monitors/route.ts`, `monitors/[name]/route.ts` — NFM monitor list/detail (CloudWatch)
- `insights`, `diagnose`, `agents` — workload insights, diagnose context, agent/coverage status
- `nfm/refresh/route.ts` — manual collection refresh trigger
- `health/route.ts` — unauthenticated ALB healthcheck
- `history/route.ts` — Athena-backed query over the S3/Parquet flow archive (`nfm_dashboard.flows_archive`) via `app/src/lib/athena.ts`; `?from=&to=&monitor=&namespace=&metric=&limit=`, defaults to the last 7 days
- `mcp/route.ts` — JSON-RPC 2.0 MCP server (`app/src/lib/mcp-server.ts`) exposing 10 `nfm_*` read-only tools (schema/topology/top-talkers/pod-flows + cost/latency/reliability/anomalies/alerts lenses + history) for EXTERNAL cross-account MCP consumers (e.g. awsops), auth'd by `MCP_BEARER_TOKEN` instead of Cognito (ADR-012)

## Rules
- Handlers stay thin: parse/validate input, call `app/src/lib/*`, shape the response. No business logic in routes.
- PURE flow-lens routes (analytics cost/dependencies/efficiency/latency/movers, anomalies, network, cost-explorer) wrap their compute in `cachedLens(lensCacheKey(route, req.url), …)` (`app/src/lib/ddb.ts`) — cached until the collector writes a new cycle or the 5-min grid rolls, shared across users. NEVER wrap a route that mixes CloudWatch alarms/metrics or user-specific data (reliability/scorecard/alerts/overview/reports/search stay unwrapped).
- Streaming responses use `app/src/lib/sse.ts` helpers (`sseEvent`); send keepalives on long streams (see `ai/route.ts`).
- New endpoint => update this file and `docs/reference/api.md`; UI-facing strings still go through i18n on the client side.
- Tests for route logic live next to the extracted lib code in `app/src/lib` (keep routes trivially thin).
