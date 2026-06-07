'use client';

/**
 * Lista de proximos agendamentos da Home (spec direcao-1). Trata os 3 estados:
 *   - gcal_configured=false -> empty amigavel ("Agenda ainda nao conectada").
 *   - sem eventos           -> empty ("Nenhum agendamento por enquanto").
 *   - com eventos           -> linhas com iniciais + titulo + hora/dia. O primeiro
 *     evento (proximo) ganha realce ambar lateral 3px (spec 1.2, caso "agora").
 */
import { IconCalendar } from '@/components/icons';
import type { AgendamentosResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatDiaRelativo, formatHora, initials } from '@/lib/format';

export function AgendamentosList({ data }: { data: AgendamentosResponse }) {
  if (!data.gcal_configured) {
    return (
      <EmptyBox
        title="Agenda ainda não conectada"
        description="Quando sua agenda estiver ligada, os próximos atendimentos aparecem aqui."
      />
    );
  }
  if (data.agendamentos.length === 0) {
    return (
      <EmptyBox
        title="Nenhum agendamento por enquanto"
        description="Os próximos atendimentos marcados pelo robô vão aparecer aqui."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-card-sm border border-line bg-surface">
      {data.agendamentos.slice(0, 5).map((ag, idx) => (
        <div
          key={ag.id}
          className={cn(
            'flex items-center gap-3.5 border-b border-line px-[15px] py-[13px] last:border-b-0',
            idx === 0 && 'border-l-[3px] border-l-amber',
          )}
        >
          <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] bg-brand-soft font-display text-[13px] font-bold text-brand">
            {initials(ag.titulo)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-[14px] font-semibold text-ink">
              {ag.titulo}
            </div>
          </div>
          <div className="shrink-0 text-right text-[12.5px] text-ink-soft">
            <b className="block font-display text-[14px] font-semibold text-ink">
              {formatHora(ag.inicio)}
            </b>
            {formatDiaRelativo(ag.inicio)}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyBox({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center rounded-card-sm border border-line bg-surface px-6 py-8 text-center">
      <IconCalendar size={36} className="mb-2.5 text-ink-faint" />
      <h3 className="font-display text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-[260px] text-[13px] text-ink-soft">{description}</p>
    </div>
  );
}
