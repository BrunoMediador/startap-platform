/**
 * Catch-all do proxy de /auth/* -> portal-api (runtime, ver lib/proxy.ts).
 * Substitui o rewrite de next.config que bakava PORTAL_API_URL no build.
 */
import { proxyToApi } from '@/lib/proxy';

// Sempre dinamico: cada request resolve PORTAL_API_URL e repassa cookies.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return proxyToApi(req, 'auth', path);
}

export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
  handle as HEAD,
  handle as OPTIONS,
};
