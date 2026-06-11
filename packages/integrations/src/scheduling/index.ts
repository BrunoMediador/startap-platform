/**
 * scheduling — lógica de disponibilidade de agenda compartilhada (bot + portal).
 *
 * Movido de apps/api/src/lib/free-slots.ts na Missão 020 F4 para que o
 * portal-api calcule slots livres com a MESMA regra que o bot usa (step =
 * duração do serviço, piso de 10min pra hoje, overlap contra GCal).
 */
export * from './free-slots.js';
