// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';
import { SESSION_COOKIE_NAME } from '@/lib/auth';

// Real safeEqual/SESSION_COOKIE_NAME; only the network-bound JWT verify is stubbed.
vi.mock('@/lib/auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...mod,
    verifyIdToken: vi.fn(async (token: string) =>
      token === 'valid-token' ? { email: 'admin@example.com' } : null),
  };
});

const req = (path: string, init?: { cookie?: string; originVerify?: string; authorization?: string }) => {
  const headers = new Headers();
  if (init?.cookie) headers.set('cookie', init.cookie);
  if (init?.originVerify) headers.set('x-origin-verify', init.originVerify);
  if (init?.authorization) headers.set('authorization', init.authorization);
  return new NextRequest(`https://app.example${path}`, { headers });
};

afterEach(() => vi.unstubAllEnvs());

describe('session gate (default: auth enforced)', () => {
  it('redirects unauthenticated page requests to /login', async () => {
    const res = await middleware(req('/topology'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.example/login');
  });

  it('returns 401 JSON for unauthenticated API requests', async () => {
    const res = await middleware(req('/api/flows'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('lets a valid session cookie through', async () => {
    const res = await middleware(req('/topology', { cookie: `${SESSION_COOKIE_NAME}=valid-token` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('AUTH_DISABLED=1 (operator toggle, honored in production — ADR-005)', () => {
  it('skips the session gate for pages and APIs', async () => {
    vi.stubEnv('AUTH_DISABLED', '1');
    for (const path of ['/topology', '/api/flows']) {
      const res = await middleware(req(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get('location'), path).toBeNull();
    }
  });

  it('still enforces the x-origin-verify perimeter (missing/wrong header → 403)', async () => {
    vi.stubEnv('AUTH_DISABLED', '1');
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 's3cret');
    expect((await middleware(req('/topology'))).status).toBe(403);
    expect((await middleware(req('/api/flows', { originVerify: 'wrong' }))).status).toBe(403);
    expect((await middleware(req('/topology', { originVerify: 's3cret' }))).status).toBe(200);
  });
});

describe('/api/mcp perimeter (ADR-012/013 — bearer + SigV4, not the Cognito gate)', () => {
  it('404s (route does not exist) when no bearer token is configured', async () => {
    expect((await middleware(req('/api/mcp'))).status).toBe(404);
  });

  it('401s a wrong bearer token', async () => {
    vi.stubEnv('MCP_BEARER_TOKEN', 'right-token');
    const r = req('/api/mcp', { authorization: 'Bearer wrong-token' });
    expect((await middleware(r)).status).toBe(401);
  });

  it('accepts the correct bearer token', async () => {
    vi.stubEnv('MCP_BEARER_TOKEN', 'right-token');
    const r = req('/api/mcp', { authorization: 'Bearer right-token' });
    expect((await middleware(r)).status).toBe(200);
  });

  it('401s an AWS4-GetCallerIdentity header when SigV4 verification fails (malformed URL) — never falls through to bearer', async () => {
    vi.stubEnv('MCP_BEARER_TOKEN', 'right-token'); // configured, but must not be consulted
    const r = req('/api/mcp', { authorization: 'AWS4-GetCallerIdentity not-a-url' });
    expect((await middleware(r)).status).toBe(401);
  });

  it('401s when no allowlist is configured, even with a bearer token also set', async () => {
    vi.stubEnv('MCP_ACCOUNT_ID', '180294183052');
    vi.stubEnv('MCP_ALLOWED_CALLERS', ''); // empty → fail-closed
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<R><Arn>arn:aws:sts::180294183052:assumed-role/awsops-runtime/s1</Arn>' +
      '<UserId>u</UserId><Account>180294183052</Account></R>', { status: 200 })));
    const r = req('/api/mcp', { authorization: 'AWS4-GetCallerIdentity https://sts.amazonaws.com/?Action=GetCallerIdentity' });
    expect((await middleware(r)).status).toBe(401);
    vi.unstubAllGlobals();
  });

  it('accepts a SigV4 caller matching the configured allowlist', async () => {
    vi.stubEnv('MCP_ACCOUNT_ID', '180294183052');
    vi.stubEnv('MCP_ALLOWED_CALLERS', 'assumed-role/awsops-runtime');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<R><Arn>arn:aws:sts::180294183052:assumed-role/awsops-runtime/s1</Arn>' +
      '<UserId>u</UserId><Account>180294183052</Account></R>', { status: 200 })));
    const r = req('/api/mcp', { authorization: 'AWS4-GetCallerIdentity https://sts.amazonaws.com/?Action=GetCallerIdentity' });
    expect((await middleware(r)).status).toBe(200);
    vi.unstubAllGlobals();
  });
});

describe('paths exempt from the session gate in both modes', () => {
  it('always passes the ALB healthcheck, even without the origin header', async () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 's3cret');
    expect((await middleware(req('/api/health'))).status).toBe(200);
  });

  it('keeps /login and /api/auth/* public when auth is enforced', async () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 's3cret');
    for (const path of ['/login', '/api/auth/login']) {
      const res = await middleware(req(path, { originVerify: 's3cret' }));
      expect(res.status, path).toBe(200);
      expect(res.headers.get('location'), path).toBeNull();
    }
  });
});
