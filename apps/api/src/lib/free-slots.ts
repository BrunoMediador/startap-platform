/**
 * free-slots — calcula slots de agendamento livres por bot.
 *
 * Lê horários de funcionamento e serviços do clone (flow_clones) e cruza com
 * eventos do Google Calendar para devolver a string {agenda} pronta pra IA
 * consumir. A IA não precisa "raciocinar disponibilidade" — recebe a tabela
 * já filtrada e formatada por serviço e dia.
 *
 * Fallback: se o slot não está em flow_clones (caso da matriz teste_barbearia
 * rodando direto, ou clone sem config), usa BUILTIN_DEFAULTS — mantém compat
 * com o comportamento anterior do bot.
 */
import type { CalendarEvent } from '@startap/integrations/google-calendar';
import type { HorariosFuncionamento, ServicoConfig } from '@startap/db';
import { flowClones } from '@startap/db';

const TZ = 'America/Sao_Paulo';

export interface ScheduleConfig {
  /** Janelas de atendimento por weekday (0=Dom .. 6=Sab). null = fechado. */
  work: Record<number, [number, number] | null>;
  /** Serviços disponíveis (nome + duração em minutos). */
  services: Array<{ name: string; min: number }>;
  /** Origem da config — útil para log/debug. */
  source: 'flow_clones' | 'defaults';
}

// ---- Defaults (preservam comportamento do bot pre-PR-B) ---------------------

const BUILTIN_DEFAULTS: ScheduleConfig = {
  work: {
    0: null,
    1: [8 * 60, 19 * 60],
    2: [8 * 60, 19 * 60],
    3: [8 * 60, 19 * 60],
    4: [8 * 60, 19 * 60],
    5: [8 * 60, 19 * 60],
    6: [7 * 60, 17 * 60],
  },
  services: [
    { name: 'Corte', min: 40 },
    { name: 'Barba', min: 20 },
    { name: 'Sobrancelha', min: 20 },
    { name: 'Corte+Barba', min: 60 },
    { name: 'Pezinho', min: 20 },
    { name: 'Relaxamento', min: 40 },
    { name: 'Corte pigmentado', min: 60 },
  ],
  source: 'defaults',
};

// ---- Conversão jsonb -> ScheduleConfig --------------------------------------

const _DIA_TO_WEEKDAY: Record<keyof HorariosFuncionamento, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

function parseHHMM(s: string | null | undefined): number | null {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number.parseInt(m[1] ?? '0', 10);
  const mm = Number.parseInt(m[2] ?? '0', 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

function horariosToWork(
  horarios: HorariosFuncionamento | null,
): Record<number, [number, number] | null> | null {
  if (!horarios || typeof horarios !== 'object') return null;
  const out: Record<number, [number, number] | null> = {};
  for (const [key, weekday] of Object.entries(_DIA_TO_WEEKDAY)) {
    const dia = horarios[key as keyof HorariosFuncionamento];
    if (!dia || dia.fechado) {
      out[weekday] = null;
      continue;
    }
    const abre = parseHHMM(dia.abre);
    const fecha = parseHHMM(dia.fecha);
    if (abre == null || fecha == null || abre >= fecha) {
      out[weekday] = null;
      continue;
    }
    out[weekday] = [abre, fecha];
  }
  return out;
}

function servicosToServices(
  servicos: ServicoConfig[] | null,
): Array<{ name: string; min: number }> | null {
  if (!Array.isArray(servicos) || servicos.length === 0) return null;
  return servicos
    .filter((s) => s && typeof s.nome === 'string' && s.nome.trim() !== '')
    .map((s) => ({
      name: String(s.nome).trim(),
      min: Number.isFinite(Number(s.duracao_min)) && Number(s.duracao_min) > 0
        ? Math.round(Number(s.duracao_min))
        : 30,
    }));
}

/**
 * Carrega config do slot. Se o slot está em flow_clones e tem horarios+servicos
 * preenchidos, usa-os; caso contrário usa BUILTIN_DEFAULTS.
 */
export async function loadScheduleConfig(slot: string): Promise<ScheduleConfig> {
  try {
    const clone = await flowClones.getCloneBySlot(slot);
    if (!clone) return BUILTIN_DEFAULTS;

    const work = horariosToWork(clone.horarios_funcionamento);
    const services = servicosToServices(clone.servicos);

    // Politica: se UMA das duas configs estiver vazia ou invalida, cai pro
    // default — evita rodar com config parcial que gera prompt confuso.
    if (!work || !services || services.length === 0) {
      return BUILTIN_DEFAULTS;
    }

    return { work, services, source: 'flow_clones' };
  } catch {
    return BUILTIN_DEFAULTS;
  }
}

// ---- Formatação dos slots (extraído de teste_barbearia.formatarAgenda) -----

interface SpParts {
  wd: number;
  key: string;
  label: string;
  mins: number;
}

function spParts(date: Date): SpParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((a, p) => {
      a[p.type] = p.value;
      return a;
    }, {});
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const wd = weekdayNames.indexOf(parts.weekday ?? '');
  return {
    wd,
    key: `${parts.year}-${parts.month}-${parts.day}`,
    label: `${parts.day}/${parts.month}`,
    mins: Number.parseInt(parts.hour ?? '0', 10) * 60 + Number.parseInt(parts.minute ?? '0', 10),
  };
}

function hhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const DIAS_LABEL = [
  'DOMINGO',
  'SEGUNDA-FEIRA',
  'TERCA-FEIRA',
  'QUARTA-FEIRA',
  'QUINTA-FEIRA',
  'SEXTA-FEIRA',
  'SABADO',
];

/**
 * Formata a string {agenda} com slots disponíveis por dia e serviço.
 * Passada pronta pra IA — ela não precisa cruzar GCal × horários × duração.
 *
 * Slots iniciam de 20 em 20 min. Próximo slot do dia atual respeita ceil de 10
 * min sobre o relógio (evita oferecer um slot que já começou ou começa em <10min).
 */
export function formatarAgendaComConfig(
  events: CalendarEvent[],
  config: ScheduleConfig,
  opts: { daysAhead?: number; slotStepMin?: number } = {},
): string {
  const daysAhead = opts.daysAhead ?? 5;
  const stepMin = opts.slotStepMin ?? 20;
  const now = new Date();

  const occupied: Record<string, Array<{ s: number; e: number }>> = {};
  for (const ev of events) {
    const s = new Date(ev.start.dateTime ?? `${ev.start.date}T00:00:00`);
    const e = new Date(ev.end.dateTime ?? `${ev.end.date}T00:00:00`);
    const sp = spParts(s);
    const sep = spParts(e);
    const key = sp.key;
    if (!occupied[key]) occupied[key] = [];
    occupied[key].push({ s: sp.mins, e: sep.mins });
  }

  const blocks: string[] = [];

  for (let offset = 0; offset <= daysAhead; offset++) {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    const sp = spParts(date);
    const wh = config.work[sp.wd];
    if (!wh) continue;

    const [wStart, wEnd] = wh;
    let minStart = wStart;
    if (offset === 0) {
      minStart = Math.max(wStart, Math.ceil((sp.mins + 10) / stepMin) * stepMin);
    }

    const occ = occupied[sp.key] ?? [];
    let label: string;
    if (offset === 0) label = `HOJE (${sp.label})`;
    else if (offset === 1) label = `AMANHA (${sp.label})`;
    else label = `${DIAS_LABEL[sp.wd]} (${sp.label})`;

    const lines: string[] = [];
    for (const svc of config.services) {
      const slots: string[] = [];
      for (let t = minStart; t + svc.min <= wEnd; t += stepMin) {
        if (!occ.some((o) => t < o.e && t + svc.min > o.s)) {
          slots.push(hhmm(t));
        }
      }
      lines.push(
        `  ${svc.name} (${svc.min}min): ${slots.length ? slots.join(', ') : 'SEM DISPONIBILIDADE'}`,
      );
    }
    blocks.push(`${label}:\n${lines.join('\n')}`);
  }

  return blocks.join('\n\n') || 'Sem horarios disponiveis.';
}
