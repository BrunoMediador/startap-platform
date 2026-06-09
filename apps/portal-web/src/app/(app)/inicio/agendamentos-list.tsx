'use client';

/**
 * Agendamentos da Home (item 1 da leva 2). O backend manda janela -7/+14d ASC;
 * agrupamos client-side em Hoje / Proximos / Recentes (lib/agendamentos). Cada
 * grupo com header; dentro, Recentes DESC e Hoje/Proximos ASC. Trata 3 estados:
 *   - gcal_configured=false -> empty amigavel (pre-setup: agenda nao conectada).
 *   - sem eventos na janela  -> empty ("Nenhum agendamento nos ultimos 7 / ...").
 *   - com eventos            -> grupos. No grupo Hoje, o 1o evento ganha realce
 *     ambar lateral 3px (spec 1.2, caso "agora").
 */
import { IconCalendar } from '@/components/icons';
import {
  type GruposAgendamentos,
  agruparAgendamentos,
  totalAgendamentos,
} from '@/lib/agendamentos';
import type { Agendamento, AgendamentosResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatAgendamentoHora, initials } from '@/lib/format';

export function AgendamentosList({ data }: { data: AgendamentosResponse }) {
  if (!data.gcal_configured) {
    return (
      <EmptyBox
        title="Agenda ainda não conectada"
        description="Quando sua agenda estiver ligada, os próximos atendimentos aparecem aqui."
      />
    );
  }

  const grupos = agruparAgendamentos(data.agendamentos);
  if (totalAgendamentos(grupos) === 0) {
    return (
      <EmptyBox
        title="Nenhum agendamento por enquanto"
        description="Nenhum agendamento nos últimos 7 / próximos 14 dias. Os atendimentos marcados pelo robô vão aparecer aqui."
      />
    );
  }

  return (
    <div className="space-y-4">
      <Grupo titulo="Hoje" itens={grupos.hoje} destacaPrimeiro />
      <Grupo titulo="Próximos" itens={grupos.proximos} />
      <Grupo titulo="Recentes" itens={grupos.recentes} />
    </div>
  );
}

function Grupo({
  titulo,
  itens,
  destacaPrimeiro,
}: {
  titulo: string;
  itens: GruposAgendamentos[keyof GruposAgendamentos];
  destacaPrimeiro?: boolean;
}) {
  if (itens.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 px-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {titulo} <span className="text-ink-faint/70">· {itens.length}</span>
      </h3>
      <div className="overflow-hidden rounded-card-sm border border-line bg-surface shadow-card">
        {itens.map((ag, idx) => (
          <AgendamentoRow key={ag.id} ag={ag} destaque={Boolean(destacaPrimeiro) && idx === 0} />
        ))}
      </div>
    </section>
  );
}

function AgendamentoRow({ ag, destaque }: { ag: Agendamento; destaque: boolean }) {
  const hora = formatAgendamentoHora(ag.inicio);
  const dia = formatAgendamentoDia(ag.inicio);
  return (
    <div
      className={cn(
        'flex items-center gap-3.5 border-b border-line-soft px-[15px] py-[13px] last:border-b-0',
        destaque && 'border-l-[3px] border-l-amber',
      )}
    >
      <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] bg-brand-soft font-display text-[13px] font-bold text-brand">
        {initials(ag.titulo)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-[14px] font-semibold text-ink">{ag.titulo}</div>
      </div>
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

function EmptyBox({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center rounded-card-sm border border-line bg-surface px-6 py-8 text-center shadow-card">
      <IconCalendar size={36} className="mb-2.5 text-ink-faint" />
      <h3 className="font-display text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-[280px] text-[13px] text-ink-soft">{description}</p>
    </div>
  );
}
