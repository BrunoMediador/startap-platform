'use client';

/**
 * Agenda do COLABORADOR (SCRUM-32). Filtro de DATA igual ao do dono (PeriodSelector
 * + lib/billing-periodo): presets rápidos + janela [de, ate]. O período é
 * CONTROLADO pela página (ele vira a janela past/ahead do fetch); aqui só
 * renderizamos o seletor e aparamos a lista pro intervalo EXATO (filtrarPorPeriodo).
 *
 * Com `agenda_write_enabled === true` do servidor, o colaborador também pode
 * abrir SOMENTE seus eventos para remarcar/cancelar e criar um novo horário.
 * Ausência/falso preserva a superfície histórica de consulta.
 */
import { EventoTitulo } from '@/components/agenda/evento-titulo';
import { ColaboradorAgendaDetailSheet } from '@/components/colaborador/colaborador-agenda-detail-sheet';
import { useColaborador } from '@/components/colaborador/colaborador-session-context';
import { PeriodSelector } from '@/components/relatorios/period-selector';
import { TenantTzValueProvider, useTenantTz } from '@/components/shell/tenant-tz-context';
import { inicialDoTitulo } from '@/lib/agenda-titulo';
import { podeGerenciarAgendaColaborador } from '@/lib/colaborador-agenda-write';
import type { Agendamento, ColaboradorAgendaResponse } from '@/lib/api-types';
import type { Periodo } from '@/lib/billing-periodo';
import {
  agendaPeriodoLimites,
  agendaPeriodoPresets,
  filtrarPorPeriodo,
} from '@/lib/colaborador-agenda-periodo';
import { formatAgendamentoDia, formatAgendamentoHora } from '@/lib/format';
import Link from 'next/link';
import { useMemo, useState } from 'react';

export function ColaboradorAgendaClient({
  data,
  periodo,
  onPeriodoChange,
}: {
  data: ColaboradorAgendaResponse;
  periodo: Periodo;
  onPeriodoChange: (p: Periodo) => void;
}) {
  // Fuso do clone vem da SESSÃO do colaborador (/auth/colaborador/me): ele não tem acesso a
  // /portal/status. Default São Paulo se ausente (TenantTzValueProvider).
  const { timezone } = useColaborador();
  const presets = useMemo(() => agendaPeriodoPresets(), []);
  const limites = useMemo(() => agendaPeriodoLimites(periodo), [periodo]);
  const filtradas = useMemo(
    () => filtrarPorPeriodo(data.agendamentos, periodo),
    [data.agendamentos, periodo],
  );
  const [aberto, setAberto] = useState<Agendamento | null>(null);
  const podeGerenciar = podeGerenciarAgendaColaborador(data);

  return (
    <TenantTzValueProvider timeZone={timezone}>
      <div>
        {podeGerenciar ? (
          <div className="mb-4 flex justify-end">
            <Link
              href="/colaborador/agenda/novo"
              className="inline-flex min-h-11 items-center justify-center rounded-btn bg-brand px-5 font-display text-[14px] font-semibold text-bg outline-none transition-colors hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Novo horário
            </Link>
          </div>
        ) : null}
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
              Escolha outras datas acima ou aguarde — os horários marcados pra você aparecem aqui.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-card-sm border border-line bg-surface">
            {filtradas.map((ag) => (
              <AgendaRow key={ag.id} ag={ag} onOpen={podeGerenciar ? () => setAberto(ag) : undefined} />
            ))}
          </div>
        )}
        {podeGerenciar ? (
          <ColaboradorAgendaDetailSheet agendamento={aberto} onClose={() => setAberto(null)} />
        ) : null}
      </div>
    </TenantTzValueProvider>
  );
}

/** Linha própria: ação só é montada quando o servidor liberou a escrita. */
function AgendaRow({ ag, onOpen }: { ag: Agendamento; onOpen?: () => void }) {
  const tz = useTenantTz();
  const hora = formatAgendamentoHora(ag.inicio, tz);
  const dia = formatAgendamentoDia(ag.inicio, undefined, tz);
  const conteudo = (
    <>
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
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Abrir horário de ${ag.titulo}`}
        className="group flex min-h-14 w-full items-center gap-3.5 border-b border-line-soft px-[15px] py-[13px] text-left outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand last:border-b-0"
      >
        {conteudo}
      </button>
    );
  }
  return (
    <div className="group flex min-h-14 items-center gap-3.5 border-b border-line-soft px-[15px] py-[13px] last:border-b-0">
      {conteudo}
    </div>
  );
}
