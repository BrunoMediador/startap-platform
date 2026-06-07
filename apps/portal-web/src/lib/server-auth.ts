/**
 * Guarda de autenticacao server-side (RSC). Le o cookie de sessao da request e
 * chama o portal-api /auth/me direto (rede interna, sem passar pelo proxy do
 * Next) encaminhando o cookie. Retorna o tenant ({ username, slot }) ou null.
 *
 * Usado pelo layout do grupo (app) pra redirecionar deslogados ao /login, e pelo
 * /login pra mandar logados direto pra home. Server-only.
 */
import { cookies } from 'next/headers';
import type { AuthMe, StatusResponse } from './api-types';

const SESSION_COOKIE = 'portal.sid';
const PORTAL_API_URL = process.env.PORTAL_API_URL ?? 'http://localhost:3051';

async function serverGet<T>(path: string): Promise<T | null> {
  const store = await cookies();
  const sid = store.get(SESSION_COOKIE);
  if (!sid) return null;
  try {
    const res = await fetch(`${PORTAL_API_URL}${path}`, {
      headers: { cookie: `${SESSION_COOKIE}=${sid.value}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // portal-api indisponivel — trata como deslogado/sem dados.
    return null;
  }
}

export function getServerSession(): Promise<AuthMe | null> {
  return serverGet<AuthMe>('/auth/me');
}

/** Nome do negocio (display_name) pro shell. Fallback no slot se indisponivel. */
export async function getServerBusinessName(fallback: string): Promise<string> {
  const status = await serverGet<StatusResponse>('/portal/status');
  return status?.display_name ?? fallback;
}
