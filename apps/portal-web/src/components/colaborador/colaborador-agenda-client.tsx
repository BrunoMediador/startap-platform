'use client';

/**
 * Agenda do COLABORADOR (SCRUM-32). Filtro de DATA igual ao do dono (PeriodSelector
 * + lib/billing-periodo): presets rápidos + janela [de, ate]. O período é
 * CONTROLADO pela página (ele vira a janela past/ahead do fetch); aqui só
 * renderizamos o seletor e aparamos a lista pro intervalo EXATO (filtrarPorPeriodo).
 *
 * As linhas NÃO são clicáveis: o colaborador só CONSULTA (sem remarcar / trocar
 * serviço / cancelar — isso é do dono). Recebe `data` já pronta (loading/erro/
 * agenda-não-conectada ficam na página).
 */
import { EventoTitulo } from '@/components/agenda/evento-titulo';
import { PeriodSelector } from '@/components/relatorios/period-selector';
import { inicialDoTitulo } from '@/lib/agenda-titulo';
import type { Agendamento, ColaboradorAgendaResponse } from '@/lib/api-types';
import type { Periodo } from '@/lib/billing-periodo';
import {
  agendaPeriodoLimites,
  agendaPeriodoPresets,
  filtrarPorPeriodo,
} from '@/lib/colaborador-agenda-periodo';
import { formatAgendamentoDia, formatAgendamentoHora } from '@/lib/format';
import { useMemo } from 'react';

export function ColaboradorAgendaClient({
  data,
  periodo,
  onPeriodoChange,
}: {
  data: ColaboradorAgendaResponse;
  periodo: Periodo;
  onPeriodoChange: (p: Periodo) => void;
}) {
  const presets = useMemo(() => agendaPeriodoPresets(), []);
  const limites = useMemo(() => agendaPeriodoLimites(periodo), [periodo]);
  const filtradas = useMemo(
    () => filtrarPorPeriodo(data.agendamentos, periodo),
    [data.agendamentos, periodo],
  );

  return (
    <div>
      <PeriodSelector
        value={periodo}
        onChange={onPeriodoChange}
        presets={presets}
        limites={limites}
      />

      {filtradas.length === 0 ? (
        <div className="rounded-card-sm border border-line bg-surface px-6 py-9 text-center">
          <h3 className="font-display text-[15px] font-semibold text-ink">Nada nesse período</h3>
          <p className="mx-auto mt-1.5 max-w-[34ch] text-[13.5px] text-ink-soft">
            Escolha outras datas acima ou aguarde — os horários que o robô marcar pra você aparecem
            aqui.
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
