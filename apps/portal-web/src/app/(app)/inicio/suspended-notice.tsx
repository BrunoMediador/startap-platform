import { IconAlert } from '@/components/icons';
import { SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
import type { AvisoSuspensao } from '@/lib/suspensao';
import Link from 'next/link';

/** Aviso persistente dos eixos que impedem resposta/processamento. */
export function SuspendedNotice({ aviso }: { aviso: AvisoSuspensao }) {
  const owner = aviso.motivo === 'owner';
  const billing = aviso.motivo === 'inadimplencia';
  const tone = owner
    ? 'border-line-strong bg-surface-sunken'
    : billing
      ? 'border-danger/35 bg-danger-soft'
      : 'border-warn/35 bg-warn-soft';
  const iconCls = owner ? 'text-ink-soft' : billing ? 'text-danger' : 'text-warn';
  const actionClass =
    'mt-2 inline-flex min-h-11 items-center rounded-btn px-1 font-display text-[13px] font-semibold text-brand outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg';

  return (
    <section
      className={`mb-3.5 flex items-start gap-3 rounded-card border px-4 py-4 ${tone}`}
      role={owner ? 'status' : 'alert'}
      aria-labelledby="suspensao-titulo"
    >
      <IconAlert size={22} className={`mt-0.5 shrink-0 ${iconCls}`} />
      <div className="min-w-0">
        <h2 id="suspensao-titulo" className="font-display text-[15px] font-semibold text-ink">
          {aviso.title}
        </h2>
        <p className="mt-1 text-[13px] leading-normal text-ink-soft">{aviso.body}</p>
        {aviso.action === 'resume' ? (
          <Link href="/conectar" className={actionClass}>
            {aviso.actionLabel}
          </Link>
        ) : aviso.action === 'billing' ? (
          <Link href="/mensalidade" className={actionClass}>
            {aviso.actionLabel}
          </Link>
        ) : (
          <a href={SUPORTE_WHATSAPP_URL} className={actionClass}>
            {aviso.actionLabel}
          </a>
        )}
      </div>
    </section>
  );
}
