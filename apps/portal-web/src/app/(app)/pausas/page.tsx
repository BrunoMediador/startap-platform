'use client';

import { IconPause, IconPlay } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import type { PausaRow, RecentContact } from '@/lib/api-types';
import { formatPausadoHa, initials, maskPhoneDisplay } from '@/lib/format';
import { useAddPausa, usePausas, useRemovePausa } from '@/lib/queries';
/**
 * Pausas (spec 6.9/6.10 + 3.5). Lista de pausados + "Pausar um número" (abre
 * sheet de contatos recentes, SEM digitacao livre). Pausar E despausar SEMPRE com
 * CONFIRMACAO explicita (D5 — efeito real no atendimento). Nao otimista: chama,
 * confirma com toast, a lista revalida via invalidateQueries.
 */
import { useState } from 'react';
import { ContactSheet } from './contact-sheet';

/** Nome amigavel de uma pausa (reason pode trazer contexto; senao usa o numero). */
function nomePausa(p: PausaRow): string {
  return maskPhoneDisplay(p.telefone);
}

export default function PausasPage() {
  const { slot } = useTenant();
  const toast = useToast();
  const pausasQ = usePausas(slot);
  const addPausa = useAddPausa(slot);
  const removePausa = useRemovePausa(slot);

  const [sheetOpen, setSheetOpen] = useState(false);
  // confirmacao de PAUSAR um contato escolhido no sheet
  const [pausando, setPausando] = useState<RecentContact | null>(null);
  // confirmacao de DESPAUSAR uma linha existente
  const [despausando, setDespausando] = useState<PausaRow | null>(null);

  const pausas = pausasQ.data?.pausas ?? [];

  function onSelectContato(c: RecentContact) {
    setSheetOpen(false);
    setPausando(c);
  }

  function confirmPausar() {
    const c = pausando;
    if (!c) return;
    addPausa.mutate(c.phone, {
      onSuccess: () => {
        setPausando(null);
        toast.success(`${c.name ?? 'Contato'} pausado`);
      },
      onError: () => {
        setPausando(null);
        toast.error('Não foi possível pausar. Tente de novo.');
      },
    });
  }

  function confirmDespausar() {
    const p = despausando;
    if (!p) return;
    removePausa.mutate(p.telefone, {
      onSuccess: () => {
        setDespausando(null);
        toast.success(`${nomePausa(p)} despausado`);
      },
      onError: () => {
        setDespausando(null);
        toast.error('Não foi possível despausar. Tente de novo.');
      },
    });
  }

  return (
    <>
      <PageHead
        title="Pausas"
        subtitle="Números que o robô não vai responder. Útil pra atender alguém na mão."
      />

      {pausasQ.isPending ? (
        <>
          <span className="sr-only">Carregando números pausados…</span>
          <SkeletonList rows={3} />
        </>
      ) : pausasQ.isError ? (
        <ErrorState onRetry={() => pausasQ.refetch()} />
      ) : pausas.length === 0 ? (
        <EmptyState
          icon={<IconPause size={48} />}
          title="Nenhum número pausado"
          description="Quando precisar atender alguém manualmente, pause o robô para esse contato aqui."
          action={{ label: 'Pausar um número', onClick: () => setSheetOpen(true) }}
        />
      ) : (
        <>
          <div className="mb-3.5 overflow-hidden rounded-card border border-line bg-surface">
            {pausas.map((p) => (
              <div
                key={p.telefone}
                className="flex min-h-16 items-center gap-3.5 border-b border-line px-[15px] py-3.5 last:border-b-0"
              >
                <span className="flex size-[42px] shrink-0 items-center justify-center rounded-[12px] bg-warn-bg text-warn">
                  <IconPause size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-display text-[15px] font-semibold text-ink">
                    {nomePausa(p)}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-ink-soft">
                    {formatPausadoHa(p.updated_at)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDespausando(p)}
                  className="h-10 shrink-0 rounded-[11px] border border-line bg-surface px-4 font-display text-[13.5px] font-semibold text-brand outline-none transition-colors hover:border-transparent hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Despausar
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex h-[52px] w-full items-center justify-center gap-2.5 rounded-card bg-brand font-display text-[15px] font-semibold text-white outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-700 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          >
            <IconPause size={20} />
            Pausar um número
          </button>
        </>
      )}

      <ContactSheet
        open={sheetOpen}
        slot={slot}
        onClose={() => setSheetOpen(false)}
        onSelect={onSelectContato}
      />

      <ConfirmDialog
        open={pausando !== null}
        icon={<IconPause size={24} />}
        title={`Pausar atendimento de ${pausando?.name ?? 'esse contato'}?`}
        description="O robô vai parar de responder esse contato até você despausar."
        confirmLabel="Pausar"
        loading={addPausa.isPending}
        onConfirm={confirmPausar}
        onCancel={() => setPausando(null)}
      />

      <ConfirmDialog
        open={despausando !== null}
        icon={<IconPlay size={24} />}
        title={`Voltar a atender ${despausando ? nomePausa(despausando) : 'esse contato'}?`}
        description="O robô vai responder esse contato normalmente de novo."
        confirmLabel="Despausar"
        loading={removePausa.isPending}
        onConfirm={confirmDespausar}
        onCancel={() => setDespausando(null)}
      />
    </>
  );
}
