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
import type { Agendamento, AgendamentosResponse } from './api-types';

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

/**
 * Remove um evento do cache da lista por id, ajustando `count` (W10 — excluir).
 * Pura/testável (separada do hook de query). Não decrementa `count` abaixo de 0
 * e é idempotente: excluir um id ausente devolve a lista intacta (caso o evento
 * já tenha sumido — ex.: cancelado pelo robô em paralelo).
 */
export function removerAgendamento(
  prev: AgendamentosResponse,
  eventId: string,
): AgendamentosResponse {
  const agendamentos = prev.agendamentos.filter((a) => a.id !== eventId);
  if (agendamentos.length === prev.agendamentos.length) return prev;
  return { ...prev, agendamentos, count: Math.max(0, prev.count - 1) };
}

// ── Filtros + paginacao da Inicio (leva 3, BLOCO B) ──────────────────────────

/** Periodo selecionavel nas abas: Todos / Hoje / Proximos / Recentes. */
export type PeriodoFiltro = 'todos' | 'hoje' | 'proximos' | 'recentes';

export interface FiltroAgendamentos {
  /** Aba de periodo (default 'todos'). */
  periodo: PeriodoFiltro;
  /** Texto livre — filtra por `titulo` (case/acento-insensitive). '' = sem filtro. */
  busca: string;
  /** Data exata "YYYY-MM-DD" — mostra so os desse dia. '' = sem filtro. */
  data: string;
}

/** Normaliza texto pra busca: lowercase + remove acentos (NFD + strip combining). */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // remove diacriticos (acentos) — robusto, sem char raw
    .trim();
}

/** "YYYY-MM-DD" local de um Date (sem fuso UTC). */
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Aplica os 3 filtros COMBINAVEIS (periodo E busca E data) sobre a lista crua,
 * ja na ordem de exibicao (Hoje/Proximos ASC, Recentes DESC, na sequencia
 * hoje -> proximos -> recentes). Pura (testavel). `now` injetavel pra teste.
 *
 * - periodo: 'todos' nao filtra; senao mantem so o grupo escolhido.
 * - busca: compara `titulo` normalizado (case/acento-insensitive) por substring.
 * - data: mantem so eventos cujo dia local == a data "YYYY-MM-DD" informada.
 */
export function filtrarAgendamentos(
  agendamentos: Agendamento[],
  filtro: FiltroAgendamentos,
  now = new Date(),
): Agendamento[] {
  const grupos = agruparAgendamentos(agendamentos, now);
  const ordenados: Agendamento[] =
    filtro.periodo === 'hoje'
      ? grupos.hoje
      : filtro.periodo === 'proximos'
        ? grupos.proximos
        : filtro.periodo === 'recentes'
          ? grupos.recentes
          : [...grupos.hoje, ...grupos.proximos, ...grupos.recentes];

  const buscaNorm = normalizar(filtro.busca);
  const data = filtro.data.trim();

  return ordenados.filter((ag) => {
    if (buscaNorm && !normalizar(ag.titulo).includes(buscaNorm)) return false;
    if (data) {
      const d = parseInicio(ag.inicio);
      if (!d || ymdLocal(d) !== data) return false;
    }
    return true;
  });
}

/** True se algum dos 3 filtros esta ativo (distingue empty "filtro" x "janela"). */
export function temFiltroAtivo(filtro: FiltroAgendamentos): boolean {
  return filtro.periodo !== 'todos' || filtro.busca.trim() !== '' || filtro.data.trim() !== '';
}
