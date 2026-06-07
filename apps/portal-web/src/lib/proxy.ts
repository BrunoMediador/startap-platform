/**
 * Proxy de runtime para o portal-api.
 *
 * POR QUE EXISTE: o `rewrites()` do next.config resolve `PORTAL_API_URL` em BUILD
 * TIME. No build do Docker a var nao existe, entao o default `localhost:3051`
 * ficava gravado no bundle e o login quebrava em prod (ECONNREFUSED). Aqui o
 * destino e lido de `process.env.PORTAL_API_URL` A CADA REQUEST (server runtime),
 * entao a env do container vale e nenhum rebuild e necessario pra mudar o destino.
 *
 * O que ele preserva no caminho browser <-> portal-api:
 *   - method, query string e path completos
 *   - headers de entrada (menos os hop-by-hop), incluindo o Cookie de sessao
 *   - body (streaming via duplex, pra POST/PUT funcionarem em Node 20)
 *   - Set-Cookie da resposta — CRITICO: o cookie httpOnly `portal.sid` do
 *     portal-api precisa voltar pro browser, senao o login nao persiste.
 *
 * Mesmo dominio publico (app.startap.tech) -> sem CORS, cookie same-origin.
 */
import { NextResponse } from 'next/server';

function apiBase(): string {
  return process.env.PORTAL_API_URL ?? 'http://localhost:3051';
}

/**
 * Headers que NAO devem ser repassados (hop-by-hop por RFC 7230 + os que o fetch
 * do Node recalcula sozinho). `host` precisa cair senao o upstream recebe o host
 * publico errado; `content-length` e recalculado pelo runtime.
 */
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // o runtime do Next gere o content-encoding/length da resposta que ele emite.
  'content-encoding',
  'content-length',
]);

/**
 * Repassa a request recebida pro portal-api e devolve a resposta intacta.
 * `prefix` e o segmento de topo (`auth` | `portal`) e `path` os segmentos restantes
 * do catch-all. A query string vem da URL original.
 */
export async function proxyToApi(
  req: Request,
  prefix: 'auth' | 'portal',
  path: string[],
): Promise<Response> {
  const incoming = new URL(req.url);
  const suffix = path.length > 0 ? `/${path.join('/')}` : '';
  const target = `${apiBase()}/${prefix}${suffix}${incoming.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    redirect: 'manual',
    // Sem cache: respostas do portal-api sao por-sessao.
    cache: 'no-store',
  };
  if (hasBody) {
    init.body = req.body;
    // Node 20+ exige duplex: 'half' quando o body e um stream (POST/PUT).
    init.duplex = 'half';
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    // portal-api fora do ar / DNS interno — 502 pro front tratar como erro de rede.
    return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
  }

  const resHeaders = new Headers();
  // `getSetCookie()` preserva multiplos Set-Cookie (Headers.set colapsaria em um).
  for (const [key, value] of upstream.headers) {
    if (key.toLowerCase() === 'set-cookie') continue;
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    resHeaders.set(key, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) {
    resHeaders.append('set-cookie', cookie);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}
