'use client';

import { AgendaClient } from '@/components/agenda/agenda-client';
import { AgendaEstabelecimentoClient } from '@/components/agenda/agenda-estabelecimento-client';
/**
 * Agenda completa (Bloco A — rota dedicada). Reusa a query da Início
 * (useAgendamentos: cache quente). Full-width, PAGE_SIZE maior, seletor de visão
 * Lista/Semana + expandir, e o sheet de detalhe pra remarcar/trocar/cancelar.
 *
 * Estados de dados remotos (todos com skeleton, não spinner mudo):
 *   - pending            -> skeleton de lista + sr-only.
 *   - erro               -> ErrorState com retry.
 *   - gcal_configured:false (pré-setup) -> empty "agenda não conectada".
 *   - sem eventos na janela -> empty "nenhum agendamento" + CTA Novo.
 *   - com eventos        -> AgendaClient (Lista/Semana).
 */
import { AguardandoAgendaCard } from '@/components/agenda/aguardando-agenda-card';
import { IconCalendar } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { agendaConexaoEstado } from '@/lib/agenda-conexao';
import { useAgendamentos } from '@/lib/queries';
import { useRouter } from 'next/navigation';

export default function AgendaPage() {
  const { slot, productType } = useTenant();
  const router = useRouter();
  const q = useAgendamentos(slot);
  // Estabelecimento (multi-profissional): variante com cor/coluna por profissional.
  // Individual (Cirilo/Samuel): segue idêntico a hoje (AgendaClient).
  const isEstabelecimento = productType === 'estabelecimento';

  return (
    <>
      <PageHead
        title="Agenda"
        subtitle={
          isEstabelecimento
            ? 'Os horários de todos os profissionais, cada um com sua cor. Toque num pra remarcar, trocar o serviço ou cancelar.'
            : 'Todos os horários da sua agenda. Toque num pra remarcar, trocar o serviço ou cancelar.'
        }
      />

      {q.isPending ? (
        <>
          <span className="sr-only">Carregando sua agenda…</span>
          <SkeletonList rows={6} />
        </>
      ) : q.isError || !q.data ? (
        <ErrorState title="Não foi possível carregar a agenda" onRetry={() => q.refetch()} />
      ) : agendaConexaoEstado(q.data) === 'aguardando' ? (
        <AguardandoAgendaCard />
      ) : !q.data.gcal_configured ? (
        <EmptyState
          icon={<IconCalendar size={26} />}
          title="Agenda ainda não conectada"
          description="Quando sua agenda do Google estiver ligada, os horários aparecem aqui pra você acompanhar e editar."
        />
      ) : q.data.agendamentos.length === 0 ? (
        <EmptyState
          icon={<IconCalendar size={26} />}
          title="Nenhum agendamento ainda"
          description="Assim que o assistente marcar um atendimento no WhatsApp, ele aparece aqui. Você também pode marcar um na mão."
          action={{ label: 'Marcar um horário', onClick: () => router.push('/agendamentos/novo') }}
        />
      ) : isEstabelecimento ? (
        <AgendaEstabelecimentoClient slot={slot} data={q.data} />
      ) : (
        <AgendaClient data={q.data} />
      )}
    </>
  );
}
