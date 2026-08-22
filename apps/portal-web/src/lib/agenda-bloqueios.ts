import type {
  AgendaBloqueioInput,
  AgendaBloqueioPeriodicidade,
  CriarAgendaBloqueioSerieBody,
  CriarAgendaBloqueioSerieResponse,
  PreviewAgendaBloqueioRecorrencia,
  PreviewAgendaBloqueioRecorrenciaBody,
  PreviewOcorrenciaStatus,
  RemoverAgendaBloqueioSerieResponse,
} from './api-types';
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

export const BLOQUEIO_PERIODICIDADE_LABELS: Record<AgendaBloqueioPeriodicidade, string> = {
  diaria: 'Todos os dias',
  semanal: 'Toda semana',
  mensal: 'Todo mes',
  trimestral: 'A cada 3 meses',
  semestral: 'A cada 6 meses',
};

export interface RevisaoAgendaBloqueioRecorrencia extends PreviewAgendaBloqueioRecorrencia {}

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

export function buildPreviewAgendaBloqueioRecorrenciaBody(args: {
  base: AgendaBloqueioInput;
  periodicidade: AgendaBloqueioPeriodicidade;
  ocorrencias: number;
}): PreviewAgendaBloqueioRecorrenciaBody {
  return {
    ...args.base,
    periodicidade: args.periodicidade,
    ocorrencias: args.ocorrencias,
  };
}

export function initRevisaoAgendaBloqueioRecorrencia(
  previews: PreviewAgendaBloqueioRecorrencia[],
): RevisaoAgendaBloqueioRecorrencia[] {
  return previews.map((preview) => ({ ...preview }));
}

export function buildCriarAgendaBloqueioSerieBody(args: {
  base: AgendaBloqueioInput;
  periodicidade: AgendaBloqueioPeriodicidade;
  ocorrencias: number;
}): CriarAgendaBloqueioSerieBody {
  return {
    ...args.base,
    periodicidade: args.periodicidade,
    ocorrencias: args.ocorrencias,
  };
}

export function buildAgendaBloqueioRecorrenciaKey(args: {
  base: AgendaBloqueioInput;
  periodicidade: AgendaBloqueioPeriodicidade;
  ocorrencias: number;
}): string {
  return JSON.stringify({
    ...args.base,
    motivo: args.base.motivo?.trim() ?? '',
    colaborador_id: args.base.colaborador_id ?? null,
    periodicidade: args.periodicidade,
    ocorrencias: args.ocorrencias,
  });
}

export function isAgendaBloqueioRecorrenciaLivre(
  status: PreviewOcorrenciaStatus | null | undefined,
): boolean {
  return status === 'livre';
}

export function statusAgendaBloqueioRecorrenciaLabel(
  status: PreviewOcorrenciaStatus | null | undefined,
): string {
  switch (status) {
    case 'livre':
      return 'Livre';
    case 'ocupado':
      return 'Ja existe algo marcado';
    case 'fora_do_horario':
      return 'Fora do horario de funcionamento';
    case 'fechado':
      return 'Fechado nesse dia';
    case 'fora_da_janela':
      return 'Fora do periodo permitido';
    case 'passado':
      return 'Esse horario ja passou';
    default:
      return 'Ocupado ou indisponivel nesse horario';
  }
}

export function falhaAgendaBloqueioSerieLabel(reason?: string | null): string {
  if (!reason) return 'Nao foi possivel confirmar essa ocorrencia na Agenda Google.';
  if (reason === 'gcal_rate_limit') return 'A agenda ficou sobrecarregada nesse momento';
  if (reason === 'erro_gcal') return 'Nao foi possivel confirmar com a agenda';
  if (
    reason === 'livre' ||
    reason === 'ocupado' ||
    reason === 'fora_do_horario' ||
    reason === 'fechado' ||
    reason === 'fora_da_janela' ||
    reason === 'passado'
  ) {
    return statusAgendaBloqueioRecorrenciaLabel(reason);
  }
  return 'Nao foi possivel confirmar essa ocorrencia na Agenda Google.';
}

export function countRemovidosAgendaBloqueioSerie(
  resposta: RemoverAgendaBloqueioSerieResponse,
): number {
  return resposta.removidos.length;
}

export function resumoRemocaoAgendaBloqueioSerie(
  resposta: RemoverAgendaBloqueioSerieResponse,
): string {
  const removidos = resposta.removidos.length;
  const falhas = resposta.falhas.length;
  if (falhas === 0) {
    return removidos === 1
      ? '1 próxima ocorrência removida.'
      : `${removidos} próximas ocorrências removidas.`;
  }
  return `Remoção parcial: ${removidos} removidos e ${falhas} falha${falhas === 1 ? '' : 's'}. A lista foi atualizada.`;
}

export function resumoResultadoAgendaBloqueioSerie(
  resposta: CriarAgendaBloqueioSerieResponse,
): string {
  const { criados, falhas } = resposta;
  if (falhas.length === 0) {
    return criados.length === 1 ? '1 bloqueio criado.' : `${criados.length} bloqueios criados.`;
  }
  if (criados.length === 0) {
    return 'Nenhum bloqueio foi criado. Revise a serie e tente de novo.';
  }
  const total = criados.length + falhas.length;
  return `${criados.length} de ${total} bloqueios criados — ${falhas.length} nao entrou porque a agenda mudou.`;
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
