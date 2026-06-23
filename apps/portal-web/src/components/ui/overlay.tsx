'use client';

import { cn } from '@/lib/cn';
/**
 * Overlay base para Sheet (bottom, mobile) e Modal (centralizado).
 * - trap de foco simples (Tab cicla dentro do dialog),
 * - Esc fecha (= cancelar),
 * - foco inicial no primeiro foco util; foco volta ao gatilho ao fechar,
 * - aria-modal + role=dialog. Anima entrada (180ms).
 *
 * Sem portal de lib externa: renderiza inline com position fixed cobrindo a tela.
 */
import { useCallback, useEffect, useRef } from 'react';

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /**
   * 'sheet'  sobe de baixo (mobile-first);
   * 'modal'  centraliza;
   * 'detail' é responsivo: bottom-sheet no mobile, painel lateral direito no
   *          desktop (>=sm). Usado no detalhe de agendamento (Bloco C).
   */
  variant: 'sheet' | 'modal' | 'detail';
  children: React.ReactNode;
  /** elemento que recebe foco ao abrir (default: o primeiro focavel). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function Overlay({
  open,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  variant,
  children,
  initialFocusRef,
}: OverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Guarda o gatilho ao abrir e devolve o foco ao fechar.
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      // foco inicial
      requestAnimationFrame(() => {
        const target =
          initialFocusRef?.current ??
          dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
          dialogRef.current;
        target?.focus();
      });
    } else if (triggerRef.current) {
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, [open, initialFocusRef]);

  // Trava o scroll do body enquanto aberto.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay de fundo; o conteudo trata teclado e Esc fecha
    <div
      className={cn(
        // Overlay mais forte no escuro (spec 1.A.6 / D12): black/55 vs ink/40 do claro.
        'fixed inset-0 z-40 flex bg-black/55',
        variant === 'sheet' && 'items-end',
        variant === 'modal' && 'items-center justify-center px-6',
        // detail: bottom-sheet no mobile, painel encostado à direita no desktop.
        variant === 'detail' && 'items-end sm:items-stretch sm:justify-end',
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onKeyDown={onKeyDown}
        className={cn(
          // Flutuante (spec 1.A.6): surface-elev + borda forte + sombra so pra descolar do overlay.
          variant === 'sheet' &&
            'w-full origin-bottom animate-[sheetIn_180ms_var(--ease-out-soft)] rounded-t-[22px] border-t border-line-strong bg-surface-elev pb-[calc(14px+env(safe-area-inset-bottom))] shadow-elev',
          variant === 'modal' &&
            'w-full max-w-[330px] animate-[modalIn_180ms_var(--ease-out-soft)] rounded-[20px] border border-line-strong bg-surface-elev p-[22px_20px_18px] shadow-elev',
          // detail: sheet de baixo no mobile; no desktop, painel alto encostado à
          // direita (entra deslizando da direita), com scroll interno.
          variant === 'detail' &&
            'flex max-h-[88vh] w-full origin-bottom animate-[sheetIn_180ms_var(--ease-out-soft)] flex-col overflow-y-auto rounded-t-[22px] border-t border-line-strong bg-surface-elev pb-[calc(14px+env(safe-area-inset-bottom))] shadow-elev sm:max-h-none sm:h-dvh sm:w-[420px] sm:origin-right sm:animate-[panelIn_200ms_var(--ease-out-soft)] sm:rounded-none sm:border-l sm:border-t-0 sm:pb-[max(18px,env(safe-area-inset-bottom))]',
        )}
      >
        {children}
      </div>
    </div>
  );
}
