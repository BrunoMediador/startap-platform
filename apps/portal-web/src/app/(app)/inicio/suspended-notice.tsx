/**
 * Aviso de suspensao por inadimplencia (spec D3). Informativo, aponta o suporte,
 * SEM botao de reativar — so o Bruno reativa (regra de negocio). Sem dark pattern.
 */
import { IconAlert } from '@/components/icons';
import { SUPORTE_WHATSAPP_URL } from '@/lib/suporte';

export function SuspendedNotice() {
  return (
    <div className="mb-3.5 flex items-start gap-3 rounded-card border border-warn/30 bg-warn-soft px-4 py-4">
      <IconAlert size={22} className="mt-0.5 shrink-0 text-warn" />
      <div>
        <h2 className="font-display text-[15px] font-semibold text-ink">
          Atendimento pausado pela administração
        </h2>
        <p className="mt-1 text-[13px] leading-normal text-ink-soft">
          Para reativar o robô, regularize a mensalidade e fale com o suporte. A reativação é feita
          pela nossa equipe.
        </p>
        <a
          href={SUPORTE_WHATSAPP_URL}
          className="mt-2 inline-block font-display text-[13px] font-semibold text-brand outline-none focus-visible:underline"
        >
          Falar com o suporte
        </a>
      </div>
    </div>
  );
}
