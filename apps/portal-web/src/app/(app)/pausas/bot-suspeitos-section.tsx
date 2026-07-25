'use client';

import { IconAlert, IconPlay } from '@/components/icons';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import type { PausaRow } from '@/lib/api-types';
import { formatPausadoHa, formatPhoneDisplay, initials } from '@/lib/format';
import { useBotDetectPausas, useRemoveBotDetectPausa } from '@/lib/queries';

/** Placeholder muted quando nenhum nome resolve (SCRUM-144) — igual ao da lista de Pausas. */
const NOME_NAO_CAPTURADO = 'nome não capturado';
/**
 * Seção "Números pausados (suspeita de bot)" (SCRUM-4 PR-E). Lista os números que a auto-pausa do
 * bot-detect pausou (source='bot_detected') e deixa o dono DESPAUSAR num clique — a rede de proteção
 * da auto-pausa. Reusa o padrão visual de Pausas + ConfirmDialog (efeito real no atendimento).
 *
 * VEM VAZIA enquanto a auto-pausa do worker (BOT_DETECT_AUTOPAUSE) estiver OFF -> a seção NÃO
 * renderiza nada (return null). Byte-a-byte invisível pro cliente até a feature ser ligada.
 *
 * O dono vê o número COMPLETO (são contatos dele — precisa reconhecer quem foi pausado); o nome,
 * quando existe, vem do join telefone->nome que a página de Pausas já monta (prop resolveName).
 */
import { useState } from 'react';

interface BotSuspeitosSectionProps {
  slot: string;
  /** Resolve nome a partir do telefone (join com contatos já feito na página). */
  resolveName: (telefone: string) => string | null;
}

export function BotSuspeitosSection({ slot, resolveName }: BotSuspeitosSectionProps) {
  const toast = useToast();
  const pausasQ = useBotDetectPausas(slot);
  const removePausa = useRemoveBotDetectPausa(slot);
  const [despausando, setDespausando] = useState<PausaRow | null>(null);

  const pausas = pausasQ.data?.pausas ?? [];

  // Enquanto a auto-pausa estiver OFF a lista vem vazia -> não renderiza nada (nem em erro/loading).
  if (pausas.length === 0) return null;

  // SCRUM-144: contact_name snapshotado na pausa PRIMEIRO; senão o join com recentes (prop
  // resolveName). null = nenhum nome real → UI mostra "nome não capturado".
  function nomeReal(p: PausaRow): string | null {
    const snap = p.contact_name?.trim();
    if (snap && snap.length > 0) return snap;
    return resolveName(p.telefone);
  }

  function confirmDespausar() {
    const p = despausando;
    if (!p) return;
    const rotulo = nomeReal(p) ?? formatPhoneDisplay(p.telefone);
    removePausa.mutate(p.telefone, {
      onSuccess: () => {
        setDespausando(null);
        toast.success(`${rotulo} despausado`);
      },
      onError: () => {
        setDespausando(null);
        toast.error('Não foi possível despausar. Tente de novo.');
      },
    });
  }

  const despausandoNome = despausando ? nomeReal(despausando) : null;

  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-warn-soft text-warn">
          <IconAlert size={16} />
        </span>
        <div>
          <h2 className="font-display text-[14.5px] font-semibold text-ink">
            Números pausados (suspeita de bot)
          </h2>
          <p className="text-[12.5px] text-ink-soft">
            Pausamos automaticamente quem parece um robô. Se for um cliente de verdade, despause.
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-card border border-warn/40 bg-surface shadow-card">
        {pausas.map((p) => {
          // SCRUM-144: TÍTULO = nome real OU "nome não capturado" (muted); SUBTÍTULO = número
          // sempre visível. Mesma regra uniforme da lista principal de Pausas.
          const nome = nomeReal(p);
          const numero = formatPhoneDisplay(p.telefone);
          return (
            <div
              key={p.telefone}
              className="group flex min-h-16 items-center gap-3.5 border-b border-line-soft px-[15px] py-3.5 transition-colors last:border-b-0 hover:bg-surface-hover"
            >
              <span className="flex size-[42px] shrink-0 items-center justify-center rounded-[12px] bg-warn-soft font-display text-[14px] font-bold text-warn">
                {nome ? initials(nome) : <IconAlert size={20} />}
              </span>
              <div className="min-w-0 flex-1">
                {nome ? (
                  <div className="truncate font-display text-[15px] font-semibold text-ink">
                    {nome}
                  </div>
                ) : (
                  <div className="truncate font-display text-[15px] font-medium italic text-ink-faint">
                    {NOME_NAO_CAPTURADO}
                  </div>
                )}
                <div className="mt-0.5 text-[12.5px] tabular-nums text-ink-soft">
                  {numero} · {formatPausadoHa(p.updated_at)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDespausando(p)}
                className="h-10 shrink-0 rounded-[11px] border border-line-strong bg-surface px-4 font-display text-[13.5px] font-semibold text-brand outline-none transition-colors hover:border-line-strong hover:bg-surface-elev-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Despausar
              </button>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={despausando !== null}
        icon={<IconPlay size={24} />}
        title={`Voltar a atender ${
          despausandoNome ??
          (despausando ? formatPhoneDisplay(despausando.telefone) : 'esse contato')
        }?`}
        description="O assistente vai responder esse contato normalmente de novo."
        confirmLabel="Despausar"
        loading={removePausa.isPending}
        onConfirm={confirmDespausar}
        onCancel={() => setDespausando(null)}
      />
    </section>
  );
}
