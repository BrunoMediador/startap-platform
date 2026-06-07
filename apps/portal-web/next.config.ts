import type { NextConfig } from 'next';

/**
 * portal-web — Next.js 15 (App Router), output standalone (ADR 0012, Decisao 5).
 *
 * Proxy/rewrite de /portal/* e /auth/* para o portal-api (rede interna, porta
 * 3051). Mesmo domINIO publico (app.startap.tech) -> sem CORS, o cookie de sessao
 * httpOnly assinado passa direto. A internet so enxerga o Next; o portal-api fica
 * na rede automacoes_rede_interna e nunca e exposto.
 *
 * PORTAL_API_URL define o destino do proxy:
 *   - dev local:  http://localhost:3051
 *   - container:  http://startap-portal-api:3051 (nome do servico no compose)
 */
const PORTAL_API_URL = process.env.PORTAL_API_URL ?? 'http://localhost:3051';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: '/auth/:path*', destination: `${PORTAL_API_URL}/auth/:path*` },
      { source: '/portal/:path*', destination: `${PORTAL_API_URL}/portal/:path*` },
    ];
  },
};

export default nextConfig;
