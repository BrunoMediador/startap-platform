'use client';

/**
 * "Meu atendente" / Personalidade (sub-aba `/atendente/personalidade`, SCRUM-157).
 * Extraído do antigo grupo "Personalidade do seu atendente" (mega-página `/perfil`,
 * depois `/negocio/dados`) — SEM refatorar por dentro: "Monte seu atendente" (builder
 * conversacional) + "Tom da conversa" (slider), byte-idêntico às seções originais.
 * Cada uma segue se auto-gateando por 404 como hoje (o gate desta PÁGINA no menu é
 * outro, resolvido no layout via features.prompt_builder || tom disponível).
 */
import { MonteAssistenteSection } from '@/components/prompt-builder/monte-assistente-section';
import { TomAssistenteSection } from '@/components/tom-assistente/tom-assistente-section';

export default function AtendentePersonalidadePage() {
  return (
    <div className="flex flex-col gap-8">
      <MonteAssistenteSection />
      <TomAssistenteSection />
    </div>
  );
}
