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
 */
export type NavGate = 'conexao' | 'estabelecimento' | 'atendimentos';

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
  | 'pause';

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
 * Ordem canônica dos itens. "Agenda" (2ª posição, uso diário) ganhou entrada
 * FIXA logo após "Início": é a tela de compromissos do dia, antes só alcançável
 * rolando a Home. Demais itens mantêm a mesma ordem relativa de antes.
 */
export const NAV_SPEC: NavItemSpec[] = [
  { href: '/inicio', label: 'Início', icon: 'home' },
  { href: '/agenda', label: 'Agenda', icon: 'calendar' },
  { href: '/conectar', label: 'Conectar', icon: 'whatsapp', gated: ['conexao'] },
  { href: '/equipe', label: 'Equipe', icon: 'users', gated: ['estabelecimento'] },
  // App de gestão (Fase 1): tela ÚNICA Billing (faturamento + comissão consolidados,
  // Previsão|Faturado). "Registrar" virou um botão DENTRO da tela Billing. Gated pela flag.
  { href: '/billing', label: 'Faturamento', icon: 'wallet', gated: ['atendimentos'] },
  { href: '/servicos', label: 'Serviços', icon: 'services' },
  { href: '/horarios', label: 'Horários', icon: 'clock' },
  { href: '/perfil', label: 'Meu negócio', icon: 'user' },
  { href: '/pausas', label: 'Pausas', icon: 'pause' },
  // Faturamento (o que o dono RECEBE) usa 'wallet'; Mensalidade (o que ele PAGA
  // pra gente) usa 'card' — ícones distintos pra não confundir os dois (item-3).
  { href: '/mensalidade', label: 'Mensalidade', icon: 'card' },
];

export interface NavGateContext {
  conexaoEnabled: boolean;
  isEstabelecimento: boolean;
  atendimentosEnabled: boolean;
}

/**
 * Filtra itens pelos gates (TODOS os gates de um item precisam passar). Genérico
 * pra servir tanto a spec pura (teste) quanto os NavItem com componente (shell) —
 * fonte ÚNICA da regra de gate, sem duplicar a lógica no hook.
 */
export function filterByGates<T extends { gated?: NavGate[] }>(
  items: T[],
  ctx: NavGateContext,
): T[] {
  const passes = (gate: NavGate): boolean => {
    if (gate === 'conexao') return ctx.conexaoEnabled;
    if (gate === 'estabelecimento') return ctx.isEstabelecimento;
    return ctx.atendimentosEnabled; // 'atendimentos'
  };
  return items.filter((item) => !item.gated || item.gated.every(passes));
}
