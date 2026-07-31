/**
 * Server-to-server auth for `/api/mcp` via the STS GetCallerIdentity
 * forwarding trick — the same mechanism `aws-iam-authenticator` (EKS) and
 * HashiCorp Vault's `auth/aws` method use: we are a plain ALB+ECS endpoint,
 * not an AWS-native service, so we cannot verify an arbitrary SigV4
 * signature ourselves. Instead the caller presigns a real
 * `sts:GetCallerIdentity` request with ITS OWN AWS credentials and hands us
 * the URL; we perform that exact HTTP call against the real STS endpoint —
 * AWS itself validates the signature, and a 200 response's `<Arn>` tells us
 * who signed it. No shared secret ever changes hands; access is revoked by
 * removing the caller's IAM grant, and every call is attributable in
 * CloudTrail as the caller's own identity.
 *
 * Complements, not replaces, the Bearer-token path in `middleware.ts`:
 * SigV4 is for AWS-credentialed server-to-server callers in the SAME
 * account (e.g. awsops's AgentCore runtime role — see ADR-013); Bearer
 * stays for non-AWS-SDK clients (Claude Code CLI's `--header` flag sends a
 * static string, it cannot sign a request).
 */

const STS_HOST_RE = /^sts(\.[a-z0-9-]+)?\.amazonaws\.com$/;
const FETCH_TIMEOUT_MS = 5000;

export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

/** Pulls a well-formed tag's text out of GetCallerIdentityResponse XML — no XML parser needed for 3 flat tags. */
function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

/**
 * Validates `rawUrl` is a genuine STS GetCallerIdentity presigned request —
 * https-only, hostname pinned to a real `sts(.<region>)?.amazonaws.com`
 * domain, action pinned — which blocks SSRF to arbitrary hosts (the
 * hostname pin is the whole guard; there is no path/port to widen). Then
 * performs it with no redirect-following and returns the caller identity on
 * a 200. Returns null on ANY failure (malformed URL, wrong host, non-200,
 * malformed body, network error/timeout) — never throws, so a bad or
 * expired presigned URL degrades to "not this caller," not a 500.
 */
export async function verifyStsCallerIdentity(rawUrl: string): Promise<CallerIdentity | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!STS_HOST_RE.test(url.hostname)) return null;
  if (url.searchParams.get('Action') !== 'GetCallerIdentity') return null;

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    const body = await res.text();
    const arn = extractTag(body, 'Arn');
    const account = extractTag(body, 'Account');
    const userId = extractTag(body, 'UserId');
    if (!arn || !account || !userId) return null;
    return { arn, account, userId };
  } catch {
    return null;
  }
}

/**
 * True iff `identity` is in the SAME account as `expectedAccount` AND its
 * ARN matches one of `allowlist`'s entries. An entry is either:
 *   - an exact ARN (`arn:aws:iam::<acct>:user/foo`), or
 *   - `assumed-role/<RoleName>` — matches ANY session of that role
 *     (`arn:aws:sts::<acct>:assumed-role/<RoleName>/<session>`), since an
 *     assumed-role identity's session name is caller-controlled and unique
 *     per call/runtime invocation, not something an allowlist can pin.
 * Checking `identity.account` independently of the ARN string is
 * deliberate defense in depth against a same-role-name-different-account
 * collision, even though in practice the ARN already encodes the account.
 */
export function isAllowedMcpCaller(
  identity: CallerIdentity,
  expectedAccount: string,
  allowlist: string[],
): boolean {
  if (identity.account !== expectedAccount) return false;
  return allowlist.some((entry) => {
    if (entry.startsWith('assumed-role/')) {
      const roleName = entry.slice('assumed-role/'.length);
      return identity.arn === `arn:aws:sts::${expectedAccount}:assumed-role/${roleName}`
        || identity.arn.startsWith(`arn:aws:sts::${expectedAccount}:assumed-role/${roleName}/`);
    }
    return identity.arn === entry;
  });
}
