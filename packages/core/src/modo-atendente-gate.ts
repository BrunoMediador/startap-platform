/**
 * modo-atendente-gate.ts — gate POR-CLONE do MODO ATENDENTE (SCRUM-59).
 *
 * O modo atendente (bot que atende/tira dúvida/qualifica SEM agenda automática) é ligado
 * por SLOT, no MESMO padrão do `isAtendFromAgendaEnabled` (billing derivado da agenda),
 * pra estrear só no clone do piloto sem tocar Cirilo/Samuel (decisão do Bruno: "começar
 * só com flag no novo, não mexer nos que estão rodando").
 *
 * Configurado via a env `MODO_ATENDENTE_SLOTS` (string, lista separada por vírgula),
 * passada pra cá já lida do config tipado dos apps (apps/api e apps/portal-api):
 *   - vazio / não setado  -> OFF pra TODOS (default seguro = estado de hoje).
 *   - 'slot_a,slot_b'      -> ON só nos slots listados.
 *   - '*'                  -> ON pra TODOS (enable global futuro).
 *
 * ⚠️ O modo atendente também exige, ALÉM deste gate, o perfil do clone com
 * `agenda_automatica === false` (flow_clones.personalizacao) — o gate por env é o macro,
 * o perfil é o toggle fino por-clone. Ambos verdadeiros = modo atendente.
 *
 * KILL-SWITCH / ESCALA (sem deploy de código):
 *   - esvaziar a env       -> off geral.
 *   - adicionar um slot     -> libera aquele clone.
 *   - '*'                   -> todos.
 *
 * Helper PURO (sem I/O, sem env interna): a env é lida no config schema de cada app e
 * passada como argumento — fácil de testar e sem acoplamento a process.env aqui.
 */

/**
 * @param slot         slot do clone (SEMPRE da sessão / requireTenant — nunca de input).
 * @param slotsConfig  valor de `config.MODO_ATENDENTE_SLOTS` (string da env).
 * @returns true se o gate macro do modo atendente está ligado para este slot.
 */
export function isModoAtendenteEnabled(
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
 * gate por-clone (coluna `flow_clones.modo_atendente_enabled`):
 *
 *     efetivo = isModoAtendenteEnabled(slot, envCsv)  OR  columnEnabled === true
 *
 * O env permanece como kill-switch/override GLOBAL: se o slot está no CSV (ou o CSV é '*'),
 * segue ON independente da coluna — preserva a byte-identidade de quem já roda. A coluna só
 * ADICIONA capacidade (ligar por-clone sem env), nunca remove. Helper PURO: a leitura da coluna
 * acontece no caller (que já carrega o clone); aqui só combinamos os dois booleanos.
 *
 * @param slot          slot do clone (SEMPRE da sessão / requireTenant — nunca de input).
 * @param slotsConfig   valor de `config.MODO_ATENDENTE_SLOTS` (string da env).
 * @param columnEnabled valor de `flow_clones.modo_atendente_enabled` (boolean; ausente = false).
 */
export function resolveModoAtendenteEnabled(
  slot: string,
  slotsConfig: string | undefined | null,
  columnEnabled: boolean | undefined | null,
): boolean {
  return isModoAtendenteEnabled(slot, slotsConfig) || columnEnabled === true;
}
