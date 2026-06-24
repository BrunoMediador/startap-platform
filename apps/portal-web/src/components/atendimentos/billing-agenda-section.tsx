'use client';

/**
 * Ramo atend_from_agenda do Billing (itens 4/5). Dono ÚNICO da query de
 * atendimentos do balde — gráfico, filtros, lista editável e comissão compartilham
 * o MESMO fetch (sem duplicar). Pipeline:
 *
 *   useAtendimentosBalde -> filtra CLIENT-SIDE (filtrarAtendimentos) -> recomputa o
 *   total (somarTotalCents) -> alimenta gráfico + lista + comissão.
 *
 * Mantém os mesmos estados remotos da BaldeList original (loading/erro/404/empty).
 * A comissão é recomputada do array filtrado (live-compute) — só estabelecimento.
 * O ramo NÃO-gate (clones individuais) vive na page e não passa por aqui.
 */
import { BaldeListView } from '@/components/atendimentos/balde-list';
import { BillingChart } from '@/components/atendimentos/billing-chart';
import { BillingFiltros } from '@/components/atendimentos/billing-filtros';
import { ComissaoBaldeFiltrada } from '@/components/atendimentos/comissao-balde-filtrada';
import { IconWallet } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import type { AtendimentoBalde } from '@/lib/api-types';
import {
  type BillingFiltro,
  FILTRO_VAZIO,
  filtrarAtendimentos,
  somarTotalCents,
} from '@/lib/atendimentos-balde';
import { useAtendimentosBalde, useEquipe } from '@/lib/queries';
import { useEffect, useMemo, useState } from 'react';

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function BillingAgendaSection({
  balde,
  de,
  ate,
}: {
  balde: AtendimentoBalde;
  de: string;
  ate: string;
}) {
  const { slot, productType, atendimentosEnabled, atendFromAgenda } = useTenant();
  const isEstabelecimento = productType === 'estabelecimento';
  const habilitado = atendimentosEnabled && atendFromAgenda;
  const [flagOff, setFlagOff] = useState(false);
  const [filtro, setFiltro] = useState<BillingFiltro>(FILTRO_VAZIO);

  const q = useAtendimentosBalde(slot, balde, de, ate, habilitado && !flagOff);
  // Equipe só no estabelecimento (lista todos os ativos na comissão, mesmo sem booking).
  const equipeQ = useEquipe(isEstabelecimento ? slot : '');

  // Trocar de balde/período reseta os filtros (recorte novo, filtro velho confunde).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reseta o filtro ao mudar balde/período, não a cada render
  useEffect(() => {
    setFiltro(FILTRO_VAZIO);
  }, [balde, de, ate]);

  const todas = useMemo(() => q.data?.atendimentos ?? [], [q.data]);
  const filtradas = useMemo(() => filtrarAtendimentos(todas, filtro), [todas, filtro]);
  const totalFiltrado = useMemo(() => somarTotalCents(filtradas), [filtradas]);
  const colaboradoresAtivos = useMemo(
    () => (equipeQ.data?.colaboradores ?? []).filter((c) => c.ativo),
    [equipeQ.data],
  );

  if (!habilitado || flagOff || is404(q.error)) return <Indisponivel />;

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <BillingFiltros value={filtro} onChange={setFiltro} />

        {q.isPending ? (
          <>
            <span className="sr-only">Carregando os atendimentos…</span>
            <SkeletonList rows={4} />
          </>
        ) : q.isError || !q.data ? (
          <ErrorState
            title="Não foi possível carregar os atendimentos"
            onRetry={() => q.refetch()}
          />
        ) : (
          <>
            <BillingChart rows={filtradas} />
            <BaldeListView
              slot={slot}
              balde={balde}
              de={de}
              ate={ate}
              rows={filtradas}
              totalCents={totalFiltrado}
              onFlagOff={() => setFlagOff(true)}
              mostrarVendedor={isEstabelecimento}
            />
          </>
        )}
      </div>

      {/* Comissão — só estabelecimento. Recomputa do array filtrado (live-compute). */}
      {isEstabelecimento && q.data && (
        <ComissaoBaldeFiltrada
          balde={balde}
          rows={filtradas}
          colaboradoresAtivos={colaboradoresAtivos}
        />
      )}
    </div>
  );
}

function Indisponivel() {
  return (
    <EmptyState
      icon={<IconWallet size={26} />}
      title="Recurso indisponível"
      description="O faturamento pela agenda ainda não está liberado pra sua conta. Fale com o suporte pra ativar."
    />
  );
}
