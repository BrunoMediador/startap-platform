'use client';

/**
 * TimezoneCombobox — seletor de fuso horário "Brasil no topo, mundo por busca".
 *
 * Decisão do Bruno: combobox COM BUSCA, fusos do Brasil fixados no topo, o mundo
 * inteiro alcançável digitando ("cui" acha Cuiabá, "lis" Lisboa). Cada opção mostra
 * rótulo amigável + offset atual "(UTC±N)" — DST-correto, computado via Intl (nunca
 * chumbado). Emite o nome IANA. É SELEÇÃO, nunca campo aberto (o texto só busca; o
 * valor sempre sai de uma opção real).
 *
 * A11y (padrão WAI-ARIA combobox + listbox): o input de busca é `role=combobox`
 * com `aria-expanded`/`aria-controls`/`aria-activedescendant`; a lista é
 * `role=listbox`; cada item é `role=option` com `aria-selected`. Teclado: ↑/↓
 * andam, Enter escolhe, Esc fecha, Home/End vão aos extremos. Foco visível, alvo
 * ~44px, contraste AA. Fecha em clique fora e devolve o foco ao gatilho.
 */

import { IconCheck, IconChevronRight, IconClock, IconSearch } from '@/components/icons';
import { cn } from '@/lib/cn';
import {
  type TimezoneOption,
  buildTimezoneOptions,
  filterTimezones,
  friendlyLabel,
  getUtcOffsetLabel,
} from '@/lib/timezones';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';

interface TimezoneComboboxProps {
  /** Fuso IANA selecionado (ex.: "America/Sao_Paulo"). */
  value: string;
  onChange: (id: string) => void;
  label: string;
  /** Texto de ajuda sob o campo (some quando há erro). */
  hint?: string;
  error?: string;
  id?: string;
  /** Esconde visualmente o label mantendo-o pra leitores de tela. */
  hideLabel?: boolean;
}

export function TimezoneCombobox({
  value,
  onChange,
  label,
  hint,
  error,
  id,
  hideLabel,
}: TimezoneComboboxProps) {
  const autoId = useId();
  const baseId = id ?? autoId;
  const listId = `${baseId}-listbox`;
  const errId = `${baseId}-err`;
  const hintId = `${baseId}-hint`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Opções agrupadas (Brasil + mundo). Computadas 1x por montagem (offset "de agora"
  // é estável no ciclo de vida da tela); `value` só garante que o selecionado exista.
  const groups = useMemo(() => buildTimezoneOptions(value), [value]);

  const searching = query.trim().length > 0;
  // Lista PLANA na MESMA ordem em que é renderizada (pro aria-activedescendant/teclado).
  const flat: TimezoneOption[] = useMemo(
    () => (searching ? filterTimezones(groups, query) : [...groups.brazil, ...groups.world]),
    [groups, query, searching],
  );

  // Rótulo do gatilho: o que está selecionado (sempre há um; default São Paulo).
  const currentLabel = friendlyLabel(value);
  const currentOffset = getUtcOffsetLabel(value);

  // Ao abrir: foca a busca e posiciona o "ativo" no item selecionado (ou 1º).
  // biome-ignore lint/correctness/useExhaustiveDependencies: roda só na transição de abrir; `flat`/`value` são lidos como snapshot inicial de propósito (não re-executar a cada tecla).
  useEffect(() => {
    if (!open) return;
    const idx = flat.findIndex((o) => o.id === value);
    setActive(idx >= 0 ? idx : 0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Rola o item ativo pra dentro da viewport da lista.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(`${baseId}-opt-${active}`)}`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open, baseId]);

  // Fecha ao clicar fora.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  function close(returnFocus = false) {
    setOpen(false);
    setQuery('');
    if (returnFocus) triggerRef.current?.focus();
  }

  function choose(opt: TimezoneOption) {
    onChange(opt.id);
    close(true);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(i + 1, flat.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(flat.length - 1);
        break;
      case 'Enter': {
        e.preventDefault();
        const opt = flat[active];
        if (opt) choose(opt);
        break;
      }
      case 'Escape':
        e.preventDefault();
        close(true);
        break;
      default:
        break;
    }
  }

  const activeId = flat[active] ? `${baseId}-opt-${active}` : undefined;

  return (
    <div className="flex w-full flex-col gap-[7px]" ref={rootRef}>
      <label
        htmlFor={`${baseId}-trigger`}
        className={cn('text-[13px] font-semibold text-ink', hideLabel && 'sr-only')}
      >
        {label}
      </label>

      <div className="relative">
        {/* Gatilho: mostra o selecionado + offset. Abre o painel de busca. */}
        <button
          ref={triggerRef}
          id={`${baseId}-trigger`}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-invalid={error ? true : undefined}
          aria-describedby={cn(error && errId, hint && !error && hintId) || undefined}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'flex h-[50px] w-full items-center gap-2.5 rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 text-left text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms]',
            'hover:border-[var(--c-input-hover-border)]',
            'focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/35 focus-visible:shadow-focus',
            error && 'border-danger',
          )}
        >
          <IconClock size={17} className="shrink-0 text-ink-soft" />
          <span className="min-w-0 flex-1 truncate">{currentLabel}</span>
          <span className="shrink-0 text-[13px] tabular-nums text-ink-soft">{currentOffset}</span>
          <IconChevronRight
            size={16}
            className={cn(
              'shrink-0 text-ink-soft transition-transform',
              open ? '-rotate-90' : 'rotate-90',
            )}
          />
        </button>

        {open && (
          <div className="absolute z-50 mt-1.5 w-full overflow-hidden rounded-card border border-line-strong bg-surface-elev shadow-elev">
            {/* Busca: filtra a lista IANA inteira (Brasil-first). Só busca, não digita valor. */}
            <div className="flex items-center gap-2 border-b border-line px-3">
              <IconSearch size={16} className="shrink-0 text-ink-faint" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                aria-label="Buscar fuso horário"
                autoComplete="off"
                spellCheck={false}
                placeholder="Buscar cidade ou país…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0); // nova busca -> ativo volta pro 1º resultado
                }}
                onKeyDown={onKeyDown}
                className="h-11 w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-faint"
              />
            </div>

            <div
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-label={label}
              className="max-h-[280px] overflow-y-auto overscroll-contain py-1 outline-none"
            >
              {flat.length === 0 && (
                <p className="px-3 py-6 text-center text-[13px] text-ink-soft" aria-live="polite">
                  Nenhum fuso encontrado.
                </p>
              )}

              {!searching && groups.brazil.length > 0 && <GroupHeader>Brasil</GroupHeader>}
              {flat.map((opt, i) => {
                // Cabeçalho "Todos os fusos" antes do 1º item não-Brasil (só sem busca).
                const showWorldHeader =
                  !searching && !opt.brazil && (i === 0 || flat[i - 1]?.brazil === true);
                return (
                  <Fragment key={opt.id}>
                    {showWorldHeader && <GroupHeader>Todos os fusos</GroupHeader>}
                    <OptionRow
                      id={`${baseId}-opt-${i}`}
                      opt={opt}
                      selected={opt.id === value}
                      active={i === active}
                      onSelect={() => choose(opt)}
                      onHover={() => setActive(i)}
                    />
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {hint && !error && (
        <p id={hintId} className="text-[12px] leading-normal text-ink-soft">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
      {children}
    </div>
  );
}

function OptionRow({
  id,
  opt,
  selected,
  active,
  onSelect,
  onHover,
}: {
  id: string;
  opt: TimezoneOption;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    // Padrão listbox+aria-activedescendant: o teclado vive no input role=combobox; a
    // opção só recebe ponteiro (mouseDown seleciona antes do blur; mouseMove realça).
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      onMouseDown={(e) => {
        // Evita o blur do input antes do clique registrar.
        e.preventDefault();
        onSelect();
      }}
      onMouseMove={onHover}
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-[14px]',
        active ? 'bg-brand-soft text-ink' : 'text-ink',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-brand">
        {selected && <IconCheck size={15} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{opt.label}</span>
      <span className="shrink-0 text-[12.5px] tabular-nums text-ink-soft">{opt.offsetLabel}</span>
    </div>
  );
}
