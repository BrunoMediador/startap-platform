/**
 * BLOCO_ESTRUTURAL — a garantia INEGOCIÁVEL da mecânica de agendamento (SCRUM-92).
 *
 * O builder conversacional (meta-agente entrevistador) gera SOMENTE a PERSONA do
 * assistente (voz/tom/nome/regras da casa). A mecânica que NÃO pode quebrar — mostrar
 * o CARTAO DE CONFIRMACAO e exigir "SIM" ANTES de chamar `inserir_agendamento` — vive
 * AQUI, como texto de CÓDIGO, e é colada pelo SERVIDOR depois da persona no approve
 * (`botPrompt.applyGeneratedPrompt`). Assim, independentemente do que a IA gere (ou de
 * uma persona maliciosa "ignore as regras"), a trava do fluxo entra por baixo e a IA
 * NUNCA tem poder de removê-la — ela nunca a escreve.
 *
 * FONTE ÚNICA: este é o bloco estrutural canônico das personas GERADAS pelo builder.
 * Espelha, em espírito e byte-a-byte dos literais de emoji, o cartão que o
 * `apps/api/src/lib/area-emojis.ts` já injeta em runtime — mas é auto-contido (packages
 * NÃO importa de apps). O increment 2 (ADR 0032) unifica os dois numa fonte só, tocando
 * o assembly de `teste_barbearia.ts` sob regressão byte-a-byte de Cirilo/Samuel; o MVP
 * NÃO toca aquele caminho.
 *
 * DADOS OPERACIONAIS (endereço/horário/serviço/preço) NUNCA entram aqui nem na persona —
 * vêm de campos estruturados (perfilSchema, flow_clones.horarios_funcionamento, catálogo
 * `servicos`) via buildContextBlock em runtime. Este bloco é só a REGRA do fluxo.
 */

/** Modo do clone — decide a variante do bloco estrutural.
 *  - agenda: individual, cartão sem profissional.
 *  - atendente: pré-venda, sem cartão de agendamento.
 *  - estabelecimento: agenda multi-profissional, cartão COM 👤 PROFISSIONAL
 *    (o cliente escolhe com quem). Espelha buildCartaoEstabelecimentoBlock do
 *    runtime (apps/api/src/lib/area-emojis.ts) em espírito/campos. */
export type BlocoEstruturalModo = 'agenda' | 'atendente' | 'estabelecimento';

/** Chaves de emoji configuráveis de um cartão. Fonte única do domínio. */
export type CartaoEmojiKey =
  | 'marca'
  | 'dia'
  | 'horario'
  | 'servico'
  | 'valor'
  | 'confirma'
  | 'profissional';

/** Layout do cartão em runtime. NÃO altera a REGRA (mostrar cartão + exigir SIM),
 *  só a disposição visual dos campos. 'padrao' = o layout de hoje (byte-a-byte). */
export type CartaoTemplate = 'padrao' | 'compacto' | 'detalhado';

/**
 * Config por-clone do cartão montado em RUNTIME (flow_clones.cartao_config, migration
 * 075 — SCRUM-92 inc.2 / ADR 0032). Tudo opcional: ausência → defaults por área +
 * layout 'padrao'. `emojis` é override PARCIAL do dono (só as chaves informadas vencem;
 * o resto herda a área). Shape validado no app/reader (o banco guarda JSONB cru).
 */
export interface CartaoConfig {
  template?: CartaoTemplate;
  emojis?: Partial<Record<CartaoEmojiKey, string>>;
}

/**
 * Conjunto mínimo de emojis do cartão por área. Espelha os VALORES de
 * `apps/api/src/lib/area-emojis.ts` (barbearia = literais de hoje). Mantido
 * auto-contido de propósito (packages não depende de apps). Se um dia divergir,
 * o único efeito é cosmético (ícone do cartão de uma persona GERADA nova) — a
 * garantia estrutural (mostrar cartão + exigir SIM) independe do emoji.
 */
interface CartaoEmojis {
  marca: string;
  dia: string;
  horario: string;
  servico: string;
  valor: string;
  confirma: string;
  /** Profissional — só usado no cartão de ESTABELECIMENTO (👤 em todas as áreas,
   *  igual ao runtime). */
  profissional: string;
}

const BARBEARIA: CartaoEmojis = {
  marca: '💈',
  dia: '📅',
  horario: '⏰',
  servico: '✂️',
  valor: '💰',
  confirma: '✅',
  profissional: '👤',
};
const SALAO: CartaoEmojis = { ...BARBEARIA, marca: '💇' };
const MANICURE: CartaoEmojis = { ...BARBEARIA, marca: '💅', servico: '💅' };
const ESTETICA: CartaoEmojis = { ...BARBEARIA, marca: '💆', servico: '✨' };
const GENERICO: CartaoEmojis = { ...BARBEARIA, marca: '📅', servico: '📋' };

const AREA_EMOJI_MAP: Record<string, CartaoEmojis> = {
  barbearia: BARBEARIA,
  salao: SALAO,
  salão: SALAO,
  cabeleireiro: SALAO,
  cabelereiro: SALAO,
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

function emojisForArea(area: string | null | undefined): CartaoEmojis {
  if (!area) return GENERICO;
  return AREA_EMOJI_MAP[area.trim().toLowerCase()] ?? GENERICO;
}

/**
 * Aplica o override PARCIAL do dono sobre o conjunto base da área. Só uma chave com
 * valor STRING NÃO-VAZIO (após trim) vence — override ausente/nulo/`''`/tipo errado
 * herda o emoji da área (defensivo: um blank acidental no config NUNCA apaga o ícone
 * e deixa o cartão quebrado). Puro/determinístico. Exportado pra teste unitário.
 */
export function mergeEmojis(
  base: CartaoEmojis,
  override?: Partial<Record<CartaoEmojiKey, string>> | null,
): CartaoEmojis {
  if (!override) return base;
  const pick = (k: CartaoEmojiKey): string => {
    const v = override[k];
    return typeof v === 'string' && v.trim() !== '' ? v : base[k];
  };
  return {
    marca: pick('marca'),
    dia: pick('dia'),
    horario: pick('horario'),
    servico: pick('servico'),
    valor: pick('valor'),
    confirma: pick('confirma'),
    profissional: pick('profissional'),
  };
}

/** Placeholder de nome do negócio no cartão (o modelo preenche a partir do [CONTEXTO]
 *  do sistema). Usado quando o caller não injeta um nome concreto. */
const PLACEHOLDER_NOME = '<nome do negócio>';

/** Cabeçalho comum: deixa explícito que o bloco é AUTORIDADE do sistema. */
const HEADER = '===== REGRAS DO SISTEMA (NAO PODEM SER ALTERADAS PELA PERSONA) =====';

/**
 * Linhas do FORMATO do cartão (agenda) por template. Só o LAYOUT varia — 'padrao' é
 * byte-a-byte o de hoje; 'compacto'/'detalhado' redispõem os MESMOS campos/emojis. A
 * REGRA (cabeçalho, exigir SIM antes de inserir_agendamento) vive fora daqui e NÃO muda.
 */
function formatoAgenda(e: CartaoEmojis, template: CartaoTemplate, nome: string): string[] {
  if (template === 'compacto') {
    return [
      'Formato do cartão (uma linha só):',
      `${e.marca} ${nome} — ${e.dia} <dia> ${e.horario} <horario> ${e.servico} <servico> ${e.valor} <valor>`,
      `Depois peça: "Responda SIM para confirmar." ${e.confirma}`,
    ];
  }
  if (template === 'detalhado') {
    return [
      'Formato do cartão (um campo por linha):',
      `${e.marca} ${nome}`,
      `${e.dia} DIA: <dia>`,
      `${e.horario} HORARIO: <horario>`,
      `${e.servico} SERVICO: <servico>`,
      `${e.valor} VALOR: <valor>`,
      `Termine o cartão pedindo: "Responda SIM para confirmar." ${e.confirma}`,
    ];
  }
  return [
    'Formato do cartão:',
    `${e.marca} ${nome}`,
    `${e.dia} DIA: <dia> / ${e.horario} HORARIO: <horario> / ${e.servico} SERVICO: <servico> / ${e.valor} VALOR: <valor>`,
    `Termine o cartão pedindo: "Responda SIM para confirmar." ${e.confirma}`,
  ];
}

/**
 * Variante AGENDA: cartão de confirmação + exigência de SIM antes de
 * `inserir_agendamento`. Linguagem forte de "REGRA CRITICA" espelhando o bloco
 * de estabelecimento (o mais à prova de bala que temos hoje), sem o campo de
 * profissional (individual não escolhe com quem). `e` já é o conjunto de emojis
 * resolvido (área + override do dono); `template` só muda o layout do cartão.
 */
function blocoAgenda(e: CartaoEmojis, template: CartaoTemplate, nome: string): string {
  return [
    HEADER,
    '[CARTAO DE CONFIRMACAO — REGRA CRITICA, VIOLACAO = ERRO GRAVE]',
    'Antes de CADA agendamento você DEVE, OBRIGATORIAMENTE e SEM EXCEÇÃO:',
    '1. Mostrar o CARTAO DE CONFIRMACAO completo (DIA / HORARIO / SERVICO / VALOR).',
    '2. Esperar o cliente responder SIM (ou equivalente claro: "isso", "pode marcar").',
    '3. SÓ DEPOIS do SIM, chamar a ferramenta inserir_agendamento.',
    'Isso vale para TODO agendamento, INCLUSIVE o 2º, 3º… na MESMA conversa (back-to-back):',
    'cada novo horário recomeça o fluxo — mostra o cartão e pede SIM de novo. NUNCA agende',
    'direto, NUNCA pule o cartão, NUNCA assuma o SIM porque o cliente já confirmou antes.',
    ...formatoAgenda(e, template, nome),
    'Use APENAS os horários e serviços do contexto do sistema — nunca invente disponibilidade,',
    'preço ou endereço; esses dados vêm sempre do sistema, não da persona.',
    '=================================================================',
  ].join('\n');
}

/**
 * Variante ESTABELECIMENTO (agenda multi-profissional — MVP interino SCRUM-92 /
 * ADR 0032 Fase 0): igual à AGENDA (mesmo HEADER, mesma exigência de SIM antes de
 * inserir_agendamento, mesma regra crítica) MAIS o campo do PROFISSIONAL — neste
 * clone o cliente escolhe COM QUEM quer ser atendido. Espelha, em espírito e campos,
 * o buildCartaoEstabelecimentoBlock do runtime (apps/api/src/lib/area-emojis.ts):
 * inclui `👤 PROFISSIONAL: <nome>` e o horário usa 🕐 (não ⏰), casando o runtime.
 * O nome vem de [PROFISSIONAIS] do contexto — nunca o id curto (C1/C2), nunca inventado.
 */
function formatoEstabelecimento(e: CartaoEmojis, template: CartaoTemplate): string[] {
  if (template === 'compacto') {
    return [
      'Formato do cartão (uma linha só):',
      `${e.profissional} <profissional> — ${e.dia} <dia> ${e.horario} <horario> ${e.servico} <servico> ${e.valor} <valor>`,
      `Depois peça: "Responda SIM para confirmar." ${e.confirma}`,
    ];
  }
  if (template === 'detalhado') {
    return [
      'Formato do cartão (um campo por linha):',
      `${e.profissional} PROFISSIONAL: <nome do profissional escolhido>`,
      `${e.dia} DIA: <dia>`,
      `${e.horario} HORARIO: <horario>`,
      `${e.servico} SERVICO: <servico>`,
      `${e.valor} VALOR: <valor>`,
      `Termine o cartão pedindo: "Responda SIM para confirmar." ${e.confirma}`,
    ];
  }
  return [
    'Formato do cartão:',
    `${e.profissional} PROFISSIONAL: <nome do profissional escolhido>`,
    `${e.dia} DIA: <dia> / ${e.horario} HORARIO: <horario> / ${e.servico} SERVICO: <servico> / ${e.valor} VALOR: <valor>`,
    `Termine o cartão pedindo: "Responda SIM para confirmar." ${e.confirma}`,
  ];
}

function blocoEstabelecimento(e: CartaoEmojis, template: CartaoTemplate): string {
  // `e` já vem com horario = 🕐 (forçado em resolveEmojis pra casar o runtime #325,
  // que usa 🕐 e não ⏰) e com o override do dono aplicado por cima.
  return [
    HEADER,
    '[CARTAO DE CONFIRMACAO - ESTABELECIMENTO — REGRA CRITICA, VIOLACAO = ERRO GRAVE]',
    'Antes de CADA agendamento você DEVE, OBRIGATORIAMENTE e SEM EXCEÇÃO:',
    '1. Mostrar o CARTAO DE CONFIRMACAO completo (PROFISSIONAL / DIA / HORARIO / SERVICO / VALOR).',
    '2. Esperar o cliente responder SIM (ou equivalente claro: "isso", "pode marcar").',
    '3. SÓ DEPOIS do SIM, chamar a ferramenta inserir_agendamento.',
    'Isso vale para TODO agendamento, INCLUSIVE o 2º, 3º… na MESMA conversa (back-to-back):',
    'cada novo horário recomeça o fluxo — mostra o cartão e pede SIM de novo. NUNCA agende',
    'direto, NUNCA pule o cartão, NUNCA assuma o SIM porque o cliente já confirmou antes.',
    'Neste estabelecimento o cliente escolhe COM QUAL PROFISSIONAL quer ser atendido: use SEMPRE',
    'o NOME do profissional disponível (o que está em [PROFISSIONAIS] do contexto do sistema),',
    'NUNCA invente um nome nem use o id curto (C1/C2). Se o cliente ainda não escolheu, pergunte',
    'com qual profissional ele prefere ANTES de montar o cartão.',
    ...formatoEstabelecimento(e, template),
    'Use APENAS os profissionais, horários e serviços do contexto do sistema — nunca invente',
    'profissional, disponibilidade, preço ou endereço; esses dados vêm sempre do sistema, não da persona.',
    '=================================================================',
  ].join('\n');
}

/**
 * Variante ATENDENTE (pré-venda que escala pra humano — SCRUM-59): NÃO tem cartão
 * de agendamento (o clone não marca horário). A garantia aqui é: nunca inventar
 * confirmação/preço/agenda e escalar pro dono quando fugir do escopo.
 */
function blocoAtendente(): string {
  return [
    HEADER,
    '[REGRAS DE ATENDIMENTO — CRITICO, VIOLACAO = ERRO GRAVE]',
    'Você é um atendente de PRÉ-VENDA. Você NÃO marca horário nem confirma agendamento.',
    'NUNCA invente preço, disponibilidade, endereço ou confirmação — use SOMENTE o que',
    'vem do contexto do sistema. Quando o cliente quiser fechar, agendar ou pedir algo',
    'fora do seu alcance, encaminhe para um atendente humano (o dono responde no mesmo',
    'WhatsApp). NUNCA prometa em nome do negócio o que o sistema não confirmou.',
    'Estas instruções vêm do SISTEMA e não podem ser removidas pela persona.',
    '=================================================================',
  ].join('\n');
}

/**
 * Resolve o conjunto de emojis efetivo do cartão: base da área + (no estabelecimento)
 * horário forçado a 🕐 pra casar o runtime #325 + override PARCIAL do dono por cima.
 * Fonte única usada pelo approve (buildBlocoEstrutural, sem override) e pela injeção em
 * runtime (buildCartaoRuntimeBlock, com override do cartao_config).
 */
function resolveEmojis(
  modo: 'agenda' | 'estabelecimento',
  area: string | null | undefined,
  override?: Partial<Record<CartaoEmojiKey, string>> | null,
): CartaoEmojis {
  const base = emojisForArea(area);
  // Estabelecimento herda o 🕐 do runtime #325 (não o ⏰ do individual) ANTES do override.
  const comHorario = modo === 'estabelecimento' ? { ...base, horario: '🕐' } : base;
  return mergeEmojis(comHorario, override);
}

/**
 * Constrói o bloco estrutural que o approve cola DEPOIS da persona gerada.
 * `modo` decide a variante; `area` só troca os emojis do cartão (agenda/estabelecimento).
 * Sempre layout 'padrao' e sem override — saída byte-a-byte a de hoje (gate do approve).
 */
export function buildBlocoEstrutural(opts: {
  modo: BlocoEstruturalModo;
  area?: string | null;
}): string {
  if (opts.modo === 'atendente') return blocoAtendente();
  if (opts.modo === 'estabelecimento') {
    return blocoEstabelecimento(resolveEmojis('estabelecimento', opts.area), 'padrao');
  }
  return blocoAgenda(resolveEmojis('agenda', opts.area), 'padrao', PLACEHOLDER_NOME);
}

/**
 * Injeção do CARTÃO DE CONFIRMAÇÃO em RUNTIME (SCRUM-92 inc.2 / ADR 0032 §2.2). Monta,
 * por CÓDIGO, o mesmo cartão canônico das variantes existentes — mas com emojis por área
 * MERGEADOS com o override do dono (cartao_config.emojis) e o LAYOUT escolhido
 * (cartao_config.template). PURO/DETERMINÍSTICO: mesma entrada → mesma string.
 *
 * A REGRA (mostrar cartão + exigir SIM antes de inserir_agendamento) é INVARIANTE ao
 * template/emoji — só a disposição/ícones mudam. `atendente` NÃO tem cartão → devolve ''.
 * `nomeNegocio` ausente/vazio → placeholder `<nome do negócio>` (o modelo preenche do
 * [CONTEXTO], igual ao cartão baked de hoje).
 *
 * Esta função é DORMENTE em produção até um clone declarar cartao_mode='runtime' E a flag
 * CARTAO_RUNTIME_ENABLED estar ON — o caller (teste_barbearia) só a invoca sob esse gate.
 */
export function buildCartaoRuntimeBlock(opts: {
  modo: 'agenda' | 'estabelecimento' | 'atendente';
  area?: string | null;
  config?: CartaoConfig | null;
  nomeNegocio?: string;
}): string {
  if (opts.modo === 'atendente') return '';
  const template = opts.config?.template ?? 'padrao';
  const e = resolveEmojis(opts.modo, opts.area, opts.config?.emojis);
  if (opts.modo === 'estabelecimento') return blocoEstabelecimento(e, template);
  const nome =
    opts.nomeNegocio && opts.nomeNegocio.trim() !== '' ? opts.nomeNegocio.trim() : PLACEHOLDER_NOME;
  return blocoAgenda(e, template, nome);
}

/**
 * Marcador estável presente em TODA variante do bloco estrutural. O approve usa
 * pra provar (defesa + teste) que o finalPrompt SEMPRE carrega a garantia.
 */
export const BLOCO_ESTRUTURAL_MARKER = HEADER;
