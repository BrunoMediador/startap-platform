/**
 * Aviso quando o atendimento está pausado (flow_enabled=false). A copy varia POR
 * MOTIVO (lib/suspensao) pra NUNCA pedir "regularize a mensalidade" quando foi o
 * próprio dono que pausou (owner_request) ou a conta está em dia — só a
 * inadimplência REAL fala em cobrança. Sem dark pattern; reativação por billing/
 * suporte conforme o caso (regra de negócio: só o Bruno reativa suspensão da Startap).
 */
import { IconAlert } from '@/components/icons';
import { SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
import type { MotivoPausa } from '@/lib/suspensao';
import Link from 'next/link';

const COPY: Record<MotivoPausa, { title: string; body: string }> = {
  owner: {
    title: 'Você pausou o atendimento',
    body: 'O robô não responde no WhatsApp até você retomar. Pode retomar quando quiser — o WhatsApp segue conectado.',
  },
  inadimplencia: {
    title: 'Atendimento pausado',
    body: 'Para reativar o robô, regularize a mensalidade. Assim que o pagamento for confirmado, o atendimento volta automaticamente.',
  },
  startap_outro: {
    title: 'Atendimento pausado pela administração',
    body: 'Para reativar o robô, fale com o suporte. A reativação é feita pela nossa equipe.',
  },
};

export function SuspendedNotice({ motivo }: { motivo: MotivoPausa }) {
  const copy = COPY[motivo];
  // Tom de alerta só pra inadimplência/admin; pausa do dono é informativa (sem alarme).
  const tone =
    motivo === 'owner' ? 'border-line-strong bg-surface-sunken' : 'border-warn/30 bg-warn-soft';
  const iconCls = motivo === 'owner' ? 'text-ink-soft' : 'text-warn';

  return (
    <div className={`mb-3.5 flex items-start gap-3 rounded-card border px-4 py-4 ${tone}`}>
      <IconAlert size={22} className={`mt-0.5 shrink-0 ${iconCls}`} />
      <div>
        <h2 className="font-display text-[15px] font-semibold text-ink">{copy.title}</h2>
        <p className="mt-1 text-[13px] leading-normal text-ink-soft">{copy.body}</p>
        {motivo === 'owner' ? (
          <Link
            href="/conectar"
            className="mt-2 inline-block font-display text-[13px] font-semibold text-brand outline-none focus-visible:underline"
          >
            Retomar atendimento
          </Link>
        ) : motivo === 'inadimplencia' ? (
          <Link
            href="/mensalidade"
            className="mt-2 inline-block font-display text-[13px] font-semibold text-brand outline-none focus-visible:underline"
          >
            Ver mensalidade
          </Link>
        ) : (
          <a
            href={SUPORTE_WHATSAPP_URL}
            className="mt-2 inline-block font-display text-[13px] font-semibold text-brand outline-none focus-visible:underline"
          >
            Falar com o suporte
          </a>
        )}
      </div>
    </div>
  );
}
