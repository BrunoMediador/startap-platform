/**
 * SCRUM-157 — Spec PURA das sub-abas de "Meu negócio" (`/negocio/*`) e
 * "Meu atendente" (`/atendente/*`). Zero React/JSX/fetch, igual a `@/lib/nav`:
 * é a fonte da ORDEM, do HREF e dos GATES de cada aba, testável no harness
 * pure-fn do portal (sem RTL/jsdom).
 *
 * Por que isto existe: o Bruno rejeitou o padrão anterior (10 itens de menu
 * planos + "Meu negócio" empilhando 10 seções numa página só com chips que
 * só ROLAM até âncora, extinta `perfil-grupos.ts`). A troca é por TELAS
 * separadas de verdade, com URL própria — Serviços/Horários/Equipe saem do
 * menu e viram sub-abas de "Meu negócio"; a personalização da IA vira o item
 * próprio "Meu atendente".
 *
 * Gate: reaproveita `filterByGates`/`NavGate`/`NavGateContext` de `@/lib/nav`
 * em vez de duplicar a função — fonte ÚNICA da regra "todos os gates de um
 * item precisam passar". As disjunções (OR) das abas — ex.: "Personalidade"
 * aparece com builder OU tom — são resolvidas pelo CHAMADOR ao montar o
 * `NavGateContext` (campos já compostos `negocioAgenda`/`atendentePersonalidade`/
 * `atendenteMensagens`), não pela função de filtro (que só sabe fazer AND).
 */
import { type NavGateContext, type NavItemSpec, filterByGates } from './nav';

/**
 * Chave de cada sub-aba. Reaproveita o nome de domínio de `SecaoKey` (abaixo)
 * onde a aba corresponde 1:1 a uma seção existente; adiciona 'agenda' (a
 * antiga seção 'agendamento'+'lembretes'+'google-agenda' viram a aba "Agenda"
 * de "Meu negócio") e as 3 abas novas de "Meu atendente".
 */
export type AbaKey =
  // Sub-abas de "Meu negócio" (`/negocio/*`)
  | 'negocio-dados'
  | 'negocio-servicos'
  | 'negocio-horarios'
  | 'negocio-equipe'
  | 'negocio-agenda'
  // Sub-abas de "Meu atendente" (`/atendente/*`)
  | 'atendente-personalidade'
  | 'atendente-mensagens'
  | 'atendente-testar';

export interface AbaSpec extends NavItemSpec {
  href: string;
  label: string;
  key: AbaKey;
}

/**
 * Cada seção renderizada hoje nas telas `/negocio/dados` e `/atendente/*`, em
 * chave estável. Herdado da extinta `perfil-grupos.ts` (mega-página "Meu
 * negócio" com mini-nav de âncoras, SCRUM-98) — a divisão em GRUPOS morreu com
 * ela, mas o mapa seção->ABA (agora uma tela/rota de verdade) continua vivo
 * aqui, fonte única.
 */
export type SecaoKey =
  // "Meu negócio" / Dados
  | 'dados-negocio' // form principal (nome, contato, endereço, fuso, formas de pagamento)
  | 'planos' // Planos e assinaturas (texto livre)
  | 'recepcao' // WhatsApp da recepção (destino dos avisos ao dono)
  // "Meu atendente" / Personalidade
  | 'monte-assistente' // Monte seu atendente (builder conversacional)
  | 'tom' // Tom da conversa (slider)
  | 'cartao' // Cartão de confirmação
  // "Meu negócio" / Agenda
  | 'agendamento' // Agendamento (toggle + link, modo atendente)
  | 'lembretes' // Lembretes automáticos
  | 'google-agenda'; // Conta Google / instalar app

/** Todas as seções, na ordem em que apareciam na extinta mega-página (SCRUM-98). */
export const TODAS_SECOES: readonly SecaoKey[] = [
  'dados-negocio',
  'planos',
  'recepcao',
  'monte-assistente',
  'tom',
  'cartao',
  'agendamento',
  'lembretes',
  'google-agenda',
];

/**
 * Sub-abas de "Meu negócio", na ordem de exibição.
 *  - 'negocio-dados': dados-negocio + planos + recepção (sempre visível, sem gate).
 *  - 'negocio-servicos' / 'negocio-horarios': Serviços/Horários que saíram do
 *    menu de topo — sempre visíveis (nenhum gate as escondia lá).
 *  - 'negocio-equipe': só estabelecimento (era gate do item "Equipe" no menu).
 *  - 'negocio-agenda': agendamento + lembretes + google-agenda, unificados —
 *    aparece com modo_atendente OU atendFromAgenda OU credencial Google já
 *    configurada (qualquer um dos 3 já significa "tem algo de agenda pra ver").
 */
export const NEGOCIO_ABAS: readonly AbaSpec[] = [
  { key: 'negocio-dados', href: '/negocio/dados', label: 'Dados', icon: 'user' },
  { key: 'negocio-servicos', href: '/negocio/servicos', label: 'Serviços', icon: 'services' },
  { key: 'negocio-horarios', href: '/negocio/horarios', label: 'Horários', icon: 'clock' },
  {
    key: 'negocio-equipe',
    href: '/negocio/equipe',
    label: 'Equipe',
    icon: 'users',
    gated: ['estabelecimento'],
  },
  {
    key: 'negocio-agenda',
    href: '/negocio/agenda',
    label: 'Agenda',
    icon: 'calendar',
    gated: ['negocioAgenda'],
  },
] as const;

/**
 * Sub-abas de "Meu atendente", na ordem de exibição.
 *  - 'atendente-personalidade': builder conversacional + tom — aparece se
 *    QUALQUER um dos dois estiver disponível.
 *  - 'atendente-mensagens': o cartão de confirmação — aparece se disponível. A aba
 *    se CHAMA "Cartão de confirmação" (rename 31/07) porque passa a ter só isso: a
 *    antiga "Perguntas frequentes" saiu daqui (#554), com o conteúdo passando a viver
 *    no prompt via IA — formulário próprio removido, backend/coluna intocados.
 *    ⚠️ O `key`/`href` continuam 'atendente-mensagens'/'/atendente/mensagens' de
 *    propósito: renomear a ROTA quebraria URL salva e link interno — foi o estrago
 *    que a #547 teve de limpar. Só o RÓTULO mudou.
 *  - 'atendente-testar': sandbox de conversa (SCRUM-101), só com a flag ON.
 */
export const ATENDENTE_ABAS: readonly AbaSpec[] = [
  {
    key: 'atendente-personalidade',
    href: '/atendente/personalidade',
    label: 'Personalidade',
    icon: 'sparkle',
    gated: ['atendentePersonalidade'],
  },
  {
    key: 'atendente-mensagens',
    href: '/atendente/mensagens',
    label: 'Cartão de confirmação',
    icon: 'card',
    gated: ['atendenteMensagens'],
  },
  {
    key: 'atendente-testar',
    href: '/atendente/testar',
    label: 'Testar',
    icon: 'whatsapp',
    gated: ['sandbox'],
  },
] as const;

/** Todas as abas das duas telas, na ordem em que aparecem (negócio antes de atendente). */
export const TODAS_ABAS: readonly AbaSpec[] = [...NEGOCIO_ABAS, ...ATENDENTE_ABAS];

/**
 * Mapa seção (`SecaoKey`, acima) -> aba nova. Substituto do extinto
 * `grupoDaSecao` (perfil-grupos.ts) para o mundo de telas separadas: toda
 * seção que a extinta mega-página "Meu negócio" renderizava hoje tem que
 * resolver pra UMA aba — o teste (`abas.test.ts`) trava a completude deste
 * mapa contra `SecaoKey`.
 */
const SECAO_PARA_ABA: Record<SecaoKey, AbaKey> = {
  // Grupo "Dados do negócio" -> aba "Dados"
  'dados-negocio': 'negocio-dados',
  planos: 'negocio-dados',
  recepcao: 'negocio-dados',
  // Grupo "Personalidade do seu atendente" -> "Meu atendente"
  'monte-assistente': 'atendente-personalidade',
  tom: 'atendente-personalidade',
  cartao: 'atendente-mensagens',
  // Grupo "Agenda e lembretes" -> aba "Agenda" de "Meu negócio"
  agendamento: 'negocio-agenda',
  lembretes: 'negocio-agenda',
  'google-agenda': 'negocio-agenda',
};

/** Aba dona de uma seção herdada (ou undefined se a chave não mapeia pra nenhuma aba). */
export function abaDaSecao(secao: SecaoKey): AbaKey | undefined {
  return SECAO_PARA_ABA[secao];
}

/**
 * Filtra as abas de "Meu negócio" pelos gates do contexto. Fina wrapper sobre
 * `filterByGates` (mesma função do menu de topo) — sem lógica de gate própria.
 */
export function filterNegocioAbas(ctx: NavGateContext): AbaSpec[] {
  return filterByGates(NEGOCIO_ABAS as AbaSpec[], ctx);
}

/** Filtra as abas de "Meu atendente" pelos gates do contexto (ver `filterNegocioAbas`). */
export function filterAtendenteAbas(ctx: NavGateContext): AbaSpec[] {
  return filterByGates(ATENDENTE_ABAS as AbaSpec[], ctx);
}
