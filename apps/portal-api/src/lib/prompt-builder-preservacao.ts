/**
 * Guarda de PRESERVAÇÃO do modo MELHORIA do builder (SCRUM-153).
 *
 * No modo 'criacao' a persona nasce do zero: não há nada a perder. No modo 'melhoria' o clone
 * JÁ TEM uma persona no ar que o dono escreveu/aprovou, e o approve SOBRESCREVE o bot_prompt
 * inteiro (applyGeneratedPrompt faz INSERT..ON CONFLICT DO UPDATE). Então um modelo que
 * "resume", trunca ou devolve só o trecho novo faz o dono PERDER texto que ele nunca pediu pra
 * remover — exatamente o que a regra de negócio 27 proíbe ("o que o CLIENTE configurou é dele").
 *
 * O prompt V5 manda preservar, mas prompt não é garantia. Esta é a camada determinística: mede o
 * ENCOLHIMENTO da proposta em relação à persona que está no ar e, se passar do teto, marca como
 * não-preservada. O route usa isso pra NÃO promover a proposta a rascunho silenciosamente — o
 * dono é avisado e escolhe (pedir de novo, ou declarar explicitamente que quer reescrever).
 *
 * Deliberadamente NÃO é um diff semântico: encolhimento por caractere é barato, determinístico e
 * pega o modo de falha real (persona voltando pela metade). Reescrita LEGÍTIMA — pedida pelo dono
 * — passa por cima desta guarda via `reescritaExplicita`, porque aí perder o texto antigo é o que
 * ele pediu (e o snapshot em bot_prompt_versions continua sendo a rede de segurança).
 */

/**
 * Fração da persona atual que a proposta pode perder sem levantar suspeita. 0.5 = a proposta
 * pode ficar com metade do tamanho; abaixo disso não é "ajuste", é outra persona.
 * Generoso de propósito: o objetivo é pegar a perda GROSSEIRA (só o trecho novo, texto cortado
 * no meio), não policiar reformulação de frase. Falso-positivo aqui custa uma pergunta a mais
 * ao dono; falso-negativo custa o texto dele.
 */
export const PRESERVACAO_MIN_RATIO = 0.5;

/** Personas curtas não entram na conta: variação de poucas dezenas de chars é ruído. */
export const PRESERVACAO_MIN_CHARS_APLICAVEL = 200;

export interface PreservacaoResult {
  /** true = a proposta preservou o bastante (ou a guarda não se aplica). */
  ok: boolean;
  /** tamanho da proposta / tamanho da persona atual (arredondado, pra log). */
  ratio: number;
}

/**
 * A proposta preserva a persona atual o suficiente?
 *
 * @param personaAtual  persona que está no ar (vazia = modo criação → sempre ok).
 * @param proposta      persona proposta pelo modelo, JÁ limpa pelo validador.
 * @param reescritaExplicita  o dono pediu reescrita total nesta conversa → guarda desligada.
 */
export function avaliarPreservacao(
  personaAtual: string,
  proposta: string,
  reescritaExplicita = false,
): PreservacaoResult {
  const atual = (personaAtual ?? '').trim();
  const nova = (proposta ?? '').trim();
  // Sem persona atual (criação) ou persona curta demais: guarda não se aplica.
  if (atual.length < PRESERVACAO_MIN_CHARS_APLICAVEL) return { ok: true, ratio: 1 };
  const ratio = nova.length / atual.length;
  const rounded = Math.round(ratio * 100) / 100;
  // Reescrita pedida pelo dono: encolher é legítimo (o snapshot em bot_prompt_versions guarda
  // o texto antigo de qualquer forma).
  if (reescritaExplicita) return { ok: true, ratio: rounded };
  return { ok: ratio >= PRESERVACAO_MIN_RATIO, ratio: rounded };
}
