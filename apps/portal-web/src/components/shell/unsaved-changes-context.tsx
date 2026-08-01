'use client';

/**
 * Guard GLOBAL de "alterações não salvas" (SCRUM-158). Substitui o desenho
 * anterior de "a página declara seu dirty" (`useAvisarNaoSalvo`, ligado só em
 * `/negocio/dados`) por um REGISTRY: cada seção salvável se registra aqui
 * (`useRegistrarNaoSalvo`); um guard central observa TODAS e sobe um único
 * diálogo, mesmo com várias seções sujas ao mesmo tempo (ex. histórico: Cartão
 * + FAQ em "Meu atendente › Mensagens" — o bug original que motivou isto; a
 * UI de FAQ foi removida depois, mas o mecanismo de "várias sujas" continua
 * valendo pra qualquer par de seções salváveis).
 *
 * Por que registry e não `useAvisarNaoSalvo` chamado 9x: o hook registra 3
 * listeners globais (click em captura, popstate, beforeunload). N instâncias
 * = N listeners concorrentes disputando o mesmo evento — o primeiro a rodar
 * chama `stopImmediatePropagation()` e mata os outros, então só a seção mais
 * "cedo" no DOM abriria diálogo e as demais perderiam o rascunho em
 * silêncio (o bug de novo, só mais difícil de reproduzir). No popstate seria
 * pior: cada instância faz seu próprio `history.pushState`, empilhando N
 * entradas fantasma por clique no "voltar".
 *
 * Registros num `useRef<Map>`, NÃO `useState`: `dirty` muda a cada tecla
 * digitada no form — um Map em estado re-renderizaria o `(app)` inteiro (todo
 * o shell: sidebar/topbar/bottom-nav) a cada caractere. Só `{open,
 * nomesSujos}` (o que o diálogo realmente precisa exibir) vira estado.
 *
 * A mecânica dos 3 listeners é a MESMA já validada em prod pelo hook
 * original (#545) — só trocamos a fonte do dirty (`dirtyRef.current` -> a
 * lista de registros sujos) e a decisão de clique (inline -> `deveInterceptarClique`,
 * puro e testado em `lib/nao-salvo.test.ts`).
 */
import { UnsavedChangesDialog } from '@/components/ui/unsaved-changes-dialog';
import {
  type RegistroNaoSalvo,
  descreveSecoesSujas,
  deveInterceptarClique,
  salvarTodos,
  sujos,
} from '@/lib/nao-salvo';
import { useRouter } from 'next/navigation';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

interface UnsavedChangesCtx {
  registrar: (id: string, registro: RegistroNaoSalvo) => void;
  desregistrar: (id: string) => void;
}

const Ctx = createContext<UnsavedChangesCtx | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const registrosRef = useRef<Map<string, RegistroNaoSalvo>>(new Map());

  const [open, setOpen] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [nomesSujos, setNomesSujos] = useState<string[]>([]);
  // Destino pendente: um href (navegação por Link) ou 'back' (botão voltar).
  const pendingRef = useRef<string | 'back' | null>(null);

  const registrar = useCallback((id: string, registro: RegistroNaoSalvo) => {
    registrosRef.current.set(id, registro);
  }, []);

  const desregistrar = useCallback((id: string) => {
    registrosRef.current.delete(id);
  }, []);

  const irPara = useCallback(
    (destino: string | 'back') => {
      if (destino === 'back') router.back();
      else router.push(destino);
    },
    [router],
  );

  const algumSujo = useCallback(() => sujos([...registrosRef.current.values()]).length > 0, []);

  // ── Intercepta clique em <a> interno (Link da sidebar/bottom-nav/sub-tabs) ──
  useEffect(() => {
    function onClickCapture(e: MouseEvent) {
      if (!algumSujo()) return;

      const anchorEl = (e.target as HTMLElement)?.closest?.('a[href]');
      const destino = deveInterceptarClique(
        anchorEl
          ? {
              href: anchorEl.getAttribute('href'),
              download: anchorEl.hasAttribute('download'),
              target: anchorEl.getAttribute('target'),
            }
          : null,
        window.location.origin,
        window.location.pathname,
        {
          defaultPrevented: e.defaultPrevented,
          button: e.button,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
        },
      );
      if (!destino) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      pendingRef.current = destino;
      setNomesSujos(sujos([...registrosRef.current.values()]).map((r) => r.nome));
      setOpen(true);
    }

    document.addEventListener('click', onClickCapture, true);
    return () => document.removeEventListener('click', onClickCapture, true);
  }, [algumSujo]);

  // ── Intercepta o botão/gesto "voltar" do navegador ──────────────────────
  useEffect(() => {
    function onPopState() {
      if (!algumSujo()) return;
      // O Next já trocou a URL: reempurra a atual pra "cancelar" a saída até o
      // dono decidir no diálogo (se confirmar, `irPara('back')` navega de verdade).
      window.history.pushState(null, '', window.location.href);
      pendingRef.current = 'back';
      setNomesSujos(sujos([...registrosRef.current.values()]).map((r) => r.nome));
      setOpen(true);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [algumSujo]);

  // ── Fechar aba/recarregar: fallback nativo (prompt genérico do browser) ──
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!algumSujo()) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [algumSujo]);

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
    salvarTodos(sujos([...registrosRef.current.values()])).then(({ ok }) => {
      setSalvando(false);
      setOpen(false);
      pendingRef.current = null;
      // ok:false = alguma seção rejeitou (validação/erro já tratado inline pela
      // própria seção) — NÃO navega, mantém o dono na tela pra corrigir.
      if (ok && destino) irPara(destino);
    });
  }, [irPara]);

  return (
    <Ctx.Provider value={{ registrar, desregistrar }}>
      {children}
      <UnsavedChangesDialog
        open={open}
        loading={salvando}
        secoes={nomesSujos}
        onSalvarESair={onSalvarESair}
        onDescartar={onDescartar}
        onCancelar={onCancelar}
      />
    </Ctx.Provider>
  );
}

/**
 * Registra UMA seção salvável no guard global. `nome` aparece no diálogo
 * ("Você tem alterações não salvas em: Perguntas frequentes"). `dirty`/`salvar`
 * são lidos a cada render (sem exigir `useCallback` do chamador) — `salvar`
 * fica em ref só pra não recriar o registro a cada render por identidade de
 * função. Desmontar a seção (ex.: feature gated que sumiu) remove do
 * registro automaticamente via cleanup.
 */
export function useRegistrarNaoSalvo(
  nome: string,
  dirty: boolean,
  salvar: () => void | Promise<void>,
) {
  const ctx = useContext(Ctx);
  const id = useId();
  const salvarRef = useRef(salvar);
  salvarRef.current = salvar;

  if (!ctx) {
    throw new Error('useRegistrarNaoSalvo precisa de <UnsavedChangesProvider>');
  }

  useEffect(() => {
    ctx.registrar(id, { nome, dirty, salvar: () => salvarRef.current() });
    return () => ctx.desregistrar(id);
  });
}
