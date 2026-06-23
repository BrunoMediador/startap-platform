'use client';

/**
 * Agenda de ESTABELECIMENTO (multi-profissional) — variante da agenda individual
 * (#332) pra clientes product_type='estabelecimento' (ex.: barber_dragon). Mostra
 * os eventos AGREGADOS de todas as agendas dos colaboradores, com:
 *   - COR por profissional (estável; legenda + filtro no topo);
 *   - agendamentos PARALELOS (mesmo horário, profissionais distintos) LADO A LADO;
 *   - filtro por profissional (Todos / um específico);
 *   - descritivo (cliente + serviço + profissional + horário), reusando o
 *     tratamento de nomes longos (#332) e o MESMO sheet de detalhe (remarcar/
 *     trocar/cancelar).
 *
 * Os dados vêm da MESMA query useAgendamentos (cache quente). Estados loading/erro/
 * empty ficam na PÁGINA; aqui só renderiza `data` já pronta. No clone INDIVIDUAL
 * esta tela NÃO é usada — a page escolhe AgendaClient (sem cores/profissional).
 */
import {
  agruparPorHorario,
  filtrarPorProfissional,
  profissionaisNaAgenda,
} from '@/lib/agenda-estabelecimento';
import { type PeriodoFiltro, filtrarAgendamentos } from '@/lib/agendamentos';
import type { Agendamento, AgendamentosResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { useMemo, useState } from 'react';
import { AgendaDetailSheet } from './agenda-detail-sheet';
import { EstabelecimentoHorarioGrupo } from './estabelecimento-horario-grupo';
import { ProfissionalFiltro } from './profissional-filtro';

const ABAS: { value: PeriodoFiltro; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'hoje', label: 'Hoje' },
  { value: 'proximos', label: 'Próximos' },
  { value: 'recentes', label: 'Recentes' },
];

export function AgendaEstabelecimentoClient({
  slot,
  data,
}: {
  slot: string;
  data: AgendamentosResponse;
}) {
  // Default 'todos' (igual ao SOLO): 'hoje' mostrava "Nada nesse período" quando
  // a agenda só tem eventos de outros dias — confuso pra quem acabou de abrir.
  const [periodo, setPeriodo] = useState<PeriodoFiltro>('todos');
  const [profissionalId, setProfissionalId] = useState<number | null>(null);
  const [aberto, setAberto] = useState<Agendamento | null>(null);

  // Legenda/filtro: profissionais presentes na janela INTEIRA (não muda com o
  // período/filtro selecionado — a legenda fica estável).
  const profissionais = useMemo(
    () => profissionaisNaAgenda(data.agendamentos),
    [data.agendamentos],
  );

  // Pipeline: período -> profissional -> agrupa por horário (paralelos juntos).
  const grupos = useMemo(() => {
    const porPeriodo = filtrarAgendamentos(data.agendamentos, { periodo, busca: '', data: '' });
    const porProf = filtrarPorProfissional(porPeriodo, profissionalId);
    return agruparPorHorario(porProf);
  }, [data.agendamentos, periodo, profissionalId]);

  const totalVisivel = grupos.reduce((acc, g) => acc + g.eventos.length, 0);
  // "Todos" cruza vários dias → mostra o dia no rótulo de cada horário.
  const mostrarDia = periodo === 'todos' || periodo === 'proximos' || periodo === 'recentes';

  return (
    <div>
      {/* Legenda + filtro por profissional (cor estável por colaborador). */}
      {profissionais.length > 0 && (
        <div className="mb-3">
          <ProfissionalFiltro
            profissionais={profissionais}
            selecionado={profissionalId}
            onSelecionar={setProfissionalId}
          />
        </div>
      )}

      {/* Abas de período. */}
      <div
        role="tablist"
        aria-label="Filtrar por período"
        className="mb-4 flex gap-1.5 overflow-x-auto pb-0.5"
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

      {totalVisivel === 0 ? (
        <VazioFiltro
          temProfFiltro={profissionalId !== null}
          onLimpar={() => {
            setPeriodo('todos');
            setProfissionalId(null);
          }}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {grupos.map((g) => (
            <EstabelecimentoHorarioGrupo
              key={g.chave}
              grupo={g}
              mostrarDia={mostrarDia}
              onAbrir={(ag) => setAberto(ag)}
            />
          ))}
        </div>
      )}

      <AgendaDetailSheet slot={slot} agendamento={aberto} onClose={() => setAberto(null)} />
    </div>
  );
}

function VazioFiltro({
  temProfFiltro,
  onLimpar,
}: {
  temProfFiltro: boolean;
  onLimpar: () => void;
}) {
  return (
    <div className="rounded-card-sm border border-line bg-surface px-6 py-8 text-center">
      <h3 className="font-display text-[15px] font-semibold text-ink">
        {temProfFiltro ? 'Nada para esse profissional nesse período' : 'Nada nesse período'}
      </h3>
      <p className="mx-auto mt-1.5 max-w-[34ch] text-[13.5px] text-ink-soft">
        Os horários marcados pelos profissionais aparecem aqui, cada um com a cor dele.
      </p>
      <button
        type="button"
        onClick={onLimpar}
        className="mt-4 inline-flex h-9 items-center rounded-card-sm border border-line-strong bg-surface px-4 font-display text-[13px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
      >
        Ver todos
      </button>
    </div>
  );
}
