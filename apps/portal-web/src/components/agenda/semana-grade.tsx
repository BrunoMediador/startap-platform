'use client';

/**
 * Visão Semana (Bloco A) — grade CSS de 7 colunas (segunda→domingo), SEM lib de
 * calendário. Navega semana a semana (offset). Cada dia é uma coluna com chips
 * dos agendamentos (horário início→fim quando há serviço; senão só início).
 * Chip clicável -> abre o detalhe (mesmo sheet da Lista).
 *
 * Mobile-first: as 7 colunas viram scroll horizontal (min-width por coluna);
 * no desktop cabem lado a lado. Eventos sem data aparecem num aviso à parte.
 */
import { IconChevronLeft, IconChevronRight } from '@/components/icons';
import { type DiaSemanaAgenda, buildSemana, semDataCount } from '@/lib/agenda-semana';
import { parseTitulo } from '@/lib/agenda-titulo';
import type { Agendamento } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatAgendamentoHora } from '@/lib/format';
import { useMemo, useState } from 'react';

export function SemanaGrade({
  agendamentos,
  onAbrir,
}: {
  agendamentos: Agendamento[];
  onAbrir: (ag: Agendamento) => void;
}) {
  const [offset, setOffset] = useState(0);
  const semana = useMemo(() => buildSemana(agendamentos, offset), [agendamentos, offset]);
  const semData = useMemo(() => semDataCount(agendamentos), [agendamentos]);

  return (
    <div>
      {/* Navegação de semana. */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <button
          type="button"
          aria-label="Semana anterior"
          onClick={() => setOffset((o) => o - 1)}
          className="flex size-9 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
        >
          <IconChevronLeft size={18} />
        </button>
        <div className="text-center">
          <p className="font-display text-[14.5px] font-semibold text-ink">{semana.titulo}</p>
          {offset !== 0 && (
            <button
              type="button"
              onClick={() => setOffset(0)}
              className="text-[12px] font-semibold text-brand underline-offset-2 hover:underline"
            >
              Voltar pra esta semana
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Próxima semana"
          onClick={() => setOffset((o) => o + 1)}
          className="flex size-9 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
        >
          <IconChevronRight size={18} />
        </button>
      </div>

      {/* Grade 7 colunas: scroll-x no mobile (min-w por coluna), fit no desktop.
          Fade na borda direita (mobile) sinaliza que há mais dias pra rolar — sem
          ele o dono pode achar que a semana acaba na 1ª dobra (~3,5 dias). */}
      <div className="relative -mx-1">
        <div className="overflow-x-auto pb-1">
          <div className="grid min-w-[680px] grid-cols-7 gap-1.5 px-1 md:min-w-0">
            {semana.dias.map((dia) => (
              <ColunaDia key={dia.dateKey} dia={dia} onAbrir={onAbrir} />
            ))}
          </div>
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-bg to-transparent md:hidden"
        />
      </div>

      {semData > 0 && (
        <p className="mt-3 rounded-card-sm border border-line bg-surface px-3.5 py-2.5 text-[12.5px] text-ink-soft">
          {semData}{' '}
          {semData === 1 ? 'agendamento sem data definida' : 'agendamentos sem data definida'} —
          veja na visão Lista.
        </p>
      )}
    </div>
  );
}

function ColunaDia({
  dia,
  onAbrir,
}: {
  dia: DiaSemanaAgenda;
  onAbrir: (ag: Agendamento) => void;
}) {
  return (
    <div
      className={cn(
        'flex min-h-[140px] flex-col rounded-card-sm border bg-surface',
        dia.hoje ? 'border-brand' : 'border-line',
      )}
    >
      {/* Cabeçalho do dia. */}
      <div
        className={cn(
          'flex items-baseline justify-between rounded-t-card-sm border-b px-2 py-1.5',
          dia.hoje ? 'border-brand/40 bg-brand-soft' : 'border-line-soft',
        )}
      >
        <span
          className={cn(
            'text-[11px] font-semibold uppercase tracking-[0.03em]',
            dia.hoje ? 'text-brand' : 'text-ink-faint',
          )}
        >
          {dia.curto}
        </span>
        <span
          className={cn(
            'font-display text-[14px] font-bold tabular-nums',
            dia.hoje ? 'text-brand' : 'text-ink',
          )}
        >
          {dia.diaNum}
        </span>
      </div>

      {/* Chips dos eventos do dia. */}
      <div className="flex flex-1 flex-col gap-1 p-1.5">
        {dia.eventos.length === 0 ? (
          <span className="my-auto text-center text-[11px] text-ink-faint">—</span>
        ) : (
          dia.eventos.map((ag) => <ChipEvento key={ag.id} ag={ag} onClick={() => onAbrir(ag)} />)
        )}
      </div>
    </div>
  );
}

function ChipEvento({ ag, onClick }: { ag: Agendamento; onClick: () => void }) {
  const { nome, raw } = parseTitulo(ag.titulo);
  const inicio = formatAgendamentoHora(ag.inicio);
  const fim = formatAgendamentoHora(ag.fim);
  const faixa = inicio && fim ? `${inicio}–${fim}` : inicio || '';
  return (
    <button
      type="button"
      onClick={onClick}
      title={raw || undefined}
      className="w-full rounded-[8px] border border-line-strong bg-brand-soft px-2 py-1.5 text-left outline-none transition-colors hover:bg-brand-soft-hover focus-visible:ring-2 focus-visible:ring-brand"
    >
      {faixa && (
        <span className="block font-display text-[11px] font-bold tabular-nums text-brand">
          {faixa}
        </span>
      )}
      <span className="block truncate text-[12px] font-medium text-ink">{nome}</span>
    </button>
  );
}
