'use client';

/**
 * Card de billing (spec 6.6 + 3.2). Tom por regra D1 (computeBillingView):
 *   roxo (>=6d) · ambar (1..5d) · vermelho (vencido). Sem billing => roxo "em dia".
 *
 * Contraste (spec 1.A.9 + D2): no card ambar (solido), TODO o texto usa tinta
 * escura (amber-ink #1A1208) — branco sobre ambar reprova AA. Roxo/vermelho
 * solidos usam texto branco (AA). Barra de progresso com aria-label textual.
 */
import { Card } from '@/components/ui/card';
import type { StatusBilling } from '@/lib/api-types';
import { type BillingTone, computeBillingView } from '@/lib/billing';
import { cn } from '@/lib/cn';
import { formatDueDate } from '@/lib/format';

interface BillingCardProps {
  billing: StatusBilling | null;
}

// Cards de marca/billing seguem com fundo SOLIDO colorido mesmo no tema escuro
// (spec 1.A.9 / D10) — sao o ponto focal da Home sobre o fundo apagado.
const SURFACE: Record<BillingTone, string> = {
  brand: 'bg-brand-fill text-white',
  amber: 'bg-amber-fill text-amber-ink',
  danger: 'bg-danger-fill text-white',
  neutral: 'bg-brand-fill text-white',
};

/** Cor da meta (texto pequeno) — escura no ambar pra contraste (D2/1.A.9). */
const META: Record<BillingTone, string> = {
  brand: 'text-white/[0.82]',
  amber: 'text-amber-ink/85',
  danger: 'text-white/[0.85]',
  neutral: 'text-white/[0.82]',
};
const LABEL: Record<BillingTone, string> = {
  brand: 'text-white/70',
  amber: 'text-amber-ink/80',
  danger: 'text-white/75',
  neutral: 'text-white/70',
};
/** Cor do numero/titulo forte — escuro no ambar, branco no roxo/vermelho (1.A.9). */
const STRONG: Record<BillingTone, string> = {
  brand: 'text-white',
  amber: 'text-amber-ink',
  danger: 'text-white',
  neutral: 'text-white',
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
        <div
          className={cn(
            'relative z-10 mt-1.5 font-display text-[26px] font-bold tracking-[-0.02em]',
            STRONG[tone],
          )}
        >
          {titleVencido}
        </div>
      ) : (
        <div
          className={cn(
            'relative z-10 mt-1.5 font-display text-[34px] font-bold leading-none tracking-[-0.02em]',
            STRONG[tone],
          )}
        >
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
          className={cn(
            'relative z-10 mt-3.5 h-1.5 overflow-hidden rounded-pill',
            tone === 'amber' ? 'bg-amber-ink/20' : 'bg-white/[0.22]',
          )}
          role="img"
          aria-label={`${dias} de 30 dias restantes`}
        >
          <span
            className={cn(
              'block h-full rounded-pill',
              tone === 'amber' ? 'bg-amber-ink' : 'bg-white',
            )}
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
