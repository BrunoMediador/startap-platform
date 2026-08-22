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
 *  4. Monta o bloco [PROFISSIONAIS] (nome + serviços DE CADA colaborador, de
 *     clone_colaboradores.servicos — migration 057; vazio = faz todos os globais) e o
 *     [HORARIOS DISPONIVEIS]
 *     ROTULADO POR COLABORADOR, reusando a MESMA grade do bot individual
 *     (formatarAgendaComConfig — step = duração, piso de 10min pra hoje, overlap).
 *  5. Inclui a REGRA DE DESAMBIGUAÇÃO obrigatória pra homônimos.
 *
 * O LLM recebe apenas os nomes dos profissionais. O servidor resolve o nome
 * escolhido contra a lista ativa do slot, mantendo calendarId e IDs curtos como
 * detalhes internos — ver inserir_agendamento no apps/api.
 */
import type { CalendarEvent, FreeBusyResult } from '../google-calendar/client.js';
import type { ColaboradorGcal } from '../google-calendar/per-clone.js';
import { type ScheduleConfig, formatarAgendaComConfig } from './free-slots.js';

/** Timezone canônica (reexporta a do free-slots pra não divergir). */
export { TZ } from './free-slots.js';

/**
 * Colaborador decorado com id curto interno estável (C1, C2…). `client`,
 * `calendarId` e `shortId` nunca entram no texto do prompt.
 */
export interface ColaboradorAgenda extends ColaboradorGcal {
  /** Id curto estável usado internamente ao resolver a tool (C1, C2, …). */
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
 * Resolve um id curto (compatibilidade), id numérico ou nome completo para o
 * colaborador correspondente, SERVER-SIDE, validando contra a lista decorada
 * daquele slot.
 *
 * O runtime atual passa o nome completo que aparece ao cliente. Os formatos
 * antigos seguem aceitos para recuperar conversas/modelos que ainda carreguem
 * o código interno. Nome ambíguo é rejeitado em vez de escolher alguém errado.
 * NUNCA aceita calendarId.
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
  const normalizedName = v.toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
  const byName = colaboradores.filter(
    (c) => c.nome.trim().toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ') === normalizedName,
  );
  if (byName.length === 1) return byName[0] ?? null;
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

/** Normaliza um nome de serviço pra comparação tolerante (lower + trim + colapsa espaço). */
function normServico(s: string | null | undefined): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Resolve a lista EFETIVA de serviços que um colaborador faz, aplicando o fallback:
 *  - se `colaborador.servicos` tem itens → usa a lista DELE (migration 057);
 *  - se está VAZIA → o dono não especificou → faz TODOS os serviços globais do clone
 *    (config.services). Decisão de produto (migration 057): vazio NÃO bloqueia agenda.
 *
 * Os nomes são casados (case-insensitive) contra os serviços globais para devolver o
 * nome CANÔNICO (o que aparece em [SERVICOS E PRECOS]); um serviço do colaborador que
 * não exista mais na lista global é descartado (config do dono ficou inconsistente).
 */
export function servicosDoColaborador(
  colaborador: { servicos: string[] },
  config: ScheduleConfig,
): string[] {
  const globais = config.services.map((s) => s.name);
  if (!colaborador.servicos || colaborador.servicos.length === 0) {
    return globais;
  }
  const globaisByNorm = new Map(globais.map((n) => [normServico(n), n]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of colaborador.servicos) {
    const canonico = globaisByNorm.get(normServico(raw));
    if (canonico && !seen.has(canonico)) {
      seen.add(canonico);
      out.push(canonico);
    }
  }
  // Se TODOS os serviços do colaborador sumiram da lista global (inconsistência),
  // cai pro fallback global em vez de deixar o profissional sem nenhum serviço.
  return out.length > 0 ? out : globais;
}

/**
 * True se `servicoPedido` está entre os serviços EFETIVOS do colaborador (com o
 * fallback de `servicosDoColaborador`). Comparação tolerante (case/espaço).
 * Pedido vazio → true (não bloqueia: o summary/contexto decide o serviço depois).
 */
export function colaboradorFazServico(
  colaborador: { servicos: string[] },
  config: ScheduleConfig,
  servicoPedido: string | null | undefined,
): boolean {
  const pedido = normServico(servicoPedido);
  if (pedido === '') return true;
  return servicosDoColaborador(colaborador, config).some((s) => normServico(s) === pedido);
}

/**
 * Monta o bloco [PROFISSIONAIS]: nome + serviços que o profissional faz.
 *
 * Cada colaborador lista os SEUS serviços (clone_colaboradores.servicos, migration
 * 057). Quando o dono NÃO especificou (servicos vazio), o profissional faz TODOS os
 * serviços globais do clone (fallback de produto — migration 057: vazio não bloqueia).
 * A regra de desambiguação de homônimos é OBRIGATÓRIA.
 */
function buildProfissionaisBlock(
  colaboradores: ColaboradorAgenda[],
  config: ScheduleConfig,
): string {
  const linhas = colaboradores.map((c) => {
    const servs = servicosDoColaborador(c, config);
    const lista = servs.join(', ') || 'todos os serviços';
    return `${nomeLimpo(c.nome)} (faz: ${lista})`;
  });
  return [
    'Profissionais disponíveis:',
    ...linhas,
    '',
    'REGRA DE ESCOLHA DO PROFISSIONAL (OBRIGATÓRIA):',
    '- SEMPRE pergunte com qual profissional o cliente quer antes de confirmar o horário.',
    '- Cada profissional só faz os serviços listados ao lado do nome dele. NUNCA ofereça',
    '  nem agende um serviço com um profissional que não o faz. Se o cliente pedir um',
    '  serviço que aquele profissional não faz, diga isso e indique quem faz (ou ofereça',
    '  outro serviço que ele faz). Ex.: "A Maria não faz Corte; quem faz é o Bruno. Quer com ele?".',
    '- Se o cliente disser só o primeiro nome e houver MAIS DE UM profissional com esse',
    '  nome (homônimos), você DEVE perguntar qual deles, listando as opções pelo nome',
    '  completo. Ex.: "Temos o João S. e o João P., com qual você prefere?".',
    '- NUNCA escolha o profissional por conta própria quando houver ambiguidade.',
    '- Ao chamar inserir_agendamento, passe o NOME COMPLETO do profissional escolhido.',
    '  Nunca use, mencione ou mostre códigos internos, e-mail ou agenda.',
  ].join('\n');
}

/**
 * Deriva um ScheduleConfig com `services` restrito aos serviços que ESTE colaborador
 * faz — reusa `servicosDoColaborador` (MESMA fonte + fallback do bloco [PROFISSIONAIS]),
 * então a grade [HORARIOS] fica coerente com o que o [PROFISSIONAIS] anuncia.
 *
 * Filtra `config.services` por MEMBERSHIP (preservando ORDEM e duração `min` dos serviços
 * globais). No fallback — colaborador SEM serviços marcados → `servicosDoColaborador`
 * devolve TODOS os globais → o filtro mantém `config.services` intacto → a grade é
 * BYTE-IDÊNTICA ao comportamento anterior (nada muda pra quem não configurou).
 *
 * Guard: se o filtro esvaziar (não deve — `servicosDoColaborador` já tem fallback próprio),
 * mantém os globais para nunca deixar o profissional sem nenhuma grade.
 */
function scheduleConfigDoColaborador(
  colaborador: ColaboradorAgenda,
  config: ScheduleConfig,
): ScheduleConfig {
  const efetivos = new Set(servicosDoColaborador(colaborador, config).map(normServico));
  const services = config.services.filter((s) => efetivos.has(normServico(s.name)));
  return { ...config, services: services.length > 0 ? services : config.services };
}

/**
 * Monta o bloco [HORARIOS DISPONIVEIS] rotulado por colaborador. Cada colaborador
 * ganha sua sub-seção com a MESMA grade do bot individual (por serviço/dia),
 * calculada a partir da SUA ocupação (do freebusy batched) e RESTRITA aos serviços
 * que ELE faz (clone_colaboradores.servicos — "selecionar não digitar"; SCRUM-28):
 * um barbeiro que só faz Corte não aparece mais com a grade de Barba/Manicure.
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
    // Grade só dos serviços DESTE profissional (fallback = todos os globais → byte-idêntico).
    const agenda = formatarAgendaComConfig(events, scheduleConfigDoColaborador(c, config));
    partes.push(`### ${nomeLimpo(c.nome)}`);
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
    // Fuso do clone (default SP via ScheduleConfig.timezone). buildHorariosBlock ->
    // formatarAgendaComConfig já herda config.timezone; aqui alinhamos o freeBusy.
    timeZone: config.timezone,
  });

  return {
    colaboradores: decorados,
    profissionaisBlock: buildProfissionaisBlock(decorados, config),
    horariosBlock: buildHorariosBlock(decorados, freebusy, config),
  };
}
