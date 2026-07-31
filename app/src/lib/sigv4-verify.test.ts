import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowedMcpCaller, verifyStsCallerIdentity } from './sigv4-verify';

const GCI_URL = 'https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15&X-Amz-Signature=abc';
const GCI_XML = `<GetCallerIdentityResponse><GetCallerIdentityResult>
  <Arn>arn:aws:sts::180294183052:assumed-role/awsops-runtime/session-1</Arn>
  <UserId>AROAEXAMPLE:session-1</UserId>
  <Account>180294183052</Account>
</GetCallerIdentityResult></GetCallerIdentityResponse>`;

describe('verifyStsCallerIdentity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a malformed URL', async () => {
    expect(await verifyStsCallerIdentity('not a url')).toBeNull();
  });

  it('rejects non-https', async () => {
    expect(await verifyStsCallerIdentity('http://sts.amazonaws.com/?Action=GetCallerIdentity')).toBeNull();
  });

  it('rejects a host that is not sts.*.amazonaws.com (SSRF guard)', async () => {
    expect(await verifyStsCallerIdentity('https://evil.example.com/?Action=GetCallerIdentity')).toBeNull();
    expect(await verifyStsCallerIdentity('https://sts.amazonaws.com.evil.com/?Action=GetCallerIdentity')).toBeNull();
  });

  it('accepts a regional STS host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(GCI_XML, { status: 200 })));
    const id = await verifyStsCallerIdentity(
      'https://sts.ap-northeast-2.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
    );
    expect(id?.arn).toBe('arn:aws:sts::180294183052:assumed-role/awsops-runtime/session-1');
  });

  it('rejects a URL whose Action is not GetCallerIdentity', async () => {
    expect(await verifyStsCallerIdentity('https://sts.amazonaws.com/?Action=AssumeRole')).toBeNull();
  });

  it('performs the request and parses the identity on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(GCI_XML, { status: 200 })));
    const id = await verifyStsCallerIdentity(GCI_URL);
    expect(id).toEqual({
      account: '180294183052',
      arn: 'arn:aws:sts::180294183052:assumed-role/awsops-runtime/session-1',
      userId: 'AROAEXAMPLE:session-1',
    });
  });

  it('returns null on a non-200 (e.g. an invalid/expired signature)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<Error/>', { status: 403 })));
    expect(await verifyStsCallerIdentity(GCI_URL)).toBeNull();
  });

  it('returns null on a network error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await verifyStsCallerIdentity(GCI_URL)).toBeNull();
  });

  it('returns null when the response body is missing an expected tag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<GetCallerIdentityResponse/>', { status: 200 })));
    expect(await verifyStsCallerIdentity(GCI_URL)).toBeNull();
  });
});

describe('isAllowedMcpCaller', () => {
  const account = '180294183052';

  it('matches an assumed-role allowlist entry against any session', () => {
    const id = { account, arn: `arn:aws:sts::${account}:assumed-role/awsops-runtime/session-xyz`, userId: 'x' };
    expect(isAllowedMcpCaller(id, account, ['assumed-role/awsops-runtime'])).toBe(true);
  });

  it('rejects a different role name', () => {
    const id = { account, arn: `arn:aws:sts::${account}:assumed-role/some-other-role/session-1`, userId: 'x' };
    expect(isAllowedMcpCaller(id, account, ['assumed-role/awsops-runtime'])).toBe(false);
  });

  it('rejects a role-name prefix collision (assumed-role/awsops-runtime-2 must not match awsops-runtime)', () => {
    const id = { account, arn: `arn:aws:sts::${account}:assumed-role/awsops-runtime-2/session-1`, userId: 'x' };
    expect(isAllowedMcpCaller(id, account, ['assumed-role/awsops-runtime'])).toBe(false);
  });

  it('matches an exact ARN entry', () => {
    const id = { account, arn: `arn:aws:iam::${account}:user/ci-bot`, userId: 'x' };
    expect(isAllowedMcpCaller(id, account, [`arn:aws:iam::${account}:user/ci-bot`])).toBe(true);
  });

  it('rejects a matching ARN from a different account (defense in depth)', () => {
    const id = { account: '999999999999', arn: `arn:aws:sts::${account}:assumed-role/awsops-runtime/session-1`, userId: 'x' };
    expect(isAllowedMcpCaller(id, account, ['assumed-role/awsops-runtime'])).toBe(false);
  });

  it('denies everything when the allowlist is empty (fail-closed default)', () => {
    const id = { account, arn: `arn:aws:sts::${account}:assumed-role/awsops-runtime/session-1`, userId: 'x' };
    expect(isAllowedMcpCaller(id, account, [])).toBe(false);
  });
});
