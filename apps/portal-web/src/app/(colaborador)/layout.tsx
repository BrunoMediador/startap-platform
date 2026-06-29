import { ColaboradorSessionProvider } from '@/components/colaborador/colaborador-session-context';
import { ColaboradorShell } from '@/components/colaborador/colaborador-shell';
import { ParticleField } from '@/components/fx/particle-field';
import { getServerColaboradorSession } from '@/lib/server-auth';
import { redirect } from 'next/navigation';

/**
 * Shell do painel READ-ONLY do colaborador (SCRUM-32). Guard server-side: chama
 * /auth/colaborador/me — só passa quem tem sessão role='colaborador' E a flag
 * COLABORADOR_PORTAL_ENABLED ligada; qualquer outro caso (dono, deslogado, flag
 * off) -> /login. A identidade (slot/colaboradorId) vem SEMPRE do servidor.
 *
 * Fundo vivo + tema escuro único como o resto do portal: a constelação (appbg)
 * fica fixa atrás (z-[-1]); o shell é bg-surface sólido e cobre o canvas nos vãos.
 */
export default async function ColaboradorLayout({ children }: { children: React.ReactNode }) {
  const colaborador = await getServerColaboradorSession();
  if (!colaborador) redirect('/login');

  return (
    <ColaboradorSessionProvider
      slot={colaborador.slot}
      colaboradorId={colaborador.colaborador_id}
      displayName={colaborador.display_name}
      username={colaborador.username}
      timezone={colaborador.timezone ?? null}
    >
      <ParticleField variant="appbg" />
      <div className="app-vignette pointer-events-none fixed inset-0 z-[-1]" aria-hidden />
      <ColaboradorShell displayName={colaborador.display_name}>{children}</ColaboradorShell>
    </ColaboradorSessionProvider>
  );
}
