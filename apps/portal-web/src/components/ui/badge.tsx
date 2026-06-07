/**
 * Badge de status / chip (spec 6.5). Texto SEMPRE presente (nunca so cor —
 * acessibilidade). Variantes mapeiam estados de status do bot e vencimento.
 */
import { cn } from '@/lib/cn';

type BadgeTone = 'ok' | 'danger' | 'warn' | 'amber' | 'info';

const TONES: Record<BadgeTone, string> = {
  ok: 'bg-ok-bg text-ok',
  danger: 'bg-danger-bg text-danger',
  warn: 'bg-warn-bg text-warn',
  amber: 'bg-amber-bg text-amber',
  info: 'bg-brand-50 text-brand',
};

export function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1.5 font-display text-[12px] font-semibold',
        TONES[tone],
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
