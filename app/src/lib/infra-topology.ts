/**
 * Static, hand-maintained map of nfm-dashboard's OWN request/data path —
 * CloudFront -> ALB -> ECS -> {DynamoDB, Athena/S3, Bedrock, AgentCore} -> ...
 * This is infrastructure topology (the app's own deployment graph, derived
 * from infra/lib/*.ts), NOT the pod-to-pod flow topology `nfm_topology`
 * exposes (that's live NFM data about OTHER EKS clusters this product
 * monitors). Keep this in lockstep with infra/lib/app-stack.ts,
 * data-stack.ts, and agentcore-stack.ts when those change — there is no
 * live AWS API call backing this (the ECS task role has no
 * elbv2/ecs/cloudfront Describe* permissions), so it will silently drift if
 * the CDK stacks move on without a matching edit here.
 */

export type InfraNodeKind =
  | 'client' | 'cdn' | 'alb' | 'compute' | 'auth' | 'db' | 'stream' | 'storage'
  | 'analytics' | 'ai' | 'lambda' | 'config' | 'external';

export interface InfraNode {
  id: string;
  kind: InfraNodeKind;
  label: string;
  detail: string;
}

export interface InfraEdge {
  from: string;
  to: string;
  label: string;
}

export const INFRA_NODES: InfraNode[] = [
  { id: 'client', kind: 'client', label: 'Browser / MCP client', detail: 'End users, or an external MCP consumer (e.g. awsops)' },
  { id: 'cloudfront', kind: 'cdn', label: 'CloudFront', detail: 'nfm-dashboard.atomai.click; only public entry point' },
  { id: 'alb', kind: 'alb', label: 'ALB (internal)', detail: 'HTTP:80; SG ingress = CloudFront origin-facing prefix list only' },
  { id: 'ecs', kind: 'compute', label: 'ECS Fargate: nfm-dashboard-app', detail: 'Next.js 16 standalone, arm64, port 3000, 1 task' },
  { id: 'cognito', kind: 'auth', label: 'Cognito', detail: 'Hosted UI + PKCE; session cookie verified per-request' },
  { id: 'ddb_flows', kind: 'db', label: 'DynamoDB: nfm-dashboard-flows', detail: 'Hot flow records, 5-min buckets + HFLOW hourly rollups, 7d/15d TTL' },
  { id: 'ddb_meta', kind: 'db', label: 'DynamoDB: nfm-dashboard-meta', detail: 'Topology snapshot, collection status, coverage' },
  { id: 'ddb_stream_lambda', kind: 'lambda', label: 'Lambda: archive-transform', detail: 'DynamoDB Stream (NEW_IMAGE) -> flattens FlowEdge rows' },
  { id: 'firehose', kind: 'stream', label: 'Kinesis Firehose', detail: 'Parquet conversion, dynamic partition by dt' },
  { id: 's3_archive', kind: 'storage', label: 'S3: flow-archive', detail: 'Parquet lake, partitioned by dt (date)' },
  { id: 'glue_athena', kind: 'analytics', label: 'Glue + Athena', detail: 'nfm_dashboard.flows_archive, workgroup nfm-dashboard, 2GB scan cap' },
  { id: 'cloudwatch', kind: 'analytics', label: 'CloudWatch', detail: 'NFM metrics + alarms (GetMetricData/ListMetrics/DescribeAlarms)' },
  { id: 'bedrock', kind: 'ai', label: 'Bedrock (Converse API)', detail: 'Chat + diagnose SSE streams' },
  { id: 'agentcore_gw', kind: 'ai', label: 'AgentCore Gateway: nfm-gateway', detail: 'SigV4/AWS_IAM, 27 tools across 3 Lambda targets' },
  { id: 'mcp_tool_lambdas', kind: 'lambda', label: 'MCP tool Lambdas (nfm/ddb/network)', detail: 'tools/nfm_mcp.py, ddb_mcp.py, network_mcp.py' },
  { id: 'collector_lambda', kind: 'lambda', label: 'Lambda: nfm-dashboard-collector', detail: '5-min schedule; also manually triggerable via /api/nfm/refresh' },
  { id: 'nfm_api', kind: 'external', label: 'AWS Network Flow Monitor API', detail: 'Source of truth for pod-to-pod flow data' },
  { id: 'ssm', kind: 'config', label: 'SSM Parameter Store', detail: '/nfm-dashboard/gateway-url (SecureString)' },
];

export const INFRA_EDGES: InfraEdge[] = [
  { from: 'client', to: 'cloudfront', label: 'HTTPS' },
  { from: 'cloudfront', to: 'alb', label: 'HTTP:80 + X-Origin-Verify header (shared secret)' },
  { from: 'alb', to: 'ecs', label: 'HTTP:3000; target-group health check GET /api/health' },
  { from: 'ecs', to: 'cognito', label: 'OIDC Hosted UI + PKCE login; ID-token verification every request' },
  { from: 'client', to: 'ecs', label: '/api/mcp only: Bearer token (ADR-012) — bypasses Cognito, still behind CloudFront+origin-verify' },
  { from: 'ecs', to: 'ddb_flows', label: 'Query/Get (hot 24h/7d flow window reads, 5-min + HFLOW-hour lenses)' },
  { from: 'ecs', to: 'ddb_meta', label: 'Get/Put (topology snapshot, collection status, coverage)' },
  { from: 'ecs', to: 'cloudwatch', label: 'GetMetricData/ListMetrics/DescribeAlarms' },
  { from: 'ecs', to: 'glue_athena', label: 'StartQueryExecution (long-range /api/history, /nfm_history MCP tool)' },
  { from: 'glue_athena', to: 's3_archive', label: 'reads Parquet objects' },
  { from: 'ecs', to: 'bedrock', label: 'InvokeModel(WithResponseStream) — chat/diagnose' },
  { from: 'ecs', to: 'agentcore_gw', label: 'SigV4 InvokeGateway — chat tool-calling loop' },
  { from: 'agentcore_gw', to: 'mcp_tool_lambdas', label: 'MCP tools/call' },
  { from: 'ecs', to: 'ssm', label: 'GetParameter — resolves the gateway URL' },
  { from: 'ecs', to: 'collector_lambda', label: 'Lambda:Invoke — manual refresh (/api/nfm/refresh)' },
  { from: 'collector_lambda', to: 'nfm_api', label: 'Start/GetStatus/GetResults MonitorTopContributors + WorkloadInsights' },
  { from: 'collector_lambda', to: 'ddb_flows', label: 'BatchWrite — 5-min cycle flow rows + HFLOW hourly rollups' },
  { from: 'collector_lambda', to: 'ddb_meta', label: 'Put — topology snapshot, collection status/history, coverage' },
  { from: 'ddb_flows', to: 'ddb_stream_lambda', label: 'DynamoDB Stream (NEW_IMAGE)' },
  { from: 'ddb_stream_lambda', to: 'firehose', label: 'PutRecord (flattened FlowEdge rows)' },
  { from: 'firehose', to: 's3_archive', label: 'buffered Parquet delivery' },
];
