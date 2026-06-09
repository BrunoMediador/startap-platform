/**
 * Agrupamento client-side dos agendamentos (item 1 da leva 2).
 *
 * O backend manda uma janela -7/+14d ordenada ASC. Aqui agrupamos comparando o
 * `inicio` de cada evento com agora:
 *   - Hoje     : mesmo dia local de hoje
 *   - Proximos : futuro alem de hoje
 *   - Recentes : passado (antes de hoje)
 * Dentro de cada grupo, Recentes vem DESC (mais recente primeiro); Hoje e
 * Proximos ASC (mais cedo primeiro).
 *
 * `inicio` pode ser ISO datetime, date puro "2026-06-09" ou null. Null vai pra
 * Proximos (evento sem horario definido — nao some da tela), no fim do grupo.
 */
import type { Agendamento } from './api-types';

export type GrupoAgendamento = 'hoje' | 'proximos' | 'recentes';

export interface GruposAgendamentos {
  hoje: Agendamento[];
  proximos: Agendamento[];
  recentes: Agendamento[];
}

/** Inicio do dia local (00:00) de uma data, em ms. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Converte `inicio` (ISO datetime, date puro "YYYY-MM-DD" ou null) num Date local.
 * Date puro vira meia-noite local (nao UTC) pra a comparacao de dia bater certo.
 * Retorna null se invalido/ausente.
 */
export function parseInicio(inicio: string | null): Date | null {
  if (!inicio) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inicio);
  if (dateOnly) {
    const y = Number(dateOnly[1]);
    const m = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const d = new Date(y, m, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(inicio);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Classifica um agendamento em hoje/proximos/recentes (now = referencia). */
export function classify(inicio: string | null, now = new Date()): GrupoAgendamento {
  const d = parseInicio(inicio);
  if (!d) return 'proximos'; // sem horario -> trata como por-vir, nao some
  const dia = startOfDay(d);
  const hoje = startOfDay(now);
  if (dia === hoje) return 'hoje';
  return dia > hoje ? 'proximos' : 'recentes';
}

/**
 * Agrupa e ordena. Hoje/Proximos ASC; Recentes DESC. Eventos sem `inicio` vao pro
 * fim de Proximos (ordenacao estavel preserva a ordem original entre eles).
 */
export function agruparAgendamentos(
  agendamentos: Agendamento[],
  now = new Date(),
): GruposAgendamentos {
  const hoje: Agendamento[] = [];
  const proximos: Agendamento[] = [];
  const recentes: Agendamento[] = [];

  for (const ag of agendamentos) {
    const grupo = classify(ag.inicio, now);
    if (grupo === 'hoje') hoje.push(ag);
    else if (grupo === 'recentes') recentes.push(ag);
    else proximos.push(ag);
  }

  const ts = (ag: Agendamento) => parseInicio(ag.inicio)?.getTime() ?? Number.POSITIVE_INFINITY;
  hoje.sort((a, b) => ts(a) - ts(b));
  proximos.sort((a, b) => ts(a) - ts(b)); // null (Infinity) vai pro fim
  recentes.sort((a, b) => ts(b) - ts(a)); // mais recente primeiro

  return { hoje, proximos, recentes };
}

/** Quantos eventos no total (pra empty state e contagem). */
export function totalAgendamentos(g: GruposAgendamentos): number {
  return g.hoje.length + g.proximos.length + g.recentes.length;
}
