'use client';

/**
 * Agenda do COLABORADOR — visão READ-ONLY (SCRUM-32). Reusa a MESMA lógica de
 * filtro por período (filtrarAgendamentos) e a formatação de dia/hora do painel do
 * dono, mas as linhas NÃO são clicáveis: o colaborador só CONSULTA (sem remarcar /
 * trocar serviço / cancelar — isso é do dono). Recebe `data` já pronta (estados
 * loading/erro/empty ficam na página).
 */
import { EventoTitulo } from '@/components/agenda/evento-titulo';
import { inicialDoTitulo } from '@/lib/agenda-titulo';
import { type PeriodoFiltro, filtrarAgendamentos } from '@/lib/agendamentos';
import type { Agendamento, ColaboradorAgendaResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatAgendamentoHora } from '@/lib/format';
import { useMemo, useState } from 'react';

const ABAS: { value: PeriodoFiltro; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'hoje', label: 'Hoje' },
  { value: 'proximos', label: 'Próximos' },
  { value: 'recentes', label: 'Recentes' },
];

export function ColaboradorAgendaClient({ data }: { data: ColaboradorAgendaResponse }) {
  const [periodo, setPeriodo] = useState<PeriodoFiltro>('todos');

  const filtradas = useMemo(
    () => filtrarAgendamentos(data.agendamentos, { periodo, busca: '', data: '' }),
    [data.agendamentos, periodo],
  );

  return (
    <div>
      <div
        role="tablist"
        aria-label="Filtrar por período"
        className="mb-3 flex gap-1.5 overflow-x-auto pb-0.5"
      >
        {ABAS.map((aba) => {
          const ativo = periodo === aba.value;
          return (
            <button
              key={aba.value}
              type="button"
              role="tab"
              aria-selected={ativo}
              onClick={() => setPeriodo(aba.value)}
              className={cn(
                'shrink-0 rounded-pill px-3.5 py-1.5 font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                ativo
                  ? 'bg-brand-soft text-brand'
                  : 'border border-line bg-surface text-ink-soft hover:bg-surface-hover hover:text-ink',
              )}
            >
              {aba.label}
            </button>
          );
        })}
      </div>

      {filtradas.length === 0 ? (
        <div className="rounded-card-sm border border-line bg-surface px-6 py-9 text-center">
          <h3 className="font-display text-[15px] font-semibold text-ink">Nada nesse período</h3>
          <p className="mx-auto mt-1.5 max-w-[34ch] text-[13.5px] text-ink-soft">
            Os horários que o robô marcar pra você aparecem aqui.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-card-sm border border-line bg-surface">
          {filtradas.map((ag) => (
            <AgendaRow key={ag.id} ag={ag} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Linha de consulta (não clicável) — nome + serviço + dia/hora. */
function AgendaRow({ ag }: { ag: Agendamento }) {
  const hora = formatAgendamentoHora(ag.inicio);
  const dia = formatAgendamentoDia(ag.inicio);
  return (
    <div className="group flex min-h-14 items-center gap-3.5 border-b border-line-soft px-[15px] py-[13px] last:border-b-0">
      <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-brand-soft font-display text-[13px] font-bold text-brand">
        {inicialDoTitulo(ag.titulo)}
      </span>
      <EventoTitulo titulo={ag.titulo} className="flex-1" />
      <div className="shrink-0 text-right text-[12.5px] text-ink-soft">
        {hora ? (
          <b className="block font-display text-[14px] font-semibold tabular-nums text-ink">
            {hora}
          </b>
        ) : null}
        {dia}
      </div>
    </div>
  );
}
