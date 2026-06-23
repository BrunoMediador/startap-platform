'use client';

/**
 * Relatório de comissão (App de gestão, Fase 1 — ADR 0026). Só faz sentido pro
 * estabelecimento (EMPRESA): comissão = % por profissional sobre o bruto. No SOLO
 * o backend devolve vazio e o item de menu nem aparece — aqui mostramos "recurso
 * indisponível" como defesa em profundidade (link direto).
 *
 * Os valores vêm prontos do backend (GET /portal/relatorios/comissao?de=&ate=).
 * Período default = mês corrente. Estados: loading / erro / vazio / indisponível
 * (flag atendimentos OFF -> 404 ou sessão sem a flag; ou conta SOLO).
 */
import { IconUsers } from '@/components/icons';
import { PeriodSelector, type Periodo } from '@/components/relatorios/period-selector';
import { useTenant } from '@/components/shell/session-context';
import { MetricCard } from '@/components/ui/card';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import { firstOfMonthISO, formatPrecoCents, toISODate } from '@/lib/format';
import { useComissao } from '@/lib/queries';
import { useState } from 'react';

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export default function ComissaoPage() {
  const { slot, productType, atendimentosEnabled } = useTenant();
  const isEstabelecimento = productType === 'estabelecimento';

  const [periodo, setPeriodo] = useState<Periodo>(() => ({
    de: firstOfMonthISO(),
    ate: toISODate(),
  }));

  // Não bate na API quando é SOLO ou a flag está off (defesa em profundidade).
  const habilitado = atendimentosEnabled && isEstabelecimento;
  const q = useComissao(habilitado ? slot : '', periodo.de, periodo.ate);

  if (!habilitado) return <Indisponivel />;

  return (
    <>
      <PageHead
        title="Comissão"
        subtitle="Quanto pagar de comissão a cada profissional no período."
      />

      <PeriodSelector value={periodo} onChange={setPeriodo} />

      {q.isPending ? (
        <>
          <span className="sr-only">Carregando as comissões…</span>
          <SkeletonList rows={3} />
        </>
      ) : is404(q.error) ? (
        <IndisponivelInline />
      ) : q.isError || !q.data ? (
        <ErrorState title="Não foi possível carregar as comissões" onRetry={() => q.refetch()} />
      ) : q.data.por_profissional.length === 0 ? (
        <EmptyState
          icon={<IconUsers size={26} />}
          title="Nenhuma comissão no período"
          description="Registre atendimentos com profissional e defina a % de comissão dele em Equipe. As comissões aparecem aqui."
        />
      ) : (
        <div className="space-y-5">
          <MetricCard value={formatPrecoCents(q.data.total_cents)} caption="Comissão a pagar" />

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
                    {formatPrecoCents(p.comissao_cents)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

/** Página inteira indisponível (SOLO ou flag OFF). */
function Indisponivel() {
  return (
    <>
      <PageHead title="Comissão" subtitle="Quanto pagar de comissão a cada profissional." />
      <IndisponivelInline />
    </>
  );
}

function IndisponivelInline() {
  return (
    <EmptyState
      icon={<IconUsers size={26} />}
      title="Recurso indisponível"
      description="O relatório de comissão está disponível apenas para contas de estabelecimento com o app de gestão ativo. Fale com o suporte."
    />
  );
}
