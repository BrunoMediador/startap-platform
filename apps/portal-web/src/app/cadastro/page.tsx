import { getServerSession } from '@/lib/server-auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CadastroForm } from './cadastro-form';

export const metadata: Metadata = {
  title: 'Criar conta · Startap',
  description: 'Teste grátis por 10 dias. Sem cartão.',
};

/**
 * Cadastro self-service (Missao 020 F1) — rota PUBLICA, linkada na landing
 * ("Quero testar grátis") e no login ("Criar conta grátis"). O link pode
 * existir mesmo com PORTAL_SIGNUP OFF: o backend devolve 404 e o form mostra
 * o estado "indisponivel". Ja logado pula pro app, igual /login.
 */
export default async function CadastroPage() {
  const session = await getServerSession();
  if (session) redirect('/inicio');
  return <CadastroForm />;
}
