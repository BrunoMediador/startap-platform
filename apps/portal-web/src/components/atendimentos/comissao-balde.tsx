'use client';

/**
 * Seção "Comissão por profissional" da tela Billing (ADR 0026 + consolidação). SÓ
 * estabelecimento (EMPRESA): no SOLO o backend devolve vazio e a seção nem é montada
 * pela página. O `balde` espelha o seletor Previsão|Faturado da tela — a comissão
 * acompanha o que está sendo olhado (esperado vs realizado).
 *
 * Layout aprovado: por profissional -> bruto · % · comissão R$. Campos nullable com
 * fallback (`profissional_nome` -> "Sem profissional"; `comissao_pct` null -> "—").
 *
 * Estados remotos: loading (skeleton) / 404 flag-off (esconde — defesa em
 * profundidade) / erro (retry) / vazio (sem comissão no período). O contrato de
 * comissão está congelado mas o backend constrói em paralelo; se algo divergir, a
 * UI degrada (erro amigável) sem travar o resto da tela Billing.
 */
import { IconUsers } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Badge } from '@/components/ui/badge';
import { MetricCard } from '@/components/ui/card';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import type { AtendimentoBalde } from '@/lib/api-types';
import { profissionalLabel } from '@/lib/atendimentos-balde';
import { formatPctComissao } from '@/lib/comissao';
import { formatPrecoCents } from '@/lib/format';
import { useComissao } from '@/lib/queries';

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function ComissaoBalde({
  balde,
  de,
  ate,
}: {
  balde: AtendimentoBalde;
  de: string;
  ate: string;
}) {
  const { slot, productType, atendimentosEnabled } = useTenant();
  const isEstabelecimento = productType === 'estabelecimento';
  const habilitado = atendimentosEnabled && isEstabelecimento;

  const q = useComissao(habilitado ? slot : '', balde, de, ate, habilitado);

  // SOLO ou flag off ou 404 -> a comissão simplesmente não aparece na tela Billing.
  if (!habilitado || is404(q.error)) return null;

  const captionTotal = balde === 'previsao' ? 'Comissão prevista' : 'Comissão a pagar';

  return (
    <section aria-labelledby="bill-comissao" className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="bill-comissao" className="mx-0.5 font-display text-[16px] font-semibold text-ink">
          Comissão por profissional
        </h2>
      </div>

      {q.isPending ? (
        <>
          <span className="sr-only">Carregando as comissões…</span>
          <SkeletonList rows={3} />
        </>
      ) : q.isError || !q.data ? (
        <ErrorState title="Não foi possível carregar as comissões" onRetry={() => q.refetch()} />
      ) : q.data.por_profissional.length === 0 ? (
        <EmptyState
          icon={<IconUsers size={26} />}
          title="Nenhuma comissão no período"
          description="Registre atendimentos com profissional e defina a % de comissão dele em Equipe. As comissões aparecem aqui."
        />
      ) : (
        <div className="space-y-3">
          <MetricCard value={formatPrecoCents(q.data.total_cents)} caption={captionTotal} />

          <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {q.data.por_profissional.map((p) => (
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
