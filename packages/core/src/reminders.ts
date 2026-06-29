/**
 * reminders.ts — lógica PURA do lembrete de agendamento (one-way). Sem I/O, sem env, sem
 * banco. Compartilhada entre o portal-api (validação do config) e o worker (decisão de
 * janela + render do template). Fácil de testar isoladamente.
 *
 * Decisões fixas (design do arquiteto):
 *  - Conjunto PERMITIDO de janelas (min antes do horário): 24h/3h/2h/1h.
 *  - DEFAULT GLOBAL de janelas quando o clone não configurou (NULL no banco).
 *  - Template default PT-BR, reviewável (a COPY vai pro Bruno aprovar antes de cliente real).
 *  - Render do {horario} em BRT (America/Sao_Paulo).
 */

/** Fuso do negócio (idêntico ao TZ de scheduling/free-slots). */
export const REMINDER_TZ = 'America/Sao_Paulo';

/**
 * Conjunto PERMITIDO de janelas (minutos antes do horário). O dono só pode escolher destas.
 * 1440=24h, 180=3h, 120=2h, 60=1h.
 */
export const ALLOWED_REMINDER_WINDOWS_MIN: readonly number[] = [1440, 180, 120, 60] as const;

/** Default GLOBAL aplicado quando o clone não tem janelas próprias (NULL no banco). */
export const DEFAULT_REMINDER_WINDOWS_MIN: readonly number[] = [1440, 120] as const;

/**
 * Tolerância (min) do gatilho: o lembrete dispara quando faltam entre (janela - tolerância) e
 * janela para o horário. Cobre o passo do cron (a cada 5 min) sem perder nem duplicar — o
 * claim idempotente garante 1 envio mesmo que dois ciclos caiam dentro da tolerância.
 */
export const DEFAULT_REMINDER_TOLERANCE_MIN = 5;

/**
 * Template DEFAULT do lembrete (PT-BR). ⚠️ COPY PARA O BRUNO REVISAR antes de ir pra cliente
 * real. Vars suportadas: {cliente_nome} {servico_nome} {horario} {profissional} {negocio}.
 * {profissional} é OMITIDO em SOLO/individual (sem colaborador) — ver renderReminderTemplate.
 */
export const DEFAULT_REMINDER_TEMPLATE =
  'Oi{cliente_nome}! Passando pra lembrar do seu horário {servico_nome}{profissional} ' +
  '{horario} no {negocio}. Qualquer coisa, é só chamar por aqui. Até logo! 💈';

/** Resultado da validação de janelas (entrada do PATCH do config). */
export type WindowsValidation =
  | { ok: true; windows: number[] }
  | { ok: false; reason: 'not_array' | 'empty' | 'invalid_value' | 'too_many' };

/**
 * Valida + normaliza a lista de janelas enviada pelo dono. Aceita só inteiros do conjunto
 * permitido; dedup; ordena desc (lembrete mais distante primeiro). Lista vazia = inválida
 * (o caller trata "limpar" como ausência do campo, não como []). Máx 4 (tamanho do conjunto).
 */
export function validateWindows(input: unknown): WindowsValidation {
  if (!Array.isArray(input)) return { ok: false, reason: 'not_array' };
  if (input.length === 0) return { ok: false, reason: 'empty' };
  if (input.length > ALLOWED_REMINDER_WINDOWS_MIN.length) return { ok: false, reason: 'too_many' };
  const allowed = new Set(ALLOWED_REMINDER_WINDOWS_MIN);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of input) {
    const n = Number(raw);
    if (!Number.isInteger(n) || !allowed.has(n)) return { ok: false, reason: 'invalid_value' };
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => b - a);
  return { ok: true, windows: out };
}

/**
 * Resolve as janelas efetivas de um clone: as configuradas (se houver), senão o default global.
 * Sempre devolve um array NÃO vazio de janelas válidas, ordenado desc.
 */
export function resolveWindows(configured: number[] | null | undefined): number[] {
  if (configured && configured.length > 0) {
    const v = validateWindows(configured);
    if (v.ok) return v.windows;
  }
  return [...DEFAULT_REMINDER_WINDOWS_MIN];
}

/**
 * Decide se uma janela está NO GATILHO para um horário-alvo, dado o "agora". Dispara quando o
 * tempo restante (inicio - now) cai em (janela - tolerância, janela]. Fora disso (muito cedo
 * ou já passou da janela) NÃO dispara. PURA — base do teste de janela.
 *
 * @param windowMin   janela em minutos (ex.: 120).
 * @param minsUntil   minutos faltando para o horário (inicio - now, em minutos).
 * @param toleranceMin tolerância do gatilho (default DEFAULT_REMINDER_TOLERANCE_MIN).
 */
export function isWindowDue(
  windowMin: number,
  minsUntil: number,
  toleranceMin: number = DEFAULT_REMINDER_TOLERANCE_MIN,
): boolean {
  return minsUntil <= windowMin && minsUntil > windowMin - toleranceMin;
}

/** Minutos (com sinal) entre `now` e `target` (target - now). Negativo = target no passado. */
export function minutesUntil(target: Date, now: Date): number {
  return (target.getTime() - now.getTime()) / 60_000;
}

/**
 * Formata um instante em "DD/MM às HH:MM" no fuso BRT (America/Sao_Paulo). Determinístico via
 * Intl (mesmo racional do spParts de free-slots). Ex.: 2026-06-24T13:30:00Z -> "24/06 às 10:30".
 */
export function formatHorarioBRT(when: Date, timeZone: string = REMINDER_TZ): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(when)
    .reduce<Record<string, string>>((a, p) => {
      a[p.type] = p.value;
      return a;
    }, {});
  return `${parts.day}/${parts.month} às ${parts.hour}:${parts.minute}`;
}

/** Vars de render do template. profissionalNome NULL/'' = SOLO -> {profissional} omitido. */
export interface ReminderRenderVars {
  clienteNome?: string | null;
  servicoNome?: string | null;
  /** Instante do agendamento — renderizado em BRT como {horario}. */
  inicioAt: Date;
  profissionalNome?: string | null;
  negocio: string;
  /** Override de template (do clone). Vazio/null -> usa o DEFAULT_REMINDER_TEMPLATE. */
  template?: string | null;
  /**
   * Fuso (IANA) do clone (migration 068) — relógio em que {horario} é renderizado. Ausente ->
   * 'America/Sao_Paulo' (REMINDER_TZ; byte-idêntico ao de hoje). NÃO afeta a janela de disparo
   * (essa é fuso-agnóstica — opera sobre minutos até o instante absoluto).
   */
  timeZone?: string;
}

/**
 * Renderiza o texto final do lembrete. Substitui as vars; faz limpeza de espaçamento dos
 * pedaços OPCIONAIS (cliente sem nome, SOLO sem profissional) pra não sobrar espaço duplo nem
 * vírgula solta. {profissional} vira " com Fulano" quando há profissional; "" no SOLO.
 *
 *  - {cliente_nome}  -> ", Fulano" quando há nome (vírgula+nome, ex.: "Oi, Fulano!"); "" senão.
 *  - {servico_nome}  -> "de Corte" quando há serviço; "" senão.
 *  - {horario}       -> formatHorarioBRT(inicioAt).
 *  - {profissional}  -> " com Fulano" quando há profissional (estabelecimento); "" no SOLO.
 *  - {negocio}       -> display_name.
 */
export function renderReminderTemplate(vars: ReminderRenderVars): string {
  const tpl =
    vars.template && vars.template.trim().length > 0 ? vars.template : DEFAULT_REMINDER_TEMPLATE;

  const clienteNome = (vars.clienteNome ?? '').trim();
  const servicoNome = (vars.servicoNome ?? '').trim();
  const profissionalNome = (vars.profissionalNome ?? '').trim();

  const replaced = tpl
    .replace(/\{cliente_nome\}/g, clienteNome ? `, ${clienteNome}` : '')
    .replace(/\{servico_nome\}/g, servicoNome ? `de ${servicoNome} ` : '')
    .replace(/\{horario\}/g, formatHorarioBRT(vars.inicioAt, vars.timeZone))
    .replace(/\{profissional\}/g, profissionalNome ? ` com ${profissionalNome}` : '')
    .replace(/\{negocio\}/g, vars.negocio);

  // Limpeza: colapsa espaços duplos e espaço antes de pontuação que possam ter sobrado
  // quando uma var opcional virou "".
  return replaced
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?])/g, '$1')
    .trim();
}
