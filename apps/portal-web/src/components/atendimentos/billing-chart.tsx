'use client';

import { useTenantTz } from '@/components/shell/tenant-tz-context';
import type { AtendimentoBaldeRow } from '@/lib/api-types';
import {
  type AggBucket,
  agruparPorDia,
  agruparPorForma,
  agruparPorProfissional,
} from '@/lib/atendimentos-balde';
/**
 * Gráfico do Billing (decisão do Bruno) — 3 visões com toggle, alimentadas pelo
 * MESMO array de atendimentos já carregado na página (sem fetch extra). Respeita o
 * balde selecionado (Previsão|Faturado) — recebe as linhas já daquele balde:
 *   (a) Por DIA            -> barras de faturamento por dia do período.
 *   (b) Por PROFISSIONAL   -> barras somando por profissional.
 *   (c) Por FORMA DE PGTO  -> "pizza" (barras empilhadas horizontais) por forma.
 *
 * Sem dependência de chart externa (priorizar simplicidade + build no VPS): barras
 * em SVG/Tailwind. Agregações PURAS de lib/atendimentos-balde (somam o líquido, pra
 * bater com o total da lista). Dia agrupado por `row.data` (BR), nunca por inicio_at.
 */
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatPrecoCents } from '@/lib/format';
import { useMemo, useState } from 'react';

type Visao = 'dia' | 'profissional' | 'forma';

const VISOES: { value: Visao; label: string }[] = [
  { value: 'dia', label: 'Por dia' },
  { value: 'profissional', label: 'Por profissional' },
  { value: 'forma', label: 'Por pagamento' },
];

// Paleta estável pras fatias da visão "por pagamento" (ciclo se faltar cor).
const FATIA_CORES = [
  'var(--c-brand, #34d399)',
  '#60a5fa',
  '#fbbf24',
  '#f472b6',
  '#a78bfa',
  '#f87171',
];

export function BillingChart({ rows }: { rows: AtendimentoBaldeRow[] }) {
  const tz = useTenantTz();
  const [visao, setVisao] = useState<Visao>('dia');

  const dadosDia = useMemo(() => agruparPorDia(rows), [rows]);
  const dadosProf = useMemo(() => agruparPorProfissional(rows), [rows]);
  const dadosForma = useMemo(() => agruparPorForma(rows), [rows]);

  // Sem linhas: a página já mostra empty na lista — aqui só não renderiza o card.
  if (rows.length === 0) return null;

  return (
    <section
      aria-labelledby="bill-chart-titulo"
      className="rounded-card border border-line bg-surface p-4 shadow-card"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2
          id="bill-chart-titulo"
          className="mx-0.5 font-display text-[15px] font-semibold text-ink"
        >
          Faturamento
        </h2>
        <div
          role="tablist"
          aria-label="Visão do gráfico"
          className="inline-flex rounded-pill border border-line bg-surface-sunken p-0.5"
        >
          {VISOES.map((v) => {
            const ativo = visao === v.value;
            return (
              <button
                key={v.value}
                type="button"
                role="tab"
                aria-selected={ativo}
                onClick={() => setVisao(v.value)}
                className={cn(
                  'rounded-pill px-3 py-1.5 font-display text-[12.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand',
                  ativo ? 'bg-brand-soft text-brand' : 'text-ink-soft hover:text-ink',
                )}
              >
                {v.label}
              </button>
            );
          })}
        </div>
      </div>

      {visao === 'dia' && (
        <Barras
          buckets={dadosDia}
          rotulo={(b) => formatAgendamentoDia(b.chave, undefined, tz)}
          aria="Faturamento por dia"
        />
      )}
      {visao === 'profissional' && (
        <Barras buckets={dadosProf} rotulo={(b) => b.rotulo} aria="Faturamento por profissional" />
      )}
      {visao === 'forma' && <Fatias buckets={dadosForma} />}
    </section>
  );
}

/** Barras horizontais (largura proporcional ao maior). Acessível via lista. */
function Barras({
  buckets,
  rotulo,
  aria,
}: {
  buckets: AggBucket[];
  rotulo: (b: AggBucket) => string;
  aria: string;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.total_cents));
  return (
    <ul aria-label={aria} className="space-y-2.5">
      {buckets.map((b) => {
        const pct = Math.round((b.total_cents / max) * 100);
        return (
          <li key={b.chave} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-display text-[13px] font-semibold text-ink">
                {rotulo(b)}
              </span>
              <span className="shrink-0 font-display text-[13px] font-semibold tabular-nums text-ink">
                {formatPrecoCents(b.total_cents)}
              </span>
            </div>
            <div
              className="h-2.5 w-full overflow-hidden rounded-pill bg-surface-sunken"
              role="presentation"
            >
              <div
                className="h-full rounded-pill bg-brand transition-[width]"
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Pizza" enxuta: barra empilhada horizontal + legenda com valor e % de cada forma.
 * Mais legível no mobile que uma pizza SVG e sem dep externa.
 */
function Fatias({ buckets }: { buckets: AggBucket[] }) {
  const total = buckets.reduce((acc, b) => acc + b.total_cents, 0);
  if (total === 0) {
    return (
      <p className="rounded-card-sm border border-line bg-surface px-3.5 py-4 text-center text-[13px] text-ink-soft">
        Sem valor no período pra separar por forma de pagamento.
      </p>
    );
  }
  return (
    <div>
      <div
        className="mb-3 flex h-3 w-full overflow-hidden rounded-pill"
        role="img"
        aria-label="Distribuição do faturamento por forma de pagamento"
      >
        {buckets.map((b, i) => (
          <span
            key={b.chave}
            className="h-full"
            style={{
              width: `${(b.total_cents / total) * 100}%`,
              backgroundColor: FATIA_CORES[i % FATIA_CORES.length],
            }}
          />
        ))}
      </div>
      <ul className="space-y-2">
        {buckets.map((b, i) => {
          const pct = Math.round((b.total_cents / total) * 100);
          return (
            <li key={b.chave} className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="size-3 shrink-0 rounded-[3px]"
                style={{ backgroundColor: FATIA_CORES[i % FATIA_CORES.length] }}
              />
              <span className="min-w-0 flex-1 truncate font-display text-[13px] font-semibold text-ink">
                {b.rotulo}
              </span>
              <span className="shrink-0 text-[12px] tabular-nums text-ink-soft">{pct}%</span>
              <span className="shrink-0 font-display text-[13px] font-semibold tabular-nums text-ink">
                {formatPrecoCents(b.total_cents)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
