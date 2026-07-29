import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, safeEqual, verifyIdToken } from '@/lib/auth';

const PUBLIC_PATHS = ['/login', '/api/health', '/favicon.ico'];
const PUBLIC_PREFIXES = ['/api/auth/', '/_next/'];
// Static assets served from /public (images, fonts, manifest, …).
const STATIC_FILE = /\.(?:ico|png|svg|jpg|jpeg|gif|webp|css|js|map|txt|xml|json|woff2?)$/;

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) ||
    // Static asset extensions never bypass auth for API paths.
    (!pathname.startsWith('/api/') && STATIC_FILE.test(pathname))
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ALB target-group healthcheck hits the container directly (no CloudFront header).
  if (pathname === '/api/health') return NextResponse.next();

  // CloudFront → ALB origin verification (skipped when unset, e.g. local dev).
  // Constant-time (digest-based) compare: header timing must not leak the secret.
  // Runs BEFORE the AUTH_DISABLED bypass below: the toggle relaxes only the
  // user-session gate, never the CloudFront-origin perimeter.
  const originSecret = process.env.ORIGIN_VERIFY_SECRET;
  if (originSecret && !(await safeEqual(req.headers.get('x-origin-verify') ?? '', originSecret))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // MCP data-source egress (ADR-012) — a separate bearer-token perimeter, not
  // the Cognito session gate: awsops (a different AWS account) can't hold a
  // Cognito session here. Fails closed: no token configured → route doesn't
  // exist. Origin-verify above still applies, so a direct-to-ALB bypass of
  // CloudFront is still 403 regardless of bearer.
  if (pathname === '/api/mcp') {
    const expected = process.env.MCP_BEARER_TOKEN;
    if (!expected) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const got = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    if (!(await safeEqual(got, expected))) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) return NextResponse.next();

  // Session-gate toggle: local dev without Cognito, or a deliberate operator
  // decision in production (infra `authDisabled` CDK context → task-def env,
  // ADR-005). Cognito stays provisioned — flipping the flag re-enables auth.
  if (process.env.AUTH_DISABLED === '1') return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const user = token ? await verifyIdToken(token) : null;
  if (!user) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', req.url), 302);
  }
  return NextResponse.next();
}

export const config = {
  // Run on pages and api routes; skip build assets for performance.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
