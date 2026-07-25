// area-emojis — emojis do cartão de confirmação por ÁREA/vertical do clone.
//
// PROBLEMA (Bruno, cartão da Bruna/salão mostrava 💈 de barbearia): o cartão de
// confirmação nasceu hardcoded com os emojis de barbearia (💈 marca, ✂️ serviço).
// Todo clone — barbearia, salão, manicure, estética — herdava 💈/✂️. Aqui o emoji
// passa a seguir flow_clones.area (migration 051).
//
// COMO ISTO APLICA A CLONES JÁ EXISTENTES (incl. Bruna) SEM RE-RENDERIZAR O PROMPT:
//   O cartão individual vive no bot_prompt persistido de cada clone (texto com
//   💈/✂️). Não dá pra trocar isso "em runtime" mexendo no template. Em vez disso,
//   o bot INJETA EM RUNTIME um bloco curto [CARTAO - EMOJIS DA AREA] que MANDA o
//   modelo usar os emojis certos — exatamente o mesmo mecanismo que o #325 usa pro
//   cartão de estabelecimento. Assim a Bruna (salão) passa a ver 💅/💇 sem que
//   ninguém re-renderize o prompt dela.
//
// ⚠️ RETROCOMPAT PAGANTES (Cirilo + Samuel = area='barbearia'):
//   barbearia É o conjunto que o cartão já tem hoje. Para barbearia, o builder
//   individual devolve '' (NENHUM bloco injetado) → o cartão deles segue
//   BYTE-A-BYTE o do bot_prompt atual (💈/✂️), zero mudança visível. Só áreas
//   não-barbearia recebem o bloco de override. No estabelecimento, o builder
//   parametriza o bloco runtime do #325 usando barbearia = os MESMOS literais de
//   hoje (📅 🕐 ✂️ 💰 👤), então barbearia continua idêntico lá também.

/** Conjunto de emojis de um cartão de confirmação. 1 conjunto por área. */
export interface CardEmojis {
  /** Emoji "marca" do negócio — vai no cabeçalho do cartão (💈 na barbearia). */
  marca: string;
  /** Dia do agendamento. */
  dia: string;
  /** Horário. */
  horario: string;
  /** Serviço (✂️ na barbearia). */
  servico: string;
  /** Valor. */
  valor: string;
  /** Confirmação (✅). */
  confirma: string;
  /** Profissional (só usado no cartão de estabelecimento). */
  profissional: string;
}

// ── Conjuntos por área ────────────────────────────────────────────────────────
// barbearia = EXATAMENTE os emojis de hoje (cartão individual no bot_prompt +
// cartão de estabelecimento do #325). NÃO MUDAR sem regenerar a regressão dos
// pagantes — qualquer alteração aqui muda o cartão do Cirilo/Samuel.
const BARBEARIA: CardEmojis = {
  marca: '💈',
  dia: '📅',
  horario: '⏰',
  servico: '✂️',
  valor: '💰',
  confirma: '✅',
  profissional: '👤',
};

// Salão / cabeleireiro: tesoura continua fazendo sentido pra corte, mas a marca
// vira 💇 (cabelo) em vez do poste de barbearia.
const SALAO: CardEmojis = {
  marca: '💇',
  dia: '📅',
  horario: '⏰',
  servico: '✂️',
  valor: '💰',
  confirma: '✅',
  profissional: '👤',
};

// Manicure: unha em tudo que é "marca/serviço".
const MANICURE: CardEmojis = {
  marca: '💅',
  dia: '📅',
  horario: '⏰',
  servico: '💅',
  valor: '💰',
  confirma: '✅',
  profissional: '👤',
};

// Estética: cuidado/spa (💆) na marca, ✨ no serviço.
const ESTETICA: CardEmojis = {
  marca: '💆',
  dia: '📅',
  horario: '⏰',
  servico: '✨',
  valor: '💰',
  confirma: '✅',
  profissional: '👤',
};

// Genérico ("outro" / área desconhecida / NULL): nada de tesoura ou poste —
// agenda neutra. Cobre clones pré-051 (area NULL) e a vertical "outro".
const GENERICO: CardEmojis = {
  marca: '📅',
  dia: '📅',
  horario: '⏰',
  servico: '📋',
  valor: '💰',
  confirma: '✅',
  profissional: '👤',
};

/**
 * Mapa área→emojis. Aliases tolerantes (salao/salão/cabeleireiro caem no mesmo
 * conjunto) porque a taxonomia é validada no app, não no banco (migration 051), e
 * pode chegar com acento/variação. Qualquer chave fora daqui → GENERICO.
 */
const AREA_EMOJI_MAP: Record<string, CardEmojis> = {
  barbearia: BARBEARIA,
  salao: SALAO,
  salão: SALAO,
  cabeleireiro: SALAO,
  cabelereiro: SALAO, // grafia comum errada — não punir o cliente
  manicure: MANICURE,
  manicures: MANICURE,
  nail: MANICURE,
  estetica: ESTETICA,
  estética: ESTETICA,
  spa: ESTETICA,
  outro: GENERICO,
  generico: GENERICO,
  genérico: GENERICO,
};

/**
 * Resolve o conjunto de emojis a partir da área crua (já em lowercase trimado
 * pelo reader). `null`/desconhecido → GENERICO (fallback seguro).
 */
export function emojisForArea(area: string | null | undefined): CardEmojis {
  if (!area) return GENERICO;
  return AREA_EMOJI_MAP[area] ?? GENERICO;
}

/** True se a área é barbearia (o caminho que NÃO recebe override no individual). */
export function isBarbearia(area: string | null | undefined): boolean {
  return area === 'barbearia';
}

/**
 * Bloco runtime [CARTAO - EMOJIS DA AREA] pro caminho INDIVIDUAL.
 *
 * RETORNA '' QUANDO área é barbearia (ou null/desconhecida): nesse caso o cartão
 * do bot_prompt (já com 💈/✂️ na barbearia, ou neutro nos antigos) NÃO é tocado e
 * o systemPrompt fica byte-a-byte o de hoje. PROTEGE Cirilo/Samuel.
 *
 * Para áreas não-barbearia conhecidas (salão/manicure/estética) injeta uma
 * instrução curta que MANDA o modelo trocar os emojis do cartão pelos da área.
 * Não reescreve a estrutura do cartão (DIA/HORARIO/SERVICO/VALOR) — só os ícones.
 *
 * PROMPT_CUSTOM (SCRUM-84): quando o dono estilizou a persona à mão (flow_clones
 * .prompt_custom=true, migration 070), a PERSONA É A AUTORIDADE FINAL do cartão —
 * NÃO injetamos override nenhum, senão sobrescrevemos os emojis que ele escolheu de
 * propósito (caso Ingrid: 🌻 no cabeçalho virava 📅 do genérico). O override existe
 * só pra clones de TEMPLATE, que herdaram 💈/✂️ da matriz sem querer. Default false
 * = comportamento byte-a-byte de antes (protege Cirilo/Samuel e chamadas legadas).
 */
export function buildCartaoEmojiOverrideBlock(
  area: string | null | undefined,
  promptCustom = false,
): string {
  // Persona custom manda no cartão — não sobrepõe emoji nenhum (SCRUM-84).
  if (promptCustom) return '';
  // barbearia → conjunto atual já está no prompt; null/desconhecido → não arrisca
  // mudar o visual de um clone antigo. Em ambos: nenhum bloco.
  if (!area || area === 'barbearia') return '';
  // Aqui a área é uma conhecida não-barbearia OU "outro" (mapeia pra genérico).
  // Em ambos os casos vale injetar o override — inclusive o genérico, pra tirar o
  // 💈 do cartão de um clone de área "outro".
  const e = emojisForArea(area);
  return [
    '[CARTAO DE CONFIRMACAO - EMOJIS DESTE NEGOCIO]',
    'Este negocio NAO e uma barbearia. Ao montar o CARTAO DE CONFIRMACAO, use estes',
    'emojis no lugar dos que aparecem no modelo acima (NAO use 💈 nem trate como barbearia):',
    `${e.marca} no cabecalho/marca do cartao`,
    `${e.dia} para o DIA`,
    `${e.horario} para o HORARIO`,
    `${e.servico} para o SERVICO`,
    `${e.valor} para o VALOR`,
    `${e.confirma} para a confirmacao (SIM)`,
    'Mantenha o resto do cartao e o tom da persona exatamente iguais.',
  ].join('\n');
}

/**
 * Bloco runtime [CARTAO DE CONFIRMACAO - ESTABELECIMENTO] parametrizado por área.
 *
 * Substitui o bloco hardcoded do #325. Para barbearia devolve EXATAMENTE o texto
 * que o #325 produz hoje (📅 🕐 ✂️ 💰 👤) — regressão garantida nos testes. Para
 * outras áreas, troca os ícones de marca/serviço pelos da área, mantendo a regra
 * do profissional (👤) e o fluxo.
 *
 * Nota: no cartão de estabelecimento o HORARIO usa 🕐 (igual ao #325 original),
 * não ⏰ — preservamos o literal de hoje pra barbearia ficar byte-a-byte.
 *
 * DUAS COISAS SEPARADAS (SCRUM-85, espelha o SCRUM-84/#458 do individual):
 *   (1) REGRA ESTRUTURAL — cartão obrigatório completo + esperar SIM antes de
 *       inserir_agendamento + PROFISSIONAL pelo nome + valer a CADA agendamento
 *       (inclusive back-to-back). É crítica pra correção do agendamento e vai
 *       SEMPRE, inegociável, INDEPENDENTE de persona. Diferente do individual, este
 *       bloco NÃO pode ser pulado — ele carrega essa regra.
 *   (2) ESTILO/EMOJIS — só o "Formato do cartão" com ícones por área. Com
 *       prompt_custom=false o bloco sai BYTE-A-BYTE o de hoje (emojis da área;
 *       protege o barber_dragon). Com prompt_custom=true a persona é a autoridade
 *       do estilo: mantemos os MESMOS campos obrigatórios, mas SEM impor emoji de
 *       área — os ícones/tom ficam por conta da persona custom.
 * Default false = comportamento byte-a-byte de antes (protege chamadas legadas).
 */
export function buildCartaoEstabelecimentoBlock(
  area: string | null | undefined,
  promptCustom = false,
): string {
  // Regra ESTRUTURAL — SEMPRE injetada, inegociável, independe de persona (SCRUM-85).
  // Estas 10 linhas são idênticas nos dois ramos: mudam só as linhas de "Formato".
  const estrutura = [
    '[CARTAO DE CONFIRMACAO - ESTABELECIMENTO — REGRA CRITICA, VIOLACAO = ERRO GRAVE]',
    'Antes de CADA agendamento você DEVE, OBRIGATORIAMENTE e SEM EXCEÇÃO:',
    '1. Mostrar o CARTAO DE CONFIRMACAO completo (todos os campos abaixo).',
    '2. Esperar o cliente responder SIM (ou equivalente claro: "isso", "pode marcar").',
    '3. SÓ DEPOIS do SIM, chamar inserir_agendamento.',
    'Isso vale para TODO agendamento, INCLUSIVE o 2º, 3º… na MESMA conversa (back-to-back):',
    'cada novo horário recomeça o fluxo — mostra o cartão e pede SIM de novo. NUNCA agende',
    'direto, NUNCA pule o cartão, NUNCA assuma o SIM porque o cliente já confirmou antes.',
    'Neste estabelecimento o cliente escolhe o profissional, então o cartão DEVE incluir o',
    'nome do profissional escolhido (o nome que está em [PROFISSIONAIS], não o id curto C1/C2).',
  ];

  // (2b) PROMPT_CUSTOM (SCRUM-85): persona é a autoridade do ESTILO. Mantém TODOS os
  // campos obrigatórios (PROFISSIONAL/DIA/HORARIO/SERVICO/VALOR) e a exigência do SIM,
  // mas NÃO impõe os emojis da área — a persona custom dita os ícones/tom.
  if (promptCustom) {
    return [
      ...estrutura,
      'Formato do cartão (mantenha estes campos; use os emojis e o estilo da SUA persona):',
      'PROFISSIONAL: <nome do profissional escolhido>',
      'DIA: <dia> / HORARIO: <horario> / SERVICO: <servico> / VALOR: <valor>',
      'Termine o cartão pedindo: "Responda SIM para confirmar." Mantenha o tom da persona.',
    ].join('\n');
  }

  // (2a) prompt_custom=false → BYTE-A-BYTE o bloco de hoje (protege barber_dragon).
  // Horário no estabelecimento herda do #325 (🕐). Barbearia/genérico expõem 🕐;
  // pra manter o #325 idêntico na barbearia, forçamos 🕐 aqui independentemente do
  // CardEmojis.horario (que é ⏰ no individual). As demais posições seguem a área.
  const e = emojisForArea(area);
  const horarioEstab = '🕐';
  return [
    ...estrutura,
    'Formato do cartão:',
    `${e.profissional} PROFISSIONAL: <nome do profissional escolhido>`,
    `${e.dia} DIA: <dia> / ${horarioEstab} HORARIO: <horario> / ${e.servico} SERVICO: <servico> / ${e.valor} VALOR: <valor>`,
    'Termine o cartão pedindo: "Responda SIM para confirmar." Mantenha o tom da persona.',
  ].join('\n');
}
