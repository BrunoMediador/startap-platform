'use client';

/**
 * AreaSelector (W8 da Missão 023) — o dono diz "que tipo de negócio é o meu" no
 * cadastro, pra o robô já nascer com o tom/serviços certos da área dele.
 *
 * Radiogroup ACESSÍVEL de cards (NÃO <select> nativo): cards são mais tocáveis
 * no mobile e mais claros (spec W8). Padrão WAI-ARIA radio com roving tabindex —
 * Tab entra no grupo (no item marcado, ou no 1º), setas movem entre opções e
 * marcam, Home/End vão pros extremos. A seleção é visível por MAIS que cor
 * (check + borda + fundo), pra daltonismo (spec acessibilidade).
 *
 * Os slugs (`barbearia`...`outros`) são o contrato do POST /auth/signup; os
 * rótulos abaixo são só de exibição. "Outro serviço" é o catch-all e ocupa a
 * largura dupla pra caber o texto.
 */
import {
  IconBrush,
  IconCalendar,
  IconCheck,
  IconScissors,
  IconSparkle,
  IconUser,
} from '@/components/icons';
import { AREAS_SLUGS, type Area } from '@/lib/cadastro';
import { cn } from '@/lib/cn';
import { useId, useRef } from 'react';

interface AreaOption {
  slug: Area;
  label: string;
  Icon: typeof IconScissors;
  /** Catch-all "Outro serviço" ocupa 2 colunas (texto mais longo). */
  wide?: boolean;
}

const OPTIONS: AreaOption[] = [
  { slug: 'barbearia', label: 'Barbearia', Icon: IconScissors },
  { slug: 'cabeleireiro', label: 'Cabeleireiro', Icon: IconUser },
  { slug: 'manicure', label: 'Manicure', Icon: IconBrush },
  { slug: 'estetica', label: 'Estética', Icon: IconSparkle },
  { slug: 'outros', label: 'Outro serviço com agendamento', Icon: IconCalendar, wide: true },
];

interface AreaSelectorProps {
  value: Area | null;
  error?: string;
  onChange: (area: Area) => void;
}

export function AreaSelector({ value, error, onChange }: AreaSelectorProps) {
  const labelId = useId();
  const errId = `${labelId}-err`;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  /** Move foco + seleção pro índice (roving tabindex). */
  function focusIndex(i: number) {
    const n = OPTIONS.length;
    const idx = ((i % n) + n) % n;
    const opt = OPTIONS[idx];
    if (opt) {
      onChange(opt.slug);
      refs.current[idx]?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        focusIndex(i + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        focusIndex(i - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        focusIndex(OPTIONS.length - 1);
        break;
      default:
        break;
    }
  }

  // Item que recebe Tab: o marcado, ou o 1º quando nada marcado (padrão radio).
  const tabbableIdx = Math.max(
    0,
    OPTIONS.findIndex((o) => o.slug === value),
  );

  return (
    <div className="flex w-full flex-col gap-[7px]">
      <span id={labelId} className="text-[13px] font-semibold text-ink">
        Qual é o seu tipo de negócio?
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={error ? errId : undefined}
        aria-invalid={error ? true : undefined}
        className="grid grid-cols-2 gap-2"
      >
        {OPTIONS.map((opt, i) => {
          const ativo = opt.slug === value;
          const { Icon } = opt;
          return (
            <button
              key={opt.slug}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={ativo}
              tabIndex={i === tabbableIdx ? 0 : -1}
              onClick={() => onChange(opt.slug)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                'relative flex min-h-[60px] items-center gap-2.5 rounded-card-sm border-[1.5px] px-3 py-2.5 text-left outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                opt.wide && 'col-span-2',
                ativo
                  ? 'border-brand bg-brand-soft text-ink'
                  : 'border-line bg-surface text-ink-soft hover:border-line-strong hover:bg-surface-hover',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-[9px] border transition-colors',
                  ativo
                    ? 'border-brand/40 bg-brand-soft text-brand'
                    : 'border-line-strong text-ink-soft',
                )}
              >
                <Icon size={18} />
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 font-display text-[13.5px] font-semibold leading-tight',
                  ativo ? 'text-brand' : 'text-ink',
                )}
              >
                {opt.label}
              </span>
              {/* Check no canto: seleção legível além da cor (daltonismo). */}
              {ativo && (
                <span
                  aria-hidden
                  className="absolute right-2 top-2 flex size-[18px] items-center justify-center rounded-full bg-brand text-bg"
                >
                  <IconCheck size={11} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {error && (
        <p id={errId} role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
