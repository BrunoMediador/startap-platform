'use client';

/**
 * "Meu atendente" / Mensagens (sub-aba `/atendente/mensagens`, SCRUM-157).
 * Extraído do antigo grupo "Personalidade do seu atendente" — SEM refatorar por
 * dentro: "Cartão de confirmação" + "Perguntas frequentes", byte-idêntico às
 * seções originais. Cada uma segue se auto-gateando por 404 como hoje (o gate
 * desta PÁGINA no menu é outro, resolvido no layout via features.faq_personalizado
 * || cartão disponível).
 */
import { CartaoConfigSection } from '@/components/cartao-config/cartao-config-section';
import { FaqSection } from '@/components/faq/faq-section';

export default function AtendenteMensagensPage() {
  return (
    <div className="flex flex-col gap-8">
      <CartaoConfigSection />
      <FaqSection />
    </div>
  );
}
