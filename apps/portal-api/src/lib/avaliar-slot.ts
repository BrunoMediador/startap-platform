import type { gcal } from '@startap/integrations';
/**
 * Helper COMPARTILHADO de avaliação de um slot de agendamento (data+hora+serviço) contra
 * a config do tenant (horários/serviços) e a agenda GCal — extraído do POST
 * /portal/agendamentos (Missão 020 F4) para ser reusado pelo preview de recorrência
 * (POST /portal/agendamentos/recorrencia/preview, SCRUM — agenda recorrente).
 *
 * 🔴 Fonte ÚNICA das validações: janela de aceitação (hoje..+POST_MAX_AHEAD_DAYS),
 * início não-passado para HOJE, horário de funcionamento do dia, e double-check anti-corrida
 * contra o GCal. O POST atual foi refatorado para usar ESTES MESMOS helpers — nunca
 * duplicar a lógica aqui, senão as duas checagens (agendamento único vs preview de
 * série) divergem com o tempo (é exatamente o bug que este módulo existe para evitar).
 *
 * Dividido em DUAS funções (não uma só) porque o caller original (POST atual) resolve
 * o client GCal SOMENTE DEPOIS de validar janela/horário — resolver a agenda do
 * colaborador é I/O que não faz sentido pagar para um slot já claramente inválido
 * (ex.: data no passado). `avaliarJanela` é pura (sem client) e cobre esse caminho
 * cedo; `avaliarConflito` faz o double-check contra o GCal com o client já resolvido.
 * `avaliarSlot` compõe as duas para callers (como o preview) que não precisam da
 * mesma ordem de resolução.
 */
import {
  type ScheduleConfig,
  hhmmToMins,
  nowPartsInTz,
  weekdayOfDateKey,
  zonedWallTimeToUtc,
} from '@startap/integrations/scheduling';

export type AvaliarSlotStatus =
  | 'livre'
  | 'ocupado'
  | 'fora_do_horario'
  | 'fechado'
  | 'fora_da_janela'
  | 'passado';

export interface AvaliarSlotConflito {
  inicio: string | null;
  fim: string | null;
}

export interface AvaliarSlotResult {
  status: AvaliarSlotStatus;
  /** Só presente quando status === 'ocupado'. */
  conflito?: AvaliarSlotConflito;
  /** Instante absoluto (UTC) do início/fim — só quando calculável (status não é data-invalida). */
  startUtc?: Date;
  endUtc?: Date;
}

export interface AvaliarSlotClient {
  listEvents(opts: { timeMin: string; timeMax: string }): Promise<gcal.CalendarEvent[]>;
}

interface AvaliarJanelaInput {
  config: ScheduleConfig;
  /** YYYY-MM-DD. */
  data: string;
  /** HH:mm. */
  hora: string;
  /** Duração do serviço em minutos (já resolvida do catálogo pelo caller). */
  duracaoMin: number;
  /** Teto de dias à frente aceito (mesmo `POST_MAX_AHEAD_DAYS`/`MAX_AHEAD_DAYS` do resto do módulo — passado pelo caller, nunca hardcoded aqui). */
  maxAheadDays: number;
  /** Referência de "agora" — injetável só para teste; default `new Date()`. */
  now?: Date;
}

/**
 * Fase 1 (SEM I/O): valida janela de aceitação, piso do dia e horário de funcionamento.
 * Não toca o GCal — barato o bastante para rodar antes de resolver qualquer agenda.
 *
 * Contrato de status (retorna cedo, sem chegar a 'ocupado'/'livre' — quem decide isso é
 * `avaliarConflito`, na Fase 2):
 *  - 'fechado'          : data calendarialmente inexistente (weekdayOfDateKey null — ex.
 *                         31/02). Único caso de 'fechado' — o POST original tratava isso
 *                         num 400 separado ANTES de sequer chamar esta validação; o preview
 *                         (que só tem este helper) devolve 'fechado' pro caller decidir.
 *  - 'fora_da_janela'   : data > hoje+maxAheadDays.
 *  - 'passado'          : data no passado, ou hoje com hora anterior ao relógio atual.
 *  - 'fora_do_horario'  : dia SEM janela de funcionamento (dia fechado da semana, ex.
 *                         domingo) OU horário/duração que não cabe na janela do dia —
 *                         mesma condição única (`!janela || ...`) do POST original,
 *                         preservada byte-a-byte (o POST nunca distinguiu os dois).
 *  - 'livre'            : passou nas checagens síncronas — falta só o double-check no GCal.
 */
export function avaliarJanela(input: AvaliarJanelaInput): AvaliarSlotResult {
  const { config, data, hora, duracaoMin, maxAheadDays } = input;
  const tz = config.timezone;
  const now = input.now ?? new Date();

  const wd = weekdayOfDateKey(data, tz);
  if (wd === null) {
    return { status: 'fechado' };
  }

  const agora = nowPartsInTz(now, tz);
  const limite = nowPartsInTz(new Date(now.getTime() + maxAheadDays * 86_400_000), tz);
  if (data > limite.dateKey) {
    return { status: 'fora_da_janela' };
  }

  const startMins = hhmmToMins(hora);
  const endMins = startMins + duracaoMin;

  if (data < agora.dateKey || (data === agora.dateKey && startMins < agora.mins)) {
    return { status: 'passado' };
  }

  const janela = config.work[wd];
  if (!janela || startMins < janela[0] || endMins > janela[1]) {
    return { status: 'fora_do_horario' };
  }

  const startUtc = zonedWallTimeToUtc(data, startMins, tz);
  const endUtc = zonedWallTimeToUtc(data, endMins, tz);
  return { status: 'livre', startUtc, endUtc };
}

interface AvaliarConflitoInput {
  /** Cliente GCal já resolvido (agenda do clone ou do colaborador-alvo no estabelecimento). */
  client: AvaliarSlotClient;
  startUtc: Date;
  endUtc: Date;
  /** eventId a ignorar na checagem (uso: PATCH revalidando o próprio evento). */
  ignorarEventId?: string;
}

/**
 * Fase 2 (I/O): double-check anti-corrida contra o GCal para uma janela [startUtc,endUtc)
 * JÁ validada pela Fase 1. Função de leitura pura (I/O só via `client.listEvents`).
 */
export async function avaliarConflito(input: AvaliarConflitoInput): Promise<AvaliarSlotResult> {
  const { client, startUtc, endUtc, ignorarEventId } = input;
  const existing = await client.listEvents({
    timeMin: startUtc.toISOString(),
    timeMax: endUtc.toISOString(),
  });
  const conflito = existing.find((ev) => {
    if (ignorarEventId && ev.id === ignorarEventId) return false;
    const evStart = new Date(ev.start.dateTime ?? `${ev.start.date}T00:00:00`).getTime();
    const evEnd = new Date(ev.end.dateTime ?? `${ev.end.date}T00:00:00`).getTime();
    return evStart < endUtc.getTime() && evEnd > startUtc.getTime();
  });
  if (conflito) {
    return {
      status: 'ocupado',
      conflito: {
        inicio: conflito.start.dateTime ?? conflito.start.date ?? null,
        fim: conflito.end.dateTime ?? conflito.end.date ?? null,
      },
      startUtc,
      endUtc,
    };
  }
  return { status: 'livre', startUtc, endUtc };
}

export interface AvaliarSlotInput extends AvaliarJanelaInput {
  client: AvaliarSlotClient;
  ignorarEventId?: string;
}

/**
 * Composição das duas fases (janela + double-check) num único await — para callers
 * que não precisam da mesma ordem de resolução do POST original (ex.: o preview de
 * recorrência, que já resolveu a agenda do colaborador antes de avaliar cada ocorrência).
 * NÃO GRAVA NADA — leitura pura.
 */
export async function avaliarSlot(input: AvaliarSlotInput): Promise<AvaliarSlotResult> {
  const janela = avaliarJanela(input);
  if (janela.status !== 'livre') return janela;
  return avaliarConflito({
    client: input.client,
    startUtc: janela.startUtc as Date,
    endUtc: janela.endUtc as Date,
    ignorarEventId: input.ignorarEventId,
  });
}
