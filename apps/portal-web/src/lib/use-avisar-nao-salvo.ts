'use client';

/**
 * Guarda de navegação genérica (requisito do Bruno): se o dono editou um form
 * e tenta SAIR da tela sem salvar — trocar de sub-aba, clicar em item do menu,
 * voltar — sobe um popup com 3 saídas (Salvar e sair / Descartar / Cancelar)
 * em vez de perder o rascunho em silêncio. Mora em `lib/` (não em
 * `components/`) porque não é UI: é lógica de interceptação de navegação +
 * estado do diálogo, reaproveitável por QUALQUER form futuro que precise do
 * mesmo guard (hoje só `/negocio/dados`, mas o hook não sabe nada sobre
 * "perfil" — só recebe `dirty` e um `onSalvar`).
 *
 * ── Como intercepta ──────────────────────────────────────────────────────
 * O App Router do Next 15 (estável, sem a APIs de bloqueio ainda instável em
 * canary) não expõe um "beforeNavigate" nativo. A saída confiável pra
 * navegação CLIENT-SIDE (Link da sidebar/bottom-nav/sub-tabs, ou qualquer
 * <a> interno) é um listener de CLIQUE em fase de CAPTURA no documento: acha
 * o <a> mais próximo, filtra só links internos (mesma origem, sem
 * target/download/modificador), e se `dirty` for true intercepta ANTES do
 * Next navegar (`preventDefault` + `stopImmediatePropagation`), guarda o href
 * e abre o diálogo. "Voltar" do navegador (botão físico/gesto) é coberto por
 * um listener de `popstate`: como o Next já trocou a URL antes do evento
 * disparar, a única forma de "recusar" é reempurrar a URL atual na história
 * (`history.pushState`) e abrir o diálogo — se o dono confirmar Descartar/
 * Salvar, aí sim `router.back()` de verdade.
 *
 * ⚠️ LIMITAÇÃO CONHECIDA: fechar a ABA/JANELA do navegador (ou recarregar)
 * não passa por nenhum dos dois listeners acima — não tem JS client-side que
 * troque isso por um diálogo customizado. Cobrimos com `beforeunload` nativo
 * (o prompt genérico do PRÓPRIO navegador, sem nossas 3 opções — só
 * OK/Cancelar do browser). É uma degradação aceita, não uma solução frágil:
 * não dá pra fingir 3 botões num prompt que o Chrome/Firefox não deixa
 * customizar há anos (removeram o texto customizado por spam).
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SaidaNaoSalvo = 'salvar' | 'descartar' | 'cancelar';

export interface UseAvisarNaoSalvoResult {
  /** true = diálogo aberto (renderize o `UnsavedChangesDialog` com isto). */
  open: boolean;
  /** Chama ao clicar "Salvar e sair". Ver `onConfirmSalvar` no hook. */
  onSalvarESair: () => void;
  /** Chama ao clicar "Descartar". */
  onDescartar: () => void;
  /** Chama ao clicar "Cancelar" (ou Esc/fora do modal). */
  onCancelar: () => void;
  /** true enquanto o `onSalvar` do chamador está em voo (desabilita os botões). */
  salvando: boolean;
}

/**
 * @param dirty - true quando há edição não salva (comparação rascunho×salvo já
 *   pronta do chamador — inclui QUALQUER campo que o form considere "sujo").
 * @param onSalvar - função de submit existente do form. Deve devolver uma
 *   Promise que REJEITA em caso de validação/erro (o hook cancela a
 *   navegação e deixa o form mostrar o erro inline — nunca navega nem
 *   descarta em silêncio) e RESOLVE em sucesso (o hook libera a navegação
 *   pendente). Síncrono também é aceito (fica implicitamente resolvido).
 */
export function useAvisarNaoSalvo(
  dirty: boolean,
  onSalvar: () => void | Promise<void>,
): UseAvisarNaoSalvoResult {
  const router = useRouter();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const [open, setOpen] = useState(false);
  const [salvando, setSalvando] = useState(false);
  // Destino pendente: um href (navegação por Link) ou 'back' (botão voltar).
  const pendingRef = useRef<string | 'back' | null>(null);

  const irPara = useCallback(
    (destino: string | 'back') => {
      if (destino === 'back') router.back();
      else router.push(destino);
    },
    [router],
  );

  // ── Intercepta clique em <a> interno (Link da sidebar/bottom-nav/sub-tabs) ──
  useEffect(() => {
    function onClickCapture(e: MouseEvent) {
      if (!dirtyRef.current) return;
      // Ignora clique modificado (abrir em nova aba/janela) — deixa o browser cuidar.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;

      const anchor = (e.target as HTMLElement)?.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      if (anchor.hasAttribute('download') || anchor.getAttribute('target') === '_blank') return;

      // Só intercepta navegação INTERNA (mesma origem) — link externo segue normal.
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Mesmo destino (ex.: âncora da própria página) não é "sair" — deixa passar.
      if (url.pathname === window.location.pathname) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      pendingRef.current = `${url.pathname}${url.search}${url.hash}`;
      setOpen(true);
    }

    document.addEventListener('click', onClickCapture, true);
    return () => document.removeEventListener('click', onClickCapture, true);
  }, []);

  // ── Intercepta o botão/gesto "voltar" do navegador ──────────────────────
  useEffect(() => {
    function onPopState() {
      if (!dirtyRef.current) return;
      // O Next já trocou a URL: reempurra a atual pra "cancelar" a saída até o
      // dono decidir no diálogo (se confirmar, `irPara('back')` navega de verdade).
      window.history.pushState(null, '', window.location.href);
      pendingRef.current = 'back';
      setOpen(true);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // ── Fechar aba/recarregar: fallback nativo (ver limitação no topo do arquivo) ──
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      e.preventDefault();
      // Alguns browsers exigem returnValue setado; texto é ignorado por eles (prompt genérico).
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const onCancelar = useCallback(() => {
    setOpen(false);
    pendingRef.current = null;
  }, []);

  const onDescartar = useCallback(() => {
    const destino = pendingRef.current;
    setOpen(false);
    pendingRef.current = null;
    if (destino) irPara(destino);
  }, [irPara]);

  const onSalvarESair = useCallback(() => {
    const destino = pendingRef.current;
    setSalvando(true);
    Promise.resolve()
      .then(() => onSalvar())
      .then(() => {
        // Sucesso: fecha o diálogo e SÓ ENTÃO navega (dirty já deve ter virado
        // false pelo próprio onSalvar, mas navegamos de qualquer forma — o
        // chamador é quem decide se o submit teve sucesso via resolve/reject).
        setSalvando(false);
        setOpen(false);
        pendingRef.current = null;
        if (destino) irPara(destino);
      })
      .catch(() => {
        // Validação/erro: CANCELA a navegação, deixa o diálogo fechar e o form
        // (que já deve estar mostrando o erro inline via seu próprio estado)
        // segue na tela. Nunca navega nem descarta em silêncio.
        setSalvando(false);
        setOpen(false);
        pendingRef.current = null;
      });
  }, [onSalvar, irPara]);

  return { open, onSalvarESair, onDescartar, onCancelar, salvando };
}
