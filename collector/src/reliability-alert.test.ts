import { describe, it, expect } from 'vitest';
import { detectReliabilityBreaches, diffBreachState, RETRANS_THRESHOLD, TIMEOUT_THRESHOLD } from './reliability-alert.js';
import type { FlowEdge } from './types.js';

const edge = (overrides: Partial<FlowEdge>): FlowEdge => ({
  edgeHash: 'h', monitor: 'm', metric: 'DATA_TRANSFERRED', category: 'INTER_AZ',
  bucket: '2026-08-01T00:00:00Z', value: 0, unit: 'Bytes',
  a: { podNamespace: 'ns-a', serviceName: 'svc-a' },
  b: { podNamespace: 'ns-b', serviceName: 'svc-b' },
  traversedConstructs: [], ...overrides,
});

describe('detectReliabilityBreaches', () => {
  it('flags an entity whose retransmission rate exceeds the threshold', () => {
    // 1 GB transferred, 11 retransmissions -> 11 events/GB > RETRANS_THRESHOLD (10).
    const edges = [
      edge({ metric: 'DATA_TRANSFERRED', value: 1e9 }),
      edge({ metric: 'RETRANSMISSIONS', value: 11 }),
    ];
    const breaches = detectReliabilityBreaches(edges);
    expect(breaches.map((b) => b.key)).toContain('ns-a/svc-a');
    expect(breaches.map((b) => b.key)).toContain('ns-b/svc-b');
    expect(breaches[0].retransRate).toBeCloseTo(11, 5);
  });

  it('does not flag an entity at or under the threshold', () => {
    const edges = [
      edge({ metric: 'DATA_TRANSFERRED', value: 1e9 }),
      edge({ metric: 'RETRANSMISSIONS', value: RETRANS_THRESHOLD }),
    ];
    expect(detectReliabilityBreaches(edges)).toEqual([]);
  });

  it('flags on timeout rate independently of retransmission rate', () => {
    const edges = [
      edge({ metric: 'DATA_TRANSFERRED', value: 1e9 }),
      edge({ metric: 'TIMEOUTS', value: TIMEOUT_THRESHOLD + 1 }),
    ];
    expect(detectReliabilityBreaches(edges).map((b) => b.key)).toContain('ns-a/svc-a');
  });

  it('ignores ROUND_TRIP_TIME edges entirely (not part of the byte/event tally)', () => {
    const edges = [edge({ metric: 'ROUND_TRIP_TIME', value: 999 })];
    expect(detectReliabilityBreaches(edges)).toEqual([]);
  });

  it('attributes to both endpoints without double-counting a self-referencing pair', () => {
    const edges = [
      edge({
        metric: 'RETRANSMISSIONS', value: 20,
        a: { podNamespace: 'ns', serviceName: 'svc' }, b: { podNamespace: 'ns', serviceName: 'svc' },
      }),
      edge({
        metric: 'DATA_TRANSFERRED', value: 1e9,
        a: { podNamespace: 'ns', serviceName: 'svc' }, b: { podNamespace: 'ns', serviceName: 'svc' },
      }),
    ];
    const breaches = detectReliabilityBreaches(edges);
    expect(breaches).toHaveLength(1); // one entity, not two despite a===b
    expect(breaches[0].retransRate).toBeCloseTo(20, 5);
  });

  it('sorts descending by retransRate', () => {
    const edges = [
      edge({ metric: 'DATA_TRANSFERRED', value: 1e9, a: { serviceName: 'low' }, b: { serviceName: 'x1' } }),
      edge({ metric: 'RETRANSMISSIONS', value: 15, a: { serviceName: 'low' }, b: { serviceName: 'x1' } }),
      edge({ metric: 'DATA_TRANSFERRED', value: 1e9, a: { serviceName: 'high' }, b: { serviceName: 'x2' } }),
      edge({ metric: 'RETRANSMISSIONS', value: 50, a: { serviceName: 'high' }, b: { serviceName: 'x2' } }),
    ];
    const keys = detectReliabilityBreaches(edges).map((b) => b.key);
    expect(keys.indexOf('unknown/high')).toBeLessThan(keys.indexOf('unknown/low'));
  });
});

describe('diffBreachState', () => {
  it('reports a fresh breach as started, nothing resolved, when prior state is empty', () => {
    const current = [{ key: 'ns/a', retransRate: 20, timeoutRate: 0 }];
    expect(diffBreachState(current, [])).toEqual({ started: current, resolved: [] });
  });

  it('reports nothing when the same breach persists across cycles (no per-cycle spam)', () => {
    const current = [{ key: 'ns/a', retransRate: 20, timeoutRate: 0 }];
    expect(diffBreachState(current, ['ns/a'])).toEqual({ started: [], resolved: [] });
  });

  it('reports a recovered entity as resolved', () => {
    expect(diffBreachState([], ['ns/a'])).toEqual({ started: [], resolved: ['ns/a'] });
  });

  it('reports independent started/resolved sets when the breaching population shifts', () => {
    const current = [{ key: 'ns/new', retransRate: 20, timeoutRate: 0 }];
    expect(diffBreachState(current, ['ns/old'])).toEqual({ started: current, resolved: ['ns/old'] });
  });
});
