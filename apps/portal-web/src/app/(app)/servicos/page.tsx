import { redirect } from 'next/navigation';

/**
 * `/servicos` virou sub-aba `/negocio/servicos` (SCRUM-157). Redirect DENTRO do
 * grupo `(app)` (não em `next.config.ts`): redirect de config roda ANTES do guard
 * de sessão de `layout.tsx:26` (deslogado seria mandado direto ao destino em vez
 * de `/login`) — o próprio `next.config.ts:5-12` documenta build-time redirect
 * quebrando o login em prod.
 */
export default function ServicosRedirectPage() {
  redirect('/negocio/servicos');
}
