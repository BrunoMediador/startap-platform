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
 *
 * `verbatim` (refinamento Bruno 23/07): cartão LEGADO capturado LITERALMENTE do bot_prompt
 * de um clone MIGRADO (script migrate-cartao-runtime). Quando presente e não-vazio, o
 * `buildCartaoRuntimeBlock` EMITE esse texto exato — o cartão só SAI do bot_prompt (baked) e
 * ENTRA injetado, IDÊNTICO ao que o clone já tinha (zero mudança visível pro cliente). O
 * caminho "montado por template/emojis" só vale pra clones NOVOS ou quando o DONO edita
 * (aí vira o cartão-built com a escolha dele). template/emojis convivem: servem de SEED do
 * picker mesmo com verbatim presente (a UI pré-preenche com o que o clone já usa).
 */
export interface CartaoConfig {
  template?: CartaoTemplate;
  emojis?: Partial<Record<CartaoEmojiKey, string>>;
  verbatim?: string;
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
 * Valores que preenchem os campos do cartão. Na INSTRUÇÃO da persona (formato*) entram os
 * PLACEHOLDERS (`<dia>` etc.) que o modelo substitui em runtime; na PRÉVIA do portal
 * (buildCartaoExemplo) entram valores REAIS de exemplo (dia/serviço/preço do clone). Fonte
 * ÚNICA: as linhas do cartão (cartaoLinhas*) são as MESMAS pros dois caminhos — só os `v`
 * mudam. Assim o que o dono vê na prévia = layout/CAIXA-ALTA/barras que o runtime dita.
 */
interface CartaoValores {
  dia: string;
  horario: string;
  servico: string;
  valor: string;
  /** Só usado no cartão de ESTABELECIMENTO. Ignorado na agenda (individual). */
  profissional: string;
}

/** Placeholders da INSTRUÇÃO (byte-a-byte os de hoje — regressão dos pagantes). O do
 *  profissional varia por template no estabelecimento e é passado pelo caller. */
const PLACEHOLDERS_AGENDA: CartaoValores = {
  dia: '<dia>',
  horario: '<horario>',
  servico: '<servico>',
  valor: '<valor>',
  profissional: '',
};

/**
 * Linhas do CARTÃO (agenda) que o assistente EMITE — a FONTE ÚNICA do layout. Tanto a
 * instrução da persona (formatoAgenda) quanto a prévia do portal (buildCartaoExemplo)
 * consomem estas MESMAS linhas; só os `v` (placeholders vs valores reais) trocam. NÃO inclui
 * o rótulo "Formato do cartão:" nem a linha de "Responda SIM" — quem chama adiciona conforme
 * o contexto (instrução com prosa; exemplo com o fechamento "Responda SIM para confirmar.").
 */
function cartaoLinhasAgenda(
  e: CartaoEmojis,
  template: CartaoTemplate,
  nome: string,
  v: CartaoValores,
): string[] {
  if (template === 'compacto') {
    return [
      `${e.marca} ${nome} — ${e.dia} ${v.dia} ${e.horario} ${v.horario} ${e.servico} ${v.servico} ${e.valor} ${v.valor}`,
    ];
  }
  if (template === 'detalhado') {
    return [
      `${e.marca} ${nome}`,
      `${e.dia} DIA: ${v.dia}`,
      `${e.horario} HORARIO: ${v.horario}`,
      `${e.servico} SERVICO: ${v.servico}`,
      `${e.valor} VALOR: ${v.valor}`,
    ];
  }
  return [
    `${e.marca} ${nome}`,
    `${e.dia} DIA: ${v.dia} / ${e.horario} HORARIO: ${v.horario} / ${e.servico} SERVICO: ${v.servico} / ${e.valor} VALOR: ${v.valor}`,
  ];
}

/**
 * Linhas do FORMATO do cartão (agenda) por template. Só o LAYOUT varia — 'padrao' é
 * byte-a-byte o de hoje; 'compacto'/'detalhado' redispõem os MESMOS campos/emojis. A
 * REGRA (cabeçalho, exigir SIM antes de inserir_agendamento) vive fora daqui e NÃO muda.
 */
function formatoAgenda(e: CartaoEmojis, template: CartaoTemplate, nome: string): string[] {
  const linhas = cartaoLinhasAgenda(e, template, nome, PLACEHOLDERS_AGENDA);
  if (template === 'compacto') {
    return [
      'Formato do cartão (uma linha só):',
      ...linhas,
      `Depois peça: "Responda SIM para confirmar." ${e.confirma}`,
    ];
  }
  if (template === 'detalhado') {
    return [
      'Formato do cartão (um campo por linha):',
      ...linhas,
      `Termine o cartão pedindo: "Responda SIM para confirmar." ${e.confirma}`,
    ];
  }
  return [
    'Formato do cartão:',
    ...linhas,
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
/**
 * Linhas do CARTÃO (estabelecimento) que o assistente EMITE — FONTE ÚNICA compartilhada por
 * formatoEstabelecimento (instrução) e buildCartaoExemplo (prévia). Inclui a linha do
 * PROFISSIONAL (👤). O horário usa o `e.horario` já resolvido a 🕐 (resolveEmojis força no
 * estabelecimento, casando o runtime #325). Só os `v` mudam entre instrução e exemplo.
 */
function cartaoLinhasEstabelecimento(
  e: CartaoEmojis,
  template: CartaoTemplate,
  v: CartaoValores,
): string[] {
  if (template === 'compacto') {
    return [
      `${e.profissional} ${v.profissional} — ${e.dia} ${v.dia} ${e.horario} ${v.horario} ${e.servico} ${v.servico} ${e.valor} ${v.valor}`,
    ];
  }
  if (template === 'detalhado') {
    return [
      `${e.profissional} PROFISSIONAL: ${v.profissional}`,
      `${e.dia} DIA: ${v.dia}`,
      `${e.horario} HORARIO: ${v.horario}`,
      `${e.servico} SERVICO: ${v.servico}`,
      `${e.valor} VALOR: ${v.valor}`,
    ];
  }
  return [
    `${e.profissional} PROFISSIONAL: ${v.profissional}`,
    `${e.dia} DIA: ${v.dia} / ${e.horario} HORARIO: ${v.horario} / ${e.servico} SERVICO: ${v.servico} / ${e.valor} VALOR: ${v.valor}`,
  ];
}

function formatoEstabelecimento(e: CartaoEmojis, template: CartaoTemplate): string[] {
  // O placeholder do profissional difere por template (byte-a-byte o de hoje): compacto usa a
  // forma curta "<profissional>"; padrao/detalhado usam o guia "<nome do profissional escolhido>".
  const profPlaceholder =
    template === 'compacto' ? '<profissional>' : '<nome do profissional escolhido>';
  const linhas = cartaoLinhasEstabelecimento(e, template, {
    ...PLACEHOLDERS_AGENDA,
    profissional: profPlaceholder,
  });
  if (template === 'compacto') {
    return [
      'Formato do cartão (uma linha só):',
      ...linhas,
      `Depois peça: "Responda SIM para confirmar." ${e.confirma}`,
    ];
  }
  if (template === 'detalhado') {
    return [
      'Formato do cartão (um campo por linha):',
      ...linhas,
      `Termine o cartão pedindo: "Responda SIM para confirmar." ${e.confirma}`,
    ];
  }
  return [
    'Formato do cartão:',
    ...linhas,
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
  // ── Caminho VERBATIM (clone MIGRADO — refinamento Bruno 23/07) ────────────────────
  // Quando o clone traz um cartão legado capturado do bot_prompt, EMITE ele LITERALMENTE
  // (o cartão só troca de "baked" pra "injetado", byte-idêntico ao que o cliente já tinha).
  // Precede o caminho montado: um clone migrado NUNCA recebe o cartão novo por baixo dos
  // panos — só se o dono editar (aí o app grava um config sem `verbatim` e cai no montado).
  const verbatim = opts.config?.verbatim;
  if (typeof verbatim === 'string' && verbatim.trim() !== '') return verbatim;
  const template = opts.config?.template ?? 'padrao';
  const e = resolveEmojis(opts.modo, opts.area, opts.config?.emojis);
  if (opts.modo === 'estabelecimento') return blocoEstabelecimento(e, template);
  const nome =
    opts.nomeNegocio && opts.nomeNegocio.trim() !== '' ? opts.nomeNegocio.trim() : PLACEHOLDER_NOME;
  return blocoAgenda(e, template, nome);
}

/** Fechamento canônico do cartão EMITIDO (o que o cliente vê no fim do cartão), com o emoji
 *  de confirmação resolvido. Espelha o "Responda SIM para confirmar." que a instrução manda o
 *  modelo escrever — usado só pelo exemplo (a instrução carrega a versão em prosa). */
function fechamentoExemplo(e: CartaoEmojis): string {
  return `Responda SIM para confirmar. ${e.confirma}`;
}

/** Valores de amostra do cartão de EXEMPLO. `nomeNegocio` só é usado na agenda (o header do
 *  cartão individual); estabelecimento usa a linha do profissional. Todos já formatados pt-BR
 *  pelo caller (ex.: valor = 'R$ 65,00', dia = 'quinta, 24/07'). */
export interface CartaoExemploSample {
  /** Nome do negócio no header do cartão individual. Vazio/ausente → placeholder. */
  nomeNegocio?: string;
  dia: string;
  horario: string;
  /** Nome de um serviço REAL do catálogo do clone (ou fallback neutro). */
  servico: string;
  /** Preço do serviço já formatado (ex.: 'R$ 65,00'). */
  valor: string;
  /** Nome de um profissional (só entra no cartão de estabelecimento). */
  profissional: string;
}

/**
 * Renderiza um EXEMPLO do CARTÃO DE CONFIRMAÇÃO — o texto que o cliente RECEBE no WhatsApp,
 * com valores de amostra no lugar dos placeholders. É a prévia FIEL do portal (SCRUM-99): usa
 * as MESMAS linhas (cartaoLinhas*) que a instrução da persona/runtime dita, então o dono vê
 * exatamente o layout/emojis/CAIXA-ALTA/barras/"Responda SIM" que o cliente recebe — fonte
 * ÚNICA, sem divergência com o runtime. PURO/DETERMINÍSTICO.
 *
 * - `atendente` NÃO tem cartão → devolve '' (a UI esconde a seção).
 * - `agenda` (individual) NÃO tem linha de profissional; só `estabelecimento` tem.
 * - Emojis = área + override do dono (mesma resolução do runtime); `template` só muda o layout.
 * - `nomeNegocio` vazio → placeholder `<nome do negócio>` (defensivo; o caller semeia o real).
 *
 * NÃO renderiza o bloco de REGRA/HEADER (isso é instrução interna pro modelo, nunca vira card):
 * devolve só o cartão amigável. NÃO usa o caminho `verbatim` — o exemplo é sempre montado dos
 * template/emojis (o portal só chama isto no fluxo editável, onde a config é template+emojis).
 */
export function buildCartaoExemplo(opts: {
  modo: 'agenda' | 'estabelecimento' | 'atendente';
  area?: string | null;
  config?: Pick<CartaoConfig, 'template' | 'emojis'> | null;
  sample: CartaoExemploSample;
}): string {
  if (opts.modo === 'atendente') return '';
  const template = opts.config?.template ?? 'padrao';
  const e = resolveEmojis(opts.modo, opts.area, opts.config?.emojis);
  const s = opts.sample;
  if (opts.modo === 'estabelecimento') {
    const linhas = cartaoLinhasEstabelecimento(e, template, {
      dia: s.dia,
      horario: s.horario,
      servico: s.servico,
      valor: s.valor,
      profissional: s.profissional,
    });
    return [...linhas, fechamentoExemplo(e)].join('\n');
  }
  const nome =
    s.nomeNegocio && s.nomeNegocio.trim() !== '' ? s.nomeNegocio.trim() : PLACEHOLDER_NOME;
  const linhas = cartaoLinhasAgenda(e, template, nome, {
    dia: s.dia,
    horario: s.horario,
    servico: s.servico,
    valor: s.valor,
    profissional: '',
  });
  return [...linhas, fechamentoExemplo(e)].join('\n');
}

/**
 * Marcador estável presente em TODA variante do bloco estrutural. O approve usa
 * pra provar (defesa + teste) que o finalPrompt SEMPRE carrega a garantia.
 */
export const BLOCO_ESTRUTURAL_MARKER = HEADER;

/** Ordem canônica das chaves de emoji do cartão. Fonte única do domínio (usada pelo
 *  catálogo/allowlist e pelo endpoint de config). */
export const CARTAO_EMOJI_KEYS: readonly CartaoEmojiKey[] = [
  'marca',
  'dia',
  'horario',
  'servico',
  'valor',
  'confirma',
  'profissional',
] as const;

/**
 * Emojis DEFAULT do cartão pra uma área + modo. Wrapper público de `resolveEmojis` (sem
 * override): o endpoint `/portal/cartao-config` usa como `defaults` do GET e o catálogo/
 * allowlist usa como uma das bases. `estabelecimento` força 🕐 no horário (casa o runtime
 * #325); `agenda` mantém ⏰. Devolve um Record puro (cópia), nunca a referência interna.
 */
export function resolveDefaultCartaoEmojis(
  modo: 'agenda' | 'estabelecimento',
  area?: string | null,
): Record<CartaoEmojiKey, string> {
  return { ...resolveEmojis(modo, area) };
}

/**
 * TODOS os conjuntos de emoji default conhecidos (todas as áreas + a variante de horário
 * do estabelecimento 🕐). Base pra construir a allowlist FECHADA do endpoint (o catálogo
 * garante que TODO default por área é sempre um valor válido — o picker nunca oferece um
 * emoji que o backend rejeitaria). NÃO é o catálogo completo (o catálogo estende com um
 * conjunto curado por chave — ver cartao-catalog.ts).
 */
export function allAreaDefaultEmojiSets(): Record<CartaoEmojiKey, string>[] {
  const areas = ['barbearia', 'salao', 'manicure', 'estetica', 'generico'];
  const sets: Record<CartaoEmojiKey, string>[] = [];
  for (const a of areas) {
    sets.push({ ...resolveEmojis('agenda', a) });
    sets.push({ ...resolveEmojis('estabelecimento', a) });
  }
  return sets;
}
