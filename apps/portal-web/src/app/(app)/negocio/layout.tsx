'use client';

/**
 * Shell de "Meu negócio" (SCRUM-157): título fixo + sub-abas reais
 * (Dados/Serviços/Horários/Equipe/Agenda). Cada sub-página some o próprio
 * `<PageHead>` — o título agora é deste layout, a aba ativa já diz onde o
 * dono está.
 *
 * Gate da aba "Agenda" (negocioAgenda = modo_atendente || atendFromAgenda ||
 * temCredencialGoogle): reaproveita 3 sinais que já existem hoje, sem bater
 * em endpoint novo —
 *   - modo_atendente: useAgendaConfig (mesmo GET /portal/perfil da seção
 *     Agendamento, numa query própria pra não tocar no cache otimista do
 *     formulário principal).
 *   - atendFromAgenda: já vem pronto na sessão (useTenant, ADR 0027 Fase C).
 *   - temCredencialGoogle: useGoogleConta — GoogleContaResponse com
 *     google_account_email preenchido (feature ON + credencial cadastrada).
 *
 * ANTI-FLASH: enquanto QUALQUER uma das duas queries (agendaConfig/googleConta)
 * está `isPending`, a aba "Agenda" fica de fora do filtro — mesmo critério de
 * `tom-assistente-section.tsx:49` (nunca aparecer e sumir é melhor que piscar).
 * atendFromAgenda vem da sessão (sem loading próprio), então só as 2 queries
 * remotas entram nessa conta.
 */
import { useTenant } from '@/components/shell/session-context';
import { PageHead } from '@/components/ui/page-head';
import { SubTabs } from '@/components/ui/sub-tabs';
import { filterNegocioAbas } from '@/lib/abas';
import { useAgendaConfig, useGoogleConta } from '@/lib/queries';

export default function NegocioLayout({ children }: { children: React.ReactNode }) {
  const { isEstabelecimento, negocioAgenda } = useNegocioGateSignals();
  const abas = filterNegocioAbas({
    conexaoEnabled: false,
    isEstabelecimento,
    atendimentosEnabled: false,
    crmClientesEnabled: false,
    negocioAgenda,
  });

  return (
    <div data-negocio-layout>
      <PageHead
        title="Meu negócio"
        subtitle="Os dados, serviços, horários e equipe do seu negócio."
      />
      <SubTabs items={abas} />
      {children}
    </div>
  );
}

/** Composição fail-closed do gate `negocioAgenda` (ver comentário do topo). */
function useNegocioGateSignals(): { isEstabelecimento: boolean; negocioAgenda: boolean } {
  const { slot, productType, atendFromAgenda } = useTenant();
  const agendaConfigQ = useAgendaConfig(slot);
  const googleContaQ = useGoogleConta(slot);

  const pending = agendaConfigQ.isPending || googleContaQ.isPending;
  const modoAtendente = agendaConfigQ.data?.modo_atendente === true;
  const temCredencialGoogle = googleContaQ.data?.google_account_email != null;

  return {
    isEstabelecimento: productType === 'estabelecimento',
    // Fail-closed enquanto qualquer sinal remoto ainda carrega (anti-flash).
    negocioAgenda: pending ? false : modoAtendente || atendFromAgenda || temCredencialGoogle,
  };
}
