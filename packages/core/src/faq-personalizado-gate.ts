/**
 * faq-personalizado-gate.ts — gate POR-CLONE do FAQ PERSONALIZADO (SCRUM-65).
 *
 * O FAQ personalizado (dono cadastra pares pergunta+resposta que o bot usa como base de
 * conhecimento oficial) é ligado por SLOT, no MESMO padrão do `isModoAtendenteEnabled` /
 * `isAtendFromAgendaEnabled`, pra estrear só nos clones autorizados (ex.: Meduzza) sem
 * tocar Cirilo/Samuel (decisão do Bruno 08/07: subir com gate por-clone).
 *
 * Configurado via a env `FAQ_PERSONALIZADO_SLOTS` (string, lista separada por vírgula),
 * passada pra cá já lida do config tipado dos apps (apps/api e apps/portal-api):
 *   - vazio / não setado  -> OFF pra TODOS (default seguro = estado de hoje).
 *   - 'slot_a,slot_b'      -> ON só nos slots listados.
 *   - '*'                  -> ON pra TODOS (enable global futuro).
 *
 * O gate controla DOIS pontos: (a) a INJEÇÃO do bloco [PERGUNTAS FREQUENTES...] no contexto
 * do bot (free-slots.buildContextBlock) e (b) a exposição no portal (features.faq_personalizado
 * no GET /portal/perfil + PUT recusando a chave quando OFF).
 *
 * KILL-SWITCH / ESCALA (sem deploy de código): esvaziar a env -> off geral; adicionar um slot
 * -> libera aquele clone; '*' -> todos.
 *
 * Helper PURO (sem I/O, sem env interna): a env é lida no config schema de cada app e passada
 * como argumento — fácil de testar e sem acoplamento a process.env aqui.
 */

/**
 * @param slot         slot do clone (SEMPRE da sessão / requireTenant — nunca de input).
 * @param slotsConfig  valor de `config.FAQ_PERSONALIZADO_SLOTS` (string da env).
 * @returns true se o gate do FAQ personalizado está ligado para este slot.
 */
export function isFaqPersonalizadoEnabled(
  slot: string,
  slotsConfig: string | undefined | null,
): boolean {
  if (!slotsConfig) return false;
  // tolera espaços e vírgulas sobrando (', clone_x , ,'): trim + ignora vazios.
  const entries = slotsConfig
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return false;
  // wildcard liga geral; senão match exato do slot (sem cruzar tenant: nada de prefixo).
  if (entries.includes('*')) return true;
  return entries.includes(slot);
}

/**
 * Camada de resolução env→coluna (ADR 0030 D1). O efetivo é a UNIÃO do gate por-env com o
 * gate por-clone (coluna `flow_clones.faq_personalizado_enabled`):
 *
 *     efetivo = isFaqPersonalizadoEnabled(slot, envCsv)  OR  columnEnabled === true
 *
 * O env permanece como kill-switch/override GLOBAL: se o slot está no CSV (ou o CSV é '*',
 * estado atual de produção), segue ON independente da coluna — preserva a byte-identidade. A
 * coluna só ADICIONA capacidade (ligar por-clone quando o env for enxugado de '*'), nunca remove.
 * Helper PURO: a leitura da coluna acontece no caller (que já carrega o clone).
 *
 * @param slot          slot do clone (SEMPRE da sessão / requireTenant — nunca de input).
 * @param slotsConfig   valor de `config.FAQ_PERSONALIZADO_SLOTS` (string da env).
 * @param columnEnabled valor de `flow_clones.faq_personalizado_enabled` (boolean; ausente = false).
 */
export function resolveFaqPersonalizadoEnabled(
  slot: string,
  slotsConfig: string | undefined | null,
  columnEnabled: boolean | undefined | null,
): boolean {
  return isFaqPersonalizadoEnabled(slot, slotsConfig) || columnEnabled === true;
}
