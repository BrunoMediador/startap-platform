'use client';

/**
 * Relatório agregado de faturamento (comportamento legado, inalterado). Total, nº de
 * atendimentos, ticket médio + quebra por forma e por profissional, do GET
 * /portal/relatorios/faturamento. Usado na tela Billing pelos clones FORA do gate
 * de agenda (billing-da-agenda OFF — ex.: modo atendente/Ingrid/Meduzza): só
 * FATURADO, sem previsão. Extraído da antiga página /relatorios/faturamento na
 * consolidação; mantém a experiência idêntica à de hoje, sem regressão.
 *
 * Estados: loading / 404 flag-off (indisponível) / erro (retry) / vazio.
 */
import { IconWallet } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Badge } from '@/components/ui/badge';
import { MetricCard } from '@/components/ui/card';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import { formaPagamentoLabel, profissionalLabel } from '@/lib/atendimentos-balde';
import { formatPrecoCents } from '@/lib/format';
import { useFaturamento } from '@/lib/queries';

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function ResumoFaturamento({ de, ate }: { de: string; ate: string }) {
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
      {/* Métricas-chave. Total ocupa a largura toda (número grande, sem espremer);
          Atendimentos + Ticket dividem a linha de baixo. No desktop as 3 ficam lado
          a lado. Evita o "card órfão" do grid-cols-2 com 3 itens. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricCard
          value={formatPrecoCents(q.data.total_cents)}
          caption="Total faturado"
          className="col-span-2 sm:col-span-1"
        />
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

      {/* Por profissional (vazio em clone individual, sem colaboradores) */}
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

function IndisponivelInline() {
  return (
    <EmptyState
      icon={<IconWallet size={26} />}
      title="Recurso indisponível"
      description="Os relatórios de faturamento ainda não estão liberados pra sua conta. Fale com o suporte pra ativar."
    />
  );
}
