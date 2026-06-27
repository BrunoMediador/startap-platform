import { getServerAceiteStatus, getServerSession } from '@/lib/server-auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AceiteGate } from './aceite-gate';

export const metadata: Metadata = {
  title: 'Aceite os termos · Startap',
  description: 'Aceite os Termos de Uso e a Política de Privacidade para continuar.',
};

/**
 * Tela BLOQUEANTE de aceite pós-login (SCRUM-1, fluxo 2). Fica FORA do grupo (app)
 * (sem shell/menu) pra ser um beco com uma saída só: aceitar (ou sair).
 *
 * Guards server-side:
 *  - sem sessão -> /login.
 *  - já aceitou a versão vigente (ou API fora = fail-open) -> volta pro app (/inicio):
 *    evita loop com o redirect do layout do (app) e não mostra o gate à toa.
 *  - precisa aceitar -> renderiza o gate.
 */
export default async function AceitePage() {
  const session = await getServerSession();
  if (!session) redirect('/login');

  const status = await getServerAceiteStatus();
  if (!status?.needs_acceptance) redirect('/inicio');

  return <AceiteGate />;
}
