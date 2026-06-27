'use client';

import { BillingTabs } from '@/components/atendimentos/billing-tabs';
/**
 * Faturamento + comissão do COLABORADOR — visão READ-ONLY (SCRUM-32). Espelha o
 * mental model da tela /billing do dono: o seletor Previsão|Faturado controla qual
 * balde é mostrado, e a janela [de, ate] segue o balde (previsão = futuro;
 * faturado = passado). O colaborador vê SÓ os números dele: faturamento bruto, % de
 * comissão e — em destaque — o quanto ele recebe. Sem editar nada.
 *
 * O endpoint devolve os DOIS baldes numa tacada (faturado + previsao); aqui só
 * mostramos o selecionado. Estados remotos: loading (skeleton) / erro (retry) /
 * vazio (sem atendimento no período).
 */
import { useColaborador } from '@/components/colaborador/colaborador-session-context';
import { IconWallet } from '@/components/icons';
import { PeriodSelector } from '@/components/relatorios/period-selector';
import { Badge } from '@/components/ui/badge';
import { MetricCard } from '@/components/ui/card';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import type { AtendimentoBalde } from '@/lib/api-types';
import { type Periodo, periodoLimites, periodoPadrao, periodoPresets } from '@/lib/billing-periodo';
import { formatPctComissao } from '@/lib/comissao';
import { formatPrecoCents } from '@/lib/format';
import { useColaboradorComissao } from '@/lib/queries';
import { useMemo, useState } from 'react';

export function ColaboradorComissaoClient() {
  const { slot, colaboradorId } = useColaborador();
  const [balde, setBalde] = useState<AtendimentoBalde>('faturado');
  // O período acompanha o balde (passado p/ faturado, futuro p/ previsão).
  const [periodo, setPeriodo] = useState<Periodo>(() => periodoPadrao('faturado'));

  function trocarBalde(b: AtendimentoBalde) {
    setBalde(b);
    setPeriodo(periodoPadrao(b)); // reseta a janela pro default daquele balde
  }

  const limites = useMemo(() => periodoLimites(balde, periodo), [balde, periodo]);
  const presets = useMemo(() => periodoPresets(balde), [balde]);

  const q = useColaboradorComissao(slot, colaboradorId, periodo.de, periodo.ate);
  const bucket = q.data ? q.data[balde] : null;

  const recebeLabel = balde === 'previsao' ? 'Você vai receber (previsto)' : 'Você recebe';

  return (
    <div className="space-y-5">
      <BillingTabs value={balde} onChange={trocarBalde} />

      {/* Mesmo seletor de período do dono (/billing): presets + janela [de, ate]. */}
      <PeriodSelector value={periodo} onChange={setPeriodo} presets={presets} limites={limites} />

      {q.isPending ? (
        <>
          <span className="sr-only">Carregando seu faturamento…</span>
          <SkeletonList rows={3} />
        </>
      ) : q.isError || !bucket ? (
        <ErrorState title="Não foi possível carregar seu faturamento" onRetry={() => q.refetch()} />
      ) : bucket.count === 0 ? (
        <EmptyState
          icon={<IconWallet size={26} />}
          title="Nada no período"
          description={
            balde === 'previsao'
              ? 'Quando houver horários marcados pra você nesse período, o valor previsto aparece aqui.'
              : 'Quando você atender nesse período, o faturamento e a sua comissão aparecem aqui.'
          }
        />
      ) : (
        <div className="space-y-3">
          {/* Destaque: o que o colaborador recebe. */}
          <MetricCard value={formatPrecoCents(bucket.comissao_cents)} caption={recebeLabel} />

          <div className="grid grid-cols-2 gap-3">
            <MetricCard
              value={formatPrecoCents(bucket.total_bruto_cents)}
              caption="Faturamento bruto"
            />
            <MetricCard
              value={`${bucket.count}`}
              caption={bucket.count === 1 ? 'Atendimento' : 'Atendimentos'}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface px-[15px] py-3.5 shadow-card">
            <span className="text-[13.5px] text-ink-soft">Sua comissão</span>
            <Badge tone="info">{formatPctComissao(bucket.comissao_pct)}</Badge>
          </div>
        </div>
      )}
    </div>
  );
}
