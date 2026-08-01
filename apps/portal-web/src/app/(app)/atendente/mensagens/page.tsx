'use client';

/**
 * "Meu atendente" / Mensagens (sub-aba `/atendente/mensagens`, SCRUM-157).
 * Extraído do antigo grupo "Personalidade do seu atendente" — SEM refatorar por
 * dentro: "Cartão de confirmação", byte-idêntico à seção original. Ela segue se
 * auto-gateando por 404 como hoje (o gate desta PÁGINA no menu é outro, resolvido
 * no layout via cartão disponível).
 *
 * "Perguntas frequentes" foi REMOVIDA daqui (refactor pós-plano do Bruno): o
 * conteúdo passa a viver no prompt do bot, escrito com a IA do builder — o
 * formulário próprio ficou redundante. O backend (rota/schema/gate/coluna) foi
 * eliminado em 01/08 (faxina final, 0 clones ainda usavam a coluna).
 */
import { CartaoConfigSection } from '@/components/cartao-config/cartao-config-section';

export default function AtendenteMensagensPage() {
  return (
    <div className="flex flex-col gap-8">
      <CartaoConfigSection />
    </div>
  );
}
