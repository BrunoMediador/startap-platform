'use client';

/**
 * Status-hero da Home (spec 6.4 + 3.1). Mapeia o estado do bot a partir do
 * /portal/status:
 *   - flow_enabled=false                  -> "Atendimento pausado" (inadimplencia,
 *                                            warn). SEM botao de reativar (D3).
 *   - waha.status WORKING                 -> "Bot ativo" (ok, pulse animado).
 *   - waha.status SCAN_QR/FAILED/...      -> "Bot desconectado" (danger).
 *   - waha.status unknown e sem sessao    -> "Bot desconectado" generico.
 *
 * Sem botao de refresh manual: o auto-refresh de 60s em foco (useStatus) e o
 * reload da pagina ja recarregam tudo — o botao era redundante (feedback Bruno).
 */
import { Badge } from '@/components/ui/badge';
import type { StatusResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';

type BotState = 'ativo' | 'desconectado' | 'pausado';

function resolveState(status: StatusResponse): BotState {
  if (!status.flow_enabled) return 'pausado';
  const w = (status.waha.status ?? '').toUpperCase();
  if (w === 'WORKING') return 'ativo';
  return 'desconectado';
}

const COPY: Record<BotState, { title: string; sub: string }> = {
  ativo: { title: 'Bot ativo', sub: 'Atendendo no WhatsApp agora' },
  desconectado: {
    title: 'Bot desconectado',
    sub: 'Fale com o suporte para reconectar',
  },
  pausado: {
    title: 'Atendimento pausado',
    sub: 'Regularize a mensalidade para reativar',
  },
};

function Pulse({ state }: { state: BotState }) {
  const tone =
    state === 'ativo'
      ? { bg: 'bg-ok-soft', core: 'bg-ok' }
      : state === 'pausado'
        ? { bg: 'bg-warn-soft', core: 'bg-warn' }
        : { bg: 'bg-danger-soft', core: 'bg-danger' };
  return (
    <span
      className={cn(
        'relative flex size-[46px] shrink-0 items-center justify-center rounded-full',
        tone.bg,
        state === 'ativo' && 'animate-ring',
      )}
    >
      <span
        className={cn('size-[13px] rounded-full', tone.core, state === 'ativo' && 'pulse-glow')}
      />
    </span>
  );
}

export function StatusHero({ status }: { status: StatusResponse }) {
  const state = resolveState(status);
  const copy = COPY[state];

  return (
    // Card-heroi E1 (1.D.4): borda line-strong + relevo preto (sem cor) pra
    // descolar da hero-zone viva. Margem fica por conta do grid do hero.
    <div className="hero-e1 relative h-full overflow-hidden rounded-card border border-line-strong bg-surface p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <Pulse state={state} />
          <div className="min-w-0">
            <h2 className="font-display text-[17px] font-semibold text-ink">{copy.title}</h2>
            <p className="mt-0.5 text-[13px] text-ink-soft">{copy.sub}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state === 'ativo' && <Badge tone="ok">Conectado</Badge>}
          {state === 'desconectado' && <Badge tone="danger">Desconectado</Badge>}
          {state === 'pausado' && <Badge tone="warn">Pausado</Badge>}
        </div>
      </div>
    </div>
  );
}
