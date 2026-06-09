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
import { saudacao } from '@/lib/format';
import { useAgendamentos, useStatus } from '@/lib/queries';
import { AgendamentosList } from './agendamentos-list';
import { BillingCard } from './billing-card';
import { StatusHero } from './status-hero';
import { SuspendedNotice } from './suspended-notice';

export default function InicioPage() {
  const { slot } = useTenant();
  const status = useStatus(slot);
  const agendamentos = useAgendamentos(slot);

  if (status.isPending) {
    return (
      <>
        <div className="mb-4">
          <Skeleton className="mb-2 h-3 w-20" />
          <Skeleton className="h-6 w-44" />
        </div>
        <span className="sr-only">Carregando seu painel…</span>
        <Skeleton className="mb-3.5 h-[112px] w-full rounded-card" />
        <Skeleton className="mb-3.5 h-[130px] w-full rounded-card" />
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

  return (
    <>
      <div className="mb-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          {saudacao()}
        </div>
        <h1 className="mt-0.5 font-display text-[20px] font-bold tracking-[-0.01em] text-ink">
          {nome}
        </h1>
      </div>

      {!data.flow_enabled && <SuspendedNotice />}

      <StatusHero status={data} />

      <BillingCard billing={data.billing} />

      <div className="mb-[18px] grid grid-cols-2 gap-3">
        <MetricCard
          value={data.pausas_ativas}
          caption={data.pausas_ativas === 1 ? 'Número pausado' : 'Números pausados'}
          href="/pausas"
          ariaLabel={`${data.pausas_ativas} números pausados — ver pausas`}
        />
        <MetricCard
          value={agendamentos.data?.gcal_configured ? agendamentos.data.count : '—'}
          caption="Próximos agendamentos"
        />
      </div>

      <div className="mx-0.5 mb-[11px] mt-1">
        <h2 className="font-display text-[15px] font-semibold text-ink">Próximos agendamentos</h2>
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
        <AgendamentosList data={agendamentos.data} />
      )}
    </>
  );
}
