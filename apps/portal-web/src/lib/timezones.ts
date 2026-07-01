/**
 * Fusos horários (IANA) pro seletor "Brasil no topo, mundo por busca".
 *
 * Contexto: barbearias podem estar em qualquer fuso (o caso real foi Mato Grosso,
 * `America/Cuiaba` UTC−4, cujos agendamentos caíam 1h errados). O backend grava
 * `flow_clones.timezone` (string IANA, default São Paulo) e valida contra
 * `Intl.supportedValuesOf('timeZone')`. Aqui montamos as OPÇÕES do combobox.
 *
 * Princípios:
 *  - Offset SEMPRE computado via `Intl` (DST-correto) — NUNCA chumbado. "São Paulo"
 *    é UTC−3 hoje, mas o rótulo sai de `Intl`, não de uma constante.
 *  - Grupo "Brasil" fixado no topo (prioridade do dono); o mundo é alcançável
 *    digitando (a lista IANA completa vem de `Intl.supportedValuesOf`).
 *  - Emite/consome o nome IANA (string). Default `America/Sao_Paulo`.
 *
 * ⚠️ Duplicação menor: os rótulos/prioridade do Brasil vivem aqui pois o
 * `@startap/core` ainda não exporta uma tabela de fusos (só `REMINDER_TZ`). Se o
 * backend expuser isso, trocar por reuse. Os IANA são o contrato; os offsets NÃO
 * são chumbados (vêm de Intl), então não há risco de drift de DST.
 */

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

/**
 * Fusos canônicos do Brasil, na ordem de prioridade que o dono quer ver no topo.
 * `id` = IANA (contrato); `label` = rótulo amigável exibido. Offset NÃO entra aqui
 * (é sempre calculado em runtime via Intl).
 */
export const BRAZIL_TIMEZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'America/Sao_Paulo', label: 'São Paulo / Brasília' },
  { id: 'America/Fortaleza', label: 'Fortaleza' },
  { id: 'America/Recife', label: 'Recife' },
  { id: 'America/Belem', label: 'Belém' },
  { id: 'America/Campo_Grande', label: 'Campo Grande' },
  { id: 'America/Cuiaba', label: 'Cuiabá' },
  { id: 'America/Manaus', label: 'Manaus' },
  { id: 'America/Porto_Velho', label: 'Porto Velho' },
  { id: 'America/Boa_Vista', label: 'Boa Vista' },
  { id: 'America/Rio_Branco', label: 'Rio Branco' },
  { id: 'America/Noronha', label: 'Fernando de Noronha' },
];

const BRAZIL_LABEL_BY_ID: Record<string, string> = Object.fromEntries(
  BRAZIL_TIMEZONES.map((t) => [t.id, t.label]),
);

const BRAZIL_ID_SET = new Set(BRAZIL_TIMEZONES.map((t) => t.id));

/** Fallback mínimo se o runtime não tiver `Intl.supportedValuesOf` (navegador antigo). */
const FALLBACK_IDS: string[] = [
  ...BRAZIL_TIMEZONES.map((t) => t.id),
  'America/New_York',
  'America/Los_Angeles',
  'America/Buenos_Aires',
  'America/Mexico_City',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'UTC',
];

/** Acesso tipado a `Intl.supportedValuesOf` sem depender da lib do TS declará-lo. */
interface IntlWithSupported {
  supportedValuesOf?(key: 'timeZone'): string[];
}

/** Lista IANA completa do runtime (ou fallback). Deduplicada e sem vazios. */
export function getAllTimeZoneIds(): string[] {
  const intl = Intl as IntlWithSupported;
  let ids: string[] = FALLBACK_IDS;
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      const got = intl.supportedValuesOf('timeZone');
      if (Array.isArray(got) && got.length > 0) ids = got;
    } catch {
      // runtime recusou -> mantém fallback
    }
  }
  return Array.from(new Set(ids.filter(Boolean)));
}

/**
 * Rótulo "(UTC±N)" do fuso, DST-correto, via `Intl` — nunca chumbado.
 * Ex.: America/Sao_Paulo -> "UTC−3"; America/Cuiaba -> "UTC−4"; Asia/Kolkata -> "UTC+5:30".
 * Usa o sinal de menos tipográfico (−) pra leitura; UTC puro vira "UTC±0".
 */
export function getUtcOffsetLabel(timeZone: string, at: Date = new Date()): string {
  try {
    const name =
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
    // `name` vem como "GMT-3", "GMT+5:30" ou "GMT" (o próprio UTC).
    const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return 'UTC±0';
    const hour = String(Number(m[2]));
    const min = m[3] && m[3] !== '00' ? `:${m[3]}` : '';
    // Offset zero ("GMT+0" / "GMT") sai como "UTC±0".
    if (hour === '0' && min === '') return 'UTC±0';
    const sign = m[1] === '-' ? '−' : '+';
    return `UTC${sign}${hour}${min}`;
  } catch {
    return 'UTC';
  }
}

/** Rótulo amigável do fuso: nome do Brasil quando conhecido; senão, a cidade do IANA. */
export function friendlyLabel(id: string): string {
  const known = BRAZIL_LABEL_BY_ID[id];
  if (known) return known;
  const seg = id.split('/').pop() ?? id;
  return seg.replace(/_/g, ' ');
}

export interface TimezoneOption {
  /** Nome IANA (o valor emitido/consumido). */
  id: string;
  /** Rótulo amigável (cidade). */
  label: string;
  /** "(UTC±N)" atual, computado via Intl. */
  offsetLabel: string;
  /** true = pertence ao grupo Brasil (fixado no topo). */
  brazil: boolean;
}

function toOption(id: string, at: Date, brazil: boolean): TimezoneOption {
  return { id, label: friendlyLabel(id), offsetLabel: getUtcOffsetLabel(id, at), brazil };
}

/**
 * Monta as opções agrupadas: Brasil (ordem de prioridade) + o resto do mundo
 * (ordenado por rótulo). Garante que `selectedId` sempre exista na lista, mesmo
 * que o runtime não o liste (ex.: alias legado vindo do backend).
 */
export function buildTimezoneOptions(
  selectedId: string | null | undefined,
  at: Date = new Date(),
): { brazil: TimezoneOption[]; world: TimezoneOption[] } {
  const brazil = BRAZIL_TIMEZONES.map((t) => toOption(t.id, at, true));

  const world = getAllTimeZoneIds()
    .filter((id) => !BRAZIL_ID_SET.has(id))
    .map((id) => toOption(id, at, false))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));

  // Selecionado que não está em lugar nenhum entra no mundo (topo), pra nunca sumir.
  if (selectedId && !BRAZIL_ID_SET.has(selectedId) && !world.some((o) => o.id === selectedId)) {
    world.unshift(toOption(selectedId, at, false));
  }

  return { brazil, world };
}

/** Normaliza pra busca: minúsculo + sem acento. */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Casa a query (busca) contra id IANA, rótulo e offset — tudo sem acento. */
export function matchesQuery(opt: TimezoneOption, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return (
    normalizeSearch(opt.id).includes(q) ||
    normalizeSearch(opt.label).includes(q) ||
    normalizeSearch(opt.offsetLabel).includes(q)
  );
}

/**
 * Lista PLANA filtrada pela busca, Brasil-first. Usada quando há texto de busca
 * (a UI mostra grupos só com busca vazia). Mantém a ordem Brasil→mundo.
 */
export function filterTimezones(
  groups: { brazil: TimezoneOption[]; world: TimezoneOption[] },
  query: string,
): TimezoneOption[] {
  const all = [...groups.brazil, ...groups.world];
  return all.filter((o) => matchesQuery(o, query));
}
