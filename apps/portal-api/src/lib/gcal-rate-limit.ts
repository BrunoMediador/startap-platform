/**
 * Classifica se um erro do GCal (mensagem lançada por `gcalFetch`, formato
 * `GCal <path> -> HTTP <status>: <body>`) é RATE-LIMIT — usado pelo circuit-break do
 * POST /portal/agendamentos/serie (SCRUM — agenda recorrente): ao primeiro 403 de
 * rate-limit, o lote PARA e devolve o parcial (não insiste); e o `catch` NÃO invalida
 * o cache de agenda nem demove a agenda (regra de negócio 20 — 403 de rate-limit do
 * GCal não demove agenda, distinto de um 403 "forbidden" real de credencial revogada).
 *
 * Google devolve o corpo como JSON com `error.errors[].reason` — os dois reasons
 * documentados para quota do Calendar API são `rateLimitExceeded` (projeto) e
 * `userRateLimitExceeded` (por usuário/SA). Fallback textual (`quota`/`rate limit`)
 * cobre variações de mensagem sem quebrar se o Google mudar o shape do JSON.
 */
export function isGcalRateLimitError(message: string): boolean {
  if (/rateLimitExceeded|userRateLimitExceeded/i.test(message)) return true;
  if (/HTTP 403/.test(message) && /quota|rate.?limit/i.test(message)) return true;
  return false;
}

/** 401/403 "de verdade" (credencial revogada/sem permissão) — distinto de rate-limit. */
export function isGcalForbiddenOrAuthError(message: string): boolean {
  return /40[13]/.test(message) && !isGcalRateLimitError(message);
}
