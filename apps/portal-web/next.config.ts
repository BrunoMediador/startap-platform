import type { NextConfig } from 'next';

/**
 * portal-web — Next.js 15 (App Router), output standalone (ADR 0012, Decisao 5).
 *
 * O proxy de /auth/* e /portal/* para o portal-api NAO mora mais aqui: rewrites
 * resolvem PORTAL_API_URL em BUILD TIME e, no build do Docker (sem a var), o
 * default `localhost:3051` ficava baked no bundle e quebrava o login em prod.
 * Agora o proxy e feito por route handlers de runtime que leem PORTAL_API_URL a
 * cada request — ver src/app/auth/[...path]/route.ts, src/app/portal/[...path]/
 * route.ts e src/lib/proxy.ts.
 *
 * Mesmo dominio publico (app.startap.tech) -> sem CORS; o cookie httpOnly de
 * sessao passa same-origin. O portal-api fica na rede interna, nunca exposto.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
