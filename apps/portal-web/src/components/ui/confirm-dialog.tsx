'use client';

/**
 * Modal de confirmacao (spec 6.10). Titulo + corpo + 2 botoes. Cancelar SEMPRE
 * visivel (sem dark pattern). Foco inicial no botao menos destrutivo (Cancelar),
 * pra evitar confirmar sem querer. Acao primaria a direita.
 */
import { useId, useRef } from 'react';
import { Button } from './button';
import { Overlay } from './overlay';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Variante do botao de confirmacao. */
  confirmVariant?: 'primary' | 'destructive';
  loading?: boolean;
  icon?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancelar',
  confirmVariant = 'primary',
  loading,
  icon,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      variant="modal"
      ariaLabelledBy={titleId}
      initialFocusRef={cancelRef}
    >
      {icon && (
        <div className="mb-3.5 flex size-12 items-center justify-center rounded-[14px] bg-brand-50 text-brand">
          {icon}
        </div>
      )}
      <h3
        id={titleId}
        className="font-display text-[18px] font-semibold tracking-[-0.01em] text-ink"
      >
        {title}
      </h3>
      <p className="mt-2 text-[14px] leading-normal text-ink-soft">{description}</p>
      <div className="mt-5 flex gap-2.5">
        <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} loading={loading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Overlay>
  );
}
