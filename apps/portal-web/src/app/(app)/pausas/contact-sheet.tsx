'use client';

import { Overlay } from '@/components/ui/overlay';
import { Skeleton, skeletonKeys } from '@/components/ui/skeleton';
import type { RecentContact } from '@/lib/api-types';
import { formatHaTempo, formatPhoneDisplay, initials, normalizePhone } from '@/lib/format';
import { useContatos } from '@/lib/queries';
/**
 * Bottom sheet de contatos recentes (spec 6.9). SEM digitacao livre de numero —
 * trava de UX da missao. Lista vem de /portal/contatos (recent-contacts).
 *
 * Item 3: exibe o numero COMPLETO formatado (sem mascara) — o dono ve os proprios
 *   clientes.
 * Item 4: esconde quem JA esta pausado (pausadosSet, por telefone normalizado).
 *   Se todos os recentes ja estao pausados, empty state claro.
 *
 * Loading: skeleton 4 linhas. Selecionar -> callback com o contato, que abre a
 * confirmacao de pausa.
 */
import { useMemo } from 'react';

interface ContactSheetProps {
  open: boolean;
  slot: string;
  /** Telefones (normalizados) ja pausados — filtrados da lista (item 4). */
  pausadosSet: Set<string>;
  onClose: () => void;
  onSelect: (contact: RecentContact) => void;
}

export function ContactSheet({ open, slot, pausadosSet, onClose, onSelect }: ContactSheetProps) {
  const contatos = useContatos(slot, open);

  const todos = contatos.data?.contacts ?? [];
  // Esconde quem ja esta pausado (item 4).
  const disponiveis = useMemo(
    () => todos.filter((c) => !pausadosSet.has(normalizePhone(c.phone))),
    [todos, pausadosSet],
  );
  // Diferencia "nao tem contato recente" de "todos os recentes ja estao pausados".
  const todosPausados = todos.length > 0 && disponiveis.length === 0;

  return (
    <Overlay open={open} onClose={onClose} variant="sheet" ariaLabel="Escolher contato recente">
      <div className="mx-auto mb-1.5 mt-2 h-1 w-10 rounded-pill bg-line-strong" aria-hidden />
      <div className="px-5 pb-3 pt-2">
        <h2 className="font-display text-[17px] font-semibold text-ink">
          Escolha um contato recente
        </h2>
        <p className="mt-0.5 text-[12.5px] text-ink-soft">
          Quem falou com o robô nos últimos dias.
        </p>
      </div>

      <div className="max-h-[60vh] overflow-auto px-3 pb-2">
        {contatos.isPending ? (
          <>
            <span className="sr-only">Carregando contatos…</span>
            {skeletonKeys(4).map((key) => (
              <div key={key} className="flex items-center gap-3 px-2 py-3">
                <Skeleton className="size-10 rounded-[12px]" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </>
        ) : contatos.isError ? (
          <p className="px-2 py-8 text-center text-[13px] text-ink-soft">
            Não foi possível carregar os contatos agora.
          </p>
        ) : disponiveis.length > 0 ? (
          disponiveis.map((c) => (
            <button
              key={c.phone}
              type="button"
              onClick={() => onSelect(c)}
              className="flex min-h-14 w-full items-center gap-3.5 rounded-[12px] px-2 py-3 text-left outline-none transition-colors hover:bg-surface-elev-hover focus-visible:bg-surface-elev-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset active:bg-surface-elev-hover"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-brand-soft font-display text-[14px] font-bold text-brand">
                {initials(c.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-[14.5px] font-semibold text-ink">
                  {c.name ?? 'Contato'}
                </span>
                <span className="block text-[12.5px] tabular-nums text-ink-soft">
                  {formatPhoneDisplay(c.phone)}
                </span>
              </span>
              <span className="shrink-0 text-[12px] text-ink-faint">
                {formatHaTempo(c.last_interaction)}
              </span>
            </button>
          ))
        ) : todosPausados ? (
          <div className="px-2 py-10 text-center">
            <h3 className="font-display text-[15px] font-semibold text-ink">
              Todos os contatos recentes já estão pausados
            </h3>
            <p className="mt-1 text-[13px] text-ink-soft">
              Não há mais ninguém pra pausar por aqui. Despause alguém na lista pra voltar a
              atendê-lo.
            </p>
          </div>
        ) : (
          <div className="px-2 py-10 text-center">
            <h3 className="font-display text-[15px] font-semibold text-ink">
              Nenhum contato recente
            </h3>
            <p className="mt-1 text-[13px] text-ink-soft">
              Assim que alguém falar com o robô, aparece aqui.
            </p>
          </div>
        )}
      </div>

      <p className="px-5 pt-2 text-center text-[12px] leading-normal text-ink-faint">
        Só aparecem contatos que já conversaram com o robô. Sem digitar número.
      </p>
    </Overlay>
  );
}
