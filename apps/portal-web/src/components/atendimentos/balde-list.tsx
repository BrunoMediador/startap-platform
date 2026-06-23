'use client';

/**
 * Lista EDITÁVEL de atendimentos de UM balde (Previsão = futuros / Faturado =
 * passados), do billing derivado da agenda (ADR 0027 Fase C). Mostra o total do
 * balde + as linhas; tocar numa linha abre o sheet de edição (editar valor/forma/
 * serviço/cliente, ou remover). Cada linha traz data·hora, cliente, serviço, valor
 * (com desconto se houver), forma (ou "Sem forma"), profissional (estabelecimento;
 * "Sem profissional" se null) e o badge Auto/Manual/Editado.
 *
 * Estados remotos: loading (skeleton) / 404 flag-off (indisponível) / erro (retry)
 * / vazio (sem atendimentos no período). O período vem da página (controlado).
 */
import { IconChevronRight, IconWallet } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Badge } from '@/components/ui/badge';
import { MetricCard } from '@/components/ui/card';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import type { AtendimentoBalde, AtendimentoBaldeRow } from '@/lib/api-types';
import {
  clienteLabel,
  formaPagamentoLabel,
  profissionalLabel,
  rowBadge,
  servicoLabel,
  valorLiquidoCents,
} from '@/lib/atendimentos-balde';
import { formatAgendamentoDia, formatAgendamentoHora, formatPrecoCents } from '@/lib/format';
import { useAtendimentosBalde } from '@/lib/queries';
import { useState } from 'react';
import { AtendimentoEditSheet } from './atendimento-edit-sheet';

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

const COPY: Record<
  AtendimentoBalde,
  { totalCaption: string; emptyTitle: string; emptyDesc: string }
> = {
  previsao: {
    totalCaption: 'Previsto no período',
    emptyTitle: 'Nada previsto no período',
    emptyDesc:
      'Os agendamentos futuros entram aqui como receita esperada. Ajuste o período acima se precisar.',
  },
  faturado: {
    totalCaption: 'Faturado no período',
    emptyTitle: 'Nada faturado no período',
    emptyDesc: 'Os atendimentos que já passaram aparecem aqui. Ajuste o período acima se precisar.',
  },
};

export function BaldeList({
  balde,
  de,
  ate,
}: {
  balde: AtendimentoBalde;
  de: string;
  ate: string;
}) {
  const { slot, atendimentosEnabled, atendFromAgenda } = useTenant();
  const habilitado = atendimentosEnabled && atendFromAgenda;
  const [flagOff, setFlagOff] = useState(false);
  const [aberto, setAberto] = useState<AtendimentoBaldeRow | null>(null);

  const q = useAtendimentosBalde(slot, balde, de, ate, habilitado && !flagOff);

  if (!habilitado || flagOff || is404(q.error)) return <Indisponivel />;

  const copy = COPY[balde];

  return (
    <>
      {q.isPending ? (
        <>
          <span className="sr-only">Carregando os atendimentos…</span>
          <SkeletonList rows={4} />
        </>
      ) : q.isError || !q.data ? (
        <ErrorState title="Não foi possível carregar os atendimentos" onRetry={() => q.refetch()} />
      ) : q.data.atendimentos.length === 0 ? (
        <EmptyState
          icon={<IconWallet size={26} />}
          title={copy.emptyTitle}
          description={copy.emptyDesc}
        />
      ) : (
        <div className="space-y-4">
          <MetricCard value={formatPrecoCents(q.data.total_cents)} caption={copy.totalCaption} />

          <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {q.data.atendimentos.map((row) => (
              <LinhaAtendimento key={row.id} row={row} onClick={() => setAberto(row)} />
            ))}
          </div>
        </div>
      )}

      <AtendimentoEditSheet
        slot={slot}
        balde={balde}
        de={de}
        ate={ate}
        row={aberto}
        onClose={() => setAberto(null)}
        onFlagOff={() => setFlagOff(true)}
      />
    </>
  );
}

/** Uma linha clicável (abre o sheet de edição). */
function LinhaAtendimento({
  row,
  onClick,
}: {
  row: AtendimentoBaldeRow;
  onClick: () => void;
}) {
  const dia = formatAgendamentoDia(row.inicio_at ?? row.data);
  const hora = formatAgendamentoHora(row.inicio_at);
  const quando = [dia, hora].filter(Boolean).join(' · ') || 'Sem data';
  const liquido = valorLiquidoCents(row);
  const temDesconto = row.desconto_cents > 0;
  const badge = rowBadge(row);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Editar atendimento de ${clienteLabel(row.cliente_nome)} — ${formatPrecoCents(liquido)}`}
      className="flex w-full items-center gap-3 border-b border-line-soft px-[15px] py-3.5 text-left outline-none transition-colors last:border-b-0 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[15px] font-semibold text-ink">
            {clienteLabel(row.cliente_nome)}
          </span>
          <BadgeOrigem badge={badge} />
        </div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink-soft">
          {quando} · {servicoLabel(row.servico_nome)}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-faint">
          <span>{formaPagamentoLabel(row.forma_pagamento)}</span>
          {row.profissional_nome !== null && (
            <>
              <span aria-hidden>·</span>
              <span>{profissionalLabel(row.profissional_nome)}</span>
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className="font-display text-[15px] font-semibold tabular-nums text-ink">
          {formatPrecoCents(liquido)}
        </div>
        {temDesconto && (
          <div className="text-[11.5px] text-ink-faint line-through tabular-nums">
            {formatPrecoCents(row.valor_cents)}
          </div>
        )}
      </div>
      <IconChevronRight size={18} className="shrink-0 text-ink-faint" />
    </button>
  );
}

/** Badge da origem/edição — texto sempre presente (acessibilidade). */
function BadgeOrigem({ badge }: { badge: ReturnType<typeof rowBadge> }) {
  if (badge === 'editado') return <Badge tone="amber">Editado</Badge>;
  if (badge === 'manual') return <Badge tone="info">Manual</Badge>;
  return <Badge tone="ok">Auto</Badge>;
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
