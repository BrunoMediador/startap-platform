'use client';

/**
 * "Meu atendente" / Testar (sub-aba `/atendente/testar`, SCRUM-157). Extraído do
 * antigo grupo "Personalidade do seu atendente" — SEM refatorar por dentro: mesma
 * `TestarConversaSection` (SCRUM-101), só na tela própria (o gate desta PÁGINA no
 * menu é `features.sandbox`, resolvido no layout).
 */
import { TestarConversaSection } from '@/components/sandbox/testar-conversa-section';

export default function AtendenteTestarPage() {
  return <TestarConversaSection />;
}
