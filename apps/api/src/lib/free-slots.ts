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
import { flowClones, query } from '@startap/db';

const TZ = 'America/Sao_Paulo';

export interface ScheduleConfig {
  /** Janelas de atendimento por weekday (0=Dom .. 6=Sab). null = fechado. */
  work: Record<number, [number, number] | null>;
  /** Serviços disponíveis (nome + duração em minutos). */
  services: Array<{ name: string; min: number }>;
  /** Origem da config — útil para log/debug. */
  source: 'flow_clones' | 'bot_config' | 'defaults';
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
 * Le bot_config.horarios_funcionamento + bot_config.servicos diretamente
 * (queries.bot-config nao retorna esses jsonbs porque outros consumidores
 * nao precisam). Usado pelo loadScheduleConfig quando o slot e uma matriz.
 */
async function loadFromBotConfig(
  slot: string,
): Promise<{ work: Record<number, [number, number] | null>; services: Array<{ name: string; min: number }> } | null> {
  try {
    const r = await query<{
      horarios_funcionamento: HorariosFuncionamento | null;
      servicos: ServicoConfig[] | null;
    }>(
      `SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1`,
      [slot],
    );
    const row = r.rows[0];
    if (!row) return null;
    const work = horariosToWork(row.horarios_funcionamento);
    const services = servicosToServices(row.servicos);
    if (!work || !services || services.length === 0) return null;
    return { work, services };
  } catch {
    return null;
  }
}

/**
 * Carrega config do slot. Hierarquia (decisao 2026-05-20: matriz tambem
 * pode ter horarios+servicos pelo painel, e clones herdam):
 *   1) flow_clones (clone vinculado ao slot)
 *   2) bot_config (matriz com config preenchida)
 *   3) BUILTIN_DEFAULTS (hardcoded fallback)
 */
export async function loadScheduleConfig(slot: string): Promise<ScheduleConfig> {
  // 1) Tenta clone primeiro
  try {
    const clone = await flowClones.getCloneBySlot(slot);
    if (clone) {
      const work = horariosToWork(clone.horarios_funcionamento);
      const services = servicosToServices(clone.servicos);
      if (work && services && services.length > 0) {
        return { work, services, source: 'flow_clones' };
      }
      // Clone existe mas config incompleta — cai pra matriz (matriz_slot do clone).
      const matrizCfg = await loadFromBotConfig(clone.matriz_slot);
      if (matrizCfg) {
        return { ...matrizCfg, source: 'bot_config' };
      }
      return BUILTIN_DEFAULTS;
    }
  } catch {
    // Falha de query — cai para os proximos niveis.
  }

  // 2) Slot pode ser uma matriz rodando direto (ex: teste_barbearia sem clone).
  const matrizCfg = await loadFromBotConfig(slot);
  if (matrizCfg) {
    return { ...matrizCfg, source: 'bot_config' };
  }

  // 3) Ultimo recurso: hardcoded.
  return BUILTIN_DEFAULTS;
}

// ---- Bloco de CONTEXTO (concatenado ao prompt antes de enviar a IA) --------
//
// Bruno (2026-05-20): a parte editavel pelo painel (bot_prompt) e SOMENTE
// persona + regras + fluxo + cartao. Os dados (negocio, horarios, servicos,
// data, cliente, agenda) sao injetados pelo worker em runtime via este bloco
// — usuario nao consegue apagar acidentalmente pelo prompt.

interface ContextBlockOpts {
  /** Slot do bot/clone (necessario para localizar config). */
  slot: string;
  /** Nome do cliente final (do pushName do WhatsApp). */
  nomeCliente: string;
  /** Telefone do cliente final (E.164 sem formatacao). */
  telefoneCliente: string;
  /** Data atual ja formatada em pt-BR. */
  dataAtual: string;
  /** Ano (string) para a IA usar nos calculos. */
  ano: string;
  /** Tabela de horarios disponiveis ja formatada (vinda de formatarAgendaComConfig). */
  agendaFormatada: string;
}

// Campos da personalizacao com label especifico no bloco [NEGOCIO].
// Os demais (qualquer chave que o admin adicionar pelo painel) viram
// um bloco [OBSERVACOES] no final do contexto.
const _PERS_LABELS: Record<string, string> = {
  nome_negocio: 'Nome',
  endereco: 'Endereco',
  instagram: 'Instagram',
  telefone_contato: 'Telefone',
};

function humanizarChave(key: string): string {
  // 'horario_feriado' -> 'Horario feriado'
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Carrega personalizacao + horarios + servicos do slot.
 * Hierarquia: flow_clones (clone) -> bot_config (matriz) -> defaults vazios.
 *
 * O campo `personalizacao` retornado inclui TODAS as chaves do clone (nao
 * apenas as conhecidas) — admin pode cadastrar observacoes/promocoes/etc
 * via aba Personalizacao do painel e tudo entra no contexto.
 */
async function loadEntityForContext(slot: string): Promise<{
  personalizacao: Record<string, string>;
  horarios: HorariosFuncionamento | null;
  servicos: ServicoConfig[] | null;
}> {
  const empty = {
    personalizacao: {} as Record<string, string>,
    horarios: null,
    servicos: null,
  };

  try {
    const clone = await flowClones.getCloneBySlot(slot);
    if (clone) {
      const pers = (clone.personalizacao ?? {}) as Record<string, string>;
      const horarios = clone.horarios_funcionamento;
      const servicos = clone.servicos;
      // Se clone tem config parcial, completa com bot_config da matriz.
      let horariosFinal = horarios;
      let servicosFinal = servicos;
      if (!horarios || !servicos || servicos.length === 0) {
        try {
          const r = await query<{
            horarios_funcionamento: HorariosFuncionamento | null;
            servicos: ServicoConfig[] | null;
          }>(
            `SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1`,
            [clone.matriz_slot],
          );
          const matrizRow = r.rows[0];
          if (matrizRow) {
            if (!horariosFinal) horariosFinal = matrizRow.horarios_funcionamento;
            if (!servicosFinal || servicosFinal.length === 0) servicosFinal = matrizRow.servicos;
          }
        } catch {
          /* silent — fallback acima ja cobre */
        }
      }
      return {
        personalizacao: pers,
        horarios: horariosFinal,
        servicos: servicosFinal,
      };
    }
  } catch {
    /* silent */
  }

  // Slot e a propria matriz (sem flow_clones) — busca em bot_config.
  try {
    const r = await query<{
      horarios_funcionamento: HorariosFuncionamento | null;
      servicos: ServicoConfig[] | null;
    }>(
      `SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1`,
      [slot],
    );
    const row = r.rows[0];
    if (row) {
      return {
        ...empty,
        horarios: row.horarios_funcionamento,
        servicos: row.servicos,
      };
    }
  } catch {
    /* silent */
  }

  return empty;
}

/**
 * Monta o bloco de CONTEXTO que sera concatenado ao prompt do bot.
 *
 * Estrutura fixa, nao editavel pelo usuario do painel — protege contra
 * remocao acidental de dados importantes (Bruno 2026-05-20).
 */
export async function buildContextBlock(opts: ContextBlockOpts): Promise<string> {
  const e = await loadEntityForContext(opts.slot);

  // [NEGOCIO]: campos conhecidos com label fixo. Vazios sao omitidos.
  const negocio: string[] = [];
  const persUsadas = new Set<string>();
  for (const [key, label] of Object.entries(_PERS_LABELS)) {
    const val = e.personalizacao[key];
    if (val && String(val).trim() !== '') {
      const valor = key === 'instagram' ? `@${val}` : val;
      negocio.push(`${label}: ${valor}`);
      persUsadas.add(key);
    }
  }

  // [OBSERVACOES]: qualquer outra chave que admin cadastrou na aba
  // Personalizacao (ex: observacoes_gerais, formas_pagamento, promocao_atual,
  // horario_feriado, etc). Tudo entra no contexto — usuario nao tem como
  // omitir editando o prompt.
  const observacoes: string[] = [];
  for (const [key, val] of Object.entries(e.personalizacao)) {
    if (persUsadas.has(key)) continue;
    if (!val || String(val).trim() === '') continue;
    observacoes.push(`${humanizarChave(key)}: ${val}`);
  }

  const partes: string[] = [];
  partes.push('[CONTEXTO - DADOS DO BANCO, NAO REMOVIVEL]');
  partes.push('');
  partes.push('[DATA ATUAL]');
  partes.push(opts.dataAtual);
  partes.push(`ANO: ${opts.ano} - use SEMPRE este ano ao calcular datas.`);
  partes.push('');
  partes.push('[DADOS DO CLIENTE - JA IDENTIFICADO]');
  partes.push(`NOME: ${opts.nomeCliente}`);
  partes.push(`WHATSAPP: ${opts.telefoneCliente}`);
  if (negocio.length > 0) {
    partes.push('');
    partes.push('[NEGOCIO]');
    for (const ln of negocio) partes.push(ln);
  }
  if (observacoes.length > 0) {
    partes.push('');
    partes.push('[OBSERVACOES E DADOS EXTRAS]');
    for (const ln of observacoes) partes.push(ln);
  }
  partes.push('');
  partes.push('[FUNCIONAMENTO]');
  partes.push(renderHorariosFuncionamentoBlock(e.horarios));
  partes.push('');
  partes.push('[SERVICOS E PRECOS]');
  partes.push(renderServicosPrecosBlock(e.servicos));
  partes.push('');
  partes.push('[HORARIOS DISPONIVEIS - ATUALIZADO AGORA]');
  partes.push(opts.agendaFormatada);

  return partes.join('\n');
}

// ---- Render de blocos {{double_brace}} (paridade com painel-admin) ---------
// O painel pré-renderiza esses blocos no momento de criar/atualizar clone
// (regerarPromptClone). Mas a MATRIZ não passa por esse caminho — quando o
// worker roda pra ela direto, o bot_prompt.matriz ainda tem placeholders
// literais. Aplicamos a substituição em runtime aqui.

const _DIAS_SEMANA_RENDER: Array<[keyof HorariosFuncionamento, string]> = [
  ['segunda', 'Segunda'],
  ['terca', 'Terca'],
  ['quarta', 'Quarta'],
  ['quinta', 'Quinta'],
  ['sexta', 'Sexta'],
  ['sabado', 'Sabado'],
  ['domingo', 'Domingo'],
];

function renderHorariosFuncionamentoBlock(horarios: HorariosFuncionamento | null): string {
  if (!horarios || typeof horarios !== 'object') return 'Nao configurado.';
  const linhas: string[] = [];
  for (const [key, label] of _DIAS_SEMANA_RENDER) {
    const dia = horarios[key];
    if (!dia || dia.fechado) {
      linhas.push(`${label}: fechado`);
    } else if (dia.abre && dia.fecha) {
      linhas.push(`${label}: ${dia.abre} as ${dia.fecha}`);
    } else {
      linhas.push(`${label}: nao configurado`);
    }
  }
  return linhas.join('\n');
}

function renderServicosPrecosBlock(servicos: ServicoConfig[] | null): string {
  if (!Array.isArray(servicos) || servicos.length === 0) return 'Nenhum servico cadastrado.';
  const linhas = servicos
    .filter((s) => s && typeof s.nome === 'string' && s.nome.trim() !== '')
    .map((s) => {
      const nome = String(s.nome).trim();
      const preco = Number(s.preco_cents);
      const dur = Number(s.duracao_min);
      const precoStr = Number.isFinite(preco) && preco > 0
        ? `R$${(preco / 100).toFixed(2).replace('.', ',')}`
        : 'a combinar';
      const durStr = Number.isFinite(dur) && dur > 0 ? `${dur} min` : 'duracao a combinar';
      return `${nome}: ${precoStr} (${durStr})`;
    });
  return linhas.length > 0 ? linhas.join('\n') : 'Nenhum servico cadastrado.';
}

/**
 * Substitui {{horarios_funcionamento_render}} e {{servicos_precos_render}}
 * no prompt da matriz quando o worker roda pra matriz direto. Idempotente —
 * se o prompt nao tem esses placeholders, retorna inalterado.
 */
export async function aplicarPlaceholdersMatriz(
  prompt: string,
  slot: string,
): Promise<string> {
  if (!prompt.includes('{{horarios_funcionamento_render}}') &&
      !prompt.includes('{{servicos_precos_render}}')) {
    return prompt;
  }
  try {
    const r = await query<{
      horarios_funcionamento: HorariosFuncionamento | null;
      servicos: ServicoConfig[] | null;
    }>(
      `SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1`,
      [slot],
    );
    const row = r.rows[0];
    if (!row) return prompt;
    return prompt
      .replace(
        /\{\{horarios_funcionamento_render\}\}/g,
        renderHorariosFuncionamentoBlock(row.horarios_funcionamento),
      )
      .replace(
        /\{\{servicos_precos_render\}\}/g,
        renderServicosPrecosBlock(row.servicos),
      );
  } catch {
    return prompt;
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
