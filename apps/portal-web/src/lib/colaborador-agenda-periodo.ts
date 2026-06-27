import { parseInicio } from './agendamentos';
/**
 * Lógica pura do FILTRO DE DATA da agenda do colaborador (read-only). Espelha o
 * mental model do seletor de período do dono (lib/billing-periodo + PeriodSelector),
 * mas a agenda olha PASSADO + FUTURO numa só janela [de, ate] — não tem balde.
 *
 * O endpoint `GET /portal/colaborador/agenda` aceita `past`/`ahead` (dias relativos
 * a hoje, capados em past<=30 / ahead<=60). Aqui convertemos a janela [de, ate]
 * escolhida no picker pra esse par (`periodoParaPastAhead`) — o fetch traz só o
 * intervalo pedido (evita o teto de 100 eventos morder o futuro) — e depois
 * `filtrarPorPeriodo` apara client-side pro intervalo EXATO (past/ahead é simétrico
 * em dias inteiros e pode trazer pontas de sobra).
 *
 * Tudo aqui é função pura (fuso LOCAL, sem React) pra testar sem jsdom — convenção
 * do portal. Os LIMITES do picker já travam o usuário dentro do que o backend
 * suporta (de >= hoje-30, ate <= hoje+60), então não há "clamp silencioso".
 */
import type { Agendamento } from './api-types';
import type { Periodo, PeriodoLimites, PeriodoPreset } from './billing-periodo';
import { toISODate } from './format';

/** Teto da janela suportado pelo backend (portal-colaborador.ts). */
export const PAST_CAP = 30;
export const AHEAD_CAP = 60;

/** Janela default = passado recente + próximos (mesma do backend: -7 / +14). */
const DEFAULT_PAST = 7;
const DEFAULT_AHEAD = 14;

/** "YYYY-MM-DD" daqui a N dias (N pode ser negativo). Fuso local. */
function plusDaysISO(days: number, now = new Date()): string {
  return toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/** ms da meia-noite local de uma data "YYYY-MM-DD" (null se vazia/inválida). */
function dateOnlyMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Período DEFAULT da agenda: hoje-7 .. hoje+14 (preserva o que era exibido antes). */
export function agendaPeriodoPadrao(now = new Date()): Periodo {
  return { de: plusDaysISO(-DEFAULT_PAST, now), ate: plusDaysISO(DEFAULT_AHEAD, now) };
}

/**
 * Limites do date-picker: trava o usuário dentro do que o backend suporta
 * (de nunca antes de hoje-30; ate nunca depois de hoje+60) e mantém a janela
 * coerente (de <= ate).
 */
export function agendaPeriodoLimites(value: Periodo, now = new Date()): PeriodoLimites {
  const min = plusDaysISO(-PAST_CAP, now);
  const max = plusDaysISO(AHEAD_CAP, now);
  return {
    de: { min, max: value.ate || max },
    ate: { min: value.de || min, max },
  };
}

/** Presets rápidos da agenda: cobre o dia, próximos e o passado recente. */
export function agendaPeriodoPresets(now = new Date()): PeriodoPreset[] {
  const hoje = toISODate(now);
  return [
    { label: 'Hoje', value: { de: hoje, ate: hoje } },
    { label: 'Próx. 7 dias', value: { de: hoje, ate: plusDaysISO(7, now) } },
    { label: 'Próx. 30 dias', value: { de: hoje, ate: plusDaysISO(30, now) } },
    { label: 'Últimos 7 dias', value: { de: plusDaysISO(-7, now), ate: hoje } },
  ];
}

/**
 * Converte a janela [de, ate] em `past`/`ahead` (dias relativos a hoje) pro fetch,
 * capados ao que o backend aceita. `de` no futuro -> past=0; `ate` no passado ->
 * ahead=1. Datas vazias caem no default (-7/+14).
 */
export function periodoParaPastAhead(
  value: Periodo,
  now = new Date(),
): { past: number; ahead: number } {
  const hojeMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  const deMs = dateOnlyMs(value.de);
  const ateMs = dateOnlyMs(value.ate);
  const past = deMs == null ? DEFAULT_PAST : clamp(Math.ceil((hojeMs - deMs) / DAY), 0, PAST_CAP);
  const ahead =
    ateMs == null ? DEFAULT_AHEAD : clamp(Math.ceil((ateMs - hojeMs) / DAY), 1, AHEAD_CAP);
  return { past, ahead };
}

/**
 * Apara a lista pro intervalo EXATO [de, ate] (inclusive, por DIA local). Eventos
 * sem `inicio` (sem horário definido) são mantidos — não somem da tela. Já devolve
 * na ordem original (o backend manda ASC por início).
 */
export function filtrarPorPeriodo(agendamentos: Agendamento[], periodo: Periodo): Agendamento[] {
  const deMs = dateOnlyMs(periodo.de);
  const ateMs = dateOnlyMs(periodo.ate);
  if (deMs == null && ateMs == null) return agendamentos;
  const fimDoAte = ateMs == null ? null : ateMs + 86_400_000 - 1; // fim do dia "ate"
  return agendamentos.filter((ag) => {
    const d = parseInicio(ag.inicio);
    if (!d) return true; // sem horário -> não filtra fora
    const t = d.getTime();
    if (deMs != null && t < deMs) return false;
    if (fimDoAte != null && t > fimDoAte) return false;
    return true;
  });
}
