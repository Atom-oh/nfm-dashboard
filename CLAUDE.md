# Project Context

## Overview
**NFM Dashboard** (v0.11.0, pre-1.0) — Pod-to-Pod network observability dashboard for AWS CloudWatch Network Flow Monitor (NFM), plus a Bedrock AgentCore AI chatbot.
Live: https://nfm-dashboard.atomai.click (Cognito login). AWS account `<ACCOUNT_ID>`, region `ap-northeast-2`.

> The global `~/.claude/CLAUDE.md` (Korean-first responses) and the spec-driven workflow in `docs/superpowers/` take precedence for language and process. This file only adds project-specific context — keep it complementary and concise.

## Tech Stack
- Node.js npm-workspaces monorepo, TypeScript throughout
- `app`: Next.js 16 (App Router) + React 19, Tailwind CSS v4 design tokens (SnowUI), recharts + reactflow, `@aws-sdk/client-athena`, vitest
- `collector`: AWS Lambda (esbuild → `dist/handler.mjs` + `dist/archive-transform.mjs`), AWS SDK v3 (incl. `@aws-sdk/client-firehose`, `@aws-sdk/util-dynamodb`)
- `infra`: AWS CDK v2 (TypeScript)
- AI: Amazon Bedrock (Converse API) + AgentCore gateway (MCP over SigV4, consumer side). Also an MCP **provider**: `/api/mcp` (bearer-token gated, ADR-012) exposes read-only analysis lenses for external cross-account consumers (e.g. awsops).
- Data (hot): DynamoDB (`nfm-dashboard-flows`, `nfm-dashboard-meta`, 7-day TTL) + CloudWatch metrics
- Data (cold/analytics): DynamoDB Stream → archive-transform Lambda → Kinesis Firehose (Parquet via Glue schema) → S3 Parquet archive → Glue Data Catalog + Athena. Deliberate DDB-hot / Athena-cold tiering; the archive persists flows past the 7-day TTL for arbitrary-date-range history.

## Project Structure
```
app/          - Next.js 16 dashboard (src/app pages incl. /history (+ history-sort.ts col sniffing) & /topology force graph (+ focus-param.ts ?focus= deep-link) & /network (+ ns-param.ts ?ns= deep-link), src/app/api incl. history/ + mcp/ (MCP egress server for external consumers, ADR-012), src/lib incl. athena.ts + mcp-server.ts (MCP egress dispatcher) + use-sortable.ts (sortable tables) + graph-focus.ts/graph-layout.ts (topology ego-network + deterministic layout) + analytics/composite-conditions.ts (G5 multi-signal breaches) + analytics/port-mix.ts (G1 port labels for the network `port` scope), src/components incl. layout/ left Sidebar+Topbar nav, SortableHeader.tsx, PageIntro.tsx (per-page 개요/기능 intro box on all 17 pages), analytics/AnomalyDetailPanel.tsx (row-select slide-over) & topology/NetworkGraph.tsx; insights/tabs/DnsTab.tsx ResolverCompare (G3 CoreDNS vs Route53 Resolver))
collector/    - NFM data-collector Lambda (5-min cycle → dist/handler.mjs) + archive-transform.ts (DDB Stream → Firehose, → dist/archive-transform.mjs)
infra/        - CDK stacks: NfmDash-Data (incl. flow-archive pipeline: DDB Stream → Firehose → S3 Parquet → Glue/Athena) / Onboarding / AgentCore / App / Ops / Dns
scripts/      - build-push.sh (ECR image), smoke.sh (e2e), setup-gateway.sh
tools/        - AgentCore MCP tool Lambdas (Python: nfm_mcp, ddb_mcp, network_mcp) + create_gateway.py
onboarding/   - NFM / CoreDNS onboarding scripts (Python)
e2e/          - Playwright smoke tests
docs/         - decisions/ (ADRs), reference/ (layer docs), runbooks/, superpowers/ (spec workflow)
```

## Conventions
- TypeScript everywhere; vitest tests co-located (`*.test.ts` / `*.test.tsx` next to source).
- Tailwind v4 + SnowUI design tokens; chart colors ONLY from `app/src/lib/chart-tokens.ts` (keep in sync with `app/tailwind.config.ts`).
- i18n ko/en: ALL UI strings go through `t()` (`app/src/lib/i18n`, `translations/{ko,en}.json`) — no hardcoded UI strings.
- Left-sidebar nav is data-driven from `app/src/components/layout/nav.ts` (`NAV_GROUPS` = source of truth, `NAV_ITEMS` = flatMap); add menus there.
- Data access via `app/src/lib/ddb.ts` (DynamoDB hot), `app/src/lib/cw-metrics.ts` (CloudWatch), and `app/src/lib/athena.ts` (Parquet archive / long-range history; SQL is injection-guarded). The 5-minute bucket formula in `ddb.ts` MUST match the collector exactly. Flow windows + pure-lens responses are cached in-process, version-aligned to the collector cycle (`cachedLens`; ADR-007); interactive lens ranges cap at 24h — 7d+ goes through Athena `/history` (ADR-008).
- Sortable data: raw `<table>`s use shared `useSortableRows`/`compareBy` (`app/src/lib/use-sortable.ts`, sorts RAW values not formatted text, null-last) + `SortableHeader` (`app/src/components/SortableHeader.tsx`, `aria-sort`); the ranked `Toplist` (`app/src/components/analytics/Toplist.tsx`) opts in via a `sortable` prop while compact teasers keep a fixed top-N.
- Topology `/topology` (`app/src/components/topology/NetworkGraph.tsx`): COLOR is reserved for health — express extra signals (cross-AZ, high-retransmit, node kind) via shape/icon/badge; layout is deterministic (id-hash seed + fx/fy pinning) with localStorage position persistence.

## Key Commands
```bash
npm -w app run dev                 # dashboard dev server
npm -w app run build               # production build
npx -w app vitest run              # app tests
npx -w app tsc --noEmit            # typecheck
npm -w collector run build         # collector bundle (esbuild)
npm -w collector run test          # collector tests
bash scripts/build-push.sh <sha>   # build + push container image to ECR
cd infra && npx cdk deploy <Stack> --require-approval never -c imageTag=<sha>
#   ALL cdk commands need -c imageTag; non-App stacks may use -c imageTag=unused
bash scripts/smoke.sh              # e2e smoke test
```

<!-- AUTO-MANAGED:references -->
## Implementation References
- [Infrastructure](docs/reference/infrastructure.md) — CloudFront + ALB + ECS Fargate runtime, image build/deploy
- [Data](docs/reference/data.md) — DynamoDB single-table (flows/meta) + CloudWatch metrics
- [API](docs/reference/api.md) — Next.js route handlers under `app/src/app/api/`
- [IaC](docs/reference/iac.md) — CDK stacks in `infra/`
- [Frontend](docs/reference/frontend.md) — Next.js App Router pages, i18n
- [UI](docs/reference/ui.md) — components, charts, design tokens
- [Security](docs/reference/security.md) — Cognito auth, origin-verify, SigV4
- [Agent · LLM](docs/reference/agent-llm.md) — Bedrock Converse + AgentCore gateway chatbot
<!-- /AUTO-MANAGED:references -->

---

## Auto-Sync Rules

Rules below are applied automatically after Plan mode exit and on major code changes.

### Post-Plan Mode Actions
After exiting Plan mode (`/plan`), before starting implementation:

1. **Architecture decision made** -> Update `docs/architecture.md`
2. **Technical choice/trade-off made** -> Create `docs/decisions/ADR-NNN-title.md`
3. **New module added** -> Create `CLAUDE.md` in that module directory
4. **Operational procedure defined** -> Create runbook in `docs/runbooks/`
5. **Changes needed in this file** -> Update relevant sections above

### Code Change Sync Rules
- New top-level directory in `app/src/`, `collector/src/`, or a new workspace -> Must create `CLAUDE.md` alongside
- API endpoint added/changed -> Update `app/src/app/api/CLAUDE.md` and `docs/reference/api.md`
- DynamoDB schema/access pattern changed -> Update `app/src/lib/CLAUDE.md`, `collector/CLAUDE.md`, and `docs/reference/data.md`
- CDK stack added/changed -> Update `infra/CLAUDE.md` and `docs/reference/iac.md` / `docs/reference/infrastructure.md`
- Auth/perimeter changed -> Update `docs/reference/security.md`
- Bedrock model / gateway tooling changed -> Update `docs/reference/agent-llm.md`

### ADR Numbering
Find the highest number in `docs/decisions/ADR-*.md` and increment by 1.
Format: `ADR-NNN-concise-title.md`
