/**
 * Helpers de formatacao pt-BR. Centralizados pra copy consistente com a spec
 * (secao 3): preco "R$ 50,00", telefone mascarado "(11) 9••••-••42", datas
 * "18 de junho", duracao "30 min", tempo relativo "há 2 dias".
 */

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

/** Centavos -> "R$ 50,00". */
export function formatPrecoCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

/** "50,00" (string editavel) -> centavos inteiros. Aceita "50", "50.5", "1.234,50". */
export function parsePrecoToCents(input: string): number | null {
  const cleaned = input.trim().replace(/\s/g, '').replace(/r\$/i, '');
  if (cleaned === '') return null;
  // Remove separador de milhar e normaliza virgula decimal.
  const normalized = cleaned.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** "30 min" / "1h" / "1h30". */
export function formatDuracao(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h}h` : `${h}h${String(rest).padStart(2, '0')}`;
}

/** Iniciais de um nome (ate 2 letras). Fallback '?' se vazio. */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * CHAVE DE JOIN telefone->contato, INVARIANTE ao 9º dígito móvel BR. Usado pra
 * casar /portal/pausas (telefone guardado pelo runtime, COM o 9) com
 * /portal/contatos (telefone vindo do WAHA/NOWEB, que ora entrega COM ora SEM
 * o 9 — packages/core/phone.ts::canonicalE164 documenta o mesmo). Sem essa
 * invariancia o mesmo contato gera chaves diferentes e o NOME nunca resolve
 * (o dono ve so o numero — bug reportado pelo Bruno).
 *
 * Regras (espelham canonicalE164, mas em forma LOCAL sem DDI — a chave e opaca):
 *  1. tira DDI 55 (13/12 dig com 55 -> local de 11/10);
 *  2. celular COM 9 (local 11 dig, 3º dig = '9') -> remove o 9 -> forma canonica
 *     de 10 dig. Fixo (10 dig, comeca 2-5) e celular-sem-9 (10 dig, comeca 6-9)
 *     ficam intactos e NUNCA colidem entre si.
 * Ex: "+55 (35) 99115-3270" e "553591153270" -> ambos "3591153270".
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const local = digits.length > 11 && digits.startsWith('55') ? digits.slice(2) : digits;
  // 9º dígito móvel BR: local de 11 díg (DDD + 9 + 8) com o 9 na posição 2 ->
  // remove pra bater com a mesma linha entregue SEM o 9 (10 díg). Fixo tem 10
  // díg (nunca cai aqui) e não colide (começa 2-5, celular-sem-9 começa 6-9).
  if (local.length === 11 && local[2] === '9') {
    return local.slice(0, 2) + local.slice(3);
  }
  return local;
}

/**
 * Formata um telefone COMPLETO e legivel pra exibir ao DONO do bot (ele ve os
 * proprios clientes — mascarar e regra de LOG no backend, nao de tela do dono).
 * Ex: "5535999115327" -> "+55 (35) 99115-327" · "11999990007" -> "(11) 99999-0007".
 * Numeros fora do padrao BR caem num fallback que so insere espacos a cada grupo.
 */
export function formatPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return raw;
  const hasDDI = digits.length > 11 && digits.startsWith('55');
  const local = hasDDI ? digits.slice(2) : digits;
  const ddi = hasDDI ? '+55 ' : '';

  // Celular BR (11 digitos: DDD + 9 + 8) -> (DD) 9XXXX-XXXX.
  if (local.length === 11) {
    const ddd = local.slice(0, 2);
    const part1 = local.slice(2, 7);
    const part2 = local.slice(7);
    return `${ddi}(${ddd}) ${part1}-${part2}`;
  }
  // Fixo BR (10 digitos: DDD + 8) -> (DD) XXXX-XXXX.
  if (local.length === 10) {
    const ddd = local.slice(0, 2);
    const part1 = local.slice(2, 6);
    const part2 = local.slice(6);
    return `${ddi}(${ddd}) ${part1}-${part2}`;
  }
  // Fora do padrao: agrupa em DDD + resto pra continuar legivel, sem mascarar.
  if (local.length > 6) {
    const ddd = local.slice(0, 2);
    const rest = local.slice(2);
    const split = Math.ceil(rest.length / 2);
    return `${ddi}(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return `${ddi}${local}`;
}

/** "YYYY-MM-DD" -> "18 de junho". Retorna null se invalido. */
export function formatDueDate(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const day = Number(m[3]);
  const monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${day} de ${MESES[monthIdx]}`;
}

/** ISO -> "14:30". */
export function formatHora(iso: string | null): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** ISO -> "hoje" / "amanhã" / "12/06". Comparacao por dia local. */
export function formatDiaRelativo(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(d) - startOf(now)) / 86_400_000);
  if (diffDays === 0) return 'hoje';
  if (diffDays === 1) return 'amanhã';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/**
 * Fuso DEFAULT da barbearia (BR). Datas/horas de agendamento (timestamptz vindos do GCal/Postgres
 * em UTC) DEVEM ser exibidas no fuso DO CLONE, NUNCA no fuso do runtime (Next SSR roda em UTC; o
 * navegador pode estar em qualquer lugar). Sem isto, o label do DIA cai no dia errado pra
 * horários da noite (ex.: 22:00 BRT = 01:00 UTC do dia seguinte). ADR 0027 — bug de data.
 *
 * O fuso é parametrizável por clone: cada formatador aceita `timeZone` com este valor como
 * DEFAULT (São Paulo, UTC-3). Quem chama passa o fuso do tenant (`useTenantTz()`, vindo de
 * `GET /portal/status`). Barbearia de Mato Grosso = `America/Cuiaba` (UTC-4) → mostra 1h a
 * menos que SP. Com o default a saída é byte-idêntica ao comportamento anterior.
 */
const BR_TZ = 'America/Sao_Paulo';

/**
 * Componentes do calendário de um instante no `timeZone` dado (year/month/day inteiros). Usa
 * Intl.DateTimeFormat (en-CA -> "YYYY-MM-DD") pra extrair o dia civil de forma determinística,
 * independente do fuso do runtime. Helper interno do split de DIA.
 */
function brCalendarParts(
  d: Date,
  timeZone: string = BR_TZ,
): { year: number; month: number; day: number } {
  const iso = d.toLocaleDateString('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }); // "2026-06-23"
  const [y, mo, da] = iso.split('-');
  return { year: Number(y), month: Number(mo), day: Number(da) };
}

/** Número serial do dia civil no `timeZone` dado (dias desde a época) — base da comparação hoje/amanhã/ontem. */
function brDaySerial(d: Date, timeZone: string = BR_TZ): number {
  const { year, month, day } = brCalendarParts(d, timeZone);
  // Date.UTC com os componentes do fuso -> serial estável (não sofre DST do runtime).
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * Rotulo de DIA pt-BR pra um agendamento (item 1). Aceita ISO datetime OU date
 * puro "YYYY-MM-DD". Usa "hoje"/"amanhã"/"ontem" quando perto; senao "9 de jun".
 * No fuso do clone (`timeZone`, default São Paulo) — o dia é o dia CIVIL da barbearia,
 * não do runtime. Passe o fuso do tenant (`useTenantTz()`) pra Mato Grosso etc.
 */
export function formatAgendamentoDia(
  inicio: string | null,
  now = new Date(),
  timeZone: string = BR_TZ,
): string {
  const d = parseLocalDate(inicio);
  if (!d) return 'Sem data';
  const diffDays = brDaySerial(d, timeZone) - brDaySerial(now, timeZone);
  if (diffDays === 0) return 'Hoje';
  if (diffDays === 1) return 'Amanhã';
  if (diffDays === -1) return 'Ontem';
  return d
    .toLocaleDateString('pt-BR', { timeZone, day: 'numeric', month: 'short' })
    .replace('.', '');
}

/**
 * Hora pt-BR "14:30" pra um agendamento. Date puro (sem hora) -> "" (dia inteiro).
 * Distingue de formatHora (que devolve "--:--" em null) pra nao poluir a UI.
 * No fuso do clone (`timeZone`, default São Paulo) — a hora é a hora local da barbearia.
 */
export function formatAgendamentoHora(inicio: string | null, timeZone: string = BR_TZ): string {
  if (!inicio) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(inicio)) return ''; // date puro: sem horario
  const d = new Date(inicio);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' });
}

/**
 * ISO datetime ou date puro "YYYY-MM-DD" -> Date (helper interno). Date puro carrega só o DIA
 * civil — nunca a hora (formatAgendamentoHora devolve '' pra date puro). Ancoramos ao MEIO-DIA
 * UTC (tz-INDEPENDENTE): projetado em qualquer fuso BR (SP -03 = 09:00; Cuiabá -04 = 08:00) cai
 * no MESMO dia civil, então brDaySerial/brCalendarParts extraem o dia certo seja qual for o
 * `timeZone` do clone — sem chumbar offset. (Era T03:00:00Z, que assumia −03 fixo e escorregava
 * o dia em fusos != SP.) ISO datetime passa direto. NÃO depende de fuso — por isso sem param.
 */
function parseLocalDate(inicio: string | null): Date | null {
  if (!inicio) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inicio);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(inicio);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Tempo decorrido desde `iso` ate agora, em pt-BR curto:
 * "agora", "há 5 min", "há 3 h", "há 2 dias", "ontem".
 */
export function formatHaTempo(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'ontem';
  return `há ${days} dias`;
}

/** "Pausado há 2 dias" a partir do updated_at da pausa. */
export function formatPausadoHa(iso: string): string {
  const ha = formatHaTempo(iso);
  if (ha === 'agora') return 'Pausado agora';
  if (ha === 'ontem') return 'Pausado ontem';
  return `Pausado ${ha}`;
}

/** Saudacao por hora local: Bom dia / Boa tarde / Boa noite. */
export function saudacao(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/** Data por extenso pra saudacao editorial (1.D.3): "Segunda, 9 de junho". */
export function dataPorExtenso(date = new Date()): string {
  const dia = DIAS_SEMANA[date.getDay()];
  const num = date.getDate();
  const mes = MESES[date.getMonth()];
  return `${dia}, ${num} de ${mes}`;
}

/** Date local -> "YYYY-MM-DD" (sem deslocamento de fuso, ao contrário de toISOString). */
export function toISODate(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "YYYY-MM-DD" do dia 1 do mês corrente (default do seletor de período). */
export function firstOfMonthISO(date = new Date()): string {
  return toISODate(new Date(date.getFullYear(), date.getMonth(), 1));
}

/** "YYYY-MM-DD" -> "9 de jun" (curto, pro rótulo do período). null se inválido. */
export function formatDateShort(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${Number(m[3])} de ${MESES[monthIdx].slice(0, 3)}`;
}
