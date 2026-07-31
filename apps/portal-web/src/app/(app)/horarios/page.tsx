import { redirect } from 'next/navigation';

/**
 * `/horarios` virou sub-aba `/negocio/horarios` (SCRUM-157). Redirect DENTRO do
 * grupo `(app)` (não em `next.config.ts`) — mesmo motivo de `/servicos/page.tsx`.
 */
export default function HorariosRedirectPage() {
  redirect('/negocio/horarios');
}
