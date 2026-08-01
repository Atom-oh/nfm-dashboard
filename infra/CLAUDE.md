# infra — AWS CDK Module

## Role
CDK v2 (TypeScript) app defining all AWS infrastructure. Six stacks, env pinned to account `<ACCOUNT_ID>` / `ap-northeast-2` in `bin/nfm-dashboard.ts`:
`NfmDash-Data`, `NfmDash-Onboarding`, `NfmDash-AgentCore`, `NfmDash-App`, `NfmDash-Ops`, `NfmDash-Dns`.

## Key Files
- `bin/nfm-dashboard.ts` — app entry; instantiates the 6 stacks (Ops consumes `alb`/`targetGroup` from AppStack)
- `lib/data-stack.ts` — DynamoDB tables + collector Lambda + schedule + flow-archive pipeline: `flows` stream (`NEW_IMAGE`) → transform Lambda (`archive-transform.handler`) → Firehose L1 `CfnDeliveryStream` (Parquet, dynamic-partition by `dt`) → S3 archive bucket, catalogued by Glue L1 `CfnDatabase`/`CfnTable` (`nfm_dashboard.flows_archive`, partition projection) + Athena L1 `CfnWorkGroup` (`nfm-dashboard`). Glue columns MUST match the transform Lambda's `FlatFlowRow` (minus `dt`) or Firehose routes records to `errors/`. Fixed resource names (account `<ACCOUNT_ID>`) — no cross-stack export. Also provisions `FlowAlertTopic` (SNS, `nfm-dashboard-flow-alerts`) → task env `FLOW_ALERT_TOPIC_ARN`, real-time reliability-breach push (state transitions only) distinct from the infra-health `nfm-dashboard-alarms` topic in `OpsAlarmsStack`; ARN exported as `CfnOutput FlowAlertTopicArn` — subscribe an SQS queue there for a same-account server-to-server consumer
- `lib/nfm-onboarding-stack.ts` — NFM onboarding resources
- `lib/agentcore-stack.ts` — AgentCore MCP tool Lambdas (Python 3.13, arm64) + gateway IAM role
- `lib/app-stack.ts` — ECR image → ECS Fargate (arm64) behind ALB, fronted by CloudFront on a custom domain (`APP_DOMAIN` = `nfm-dashboard.atomai.click`, ACM cert `CERT_ARN` in us-east-1 for the `*.atomai.click` wildcard, Route53 A/AAAA alias in `HOSTED_ZONE_ID`), Cognito Hosted UI (PKCE). Cognito `callbackUrls`/`logoutUrls` register BOTH the custom domain and the CloudFront default domain (`CfnOutput CloudFrontUrl`) so login keeps working if DNS/cert isn't ready yet. `VPC_ID` and the zone/cert IDs are account-specific — re-point them when redeploying to a different AWS account. Header comment documents the ALB → CloudFront → Cognito circular-dependency resolution — read it before touching ordering. The `authDisabled` context injects `AUTH_DISABLED=1` into the task env, disabling only the middleware session gate (Cognito resources + origin-verify stay; ADR-005). Currently OFF — login enforced. Task tuning from the 2026-07-14/15 incidents: 4096 MiB memory + `NODE_OPTIONS=--max-old-space-size=3072` (heap failures exit 134, not cgroup 137) and target-group `unhealthyThresholdCount: 5` (75s tolerance so a slow cold 24h lens compute can't crash-loop the task). Also provisions the `McpToken` secret (`nfm-dashboard/mcp-token`, generated like `OriginVerify`) → task env `MCP_BEARER_TOKEN`, the bearer credential for the `/api/mcp` external MCP egress route (ADR-012); its ARN is `CfnOutput McpTokenSecretArn`.
- `lib/ops-alarms.ts` — CloudWatch alarms on ALB/target group
- `lib/dns-stack.ts` — DNS resources
- `cdk.json`, `cdk.context.json` — CDK config/context; `test/` — stack tests (vitest)

## Rules
- ALL cdk commands require `-c imageTag`: `cd infra && npx cdk deploy <Stack> --require-approval never -c imageTag=<sha>`. Non-App stacks may use `-c imageTag=unused`.
- The App image is built/pushed by `bash scripts/build-push.sh <sha>` BEFORE deploying `NfmDash-App` with that tag.
- Deploying `NfmDash-Data` requires a fresh collector build (`npm -w collector run build`).
- Auth toggle: set `authDisabled: true` in `cdk.json` context (or `-c authDisabled=true`) to disable login on App deploys; remove it (default) to enforce login. The env-only flag needs no image rebuild — redeploy `NfmDash-App` with any pushed `imageTag` (ADR-005).
- After deploy, verify with `bash scripts/smoke.sh`.
