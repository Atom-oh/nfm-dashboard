/**
 * MCP (JSON-RPC 2.0) server for `/api/mcp` — the read-only egress side of the
 * gateway (`mcp-client.ts` is the ingress/consumer side, talking to the
 * AgentCore gateway). Hand-rolled dispatcher, not the `@modelcontextprotocol/sdk`
 * streamable-HTTP server: that transport doesn't fit a stateless Next.js route
 * handler, and the protocol surface we need (initialize/tools list/call) is
 * three cases.
 *
 * Every tool wraps an existing lib/ read path or analytics lens — no new
 * analysis logic lives here. See ADR-012 for why this exists and its
 * read-only/bounded-response invariants.
 */
import { cachedLens, getCollectionHistory, getCollectionStatus, getCoverage, getDns,
  getFlowsWindow, getFlowsWindowPair, getTopology, queryPodFlows } from './ddb';
import { getAlarms } from './cw-alarms';
import { getNfmMetrics, healthByMonitor } from './cw-metrics';
import { buildMonitorList } from './monitors';
import { buildOverviewKpis, overviewSummary } from './overview-metrics';
import { costLens } from './analytics/cost';
import { latencyLens } from './analytics/latency';
import { reliabilityLens, DEFAULT_RETRANS_RATE, DEFAULT_TIMEOUT_RATE } from './analytics/reliability';
import { detectAnomalies, DEFAULT_SIGMA } from './analytics/anomalies';
import { compositeConditions } from './analytics/composite-conditions';
import { moversLens } from './analytics/movers';
import { deriveEvents } from './alerts';
import { HistoryValidationError, runHistoryQuery } from './athena';
import { INFRA_EDGES, INFRA_NODES } from './infra-topology';
import type { TopoEdge, MetricName } from './types';

const MAX_ROWS = 30;
const MAX_HISTORY_LIMIT = 500;
// ADR-008: interactive lens ranges cap at 24h in-process; beyond that is Athena's job (nfm_history).
const MAX_BUCKETS = 288; // 24h / 5min

/** Bounds a list to `n` rows without silently dropping the fact that it was cut. */
export function bound<T>(rows: T[], n = MAX_ROWS): { rows: T[]; truncated: boolean } {
  return rows.length > n ? { rows: rows.slice(0, n), truncated: true } : { rows, truncated: false };
}

/** `range` query arg (minutes, default 60) clamped to the 5-min bucket grid, capped at 24h. */
export function bucketsFromRangeMinutes(minutes: unknown): number {
  const n = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.trunc(minutes) : 60;
  if (n / 5 > MAX_BUCKETS) {
    throw new McpToolError(`range exceeds 24h (max ${MAX_BUCKETS * 5}m) — use nfm_history for longer ranges`);
  }
  return Math.max(1, Math.min(MAX_BUCKETS, Math.ceil(n / 5)));
}

export class McpToolError extends Error {}

interface JsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function cacheKey(tool: string, args: Record<string, unknown>): string {
  return `mcp:${tool}:${JSON.stringify(args, Object.keys(args).sort())}`;
}

export const TOOLS: McpTool[] = [
  {
    name: 'nfm_schema',
    description: 'Available monitors, metrics, and namespaces — call first to know what data exists before querying.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [topology, cw] = await Promise.all([getTopology(), getNfmMetrics().catch(() => ({}))]);
      const monitors = buildMonitorList(cw).map((m) => m.name);
      const namespaces = [...new Set((topology?.nodes ?? []).map((n) => n.namespace).filter(Boolean))];
      return {
        monitors,
        namespaces,
        metrics: ['DATA_TRANSFERRED', 'RETRANSMISSIONS', 'TIMEOUTS', 'ROUND_TRIP_TIME'],
        dataAvailability: 'Live lenses: rolling 24h window (5-min buckets). Longer/arbitrary ranges: nfm_history (Athena archive).',
      };
    },
  },
  {
    name: 'nfm_overview',
    description: 'Fleet-wide at-a-glance status: KPIs (data transferred, retransmissions, timeouts, RTT p50/p95, network health indicator), a composite health summary (scorecard/efficiency/DNS), and collector coverage/collection status. The single best entry point for "how healthy is the fleet right now".',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [status, coverage, series, flows, dns] = await Promise.all([
        getCollectionStatus(),
        getCoverage(),
        getNfmMetrics(60).catch(() => ({})),
        getFlowsWindow(12),
        getDns().catch(() => null),
      ]);
      const { kpis, rttP50, rttP95, nhi } = buildOverviewKpis(series);
      const summary = overviewSummary(flows, {
        byMonitor: healthByMonitor(series), dns, windowSeconds: 12 * 300,
      });
      return { kpis, rttP50, rttP95, nhi, status, coverage, summary };
    },
  },
  {
    name: 'nfm_infra_topology',
    description: 'nfm-dashboard\'s OWN request/data path — CloudFront -> ALB -> ECS -> {DynamoDB, Athena/S3, Bedrock, AgentCore, Cognito}. Static (CDK-derived), not live-queried. Use this to answer "where does traffic actually flow, end to end" for THIS app\'s infrastructure. For pod-to-pod flows inside the EKS clusters this product monitors, use nfm_topology instead — that is a different, live-queried graph.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ nodes: INFRA_NODES, edges: INFRA_EDGES }),
  },
  {
    name: 'nfm_topology',
    description: 'Pod-to-pod / service topology snapshot: nodes and edges with per-metric totals.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'max edges, default 30' } } },
    handler: async (args) => {
      const topology = await getTopology();
      const { rows: edges, truncated } = bound(topology?.edges ?? [], Number(args.limit) || MAX_ROWS);
      return { generatedAt: topology?.generatedAt ?? null, nodes: topology?.nodes ?? [], edges, truncated };
    },
  },
  {
    name: 'nfm_top_talkers',
    description: 'Top edges by a metric (default DATA_TRANSFERRED) from the current topology snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['DATA_TRANSFERRED', 'RETRANSMISSIONS', 'TIMEOUTS', 'ROUND_TRIP_TIME'] },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      const metric = (args.metric as MetricName) || 'DATA_TRANSFERRED';
      const topology = await getTopology();
      const sorted = [...(topology?.edges ?? [])]
        .filter((e: TopoEdge) => e.metrics[metric] !== undefined)
        .sort((a, b) => (b.metrics[metric] ?? 0) - (a.metrics[metric] ?? 0));
      const { rows, truncated } = bound(sorted, Number(args.limit) || 20);
      return { metric, edges: rows, truncated };
    },
  },
  {
    name: 'nfm_pod_flows',
    description: 'Recent flow records for a specific pod (as source or destination).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        pod: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['namespace', 'pod'],
    },
    handler: async (args) => {
      const namespace = String(args.namespace ?? '');
      const pod = String(args.pod ?? '');
      if (!namespace || !pod) throw new McpToolError('namespace and pod are required');
      const limit = Math.min(Number(args.limit) || MAX_ROWS, MAX_ROWS);
      const flows = await queryPodFlows(namespace, pod, limit);
      return { flows };
    },
  },
  {
    name: 'nfm_cost_lens',
    description: 'Cross-AZ/cross-VPC data-transfer USD attribution: top cost contributors and category breakdown.',
    inputSchema: { type: 'object', properties: { range: { type: 'number', description: 'minutes, default 60, max 1440' } } },
    handler: async (args) => {
      const buckets = bucketsFromRangeMinutes(args.range);
      return cachedLens(cacheKey('nfm_cost_lens', args), async () => {
        const flows = await getFlowsWindow(buckets);
        const lens = costLens(flows);
        return { ...lens, top: bound(lens.top, MAX_ROWS).rows };
      });
    },
  },
  {
    name: 'nfm_latency_lens',
    description: 'RTT percentiles, intra- vs inter-AZ latency, and slowest paths.',
    inputSchema: { type: 'object', properties: { range: { type: 'number' } } },
    handler: async (args) => {
      const buckets = bucketsFromRangeMinutes(args.range);
      return cachedLens(cacheKey('nfm_latency_lens', args), async () => {
        const lens = latencyLens(await getFlowsWindow(buckets));
        return {
          ...lens,
          slowest: bound(lens.slowest, MAX_ROWS).rows,
          slowestTail: bound(lens.slowestTail, MAX_ROWS).rows,
        };
      });
    },
  },
  {
    name: 'nfm_reliability_lens',
    description: 'Retransmission/timeout rate hotspots, threshold breaches, and NHI (network-health-indicator) timeline.',
    inputSchema: { type: 'object', properties: { range: { type: 'number' } } },
    handler: async (args) => {
      const buckets = bucketsFromRangeMinutes(args.range);
      return cachedLens(cacheKey('nfm_reliability_lens', args), async () => {
        const flows = await getFlowsWindow(buckets);
        const lens = reliabilityLens(flows);
        return {
          ...lens,
          hotspots: bound(lens.hotspots, MAX_ROWS).rows,
          breaches: bound(lens.breaches, MAX_ROWS).rows,
        };
      });
    },
  },
  {
    name: 'nfm_anomalies',
    description: 'Statistical (3-sigma) + threshold anomaly detection over a window-over-window comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'number' },
        sigma: { type: 'number', description: `default ${DEFAULT_SIGMA}` },
      },
    },
    handler: async (args) => {
      const buckets = bucketsFromRangeMinutes(args.range);
      return cachedLens(cacheKey('nfm_anomalies', args), async () => {
        const { current, prior } = await getFlowsWindowPair(buckets);
        const anomalies = detectAnomalies(current, prior, {
          retransThreshold: DEFAULT_RETRANS_RATE,
          timeoutThreshold: DEFAULT_TIMEOUT_RATE,
          sigma: Number(args.sigma) || DEFAULT_SIGMA,
        });
        return bound(anomalies, MAX_ROWS);
      });
    },
  },
  {
    name: 'nfm_alerts',
    description: 'Combined signal view: CloudWatch alarm states, derived events (NHI/reliability/collection), and composite (multi-signal) breaches.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [alarms, cwSeries, flows, pair, history] = await Promise.all([
        getAlarms(),
        getNfmMetrics().catch(() => ({})),
        getFlowsWindow(),
        getFlowsWindowPair(6),
        getCollectionHistory(),
      ]);
      const nhiByMonitor = Object.values(cwSeries)
        .filter((s) => s.metric === 'HealthIndicator')
        .map((s) => ({ monitor: s.monitor, degraded: (s.values[s.values.length - 1] ?? 0) > 0 }));
      const movers = moversLens(pair.current, pair.prior);
      const events = deriveEvents({
        nhiByMonitor,
        breaches: reliabilityLens(flows).breaches,
        collectionHistory: history.map((h) => ({
          cycleTs: h.cycleTs, failed: h.stats.failed, started: h.stats.started, throttled: h.stats.throttled,
        })),
        movers: [...movers.retransmissions, ...movers.timeouts],
      });
      const composite = compositeConditions(pair.current, pair.prior);
      return { alarms, events: bound(events, MAX_ROWS).rows, composite: bound(composite, MAX_ROWS).rows };
    },
  },
  {
    name: 'nfm_history',
    description: 'Long-range flow history from the Parquet archive (beyond the 24h live window). Requires from/to dates.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        monitor: { type: 'string' },
        namespace: { type: 'string' },
        metric: { type: 'string' },
        limit: { type: 'number', description: `max ${MAX_HISTORY_LIMIT}` },
      },
      required: ['from', 'to'],
    },
    handler: async (args) => {
      try {
        return await runHistoryQuery({
          from: String(args.from ?? ''),
          to: String(args.to ?? ''),
          monitor: args.monitor ? String(args.monitor) : undefined,
          namespace: args.namespace ? String(args.namespace) : undefined,
          metric: args.metric ? String(args.metric) : undefined,
          limit: Math.min(Number(args.limit) || MAX_HISTORY_LIMIT, MAX_HISTORY_LIMIT),
        });
      } catch (e) {
        if (e instanceof HistoryValidationError) throw new McpToolError(e.message);
        throw e;
      }
    },
  },
];

const toolsByName = new Map(TOOLS.map((t) => [t.name, t]));

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function toSchema({ inputSchema, name, description }: McpTool) {
  return { name, description, inputSchema };
}

/** Dispatches one JSON-RPC 2.0 request. Returns null for notifications (no id → no response). */
export async function handleMcpRequest(req: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  const { id, method, params } = req;
  if (method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'nfm-dashboard', version: '1.0.0' },
    } };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(toSchema) } };
  }

  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const tool = toolsByName.get(name);
    if (!tool) {
      return { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true,
      } };
    }
    try {
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      const result = await tool.handler(args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: `error: ${message}` }], isError: true,
      } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}
