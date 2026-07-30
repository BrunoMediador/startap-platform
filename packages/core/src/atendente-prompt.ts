/**
 * ATENDENTE_PROMPT_TPL — persona de pré-venda do MODO ATENDENTE.
 *
 * Fonte ÚNICA (SCRUM-122): extraída de @startap/integrations/provisioning/clone-provisioning
 * pra @startap/core porque @startap/db (updateClone) e @startap/integrations
 * (regerarPromptClone) precisam da MESMA constante e @startap/db NÃO PODE depender de
 * @startap/integrations (ciclo — ver packages/db/src/queries/clone-colaboradores.ts:534-537,
 * mesmo precedente de "espelhar tipo local" citado ali; aqui a solução é mover o DADO
 * estático pro package neutro que os dois já consomem).
 *
 * Bug original (2026-07-13, SCRUM-79): clone atendente self-service nascia com a persona de
 * AGENDA da matriz teste_barbearia ("DEVE chamar inserir_agendamento" / "Ta na agenda") em vez
 * da persona de pré-venda — bot contradizia o guardrail de runtime (buildModoAtendenteBlock).
 * Fix original só cobriu `regerarPromptClone` (provisioning); `updateClone` (save de perfil no
 * portal) REIMPLEMENTAVA o re-render do zero e nunca herdou o fix — reaberto como SCRUM-122
 * (clone MVS, criado 8 dias depois do fix original, perdeu a persona no 1º save de perfil).
 *
 * SÓ persona + tom + enquadramento de pré-venda. As REGRAS DURAS (nunca "agendei", não invente,
 * registrar_interesse/escalar_para_humano, link-vs-equipe, fora-do-expediente, não-invasivo) já
 * são injetadas em RUNTIME por buildModoAtendenteBlock (modoBlock em processAtendente) —
 * duplicar aqui só criaria risco de contradição futura e desperdício de token. Os dados do
 * negócio (serviços, preços, horários, endereço, FAQ) também são injetados em runtime por
 * buildContextBlock — por isso o template NÃO inclui {{servicos_precos_render}}/
 * {{horarios_funcionamento_render}} (inline duplicaria no system prompt e arrisca drift).
 *
 * Placeholders: SÓ {{double_brace}} de identidade ({{nome_negocio}}, {{area_artigo}}),
 * resolvidos no PROVISIONING/SAVE por renderClonePrompt/applyPersonalizacao. ZERO token
 * single-brace {x}: em runtime o atendente chama renderPrompt({ vars: {} }) — qualquer {x}
 * ficaria literal. Molde ASCII-sem-acento do DEFAULT_PROMPT_TPL (teste_barbearia).
 */
/**
 * Fallback seguro para o nome do negócio quando {{nome_negocio}} não resolve (ausente,
 * vazio ou só-whitespace). Fonte única (SCRUM-122; nasceu em clone-provisioning.ts) — os
 * DOIS caminhos de render (provisioning e save de perfil) usam EXATAMENTE o mesmo texto,
 * nunca placeholder cru nem string vazia no bot_prompt persistido.
 */
export const NOME_NEGOCIO_FALLBACK = 'a barbearia';

/**
 * Área/vertical do negócio (Missão 023 W8). Mapa CÓDIGO -> {{area_artigo}}, a frase pronta
 * COM artigo que entra no prompt (ex.: "a barbearia", "o salao"). Fonte única (SCRUM-122).
 *
 * Por que frase pronta e não montar artigo no template: evita concordância errada da IA e
 * mantém o prompt-base legível pro operador (decisão ai-engineer).
 *
 * Os valores são DELIBERADAMENTE iguais ao design (w5-w6-w8-w11-ia-design.md). A TAXONOMIA
 * canônica é validada por Zod NO APP (signup) — este mapa só traduz o código já-validado pra
 * frase. Código desconhecido/ausente cai no fallback genérico AREA_ARTIGO_FALLBACK (nunca
 * placeholder cru, nunca artigo errado). `'outro'` é o catch-all do signup; `'generico'` é
 * alias histórico do design — ambos mapeiam pro tom neutro.
 */
const AREA_ARTIGO: Readonly<Record<string, string>> = {
  barbearia: 'a barbearia',
  cabeleireiro: 'o salao',
  manicure: 'o espaco de unhas',
  estetica: 'o studio de estetica',
  outro: 'o atendimento',
  generico: 'o atendimento',
};

/** Tom neutro quando a área é ausente/desconhecida (clone antigo, valor fora do mapa). */
export const AREA_ARTIGO_FALLBACK = 'o atendimento';

/**
 * Resolve a frase {{area_artigo}} a partir do código de área (já validado no app). Trim +
 * lower defensivo; valor fora do mapa -> fallback genérico ("o atendimento"). Fonte única
 * (SCRUM-122) pra que render, backfill e tests usem a MESMA tabela.
 */
export function areaArtigo(area: unknown): string {
  if (typeof area !== 'string') return AREA_ARTIGO_FALLBACK;
  const key = area.trim().toLowerCase();
  return AREA_ARTIGO[key] ?? AREA_ARTIGO_FALLBACK;
}

export const ATENDENTE_PROMPT_TPL = [
  'Voce e o atendente virtual de {{nome_negocio}} e conversa com os clientes pelo WhatsApp.',
  'Aqui e {{area_artigo}}: voce recebe quem chega, apresenta o negocio com simpatia e ajuda a pessoa a dar o proximo passo.',
  '',
  '[QUEM VOCE E]',
  '- Uma recepcao boa gente de {{nome_negocio}}: acolhedora, prestativa e direta.',
  '- Fala como uma pessoa de verdade, no calor humano, sem parecer robo e sem formalidade dura.',
  '- Conhece o negocio e tem orgulho do trabalho da equipe; passa confianca sem exagerar.',
  '',
  '[COMO VOCE FALA]',
  '- Mensagens curtas de WhatsApp, tom leve e caloroso. Uma ideia por mensagem.',
  '- Chama a pessoa pelo nome quando souber. No maximo um emoji, so quando combinar com a conversa.',
  '- Escuta o que a pessoa precisa antes de sair falando: conversa, nao empurra, nao faz textao.',
  '',
  '[SEU PAPEL AQUI]',
  '- Da as boas-vindas, explica o que {{nome_negocio}} oferece e tira as duvidas da pessoa usando somente as informacoes do negocio que voce recebe no contexto (servicos, valores, horarios, endereco, formas de pagamento).',
  '- Quando percebe interesse, acolhe, entende o que a pessoa quer e cuida de encaminhar pra equipe dar sequencia.',
  '- Seu objetivo e ser a primeira boa impressao de {{nome_negocio}}: a pessoa tem que sair da conversa bem atendida e com vontade de ir.',
].join('\n');
