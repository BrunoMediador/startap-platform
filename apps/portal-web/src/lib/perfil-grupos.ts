/**
 * SCRUM-98 — Definição PURA dos 3 grupos da tela "Meu negócio" (perfil).
 *
 * Só metadados de organização visual: rótulo do chip da mini-nav, título/subtítulo
 * do cabeçalho do grupo, id de âncora e a ORDEM das seções dentro de cada grupo.
 * Zero React/DOM/fetch — é a fonte-da-verdade da REORGANIZAÇÃO (não muda nenhum
 * comportamento de seção). O wiring em `page.tsx` lê daqui pra montar a mini-nav e
 * os cabeçalhos; o teste (`perfil-grupos.test.ts`) trava a estrutura (completude do
 * mapa seção→grupo, unicidade das âncoras, ordem).
 *
 * IMPORTANTE: agrupar aqui NÃO altera o gating de nenhuma seção. Cada `*-section.tsx`
 * segue decidindo sozinha se renderiza (retorna null quando a feature está off). O
 * grupo se auto-oculta (fail-closed, via CSS `:has` no globals.css) quando TODAS as
 * suas seções estão ocultas — nunca sobra header de grupo vazio.
 */

export type GrupoKey = 'dados' | 'personalidade' | 'agenda';

/** Cada seção renderizada hoje na "Meu negócio", em chave estável. */
export type SecaoKey =
  // Grupo "Dados do negócio"
  | 'dados-negocio' // form principal (nome, contato, endereço, fuso, formas de pagamento)
  | 'planos' // Planos e assinaturas (texto livre)
  | 'recepcao' // WhatsApp da recepção (destino dos avisos ao dono)
  // Grupo "Personalidade do seu atendente"
  | 'monte-assistente' // Monte seu atendente (builder conversacional)
  | 'tom' // Tom da conversa (slider)
  | 'cartao' // Cartão de confirmação
  | 'faq' // Perguntas frequentes
  // Grupo "Agenda e lembretes"
  | 'agendamento' // Agendamento (toggle + link, modo atendente)
  | 'lembretes' // Lembretes automáticos
  | 'google-agenda'; // Conta Google / instalar app

export interface GrupoDef {
  readonly key: GrupoKey;
  /** id do `<section>` do grupo e alvo do chip da mini-nav (`#<anchorId>`). */
  readonly anchorId: string;
  /** Rótulo curto na mini-nav "pula pra". */
  readonly chip: string;
  /** Cabeçalho do grupo. */
  readonly titulo: string;
  /** Subtítulo curto — o que o dono configura ali. */
  readonly subtitulo: string;
  /** Seções do grupo, na ordem de render. */
  readonly secoes: readonly SecaoKey[];
}

export const PERFIL_GRUPOS: readonly GrupoDef[] = [
  {
    key: 'dados',
    anchorId: 'grupo-dados',
    chip: 'Dados',
    titulo: 'Dados do negócio',
    subtitulo: 'As informações que o assistente usa ao falar com seus clientes.',
    secoes: ['dados-negocio', 'planos', 'recepcao'],
  },
  {
    key: 'personalidade',
    anchorId: 'grupo-personalidade',
    chip: 'Personalidade',
    titulo: 'Personalidade do seu atendente',
    subtitulo: 'É aqui que você define como seu atendente conversa.',
    secoes: ['monte-assistente', 'tom', 'cartao', 'faq'],
  },
  {
    key: 'agenda',
    anchorId: 'grupo-agenda',
    chip: 'Agenda',
    titulo: 'Agenda e lembretes',
    subtitulo: 'Como o assistente marca horários e lembra seus clientes.',
    secoes: ['agendamento', 'lembretes', 'google-agenda'],
  },
] as const;

/** Todas as seções, na ordem em que aparecem na página (derivado dos grupos). */
export const TODAS_SECOES: readonly SecaoKey[] = PERFIL_GRUPOS.flatMap((g) => g.secoes);

/** Grupo dono de uma seção (ou undefined se a chave não pertence a nenhum grupo). */
export function grupoDaSecao(secao: SecaoKey): GrupoKey | undefined {
  return PERFIL_GRUPOS.find((g) => g.secoes.includes(secao))?.key;
}
