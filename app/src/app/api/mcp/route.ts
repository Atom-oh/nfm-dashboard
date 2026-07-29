import { handleMcpRequest } from '@/lib/mcp-server';

export const dynamic = 'force-dynamic';

// Auth (Bearer token) is enforced in middleware.ts before this handler runs.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || !('method' in body)) {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, { status: 400 });
  }
  const result = await handleMcpRequest(body as { id?: string | number | null; method: string; params?: Record<string, unknown> });
  if (result === null) return new Response(null, { status: 204 }); // notification — no reply
  return Response.json(result);
}
