/**
 * Agrupamento por SEMANA pra visão "Semana" da Agenda (Bloco A — grade CSS de 7
 * colunas, SEM lib de calendário). Puro e testável.
 *
 * A semana é segunda→domingo (padrão BR pra agenda de trabalho). Recebe a lista
 * crua (a mesma -7/+14d do backend), um `offset` de semanas (0 = semana atual,
 * +1 = próxima, -1 = passada) e a referência `now`. Devolve 7 colunas com:
 *   - dateKey 'YYYY-MM-DD' local (pro filtro/título),
 *   - rótulos curtos (Seg…Dom) e número do dia,
 *   - `hoje` (marca a coluna do dia atual),
 *   - os agendamentos daquele dia, ordenados por horário ASC (sem hora no fim).
 *
 * Eventos sem `inicio` válido não entram em nenhuma coluna (não têm dia) — a tela
 * mostra a contagem deles à parte, pra não sumirem silenciosamente.
 */
import { parseInicio } from './agendamentos';
import type { Agendamento } from './api-types';

const WD_CURTO = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const WD_LONGO = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

export interface DiaSemanaAgenda {
  /** 'YYYY-MM-DD' local. */
  dateKey: string;
  /** 'Seg' | 'Ter' … 'Dom'. */
  curto: string;
  /** Número do dia do mês. */
  diaNum: number;
  /** "segunda, 9 de junho" — acessibilidade. */
  longo: string;
  /** True se é o dia de `now` (realce da coluna). */
  hoje: boolean;
  /** Agendamentos do dia, ASC por horário (sem hora vai pro fim, ordem estável). */
  eventos: Agendamento[];
}

export interface SemanaAgenda {
  /** Os 7 dias (segunda→domingo). */
  dias: DiaSemanaAgenda[];
  /** Rótulo do range, ex.: "9–15 de junho" ou "29 de jun – 5 de jul". */
  titulo: string;
  /** dateKey da segunda e do domingo (pra navegação/limites). */
  inicioKey: string;
  fimKey: string;
}

/** 'YYYY-MM-DD' do dia LOCAL (não UTC). */
function dateKeyLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Início do dia local (00:00). */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** A segunda-feira (00:00 local) da semana que contém `d`. getDay: 0=dom…6=sáb. */
function mondayOf(d: Date): Date {
  const base = startOfDay(d);
  const wd = base.getDay(); // 0=dom
  const back = wd === 0 ? 6 : wd - 1; // dom volta 6; seg volta 0
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() - back);
}

/** Índice 0..6 (Seg..Dom) de um Date.getDay() (0=dom..6=sáb). */
function segIndex(getDay: number): number {
  return getDay === 0 ? 6 : getDay - 1;
}

/** "9–15 de junho" / "29 de jun – 5 de jul" (cruza mês). */
function tituloRange(seg: Date, dom: Date): string {
  const mesIgual = seg.getMonth() === dom.getMonth();
  if (mesIgual) {
    return `${seg.getDate()}–${dom.getDate()} de ${MESES[seg.getMonth()]}`;
  }
  const ms = MESES[seg.getMonth()].slice(0, 3);
  const md = MESES[dom.getMonth()].slice(0, 3);
  return `${seg.getDate()} de ${ms} – ${dom.getDate()} de ${md}`;
}

/**
 * Monta a semana (segunda→domingo) deslocada por `offset` semanas a partir de
 * `now`, distribuindo `agendamentos` nas colunas por dia local.
 */
export function buildSemana(
  agendamentos: Agendamento[],
  offset = 0,
  now = new Date(),
): SemanaAgenda {
  const seg = mondayOf(now);
  seg.setDate(seg.getDate() + offset * 7);
  const hojeKey = dateKeyLocal(startOfDay(now));

  const dias: DiaSemanaAgenda[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(seg.getFullYear(), seg.getMonth(), seg.getDate() + i);
    dias.push({
      dateKey: dateKeyLocal(d),
      curto: WD_CURTO[i],
      diaNum: d.getDate(),
      longo: `${WD_LONGO[i]}, ${d.getDate()} de ${MESES[d.getMonth()]}`,
      hoje: dateKeyLocal(d) === hojeKey,
      eventos: [],
    });
  }

  // Distribui cada evento na coluna do seu dia (se cair nesta semana).
  const inicioKey = dias[0].dateKey;
  const fimKey = dias[6].dateKey;
  for (const ag of agendamentos) {
    const d = parseInicio(ag.inicio);
    if (!d) continue; // sem dia válido -> não entra na grade
    const key = dateKeyLocal(startOfDay(d));
    if (key < inicioKey || key > fimKey) continue;
    const idx = segIndex(d.getDay());
    dias[idx].eventos.push(ag);
  }

  // Ordena cada coluna por horário ASC; sem hora (Infinity) vai pro fim, estável.
  const ts = (ag: Agendamento) => parseInicio(ag.inicio)?.getTime() ?? Number.POSITIVE_INFINITY;
  for (const dia of dias) {
    dia.eventos.sort((a, b) => ts(a) - ts(b));
  }

  const dom = new Date(seg.getFullYear(), seg.getMonth(), seg.getDate() + 6);
  return {
    dias,
    titulo: tituloRange(seg, dom),
    inicioKey,
    fimKey,
  };
}

/** Quantos eventos sem `inicio` válido (mostrados à parte na visão Semana). */
export function semDataCount(agendamentos: Agendamento[]): number {
  return agendamentos.filter((ag) => parseInicio(ag.inicio) === null).length;
}
