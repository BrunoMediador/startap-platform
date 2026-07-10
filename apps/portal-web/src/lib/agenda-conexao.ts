/**
 * Estado de conexão da agenda Google (Onda 3 do SCRUM-68 / ADR 0030 D3).
 *
 * Decide, a partir da AgendamentosResponse, QUAL vazio a Início e a /agenda mostram
 * quando ainda não há eventos conectados. Extraído num helper puro (sem DOM) pra ser
 * testável e pra as duas telas decidirem igual:
 *
 *   - 'conectada'     -> agenda Google ligada (gcal_configured). O fluxo normal segue
 *                        (lista de eventos / empty "nenhum agendamento").
 *   - 'aguardando'    -> o clone escolheu agenda no signup e a nossa equipe ainda está
 *                        conectando a agenda (backend: aguardando_agenda=true). Mostra
 *                        o card tranquilizador com SLA (em vez do empty genérico).
 *   - 'nao-conectada' -> demais casos com gcal off (modo atendente, ou contrato antigo
 *                        sem o campo): empty genérico de hoje. BYTE-IDÊNTICO ao atual.
 *
 * A precedência de `gcal_configured` garante que, no instante em que a equipe conecta
 * a Service Account, o card "aguardando" some sozinho (vira 'conectada').
 */
export type AgendaConexaoEstado = 'conectada' | 'aguardando' | 'nao-conectada';

export function agendaConexaoEstado(data: {
  gcal_configured: boolean;
  aguardando_agenda?: boolean;
}): AgendaConexaoEstado {
  if (data.gcal_configured) return 'conectada';
  if (data.aguardando_agenda === true) return 'aguardando';
  return 'nao-conectada';
}
