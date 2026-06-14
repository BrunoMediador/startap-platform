/**
 * Catch-all do proxy de /demo/* -> portal-api (runtime, ver lib/proxy.ts).
 *
 * Rota PÚBLICA (sem sessão): a demo "celular" da landing (W6) conversa com a IA
 * sandbox via POST /demo/chat. O contrato (body { messages }, resposta
 * { reply, demo_booking }), o rate-limit e a guarda anti-abuso vivem no
 * portal-api (construído em paralelo por backend/ai-engineer). Aqui só repassa.
 *
 * Mesmo padrão dos proxies de /auth e /portal: PORTAL_API_URL é resolvido a cada
 * request (runtime), nada bakado no build.
 */
import { proxyToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return proxyToApi(req, 'demo', path);
}

export { handle as GET, handle as POST, handle as OPTIONS };
