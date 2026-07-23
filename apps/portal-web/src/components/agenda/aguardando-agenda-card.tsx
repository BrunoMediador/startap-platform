/**
 * AguardandoAgendaCard (Onda 3 do SCRUM-68 / ADR 0030 D3).
 *
 * Cliente self-service que escolheu AGENDA mas cuja agenda Google ainda não foi
 * conectada pela nossa equipe (Service Account, ADR 0024). Substitui o empty
 * genérico "agenda não conectada" nessa janela transitória, com copy orientada a
 * consequência: (1) diz o que está acontecendo, (2) dá o SLA (até 24h úteis), (3)
 * tranquiliza que a assistente JÁ atende enquanto isso (degrade elegante — o bot
 * opera como atendente até o gcal ficar pronto).
 *
 * Visual "em progresso" (âmbar, não vermelho — não é erro) com ponto pulsando; some
 * sozinho quando a agenda conecta (a tela recalcula o estado, ver lib/agenda-conexao).
 * role="status" pra leitor de tela anunciar sem interromper.
 */
import { IconCalendar } from '@/components/icons';

export function AguardandoAgendaCard() {
  return (
    <div
      role="status"
      className="relative overflow-hidden rounded-card border border-amber/30 bg-surface px-6 pb-8 pt-8 text-center shadow-card"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-4 size-[120px] -translate-x-1/2 rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(224,162,60,.16), transparent 70%)' }}
      />

      <span className="relative z-10 inline-flex size-14 items-center justify-center rounded-[16px] border border-amber/40 bg-amber-soft text-amber">
        <IconCalendar size={26} aria-hidden />
        {/* Ponto pulsando = "está rolando agora". */}
        <span
          aria-hidden
          className="login-live-dot absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-surface bg-amber"
        />
      </span>

      <h3 className="relative z-10 mt-3.5 font-display text-[17px] font-semibold text-ink">
        Estamos conectando sua agenda do Google
      </h3>
      <p className="relative z-10 mx-auto mt-1.5 max-w-[38ch] text-[14px] leading-normal text-ink-soft">
        Nossa equipe está configurando sua agenda — em até <b className="text-ink">24h úteis</b>.
        Enquanto isso, o assistente já atende no WhatsApp e coleta os pedidos dos seus clientes.
      </p>
    </div>
  );
}
