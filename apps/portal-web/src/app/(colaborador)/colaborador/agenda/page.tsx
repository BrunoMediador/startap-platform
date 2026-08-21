'use client';

import { AgendaBloqueiosSection } from '@/components/agenda/agenda-bloqueios-section';
/**
 * Agenda do colaborador (read-only — SCRUM-32). Estados remotos completos:
 *   - pending              -> skeleton.
 *   - erro                 -> ErrorState com retry.
 *   - gcal_configured:false -> empty "agenda não conectada" (pré-setup, não erro).
 *   - conectada            -> ColaboradorAgendaClient (filtro de data + lista). O
 *                             vazio "nada nesse período" mora no client pra o filtro
 *                             seguir visível quando a janela vier vazia.
 *
 * O FILTRO DE DATA mora aqui (page) porque controla a JANELA do fetch: a janela
 * [de, ate] vira past/ahead (lib/colaborador-agenda-periodo) e entra na query —
 * mesmo padrão visual de período do dono (PeriodSelector / lib/billing-periodo).
 */
import { ColaboradorAgendaClient } from '@/components/colaborador/colaborador-agenda-client';
import { useColaborador } from '@/components/colaborador/colaborador-session-context';
import { IconCalendar } from '@/components/icons';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { separarAgendamentosDeBloqueios } from '@/lib/agenda-bloqueios';
import { agendaPeriodoPadrao, periodoParaPastAhead } from '@/lib/colaborador-agenda-periodo';
import { useColaboradorAgenda } from '@/lib/queries';
import { useMemo, useState } from 'react';

export default function ColaboradorAgendaPage() {
  const { slot, colaboradorId, timezone } = useColaborador();
  const [periodo, setPeriodo] = useState(() => agendaPeriodoPadrao());
  const { past, ahead } = useMemo(() => periodoParaPastAhead(periodo), [periodo]);
  const q = useColaboradorAgenda(slot, colaboradorId, past, ahead);
  const agendaSemBloqueios = q.data
    ? {
        ...q.data,
        agendamentos: separarAgendamentosDeBloqueios(q.data.agendamentos).agendamentos,
      }
    : null;

  return (
    <>
      <PageHead title="Minha agenda" subtitle="Os horários marcados pra você." />

      {q.isPending ? (
        <>
          <span className="sr-only">Carregando sua agenda…</span>
          <SkeletonList rows={6} />
        </>
      ) : q.isError || !q.data ? (
        <ErrorState title="Não foi possível carregar a agenda" onRetry={() => q.refetch()} />
      ) : !q.data.gcal_configured ? (
        <EmptyState
          icon={<IconCalendar size={26} />}
          title="Agenda ainda não conectada"
          description="Quando sua agenda do Google estiver ligada, os horários aparecem aqui pra você acompanhar."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <AgendaBloqueiosSection
            mode="colaborador"
            slot={slot}
            colaboradorId={colaboradorId}
            timeZone={timezone ?? 'America/Sao_Paulo'}
          />
          {agendaSemBloqueios ? (
            <ColaboradorAgendaClient
              data={agendaSemBloqueios}
              periodo={periodo}
              onPeriodoChange={setPeriodo}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
