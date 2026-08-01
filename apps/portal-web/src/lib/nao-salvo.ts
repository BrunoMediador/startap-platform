/**
 * Núcleo PURO (zero React) do guard global de "alterações não salvas"
 * (SCRUM-158). Extraído de `use-avisar-nao-salvo.ts` pra virar testável em
 * Node puro — o portal não tem jsdom/testing-library, só `vitest run` sobre
 * `src/lib/*.ts`. O provider (`components/shell/unsaved-changes-context.tsx`)
 * é quem lê o DOM e chama estas funções com dados já simples.
 *
 * Três funções:
 * - `deveInterceptarClique`: decide se um clique em `<a>` deve ser bloqueado
 *   (mesma regra do hook original — link interno, sem modificador, sem
 *   target/download, destino diferente do atual).
 * - `sujos`/`salvarTodos`: registry (nome -> dirty/salvar) vira lista de
 *   sujas e dispara os saves em sequência.
 * - `descreveSecoesSujas`: texto pro diálogo listar quais seções serão
 *   salvas ("Perguntas frequentes", "Perguntas frequentes e Cartão de
 *   confirmação", "A, B e C").
 */

/** Subconjunto de atributos do `<a>` que a decisão precisa — sem depender de MouseEvent/DOM. */
export interface CliqueAncora {
  href: string | null;
  download: boolean;
  target: string | null;
}

/** Subconjunto de modificadores do clique/tecla que cancelam a interceptação. */
export interface Modificadores {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * @param ancora - dados do `<a>` clicado (ou `null` se o clique não foi em link).
 * @param origem - origin da página atual (`window.location.origin`).
 * @param pathname - pathname atual (`window.location.pathname`) — mesmo destino não é "sair".
 * @param mods - modificadores do clique (abrir em nova aba/janela passa direto).
 * @returns o destino (`pathname+search+hash`) a interceptar, ou `null` se deve deixar navegar.
 */
export function deveInterceptarClique(
  ancora: CliqueAncora | null,
  origem: string,
  pathname: string,
  mods: Modificadores,
): string | null {
  if (
    mods.defaultPrevented ||
    mods.button !== 0 ||
    mods.metaKey ||
    mods.ctrlKey ||
    mods.shiftKey ||
    mods.altKey
  )
    return null;
  if (!ancora) return null;

  const { href, download, target } = ancora;
  if (!href || href.startsWith('#')) return null;
  if (download || target === '_blank') return null;

  let url: URL;
  try {
    url = new URL(href, origem);
  } catch {
    return null;
  }
  if (url.origin !== origem) return null;
  if (url.pathname === pathname) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}

/** Um registro do guard: uma seção salvável (form) com seu estado dirty atual. */
export interface RegistroNaoSalvo {
  nome: string;
  dirty: boolean;
  /** Deve rejeitar em erro de validação/save (o guard cancela a navegação) e resolver em sucesso. */
  salvar: () => void | Promise<void>;
}

/** Filtra só os registros com `dirty === true`, preservando a ordem de registro. */
export function sujos(registros: RegistroNaoSalvo[]): RegistroNaoSalvo[] {
  return registros.filter((r) => r.dirty);
}

/**
 * Salva todas as seções sujas, em SEQUÊNCIA (não paralelo — evita duas
 * mutations otimistas concorrentes no mesmo instante). Para na primeira que
 * rejeitar: `ok: false` (o chamador NÃO navega, mantém o dono na tela — mesma
 * semântica de erro do hook original).
 */
export async function salvarTodos(registros: RegistroNaoSalvo[]): Promise<{ ok: boolean }> {
  for (const registro of registros) {
    try {
      await registro.salvar();
    } catch {
      return { ok: false };
    }
  }
  return { ok: true };
}

/** Texto pro diálogo: "Nome" | "A e B" | "A, B e C". Lista vazia -> "". */
export function descreveSecoesSujas(nomes: string[]): string {
  if (nomes.length === 0) return '';
  if (nomes.length === 1) return nomes[0];
  if (nomes.length === 2) return `${nomes[0]} e ${nomes[1]}`;
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}
