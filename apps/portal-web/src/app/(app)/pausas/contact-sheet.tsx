'use client';

import { Overlay } from '@/components/ui/overlay';
import { Skeleton, skeletonKeys } from '@/components/ui/skeleton';
import type { RecentContact } from '@/lib/api-types';
import { formatHaTempo, initials, maskPhoneDisplay } from '@/lib/format';
/**
 * Bottom sheet de contatos recentes (spec 6.9). SEM digitacao livre de numero —
 * trava de UX da missao. Lista vem de /portal/contatos (recent-contacts).
 * Loading: skeleton 4 linhas; vazio: empty amigavel. Selecionar -> callback com o
 * telefone (digitos) e o nome, que abre a confirmacao de pausa.
 */
import { useContatos } from '@/lib/queries';

interface ContactSheetProps {
  open: boolean;
  slot: string;
  onClose: () => void;
  onSelect: (contact: RecentContact) => void;
}

export function ContactSheet({ open, slot, onClose, onSelect }: ContactSheetProps) {
  const contatos = useContatos(slot, open);

  return (
    <Overlay open={open} onClose={onClose} variant="sheet" ariaLabel="Escolher contato recente">
      <div className="mx-auto mb-1.5 mt-2 h-1 w-10 rounded-pill bg-line" aria-hidden />
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
        ) : contatos.data && contatos.data.contacts.length > 0 ? (
          contatos.data.contacts.map((c) => (
            <button
              key={c.phone}
              type="button"
              onClick={() => onSelect(c)}
              className="flex min-h-14 w-full items-center gap-3.5 rounded-[12px] px-2 py-3 text-left outline-none transition-colors hover:bg-brand-50 focus-visible:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-brand-50 font-display text-[14px] font-bold text-brand">
                {initials(c.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-[14.5px] font-semibold text-ink">
                  {c.name ?? 'Contato'}
                </span>
                <span className="block text-[12.5px] tabular-nums text-ink-soft">
                  {maskPhoneDisplay(c.phone)}
                </span>
              </span>
              <span className="shrink-0 text-[12px] text-ink-faint">
                {formatHaTempo(c.last_interaction)}
              </span>
            </button>
          ))
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
