'use client';

import { IconWallet } from '@/components/icons';
/**
 * Relatório de faturamento (App de gestão, Fase 1 — ADR 0026). Mostra o total
 * faturado no período, nº de atendimentos, ticket médio, e a quebra por forma de
 * pagamento e por profissional. Os números vêm prontos do backend (GET
 * /portal/relatorios/faturamento?de=&ate=) — o front não recalcula.
 *
 * Período: default = mês corrente (dia 1 até hoje), editável pelo PeriodSelector.
 * Estados remotos: loading (skeleton) / erro (retry) / vazio (sem atendimentos) /
 * indisponível (flag atendimentos OFF -> 404 ou sessão sem a flag).
 */
import { PeriodSelector, type Periodo } from '@/components/relatorios/period-selector';
import { useTenant } from '@/components/shell/session-context';
import { Badge } from '@/components/ui/badge';
import { MetricCard } from '@/components/ui/card';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import type { FormaPagamento } from '@/lib/api-types';
import { firstOfMonthISO, formatPrecoCents, toISODate } from '@/lib/format';
import { useFaturamento } from '@/lib/queries';
import { useState } from 'react';

const FORMA_LABEL: Record<FormaPagamento, string> = {
  dinheiro: 'Dinheiro',
  pix: 'Pix',
  credito: 'Crédito',
  debito: 'Débito',
  pacote: 'Pacote',
  outro: 'Outro',
};

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export default function FaturamentoPage() {
  const { slot, atendimentosEnabled } = useTenant();
  const [periodo, setPeriodo] = useState<Periodo>(() => ({
    de: firstOfMonthISO(),
    ate: toISODate(),
  }));

  const q = useFaturamento(slot, periodo.de, periodo.ate);

  if (!atendimentosEnabled) return <Indisponivel />;

  return (
    <>
      <PageHead
        title="Faturamento"
        subtitle="Quanto você faturou no período, por forma de pagamento e por profissional."
      />

      <PeriodSelector value={periodo} onChange={setPeriodo} />

      {q.isPending ? (
        <>
          <span className="sr-only">Carregando o faturamento…</span>
          <SkeletonList rows={4} />
        </>
      ) : is404(q.error) ? (
        <IndisponivelInline />
      ) : q.isError || !q.data ? (
        <ErrorState title="Não foi possível carregar o faturamento" onRetry={() => q.refetch()} />
      ) : q.data.count === 0 ? (
        <EmptyState
          icon={<IconWallet size={26} />}
          title="Nenhum atendimento no período"
          description="Registre os atendimentos pra acompanhar seu faturamento aqui. Ajuste o período acima se precisar."
        />
      ) : (
        <div className="space-y-5">
          {/* Métricas-chave */}
          <div className="grid grid-cols-2 gap-3">
            <MetricCard value={formatPrecoCents(q.data.total_cents)} caption="Total faturado" />
            <MetricCard value={q.data.count} caption="Atendimentos" />
            <MetricCard
              value={formatPrecoCents(q.data.ticket_medio_cents)}
              caption="Ticket médio"
            />
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
                    key={f.forma_pagamento}
                    className="flex items-center gap-3 border-b border-line-soft px-[15px] py-3.5 last:border-b-0"
                  >
                    <Badge tone="info">{FORMA_LABEL[f.forma_pagamento]}</Badge>
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
                    key={p.colaborador_id}
                    className="flex items-center gap-3 border-b border-line-soft px-[15px] py-3.5 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-display text-[15px] font-semibold text-ink">
                        {p.profissional_nome}
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
      )}
    </>
  );
}

/** Página inteira indisponível (flag OFF na sessão) — sem PageHead duplicado. */
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
