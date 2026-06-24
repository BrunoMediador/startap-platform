'use client';

/**
 * Segmented control da tela Billing: Previsão | Faturado. Controla a PÁGINA INTEIRA
 * (total + lista de atendimentos + comissão). Substitui o controle de 3 abas antigo
 * (Previsão/Faturado/Resumo) — "Resumo" foi absorvido: no billing-da-agenda a lista
 * editável já é a fonte; o relatório agregado legado só aparece no SOLO/flag-off.
 *
 * `role=tablist` + `aria-selected` + setas ←/→ pra acessibilidade de teclado.
 */
import type { AtendimentoBalde } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { useRef } from 'react';

const TABS: { id: AtendimentoBalde; label: string }[] = [
  { id: 'previsao', label: 'Previsão' },
  { id: 'faturado', label: 'Faturado' },
];

export function BillingTabs({
  value,
  onChange,
}: {
  value: AtendimentoBalde;
  onChange: (t: AtendimentoBalde) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next =
      e.key === 'ArrowRight' ? (idx + 1) % TABS.length : (idx - 1 + TABS.length) % TABS.length;
    onChange(TABS[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Visão do billing"
      className="mb-5 flex gap-1 rounded-pill border border-line bg-surface p-1 shadow-card"
    >
      {TABS.map((t, idx) => {
        const sel = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="tab"
            aria-selected={sel}
            tabIndex={sel ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={cn(
              'h-9 flex-1 rounded-pill font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
              sel ? 'bg-brand text-bg' : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
