/**
 * free-slots — calcula slots de agendamento livres por bot.
 *
 * Lê horários de funcionamento e serviços do clone (flow_clones) e cruza com
 * eventos do Google Calendar para devolver a string {agenda} pronta pra IA
 * consumir. A IA não precisa "raciocinar disponibilidade" — recebe a tabela
 * já filtrada e formatada por serviço e dia.
 *
 * Sem fallback silencioso: se o slot não tem horários/serviços configurados
 * em flow_clones ou bot_config, loadScheduleConfig lança erro explícito.
 * O bot deve tratar esse erro e silenciar a resposta ao cliente (não enviar
 * horários fictícios de uma barbearia que não é a do cliente).
 */
import type { HorariosFuncionamento, ServicoConfig } from '@startap/db';
import { flowClones, query } from '@startap/db';
import type { CalendarEvent } from '../google-calendar/client.js';

/** Timezone canônica de agendamento da plataforma. */
export const TZ = 'America/Sao_Paulo';

export interface ScheduleConfig {
  /** Janelas de atendimento por weekday (0=Dom .. 6=Sab). null = fechado. */
  work: Record<number, [number, number] | null>;
  /** Serviços disponíveis (nome + duração em minutos). */
  services: Array<{ name: string; min: number }>;
  /** Origem da config — útil para log/debug. */
  source: 'flow_clones' | 'bot_config';
  /**
   * Fuso (IANA) do relógio da barbearia (migration 068). DEFAULT 'America/Sao_Paulo'
   * — clone sem fuso declarado é byte-idêntico ao comportamento de hoje. Usado pra
   * converter horário-de-parede <-> instante absoluto e formatar a agenda no relógio do dono.
   */
  timezone: string;
}

// ---- Seed (referência para popular banco em setup inicial — NÃO usar em runtime) ---
// Alinhado ao seed da matriz teste_barbearia (migrations 027 + 030): 4 servicos
// basicos, todos 30min, ter-sab 09-18.
//
// IMPORTANTE: esta constante existe APENAS como referência documental e para
// scripts de seed do banco. Nunca deve ser usada como fallback em runtime.
// Se loadScheduleConfig cair aqui, significa que o banco está mal configurado
// e o bot NÃO deve responder com dados fictícios.

/** @deprecated SEED — não usar em runtime. Populando banco via scripts de seed apenas. */
export const BUILTIN_DEFAULTS_SEED = {
  work: {
    0: null, // domingo: fechado
    1: null, // segunda: fechado
    2: [9 * 60, 18 * 60], // terca
    3: [9 * 60, 18 * 60], // quarta
    4: [9 * 60, 18 * 60], // quinta
    5: [9 * 60, 18 * 60], // sexta
    6: [9 * 60, 18 * 60], // sabado
  } as Record<number, [number, number] | null>,
  services: [
    { name: 'Corte', min: 30 },
    { name: 'Barba', min: 30 },
    { name: 'Sobrancelha', min: 30 },
    { name: 'Pezinho', min: 30 },
  ],
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
      min:
        Number.isFinite(Number(s.duracao_min)) && Number(s.duracao_min) > 0
          ? Math.round(Number(s.duracao_min))
          : 30,
    }));
}

/**
 * Le bot_config.horarios_funcionamento + bot_config.servicos diretamente
 * (queries.bot-config nao retorna esses jsonbs porque outros consumidores
 * nao precisam). Usado pelo loadScheduleConfig quando o slot e uma matriz.
 */
async function loadFromBotConfig(slot: string): Promise<{
  work: Record<number, [number, number] | null>;
  services: Array<{ name: string; min: number }>;
} | null> {
  try {
    const r = await query<{
      horarios_funcionamento: HorariosFuncionamento | null;
      servicos: ServicoConfig[] | null;
    }>('SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1', [slot]);
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
 *   3) Erro explícito — sem fallback silencioso (V3 2026-05-22)
 *
 * @throws Error quando o slot não tem horários/serviços configurados nem
 *   em flow_clones nem em bot_config. O caller deve capturar e silenciar
 *   a resposta ao cliente, logando o erro com slot + telefone.
 */
export async function loadScheduleConfig(slot: string): Promise<ScheduleConfig> {
  // 1) Tenta clone primeiro
  try {
    const clone = await flowClones.getCloneBySlot(slot);
    if (clone) {
      const work = horariosToWork(clone.horarios_funcionamento);
      const services = servicosToServices(clone.servicos);
      if (work && services && services.length > 0) {
        return { work, services, source: 'flow_clones', timezone: clone.timezone };
      }
      // Clone existe mas config incompleta — cai pra matriz (matriz_slot do clone).
      // Fuso ainda vem do CLONE (a matriz só empresta horários/serviços, não o relógio).
      const matrizCfg = await loadFromBotConfig(clone.matriz_slot);
      if (matrizCfg) {
        return { ...matrizCfg, source: 'bot_config', timezone: clone.timezone };
      }
      throw new Error(
        `Configuração de horários/serviços ausente para o slot '${slot}' (clone de '${clone.matriz_slot}') — configure no painel antes de ativar`,
      );
    }
  } catch (err) {
    // Re-throw erros explícitos de config ausente.
    if (err instanceof Error && err.message.includes('horários/serviços ausente')) throw err;
    // Falha de query de DB — cai para os proximos niveis.
  }

  // 2) Slot pode ser uma matriz rodando direto (ex: teste_barbearia sem clone).
  //    Sem clone => sem fuso declarado => default 'America/Sao_Paulo' (byte-idêntico ao de hoje).
  const matrizCfg = await loadFromBotConfig(slot);
  if (matrizCfg) {
    return { ...matrizCfg, source: 'bot_config', timezone: TZ };
  }

  // 3) Sem config — erro explícito. Não usar defaults fictícios em runtime.
  throw new Error(
    `Configuração de horários/serviços ausente para o slot '${slot}' — configure no painel antes de ativar`,
  );
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
  /**
   * Tabela de horarios disponiveis ja formatada (vinda de formatarAgendaComConfig).
   * OPCIONAL: omitido no MODO ATENDENTE (SCRUM-59) — sem agenda em tempo real, o bloco
   * [HORARIOS DISPONIVEIS] nao e injetado (o render ja guarda com `if (opts.agendaFormatada)`).
   */
  agendaFormatada?: string;
  /**
   * Lista de cursos formatada para IA (usada pelos bots de vendas).
   * Quando presente, injeta bloco [CURSOS DISPONIVEIS] no contexto.
   */
  cursosDisponiveis?: string;
  /**
   * Biblioteca de midias formatada para IA (usada pelos bots de vendas).
   * Quando presente, injeta bloco [MIDIAS DA BIBLIOTECA] no contexto.
   */
  midiasDisponiveis?: string;
  /**
   * Estado da conversa (curso escolhido, midias ja enviadas).
   * Quando presente, injeta bloco [ESTADO DA CONVERSA] no contexto.
   */
  estadoConversa?: string;
}

// Campos da personalizacao com label especifico no bloco [NEGOCIO].
// Os demais (qualquer chave que o admin adicionar pelo painel) viram
// um bloco [OBSERVACOES] no final do contexto.
const _PERS_LABELS: Record<string, string> = {
  nome_negocio: 'Nome',
  nome_prestador: 'Profissional',
  endereco: 'Endereco',
  instagram: 'Instagram',
  telefone_contato: 'Telefone',
  formas_pagamento: 'Formas de pagamento',
};

function humanizarChave(key: string): string {
  // 'horario_feriado' -> 'Horario feriado'
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
          }>('SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1', [
            clone.matriz_slot,
          ]);
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
    }>('SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1', [slot]);
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
  if (opts.agendaFormatada) {
    partes.push('');
    partes.push('[HORARIOS DISPONIVEIS - ATUALIZADO AGORA]');
    partes.push(opts.agendaFormatada);
  }

  if (opts.cursosDisponiveis) {
    partes.push('');
    partes.push('[CURSOS DISPONIVEIS]');
    partes.push(opts.cursosDisponiveis);
  }
  if (opts.midiasDisponiveis) {
    partes.push('');
    partes.push('[MIDIAS DA BIBLIOTECA]');
    partes.push(opts.midiasDisponiveis);
  }
  if (opts.estadoConversa) {
    partes.push('');
    partes.push('[ESTADO DA CONVERSA]');
    partes.push(opts.estadoConversa);
  }

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
      const precoStr =
        Number.isFinite(preco) && preco > 0
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
export async function aplicarPlaceholdersMatriz(prompt: string, slot: string): Promise<string> {
  if (
    !prompt.includes('{{horarios_funcionamento_render}}') &&
    !prompt.includes('{{servicos_precos_render}}')
  ) {
    return prompt;
  }
  try {
    const r = await query<{
      horarios_funcionamento: HorariosFuncionamento | null;
      servicos: ServicoConfig[] | null;
    }>('SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1', [slot]);
    const row = r.rows[0];
    if (!row) return prompt;
    return prompt
      .replace(
        /\{\{horarios_funcionamento_render\}\}/g,
        renderHorariosFuncionamentoBlock(row.horarios_funcionamento),
      )
      .replace(/\{\{servicos_precos_render\}\}/g, renderServicosPrecosBlock(row.servicos));
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

function spParts(date: Date, timeZone: string = TZ): SpParts {
  // hourCycle: 'h23' forca formato 00-23 (em vez de 24:00 que en-US com
  // hour12:false produzia a meia-noite). Bug descoberto 2026-05-20: bot
  // dizia "hoje sem vaga" entre 00:00-00:59 BRT porque mins virava 1456
  // (24*60+16) e o piso svcStart ficava maior que wEnd, zerando o loop.
  // timeZone default 'America/Sao_Paulo' (byte-idêntico ao de hoje); o caller
  // passa o fuso do clone pra projetar o instante no relógio da barbearia.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
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
 * O step de cada serviço é igual à própria duração — slots ficam alinhados
 * (Corte 30min: 09:00, 09:30, 10:00; Barba 20min: 09:00, 09:20, 09:40). Isso
 * elimina o "gap aparente" que aparecia quando um step fixo (ex: 20min) era
 * usado para serviços com durações diferentes — Bruno (2026-05-20).
 *
 * Próximo slot do dia atual respeita um piso de 10min sobre o relógio (evita
 * oferecer slot que começa em menos de 10min).
 */
export function formatarAgendaComConfig(
  events: CalendarEvent[],
  config: ScheduleConfig,
  opts: { daysAhead?: number } = {},
): string {
  const daysAhead = opts.daysAhead ?? 5;
  const now = new Date();
  // Fuso do clone (default SP em ScheduleConfig.timezone). Toda projeção de relógio
  // (spParts) usa o relógio da barbearia — clone SP é byte-idêntico ao de hoje.
  const tz = config.timezone;

  const occupied: Record<string, Array<{ s: number; e: number }>> = {};
  for (const ev of events) {
    const s = new Date(ev.start.dateTime ?? `${ev.start.date}T00:00:00`);
    const e = new Date(ev.end.dateTime ?? `${ev.end.date}T00:00:00`);
    const sp = spParts(s, tz);
    const sep = spParts(e, tz);
    const key = sp.key;
    if (!occupied[key]) occupied[key] = [];
    occupied[key].push({ s: sp.mins, e: sep.mins });
  }

  const blocks: string[] = [];

  for (let offset = 0; offset <= daysAhead; offset++) {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    const sp = spParts(date, tz);
    const wh = config.work[sp.wd];
    if (!wh) continue;

    const [wStart, wEnd] = wh;
    const occ = occupied[sp.key] ?? [];
    let label: string;
    if (offset === 0) label = `HOJE (${sp.label})`;
    else if (offset === 1) label = `AMANHA (${sp.label})`;
    else label = `${DIAS_LABEL[sp.wd]} (${sp.label})`;

    const lines: string[] = [];
    for (const svc of config.services) {
      // Step = duracao do servico — alinhado, sem gap entre fim de um
      // agendamento e inicio do proximo slot oferecido.
      const step = Math.max(1, svc.min);
      // Piso de hoje: nao oferecer slot que comeca em menos de 10min,
      // arredondado para multiplo do step do servico.
      let svcStart = wStart;
      if (offset === 0) {
        svcStart = Math.max(wStart, Math.ceil((sp.mins + 10) / step) * step);
      }

      const slots: string[] = [];
      for (let t = svcStart; t + svc.min <= wEnd; t += step) {
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

// ---- Slots estruturados por dia (portal — agendamento manual, Missão 020 F4) -

/**
 * Piso sobre o relógio para slots de HOJE (mesma regra do bot em
 * formatarAgendaComConfig): não oferecer slot que começa em menos de 10min.
 */
const TODAY_FLOOR_MIN = 10;

export interface FreeSlotsDayOpts {
  /** Dia alvo no formato YYYY-MM-DD (calendário do fuso do clone). */
  dateKey: string;
  /** Duração do serviço em minutos — define o passo e o encaixe da grade. */
  durationMin: number;
  /** Relógio de referência (default: agora). Testável por injeção. */
  now?: Date;
  /**
   * Fuso (IANA) do clone (migration 068). Ausente -> 'America/Sao_Paulo'
   * (byte-idêntico ao de hoje). Projeta o relógio da barbearia na grade.
   */
  timeZone?: string;
}

/**
 * Versão ESTRUTURADA do formatarAgendaComConfig para UM dia e UMA duração:
 * mesma regra de step (= duração), mesmo piso de 10min pra hoje, mesmo
 * critério de overlap contra eventos do GCal. Retorna horários 'HH:mm'
 * em ordem crescente. Dia fechado ou no passado → [].
 *
 * Usada pelo portal (GET /portal/agenda/slots) — o que o dono vê na grade é
 * exatamente o que o bot ofereceria pro cliente final.
 */
export function computeFreeSlotsForDay(
  events: CalendarEvent[],
  work: Record<number, [number, number] | null>,
  opts: FreeSlotsDayOpts,
): string[] {
  const { dateKey, durationMin } = opts;
  const now = opts.now ?? new Date();
  // Fuso do clone (default SP). 15:00Z é meio-dia em -03 e 11h em -04 — longe da
  // borda do dia nos dois fusos, então o anchor é seguro; só o spParts usa o tz.
  const tz = opts.timeZone ?? TZ;
  if (!Number.isFinite(durationMin) || durationMin <= 0) return [];

  // Weekday do dia alvo no TZ do clone: 15:00Z evita borda de fuso (−03 e −04).
  const refDate = new Date(`${dateKey}T15:00:00Z`);
  if (Number.isNaN(refDate.getTime())) return [];
  const ref = spParts(refDate, tz);
  if (ref.key !== dateKey) return []; // dateKey inválido (ex: 2026-02-31)

  const nowSp = spParts(now, tz);
  if (dateKey < nowSp.key) return []; // dia já passou

  const wh = work[ref.wd];
  if (!wh) return []; // fechado

  // Ocupação do dia: mesmo bucketing por dia de início usado pelo bot.
  const occ: Array<{ s: number; e: number }> = [];
  for (const ev of events) {
    const s = new Date(ev.start.dateTime ?? `${ev.start.date}T00:00:00`);
    const e = new Date(ev.end.dateTime ?? `${ev.end.date}T00:00:00`);
    const sp = spParts(s, tz);
    if (sp.key !== dateKey) continue;
    occ.push({ s: sp.mins, e: spParts(e, tz).mins });
  }

  const [wStart, wEnd] = wh;
  const step = Math.max(1, durationMin);
  let start = wStart;
  if (dateKey === nowSp.key) {
    start = Math.max(wStart, Math.ceil((nowSp.mins + TODAY_FLOOR_MIN) / step) * step);
  }

  const slots: string[] = [];
  for (let t = start; t + durationMin <= wEnd; t += step) {
    if (!occ.some((o) => t < o.e && t + durationMin > o.s)) {
      slots.push(hhmm(t));
    }
  }
  return slots;
}

// ---- Conversão wall-time (TZ) -> instante UTC (sem lib externa) -------------

function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((a, p) => {
      a[p.type] = p.value;
      return a;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/**
 * Converte data ('YYYY-MM-DD') + minutos desde 00:00 (hora de parede no TZ)
 * para o instante UTC correspondente. Two-pass via Intl — correto mesmo se o
 * TZ voltar a ter horário de verão (America/Sao_Paulo é -03:00 fixo hoje).
 */
export function zonedWallTimeToUtc(dateKey: string, mins: number, timeZone: string = TZ): Date {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, 0, mins, 0);
  const offset1 = tzOffsetMs(new Date(guess), timeZone);
  const offset2 = tzOffsetMs(new Date(guess - offset1), timeZone);
  return new Date(guess - offset2);
}

/** Minutos desde 00:00 a partir de 'HH:mm' (já validado por regex no caller). */
export function hhmmToMins(hora: string): number {
  const [h, m] = hora.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Partes de data/hora de um instante no fuso informado (exposto pro portal/bot).
 * timeZone default 'America/Sao_Paulo' (byte-idêntico ao de hoje).
 */
export function nowPartsInTz(
  date: Date = new Date(),
  timeZone: string = TZ,
): { dateKey: string; mins: number } {
  const sp = spParts(date, timeZone);
  return { dateKey: sp.key, mins: sp.mins };
}

/**
 * Weekday (0=Dom .. 6=Sab) de uma data 'YYYY-MM-DD' no calendário do fuso
 * informado. Retorna null se a data for inválida (ex: 2026-02-31).
 * timeZone default 'America/Sao_Paulo'. 15:00Z (meio-dia em −03, 11h em −04) fica
 * longe da borda do dia nos dois fusos → o weekday é o mesmo pro mesmo dateKey.
 */
export function weekdayOfDateKey(dateKey: string, timeZone: string = TZ): number | null {
  const refDate = new Date(`${dateKey}T15:00:00Z`); // meio-dia BRT, longe de borda de fuso
  if (Number.isNaN(refDate.getTime())) return null;
  const sp = spParts(refDate, timeZone);
  return sp.key === dateKey ? sp.wd : null;
}

/**
 * REANCORA o horário-de-parede que o LLM emite (com o offset ERRADO chumbado nele,
 * tipicamente −03:00 de SP) para o instante UTC correto NO FUSO DO CLONE.
 *
 * O LLM recebe a agenda já formatada no relógio da barbearia (formatarAgendaComConfig
 * usa config.timezone) e devolve algo como '2026-06-30T14:00:00-03:00'. Nós IGNORAMOS o
 * offset textual e re-interpretamos o componente data+hora-de-parede (14:00) como hora
 * local NO FUSO DO CLONE. Para um clone SP isso é byte-idêntico (−03 == −03). Para Cuiabá
 * (−04) corrige a 1h de erro: 14:00 local vira 18:00Z (em vez do 17:00Z que o offset
 * do LLM produziria).
 *
 * Aceita 'YYYY-MM-DDTHH:mm...' e 'YYYY-MM-DD HH:mm...'. Retorna ISO (UTC) ou null se
 * o formato não casar (o caller cai no valor original = comportamento de hoje).
 */
export function reanchorWallTimeToTz(llmIso: string, timeZone: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(llmIso.trim());
  if (!m) return null;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  // FALHA FECHADA E ISOLADA A 1 CLONE: um IANA inválido na coluna timezone (ex.: 'America/Cuiba'
  // por erro de digitação num UPDATE manual) faz Intl lançar RangeError dentro de zonedWallTimeToUtc.
  // Capturamos e devolvemos null -> o caller cai no valor original (= comportamento de hoje) em vez
  // de derrubar o agendamento daquele clone.
  try {
    return zonedWallTimeToUtc(m[1], mins, timeZone).toISOString();
  } catch {
    return null;
  }
}
