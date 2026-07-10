/**
 * human-reply-agenda-gate.ts — gate POR-CLONE da PAUSA POR RESPOSTA HUMANA nos FORMATOS DE
 * AGENDA (SCRUM-68, Onda 4 / ADR 0030).
 *
 * Contexto (regra de produto do Bruno, [[produto-regra-pausa]]): pausa por FRASE/keyword ou
 * pelo APP = INDETERMINADA (só o cliente remove); pausa por INTERAÇÃO HUMANA (o dono responde
 * à mão no MESMO número) = 60min com volta automática. Esse "human_reply de 60min" já existe no
 * ramo MODO ATENDENTE (router.ts, gated por MODO_ATENDENTE_SLOTS). Nos formatos de AGENDA
 * (Cirilo/Samuel/dragon) o dono que responde à mão com texto livre (não-keyword) hoje cai em
 * 'ignored:fromMe' SEM pausa nenhuma → o bot responde JUNTO com o humano. Este gate liga a mesma
 * pausa 60min no ramo AGENDA, por-clone, no MESMO padrão do `isModoAtendenteEnabled`.
 *
 * Configurado via a env `HUMAN_REPLY_AGENDA_SLOTS` (string, lista separada por vírgula),
 * passada pra cá já lida do config/process.env dos apps consumidores (apps/api: router + base):
 *   - vazio / não setado  -> OFF pra TODOS (default seguro = estado de HOJE, byte-idêntico:
 *                            o ramo agenda segue 'ignored:fromMe' sem pausa e sem registrar eco).
 *   - 'slot_a,slot_b'      -> ON só nos slots listados (rollout: dragon primeiro, depois pagante
 *                            com go do Bruno).
 *   - '*'                  -> ON pra TODOS (enable global futuro).
 *
 * KILL-SWITCH / ESCALA (sem deploy de código):
 *   - esvaziar a env       -> off geral (volta byte-idêntico).
 *   - adicionar um slot     -> libera aquele clone.
 *   - '*'                   -> todos.
 *
 * Helper PURO (sem I/O, sem env interna): a env é lida no caller e passada como argumento —
 * fácil de testar e sem acoplamento a process.env aqui. Coluna por-clone (self-service,
 * fundação env→coluna da Onda 2) fica pra follow-up: nesta PR o env-CSV basta.
 */

/**
 * @param slot         slot do clone (SEMPRE da sessão / route.workflow_id — nunca de input).
 * @param slotsConfig  valor de `HUMAN_REPLY_AGENDA_SLOTS` (string da env).
 * @returns true se a pausa por resposta humana no ramo AGENDA está ligada para este slot.
 */
export function isHumanReplyAgendaEnabled(
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
