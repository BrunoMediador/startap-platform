'use client';

/**
 * Seletor de DIA + HORÁRIO LIVRE reutilizável (Bloco C — remarcar/trocar).
 * Reusa ~90% do fluxo de /novo: DayStrip de 14 dias (buildDayStrip) + grade SÓ de
 * horários livres (useAgendaSlots), agrupada manhã/tarde/noite. Mostrar só livres
 * previne 409 de conflito; se o backend devolver 409 mesmo assim, o pai recarrega
 * a grade (refetch exposto via `slotsQuery`).
 *
 * Estados: skeleton (procurando livres), erro+retry, dia fechado, dia lotado,
 * agenda Google não conectada (422/gcal off — o pai trata e nem monta isto).
 */
import { Skeleton, skeletonKeys } from '@/components/ui/skeleton';
import type { SlotsGrupos } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { buildDayStrip, formatDiaExtenso } from '@/lib/novo-agendamento';
import { useAgendaSlots, useHorarios } from '@/lib/queries';
import { useMemo } from 'react';

export function SlotPicker({
  slot,
  servico,
  dataSel,
  horaSel,
  onPickDia,
  onPickHora,
  aviso,
  colaboradorId = null,
}: {
  slot: string;
  /** Nome do serviço (define a duração — necessário pra grade). */
  servico: string | null;
  dataSel: string | null;
  horaSel: string | null;
  onPickDia: (dateKey: string) => void;
  onPickHora: (hora: string) => void;
  /** Aviso amber inline (ex.: 409 recarregou a grade). */
  aviso?: string | null;
  /**
   * ESTABELECIMENTO: colaborador dono do evento sendo remarcado — a grade tem que
   * olhar a agenda DELE. null no individual (single-agenda). Remarcar v1 não move o
   * evento entre profissionais, então é sempre o colaborador atual do agendamento.
   */
  colaboradorId?: number | null;
}) {
  const horariosQ = useHorarios(slot);
  const slotsQ = useAgendaSlots(slot, dataSel, servico, colaboradorId);
  const strip = useMemo(() => buildDayStrip(horariosQ.data), [horariosQ.data]);

  return (
    <div className="space-y-4">
      {/* Dia */}
      <div>
        <h3 className="mb-2 font-display text-[13.5px] font-semibold text-ink">Novo dia</h3>
        <div
          role="radiogroup"
          aria-label="Escolha o dia"
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {strip.map((d) => {
            const ativo = d.dateKey === dataSel;
            return (
              <button
                key={d.dateKey}
                type="button"
                role="radio"
                aria-checked={ativo}
                disabled={d.fechado}
                aria-label={`${d.longo}${d.fechado ? ' — fechado' : ''}`}
                onClick={() => onPickDia(d.dateKey)}
                className={cn(
                  'flex min-w-[58px] shrink-0 flex-col items-center gap-0.5 rounded-card-sm border px-2 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-elev',
                  ativo
                    ? 'border-brand bg-brand-soft'
                    : 'border-line bg-surface hover:bg-surface-hover',
                  d.fechado && 'cursor-not-allowed opacity-45 hover:bg-surface',
                )}
              >
                <span
                  className={cn(
                    'text-[11.5px] font-semibold',
                    ativo ? 'text-brand' : 'text-ink-soft',
                  )}
                >
                  {d.label}
                </span>
                <span
                  className={cn(
                    'font-display text-[16px] font-bold tabular-nums',
                    ativo ? 'text-brand' : 'text-ink',
                  )}
                >
                  {d.diaNum}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Horário livre — só com dia escolhido. */}
      {servico && dataSel ? (
        <div aria-live="polite">
          <h3 className="mb-2 font-display text-[13.5px] font-semibold text-ink">
            Horários livres · {formatDiaExtenso(dataSel)}
          </h3>

          {aviso && (
            <p
              role="status"
              className="mb-2.5 rounded-card-sm border border-amber/40 bg-amber-soft px-3.5 py-2.5 text-[13px] font-medium text-amber"
            >
              {aviso}
            </p>
          )}

          {slotsQ.isPending ? (
            <>
              <span className="sr-only">Procurando horários livres…</span>
              <div aria-hidden className="grid grid-cols-4 gap-2">
                {skeletonKeys(8).map((k) => (
                  <Skeleton key={k} className="h-10 rounded-pill" />
                ))}
              </div>
            </>
          ) : slotsQ.isError ? (
            <Nota texto="Não conseguimos ver a agenda agora.">
              <button
                type="button"
                onClick={() => slotsQ.refetch()}
                className="font-display text-[13px] font-semibold text-brand underline-offset-2 hover:underline"
              >
                Tentar de novo
              </button>
            </Nota>
          ) : !slotsQ.data.aberto ? (
            <Nota texto="Fechado nesse dia. Escolha outro acima." />
          ) : slotsQ.data.count === 0 ? (
            <Nota texto="Esse dia já tá cheio. Tente outro dia." />
          ) : (
            <Grade grupos={slotsQ.data.grupos} horaSel={horaSel} onPick={onPickHora} />
          )}
        </div>
      ) : (
        <p className="text-[13px] text-ink-soft">Escolha o dia pra ver os horários livres.</p>
      )}
    </div>
  );
}

function Grade({
  grupos,
  horaSel,
  onPick,
}: {
  grupos: SlotsGrupos;
  horaSel: string | null;
  onPick: (hora: string) => void;
}) {
  const ordem: { key: keyof SlotsGrupos; label: string }[] = [
    { key: 'manha', label: 'Manhã' },
    { key: 'tarde', label: 'Tarde' },
    { key: 'noite', label: 'Noite' },
  ];
  return (
    <div role="radiogroup" aria-label="Escolha o horário" className="space-y-3">
      {ordem.map(({ key, label }) =>
        grupos[key].length === 0 ? null : (
          <div key={key}>
            <h4 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-ink-faint">
              {label}
            </h4>
            <div className="grid grid-cols-4 gap-2">
              {grupos[key].map((h) => {
                const ativo = h === horaSel;
                return (
                  <button
                    key={h}
                    type="button"
                    role="radio"
                    aria-checked={ativo}
                    onClick={() => onPick(h)}
                    className={cn(
                      'h-10 rounded-pill border font-display text-[13px] font-semibold tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-elev',
                      ativo
                        ? 'border-brand bg-brand text-bg'
                        : 'border-line bg-surface text-ink hover:bg-surface-hover',
                    )}
                  >
                    {h}
                  </button>
                );
              })}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function Nota({ texto, children }: { texto: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-card-sm border border-line bg-surface px-5 py-5 text-center">
      <p className="text-[13.5px] text-ink-soft">{texto}</p>
      {children}
    </div>
  );
}
