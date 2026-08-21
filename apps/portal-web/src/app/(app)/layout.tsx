import { ParticleField } from '@/components/fx/particle-field';
import { BottomNav } from '@/components/shell/bottom-nav';
import { ReconnectBanner } from '@/components/shell/reconnect-banner';
import { SessionProvider } from '@/components/shell/session-context';
import { Sidebar } from '@/components/shell/sidebar';
import { TenantTzProvider } from '@/components/shell/tenant-tz-context';
import { Topbar } from '@/components/shell/topbar';
import { UnsavedChangesProvider } from '@/components/shell/unsaved-changes-context';
import { getServerAceiteStatus, getServerBusinessName, getServerSession } from '@/lib/server-auth';
import { redirect } from 'next/navigation';

/**
 * Shell do app autenticado (spec 2). Guard server-side: sem sessao -> /login.
 * Layout: mobile = topbar + scroll + bottom nav; >=md = sidebar lateral + topo.
 * O business name vem do /portal/status (server) com fallback no slot.
 *
 * Fundo vivo (decisao Bruno): a constelacao do login (`ParticleField` nivel-login,
 * com linha ao cursor) vive AQUI, montada uma unica vez no shell -> persiste
 * entre navegacoes (Inicio/Horarios/Servicos/Pausas) sem remount/flash. Fica
 * fixa no viewport ATRAS do conteudo (z-[-1], ver `.app-bg`); sidebar/topbar/
 * bottom-nav e cards sao `bg-surface` solido e cobrem o canvas — as particulas
 * aparecem nos vaos. A vinheta (`.app-vignette`) por cima garante contraste AA do
 * texto que rola sobre as particulas. O canvas ja pausa fora de foco, e estatico
 * em reduced-motion e trava DPR em 2.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect('/login');

  // Gate de aceite pós-login (SCRUM-1, fluxo 2): clientes que se cadastraram antes do
  // checkbox precisam aceitar a versão vigente dos Termos/Privacidade ANTES de usar o
  // app. needs_acceptance -> manda pro /aceite (fora do (app), sem shell), que só
  // libera de volta após o "Li e aceito". Fail-open: API fora não tranca (ver
  // getServerAceiteStatus).
  const aceite = await getServerAceiteStatus();
  if (aceite?.needs_acceptance) redirect('/aceite');

  const businessName = await getServerBusinessName(session.slot);

  return (
    <SessionProvider
      slot={session.slot}
      username={session.username}
      productType={session.product_type ?? 'individual'}
      seatCap={session.seat_cap ?? null}
      atendimentosEnabled={session.atendimentos_enabled ?? false}
      atendFromAgenda={session.atend_from_agenda ?? false}
      crmClientesEnabled={session.crm_clientes_enabled ?? false}
      whatsappManualEnabled={session.whatsapp_manual_enabled ?? false}
    >
      {/* Fuso do clone (default São Paulo) pros formatadores da agenda — lê /portal/status
          (dedup do React Query). Mato Grosso (America/Cuiaba, UTC-4) deixa de ver +1h. */}
      <TenantTzProvider>
        {/* Guard global de "alterações não salvas" (SCRUM-158): registry central +
          diálogo único, montado no layout RAIZ do (app) — cobre navegação pela
          sidebar/bottom-nav/topbar, não só entre sub-abas de uma mesma página. */}
        <UnsavedChangesProvider>
          {/* Fundo vivo fixo (atras de TODO o shell, z-[-1]): a constelacao do login
            persistente em todas as rotas autenticadas. + vinheta por cima do
            canvas pra contraste AA do texto que rola sobre as particulas. */}
          <ParticleField variant="appbg" />
          <div className="app-vignette pointer-events-none fixed inset-0 z-[-1]" aria-hidden />

          {/* Shell em flex row (1.D.7): sidebar e a coluna de conteudo sao IRMAOS.
            A pagina inteira rola; a sidebar fica sticky/h-dvh com rodape sempre
            visivel (fix do BLOCO A — antes esticava com o conteudo).
            SEM bg-bg aqui: o `body` ja pinta `--color-bg`. Deixar o shell
            transparente permite que o fundo vivo (canvas appbg, z-[-1]) apareca
            nos vaos atras do conteudo; sidebar/topbar/bottom-nav/cards (bg-surface
            solido, z>=20 no sticky) cobrem o canvas e seguem clicaveis. */}
          <div className="flex min-h-dvh">
            <Sidebar businessName={businessName} />
            <div className="flex min-w-0 flex-1 flex-col">
              <Topbar businessName={businessName} />
              {/* Banner de reconexao (acima de children, em TODAS as rotas quando
                needs_action; some em WORKING e na propria /conectar). Gated pela flag. */}
              <ReconnectBanner />
              {/* pb mobile = var(--nav-clearance) (altura real da bottom-nav +
                safe-area + respiro): garante que o conteudo em fluxo normal
                (lixeira da Inicio, botoes de acao no fim, etc.) nunca caia atras
                da nav. Derivado do MESMO token da agenda expandida/toast -> sem
                magic-number drift; se a nav crescer, a folga acompanha sozinha. */}
              <main className="mx-auto w-full max-w-[720px] flex-1 px-5 pb-[var(--nav-clearance)] pt-[18px] md:pb-12">
                {children}
              </main>
              <BottomNav />
            </div>
          </div>
        </UnsavedChangesProvider>
      </TenantTzProvider>
    </SessionProvider>
  );
}
