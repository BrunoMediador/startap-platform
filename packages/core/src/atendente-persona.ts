/**
 * Persona/identidade compartilhada do MODO ATENDENTE + helpers de área.
 *
 * MORAVAM em @startap/integrations (clone-provisioning.ts). Movidos pra @startap/core
 * (SCRUM-122) porque DOIS caminhos precisam da MESMA fonte da persona de pré-venda:
 *   - regerarPromptClone (provisioning/signup)      — @startap/integrations
 *   - updateClone (re-render no save de perfil)      — @startap/db
 * @startap/db NÃO pode importar @startap/integrations (a dependência é o contrário),
 * então a única casa comum é @startap/core. Duplicar o template nos dois pacotes foi
 * exatamente a CLASSE de bug do SCRUM-122 (drift): um caminho honrava o modo atendente
 * e o outro re-renderizava a matriz de AGENDA. Fonte única mata a classe.
 */

/**
 * Fallback seguro para o nome do negócio. Centralizado pra que o render e o
 * passe de sanitização final usem EXATAMENTE o mesmo texto.
 */
export const NOME_NEGOCIO_FALLBACK = 'a barbearia';

/**
 * Área/vertical do negócio (Missão 023 W8). Mapa CÓDIGO -> {{area_artigo}}, a
 * frase pronta COM artigo que entra no prompt (ex.: "a barbearia", "o salao").
 *
 * Por que frase pronta e não montar artigo no template: evita concordância
 * errada da IA e mantém o prompt-base legível pro operador (decisão ai-engineer).
 *
 * Os valores são DELIBERADAMENTE iguais ao design (w5-w6-w8-w11-ia-design.md). A
 * TAXONOMIA canônica é validada por Zod NO APP (signup) — este mapa só traduz o
 * código já-validado pra frase. Código desconhecido/ausente cai no fallback
 * genérico AREA_ARTIGO_FALLBACK (nunca placeholder cru, nunca artigo errado).
 *
 * `'outro'` é o catch-all do signup; `'generico'` é alias histórico do design —
 * ambos mapeiam pro tom neutro.
 */
export const AREA_ARTIGO: Readonly<Record<string, string>> = {
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
 * Resolve a frase {{area_artigo}} a partir do código de área (já validado no app).
 * Trim + lower defensivo; valor fora do mapa -> fallback genérico ("o atendimento").
 * Centralizado pra que render e backfill/tests usem a MESMA tabela.
 */
export function areaArtigo(area: unknown): string {
  if (typeof area !== 'string') return AREA_ARTIGO_FALLBACK;
  const key = area.trim().toLowerCase();
  return AREA_ARTIGO[key] ?? AREA_ARTIGO_FALLBACK;
}

/**
 * SEED do MODO ATENDENTE (bug 2026-07-13: clone atendente self-service nascia com
 * a persona de AGENDA da matriz teste_barbearia — "DEVE chamar inserir_agendamento"
 * / "Ta na agenda" — enquanto o guardrail de runtime (buildModoAtendenteBlock) diz o
 * oposto → bot esquizofrênico). Este template dá a PERSONA de pré-venda a todo clone
 * provisionado com modo_atendente_enabled, em vez de renderizar a matriz de agenda.
 *
 * SÓ persona + tom + enquadramento de pré-venda. As REGRAS DURAS (nunca "agendei",
 * não invente, registrar_interesse/escalar_para_humano, link-vs-equipe, fora-do-
 * expediente, não-invasivo) já são injetadas em RUNTIME por buildModoAtendenteBlock
 * (modoBlock em processAtendente) — duplicar aqui só criaria risco de contradição
 * futura e desperdício de token. Os dados do negócio (serviços, preços, horários,
 * endereço, FAQ) também são injetados em runtime por buildContextBlock — por isso o
 * template NÃO inclui {{servicos_precos_render}}/{{horarios_funcionamento_render}}
 * (inline duplicaria no system prompt e arrisca drift).
 *
 * Placeholders: SÓ {{double_brace}} de identidade ({{nome_negocio}}, {{area_artigo}}),
 * resolvidos no PROVISIONING por renderClonePrompt. ZERO token single-brace {x}:
 * em runtime o atendente chama renderPrompt({ vars: {} }) — qualquer {x} ficaria
 * literal. Molde ASCII-sem-acento do DEFAULT_PROMPT_TPL (teste_barbearia).
 */
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
