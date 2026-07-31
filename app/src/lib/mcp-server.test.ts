import { describe, it, expect } from 'vitest';
import { TOOLS, handleMcpRequest, bound, bucketsFromRangeMinutes, McpToolError } from './mcp-server';

describe('handleMcpRequest — protocol shape', () => {
  it('initialize advertises tools capability', async () => {
    const res = await handleMcpRequest({ id: 1, method: 'initialize' });
    expect(res?.result).toMatchObject({ capabilities: { tools: {} } });
  });

  it('tools/list returns exactly the 12 catalog tools, all nfm_-prefixed and unique', async () => {
    const res = await handleMcpRequest({ id: 1, method: 'tools/list' });
    const tools = (res?.result as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
    expect(tools).toHaveLength(12);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // unique
    for (const name of names) expect(name).toMatch(/^nfm_/);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('unknown method returns JSON-RPC -32601', async () => {
    const res = await handleMcpRequest({ id: 1, method: 'bogus/method' });
    expect(res?.error).toMatchObject({ code: -32601 });
  });

  it('unknown tool name in tools/call returns an isError content block, not a JSON-RPC error', async () => {
    const res = await handleMcpRequest({
      id: 1, method: 'tools/call', params: { name: 'not_a_real_tool', arguments: {} },
    });
    const result = res?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown tool');
  });

  it('notification (no reply expected) returns null', async () => {
    const res = await handleMcpRequest({ method: 'notifications/initialized' });
    expect(res).toBeNull();
  });
});

describe('bound', () => {
  it('passes rows through untouched when under the cap', () => {
    const { rows, truncated } = bound([1, 2, 3], 5);
    expect(rows).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
  });

  it('truncates and flags when over the cap', () => {
    const { rows, truncated } = bound([1, 2, 3, 4, 5], 3);
    expect(rows).toEqual([1, 2, 3]);
    expect(truncated).toBe(true);
  });
});

describe('bucketsFromRangeMinutes', () => {
  it('defaults to 60 minutes (12 buckets) when omitted', () => {
    expect(bucketsFromRangeMinutes(undefined)).toBe(12);
  });

  it('rounds up to the nearest 5-min bucket', () => {
    expect(bucketsFromRangeMinutes(61)).toBe(13);
  });

  it('accepts exactly the 24h cap', () => {
    expect(bucketsFromRangeMinutes(24 * 60)).toBe(288);
  });

  it('rejects a range beyond 24h, pointing at nfm_history', () => {
    expect(() => bucketsFromRangeMinutes(24 * 60 + 5)).toThrow(McpToolError);
    expect(() => bucketsFromRangeMinutes(24 * 60 + 5)).toThrow(/nfm_history/);
  });
});
