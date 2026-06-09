'use client';

import { useTenant } from '@/components/shell/session-context';
/**
 * Home / Status (spec 7, hierarquia 3 niveis: status > vencimento > metricas/listas).
 *
 * Estados: loading (skeleton + texto contextual), error (retry), conteudo.
 * Auto-refresh do status a cada 60s em foco (useStatus, spec D6); recarregar a
 * pagina busca tudo. Suspensao por inadimplencia mostra aviso informativo (D3).
 */
import { MetricCard } from '@/components/ui/card';
import { Skeleton, SkeletonList } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { agruparAgendamentos } from '@/lib/agendamentos';
import { useAgendamentos, useStatus } from '@/lib/queries';
import { AgendamentosList } from './agendamentos-list';
import { HeroZone } from './hero-zone';
import { SuspendedNotice } from './suspended-notice';

export default function InicioPage() {
  const { slot } = useTenant();
  const status = useStatus(slot);
  const agendamentos = useAgendamentos(slot);

  if (status.isPending) {
    // Shape do skeleton casa com o conteudo real (1.D.6): kicker+saudacao,
    // status-hero + billing, metricas, lista.
    return (
      <>
        <div className="mb-4 pt-1.5">
          <Skeleton className="mb-2.5 h-3 w-24" />
          <Skeleton className="h-7 w-56" />
          <Skeleton className="mt-2 h-3.5 w-44" />
        </div>
        <span className="sr-only">Carregando seu painel…</span>
        <div className="mb-[18px] grid gap-3.5 min-[1100px]:grid-cols-2">
          <Skeleton className="h-[92px] w-full rounded-card" />
          <Skeleton className="h-[140px] w-full rounded-card" />
        </div>
        <div className="mb-[18px] grid grid-cols-2 gap-3">
          <Skeleton className="h-[74px] rounded-card-sm" />
          <Skeleton className="h-[74px] rounded-card-sm" />
        </div>
        <SkeletonList rows={3} />
      </>
    );
  }

  if (status.isError || !status.data) {
    return <ErrorState onRetry={() => status.refetch()} />;
  }

  const data = status.data;
  const nome = data.display_name ?? 'Seu negócio';

  // "Proximos" no metric = hoje + futuro (a janela do backend traz tambem
  // recentes/-7d, que nao contam como "proximos"). gcal off -> "—".
  const ag = agendamentos.data;
  let proximosCount: number | string = '—';
  if (ag?.gcal_configured) {
    const g = agruparAgendamentos(ag.agendamentos);
    proximosCount = g.hoje.length + g.proximos.length;
  }

  return (
    <>
      {!data.flow_enabled && <SuspendedNotice />}

      {/* Hero-zone (1.D): saudacao editorial + status (E1) + billing (E2),
          com aurora + canvas ambient + fade. Stagger interno nos cards-heroi. */}
      <HeroZone status={data} businessName={nome} />

      {/* Metricas (E0) — stagger 3 no mount. */}
      <div className="stagger stagger-3 mb-[18px] grid grid-cols-2 gap-3">
        <MetricCard
          value={data.pausas_ativas}
          caption={data.pausas_ativas === 1 ? 'Número pausado' : 'Números pausados'}
          href="/pausas"
          ariaLabel={`${data.pausas_ativas} números pausados — ver pausas`}
        />
        <MetricCard value={proximosCount} caption="Próximos agendamentos" />
      </div>

      <div className="stagger stagger-4 mx-0.5 mb-[11px] mt-1">
        <h2 className="font-display text-[15px] font-semibold text-ink">Agendamentos</h2>
      </div>

      {agendamentos.isPending ? (
        <>
          <span className="sr-only">Carregando seus agendamentos…</span>
          <SkeletonList rows={3} />
        </>
      ) : agendamentos.isError || !agendamentos.data ? (
        <ErrorState
          title="Não foi possível carregar os agendamentos"
          onRetry={() => agendamentos.refetch()}
        />
      ) : (
        <div className="stagger stagger-4">
          <AgendamentosList data={agendamentos.data} />
        </div>
      )}
    </>
  );
}
