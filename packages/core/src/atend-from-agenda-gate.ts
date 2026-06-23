/**
 * atend-from-agenda-gate.ts — gate POR-CLONE do billing derivado da agenda (ADR 0027).
 *
 * Substitui o gate booleano GLOBAL (`config.ATEND_FROM_AGENDA`) por um gate por SLOT,
 * pra ligar a feature só em clones específicos (ex.: dragon) sem tocar Cirilo/Samuel.
 *
 * Configurado via a env `ATEND_FROM_AGENDA_SLOTS` (string, lista separada por vírgula),
 * passada pra cá já lida do config tipado dos dois apps (apps/api e apps/portal-api):
 *   - vazio / não setado  -> OFF pra TODOS (default seguro = estado de hoje).
 *   - 'slot_a,slot_b'      -> ON só nos slots listados.
 *   - '*'                  -> ON pra TODOS (enable global futuro).
 *
 * KILL-SWITCH: limpar a env volta a OFF pra todos, sem deploy de código.
 *
 * Helper PURO (sem I/O, sem env interna): a env é lida no config schema de cada app e
 * passada como argumento — fácil de testar e sem acoplamento a process.env aqui.
 */

/**
 * @param slot         slot do clone (SEMPRE da sessão / requireTenant — nunca de input).
 * @param slotsConfig  valor de `config.ATEND_FROM_AGENDA_SLOTS` (string da env).
 * @returns true se o gancho de billing derivado deve rodar pra este slot.
 */
export function isAtendFromAgendaEnabled(
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
