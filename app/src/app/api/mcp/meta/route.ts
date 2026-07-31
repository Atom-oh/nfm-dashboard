import { TOOLS } from '@/lib/mcp-server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mcp/meta — read-only tool catalog for the Settings page's MCP
 * integration card. Cognito-gated (regular middleware path, NOT the bearer
 * branch): metadata only (name/description/inputSchema), never a handler or
 * the bearer token itself.
 */
export function GET() {
  return Response.json({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  });
}
