'use client';

/**
 * FormatoSelector (Onda 3 do SCRUM-68 / ADR 0030 D2) — as DUAS perguntas de formato
 * do cadastro, logo depois da área. Deixam os 4 formatos contratáveis pelo signup,
 * sem env manual:
 *
 *   1) "Você atende sozinho ou tem uma equipe?"      → tipo_atendimento
 *   2) "A assistente marca sozinha na agenda, ou só atende?" → modo_ia
 *
 * Cada pergunta é um RADIOGROUP acessível de 2 cards (mesmo padrão do AreaSelector:
 * roving tabindex, setas/Home/End, seleção visível por check+borda+fundo, não só
 * cor). O combo default (Sozinho + Marca na agenda) vem PRÉ-SELECIONADO — quem só
 * quer o padrão não precisa tocar em nada (e o payload sai byte-idêntico ao de hoje;
 * ver lib/cadastro formatoFields).
 */
import { IconCalendar, IconCheck, IconHeadset, IconUser, IconUsers } from '@/components/icons';
import type { ModoIa, TipoAtendimento } from '@/lib/cadastro';
import { cn } from '@/lib/cn';
import { useId, useRef } from 'react';

interface Choice<T extends string> {
  value: T;
  label: string;
  /** Descrição curta em 1 linha — orienta a escolha sem jargão. */
  hint: string;
  Icon: typeof IconUser;
}

const TIPO_OPTIONS: Choice<TipoAtendimento>[] = [
  { value: 'individual', label: 'Atendo sozinho', hint: 'Só você atende', Icon: IconUser },
  {
    value: 'estabelecimento',
    label: 'Tenho equipe',
    hint: 'Vários profissionais',
    Icon: IconUsers,
  },
];

const MODO_OPTIONS: Choice<ModoIa>[] = [
  {
    value: 'agenda',
    label: 'Marca na agenda',
    hint: 'A assistente agenda os horários sozinha',
    Icon: IconCalendar,
  },
  {
    value: 'atendente',
    label: 'Só atende',
    hint: 'Ela responde e encaminha pra você fechar',
    Icon: IconHeadset,
  },
];

/**
 * Radiogroup genérico de N escolhas em cards (roving tabindex, WAI-ARIA radio).
 * Extraído pra as 2 perguntas compartilharem a acessibilidade sem duplicação.
 */
function ChoiceGroup<T extends string>({
  question,
  options,
  value,
  onChange,
}: {
  question: string;
  options: Choice<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  const labelId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function focusIndex(i: number) {
    const n = options.length;
    const idx = ((i % n) + n) % n;
    const opt = options[idx];
    if (opt) {
      onChange(opt.value);
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
        focusIndex(options.length - 1);
        break;
      default:
        break;
    }
  }

  // Sempre há um marcado (pré-selecionado) — ele recebe o Tab.
  const tabbableIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  return (
    <div className="flex w-full flex-col gap-[7px]">
      <span id={labelId} className="text-[13px] font-semibold text-ink">
        {question}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-2 gap-2">
        {options.map((opt, i) => {
          const ativo = opt.value === value;
          const { Icon } = opt;
          return (
            <button
              key={opt.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={ativo}
              tabIndex={i === tabbableIdx ? 0 : -1}
              onClick={() => onChange(opt.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                'relative flex min-h-[76px] flex-col gap-1 rounded-card-sm border-[1.5px] px-3 py-2.5 pr-7 text-left outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                ativo
                  ? 'border-brand bg-brand-soft text-ink'
                  : 'border-line bg-surface text-ink-soft hover:border-line-strong hover:bg-surface-hover',
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-[8px] border transition-colors',
                    ativo
                      ? 'border-brand/40 bg-brand-soft text-brand'
                      : 'border-line-strong text-ink-soft',
                  )}
                >
                  <Icon size={16} />
                </span>
                <span
                  className={cn(
                    'min-w-0 font-display text-[13.5px] font-semibold leading-tight',
                    ativo ? 'text-brand' : 'text-ink',
                  )}
                >
                  {opt.label}
                </span>
              </span>
              <span className="text-[11.5px] leading-snug text-ink-faint">{opt.hint}</span>
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
    </div>
  );
}

export function FormatoSelector({
  tipoAtendimento,
  modoIa,
  onChangeTipo,
  onChangeModo,
}: {
  tipoAtendimento: TipoAtendimento;
  modoIa: ModoIa;
  onChangeTipo: (v: TipoAtendimento) => void;
  onChangeModo: (v: ModoIa) => void;
}) {
  return (
    <>
      <ChoiceGroup
        question="Você atende sozinho ou tem uma equipe?"
        options={TIPO_OPTIONS}
        value={tipoAtendimento}
        onChange={onChangeTipo}
      />
      <ChoiceGroup
        question="A assistente marca sozinha na sua agenda, ou só atende e encaminha?"
        options={MODO_OPTIONS}
        value={modoIa}
        onChange={onChangeModo}
      />
    </>
  );
}
