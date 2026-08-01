'use client';

/**
 * Guard de "alterações não salvas" pro gesto de FECHAR um modal/sheet
 * (SCRUM-158, PR 3/3 — cobertura de overlays). O registry global
 * (`unsaved-changes-context.tsx`) só intercepta NAVEGAÇÃO: clique em `<a>`,
 * `popstate`, `beforeunload`. Fechar um `Overlay` não passa por nenhum dos
 * três — sai por Esc, clique no backdrop ou botão X, todos convergindo pro
 * mesmo `onClose` (ver `overlay.tsx:89` e `:127`). Sem este hook, um
 * rascunho dentro do sheet se perde em silêncio ao fechar.
 *
 * Por que NÃO estender o registry global do PR 1: lá "sair" = trocar de
 * rota, e o diálogo lista N seções sujas ao mesmo tempo (Cartão + FAQ) numa
 * página. Fechar um sheet é um gesto LOCAL e sempre 1:1 (uma seção, um
 * dono). Dá pra reusar o MESMO componente de diálogo (`UnsavedChangesDialog`,
 * 3 ações — Salvar e sair / Descartar / Cancelar) sem tocar o registry nem
 * o provider: aqui é só `useState` local decidindo quando abrir aquele
 * diálogo, com callbacks locais no lugar dos globais.
 *
 * O padrão de Overlay-dentro-de-Overlay (o `UnsavedChangesDialog`, variant
 * "modal", sobre o `Overlay variant="detail"` do sheet pai) já é o MESMO
 * usado pelas confirmações destrutivas existentes nestes componentes
 * (remover atendimento, cancelar horário via `ConfirmDialog`) — provado em
 * produção, sem conflito de z-index/foco/Esc: o Overlay de cima é portado
 * depois no DOM (ordem de montagem == ordem de empilhamento com z-index
 * empatado) e o `onKeyDown` fica no `role="dialog"` de CADA overlay com
 * `stopPropagation` — o Esc fecha só o que está com foco (o de cima),
 * nunca os dois juntos.
 *
 * Uso: trocar `onClose={fechar}`/o botão X do sheet por `pedirFechar`, e
 * renderizar `<UnsavedChangesDialog {...guard} />` como irmão do Overlay.
 */
import { useState } from 'react';

export interface GuardAoFecharResult {
  /** Passar no lugar do onClose original do Overlay/botão X. */
  pedirFechar: () => void;
  /** true enquanto o diálogo de confirmação está aberto. */
  open: boolean;
  /** true enquanto "Salvar e sair" está em voo. */
  salvando: boolean;
  onSalvarESair: () => void;
  onDescartar: () => void;
  onCancelar: () => void;
}

/**
 * @param dirty - true se há rascunho não salvo.
 * @param salvar - salva o rascunho (rejeita em erro de validação/save — nesse caso NÃO fecha, mesma semântica do guard de navegação).
 * @param fecharDeVerdade - callback que efetivamente fecha o overlay (o `onClose`/reset original).
 */
export function useGuardAoFechar(
  dirty: boolean,
  salvar: () => void | Promise<void>,
  fecharDeVerdade: () => void,
): GuardAoFecharResult {
  const [open, setOpen] = useState(false);
  const [salvando, setSalvando] = useState(false);

  function pedirFechar() {
    if (dirty) {
      setOpen(true);
      return;
    }
    fecharDeVerdade();
  }

  function onDescartar() {
    setOpen(false);
    fecharDeVerdade();
  }

  function onCancelar() {
    setOpen(false);
  }

  async function onSalvarESair() {
    setSalvando(true);
    try {
      await salvar();
      setSalvando(false);
      setOpen(false);
      fecharDeVerdade();
    } catch {
      // Erro já tratado (toast/erro inline) dentro de `salvar` — mantém o
      // dono no sheet pra corrigir, igual ao guard de navegação.
      setSalvando(false);
    }
  }

  return { pedirFechar, open, salvando, onSalvarESair, onDescartar, onCancelar };
}
