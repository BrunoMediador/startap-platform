/**
 * Guarda de autenticacao server-side (RSC). Le o cookie de sessao da request e
 * chama o portal-api /auth/me direto (rede interna, sem passar pelo proxy do
 * Next) encaminhando o cookie. Retorna o tenant ({ username, slot }) ou null.
 *
 * Usado pelo layout do grupo (app) pra redirecionar deslogados ao /login, e pelo
 * /login pra mandar logados direto pra home. Server-only.
 */
import { cookies } from 'next/headers';
import type { AceiteStatus, AuthMe, ColaboradorMe, StatusResponse } from './api-types';

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

/**
 * Sessão de COLABORADOR (SCRUM-32). Chama /auth/colaborador/me (withColaborador):
 * só responde 200 quando o cookie é de uma sessão role='colaborador' E a flag
 * COLABORADOR_PORTAL_ENABLED está ON — senão 403/404 -> null. Usado pelo guard do
 * grupo (colaborador) pra mandar quem não é colaborador de volta ao /login. A
 * identidade (colaborador_id/slot) vem SEMPRE da sessão, nunca do client.
 */
export function getServerColaboradorSession(): Promise<ColaboradorMe | null> {
  return serverGet<ColaboradorMe>('/auth/colaborador/me');
}

/** Nome do negocio (display_name) pro shell. Fallback no slot se indisponivel. */
export async function getServerBusinessName(fallback: string): Promise<string> {
  const status = await serverGet<StatusResponse>('/portal/status');
  return status?.display_name ?? fallback;
}

/**
 * Status do aceite dos Termos/Privacidade do tenant logado (SCRUM-1, fluxo 2). Usado
 * pelo guard do shell (app) pra redirecionar ao /aceite quem ainda nao aceitou a versao
 * vigente. FAIL-OPEN: se o portal-api estiver indisponivel (null), NAO bloqueia o app
 * (um blip de rede nao tranca o cliente pra fora) — o gate reaparece na proxima
 * navegacao quando a API voltar. A prova so e gravada no aceite explicito (POST).
 */
export function getServerAceiteStatus(): Promise<AceiteStatus | null> {
  return serverGet<AceiteStatus>('/portal/aceite/status');
}
