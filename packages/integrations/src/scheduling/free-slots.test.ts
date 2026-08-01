/**
 * Testes unitários para loadScheduleConfig (V3 — sem fallback silencioso).
 *
 * Não conecta no banco — usa mocks do módulo @startap/db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks devem ser declarados antes do import do módulo testado.
vi.mock('@startap/db', () => ({
  flowClones: {
    getCloneBySlot: vi.fn(),
  },
  query: vi.fn(),
}));

import { flowClones, query } from '@startap/db';
import {
  type ScheduleConfig,
  buildContextBlock,
  computeFreeSlotsForDay,
  formatarAgendaComConfig,
  loadScheduleConfig,
  reanchorWallTimeToTz,
  weekdayOfDateKey,
  zonedWallTimeToUtc,
} from './free-slots.js';

const mockGetCloneBySlot = vi.mocked(flowClones.getCloneBySlot);
const mockQuery = vi.mocked(query);

const HORARIOS_VALIDOS = {
  domingo: { fechado: true },
  segunda: { fechado: false, abre: '09:00', fecha: '18:00' },
  terca: { fechado: false, abre: '09:00', fecha: '18:00' },
  quarta: { fechado: false, abre: '09:00', fecha: '18:00' },
  quinta: { fechado: false, abre: '09:00', fecha: '18:00' },
  sexta: { fechado: false, abre: '09:00', fecha: '18:00' },
  sabado: { fechado: false, abre: '09:00', fecha: '18:00' },
};

const SERVICOS_VALIDOS = [
  { nome: 'Corte', duracao_min: 30, preco_cents: 2500 },
  { nome: 'Barba', duracao_min: 30, preco_cents: 2000 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadScheduleConfig — caminho feliz', () => {
  it('retorna config do clone quando flow_clones tem horarios e servicos', async () => {
    mockGetCloneBySlot.mockResolvedValue({
      slot: 'clone_cirilobarbearia_c8w2f0',
      matriz_slot: 'teste_barbearia',
      horarios_funcionamento: HORARIOS_VALIDOS,
      servicos: SERVICOS_VALIDOS,
    } as never);

    const cfg = await loadScheduleConfig('clone_cirilobarbearia_c8w2f0');

    expect(cfg.source).toBe('flow_clones');
    expect(cfg.services).toHaveLength(2);
    expect(cfg.services[0]?.name).toBe('Corte');
    expect(cfg.work[1]).toEqual([9 * 60, 18 * 60]);
  });

  it('cai para bot_config da matriz quando clone existe mas sem config', async () => {
    mockGetCloneBySlot.mockResolvedValue({
      slot: 'clone_sem_config',
      matriz_slot: 'teste_barbearia',
      horarios_funcionamento: null,
      servicos: null,
    } as never);

    mockQuery.mockResolvedValue({
      rows: [
        {
          horarios_funcionamento: HORARIOS_VALIDOS,
          servicos: SERVICOS_VALIDOS,
        },
      ],
    } as never);

    const cfg = await loadScheduleConfig('clone_sem_config');

    expect(cfg.source).toBe('bot_config');
    expect(cfg.services).toHaveLength(2);
  });

  it('retorna config do bot_config quando nao ha clone (slot e a propria matriz)', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);

    mockQuery.mockResolvedValue({
      rows: [
        {
          horarios_funcionamento: HORARIOS_VALIDOS,
          servicos: SERVICOS_VALIDOS,
        },
      ],
    } as never);

    const cfg = await loadScheduleConfig('teste_barbearia');

    expect(cfg.source).toBe('bot_config');
  });
});

describe('loadScheduleConfig — erro explícito (V3: sem fallback silencioso)', () => {
  it('lanca erro quando clone existe mas nem clone nem matriz tem config', async () => {
    mockGetCloneBySlot.mockResolvedValue({
      slot: 'clone_mal_configurado',
      matriz_slot: 'matriz_mal_configurada',
      horarios_funcionamento: null,
      servicos: null,
    } as never);

    // Matriz também sem config
    mockQuery.mockResolvedValue({ rows: [] } as never);

    await expect(loadScheduleConfig('clone_mal_configurado')).rejects.toThrow(
      "Configuração de horários/serviços ausente para o slot 'clone_mal_configurado'",
    );
  });

  it('lanca erro quando nao ha clone e bot_config do slot esta sem config', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    await expect(loadScheduleConfig('slot_sem_config')).rejects.toThrow(
      "Configuração de horários/serviços ausente para o slot 'slot_sem_config'",
    );
  });

  it('lanca erro quando nao ha clone e bot_config tem horarios mas sem servicos', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);
    mockQuery.mockResolvedValue({
      rows: [
        {
          horarios_funcionamento: HORARIOS_VALIDOS,
          servicos: [],
        },
      ],
    } as never);

    await expect(loadScheduleConfig('slot_sem_servicos')).rejects.toThrow(
      "Configuração de horários/serviços ausente para o slot 'slot_sem_servicos'",
    );
  });

  it('NAO retorna BUILTIN_DEFAULTS em nenhum cenario — o tipo "defaults" foi removido', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    // Garantir que não é possível obter source: 'defaults' — o tipo foi removido do ScheduleConfig.
    // A promise deve rejeitar antes de qualquer return.
    const result = loadScheduleConfig('qualquer_slot');
    await expect(result).rejects.toThrow();
  });
});

// ---- computeFreeSlotsForDay (Missão 020 F4 — grade do agendamento manual) ----
//
// Funções puras: sem mock de banco. Datas fixas — 2026-06-13 é sábado (wd 6),
// 2026-06-14 é domingo (wd 0). `now` injetado pra não depender do relógio real.

const WORK_SAB_09_12: Record<number, [number, number] | null> = {
  0: null,
  1: null,
  2: null,
  3: null,
  4: null,
  5: null,
  6: [9 * 60, 12 * 60],
};

// Relógio de referência: quarta 2026-06-10 12:00 BRT (antes dos dias-alvo).
const NOW_REF = new Date('2026-06-10T12:00:00-03:00');

function evento(inicio: string, fim: string) {
  return {
    id: 'ev',
    summary: 'Fulano - Corte | WhatsApp: 5511999990000',
    start: { dateTime: inicio },
    end: { dateTime: fim },
  };
}

describe('computeFreeSlotsForDay', () => {
  it('dia fechado retorna vazio', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-14', // domingo: fechado
      durationMin: 30,
      now: NOW_REF,
    });
    expect(slots).toEqual([]);
  });

  it('dia no passado retorna vazio mesmo se aberto', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-06', // sábado anterior ao NOW_REF
      durationMin: 30,
      now: NOW_REF,
    });
    expect(slots).toEqual([]);
  });

  it('duração 30min sem eventos: grade alinhada 09:00..11:30', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-13',
      durationMin: 30,
      now: NOW_REF,
    });
    expect(slots).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('evento 10:00-10:30 abre o buraco certo na grade de 30min', () => {
    const slots = computeFreeSlotsForDay(
      [evento('2026-06-13T10:00:00-03:00', '2026-06-13T10:30:00-03:00')],
      WORK_SAB_09_12,
      { dateKey: '2026-06-13', durationMin: 30, now: NOW_REF },
    );
    expect(slots).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  it('duração 45min: passo 45, último slot encaixa exato no fechamento', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-13',
      durationMin: 45,
      now: NOW_REF,
    });
    // 11:15 + 45 = 12:00 (fecha) — encaixa; 12:00 não cabe.
    expect(slots).toEqual(['09:00', '09:45', '10:30', '11:15']);
  });

  it('duração 45min com evento 10:00-10:30: bloqueia só o slot que sobrepõe', () => {
    const slots = computeFreeSlotsForDay(
      [evento('2026-06-13T10:00:00-03:00', '2026-06-13T10:30:00-03:00')],
      WORK_SAB_09_12,
      { dateKey: '2026-06-13', durationMin: 45, now: NOW_REF },
    );
    // 09:45-10:30 sobrepõe o evento; 10:30-11:15 encosta sem sobrepor (livre).
    expect(slots).toEqual(['09:00', '10:30', '11:15']);
  });

  it('HOJE aplica piso de 10min arredondado pro passo do serviço', () => {
    // Sábado 09:12 BRT: piso = ceil((552+10)/30)*30 = 570 → primeiro slot 09:30.
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-06-13',
      durationMin: 30,
      now: new Date('2026-06-13T09:12:00-03:00'),
    });
    expect(slots).toEqual(['09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('eventos de outro dia não afetam a grade do dia alvo', () => {
    const slots = computeFreeSlotsForDay(
      [evento('2026-06-06T10:00:00-03:00', '2026-06-06T10:30:00-03:00')],
      WORK_SAB_09_12,
      { dateKey: '2026-06-13', durationMin: 30, now: NOW_REF },
    );
    expect(slots).toContain('10:00');
    expect(slots).toHaveLength(6);
  });

  it('data inválida retorna vazio', () => {
    const slots = computeFreeSlotsForDay([], WORK_SAB_09_12, {
      dateKey: '2026-02-31',
      durationMin: 30,
      now: NOW_REF,
    });
    expect(slots).toEqual([]);
  });
});

describe('zonedWallTimeToUtc / weekdayOfDateKey', () => {
  it('converte hora de parede BRT pra instante UTC (-03:00)', () => {
    expect(zonedWallTimeToUtc('2026-06-13', 10 * 60).toISOString()).toBe(
      '2026-06-13T13:00:00.000Z',
    );
    // 24:00 de parede = 00:00 do dia seguinte.
    expect(zonedWallTimeToUtc('2026-06-13', 24 * 60).toISOString()).toBe(
      '2026-06-14T03:00:00.000Z',
    );
  });

  it('weekdayOfDateKey: sábado=6, domingo=0, data inexistente=null', () => {
    expect(weekdayOfDateKey('2026-06-13')).toBe(6);
    expect(weekdayOfDateKey('2026-06-14')).toBe(0);
    expect(weekdayOfDateKey('2026-02-31')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// FUSO POR CLONE (migration 068) — Mato Grosso = America/Cuiaba (UTC-4).
// Invariante: clone SP (default) é BYTE-IDÊNTICO ao de hoje; Cuiabá corrige a 1h de erro.
// ─────────────────────────────────────────────────────────────────────────────────────

describe('fuso por clone — zonedWallTimeToUtc / reanchorWallTimeToTz / weekdayOfDateKey', () => {
  it('zonedWallTimeToUtc: 14:00 de parede em Cuiabá (−04) → 18:00Z (SP daria 17:00Z)', () => {
    expect(zonedWallTimeToUtc('2026-06-30', 14 * 60, 'America/Cuiaba').toISOString()).toBe(
      '2026-06-30T18:00:00.000Z',
    );
    // SP (default, sem tz) do MESMO horário de parede → 17:00Z (byte-idêntico ao de hoje).
    expect(zonedWallTimeToUtc('2026-06-30', 14 * 60).toISOString()).toBe(
      '2026-06-30T17:00:00.000Z',
    );
  });

  it('reanchorWallTimeToTz: ignora o offset do LLM e reinterpreta no fuso do clone', () => {
    // O LLM emite -03:00 (offset de SP chumbado). Reancorado em Cuiabá = 18:00Z.
    expect(reanchorWallTimeToTz('2026-06-30T14:00:00-03:00', 'America/Cuiaba')).toBe(
      '2026-06-30T18:00:00.000Z',
    );
    // Reancorado em SP = 17:00Z = EXATAMENTE o instante que o -03:00 já representava.
    // PROVA DE IGUALDADE: clone SP não muda nada vs. o comportamento de hoje.
    expect(reanchorWallTimeToTz('2026-06-30T14:00:00-03:00', 'America/Sao_Paulo')).toBe(
      '2026-06-30T17:00:00.000Z',
    );
    expect(new Date('2026-06-30T14:00:00-03:00').toISOString()).toBe('2026-06-30T17:00:00.000Z');
  });

  it('reanchorWallTimeToTz: aceita "YYYY-MM-DD HH:mm" e devolve null em formato inválido', () => {
    expect(reanchorWallTimeToTz('2026-06-30 14:00', 'America/Cuiaba')).toBe(
      '2026-06-30T18:00:00.000Z',
    );
    expect(reanchorWallTimeToTz('amanhã às 14h', 'America/Cuiaba')).toBeNull();
  });

  it('reanchorWallTimeToTz: IANA inválido → null SEM lançar (falha fechada, isolada a 1 clone)', () => {
    // 'America/Cuiba' (digitação errada) faria Intl lançar RangeError — capturado → null.
    expect(() => reanchorWallTimeToTz('2026-06-30T14:00:00-03:00', 'America/Cuiba')).not.toThrow();
    expect(reanchorWallTimeToTz('2026-06-30T14:00:00-03:00', 'America/Cuiba')).toBeNull();
    // Fusos VÁLIDOS seguem funcionando normalmente.
    expect(reanchorWallTimeToTz('2026-06-30T14:00:00-03:00', 'America/Sao_Paulo')).toBe(
      '2026-06-30T17:00:00.000Z',
    );
    expect(reanchorWallTimeToTz('2026-06-30T14:00:00-03:00', 'America/Cuiaba')).toBe(
      '2026-06-30T18:00:00.000Z',
    );
  });

  it('weekdayOfDateKey: mesmo dateKey → mesmo weekday em SP e Cuiabá', () => {
    expect(weekdayOfDateKey('2026-06-13', 'America/Cuiaba')).toBe(6);
    expect(weekdayOfDateKey('2026-06-13', 'America/Sao_Paulo')).toBe(6);
    expect(weekdayOfDateKey('2026-06-14', 'America/Cuiaba')).toBe(0);
  });
});

describe('fuso por clone — computeFreeSlotsForDay (Cuiabá UTC-4)', () => {
  it('evento bucketizado pelo fuso: 13:00Z ocupa 09:00 (Cuiabá) vs 10:00 (SP)', () => {
    const ev = evento('2026-06-13T13:00:00Z', '2026-06-13T13:30:00Z');
    // SP (−03): evento é 10:00–10:30 → some o slot 10:00.
    const sp = computeFreeSlotsForDay([ev], WORK_SAB_09_12, {
      dateKey: '2026-06-13',
      durationMin: 30,
      now: NOW_REF,
      timeZone: 'America/Sao_Paulo',
    });
    expect(sp).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
    // Cuiabá (−04): evento é 09:00–09:30 → some o slot 09:00.
    const cuiaba = computeFreeSlotsForDay([ev], WORK_SAB_09_12, {
      dateKey: '2026-06-13',
      durationMin: 30,
      now: NOW_REF,
      timeZone: 'America/Cuiaba',
    });
    expect(cuiaba).toEqual(['09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('now de borda: 03:00Z é 13/06 (passado p/ SP) mas 12/06 23:00 (hoje p/ Cuiabá)', () => {
    const now = new Date('2026-06-13T03:00:00Z'); // SP = 00:00 13/06 ; Cuiabá = 23:00 12/06
    const WORK_SEX_NOITE: Record<number, [number, number] | null> = {
      0: null,
      1: null,
      2: null,
      3: null,
      4: null,
      5: [23 * 60, 24 * 60], // sexta 23:00–24:00 (janela noturna p/ exercitar a borda)
      6: null,
    };
    // SP: 13/06 já começou → o dia-alvo 12/06 é PASSADO → vazio.
    const sp = computeFreeSlotsForDay([], WORK_SEX_NOITE, {
      dateKey: '2026-06-12',
      durationMin: 30,
      now,
      timeZone: 'America/Sao_Paulo',
    });
    expect(sp).toEqual([]);
    // Cuiabá: ainda é 23:00 de 12/06 (HOJE) → oferece o slot 23:30.
    const cuiaba = computeFreeSlotsForDay([], WORK_SEX_NOITE, {
      dateKey: '2026-06-12',
      durationMin: 30,
      now,
      timeZone: 'America/Cuiaba',
    });
    expect(cuiaba).toEqual(['23:30']);
  });
});

describe('fuso por clone — formatarAgendaComConfig (Cuiabá UTC-4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // SP 09:00 / Cuiabá 08:00 — MESMO dia 15/06 nos dois fusos (label HOJE idêntico).
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const WORK_TODOS_09_12: Record<number, [number, number] | null> = {
    0: [9 * 60, 12 * 60],
    1: [9 * 60, 12 * 60],
    2: [9 * 60, 12 * 60],
    3: [9 * 60, 12 * 60],
    4: [9 * 60, 12 * 60],
    5: [9 * 60, 12 * 60],
    6: [9 * 60, 12 * 60],
  };
  const baseCfg = (timezone: string): ScheduleConfig => ({
    work: WORK_TODOS_09_12,
    services: [{ name: 'Corte', min: 60 }],
    source: 'flow_clones',
    timezone,
  });
  // Evento 14:00Z–15:00Z: em SP = 11:00–12:00; em Cuiabá = 10:00–11:00.
  const ev = evento('2026-06-15T14:00:00Z', '2026-06-15T15:00:00Z');

  it('SP (default): evento ocupa 11:00 → HOJE oferece 10:00', () => {
    const out = formatarAgendaComConfig([ev], baseCfg('America/Sao_Paulo'), { daysAhead: 0 });
    expect(out).toBe('HOJE (15/06):\n  Corte (60min): 10:00');
  });

  it('Cuiabá: evento ocupa 10:00 → HOJE oferece 09:00 e 11:00', () => {
    const out = formatarAgendaComConfig([ev], baseCfg('America/Cuiaba'), { daysAhead: 0 });
    expect(out).toBe('HOJE (15/06):\n  Corte (60min): 09:00, 11:00');
  });
});

describe('buildContextBlock — planos_beneficios REMOVIDO do rótulo dedicado (SCRUM-160, 01/08)', () => {
  const baseOpts = {
    slot: 'clone_meduzza',
    nomeCliente: 'Fulano',
    telefoneCliente: '5511999998888',
    dataAtual: 'segunda-feira, 7 de julho de 2026',
    ano: '2026',
  };

  // Clone com horarios+servicos preenchidos -> loadEntityForContext NÃO consulta a matriz.
  function cloneWith(pers: Record<string, unknown>) {
    return {
      personalizacao: pers,
      horarios_funcionamento: HORARIOS_VALIDOS,
      servicos: SERVICOS_VALIDOS,
      matriz_slot: 'teste_barbearia',
    };
  }

  it('planos AUSENTE -> contexto não menciona planos (byte-a-byte p/ quem não preencheu)', async () => {
    mockGetCloneBySlot.mockResolvedValue(cloneWith({ nome_negocio: 'Cirilo' }) as never);
    const ctx = await buildContextBlock(baseOpts);
    expect(ctx).not.toContain('Planos e assinaturas');
    expect(ctx).not.toMatch(/planos/i);
  });

  it('RISCO CONHECIDO documentado: se a chave ainda existir no JSONB (pré-migração), o texto ' +
    'vaza SEM rótulo pelo catch-all [OBSERVACOES] — por isso este código só entra em prod ' +
    'DEPOIS da migração da Ingrid remover a chave (ver comentário acima de _PERS_LABELS)', async () => {
    mockGetCloneBySlot.mockResolvedValue(
      cloneWith({
        nome_negocio: 'Ingrid',
        planos_beneficios: 'Plano Mensal R$99: corte ilimitado.',
      }) as never,
    );
    const ctx = await buildContextBlock(baseOpts);
    // NÃO tem mais o rótulo dedicado "Planos e assinaturas" — a chave não está em _PERS_LABELS.
    expect(ctx).not.toContain('Planos e assinaturas');
    // MAS o texto ainda aparece (humanizado) no catch-all, provando que a chave PRECISA sumir
    // do JSONB antes deste deploy — não é responsabilidade deste bloco de código.
    expect(ctx).toContain('Planos Beneficios: Plano Mensal R$99: corte ilimitado.');
  });

  it('planos vazio ("") -> omitido (não vira linha vazia no contexto)', async () => {
    mockGetCloneBySlot.mockResolvedValue(
      cloneWith({ nome_negocio: 'X', planos_beneficios: '' }) as never,
    );
    const ctx = await buildContextBlock(baseOpts);
    expect(ctx).not.toContain('Planos e assinaturas');
    expect(ctx).not.toMatch(/planos/i);
  });

  it('chave com valor ESTRUTURADO (array/objeto) nunca vira linha de [OBSERVACOES] — nem "[object Object]"', async () => {
    // Defesa em profundidade: qualquer chave nao-string no JSONB de personalizacao (legado ou
    // futura) e pulada no loop de [OBSERVACOES], nunca String()-ada. Cobre tanto array quanto
    // objeto puro, sem citar nenhuma chave especifica pelo nome.
    mockGetCloneBySlot.mockResolvedValue(
      cloneWith({
        nome_negocio: 'X',
        legado_array: [{ pergunta: 'a', resposta: 'b' }],
        legado_objeto: { chave: 'valor' },
      }) as never,
    );
    const ctx = await buildContextBlock(baseOpts);
    expect(ctx).not.toContain('[object Object]');
    expect(ctx).not.toMatch(/Legado Array/i);
    expect(ctx).not.toMatch(/Legado Objeto/i);
  });
});
