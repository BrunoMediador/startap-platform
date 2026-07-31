import { redirect } from 'next/navigation';

/**
 * `/perfil` virou a tela "Meu negócio" com sub-abas, e a página em si foi
 * extraída pra `/negocio/dados` (SCRUM-157). Redirect DENTRO do grupo `(app)`
 * (não em `next.config.ts`) — mesmo motivo de `/servicos/page.tsx`.
 */
export default function PerfilRedirectPage() {
  redirect('/negocio/dados');
}
