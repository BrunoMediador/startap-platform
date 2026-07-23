'use client';

/**
 * Comissão por profissional do Billing, recomputada CLIENT-SIDE a partir do array
 * de atendimentos JÁ FILTRADO (item 5). Substitui ComissaoBalde no ramo
 * atend_from_agenda quando os filtros mexem no recorte — o relatório do backend olha
 * o período inteiro e não bate sob filtro.
 *
 * Regra (invariante 3): comissão é LIVE-COMPUTE = líquido × pct do colaborador,
 * NUNCA materializada. "Lista TODOS os profissionais ativos" mesmo sem booking
 * quando NÃO há filtro de colaborador (delta 0). SÓ estabelecimento — no SOLO a
 * página nem monta (sem colaboradores). A % vem da Equipe (fonte da verdade).
 */
import { IconUsers } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { MetricCard } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import type { AtendimentoBalde, AtendimentoBaldeRow, Colaborador } from '@/lib/api-types';
import {
  computeComissaoFromRows,
  computeLucroCents,
  profissionalLabel,
  somarTotalCents,
} from '@/lib/atendimentos-balde';
import { formatPctComissao } from '@/lib/comissao';
import { formatPrecoCents } from '@/lib/format';
import { useMemo } from 'react';

export function ComissaoBaldeFiltrada({
  balde,
  rows,
  colaboradoresAtivos,
}: {
  balde: AtendimentoBalde;
  /** Linhas JÁ filtradas do balde em foco. */
  rows: AtendimentoBaldeRow[];
  /** Colaboradores ativos pra listar quem não teve booking (delta 0). */
  colaboradoresAtivos: Pick<Colaborador, 'id' | 'nome' | 'comissao_pct'>[];
}) {
  const resultado = useMemo(
    () => computeComissaoFromRows(rows, colaboradoresAtivos),
    [rows, colaboradoresAtivos],
  );

  // Lucro = faturamento do balde (mesmas linhas filtradas) − comissão recomputada.
  // 100% client-side: respeita o seletor Previsão|Faturado E os filtros via `rows`.
  const lucroCents = useMemo(
    () => computeLucroCents(somarTotalCents(rows), resultado.total_cents),
    [rows, resultado.total_cents],
  );

  const captionTotal = balde === 'previsao' ? 'Comissão prevista' : 'Comissão a pagar';
  // NÃO é "lucro" (há outros custos): é o faturamento MENOS as comissões (item-4).
  const captionLucro = 'Após comissões · faturamento − comissão';

  return (
    <section aria-labelledby="bill-comissao" className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="bill-comissao" className="mx-0.5 font-display text-[16px] font-semibold text-ink">
          Comissão por profissional
        </h2>
      </div>

      {resultado.por_profissional.length === 0 ? (
        <EmptyState
          icon={<IconUsers size={26} />}
          title="Nenhuma comissão no período"
          description="Registre atendimentos com profissional e defina a % de comissão dele em Equipe. As comissões aparecem aqui."
        />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <MetricCard value={formatPrecoCents(resultado.total_cents)} caption={captionTotal} />
            <MetricCard value={formatPrecoCents(lucroCents)} caption={captionLucro} />
          </div>

          <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {resultado.por_profissional.map((p) => (
              <div
                key={p.colaborador_id}
                className="flex items-center gap-3 border-b border-line-soft px-[15px] py-3.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display text-[15px] font-semibold text-ink">
                    {profissionalLabel(p.profissional_nome)}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-soft">
                    <span className="tabular-nums">{formatPrecoCents(p.total_bruto_cents)}</span>
                    <span aria-hidden>·</span>
                    <Badge tone="info">{formatPctComissao(p.comissao_pct)}</Badge>
                  </div>
                </div>
                <span className="shrink-0 font-display text-[15px] font-semibold tabular-nums text-ink">
                  {formatPrecoCents(p.comissao_cents)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
