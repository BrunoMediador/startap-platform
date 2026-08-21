import type { Agendamento } from './api-types';

export const BLOQUEIO_PREFIX = 'Bloqueio:';

export const BLOQUEIO_TIPO_LABEL: Record<
  'almoco' | 'ausencia' | 'ferias' | 'indisponivel',
  string
> = {
  almoco: 'Almoco',
  ausencia: 'Ausencia',
  ferias: 'Ferias',
  indisponivel: 'Indisponivel',
};

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

export function isAgendaBloqueio(agendamento: Pick<Agendamento, 'titulo'>): boolean {
  return agendamento.titulo.trim().startsWith(BLOQUEIO_PREFIX);
}

export function separarAgendamentosDeBloqueios(agendamentos: Agendamento[]) {
  return {
    agendamentos: agendamentos.filter((item) => !isAgendaBloqueio(item)),
    bloqueios: agendamentos.filter((item) => isAgendaBloqueio(item)),
  };
}

export function formatDateInputInTimeZone(timeZone: string, at: Date): string {
  return at.toLocaleDateString('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function formatTimeInputInTimeZone(timeZone: string, at: Date): string {
  return at.toLocaleTimeString('en-GB', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function defaultBloqueioFormValues(timeZone: string, now: Date = new Date()) {
  const inicio = new Date(now.getTime() + 30 * 60_000);
  const fim = new Date(inicio.getTime() + 60 * 60_000);
  return {
    inicioData: formatDateInputInTimeZone(timeZone, inicio),
    inicioHora: formatTimeInputInTimeZone(timeZone, inicio),
    fimData: formatDateInputInTimeZone(timeZone, fim),
    fimHora: formatTimeInputInTimeZone(timeZone, fim),
  };
}

export function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string): string | null {
  const matchDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const matchTime = /^(\d{2}):(\d{2})$/.exec(time);
  if (!matchDate || !matchTime) return null;

  const year = Number(matchDate[1]);
  const month = Number(matchDate[2]);
  const day = Number(matchDate[3]);
  const hour = Number(matchTime[1]);
  const minute = Number(matchTime[2]);

  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  for (let i = 0; i < 4; i += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const actualUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
    const diff = desiredUtc - actualUtc;
    guess += diff;
    if (diff === 0) break;
  }

  const finalParts = zonedParts(new Date(guess), timeZone);
  const sameWallTime =
    finalParts.year === year &&
    finalParts.month === month &&
    finalParts.day === day &&
    finalParts.hour === hour &&
    finalParts.minute === minute;

  return sameWallTime ? new Date(guess).toISOString() : null;
}
