import { NetworkFlowMonitorClient } from '@aws-sdk/client-networkflowmonitor';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EC2Client } from '@aws-sdk/client-ec2';
import { IAMClient } from '@aws-sdk/client-iam';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { runQueryMatrix } from './nfm-query.js';
import { buildTopology, writeCycle } from './storage.js';
import { categoriesForCycle } from './categories.js';
import { discoverOnboarding } from './onboard.js';
import { collectWorkloadInsights } from './wi-query.js';
import { collectDns } from './dns-collect.js';
import { runRollupStep } from './rollup-store.js';
import { detectReliabilityBreaches, diffBreachState } from './reliability-alert.js';
import type { FlowEdge, MetricName } from './types.js';

const nfm = new NetworkFlowMonitorClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true } });
const ec2 = new EC2Client({}), iam = new IAMClient({});
const cwlogs = new CloudWatchLogsClient({});
const sns = new SNSClient({});

export const handler = async () => {
  const monitorPairs = (process.env.MONITORS ?? '').split(',').filter(Boolean)
    .map(s => s.split('=') as [string, string]);
  const monitorToCluster = Object.fromEntries(monitorPairs.filter(([, c]) => c));
  const now = new Date();
  const bucket = new Date(Math.floor(now.getTime() / 300000) * 300000).toISOString().replace(/\.\d+Z/, 'Z');
  const endTime = new Date(now.getTime() - 2 * 60000);
  const startTime = new Date(now.getTime() - 7 * 60000);
  const coverage = await discoverOnboarding(ec2, iam).catch(err => {
    console.error('onboarding failed', err); return undefined; });
  // Cycle counter persisted in STATUS#collect/latest so the extended-category
  // rotation survives across Lambda invocations.
  const statusLatest = await ddb.send(new GetCommand({ TableName: process.env.TABLE_META!,
    Key: { pk: 'STATUS#collect', sk: 'latest' } }))
    .then(r => r.Item as { cycle?: number } | undefined)
    .catch(err => { console.error('cycle read failed', err); return undefined; });
  const cycle = (statusLatest?.cycle ?? 0) + 1;
  const { edges, stats } = await runQueryMatrix(nfm, {
    monitors: monitorPairs.map(([m]) => m),
    metrics: ['DATA_TRANSFERRED', 'RETRANSMISSIONS', 'TIMEOUTS', 'ROUND_TRIP_TIME'] as MetricName[],
    // `|| 3` (not ??): an empty or non-numeric env value must not silently disable rotation.
    categories: categoriesForCycle(cycle, Number(process.env.EXTENDED_CATEGORY_EVERY) || 3),
    startTime, endTime, bucket, concurrency: Number(process.env.CONCURRENCY ?? 5),
    statusPollMax: 30 });
  const topology = buildTopology(edges, monitorToCluster, now.toISOString());
  await writeCycle(ddb, { flows: process.env.TABLE_FLOWS!, meta: process.env.TABLE_META! },
    { edges, topology, stats, cycleTs: now.toISOString(), coverage, cycle });
  // Real-time reliability-breach push (current-cycle-only; no window-pair
  // comparison). Edge-triggered against ALERTSTATE#reliability so a breach
  // that persists across cycles produces one ALARM + one eventual OK, not a
  // message every 5 minutes. MUST NOT fail the collect cycle.
  await publishReliabilityAlerts(edges, now.toISOString()).catch(err => {
    console.error('reliability alert publish failed', err); });
  const wi = await collectWorkloadInsights(nfm, { startTime, endTime })
    .catch(err => { console.error('wi failed', err); return undefined; });
  if (wi) await ddb.send(new PutCommand({ TableName: process.env.TABLE_META!,
    Item: { pk: 'WI#latest', sk: 'all', rows: wi, cycleTs: now.toISOString() } }));
  // DNS pass every DNS_COLLECT_EVERY cycles (~15 min at rate(5 minutes)).
  if (cycle % (Number(process.env.DNS_COLLECT_EVERY) || 3) === 0) {
    const nowSec = Math.floor(now.getTime() / 1000);
    const dns = await collectDns(cwlogs, {
      coreDnsGroups: (process.env.DNS_CORE_GROUPS ?? '').split(',').map(s => s.trim()).filter(Boolean),
      resolverGroup: process.env.DNS_RESOLVER_GROUP ?? '/nfm-dashboard/resolver-dns',
      startTime: nowSec - 16 * 60, endTime: nowSec, flows: edges })
      .catch(err => { console.error('dns failed', err); return undefined; });
    // Keep-last-good: a transient empty Insights result (enabled:false) must not
    // overwrite a good snapshot and blank the DNS lens until the next pass.
    if (dns?.enabled) await ddb.send(new PutCommand({ TableName: process.env.TABLE_META!,
      Item: { pk: 'DNS#latest', sk: 'all', dns, cycleTs: now.toISOString() } }));
    else if (dns) console.log(JSON.stringify({ level: 'info',
      msg: 'dns aggregate empty — keeping last-good DNS#latest' }));
  }
  // Hour-close rollup (spec 2026-07-15-hourly-rollups): idempotent, <=6 hours
  // per cycle newest-first, auto-backfills from raw rows still inside the 7d
  // TTL. MUST NOT fail the collect cycle.
  const rollup = await runRollupStep({ ddb,
    tables: { flows: process.env.TABLE_FLOWS!, meta: process.env.TABLE_META! },
    monitors: monitorPairs.map(([m]) => m), nowMs: now.getTime() })
    .catch(err => { console.error('rollup failed', err); return { hoursDone: [] as string[] }; });
  console.log(JSON.stringify({ level: 'info', msg: 'cycle done', stats,
    edges: edges.length, rollupHours: rollup.hoursDone.length }));
  return { ok: true, stats };
};

/**
 * Detects this cycle's reliability breaches, diffs against the prior
 * cycle's breaching-key set (ALERTSTATE#reliability/latest), and publishes
 * one SNS message per state TRANSITION (ALARM on new breach, OK on
 * recovery) to FLOW_ALERT_TOPIC_ARN — never one per cycle a breach persists.
 * No-op (and no state write) when FLOW_ALERT_TOPIC_ARN is unset, so this is
 * safe to deploy before the topic exists.
 */
async function publishReliabilityAlerts(edges: FlowEdge[], cycleTs: string): Promise<void> {
  const topicArn = process.env.FLOW_ALERT_TOPIC_ARN;
  if (!topicArn) return;
  const current = detectReliabilityBreaches(edges);
  const stateItem = await ddb.send(new GetCommand({ TableName: process.env.TABLE_META!,
    Key: { pk: 'ALERTSTATE#reliability', sk: 'latest' } }))
    .then(r => r.Item as { keys?: string[] } | undefined);
  const { started, resolved } = diffBreachState(current, stateItem?.keys ?? []);

  const publishes = [
    ...started.map(row => sns.send(new PublishCommand({
      TopicArn: topicArn,
      Subject: `nfm-dashboard reliability breach: ${row.key}`,
      Message: JSON.stringify({ kind: 'reliability_breach', state: 'ALARM', key: row.key,
        retransRate: row.retransRate, timeoutRate: row.timeoutRate, cycleTs }),
      MessageAttributes: {
        kind: { DataType: 'String', StringValue: 'reliability_breach' },
        state: { DataType: 'String', StringValue: 'ALARM' } } }))),
    ...resolved.map(key => sns.send(new PublishCommand({
      TopicArn: topicArn,
      Subject: `nfm-dashboard reliability recovered: ${key}`,
      Message: JSON.stringify({ kind: 'reliability_breach', state: 'OK', key, cycleTs }),
      MessageAttributes: {
        kind: { DataType: 'String', StringValue: 'reliability_breach' },
        state: { DataType: 'String', StringValue: 'OK' } } }))),
  ];
  if (publishes.length) await Promise.all(publishes);

  await ddb.send(new PutCommand({ TableName: process.env.TABLE_META!,
    Item: { pk: 'ALERTSTATE#reliability', sk: 'latest',
      keys: current.map(r => r.key), cycleTs } }));
}
