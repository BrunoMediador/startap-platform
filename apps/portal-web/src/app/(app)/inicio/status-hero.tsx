'use client';

import { useTenant } from '@/components/shell/session-context';
import { Badge } from '@/components/ui/badge';
import type { StatusResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { useConexao } from '@/lib/queries';
import {
  type StatusHeroTone,
  type StatusHeroView,
  resolveStatusHeroView,
} from '@/lib/status-operacional';
import Link from 'next/link';

const PULSE_TONE: Record<StatusHeroTone, { bg: string; core: string }> = {
  ok: { bg: 'bg-ok-soft', core: 'bg-ok' },
  danger: { bg: 'bg-danger-soft', core: 'bg-danger' },
  warn: { bg: 'bg-warn-soft', core: 'bg-warn' },
  amber: { bg: 'bg-amber-soft', core: 'bg-amber' },
  info: { bg: 'bg-brand-soft', core: 'bg-brand' },
};

function Pulse({ view }: { view: StatusHeroView }) {
  const tone = PULSE_TONE[view.tone];
  return (
    <span
      aria-hidden
      className={cn(
        'relative flex size-[46px] shrink-0 items-center justify-center rounded-full',
        tone.bg,
        view.trulyActive && 'animate-ring',
      )}
    >
      <span
        className={cn('size-[13px] rounded-full', tone.core, view.trulyActive && 'pulse-glow')}
      />
    </span>
  );
}

function withAvailableAction(
  view: StatusHeroView,
  conexao: { enabled?: boolean; bot_paused?: boolean } | undefined,
): StatusHeroView {
  if (view.href !== '/conectar') return view;

  const ownerAction = view.kind === 'owner_pause';
  const available =
    conexao?.enabled === true && (!ownerAction || typeof conexao.bot_paused === 'boolean');
  if (available) return view;

  return {
    ...view,
    href: null,
    ariaLabel: null,
    description: ownerAction
      ? 'A pausa continua ativa. Fale com o suporte se precisar retomar agora.'
      : 'Fale com o suporte para restabelecer a conexão.',
  };
}

export function StatusHero({ status }: { status: StatusResponse }) {
  const { slot } = useTenant();
  const conexao = useConexao(slot);
  const view = withAvailableAction(resolveStatusHeroView(status), conexao.data);

  const inner = (
    <div>
      <div className="flex min-w-0 items-start gap-3.5">
        <Pulse view={view} />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[17px] font-semibold leading-snug text-ink">
            {view.title}
          </h2>
          <p className="mt-0.5 text-[13px] leading-normal text-ink-soft">{view.description}</p>
          <div className="mt-2">
            <Badge tone={view.tone}>{view.badge}</Badge>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[11.5px] font-medium text-ink-soft">
        <span className="rounded-pill border border-line bg-surface-sunken px-2.5 py-1.5">
          {view.wahaLabel}
        </span>
        <span className="rounded-pill border border-line bg-surface-sunken px-2.5 py-1.5">
          {view.atendimentoLabel}
        </span>
        {view.ownerPauseAlsoActive && view.kind === 'billing_block' && (
          <span className="rounded-pill border border-amber/35 bg-amber-soft px-2.5 py-1.5 text-amber">
            Sua pausa está preservada
          </span>
        )}
      </div>
    </div>
  );

  const cardClass =
    'hero-e1 relative block min-h-[148px] h-full overflow-hidden rounded-card border border-line-strong bg-surface p-[18px]';

  if (view.href && view.ariaLabel) {
    return (
      <Link
        href={view.href}
        aria-label={view.ariaLabel}
        className={cn(
          cardClass,
          'transition-colors hover:bg-surface-hover active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        )}
      >
        {inner}
      </Link>
    );
  }

  return <div className={cardClass}>{inner}</div>;
}
