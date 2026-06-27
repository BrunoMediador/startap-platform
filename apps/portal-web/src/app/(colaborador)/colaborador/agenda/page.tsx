'use client';

/**
 * Agenda do colaborador (read-only — SCRUM-32). Estados remotos completos:
 *   - pending              -> skeleton.
 *   - erro                 -> ErrorState com retry.
 *   - gcal_configured:false -> empty "agenda não conectada" (pré-setup, não erro).
 *   - sem eventos          -> empty "nenhum horário".
 *   - com eventos          -> ColaboradorAgendaClient (lista só-leitura).
 */
import { ColaboradorAgendaClient } from '@/components/colaborador/colaborador-agenda-client';
import { useColaborador } from '@/components/colaborador/colaborador-session-context';
import { IconCalendar } from '@/components/icons';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useColaboradorAgenda } from '@/lib/queries';

export default function ColaboradorAgendaPage() {
  const { slot, colaboradorId } = useColaborador();
  const q = useColaboradorAgenda(slot, colaboradorId);

  return (
    <>
      <PageHead title="Minha agenda" subtitle="Os horários marcados pra você. Só pra acompanhar." />

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
      ) : q.data.agendamentos.length === 0 ? (
        <EmptyState
          icon={<IconCalendar size={26} />}
          title="Nenhum horário ainda"
          description="Assim que o robô marcar um atendimento pra você no WhatsApp, ele aparece aqui."
        />
      ) : (
        <ColaboradorAgendaClient data={q.data} />
      )}
    </>
  );
}
