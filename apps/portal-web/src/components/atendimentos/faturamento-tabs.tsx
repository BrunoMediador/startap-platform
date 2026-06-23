'use client';

/**
 * Segmented control da área de faturamento (ADR 0027 Fase C). Três abas quando o
 * billing-da-agenda está ON: Previsão | Faturado | Resumo. "Resumo" é o relatório
 * agregado de hoje (por forma/profissional). Com a flag OFF, a página nem monta
 * essas abas (mostra só o Resumo) — SOLO fica idêntico ao de hoje.
 *
 * `role=tablist` + `aria-selected` + setas ←/→ pra acessibilidade de teclado.
 */
import { cn } from '@/lib/cn';
import { useRef } from 'react';

export type FaturamentoTab = 'previsao' | 'faturado' | 'resumo';

const TABS: { id: FaturamentoTab; label: string }[] = [
  { id: 'previsao', label: 'Previsão' },
  { id: 'faturado', label: 'Faturado' },
  { id: 'resumo', label: 'Resumo' },
];

export function FaturamentoTabs({
  value,
  onChange,
}: {
  value: FaturamentoTab;
  onChange: (t: FaturamentoTab) => void;
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
      aria-label="Visão do faturamento"
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
