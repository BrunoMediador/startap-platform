import { getServerSession } from '@/lib/server-auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Landing } from './landing';

export const metadata: Metadata = {
  title: 'Startap — Seu WhatsApp atendendo e agendando sozinho',
  description:
    'O robô da Startap responde seus clientes no WhatsApp, marca horários direto na sua agenda e nunca tira folga. Feito pra barbearias, salões e estúdios. 10 dias grátis.',
};

/**
 * Raiz pública (decisão Bruno): logado segue pra /inicio; deslogado vê a
 * LANDING de apresentação do produto (sem redirect pro /login — o login virou
 * botão "Entrar" no topo). A raiz fica fora do grupo (app), então não passa
 * pelo guard de auth do shell; /login segue intacto.
 */
export default async function RootPage() {
  const session = await getServerSession();
  if (session) redirect('/inicio');
  return <Landing />;
}
