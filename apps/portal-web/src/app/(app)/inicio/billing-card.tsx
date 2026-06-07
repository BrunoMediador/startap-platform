'use client';

/**
 * Card de billing (spec 6.6 + 3.2). Tom por regra D1 (computeBillingView):
 *   roxo (>=6d) · ambar (1..5d) · vermelho (vencido). Sem billing => roxo "em dia".
 *
 * Contraste (spec 8 + D2): no card ambar, texto pequeno (meta) usa tinta escura
 * (#3A2602) — branco pequeno sobre ambar nao passa AA. Numero grande e label
 * passam por tamanho. Barra de progresso com aria-label textual.
 */
import { Card } from '@/components/ui/card';
import type { StatusBilling } from '@/lib/api-types';
import { type BillingTone, computeBillingView } from '@/lib/billing';
import { cn } from '@/lib/cn';
import { formatDueDate } from '@/lib/format';

interface BillingCardProps {
  billing: StatusBilling | null;
}

const SURFACE: Record<BillingTone, string> = {
  brand: 'bg-brand text-white',
  amber: 'bg-amber text-white',
  danger: 'bg-danger text-white',
  neutral: 'bg-brand text-white',
};

/** Cor da meta (texto pequeno) — escura no ambar pra contraste (D2). */
const META: Record<BillingTone, string> = {
  brand: 'text-white/[0.82]',
  amber: 'text-[#3A2602]',
  danger: 'text-white/[0.85]',
  neutral: 'text-white/[0.82]',
};
const LABEL: Record<BillingTone, string> = {
  brand: 'text-white/70',
  amber: 'text-[#3A2602]',
  danger: 'text-white/75',
  neutral: 'text-white/70',
};

export function BillingCard({ billing }: BillingCardProps) {
  const view = computeBillingView(billing);
  const tone = view.tone;
  const due = formatDueDate(billing?.next_due_date ?? null);

  // Sem dados de billing — informativo, sem alarme (spec 3.2).
  if (!view.hasDueDate) {
    return (
      <Card padded={false} className={cn('relative mb-3.5 overflow-hidden p-5', SURFACE.brand)}>
        <Decor />
        <div
          className={cn(
            'relative z-10 text-[11px] font-semibold uppercase tracking-[0.08em]',
            LABEL.brand,
          )}
        >
          Sua mensalidade
        </div>
        <div className="relative z-10 mt-1.5 font-display text-[20px] font-bold text-white">
          Mensalidade em dia
        </div>
        <p className={cn('relative z-10 mt-1 text-[13px]', META.brand)}>
          Pagamento controlado pelo suporte
        </p>
      </Card>
    );
  }

  const dias = view.diasRestantes ?? 0;

  // Texto do numero/estado.
  const big = view.vencido ? null : dias;
  const titleVencido = 'Mensalidade vencida';

  return (
    <Card padded={false} className={cn('relative mb-3.5 overflow-hidden p-5', SURFACE[tone])}>
      <Decor />
      <div
        className={cn(
          'relative z-10 text-[11px] font-semibold uppercase tracking-[0.08em]',
          LABEL[tone],
        )}
      >
        Sua mensalidade
      </div>

      {view.vencido ? (
        <div className="relative z-10 mt-1.5 font-display text-[26px] font-bold tracking-[-0.02em] text-white">
          {titleVencido}
        </div>
      ) : (
        <div className="relative z-10 mt-1.5 font-display text-[34px] font-bold leading-none tracking-[-0.02em] text-white">
          {big}{' '}
          <span className="text-[15px] font-medium opacity-90">
            {dias === 1 ? 'dia restante' : 'dias restantes'}
          </span>
        </div>
      )}

      <p className={cn('relative z-10 mt-2 text-[13px]', META[tone])}>
        {view.vencido ? <>Vencia em {due}</> : <>Vence em {due}</>}
      </p>

      {view.proximo && (
        <p className={cn('relative z-10 mt-1 text-[13px] font-semibold', META.amber)}>
          Não deixe seu atendimento parar
        </p>
      )}
      {view.vencido && (
        <p className={cn('relative z-10 mt-1 text-[13px] font-semibold', META.danger)}>
          Fale com o suporte
        </p>
      )}

      {/* Barra de progresso do ciclo (decorativa-informativa, aria textual). */}
      {!view.vencido && (
        <div
          className="relative z-10 mt-3.5 h-1.5 overflow-hidden rounded-pill bg-white/[0.22]"
          role="img"
          aria-label={`${dias} de 30 dias restantes`}
        >
          <span
            className="block h-full rounded-pill bg-white"
            style={{ width: `${Math.max(0, Math.min(100, (dias / 30) * 100))}%` }}
          />
        </div>
      )}
    </Card>
  );
}

/** Circulo decorativo (rgba branco .07) — unico "brilho" permitido (spec 1.1). */
function Decor() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -bottom-[70px] -right-[60px] size-[170px] rounded-full bg-white/[0.07]"
    />
  );
}
