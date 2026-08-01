'use client';

/**
 * Diálogo de "alterações não salvas" (requisito do Bruno) — TRÊS saídas, por
 * isso é IRMÃO de `confirm-dialog.tsx` (não extensão): `ConfirmDialog` é
 * fechado em 2 ações (confirmar/cancelar) por design — width, foco inicial e
 * layout dos botões assumem par. Forçar uma 3ª ação ali quebraria esse
 * contrato pros ~10 usos existentes. Aqui o layout empilha vertical (mobile-
 * first: 3 botões lado a lado não cabem em ~360px) com "Cancelar" por último
 * e mais discreto (ghost) — as duas ações que IMPORTAM (Salvar/Descartar)
 * ficam em cima, mais alcançáveis com o polegar.
 *
 * Foco inicial no botão MENOS destrutivo (Cancelar) — mesmo princípio do
 * ConfirmDialog: evita descartar sem querer com um Enter no automático.
 */
import { descreveSecoesSujas } from '@/lib/nao-salvo';
import { useId, useRef } from 'react';
import { Button } from './button';
import { Overlay } from './overlay';

interface UnsavedChangesDialogProps {
  open: boolean;
  /** true enquanto "Salvar e sair" está em voo — desabilita os 3 botões. */
  loading?: boolean;
  /**
   * Nomes das seções com rascunho pendente (SCRUM-158, guard global — várias
   * seções podem estar sujas ao mesmo tempo, ex.: Cartão + FAQ). Sem essa
   * prop (ou lista vazia), o texto fica byte-idêntico ao de antes do guard
   * virar global.
   */
  secoes?: string[];
  onSalvarESair: () => void;
  onDescartar: () => void;
  onCancelar: () => void;
}

export function UnsavedChangesDialog({
  open,
  loading,
  secoes,
  onSalvarESair,
  onDescartar,
  onCancelar,
}: UnsavedChangesDialogProps) {
  const descricao =
    secoes && secoes.length > 0
      ? `Quer salvar antes de sair, ou descartar o que você editou em ${descreveSecoesSujas(secoes)}?`
      : 'Quer salvar antes de sair, ou descartar o que você editou nesta tela?';
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Overlay
      open={open}
      onClose={onCancelar}
      variant="modal"
      ariaLabelledBy={titleId}
      initialFocusRef={cancelRef}
    >
      <h3
        id={titleId}
        className="font-display text-[18px] font-semibold tracking-[-0.01em] text-ink"
      >
        Você tem alterações não salvas
      </h3>
      <p className="mt-2 text-[14px] leading-normal text-ink-soft">{descricao}</p>
      <div className="mt-5 flex flex-col gap-2.5">
        <Button variant="primary" loading={loading} onClick={onSalvarESair}>
          Salvar e sair
        </Button>
        <Button variant="destructive" disabled={loading} onClick={onDescartar}>
          Descartar
        </Button>
        <Button ref={cancelRef} variant="ghost" disabled={loading} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </Overlay>
  );
}
