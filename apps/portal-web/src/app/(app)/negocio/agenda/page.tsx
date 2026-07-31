'use client';

/**
 * "Meu negócio" / Agenda (sub-aba `/negocio/agenda`, SCRUM-157). Extraído do
 * antigo `(app)/perfil/page.tsx` — GRUPO 3 ("Agenda e lembretes"): Agendamento
 * + Lembretes + Conta Google, byte-idêntico ao bloco original (nenhuma seção
 * foi alterada por dentro — cada `*-section.tsx` segue se auto-gateando
 * exatamente como antes).
 *
 * Os wrappers `data-grupo-collapsavel` seguem em uso: trazem o divisor E somem
 * junto quando a seção interna renderiza null (sem divisor órfão) — a regra
 * CSS `[data-grupo-collapsavel]:not(:has(*))` continua válida (globals.css).
 */
import { AgendamentoSection } from '@/components/agendamento/agendamento-section';
import { GoogleAgendaSection } from '@/components/google-agenda/google-agenda-section';
import { LembretesSection } from '@/components/lembretes/lembretes-section';
import { useTenant } from '@/components/shell/session-context';

export default function NegocioAgendaPage() {
  const { atendFromAgenda } = useTenant();

  return (
    <>
      {/* Agendamento (modo atendente, SCRUM-59): toggle "agenda automática (Google)" +
          link externo. A seção SE AUTO-GATEIA por features.modo_atendente (por-clone,
          MODO_ATENDENTE_SLOTS) e traz o próprio divisor — some INTEIRA (sem divisor
          órfão) pros clientes atuais (byte-idêntico). */}
      <AgendamentoSection />

      {/* Lembretes: seção da própria "Meu negócio" (config self-service do lembrete
          automático). Só aparece pra quem tem agenda ativa (atend_from_agenda) —
          sem agenda não há agendamento pra lembrar. O componente cuida do próprio
          loading/erro/gating. O wrapper `data-grupo-collapsavel` traz o divisor E
          some junto quando a seção interna renderiza null (sem divisor órfão). */}
      {atendFromAgenda && (
        <div data-grupo-collapsavel className="mt-8 border-t border-line pt-6">
          <LembretesSection />
        </div>
      )}

      {/* Google Agenda: credencial da conta Google + guia pra instalar o app e ser
          notificado no celular/computador. Bloco gateado por
          GOOGLE_ACCOUNT_PORTAL_ENABLED (404 -> some) e por credencial cadastrada — o
          componente cuida do próprio loading/erro/gating e some quando não há o que
          mostrar. O wrapper `data-grupo-collapsavel` traz o divisor E some junto
          (elimina o divisor órfão que sobrava aqui antes). */}
      <div data-grupo-collapsavel className="mt-8 border-t border-line pt-6">
        <GoogleAgendaSection />
      </div>
    </>
  );
}
