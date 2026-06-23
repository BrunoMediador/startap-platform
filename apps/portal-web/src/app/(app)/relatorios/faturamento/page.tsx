'use client';

import { BaldeList } from '@/components/atendimentos/balde-list';
import { type FaturamentoTab, FaturamentoTabs } from '@/components/atendimentos/faturamento-tabs';
/**
 * Faturamento (App de gestão, Fase 1 + ADR 0027 Fase C). Duas formas de ver o
 * dinheiro do cliente final:
 *
 *  - Billing-da-agenda OFF (default / SOLO Cirilo/Samuel): a tela é IDÊNTICA à de
 *    hoje — só o relatório agregado (total, ticket médio, por forma, por
 *    profissional), montado do GET /portal/relatorios/faturamento.
 *  - Billing-da-agenda ON (atend_from_agenda): ganha um segmented control com
 *    abas Previsão | Faturado | Resumo. Previsão = eventos futuros (receita
 *    esperada), Faturado = eventos passados (realizado), ambos EDITÁVEIS linha a
 *    linha (BaldeList + sheet). Resumo = o mesmo relatório agregado de antes.
 *
 * O período (de/ate) é compartilhado entre as abas. Estados remotos: loading /
 * 404 flag-off / erro / vazio / indisponível (flag atendimentos OFF).
 */
import { IconWallet } from '@/components/icons';
import { PeriodSelector, type Periodo } from '@/components/relatorios/period-selector';
import { useTenant } from '@/components/shell/session-context';
import { Badge } from '@/components/ui/badge';
import { MetricCard } from '@/components/ui/card';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import { formaPagamentoLabel, profissionalLabel } from '@/lib/atendimentos-balde';
import { firstOfMonthISO, formatPrecoCents, toISODate } from '@/lib/format';
import { useFaturamento } from '@/lib/queries';
import { useState } from 'react';

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export default function FaturamentoPage() {
  const { atendimentosEnabled, atendFromAgenda } = useTenant();
  const [periodo, setPeriodo] = useState<Periodo>(() => ({
    de: firstOfMonthISO(),
    ate: toISODate(),
  }));
  // Com o billing-da-agenda ON, a aba inicial é Faturado (realizado é o foco diário).
  const [tab, setTab] = useState<FaturamentoTab>('faturado');

  if (!atendimentosEnabled) return <Indisponivel />;

  return (
    <>
      <PageHead
        title="Faturamento"
        subtitle="Quanto você faturou no período, por forma de pagamento e por profissional."
      />

      <PeriodSelector value={periodo} onChange={setPeriodo} />

      {atendFromAgenda ? (
        <>
          <FaturamentoTabs value={tab} onChange={setTab} />
          {tab === 'previsao' ? (
            <BaldeList balde="previsao" de={periodo.de} ate={periodo.ate} />
          ) : tab === 'faturado' ? (
            <BaldeList balde="faturado" de={periodo.de} ate={periodo.ate} />
          ) : (
            <ResumoFaturamento de={periodo.de} ate={periodo.ate} />
          )}
        </>
      ) : (
        <ResumoFaturamento de={periodo.de} ate={periodo.ate} />
      )}
    </>
  );
}

/**
 * Relatório agregado de faturamento (comportamento legado, inalterado). Total,
 * nº de atendimentos, ticket médio + quebra por forma e por profissional.
 */
function ResumoFaturamento({ de, ate }: { de: string; ate: string }) {
  const { slot } = useTenant();
  const q = useFaturamento(slot, de, ate);

  if (q.isPending) {
    return (
      <>
        <span className="sr-only">Carregando o faturamento…</span>
        <SkeletonList rows={4} />
      </>
    );
  }
  if (is404(q.error)) return <IndisponivelInline />;
  if (q.isError || !q.data) {
    return (
      <ErrorState title="Não foi possível carregar o faturamento" onRetry={() => q.refetch()} />
    );
  }
  if (q.data.count === 0) {
    return (
      <EmptyState
        icon={<IconWallet size={26} />}
        title="Nenhum atendimento no período"
        description="Registre os atendimentos pra acompanhar seu faturamento aqui. Ajuste o período acima se precisar."
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* Métricas-chave */}
      <div className="grid grid-cols-2 gap-3">
        <MetricCard value={formatPrecoCents(q.data.total_cents)} caption="Total faturado" />
        <MetricCard value={q.data.count} caption="Atendimentos" />
        <MetricCard value={formatPrecoCents(q.data.ticket_medio_cents)} caption="Ticket médio" />
      </div>

      {/* Por forma de pagamento */}
      {q.data.por_forma_pagamento.length > 0 && (
        <section aria-labelledby="sec-forma">
          <h2
            id="sec-forma"
            className="mx-0.5 mb-2.5 font-display text-[15px] font-semibold text-ink"
          >
            Por forma de pagamento
          </h2>
          <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {q.data.por_forma_pagamento.map((f) => (
              <div
                key={f.forma_pagamento ?? 'sem-forma'}
                className="flex items-center gap-3 border-b border-line-soft px-[15px] py-3.5 last:border-b-0"
              >
                <Badge tone="info">{formaPagamentoLabel(f.forma_pagamento)}</Badge>
                <span className="text-[12.5px] text-ink-soft">
                  {f.count} {f.count === 1 ? 'atendimento' : 'atendimentos'}
                </span>
                <span className="ml-auto font-display text-[15px] font-semibold tabular-nums text-ink">
                  {formatPrecoCents(f.total_cents)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Por profissional (vazio no SOLO) */}
      {q.data.por_profissional.length > 0 && (
        <section aria-labelledby="sec-prof">
          <h2
            id="sec-prof"
            className="mx-0.5 mb-2.5 font-display text-[15px] font-semibold text-ink"
          >
            Por profissional
          </h2>
          <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {q.data.por_profissional.map((p) => (
              <div
                key={p.colaborador_id ?? 'solo'}
                className="flex items-center gap-3 border-b border-line-soft px-[15px] py-3.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display text-[15px] font-semibold text-ink">
                    {profissionalLabel(p.profissional_nome)}
                  </div>
                  <div className="text-[12.5px] text-ink-soft">
                    {p.count} {p.count === 1 ? 'atendimento' : 'atendimentos'}
                  </div>
                </div>
                <span className="shrink-0 font-display text-[15px] font-semibold tabular-nums text-ink">
                  {formatPrecoCents(p.total_cents)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Página inteira indisponível (flag atendimentos OFF na sessão). */
function Indisponivel() {
  return (
    <>
      <PageHead title="Faturamento" subtitle="Acompanhe quanto você faturou no período." />
      <IndisponivelInline />
    </>
  );
}

function IndisponivelInline() {
  return (
    <EmptyState
      icon={<IconWallet size={26} />}
      title="Recurso indisponível"
      description="Os relatórios de faturamento ainda não estão liberados pra sua conta. Fale com o suporte pra ativar."
    />
  );
}
