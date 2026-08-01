// Real-time reliability-breach detection for the flow-alerts SNS push.
// Pure functions, no I/O — handler.ts owns reading/writing the dedup state
// and publishing to SNS.
//
// detectReliabilityBreaches is a collector-local port of the 'service'-kind
// path through app/src/lib/analytics/reliability.ts's ratePer+
// thresholdBreaches — deliberately NOT a cross-workspace import (collector's
// esbuild bundle and the Next.js app are separate build pipelines). Keep the
// two in lockstep by hand if thresholds or the entity-key formula change.
import type { EndpointInfo, FlowEdge } from './types.js';

const UNKNOWN = 'unknown';
// Mirrors app/src/lib/analytics/reliability.ts DEFAULT_RETRANS_RATE/DEFAULT_TIMEOUT_RATE.
export const RETRANS_THRESHOLD = 10;
export const TIMEOUT_THRESHOLD = 5;

export interface BreachRow {
  key: string;
  retransRate: number;
  timeoutRate: number;
}

function entityKey(e: EndpointInfo): string {
  const name = e.serviceName ?? e.podName ?? e.ip;
  return name ? `${e.podNamespace ?? UNKNOWN}/${name}` : UNKNOWN;
}

function ratePerGb(events: number, bytes: number): number {
  return bytes === 0 ? 0 : events / Math.max(bytes / 1e9, 1e-9);
}

/** Per-service-entity retransmission/timeout rate breaches over THIS cycle's edges only (no prior-window comparison). */
export function detectReliabilityBreaches(edges: FlowEdge[]): BreachRow[] {
  const acc = new Map<string, { bytes: number; retransmissions: number; timeouts: number }>();
  for (const f of edges) {
    if (f.metric !== 'DATA_TRANSFERRED' && f.metric !== 'RETRANSMISSIONS' && f.metric !== 'TIMEOUTS') continue;
    for (const key of new Set([entityKey(f.a), entityKey(f.b)])) {
      let slot = acc.get(key);
      if (!slot) { slot = { bytes: 0, retransmissions: 0, timeouts: 0 }; acc.set(key, slot); }
      if (f.metric === 'DATA_TRANSFERRED') slot.bytes += f.value;
      else if (f.metric === 'RETRANSMISSIONS') slot.retransmissions += f.value;
      else slot.timeouts += f.value;
    }
  }
  const rows: BreachRow[] = [];
  for (const [key, s] of acc) {
    const retransRate = ratePerGb(s.retransmissions, s.bytes);
    const timeoutRate = ratePerGb(s.timeouts, s.bytes);
    if (retransRate > RETRANS_THRESHOLD || timeoutRate > TIMEOUT_THRESHOLD) {
      rows.push({ key, retransRate, timeoutRate });
    }
  }
  rows.sort((a, b) => b.retransRate - a.retransRate || a.key.localeCompare(b.key));
  return rows;
}

export interface BreachStateDiff {
  started: BreachRow[]; // newly breaching this cycle — push ALARM
  resolved: string[]; // breaching last cycle, not anymore — push OK
}

/**
 * Edge-triggered diff against the prior cycle's breaching-key set: only
 * state TRANSITIONS are returned, so a breach that persists for many
 * cycles produces exactly one ALARM (on onset) and one OK (on recovery),
 * not one message per 5-minute cycle it remains breaching.
 */
export function diffBreachState(current: BreachRow[], priorKeys: string[]): BreachStateDiff {
  const priorSet = new Set(priorKeys);
  const currentSet = new Set(current.map((r) => r.key));
  return {
    started: current.filter((r) => !priorSet.has(r.key)),
    resolved: priorKeys.filter((k) => !currentSet.has(k)),
  };
}
