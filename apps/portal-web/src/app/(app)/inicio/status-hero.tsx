'use client';

import { IconRefresh } from '@/components/icons';
/**
 * Status-hero da Home (spec 6.4 + 3.1). Mapeia o estado do bot a partir do
 * /portal/status:
 *   - flow_enabled=false                  -> "Atendimento pausado" (inadimplencia,
 *                                            warn). SEM botao de reativar (D3).
 *   - waha.status WORKING                 -> "Bot ativo" (ok, pulse animado).
 *   - waha.status SCAN_QR/FAILED/...      -> "Bot desconectado" (danger).
 *   - waha.status unknown e sem sessao    -> "Bot desconectado" generico.
 *
 * Botao de refresh manual (spec 4): gira 300ms e dispara refetch.
 */
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
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
      ? { bg: 'bg-ok-bg', core: 'bg-ok' }
      : state === 'pausado'
        ? { bg: 'bg-warn-bg', core: 'bg-warn' }
        : { bg: 'bg-danger-bg', core: 'bg-danger' };
  return (
    <span
      className={cn(
        'relative flex size-[46px] shrink-0 items-center justify-center rounded-full',
        tone.bg,
        state === 'ativo' && 'animate-ring',
      )}
    >
      <span className={cn('size-[13px] rounded-full', tone.core)} />
    </span>
  );
}

export function StatusHero({
  status,
  onRefresh,
  refreshing,
}: {
  status: StatusResponse;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const state = resolveState(status);
  const copy = COPY[state];

  return (
    <Card className="mb-3.5">
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

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          aria-label="Atualizar status"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex size-11 items-center justify-center rounded-card-sm border border-line text-ink-soft outline-none transition-colors hover:bg-brand-50 hover:text-brand focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
        >
          <IconRefresh size={18} className={refreshing ? 'animate-spin-token' : undefined} />
        </button>
      </div>
    </Card>
  );
}
