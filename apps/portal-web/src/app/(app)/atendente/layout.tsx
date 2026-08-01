'use client';

import { useTenant } from '@/components/shell/session-context';
/**
 * Shell de "Meu atendente" (SCRUM-157): título fixo + sub-abas reais
 * (Personalidade/Mensagens/Testar). Cada sub-página some o próprio
 * `<PageHead>` — o título agora é deste layout, a aba ativa já diz onde o
 * dono está. Mesmo padrão de `negocio/layout.tsx` (gates compostos aqui,
 * anti-flash enquanto qualquer sinal remoto ainda carrega).
 *
 * Gates (ATENDENTE_ABAS em @/lib/abas, ORs já resolvidos aqui — `filterByGates`
 * só sabe fazer AND):
 *   - atendentePersonalidade = features.prompt_builder || tom disponível
 *     (useAtendenteFeatures = GET /portal/perfil; tom disponível = GET
 *     /portal/tom-assistente 200, não 404).
 *   - atendenteMensagens = cartão disponível (GET /portal/cartao-config com
 *     status !== 'hidden'). Antes era `|| features.faq_personalizado`, mas a
 *     UI de "Perguntas frequentes" foi removida (conteúdo passa a viver no
 *     prompt via IA) — MEDIDO EM PROD 31/07: ninguém perde a aba, pois
 *     `CARTAO_RUNTIME_ENABLED=true` e os 3 clones em `cartao_mode=baked`
 *     recebem 200 read-only/locked, então `cartaoDisponivel` é true pros 6.
 *   - sandbox = features.sandbox (useAtendenteFeatures).
 *
 * ANTI-FLASH: enquanto QUALQUER uma das 3 queries remotas (atendenteFeatures/
 * tomAssistente/cartaoConfig) está `isPending`, a aba correspondente fica de
 * fora do filtro — mesmo critério de `negocio/layout.tsx` (nunca aparecer e
 * sumir é melhor que piscar).
 */
import { PageHead } from '@/components/ui/page-head';
import { SubTabs } from '@/components/ui/sub-tabs';
import { filterAtendenteAbas } from '@/lib/abas';
import { useAtendenteFeatures, useCartaoConfig, useTomAssistente } from '@/lib/queries';

export default function AtendenteLayout({ children }: { children: React.ReactNode }) {
  const gates = useAtendenteGateSignals();
  // filterAtendenteAbas só lê os 3 campos de "Meu atendente" do NavGateContext — os
  // demais (conexao/estabelecimento/atendimentos) não têm gate aqui, mesmo padrão de
  // negocio/layout.tsx (fixados false, nunca lidos por ATENDENTE_ABAS).
  const abas = filterAtendenteAbas({
    conexaoEnabled: false,
    isEstabelecimento: false,
    atendimentosEnabled: false,
    ...gates,
  });

  return (
    <div data-atendente-layout>
      <PageHead
        title="Meu atendente"
        subtitle="A personalidade, as mensagens e o teste do seu assistente."
      />
      <SubTabs items={abas} />
      {children}
    </div>
  );
}

/** Composição fail-closed dos 3 gates de "Meu atendente" (ver comentário do topo). */
function useAtendenteGateSignals(): {
  atendentePersonalidade: boolean;
  atendenteMensagens: boolean;
  sandbox: boolean;
} {
  const { slot } = useTenant();
  const featuresQ = useAtendenteFeatures(slot);
  const tomQ = useTomAssistente(slot);
  const cartaoQ = useCartaoConfig(slot);

  const pending = featuresQ.isPending || tomQ.isPending || cartaoQ.isPending;
  const tomDisponivel = tomQ.data?.status === 'ok';
  const cartaoDisponivel = cartaoQ.data != null && cartaoQ.data.status !== 'hidden';

  return {
    // Fail-closed enquanto qualquer sinal remoto ainda carrega (anti-flash).
    atendentePersonalidade: pending
      ? false
      : featuresQ.data?.prompt_builder === true || tomDisponivel,
    atendenteMensagens: pending ? false : cartaoDisponivel,
    sandbox: pending ? false : featuresQ.data?.sandbox === true,
  };
}
