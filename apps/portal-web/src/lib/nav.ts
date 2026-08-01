/**
 * Config PURA da navegação do portal (SCRUM-94). Sem React/ícones aqui de
 * propósito: é a fonte da ORDEM, dos GATES e da CHAVE de ícone de cada item —
 * assim o "itens por formato" fica coberto no harness pure-fn do portal (sem
 * RTL/jsdom). O shell (nav-items.ts) mapeia `icon` -> componente e consome esta
 * spec; sidebar/bottom-nav nunca tocam este arquivo direto.
 *
 * Chave de ícone (não o componente) pra manter este módulo livre de JSX:
 *  - Agenda (compromissos)  -> 'calendar' (o calendário É a agenda do dia).
 *  - Horários (funcionamento) -> 'clock' (hora de abrir/fechar, NÃO calendário) —
 *    desambigua da Agenda, que antes dividiam o mesmo ícone de calendário.
 *
 * União de todos os gates usados pelo menu E pelas sub-abas (`@/lib/abas`).
 * `abas.ts` REUTILIZA este tipo e `filterByGates` (fonte única da regra de gate)
 * em vez de duplicar a função — ver `NavGateContext` abaixo pros gates novos.
 */
export type NavGate =
  | 'conexao'
  | 'estabelecimento'
  | 'atendimentos'
  // Gates abaixo são usados só por `@/lib/abas` (sub-abas de "Meu negócio" e
  // "Meu atendente"). São ORs JÁ RESOLVIDOS pelo chamador que monta o
  // `NavGateContext` — `filterByGates` só sabe fazer AND entre gates de um
  // item, então a disjunção (ex.: builder OU tom) vira UM booleano composto
  // aqui em vez de a função ganhar lógica de OR.
  | 'negocioAgenda' // modo_atendente || atendFromAgenda || temCredencialGoogle
  | 'atendentePersonalidade' // builder || tom
  | 'atendenteMensagens' // cartão disponível
  | 'sandbox';

export type NavIconKey =
  | 'home'
  | 'calendar'
  | 'whatsapp'
  | 'users'
  | 'wallet'
  | 'card'
  | 'services'
  | 'clock'
  | 'user'
  | 'pause'
  | 'sparkle';

export interface NavItemSpec {
  href: string;
  label: string;
  icon: NavIconKey;
  /** Item GATED (pode combinar mais de um — TODOS precisam passar):
   *  - 'conexao'         -> só aparece com GET /portal/conexao.enabled true.
   *  - 'estabelecimento' -> só quando product_type === 'estabelecimento'.
   *  - 'atendimentos'    -> só quando atendimentos_enabled (flag do backend). */
  gated?: NavGate[];
}

/**
 * Ordem canônica dos itens (8, pós-reorganização em telas — Bruno rejeitou o
 * padrão de 10 itens planos + chips que só rolam até âncora). "Agenda" (2ª
 * posição, uso diário) é entrada FIXA logo após "Início". "Serviços",
 * "Horários" e "Equipe" SAÍRAM daqui: agora são sub-abas de "Meu negócio"
 * (`/negocio/*`, ver `@/lib/abas`). A personalização da IA ganhou item PRÓPRIO
 * "Meu atendente" (`/atendente/*`, mesma spec de abas).
 */
export const NAV_SPEC: NavItemSpec[] = [
  { href: '/inicio', label: 'Início', icon: 'home' },
  { href: '/agenda', label: 'Agenda', icon: 'calendar' },
  { href: '/conectar', label: 'Conectar', icon: 'whatsapp', gated: ['conexao'] },
  // App de gestão (Fase 1): tela ÚNICA Billing (faturamento + comissão consolidados,
  // Previsão|Faturado). "Registrar" virou um botão DENTRO da tela Billing. Gated pela flag.
  { href: '/billing', label: 'Faturamento', icon: 'wallet', gated: ['atendimentos'] },
  // "Meu negócio" absorve Dados/Serviços/Horários/Equipe/Agenda como sub-abas.
  { href: '/negocio', label: 'Meu negócio', icon: 'user' },
  // "Meu atendente" absorve a personalização da IA (builder/tom/cartão/testar).
  { href: '/atendente', label: 'Meu atendente', icon: 'sparkle' },
  { href: '/pausas', label: 'Pausas', icon: 'pause' },
  // Faturamento (o que o dono RECEBE) usa 'wallet'; Mensalidade (o que ele PAGA
  // pra gente) usa 'card' — ícones distintos pra não confundir os dois (item-3).
  { href: '/mensalidade', label: 'Mensalidade', icon: 'card' },
];

export interface NavGateContext {
  conexaoEnabled: boolean;
  isEstabelecimento: boolean;
  atendimentosEnabled: boolean;
  /** Sub-abas de "Meu negócio"/"Meu atendente" (opcionais: o menu de topo nunca
   * usa esses gates hoje — só `@/lib/abas` os popula). Undefined = trata como
   * false (fail-closed), nunca faz a aba aparecer por engano. Cada campo já é
   * a DISJUNÇÃO resolvida pelo chamador (ver comentário em `NavGate`). */
  negocioAgenda?: boolean;
  atendentePersonalidade?: boolean;
  atendenteMensagens?: boolean;
  sandbox?: boolean;
}

/**
 * Filtra itens pelos gates (TODOS os gates de um item precisam passar). Genérico
 * pra servir tanto a spec pura (teste) quanto os NavItem com componente (shell) —
 * fonte ÚNICA da regra de gate, sem duplicar a lógica no hook. Reutilizada por
 * `@/lib/abas` (sub-abas de "Meu negócio"/"Meu atendente") — não duplicar.
 */
export function filterByGates<T extends { gated?: NavGate[] }>(
  items: T[],
  ctx: NavGateContext,
): T[] {
  const passes = (gate: NavGate): boolean => {
    switch (gate) {
      case 'conexao':
        return ctx.conexaoEnabled;
      case 'estabelecimento':
        return ctx.isEstabelecimento;
      case 'atendimentos':
        return ctx.atendimentosEnabled;
      case 'negocioAgenda':
        return ctx.negocioAgenda === true;
      case 'atendentePersonalidade':
        return ctx.atendentePersonalidade === true;
      case 'atendenteMensagens':
        return ctx.atendenteMensagens === true;
      case 'sandbox':
        return ctx.sandbox === true;
      default:
        return false; // fail-closed: gate desconhecido nunca libera
    }
  };
  return items.filter((item) => !item.gated || item.gated.every(passes));
}

/**
 * Itens do menu de topo que viraram TELAS com sub-abas (SCRUM-157): a rota do
 * item não é mais uma página folha, é um prefixo (`/negocio/dados`, `/negocio/
 * servicos`, `/atendente/personalidade`...). Sidebar/bottom-nav usavam
 * `pathname === href` pro estado ativo — com sub-rotas isso nunca mais acende
 * pra "Meu negócio"/"Meu atendente". Lista fechada (não any-href-with-slash):
 * itens comuns como '/agenda' continuam exigindo match EXATO.
 */
const NAV_ITEMS_COM_SUBROTAS: readonly string[] = ['/negocio', '/atendente'];

/**
 * Item ativo do menu: match EXATO pros itens comuns; match de PREFIXO
 * (`pathname === href || pathname.startsWith(href + '/')`) só pros itens de
 * `NAV_ITEMS_COM_SUBROTAS`. Único ponto de verdade — sidebar e bottom-nav
 * chamam esta função em vez de comparar `pathname === href` cada um por si.
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (NAV_ITEMS_COM_SUBROTAS.includes(href)) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  return pathname === href;
}
