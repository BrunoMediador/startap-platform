/**
 * estabelecimento.ts — montagem da agenda multi-colaborador (ADR 0023/0024, Fase A).
 *
 * GATING: este módulo SÓ é alcançado quando product_type='estabelecimento' E a flag
 * ESTABELECIMENTO_ENABLED está ON (o caller, em apps/api, faz os dois gates antes de
 * chamar daqui). O caminho individual (free-slots.ts) fica BYTE-A-BYTE inalterado e
 * 100% independente deste arquivo — nada aqui é importado pelo fluxo individual.
 *
 * O que faz:
 *  1. Recebe os colaboradores ATIVOS já resolvidos (ColaboradorGcal[] de
 *     getGcalsForSlot) — cada um com seu calendarId e o client (mesma SA do clone).
 *  2. Atribui IDs CURTOS ESTÁVEIS (C1, C2, …) por ORDEM de retorno do resolvedor
 *     (que já vem ORDER BY ordem, id — estável entre turnos enquanto a equipe não muda).
 *  3. Consulta a ocupação de TODOS de uma vez via freebusy.query batched (1 chamada,
 *     até 50 calendarId — ADR 0024 §5).
 *  4. Monta o bloco [PROFISSIONAIS] (id + nome + serviços) e o [HORARIOS DISPONIVEIS]
 *     ROTULADO POR COLABORADOR, reusando a MESMA grade do bot individual
 *     (formatarAgendaComConfig — step = duração, piso de 10min pra hoje, overlap).
 *  5. Inclui a REGRA DE DESAMBIGUAÇÃO obrigatória pra homônimos.
 *
 * O LLM NUNCA recebe calendarId cru — só o id curto (C1…). O servidor resolve o
 * calendarId a partir do id curto via resolveColaboradorByShortId (server-side),
 * validando contra a lista do slot — ver inserir_agendamento no apps/api.
 */
import type { CalendarEvent, FreeBusyResult } from '../google-calendar/client.js';
import type { ColaboradorGcal } from '../google-calendar/per-clone.js';
import { type ScheduleConfig, formatarAgendaComConfig } from './free-slots.js';

/** Timezone canônica (reexporta a do free-slots pra não divergir). */
export { TZ } from './free-slots.js';

/**
 * Colaborador já decorado com o id curto estável (C1, C2…) que vai pro prompt.
 * `client` e `calendarId` ficam SERVER-SIDE (nunca entram no texto do prompt).
 */
export interface ColaboradorAgenda extends ColaboradorGcal {
  /** Id curto estável exposto ao LLM (C1, C2, …). */
  shortId: string;
}

export interface EstabelecimentoContext {
  /** Colaboradores decorados com shortId, na ordem estável do resolvedor. */
  colaboradores: ColaboradorAgenda[];
  /** Bloco [PROFISSIONAIS] pronto pra injetar no contexto do prompt. */
  profissionaisBlock: string;
  /** Bloco [HORARIOS DISPONIVEIS] rotulado por colaborador. */
  horariosBlock: string;
}

/** Gera o id curto a partir do índice (0 → C1). Estável enquanto a ordem não muda. */
function shortIdFor(index: number): string {
  return `C${index + 1}`;
}

/**
 * Decora os colaboradores com shortId, preservando a ordem do resolvedor.
 * Exposto separadamente porque o caller (inserir_agendamento) precisa da MESMA
 * lista decorada pra resolver o id curto server-side (sem reconstruir a numeração).
 */
export function decorateColaboradores(colaboradores: ColaboradorGcal[]): ColaboradorAgenda[] {
  return colaboradores.map((c, i) => ({ ...c, shortId: shortIdFor(i) }));
}

/**
 * Resolve um id curto (C1…) OU um colaboradorId numérico para o colaborador
 * correspondente, SERVER-SIDE, validando contra a lista decorada daquele slot.
 *
 * Aceita as duas formas porque o LLM pode passar o id curto do bloco (preferido)
 * ou o colaboradorId numérico — ambos são validados contra a MESMA lista do slot;
 * qualquer valor fora da lista retorna null (rejeição). NUNCA aceita calendarId.
 *
 * Comparação de shortId é case-insensitive e tolera espaço ("c1", " C1 ").
 */
export function resolveColaboradorByShortId(
  colaboradores: ColaboradorAgenda[],
  rawId: string,
): ColaboradorAgenda | null {
  const v = String(rawId ?? '').trim();
  if (v === '') return null;
  const upper = v.toUpperCase();
  const byShort = colaboradores.find((c) => c.shortId === upper);
  if (byShort) return byShort;
  // Fallback: id numérico do colaborador (clone_colaboradores.id), também validado.
  if (/^\d+$/.test(v)) {
    const idNum = Number(v);
    const byNum = colaboradores.find((c) => c.colaboradorId === idNum);
    if (byNum) return byNum;
  }
  return null;
}

/**
 * Converte os intervalos BUSY do freebusy.query em objetos CalendarEvent-shaped,
 * pra reusar formatarAgendaComConfig (que cruza eventos × horário × duração).
 * Só os campos start/end importam pro cálculo de overlap.
 */
function busyToEvents(busy: FreeBusyResult[string] | undefined): CalendarEvent[] {
  if (!busy || busy.length === 0) return [];
  return busy.map((b, i) => ({
    id: `busy-${i}`,
    summary: 'busy',
    start: { dateTime: b.start },
    end: { dateTime: b.end },
  }));
}

/** Sanitiza o nome do colaborador pro prompt (sem quebra de linha que corte o bloco). */
function nomeLimpo(nome: string): string {
  return nome.replace(/\s+/g, ' ').trim();
}

/**
 * Monta o bloco [PROFISSIONAIS]: id curto + nome + serviços que o profissional faz.
 *
 * Fase A (MVP): a junção colaborador×serviço (colaborador_servico, migration 054)
 * é Fase B — aqui TODOS os colaboradores fazem TODOS os serviços globais do clone
 * (config.services). A linha de serviços usa a lista global; quando a 054 entrar,
 * passa a ser por colaborador. A regra de desambiguação é OBRIGATÓRIA (homônimos).
 */
function buildProfissionaisBlock(
  colaboradores: ColaboradorAgenda[],
  config: ScheduleConfig,
): string {
  const servicosGlobais = config.services.map((s) => s.name).join(', ') || 'todos os serviços';
  const linhas = colaboradores.map(
    (c) => `${c.shortId} = ${nomeLimpo(c.nome)} (faz: ${servicosGlobais})`,
  );
  return [
    'Profissionais disponíveis (use o id curto, ex.: C1, ao agendar):',
    ...linhas,
    '',
    'REGRA DE ESCOLHA DO PROFISSIONAL (OBRIGATÓRIA):',
    '- SEMPRE pergunte com qual profissional o cliente quer antes de confirmar o horário.',
    '- Se o cliente disser só o primeiro nome e houver MAIS DE UM profissional com esse',
    '  nome (homônimos), você DEVE perguntar qual deles, listando as opções pelo nome',
    '  completo. Ex.: "Temos o João S. e o João P., com qual você prefere?".',
    '- NUNCA escolha o profissional por conta própria quando houver ambiguidade.',
    '- Ao chamar inserir_agendamento, passe colaborador_id com o id curto do',
    '  profissional escolhido (C1, C2, …). Nunca invente nem passe e-mail/agenda.',
  ].join('\n');
}

/**
 * Monta o bloco [HORARIOS DISPONIVEIS] rotulado por colaborador. Cada colaborador
 * ganha sua sub-seção com a MESMA grade do bot individual (por serviço/dia),
 * calculada a partir da SUA ocupação (do freebusy batched).
 *
 * Colaborador cuja agenda não veio no freebusy (erro/sem acesso) é tratado de forma
 * CONSERVADORA: a grade é calculada como se não tivéssemos a ocupação — então o
 * cruzamento server-side em inserir_agendamento (listEvents do colaborador) é a
 * rede final que impede overbooking. Aqui só rotulamos o profissional.
 */
function buildHorariosBlock(
  colaboradores: ColaboradorAgenda[],
  freebusy: FreeBusyResult,
  config: ScheduleConfig,
): string {
  const partes: string[] = [];
  for (const c of colaboradores) {
    const events = busyToEvents(freebusy[c.calendarId]);
    const agenda = formatarAgendaComConfig(events, config);
    partes.push(`### ${c.shortId} — ${nomeLimpo(c.nome)}`);
    partes.push(agenda);
    partes.push('');
  }
  return partes.join('\n').trimEnd();
}

/**
 * Monta o contexto de estabelecimento (blocos [PROFISSIONAIS] + [HORARIOS]) a
 * partir dos colaboradores resolvidos e da config de agenda.
 *
 * Faz UMA chamada freebusy.query batched com todos os calendarIds (ADR 0024 §5).
 * Se a chamada falhar inteira, propaga o erro — o caller (apps/api) decide silenciar
 * a resposta (não inventar disponibilidade), exatamente como no caminho individual.
 *
 * @param colaboradores Lista resolvida por getGcalsForSlot (já filtrada: ativos +
 *   gcal active + calendarId presente). Vazia → bloco vazio (caller trata).
 * @param config Config de agenda do slot (horários + serviços globais).
 * @param opts.timeMin/timeMax Janela ISO para o freebusy (mesma do bot individual).
 */
export async function buildEstabelecimentoContext(
  colaboradores: ColaboradorGcal[],
  config: ScheduleConfig,
  opts: { timeMin: string; timeMax: string },
): Promise<EstabelecimentoContext> {
  const decorados = decorateColaboradores(colaboradores);

  if (decorados.length === 0) {
    return { colaboradores: [], profissionaisBlock: '', horariosBlock: '' };
  }

  // freebusy batched: 1 chamada cobre todos os colaboradores (até 50). Todos os
  // calendários são da MESMA SA do clone (ADR 0024 §2) → qualquer client serve.
  const calendarIds = decorados.map((c) => c.calendarId);
  const anyClient = decorados[0].client;
  const freebusy = await anyClient.freeBusy({
    calendarIds,
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
  });

  return {
    colaboradores: decorados,
    profissionaisBlock: buildProfissionaisBlock(decorados, config),
    horariosBlock: buildHorariosBlock(decorados, freebusy, config),
  };
}
