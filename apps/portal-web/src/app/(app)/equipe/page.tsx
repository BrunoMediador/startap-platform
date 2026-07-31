import { redirect } from 'next/navigation';

/**
 * `/equipe` virou sub-aba `/negocio/equipe` (SCRUM-157). Redirect DENTRO do
 * grupo `(app)` (não em `next.config.ts`) — mesmo motivo de `/servicos/page.tsx`.
 */
export default function EquipeRedirectPage() {
  redirect('/negocio/equipe');
}
