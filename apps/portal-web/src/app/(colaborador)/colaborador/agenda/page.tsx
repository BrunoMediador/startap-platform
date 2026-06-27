'use client';

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
import { agendaPeriodoPadrao, periodoParaPastAhead } from '@/lib/colaborador-agenda-periodo';
import { useColaboradorAgenda } from '@/lib/queries';
import { useMemo, useState } from 'react';

export default function ColaboradorAgendaPage() {
  const { slot, colaboradorId } = useColaborador();
  const [periodo, setPeriodo] = useState(() => agendaPeriodoPadrao());
  const { past, ahead } = useMemo(() => periodoParaPastAhead(periodo), [periodo]);
  const q = useColaboradorAgenda(slot, colaboradorId, past, ahead);

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
        <ColaboradorAgendaClient data={q.data} periodo={periodo} onPeriodoChange={setPeriodo} />
      )}
    </>
  );
}
