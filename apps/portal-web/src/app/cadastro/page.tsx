import { getServerSession } from '@/lib/server-auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CadastroForm } from './cadastro-form';

export const metadata: Metadata = {
  title: 'Criar conta · Startap',
  description: 'Teste grátis por 10 dias. Sem cartão.',
};

/**
 * Cadastro self-service (Missao 020 F1) — rota PUBLICA, acessivel SO por URL
 * direta enquanto PORTAL_SIGNUP estiver OFF (sem link na landing/login; o link
 * entra quando o Bruno ligar a flag). Com a flag OFF o backend devolve 404 e o
 * form mostra o estado "indisponivel". Ja logado pula pro app, igual /login.
 */
export default async function CadastroPage() {
  const session = await getServerSession();
  if (session) redirect('/inicio');
  return <CadastroForm />;
}
